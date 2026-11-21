// 手机 App 的插件页面宿主中转，主 WebView 这一头。
//
// 插件页面在安卓上是另起的干净 WebView（PluginPageActivity），够不着主界面的授权框、选择器、导航。
// 页面要做宿主类操作时：POST _bridge/host/request 拿 req → location.href = 'bridge-host://open?req=…&kind=nav|pick'
// → 原生把主界面切到前台、在 onResume 里调 window.__bridgePluginHost({ req, kind, plugin })（冷启动网页还没起好时
// 原生先记着，由这里登录就绪后经 AndroidStore.takePluginHost() 取走）。
//
// 这里的流程：GET /api/plugins/host-requests/<req> 看要做什么 → 按类型做
//   grant         → 已授权就直接回；没授权弹 bridge 自己的授权框（askGrant，同意时它自己存授权）
//   pick.file     → 先确认 page.files 已授权（没授权先走授权框），再弹文件选择器
//   pick.session  → 弹会话选择器
//   nav           → pageNav 落地（插件页面那头已经关掉了）
//   composer      → 跳到 Claude 页、新对话、填好输入框
// → POST …/complete { result }（取消、出错也要 complete，页面那头才不会干等 10 分钟）
// → grant 与 pick.* 调 AndroidStore.resumePluginPage() 把压在后面的插件页切回来。
//   nav / composer 落地后记一笔「原生返回」（lib/screenReturn.js）：新版 apk 跳转时插件页还压在后面，
//   在落地那一页按返回（nav.js）切回它；跳转没成则晚一点直接切回。
//
// 可信边界：plugin 以原生转来的（插件页的身份）为准，与服务端记录对不上就拒；req 由服务端核对是不是这个使用者的。
// 同一个 req 只处理一次：onResume 派发与冷启动 take 可能各送一遍。请求排成一条队，一次只挂一个框。
//
// 原生只送一次：MainActivity.deliverPluginHost 拿到网页回的 '1' 就把请求清掉，之后不会再送。所以这一头必须自己收场——
// 断网、5xx 退避重试几次；GET 最终没拿到（又不是过期 / 已处理）也照样 complete 一个否定结果，
// 否则页面那头的长轮询要白等到请求过期（10 分钟），期间别的宿主操作一概被「上一个框还没关」挡住。
// 两个例外不当场收场：
//   - 登录在服务端过期了（401，而前端 me 还是登录态——api.js 不做全局登出）：这条收回来排着、弹登录框，
//     登录后接着处理（已经做完、只差 complete 的，带着结果接着交，不让人再选一遍）。
//   - 框开太久：服务端请求 10 分钟过期，框不能比它活得长——快到期时把框按取消收掉、回个否定结果，
//     不然人磨蹭完再选是白选（complete 只会 404），串行的队也被这个旧框一直堵着。
import { api } from './api.js';
import { me, ui, applyMe, rootScreen } from './state.svelte.js';
import { setNativeReturn, clearNativeReturn } from './screenReturn.svelte.js';
import { t, tr } from './i18n.js';
import { showToast } from './toast.svelte.js';

// 与原生（MainActivity 收请求时的清洗）同一套形状
const REQ_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KIND_RE = /^(?:nav|pick)$/;
const PLUGIN_RE = /^[a-z][a-z0-9-]{0,47}$/;

const SEEN_MAX = 100;        // 记住最近处理过的 req（去重）
const WAIT_MAX = 20;         // 没登录 / 没就绪时最多先收着几条
const DRAIN_DELAY_MS = 400;  // 就绪后稍等界面落定再处理（同 notices 冷启动打开会话的做法）
const ERR_RESUME_MS = 1600;  // 出错时晚一点切回插件页，让人看得到提示
const RETRY_MS = [500, 1500, 4000];   // 断网 / 5xx 的退避（共约 6 秒；再长人就以为卡死了）
// 服务端宿主请求的有效期（src/plugins/page-host.mjs 的 HOST_TTL_MS）。GET 回包不带过期时刻，从这一头收到请求时起算：
// 页面发请求到原生转过来通常不到一秒，冷启动多几秒，都由下面的提前量兜住（不用服务端的绝对时刻：手机和电脑的钟可能差几分钟）
const HOST_TTL_MS = 10 * 60_000;
// 提前这么多把框收掉：留出 complete 的退避重试（约 6 秒）和路上的时间，赶在服务端作废前把「取消」送到页面
const TTL_MARGIN_MS = 20_000;

// 处理不成时回给页面的结果（页面那头按「取消 / 不允许 / 没跳」收场）
const DENY = {
  nav: { ok: false },
  composer: { ok: false },
  grant: { allow: false },
  'pick.file': { cancelled: true },
  'pick.session': { cancelled: true },
};
// 这几类插件页面压在主界面后面等结果，处理完要切回去
const RESUME_TYPES = new Set(['grant', 'pick.file', 'pick.session']);

const seen = new Set();
const waiting = [];
let registered = false;
let ready = false;
let drainTimer = null;
let chain = Promise.resolve();

const store = () => (typeof window !== 'undefined' && window.AndroidStore) || null;

function parse(o) {
  let x = o;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return null; } }
  if (!x || typeof x !== 'object') return null;
  const req = String(x.req ?? ''), kind = String(x.kind ?? ''), plugin = String(x.plugin ?? '');
  if (!REQ_RE.test(req) || !KIND_RE.test(kind) || !PLUGIN_RE.test(plugin)) return null;
  // at：这一头收到它的时刻，框的寿命从这里算（见 HOST_TTL_MS）；排着等登录的时间也算在里面
  return { req, kind, plugin, at: Date.now() };
}

function remember(req) {
  seen.add(req);
  while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
}

const loggedIn = () => !!me.kind && me.kind !== 'none';

// 先收着，等就绪 / 登录后由 drain 接着处理。req 留在 seen 里：drain 不看 seen，留着只挡掉原生重复送来的同一条
function stash(r) {
  waiting.push(r);
  while (waiting.length > WAIT_MAX) waiting.shift();   // 挤掉的那条服务端会过期，页面那头按超时收场
}

function nudgeLogin() {
  showToast(t('登录后接着处理插件页面的请求'));
  ui.loginOpen = true;
}

function accept(o) {
  const r = parse(o);
  if (!r || seen.has(r.req)) return;
  remember(r.req);
  if (ready && loggedIn() && !drainTimer) { enqueue(r); return; }
  stash(r);
  // 还没登录：把登录框打开，登录后接着处理（预载页还没结束时不弹，等 App 自己的登录流程）
  if (ui.booted && !loggedIn()) nudgeLogin();
}

// 服务端回 401 = 这个请求的身份没登录。前端 me 可能还是登录态（登录在服务端过期，api.js 不做全局登出），
// 这时弹登录框也会被 LoginDialog 当成「已登录」立刻收掉。所以先现问一次 /api/auth：确实没登录就照 App.refreshMe
// 的做法把 me 落成没登录（App 的总线 effect 随之停下、调 pluginHostIdle；登录后重跑、调 pluginHostReady 接着处理），
// 这条收回来排着，弹登录框，回 true。/api/auth 说还登录着、或者问不到，回 false——按出错收场，免得排了没人叫醒。
async function parkForLogin(r) {
  let out = false;
  try { await api.auth(); }
  catch (e) {
    if (e?.status === 401) { applyMe(e.body && typeof e.body === 'object' ? e.body : null); out = true; }
  }
  if (!out) return false;
  ready = false;   // 队里后面那几条不再各自撞一遍 401（handle 开头见到没就绪就收回来排着）
  stash(r);
  nudgeLogin();
  return true;
}

function enqueue(r) {
  chain = chain.then(() => handle(r)).catch((e) => { try { console.warn('[pluginHost]', e?.message || e); } catch {} });
}

function drain() {
  drainTimer = null;
  if (!ready || !loggedIn()) return;
  for (const r of waiting.splice(0)) enqueue(r);
}

function errText(e) {
  const raw = e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '';
  const msg = tr(String(raw || '')).slice(0, 200);
  if (msg) return msg;
  if (e?.status) return t('服务器返回 {code}', { code: e.status });
  return t('网络连接失败');
}

// 只有没拿到响应（断网、隧道抖）和 5xx 值得再试；4xx 是服务端明确的答复，再问还是一样
const transient = (e) => !e?.status || e.status >= 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fn 按 RETRY_MS 退避重试；tries 收集中途吞掉的错误（complete 要据此判断「重试撞上 409」是怎么回事）
async function retrying(fn, tries = []) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= RETRY_MS.length || !transient(e)) throw e;
      tries.push(e);
      await sleep(RETRY_MS[i]);
    }
  }
}

// POST complete（带重试）。成了回 null，失败回要告诉人的那个错误（409 = 已处理过，不算失败）。
async function complete(base, result) {
  const tries = [];
  try { await retrying(() => api.post(base + '/complete', { result }), tries); return null; }
  catch (e) {
    if (e?.status !== 409) return e;
    // 重试撞上 409：前一次其实到了服务端。回话在路上丢了（没状态码）就当成功；
    // 服务端收了场才报 5xx（如签句柄时出错）那种，照样要把原因告诉人
    return tries.find((x) => x?.status) || null;
  }
}

function resumePage(delay = 0) {
  clearNativeReturn();   // 切回插件页了：之前那次跳转记的「原生返回」不再作数
  const go = () => { try { store()?.resumePluginPage?.(); } catch {} };
  if (delay > 0) setTimeout(go, delay); else go();
}

// 插件页面还压在后面活着没（新版 apk 跳转时不再关它；旧版没有 hasPluginPage）
function pageAlive() {
  try { return typeof store()?.hasPluginPage === 'function' && !!store().hasPluginPage(); } catch { return false; }
}

// nav / composer 落地之后记一笔「原生返回」（lib/screenReturn.js）：在落地那一页按返回切回压在后面的插件页。
// 目标是屏的看屏到没到；目标是层的（文件预览、设置里的插件详情）屏不变，当场算到。
// 跳到的应用是安卓上另起插件页的那种（kind 'page'）不记：原生把那个新插件页盖上来了，返回本来就在它上面。
async function noteNative(plugin, p) {
  const to = p.to;
  if (to === 'session') return setNativeReturn('claude');
  if (to === 'home') return setNativeReturn(rootScreen());
  if (to === 'file') return setNativeReturn(ui.screen, { layer: 'preview' });
  if (to === 'settings') return setNativeReturn(ui.screen, { layer: 'settings' });
  if (to === 'app') {
    const [{ appKeyOf }, { appByKey }] = await Promise.all([import('./pageNav.js'), import('./pluginApps.svelte.js')]);
    const key = appKeyOf(plugin, p.app);
    const app = key ? appByKey(key) : null;
    if (app && (app.kind || 'page') !== 'page') return setNativeReturn(key);
  }
  clearNativeReturn();
  return false;
}

async function grantsOf(plugin) {
  const g = await api.get('/api/plugins/grants?plugin=' + encodeURIComponent(plugin));
  return {
    declared: Array.isArray(g?.declared) ? g.declared : [],
    granted: g?.granted && typeof g.granted === 'object' ? g.granted : {},
  };
}

// 确认已授权：查得到已授过就不打扰；否则弹授权框（同意时 askGrant 自己 POST /api/plugins/grants）。
// signal 到期 abort 时框按「不允许」收掉
async function ensureGrant(who, perm, known = null, signal) {
  let g = known;
  if (!g) {
    try { g = await grantsOf(who.plugin); }
    catch (e) { if (e?.status === 401) throw e; g = null; }   // 401 交给 handle 去排着等登录
  }
  if (g?.granted?.[perm]) return true;
  const { askGrant } = await import('./grantDialog.svelte.js');
  return !!(await askGrant({ plugin: who.plugin, pluginName: who.pluginName, appTitle: who.appTitle, perm, signal }));
}

// signal：框的寿命（见 handle），透传给授权框与两个选择器，abort 时它们按取消 / 不允许回
// chan：原生转来时走的通道（r.kind）。pick 通道上来的跳转（旧版 apk）收场时关掉插件页，不记原生返回
async function run(type, info, plugin, signal, chan) {
  const p = info.payload && typeof info.payload === 'object' ? info.payload : {};
  const who = { plugin, pluginName: String(info.pluginName || plugin), appTitle: String(info.appTitle || '') };
  if (type === 'nav') {
    const { pageNav } = await import('./pageNav.js');
    const ok = !!(await pageNav(plugin, { to: p.to, session: p.session, rel: p.rel, ws: p.ws, app: p.app }));
    if (ok && chan !== 'pick') await noteNative(plugin, p);
    return { ok };
  }
  if (type === 'composer') {
    const { pageComposer } = await import('./pageNav.js');
    pageComposer(String(p.text ?? ''));
    // 交给 Claude 是异步的、被拒（分页没开放）就不会到 Claude 页：记录到期自己作废
    if (chan !== 'pick') setNativeReturn('claude');
    return { ok: true };
  }
  if (type === 'grant') return { allow: await ensureGrant(who, String(p.perm || ''), null, signal) };
  if (type === 'pick.file') {
    // 同 GET host-request 的退避：这一步拿不到就整单按取消收场，人得回插件页重点一次
    const g = await retrying(() => grantsOf(plugin));
    if (!g.declared.some((d) => d?.id === 'page.files')) {
      showToast(t('插件「{name}」没有声明文件权限，选不了文件', { name: who.pluginName }), 'err');
      return { cancelled: true, failed: true };
    }
    if (!(await ensureGrant(who, 'page.files', g, signal))) return { cancelled: true };
    const { pickFiles } = await import('./filePicker.svelte.js');
    const items = await pickFiles({ multiple: p.multiple === true, accept: String(p.accept || ''), signal });
    if (!Array.isArray(items) || !items.length) return { cancelled: true };
    return { items: items.map((it) => ({ rel: String(it.rel || ''), ws: String(it.ws || '') })) };
  }
  if (type === 'pick.session') {
    const { pickSession } = await import('./sessionPicker.svelte.js');
    const s = await pickSession({ signal });
    return s && s.sessionId ? { sessionId: String(s.sessionId), title: String(s.title || '') } : { cancelled: true };
  }
  return null;
}

async function handle(r) {
  // 排进队以后才掉的登录 / 停的总线（含前面那条 parkForLogin 刚落成没登录）：收回来排着，就绪后 drain 接着处理
  if (!ready || !loggedIn()) { stash(r); return; }
  const { req, kind, plugin } = r;
  const base = '/api/plugins/host-requests/' + req;
  // 上回做完了、只差 complete 时撞上登录过期：登录后带着原来的结果接着交，不让人再选一遍
  if (r.done) { await finish(r, base, r.done.type, r.done.result, false); return; }
  let info;
  try { info = await retrying(() => api.get(base)); }
  catch (e) {
    const st = e?.status;
    if (st === 401 && await parkForLogin(r)) return;
    // 409 = 已经处理过了（重复派发），不吵；404（过期、不是这个账号的）要说一声，不然人只看到界面闪了一下
    if (st !== 409) showToast(errText(e), 'err');
    // 过期 / 已处理以外的失败：照样回个否定结果收场，页面那头才不干等。服务端对哪种类型都把
    // { cancelled: true } 当成取消 / 不允许 / 没跳（grant 只认 allow === true，nav 只认 ok）
    if (st !== 404 && st !== 409) await complete(base, { cancelled: true });
    if (kind === 'pick') resumePage(st === 409 ? 0 : ERR_RESUME_MS);
    // 新版 apk 走 nav 通道时插件页让到了后台、没关：没拿到要做什么就没人切回它，人只看到主界面闪了一下。
    // 409 是前一次已经处理过（已经跳到地方了），不再切回去
    else if (kind === 'nav' && st !== 409 && pageAlive()) resumePage(ERR_RESUME_MS);
    return;
  }
  const type = String(info?.type || '');
  let result = DENY[type] || { cancelled: true };
  let failed = false, late = false;
  if (!info || info.plugin !== plugin) {
    // 原生说是 A 插件的页面，服务端记的是 B：不替谁做事，按拒绝收场
    try { console.warn('[pluginHost] plugin mismatch', plugin, info?.plugin); } catch {}
  } else {
    // 框的寿命：赶在服务端请求过期之前到点，到点 abort，框按取消 / 不允许收掉（同 PluginFrame 给框的 signal）。
    // 排着等登录 / 等前一个框时已经过了点的，不再弹框也不再跳，直接回否定结果
    const left = r.at + HOST_TTL_MS - TTL_MARGIN_MS - Date.now();
    const ac = new AbortController();
    const timer = left > 0 && RESUME_TYPES.has(type) ? setTimeout(() => { late = true; ac.abort(); }, left) : null;
    try {
      if (left <= 0) late = true;
      else {
        const x = await run(type, info, plugin, ac.signal, r.kind);
        if (x && !late) { failed = !!x.failed; delete x.failed; result = x; }
      }
    } catch (e) {
      if (e?.status === 401 && await parkForLogin(r)) return;
      failed = true;
      showToast(errText(e), 'err');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (late) { failed = true; result = DENY[type] || { cancelled: true }; showToast(t('插件页面的这个请求等太久，已经作废了；回到插件页面再点一次'), 'err'); }
  }
  await finish(r, base, type, result, failed, late);
}

// 交结果并收场：grant / pick.* 切回插件页（出了错晚一点，让人看得到提示）；pick 通道上来的跳转关掉压在后面的插件页
async function finish(r, base, type, result, failed, late = false) {
  const bad = await complete(base, result);
  if (bad?.status === 401) {
    r.done = { type, result };
    if (await parkForLogin(r)) return;
  }
  // pick.file 签句柄失败（文件不合格、授权刚被撤）时服务端已按取消给页面收场，这里只把原因告诉人。
  // 到点作废的那条已经提示过了，服务端恰好先一步过期回的 404 不再报第二遍
  if (bad) { failed = true; if (!(late && bad.status === 404)) showToast(errText(bad), 'err'); }
  if (RESUME_TYPES.has(type)) resumePage(failed ? ERR_RESUME_MS : 0);
  else if (r.kind === 'pick') { try { store()?.closePluginPage?.(); } catch {} }   // 跳走了：压在后面的插件页不再留着
  // 跳转没成（目标不合格、分页没开放、出错）而插件页还压在后面：人停在原地对着主界面，晚一点切回插件页（看得到提示）
  else if ((type === 'nav' || type === 'composer') && (failed || result?.ok !== true) && pageAlive()) resumePage(ERR_RESUME_MS);
}

/** App 启动时调一次：只有手机 App 里才挂（原生在 onResume 里找 window.__bridgePluginHost）。 */
export function registerPluginHostRelay() {
  if (registered || !store()) return;
  registered = true;
  window.__bridgePluginHost = (o) => { try { accept(o); } catch {} };
}

/** 登录且总线就绪（App 的总线 effect 里调）：取冷启动时原生记下的请求，稍等界面落定后处理排着的。 */
export function pluginHostReady() {
  registerPluginHostRelay();   // 总线 effect 可能比 onMount 先跑：这里也挂一次（幂等）
  if (!registered) return;
  ready = true;
  try {
    const pend = store()?.takePluginHost?.();
    if (pend) { const r = parse(pend); if (r && !seen.has(r.req)) { remember(r.req); stash(r); } }
  } catch {}
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(drain, DRAIN_DELAY_MS);
}

/** 退出登录 / 总线停下（总线 effect 的清理里调）：之后来的请求先收着，等下次就绪。 */
export function pluginHostIdle() {
  ready = false;
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
}
