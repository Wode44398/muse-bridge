// bridge 插件页面 SDK（/plugins/_sdk/bridge-plugin.js）。插件页面里：
//
//   import { bridge } from '/plugins/_sdk/bridge-plugin.js';
//   const info = await bridge.ready();             // { pluginId, theme: 'dark'|'light', lang, platform, user, mode: 'embed'|'panel'|'standalone', app }
//   const data = await bridge.json('groups');      // GET /api/plugin/<id>/groups → JSON（非 2xx 抛错，message = 接口给的 error）
//   await bridge.json('send', { text: 'hi' });     // 带第二个参数 = POST JSON
//   const r = await bridge.fetch('raw', { method: 'POST', body: '…' });   // 类 Response：ok / status / json() / text() / blob()
//   const off = bridge.on('reply', (payload) => …); // 插件 ctx.bus.toPage('reply', payload) 推来的
//   bridge.toast('已保存'); await bridge.confirm({ title: '清空？', danger: true });
//   const src = await bridge.blobUrl('image?id=1');  // 要登录才拿得到的图片 → blob: 地址
//   bridge.openExternal(url); bridge.back();
//   bridge.go('detail.html?id=3');                 // 用脚本跳到本插件别的页面（接上 bridge 给的 #；别用 location.href = 'x.html'）
//   const c = bridge.context();                   // { sessionId, cwd, agent, app, file }：工作台标签里有会话与目录；应用分页里有 app（没有的为 null，agent 缺省 'claude'）
//   bridge.app();                                  // 插件应用（主页图标 + 全屏分页）里：{ plugin, id }，别处 null（= context().app = info.app）
//   bridge.on('context', (c) => …);               // 用户切了会话 / 工作目录
//
// 插件自己的设置与动作（只有服务器主机能用；不用插件写接口）：
//   const { schema, config } = await bridge.config.get();
//   await bridge.config.set({ paused: true });        // 合并进当前配置，按 schema 校验；插件登记了 ctx.onConfig 就热更新
//   await bridge.options('model');                    // 字段的选项（claude.models / users / 插件 ctx.configOptions…）
//   await bridge.actions(); await bridge.action('probe');   // 详情页那些按钮
//   await bridge.status();                            // 状态块 + 子进程 + 定时任务 + 用量
//   bridge.form(el, { fields: ['prefix', 'paused'] }); // 在页面里画一份设置表单（按清单 schema，改了即存）
//
// 页面宿主能力（主机与对成员开放了页面的成员都能用）。用之前先 bridge.can(名字) 探测——老宿主、旧版 App 没有：
//   bridge.can('kv' | 'chat' | 'files' | 'nav' | 'composer' | 'grant' | 'pick.file' | 'pick.session') → boolean（ready 之后才准）
//   await bridge.kv.get('count'); await bridge.kv.set('count', 3); await bridge.kv.delete('count'); await bridge.kv.list();
//                                                     // 存在服务器上、每个使用者一份；值是 JSON，set(k, null) = 删除
//   await bridge.grants();                            // { declared: [{ id, label }], granted: { 'page.chat': '<ISO 时间>' } }
//   await bridge.requestGrant('page.chat');           // 弹 bridge 自己画的授权框 → true / false（已授权直接 true，不弹）
//   const { sessionId } = await bridge.chat.start({ prompt: '你好' });   // 以使用者身份开一个真会话（没授权时先自动 requestGrant）
//   const off = bridge.chat.on(sessionId, (ev) => …);  // 事件：turn / text（增量）/ tool / approval / approval.done / done / error
//   await bridge.chat.send(sessionId, '接着说');      // → { ok, queued }（这一轮还在跑就排队）
//   await bridge.chat.stop(sessionId); await bridge.chat.sessions({ app? }); await bridge.chat.history(sessionId);
//   const files = await bridge.pick.file({ multiple: false, accept: '.md,text/*' });   // [{ handle, name, size, mime, mode }] | null
//   const text = await bridge.files.read(files[0].handle, { as: 'text' });   // as：text | json | blob | arrayBuffer
//   await bridge.files.write(handle, '新内容'); await bridge.files.stat(handle);
//   await bridge.pick.session();                      // { sessionId, title } | null
//   bridge.nav.session(id); bridge.nav.file({ rel, ws }); bridge.nav.app('<id>' 或 '<插件>:<id>'); bridge.nav.settings(); bridge.nav.home();
//   bridge.composer.prefill('帮我看看…');            // 跳到 Claude 分页、新对话、填好输入框，不代发
// 对话事件的细节：订阅断了 SDK 自己退避重连；重连时服务端会补发正在跑的那一轮，SDK 把已经给过的部分去掉，页面看到的是接续的流。
//   断线期间那一轮已经结束了：补一个 { type: 'done', ok: null, missed: true }（中间的内容没收到，要的话用 chat.history 补）；
//   订阅本身失败（没授权、会话不是这个插件的、票据过期…）：给一个 { type: 'error', kind: 'stream', message, status? } 然后停。
//   页面不能代批审批：approval 只是通知，去 Claude 分页批（bridge.nav.session）。一个页面最多同时 4 路订阅。
//   独立页（手机 App）订阅着、又在前台时，SDK 自动告诉 bridge「这个会话有人在看」，那一轮结束就不再弹系统通知（提问与审批照弹）。
//
// 页面跑在不透明源里（iframe sandbox / CSP sandbox），拿不到 bridge 的 cookie 与 localStorage——这是故意的。
//   · 嵌在 bridge 里（设置详情 / 面板）：请求经 postMessage 交给宿主页代发，宿主只放行 /api/plugin/<本插件>/ 下的路径；
//     宿主只认带着地址 # 里 nonce 的消息（见下面 NONCE）：页面改地址时别把 bridge 给的 # 整个换掉，不然刷新之后宿主不再理它；
//     跳到本插件别的页面：普通链接 SDK 自动接上 #，脚本跳转用 bridge.go()；
//     主线程被占满好几秒（宿主问「还在不在」没及时答）时宿主会当页面走了：SDK 收到 reset 自己重连，
//     在等的请求报 status 0（同断网，可重试），对话订阅自己接上；
//   · 独立打开（新窗口、手机 App 的插件页）：地址的 #t= 带着插件票据，SDK 直接带票请求。
//     跳转、授权、选择器这些要 bridge 主界面出面的操作：手机 App（地址带 #hc=1）经服务端中转——登记请求、让 App 切回主界面处理、
//     页面回来取结果；没有 hc=1（旧版 App、浏览器新窗口）这些操作直接报「要新版 bridge App」。
// 主题：<html> 上有 data-theme、--bp-* 颜色变量随宿主实时更新；引 /plugins/_sdk/bridge-plugin.css 就有一套现成控件样式。

const hash = new URLSearchParams(location.hash.slice(1));
const embedded = window.parent !== window;
const pluginId = (/^\/plugins\/([a-z][a-z0-9-]{0,47})\//.exec(location.pathname) || [])[1] || '';
const ticket = hash.get('t') || '';
// 手机 App 会接 bridge-host:// 中转：只有这时独立页面的宿主类操作才走得通
const hc = !embedded && hash.get('hc') === '1';
// 宿主（PluginFrame）每次挂载随机生成、放在 iframe 地址 # 里的口令：发给宿主的每条消息都带上，宿主只认带对了的。
// 宿主核的 e.source 是 iframe 的窗口，iframe 被链接 / 脚本导航到别的站点之后窗口还是同一个——那个页面拿不到口令，
// 就冒充不了插件页面去用代发、对话订阅、授权框这些。刷新（location.reload）保留 #，口令还在。
const NONCE = embedded ? hash.get('nonce') || '' : '';
// 这一份文档的号：离开时报 bye 用（宿主据此收掉它的订阅与框）；新旧文档的消息到宿主的先后不一定，宿主只认对得上号的
const DOC = randomId();
function randomId() {
  try {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
// 宿主声明的能力（嵌入时随 init 给；老宿主没有 = 空）
let caps = new Set();
// 不透明源里 location.origin 是字符串 "null"，服务器地址得自己拼
const SERVER = location.protocol + '//' + location.host;
const listeners = new Map();   // 事件名 → Set<fn>
const pending = new Map();     // 请求号 → { resolve, reject }
const hostSubs = new Map();    // 嵌入模式的对话订阅：订阅号 → ChatSub（宿主推来的 chat.event / chat.end 按号分发）
let seq = 0;
let info = null;
// SDK 自己的提示语按页面语言给中英两份（插件页面没有 bridge 的字典）
const isEnglish = () => /^en/i.test((info && info.lang) || hash.get('lang') || '');
const L = (zh, english) => (isEnglish() ? english : zh);
// 当前上下文（工作台标签用）：嵌入时宿主随 init 给、切会话再推 context；独立打开（手机 App）从地址的 # 读
// file：bridge 里「用「某应用」打开」某个文件时交来的 { handle, name, size, mime, mode }：嵌入时宿主随 init / context 给，
// 独立打开时在地址 # 的 fh / fn / fs / fm / fmo 里；没有就是 null。原样浅拷贝，别让页面改到宿主给的那份。
const readCtx = (c) => ({
  sessionId: c && typeof c.sessionId === 'string' && c.sessionId ? c.sessionId : null,
  cwd: c && typeof c.cwd === 'string' && c.cwd ? c.cwd : null,
  agent: c && c.agent === 'dimensio' ? 'dimensio' : 'claude',
  file: c && c.file && typeof c.file === 'object' && !Array.isArray(c.file) ? { ...c.file } : null,
});
// 独立页地址 # 里的文件：没有句柄就当没有（名字之类只是展示用，没句柄读不了）
function hashFile() {
  const handle = hash.get('fh');
  if (!handle) return null;
  const fs = hash.get('fs');
  const size = fs == null || fs === '' ? NaN : Number(fs);
  return {
    handle, name: hash.get('fn') || '', size: Number.isFinite(size) && size >= 0 ? size : null,
    mime: hash.get('fm') || '', mode: hash.get('fmo') === 'r' ? 'r' : 'rw',
  };
}
let ctx = readCtx({ sessionId: hash.get('sid'), cwd: hash.get('cwd'), agent: hash.get('agent'), file: embedded ? null : hashFile() });
// 这个页面是哪个插件应用的分页：嵌入时宿主随 init 给（{ plugin, id }），独立打开从地址的 #app= 读。
// 整个页面生命期不变（切会话推来的 context 不带它）；plugin 一律取自己的 id，宿主给错了也不会指到别家插件。
const readApp = (a) => {
  const id = typeof a === 'string' ? a : a && typeof a === 'object' ? a.id : '';
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id) ? { plugin: pluginId, id } : null;
};
let app = embedded ? null : readApp(hash.get('app'));
const ctxView = () => ({ ...ctx, app: app ? { ...app } : null, file: ctx.file ? { ...ctx.file } : null });
let readyResolve;
const readyP = new Promise((r) => { readyResolve = r; });

const TOKENS = ['bg', 'card', 'text', 'muted', 'line', 'hover', 'accent', 'brand', 'ok', 'warn', 'crit', 'field'];
function applyTheme(theme, vars) {
  const root = document.documentElement;
  root.dataset.theme = theme === 'light' ? 'light' : 'dark';
  root.style.colorScheme = root.dataset.theme;
  if (vars) for (const k of TOKENS) if (vars[k]) root.style.setProperty('--bp-' + k, vars[k]);
  if (vars && vars.radius) root.style.setProperty('--bp-radius', vars.radius);
}
// 先按地址里的提示上主题（宿主的 init 还没到时别先闪一下白）
applyTheme(hash.get('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
document.documentElement.dataset.mode = embedded ? (hash.get('mode') || 'embed') : 'standalone';

function emit(event, payload) {
  for (const fn of listeners.get(event) || []) { try { fn(payload); } catch (e) { console.error(e); } }
}

// ── 嵌入模式：和宿主对话 ─────────────────────────────────────────────────
// 口令和文档号放在最后：msg 里混进同名字段也盖不掉它们。每条都带文档号：宿主只认 hello 过的那一份文档发来的，
// 旧文档迟到的请求（新旧文档的请求号都从 1 数）不会被当成新文档的、回到新文档那里对错号
function post(msg, transfer) { window.parent.postMessage({ bp: 1, ...msg, doc: DOC, nonce: NONCE }, '*', transfer || []); }
function call(type, data, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type, id, ...data }, transfer);
  });
}
// 本插件自己的页面：同一个服务器、路径在 /plugins/<本插件>/ 下（按浏览器解析、归一化之后看，'../别家/' 出不去）。是就回解析好的 URL
function ownPage(href) {
  if (!pluginId) return null;
  let u;
  try { u = new URL(String(href ?? ''), location.href); } catch { return null; }
  return u.protocol + '//' + u.host === SERVER && u.pathname.startsWith('/plugins/' + pluginId + '/') ? u : null;
}
// 只认普通左键点的、在本框里打开的本插件页面链接；改的是 href，点击照常走（见嵌入模式那段的说明）
function keepHashOnLink(e) {
  if (!location.hash || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const t = path[0] && typeof path[0].closest === 'function' ? path[0] : e.target;
  const a = t && typeof t.closest === 'function' ? t.closest('a[href]') : null;
  // SVG 里的 <a> 的 href 不是字符串，不管
  if (!a || typeof a.href !== 'string') return;
  const target = a.getAttribute('target');
  if ((target && target.toLowerCase() !== '_self') || a.hasAttribute('download')) return;
  if ((a.getAttribute('href') || '').includes('#')) return;
  const u = ownPage(a.href);
  if (u) a.href = u.href + location.hash;
}
// GET 表单同理：提交到本插件别的页面时 # 接到 action 上（GET 提交只换查询串、保留 action 的 #）。
// 没写 action 的表单提交到当前地址，本来就带着 #，不用管；POST 提交到的是接口不是页面，不管
function keepHashOnForm(e) {
  const f = e.target;
  if (!location.hash || !f || f.tagName !== 'FORM') return;
  const s = e.submitter && typeof e.submitter.getAttribute === 'function' ? e.submitter : null;
  const over = (n) => (s && s.hasAttribute(n) ? s.getAttribute(n) || '' : null);
  const method = (over('formmethod') ?? f.getAttribute('method') ?? 'get').toLowerCase();
  const target = over('formtarget') ?? f.getAttribute('target') ?? '';
  if (method !== 'get' || (target && target.toLowerCase() !== '_self')) return;
  const viaSubmitter = over('formaction') != null;
  const raw = viaSubmitter ? over('formaction') : f.getAttribute('action');
  if (!raw || raw.includes('#')) return;
  const u = ownPage(raw);
  if (!u) return;
  if (viaSubmitter) s.setAttribute('formaction', u.href + location.hash);
  else f.setAttribute('action', u.href + location.hash);
}
if (embedded) {
  const hello = () => post({ type: 'hello', pluginId, doc: DOC });
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.bp !== 1) return;
    if (m.type === 'init') {
      // 收到 reset 重新 hello 之后宿主会再给一次 init：断开期间宿主推的主题、上下文都没送到，变了的这里补一个事件。
      // info 原地更新：页面手里拿着的是 ready() 给的那个对象，换成新对象它就再也看不到变化了
      const again = !!info;
      const was = again ? { theme: info.theme, ctx: JSON.stringify(ctxView()) } : null;
      app = readApp(m.app);
      const next = { pluginId, theme: m.theme, lang: m.lang, platform: m.platform, user: m.user, mode: m.mode || 'embed', app: app ? { ...app } : null };
      if (info) Object.assign(info, next); else info = next;
      caps = new Set(Array.isArray(m.caps) ? m.caps.filter((x) => typeof x === 'string') : []);
      if (m.context) ctx = readCtx(m.context);
      applyTheme(m.theme, m.vars);
      document.documentElement.dataset.mode = info.mode;
      readyResolve(info);
      if (again) {
        if (info.theme !== was.theme) emit('_theme', info.theme);
        if (JSON.stringify(ctxView()) !== was.ctx) emit('context', ctxView());
      }
    } else if (m.type === 'reset') {
      // 宿主把这份文档摘错了：iframe 又 load 了一次、这边主线程忙得没及时答 probe，它当这份文档已经走了，
      // 那之后推来的回话、对话事件都没送到，这边发过去的它也一条没办。不重连就整页失联（hello 只在加载时发一次、
      // 请求没有超时、订阅等着永远不来的 chat.end），所以：先重新 hello（之后发的都排在它后面，宿主照新文档接上）；
      // 在等的请求一律拒掉——状态 0，同断网：可能已经办了也可能没办，重试与否页面自己定；
      // 对话订阅当断线处理（照常退避重连、去掉补发里给过的部分）；高度重报一次（断开期间报的宿主没收）
      hello();
      const ps = [...pending.values()];
      pending.clear();
      for (const p of ps) p.reject(errOf(L('和 bridge 的连接断了一下，请重试', 'The connection to bridge was interrupted — try again'), { status: 0 }));   // i18n-ignore SDK 自带中英两份（L），不进 bridge 字典
      for (const s of [...hostSubs.values()]) s.hostEnded('');
      lastH = 0;
      report();
    } else if (m.type === 'theme') {
      if (info) info.theme = m.theme;
      applyTheme(m.theme, m.vars);
      emit('_theme', m.theme);
    } else if (m.type === 'context') {
      ctx = readCtx(m.context);
      emit('context', ctxView());
    } else if (m.type === 'event') {
      emit(m.event, m.payload);
    } else if (m.type === 'reply' && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      // detail：宿主附带的状态码 / needGrant 等，订阅重连据此分清「别再试了」和「过会儿再试」
      if (m.error) p.reject(errOf(m.error, m.detail)); else p.resolve(m.value);
    } else if (m.type === 'chat.event') {
      hostSubs.get(m.sub)?.handle(m.event);
    } else if (m.type === 'chat.end') {
      hostSubs.get(m.sub)?.hostEnded(m.error);
    } else if (m.type === 'probe') {
      // iframe 又 load 了一次，宿主来问「现在在里面的还是不是你」：报上文档号（post 自带），它对得上才接着推
      post({ type: 'here' });
    }
  });
  if (!NONCE) console.warn('[bridge-plugin] ' + L('地址 # 里没有 bridge 给的 nonce：bridge 不会理这个页面的消息（改地址时保留 bridge 给的 #，跳到插件别的页面用 bridge.go()）', 'No bridge nonce in the URL # — bridge will ignore this page (keep the # bridge gave when changing the URL; use bridge.go() to open another page of the plugin)'));
  hello();
  // 离开这份文档（跳走、刷新）：告诉宿主当场收掉它的对话订阅和挂着的框，别再往换上来的文档里推。
  // 进往返缓存（persisted）的不报：整页回来时这份文档还在，订阅得接着用
  addEventListener('pagehide', (e) => { if (!e || !e.persisted) post({ type: 'bye', doc: DOC }); });
  // 多页插件：点本插件别的页面的普通链接（<a href="b.html">）时把 bridge 给的 # 接上，新页面照样连得上宿主。
  // 捕获阶段、只改 href 不拦点击（页面自己的点击处理照常跑、照样能 preventDefault）。只管同源、落在 /plugins/<本插件>/ 下、
  // 不带 target（_self 除外）/ download、没按修饰键的左键、href 里本来没有 # 的——别的站点的链接一律不碰（口令不能带出去）
  addEventListener('click', keepHashOnLink, true);
  addEventListener('submit', keepHashOnForm, true);
  // 高度自动上报（嵌在设置详情里时宿主据此撑高 iframe，不出双滚动条）
  let lastH = 0;
  const report = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - lastH) > 1) { lastH = h; post({ type: 'resize', height: h }); }
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
} else {
  info = {
    pluginId, theme: document.documentElement.dataset.theme, lang: hash.get('lang') || (navigator.language || '').slice(0, 2),
    platform: hash.get('platform') || 'web', user: null, mode: 'standalone', app: app ? { ...app } : null,
  };
  readyResolve(info);
  if (!ticket) console.warn('[bridge-plugin] 没有插件票据：请从 bridge 里打开这个页面');
  // 独立页（手机 App 的干净页面、新窗口）的 # 里是插件票据 t= 等：点本插件别的页面的普通链接 / 提交 GET 表单时同样接上，
  // 不然一跳页就没了票据、什么请求都 401。规则同嵌入模式（只认同源、本插件路径下的；别的站点的一律不碰，票据不能带出去）
  addEventListener('click', keepHashOnLink, true);
  addEventListener('submit', keepHashOnForm, true);
}

// ── 请求 ─────────────────────────────────────────────────────────────────
// 路径只能落在 /api/plugin/<本插件>/ 下。每一段都查、按解码后的样子查：'%2e%2e'、'.%2e' 这类编码点段浏览器拼地址时一样当 '..'
// 归一化，Tab / 换行解析时被删掉（'.\t.' 变 '..'）。这里只是让页面早点拿到清楚的报错——真正把关的是宿主（只放行本插件前缀）
// 和服务端（票据只在本插件的路由上认），页面绕开 SDK 也越不过去。片段（#…）去掉：fetch 本来就不发它。
const cleanPath = (p) => {
  const s = String(p ?? '').replace(/^\/+/, '').replace(/#[\s\S]*$/, '');
  let bad = /^[a-z][a-z0-9+.-]*:/i.test(s) || /[\\\x00-\x1f\x7f]/.test(s);
  for (const seg of bad ? [] : s.split('?')[0].split('/')) {
    let d;
    try { d = decodeURIComponent(seg); } catch { bad = true; break; }
    if (d === '.' || d === '..' || /[/\\\x00-\x1f\x7f]/.test(d)) { bad = true; break; }
  }
  if (bad) throw new Error(L('路径不合法：', 'Invalid path: ') + p);
  return s;
};

function makeResponse(status, headers, buf) {
  const type = headers['content-type'] || '';
  return {
    ok: status >= 200 && status < 300, status, headers,
    arrayBuffer: async () => buf,
    text: async () => new TextDecoder().decode(buf),
    json: async () => JSON.parse(new TextDecoder().decode(buf) || 'null'),
    blob: async () => new Blob([buf], { type }),
  };
}

let expiredShown = false;
function showExpired() {
  if (expiredShown) return;
  expiredShown = true;
  const d = document.createElement('div');
  d.className = 'bp-expired';
  d.textContent = L('这个页面的访问凭证过期了，请从 bridge 里重新打开。', 'This page’s access has expired. Open it again from bridge.');
  document.body.appendChild(d);
}

// 出错统一成 Error，再挂上能据以判断的字段：status（HTTP 状态）、needGrant（要先授权的权限）、undeclared + perm（清单没声明）
function errOf(message, d) {
  const e = new Error(String(message || 'error'));
  if (d && typeof d === 'object') {
    if (typeof d.status === 'number') e.status = d.status;
    if (typeof d.needGrant === 'string' && d.needGrant) e.needGrant = d.needGrant;
    if (d.undeclared) e.undeclared = true;
    if (typeof d.perm === 'string' && d.perm) e.perm = d.perm;
  }
  return e;
}
async function responseError(r) {
  let j = null;
  try { j = await r.json(); } catch {}
  const e = errOf((j && (j.error || j.message)) || ('HTTP ' + r.status), j && typeof j === 'object' ? { ...j, status: r.status } : { status: r.status });
  e.body = j;
  return e;
}

async function bfetch(path, opts = {}) {
  await readyP;
  const rel = cleanPath(path);
  const method = String(opts.method || 'GET').toUpperCase();
  let body = opts.body;
  const headers = { ...(opts.headers || {}) };
  if (body != null && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Blob) && !ArrayBuffer.isView(body)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (embedded) {
    let payload = body;
    if (payload instanceof Blob) payload = await payload.arrayBuffer();
    else if (ArrayBuffer.isView(payload)) payload = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    const r = await call('fetch', { path: rel, method, headers, body: payload ?? null }, payload instanceof ArrayBuffer ? [payload] : []);
    return makeResponse(r.status, r.headers || {}, r.body || new ArrayBuffer(0));
  }
  const res = await fetch(SERVER + '/api/plugin/' + pluginId + '/' + rel, {
    method, body, headers: { ...headers, Authorization: 'Plugin ' + ticket }, credentials: 'omit',
  });
  if (res.status === 401) showExpired();
  const buf = await res.arrayBuffer();
  const h = {};
  res.headers.forEach((v, k) => { h[k] = v; });
  return makeResponse(res.status, h, buf);
}

async function bjson(path, data) {
  const r = await bfetch(path, data === undefined ? {} : { method: 'POST', body: data ?? {} });
  if (!r.ok) throw await responseError(r);
  let j = null;
  try { j = await r.json(); } catch {}
  return j;
}

// SSE 按块拆：空行分隔，data: 行拼起来是一条 JSON；注释行（: ok / : ping 心跳）没有 data，跳过。
// 只把 \r\n 规整成 \n（服务端只写 \n）；在拼好的缓冲上规整，免得 \r 和 \n 落在两块里被当成两个换行。
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        try { onEvent(ev); } catch (e) { console.error(e); }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// 独立页面的事件流：fetch 流读（票据放请求头，不进地址）；断了退避重连，票过期就停。
let streamOn = false;
async function openStream() {
  if (streamOn || embedded || !ticket) return;
  streamOn = true;
  let delay = 1000;
  for (;;) {
    try {
      const res = await fetch(SERVER + '/api/plugins/page-events?id=' + pluginId, { headers: { Authorization: 'Plugin ' + ticket }, credentials: 'omit' });
      if (res.status === 401) { showExpired(); return; }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      delay = 1000;
      await readSse(res.body, (ev) => { if (ev && ev.type === 'plugin.event') emit(ev.event, ev.payload); });
    } catch {}
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(30_000, delay * 2);
  }
}

// ── 小界面 ───────────────────────────────────────────────────────────────
function localToast(text, error) {
  const t = document.createElement('div');
  t.className = 'bp-toast' + (error ? ' bp-toast-err' : '');
  t.textContent = String(text);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('bp-toast-out'), 2200);
  setTimeout(() => t.remove(), 2600);
}

// ── 插件自己的设置 / 动作 ─────────────────────────────────────────────────
const config = {
  get: () => bjson('_bridge/config'),
  async set(patch, { confirmGrant = false } = {}) {
    const r = await bfetch('_bridge/config', { method: 'POST', body: { patch, confirmGrant } });
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 409 && j && j.needConfirm) {
      const names = (j.needConfirm.accounts || []).map((a) => a.name).join('、');
      if (!(await bridge.confirm({ title: '授权「' + names + '」？', desc: '插件将能以这个账号的身份跑 Claude（它有命令行，权限大）。', yes: '授权', danger: true }))) throw new Error('没有授权');
      return config.set(patch, { confirmGrant: true });
    }
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return j;
  },
};
const options = async (field) => (await bjson('_bridge/options?field=' + encodeURIComponent(field))).options || [];
const actions = async () => (await bjson('_bridge/actions')).actions || [];
const status = () => bjson('_bridge/status');
async function runAct(id, args, { confirm: ask = true } = {}) {
  if (ask) {
    const a = (await actions()).find((x) => x.id === id);
    if (a && (a.confirm || a.danger) && !(await bridge.confirm({ title: a.label + '？', desc: a.confirm || a.desc || '', yes: a.label, danger: !!a.danger }))) return null;
  }
  return bjson('_bridge/action', { action: id, args: args || {} });
}

// ── 设置表单（按清单 schema 画，改了即存）────────────────────────────────
// bridge.form(el, { fields?, exclude?, sections?, onChange? }) → { refresh(), destroy() }
//   fields：只画这些字段（按给的顺序）；exclude：不画这些；sections：只画这些分组。
//   支持：开关、文字 / 多行 / 密码、数字 / 滑块、枚举（分段 / 下拉）、动态选项（下拉）、字符串列表（有选项 = 勾选列表，否则一行一项）。
//   按群设置这类表（map）、对象、账号授权不画（显示一行「在插件详情里改」）。
function form(el, opts = {}) {
  let data = null;
  let destroyed = false;
  const optCache = new Map();
  const en = () => /^en/i.test((info && info.lang) || '');
  const tx = (k, prop, zh) => (en() && data?.i18n?.en?.config?.[k]?.[prop]) || zh || '';
  const enumOf = (k, spec) => (spec.enum || []).map((e) => (e && typeof e === 'object' ? { value: e.value, label: (en() && data?.i18n?.en?.config?.[k]?.enum?.[e.value]) || e.label || String(e.value) } : { value: e, label: String(e) }));
  const visible = (spec) => {
    if (!spec.when) return true;
    return Object.entries(spec.when).every(([f, v]) => (Array.isArray(v) ? v.includes(data.config[f]) : data.config[f] === v));
  };
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  async function save(k, v, revert) {
    try {
      const r = await config.set({ [k]: v });
      data.config = r.config;
      opts.onChange?.(k, r.config[k], r.config);
      draw();
    } catch (e) { bridge.toast(e.message, { error: true }); revert?.(); }
  }
  async function getOptions(k) {
    if (!optCache.has(k)) optCache.set(k, options(k).catch(() => []));
    return optCache.get(k);
  }
  function control(k, spec) {
    const v = data.config[k];
    if (spec.type === 'boolean') {
      const lab = h('label', 'bp-switch');
      const inp = h('input'); inp.type = 'checkbox'; inp.checked = !!v;
      inp.onchange = () => save(k, inp.checked, () => { inp.checked = !inp.checked; });
      lab.append(inp, h('span'));
      return lab;
    }
    if ((spec.type === 'string' || spec.type === 'integer' || spec.type === 'number') && Array.isArray(spec.enum) && spec.enum.length) {
      const list = enumOf(k, spec);
      if (spec.widget === 'segmented' || list.length <= 3) {
        const seg = h('div', 'bp-seg');
        for (const o of list) {
          const b = h('button', o.value === v ? 'on' : '', o.label);
          b.type = 'button';
          b.onclick = () => { if (o.value !== v) save(k, o.value); };
          seg.append(b);
        }
        return seg;
      }
      const sel = h('select', 'bp-select');
      for (const o of list) { const op = h('option', '', o.label); op.value = String(o.value); if (o.value === v) op.selected = true; sel.append(op); }
      sel.onchange = () => { const o = list.find((x) => String(x.value) === sel.value); save(k, o ? o.value : sel.value); };
      return sel;
    }
    if (spec.type === 'string' && spec.options) {
      const sel = h('select', 'bp-select');
      const first = h('option', '', en() ? '(not set)' : '（不选）'); first.value = ''; sel.append(first);
      if (v) { const cur = h('option', '', String(v)); cur.value = v; cur.selected = true; sel.append(cur); }
      getOptions(k).then((list) => {
        if (destroyed) return;
        sel.textContent = ''; sel.append(first);
        for (const o of list) { const op = h('option', '', o.label + (o.desc ? ' · ' + o.desc : '')); op.value = String(o.value); if (o.value === v) op.selected = true; sel.append(op); }
        if (v && !list.some((o) => o.value === v)) { const cur = h('option', '', String(v)); cur.value = v; cur.selected = true; sel.append(cur); }
      });
      sel.onchange = () => save(k, sel.value);
      return sel;
    }
    if (spec.type === 'string') {
      const multi = spec.widget === 'textarea';
      const inp = h(multi ? 'textarea' : 'input', multi ? 'bp-textarea' : 'bp-input');
      if (!multi) inp.type = spec.secret || spec.widget === 'password' ? 'password' : 'text';
      inp.value = v == null ? '' : String(v);
      if (spec.max) inp.maxLength = spec.max;
      inp.onchange = () => save(k, inp.value, () => { inp.value = v == null ? '' : String(v); });
      return inp;
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      const wrap = h('div', 'bp-num');
      const inp = h('input', 'bp-input'); inp.type = 'number';
      if (spec.min != null) inp.min = spec.min; if (spec.max != null) inp.max = spec.max;
      if (spec.type === 'integer') inp.step = '1';
      inp.value = v == null ? '' : String(v);
      inp.onchange = () => { const n = Number(inp.value); save(k, spec.type === 'integer' ? Math.round(n) : n, () => { inp.value = String(v); }); };
      wrap.append(inp);
      return wrap;
    }
    if (spec.type === 'array' && spec.items && !spec.items.fields && spec.items.type !== 'user') {
      const cur = Array.isArray(v) ? v.map(String) : [];
      if (spec.items.options) {
        const box = h('div', 'bp-checks');
        getOptions(k + '[]').then((list) => {
          if (destroyed) return;
          const all = [...list, ...cur.filter((x) => !list.some((o) => String(o.value) === x)).map((x) => ({ value: x, label: x }))];
          for (const o of all) {
            const lab = h('label', 'bp-check');
            const c = h('input'); c.type = 'checkbox'; c.checked = cur.includes(String(o.value));
            c.onchange = () => save(k, c.checked ? [...cur, String(o.value)] : cur.filter((x) => x !== String(o.value)), () => { c.checked = !c.checked; });
            lab.append(c, h('span', '', o.label + (o.desc ? ' · ' + o.desc : '')));
            box.append(lab);
          }
          if (!all.length) box.append(h('div', 'bp-muted', en() ? 'No options yet' : '还没有可选项'));
        });
        return box;
      }
      const ta = h('textarea', 'bp-textarea');
      ta.placeholder = en() ? 'One per line' : '一行一项';
      ta.value = cur.join('\n');
      ta.onchange = () => save(k, ta.value.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean), () => { ta.value = cur.join('\n'); });
      return ta;
    }
    return h('span', 'bp-muted', en() ? 'Edit in the plugin details' : '在插件详情里改');
  }
  function draw() {
    if (destroyed || !data) return;
    el.textContent = '';
    const schema = data.schema || {};
    let keys = Array.isArray(opts.fields) ? opts.fields.filter((k) => schema[k]) : Object.keys(schema);
    if (Array.isArray(opts.exclude)) keys = keys.filter((k) => !opts.exclude.includes(k));
    if (Array.isArray(opts.sections)) keys = keys.filter((k) => opts.sections.includes(schema[k].section || ''));
    const groups = new Map();
    for (const k of keys) {
      const spec = schema[k];
      if (!visible(spec)) continue;
      const sec = spec.section || '';
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push(k);
    }
    for (const [sec, ks] of groups) {
      const section = h('div', 'bp-section');
      if (sec) section.append(h('div', 'bp-section-title', tx(ks[0], 'section', sec)));
      const group = h('div', 'bp-group');
      for (const k of ks) {
        const spec = schema[k];
        const row = h('div', 'bp-row bp-form-row');
        const stacked = !(spec.type === 'boolean');
        if (stacked) row.classList.add('bp-row-stack');
        const main = h('div', 'bp-row-main');
        main.append(h('div', 'bp-row-title', tx(k, 'label', spec.label || k)));
        if (spec.desc) main.append(h('div', 'bp-row-desc', tx(k, 'desc', spec.desc)));
        row.append(main, control(k, spec));
        group.append(row);
      }
      section.append(group);
      el.append(section);
    }
  }
  async function refresh() {
    try { data = await config.get(); optCache.clear(); draw(); }
    catch (e) { el.textContent = ''; el.append(h('div', 'bp-empty', e.message)); }
  }
  refresh();
  return { refresh, destroy() { destroyed = true; el.textContent = ''; } };
}

// ── 页面宿主能力 ─────────────────────────────────────
// kv / grants / chat 的增删查 / files 是普通接口：嵌入时经宿主代发，独立时带票直连。
// 要 bridge 主界面出面的（跳转、填输入框、授权框、选择器）：嵌入时是宿主调用，独立时经服务端中转给手机 App。
const PAGE_PERMS = ['page.chat', 'page.files'];
const HOST_CAPS = new Set(['nav', 'composer', 'grant', 'pick.file', 'pick.session']);
const enc = (v) => encodeURIComponent(String(v ?? ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 嵌入看宿主 init 给的 caps；独立时 kv / chat / files 恒真（带票直连，App 新旧都行），宿主类看有没有 hc=1。
// 不看有没有票据：没票据是页面没从 bridge 里打开，什么都用不了，请求会 401、页面显示过期提示，不是「这个环境不支持」
function can(name) {
  const n = String(name || '');
  if (embedded) return caps.has(n);
  if (n === 'kv' || n === 'chat' || n === 'files') return true;
  return hc && HOST_CAPS.has(n);
}

const unsupported = () => Object.assign(new Error(embedded
  ? L('这个操作要在新版 bridge 里才能用', 'This needs a newer version of bridge')
  : L('这个操作要在新版 bridge App 里才能用', 'This needs the latest bridge app')), { unsupported: true });
const busyError = () => Object.assign(new Error(L('上一个选择框或授权框还没关', 'Another picker or permission prompt is still open')), { status: 409, busy: true });

// 独立页面的中转：登记请求 → 让 App 切回主界面处理（bridge-host://）→ 要结果的（授权、选择器）长轮询等它。
// nav / composer：App 收到就把插件页关掉、主界面跳过去，没有结果可等。
const REQ_RE = /^[A-Za-z0-9_-]{16,64}$/;
const HOST_WAIT_TOTAL_MS = 10 * 60_000;
let pickBusy = false;   // 同一时间只挂一个要切回主界面表态的请求（同嵌入时宿主一次一个框）
async function relay(type, payload) {
  const kind = type === 'nav' || type === 'composer' ? 'nav' : 'pick';
  if (kind === 'pick') {
    if (pickBusy) throw busyError();
    pickBusy = true;
  }
  try {
    const r = await bjson('_bridge/host/request', { type, payload });
    const req = r && typeof r.req === 'string' ? r.req : '';
    if (!REQ_RE.test(req)) throw new Error(L('服务器没给中转请求号', 'The server didn’t return a relay request id'));
    location.href = 'bridge-host://open?req=' + enc(req) + '&kind=' + kind;
    if (kind === 'nav') return { ok: true };
    return await waitHost(req);
  } finally {
    if (kind === 'pick') pickBusy = false;
  }
}
async function waitHost(req) {
  const deadline = Date.now() + HOST_WAIT_TOTAL_MS;
  let delay = 1000;
  const backoff = async () => { await sleep(delay); delay = Math.min(10_000, delay * 2); };
  while (Date.now() < deadline) {
    let r;
    // 断网、切后台被掐的长轮询：等一会儿再问（结果在服务端存着，10 分钟内都取得到）
    try { r = await bfetch('_bridge/host/wait?req=' + enc(req)); } catch { await backoff(); continue; }
    if (!r.ok) {
      // 票据过期、请求过期或不是自己的：再问也没用
      if (fatalStatus(r.status)) throw await responseError(r);
      await backoff();
      continue;
    }
    delay = 1000;
    let j = null;
    try { j = await r.json(); } catch {}
    if (j && j.done) return j.result && typeof j.result === 'object' ? j.result : {};
  }
  throw new Error(L('等了 10 分钟也没等到 bridge 的结果', 'Gave up after waiting 10 minutes for bridge'));
}

async function hostOp(type, payload) {
  await readyP;
  if (embedded) {
    // 老宿主不认识的调用不会回话，别发出去干等
    if (!caps.has(type)) throw unsupported();
    return call(type, payload);
  }
  // 同 can()：只看 hc。没票据时中转请求会 401（显示过期提示），别报成「要新版 App」误导人
  if (!hc) throw unsupported();
  return relay(type, payload);
}

// 嵌入时宿主回 true / false；中转回 { ok }
const navDone = (r) => (embedded ? r === true : !!(r && r.ok !== false));
const navTo = async (p) => navDone(await hostOp('nav', p));
const nav = {
  session: (id) => navTo({ to: 'session', session: String(id ?? '') }),
  // 也收一个字符串（= rel，文件根下的相对路径）
  file: (f) => navTo(typeof f === 'string' ? { to: 'file', rel: f } : { to: 'file', rel: String(f?.rel ?? ''), ...(f?.ws ? { ws: String(f.ws) } : {}) }),
  app: (a) => navTo({ to: 'app', app: String(a ?? '') }),
  settings: () => navTo({ to: 'settings' }),
  home: () => navTo({ to: 'home' }),
};
const composer = {
  prefill: async (text) => navDone(await hostOp('composer', { text: String(text ?? '').slice(0, 20000) })),
};

const kv = {
  async get(key) {
    const j = await bjson('_bridge/kv?key=' + enc(key));
    return j && j.value !== undefined ? j.value : null;
  },
  // value 为 null（或 undefined）= 删除
  set: (key, value) => bjson('_bridge/kv', { key: String(key ?? ''), value: value === undefined ? null : value }),
  delete: (key) => kv.set(key, null),
  async list() {
    const j = await bjson('_bridge/kv');
    return Array.isArray(j && j.keys) ? j.keys : [];
  },
};

const grants = () => bjson('_bridge/grants');
// 同一权限同时只问一次：页面连点「开始对话」时并成一个框、一个结果
const grantAsks = new Map();
function requestGrant(perm) {
  const p = String(perm || '');
  if (!PAGE_PERMS.includes(p)) return Promise.resolve(false);
  if (grantAsks.has(p)) return grantAsks.get(p);
  const job = (async () => {
    // 先看一眼：已经授过就不打扰使用者（独立页面也省一次切回主界面）；清单没声明的，框弹了也是白弹
    let g = null;
    try { g = await grants(); } catch (e) { if (e && e.status === 401) throw e; }
    if (g && g.granted && g.granted[p]) return true;
    if (g && Array.isArray(g.declared) && !g.declared.some((d) => d && d.id === p)) {
      console.warn('[bridge-plugin] 清单的 permissions 里没声明 ' + p + '，没法请求授权');
      return false;
    }
    const r = await hostOp('grant', { perm: p });
    return embedded ? r === true : !!(r && r.granted);
  })();
  grantAsks.set(p, job);
  job.then(() => grantAsks.delete(p), () => grantAsks.delete(p));
  return job;
}
// 接口回 403 needGrant：先请求授权，同意了原样再试一次；不同意就抛
async function withGrant(perm, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!e || e.needGrant !== perm) throw e;
    if (!(await requestGrant(perm))) {
      throw errOf(perm === 'page.chat' ? L('没有得到和 Claude 对话的授权', 'Permission to chat with Claude wasn’t granted') : L('没有得到授权', 'Permission wasn’t granted'), { status: 403, needGrant: perm });
    }
    return fn();
  }
}

// ── 对话订阅 ──
// 一路订阅 = 一个 ChatSub：嵌入时由宿主用自己的登录态拉 SSE、按订阅号转发（chat.sub / chat.event / chat.end / chat.unsub），
// 独立时自己带票 fetch 流读。两种都在这里退避重连、去掉重连时补发的重复部分。
// 去重的依据：服务端连上时先补发正在跑的那一轮（turn，再按原顺序给缓冲里的事件，相邻正文合并成块但总字数不变）。
// 所以记下这一轮已经给过多少字正文、多少个其它事件，补发时跳过这么多，剩下的就是断线后的新内容。
// 补发的其它事件可能比页面收过的少（答完的 phone_confirm 提问服务端会从缓冲里删掉）：按签名往后找着跳，不光照数，见 skipOne。
// 认「补发的就是没收完的那一轮」：turn 带轮次号（turn 字段）时按号认；没有时只能凭问话认，可是断线期间那一轮结束了、
// 用户又发了一遍一模一样的话（连发两次「继续」），补发的就是新的一轮——所以跳的时候逐段核对内容（正文逐字、其它事件按签名），
// 对不上就是新的一轮：先给旧的那一轮补收尾，再把跳过的部分原样补给页面。两轮不同的回答几乎总在开头就分岔。
const CHAT_SUB_MAX = 4;
const REPLAY_WAIT_MS = 2000;
// 每一轮留作核对的：已给正文的前这么多字、其它事件的前这么多个签名（再往后的不核，照数跳）
const KEEP_TEXT = 8192;
const KEEP_SIGS = 256;
const chatSubs = new Set();
let subSeq = 0;
const turnIdOf = (ev) => (typeof ev.turn === 'number' && ev.turn > 0) || (typeof ev.turn === 'string' && ev.turn) ? String(ev.turn) : null;
const sigOf = (ev) => [ev.type, ev.id ?? ev.qid ?? '', ev.status ?? '', ev.kind ?? ''].join('|');
// kept 是这一轮已给正文的开头（最多 KEEP_TEXT 字），从 pos 起和 s 比；超出留存范围的部分不核
function sameText(kept, pos, s) {
  const end = Math.min(kept.length, pos + s.length);
  return end <= pos || kept.slice(pos, end) === s.slice(0, end - pos);
}
// 「别再试了」的状态码：请求不对、没授权、会话不是这个插件的、票据过期；408 / 425 / 429 是让过会儿再来
function fatalStatus(s) { return s >= 400 && s < 500 && s !== 408 && s !== 425 && s !== 429; }

class ChatSub {
  constructor(sid, fn) {
    this.sid = sid;
    this.fn = fn;
    this.closed = false;
    this.delay = 1000;
    this.openedAt = 0;
    this.turn = null;      // 当前这一轮：{ id, userText, chars, n, text（已给正文的开头）, sigs（已给其它事件的签名）, done, errored }
    this.skip = null;      // 正在跳过补发的部分：{ chars, n, pos, k（已核对到哪）, held（跳过的事件）, ev（补发的 turn）, sure（按轮次号认的）}
    this.expect = false;   // 刚重连、上一轮没收完：等服务端补发它
    this.expectT = 0;
    this.wake = null;
    this.sleepT = 0;
    this.ac = null;
    this.sub = '';
    // 宿主上一条订阅上过、后来流断了的订阅号（退避重连的空档里 sub 是空的）：宿主按它把这个会话的「正看着」留到重连上，
    // 空档里 close() 要拿它补一条 chat.unsub，不然宿主替一个已经不看了的会话多压最多 30 秒横幅（PluginFrame chatSub）
    this.gapSub = '';
    this.endWait = null;
  }
  give(ev) { try { this.fn(ev); } catch (e) { console.error(e); } }
  opened() {
    this.openedAt = Date.now();
    if (this.turn && !this.turn.done) {
      // 补发在连上的同一时刻就写出来了，到得很快；等不到 = 断线期间那一轮已经结束（结束的轮服务端不补）
      this.expect = true;
      clearTimeout(this.expectT);
      this.expectT = setTimeout(() => { if (this.expect) { this.expect = false; this.missed(); } }, REPLAY_WAIT_MS);
    }
  }
  missed() {
    const cur = this.turn;
    if (!cur || cur.done) return;
    cur.done = true;
    this.skip = null;
    // 那一轮已经报过错的，页面已经收过尾，不再补一个 done
    if (!cur.errored) this.give({ type: 'done', ok: null, missed: true });
  }
  // 两边都有轮次号就只认号；有一边没有（旧服务端）只能退回比问话，所以后面要边跳边核对
  sameTurn(cur, ev) {
    const id = turnIdOf(ev);
    if (cur.id && id) return cur.id === id;
    return String(ev.userText ?? '') === cur.userText;
  }
  handle(ev) {
    if (this.closed || !ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
    if (this.expect) {
      this.expect = false;
      clearTimeout(this.expectT);
      const cur = this.turn;
      if (ev.type === 'turn' && cur && !cur.done && this.sameTurn(cur, ev)) {
        // 补发的（看着）是没收完的那一轮：问话给过了，接着跳过已经给过的正文与事件。
        // 什么都还没给过就没有可核对的——问话一样、又没有轮次号时，两轮在页面看来本来就分不出
        this.skip = cur.chars || cur.n ? { chars: cur.chars, n: cur.n, pos: 0, k: 0, held: [], ev, sure: !!(cur.id && turnIdOf(ev)) } : null;
        return;
      }
      this.missed();
    }
    if (ev.type === 'turn') {
      if (this.skip) {
        // 补发的那一轮比页面已经收到的还短，下一轮就来了：凭问话认的说明认错了（是新的一轮），按新的一轮补给页面；
        // 按轮次号认的不会认错，只能当旧的那一轮没收完
        if (!this.skip.sure) { this.diverged(ev); return; }
        this.skip = null;
        this.missed();
      }
      this.turn = { id: turnIdOf(ev), userText: String(ev.userText ?? ''), chars: 0, n: 0, text: '', sigs: [], done: false, errored: false };
      this.give(ev);
      return;
    }
    let out = ev;
    if (this.skip) {
      out = this.skipOne(ev);
      if (!out) return;
    }
    this.record(out);
    this.give(out);
  }
  // 跳补发里已经给过的部分：回该给页面的那一条，null = 整条跳过（或已经转给 diverged 处理完了）。
  // 同一轮的补发是页面收到过的那串事件原样（正文合并成块、可能少了被删掉的提问）再往后接，所以凭问话认的逐段核对：
  // 正文逐字对、其它事件按签名对、正文与其它事件的先后也要对得上（正文跳完之前不该来其它事件，反之亦然）
  skipOne(ev) {
    const sk = this.skip;
    const cur = this.turn;
    let out = null;
    if (ev.type === 'text') {
      const s = String(ev.text ?? '');
      if (sk.sure) {
        if (sk.chars >= s.length) sk.chars -= s.length;
        else if (sk.chars > 0) { out = { ...ev, text: s.slice(sk.chars) }; sk.chars = 0; }
        else out = ev;
      } else {
        const take = Math.min(s.length, sk.chars);
        // 跨出已给部分的那一块后面不该还有没跳的其它事件（同一轮的话，已给部分的事件都在它前面）
        if (!sk.chars || (take < s.length && sk.n) || !sameText(cur.text, sk.pos, s.slice(0, take))) return this.diverged(ev);
        sk.pos += take;
        sk.chars -= take;
        if (take < s.length) out = { ...ev, text: s.slice(take) };
        else sk.held.push(ev);
      }
    } else if (sk.sure) {
      // 按轮次号认的不会认错轮，但补发可能比页面收过的少几条：答完的提问（phone_confirm）服务端会从缓冲里删掉，
      // 补发里就没有那条 approval 了，照数跳会把后面一条新事件（比如 done）也吞掉。所以留存范围内按签名往后找：
      // 找到了就跳到它后面（中间没出现的当被删了），找不到就是新事件——前面那些都被删了，不用再跳
      const end = sk.k + sk.n;
      const lim = Math.min(end, cur.sigs.length);
      if (sk.n > 0 && sk.k < lim) {
        const sig = sigOf(ev);
        let j = sk.k;
        while (j < lim && cur.sigs[j] !== sig) j += 1;
        if (j < lim) { sk.k = j + 1; sk.n = end - sk.k; }
        else if (lim < end) { sk.k = lim + 1; sk.n = end - sk.k; }   // 留存范围外的照数跳（256 个之后不核）
        else { sk.n = 0; out = ev; }
      } else if (sk.n > 0) { sk.k += 1; sk.n -= 1; }
      else out = ev;
    } else {
      if (!sk.n || (sk.k < cur.sigs.length && cur.sigs[sk.k] !== sigOf(ev))) return this.diverged(ev);
      sk.k += 1;
      sk.n -= 1;
      sk.held.push(ev);
    }
    if (!sk.chars && !sk.n) this.skip = null;
    return out;
  }
  // 核对不上 = 补发的是新的一轮：旧的那一轮补收尾，跳过的那些连同这一条按新的一轮原样给页面
  diverged(ev) {
    const sk = this.skip;
    this.skip = null;
    this.missed();
    for (const e of [sk.ev, ...sk.held, ev]) this.handle(e);
    return null;
  }
  // 记下这一轮给过什么：总数用来跳，开头的正文与签名用来核对
  record(out) {
    const cur = this.turn;
    if (!cur) return;
    if (out.type === 'text') {
      const s = String(out.text ?? '');
      if (cur.text.length < KEEP_TEXT) cur.text += s.slice(0, KEEP_TEXT - cur.text.length);
      cur.chars += s.length;
    } else {
      if (cur.sigs.length < KEEP_SIGS) cur.sigs.push(sigOf(out));
      cur.n += 1;
    }
    if (out.type === 'done') cur.done = true;
    else if (out.type === 'error') cur.errored = true;
  }
  // 订阅本身走不下去：告诉页面一声，然后停
  fail(e) {
    if (this.closed) return;
    this.give({
      type: 'error', kind: 'stream', message: String((e && e.message) || e || ''),
      ...(e && e.status ? { status: e.status } : {}), ...(e && e.needGrant ? { needGrant: e.needGrant } : {}),
    });
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    chatSubs.delete(this);
    watchDrop(this.sid);   // off() 与订阅失败都走这里：不再看着了（独立页报 visible: false）
    clearTimeout(this.expectT);
    this.wake?.();
    try { this.ac?.abort(); } catch {}
    if (this.sub) {
      hostSubs.delete(this.sub);
      post({ type: 'chat.unsub', sub: this.sub });
      this.sub = '';
    } else if (this.gapSub) {
      post({ type: 'chat.unsub', sub: this.gapSub });
    }
    this.gapSub = '';
    this.endWait?.('');
  }
  hostEnded(error) { const fn = this.endWait; this.endWait = null; fn?.(error || ''); }
  // 退避等待：close() 与重新联网时提前叫醒
  rest() {
    return new Promise((r) => {
      this.wake = () => { this.wake = null; clearTimeout(this.sleepT); r(); };
      this.sleepT = setTimeout(this.wake, this.delay);
    });
  }
  kick() { if (this.wake) { this.delay = 1000; this.wake(); } }
  async run() {
    await readyP;
    if (embedded && !caps.has('chat')) { this.fail(unsupported()); return; }
    if (!embedded && !ticket) { this.fail(errOf(L('没有插件票据：请从 bridge 里打开这个页面', 'No plugin ticket — open this page from bridge'), { status: 401 })); return; }
    while (!this.closed) {
      try {
        await (embedded ? this.viaHost() : this.direct());
      } catch (e) {
        if (this.closed) return;
        if (e && fatalStatus(e.status)) {
          if (e.status === 401 && !embedded) showExpired();
          this.fail(e);
          return;
        }
      }
      if (this.closed) return;
      // 连上过而且撑了一阵子（不是一连上就断）：退避从头算
      if (this.openedAt && Date.now() - this.openedAt > 10_000) this.delay = 1000;
      this.openedAt = 0;
      await this.rest();
      this.delay = Math.min(30_000, this.delay * 2);
    }
  }
  async direct() {
    const ac = new AbortController();
    this.ac = ac;
    const res = await fetch(SERVER + '/api/plugin/' + pluginId + '/_bridge/chat/events?session=' + enc(this.sid), {
      headers: { Authorization: 'Plugin ' + ticket, Accept: 'text/event-stream' }, credentials: 'omit', cache: 'no-store', signal: ac.signal,
    });
    if (!res.ok || !res.body) throw await responseError(res);
    this.opened();
    await readSse(res.body, (ev) => this.handle(ev));
  }
  async viaHost() {
    const sub = 'c' + (++subSeq);
    this.sub = sub;
    hostSubs.set(sub, this);
    const ended = new Promise((r) => { this.endWait = r; });
    let up = false;
    try {
      // 宿主在拿到 2xx 响应时才回话（失败回错误 + 状态码，不会再有 chat.end）；之后的事件按订阅号推来
      await call('chat.sub', { sub, session: this.sid });
      if (this.closed) return;
      // 又订阅上了：宿主已经撤了上一回断线留着的登记
      up = true;
      this.gapSub = '';
      this.opened();
      await ended;   // 宿主那头的流断了（网络、服务端 30 分钟没有新轮收掉）：回到外面退避重连
    } finally {
      hostSubs.delete(sub);
      if (this.sub === sub) this.sub = '';
      // 订阅上过、流自己断了（不是 close 收掉的）：宿主按这个号留着登记，记下来好在空档里 close 时告诉它
      if (up && !this.closed) this.gapSub = sub;
      this.endWait = null;
    }
  }
}
addEventListener('online', () => { for (const s of chatSubs) s.kick(); });

// ── 独立页「正看着这个会话」报到 ──
// 手机 App 的插件页里看着一个会话时，那一轮结束不该再弹系统通知（人就在看）：订阅着、页面在前台时
// POST _bridge/chat/watch { sessionId, visible: true }，每 30 秒续一次（服务端 75 秒到期，漏一两次也不会误放通知）；
// 切到后台、off()、订阅结束时报 visible: false，服务端当场删掉，之后的结束照常通知。
// 嵌入模式不报：宿主（PluginFrame）自己替看着的会话压横幅。报到失败不管——最坏多弹一条通知，不影响订阅
const WATCH_MS = 30_000;
const watching = new Map();   // 会话 id → 订阅着它的路数（同一会话订两路也只报一份）
let watchT = 0;
let watchShown = false;       // 上一次报的是 visible: true（切后台 / 全撤时才有 false 可报）
const watchable = () => !embedded && !!ticket && document.visibilityState === 'visible';
function reportWatch(sid, visible) {
  try {
    // keepalive：切后台 / 关页时报的 false 也要送得出去
    fetch(SERVER + '/api/plugin/' + pluginId + '/_bridge/chat/watch', {
      method: 'POST', headers: { Authorization: 'Plugin ' + ticket, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, visible }), credentials: 'omit', keepalive: true,
    }).catch(() => {});
  } catch {}
}
function watchSync() {
  clearInterval(watchT);
  watchT = 0;
  if (watching.size && watchable()) {
    watchShown = true;
    for (const sid of watching.keys()) reportWatch(sid, true);
    watchT = setInterval(() => {
      if (!watchable()) { watchSync(); return; }
      for (const sid of watching.keys()) reportWatch(sid, true);
    }, WATCH_MS);
  } else if (watchShown) {
    watchShown = false;
    for (const sid of watching.keys()) reportWatch(sid, false);
  }
}
function watchAdd(sid) {
  if (embedded || !ticket) return;
  const n = watching.get(sid) || 0;
  watching.set(sid, n + 1);
  if (n || !watchable()) return;
  // 续报的定时器已经在跑：只给新会话报一次；还没跑就整个起一遍（顺带报到）
  if (watchT) reportWatch(sid, true); else watchSync();
}
function watchDrop(sid) {
  const n = watching.get(sid) || 0;
  if (!n) return;
  if (n > 1) { watching.set(sid, n - 1); return; }
  watching.delete(sid);
  if (watchShown) reportWatch(sid, false);
  if (!watching.size) { clearInterval(watchT); watchT = 0; watchShown = false; }
}
if (!embedded) {
  document.addEventListener('visibilitychange', watchSync);
  // 整页离开（跳页、关掉）：报 false；进往返缓存的回来时 pageshow 再报到
  addEventListener('pagehide', () => { if (watchShown) { watchShown = false; clearInterval(watchT); watchT = 0; for (const sid of watching.keys()) reportWatch(sid, false); } });
  addEventListener('pageshow', (e) => { if (e && e.persisted) watchSync(); });
}

function chatOn(sessionId, fn) {
  const sid = String(sessionId ?? '');
  if (typeof fn !== 'function') throw new TypeError(L('chat.on 要一个回调函数', 'chat.on needs a callback'));
  if (!sid) throw new Error(L('chat.on 要会话 id', 'chat.on needs a session id'));
  if (chatSubs.size >= CHAT_SUB_MAX) {
    throw new Error(L('一个页面最多同时订阅 ' + CHAT_SUB_MAX + ' 个对话，先 off() 掉不用的', 'A page can follow at most ' + CHAT_SUB_MAX + ' chats at once — off() the ones you no longer need'));
  }
  const s = new ChatSub(sid, fn);
  chatSubs.add(s);
  watchAdd(sid);
  s.run();
  return () => s.close();
}

const chat = {
  async start({ prompt, model, effort } = {}) {
    await readyP;
    const body = { prompt: String(prompt ?? '') };
    if (model) body.model = String(model);
    if (effort) body.effort = String(effort);
    // 嵌入时服务端按请求体认是哪个应用开的会话（独立页面以票据为准，带了也不看）
    if (embedded && app) body.app = app.id;
    return withGrant('page.chat', async () => {
      const j = await bjson('_bridge/chat/start', body);
      return { sessionId: String((j && j.sessionId) || '') };
    });
  },
  send: (sessionId, text) => withGrant('page.chat', () => bjson('_bridge/chat/send', { sessionId: String(sessionId ?? ''), text: String(text ?? '') })),
  stop: (sessionId) => bjson('_bridge/chat/stop', { sessionId: String(sessionId ?? '') }),
  on: chatOn,
  // { app }：只要某个应用开的；不给 = 本插件开的全部（新的在前）
  async sessions({ app: a = '' } = {}) {
    const j = await bjson('_bridge/chat/sessions' + (a ? '?app=' + enc(a) : ''));
    return Array.isArray(j) ? j : Array.isArray(j && j.sessions) ? j.sessions : [];
  },
  history: (sessionId) => bjson('_bridge/chat/history?session=' + enc(sessionId)),
};

// 句柄只留这几个字段；mode 不认识的按只读算
const cleanFiles = (list) => (Array.isArray(list) ? list : [])
  .filter((f) => f && typeof f.handle === 'string' && f.handle)
  .map((f) => ({ handle: f.handle, name: String(f.name || ''), size: Number(f.size) || 0, mime: String(f.mime || ''), mode: f.mode === 'rw' ? 'rw' : 'r' }));
const pick = {
  // 没授权时宿主 / 主界面先弹授权框；不同意、取消选择都回 null
  async file({ multiple = false, accept = '' } = {}) {
    const r = await hostOp('pick.file', { multiple: !!multiple, accept: String(accept ?? '').slice(0, 200) });
    let list = r;
    if (!embedded) {
      // 中转：{ files } 或 { cancelled, error? }（签不出句柄时主界面那头已经提示过，这里按取消收场）
      if (!r || r.cancelled) { if (r && r.error) console.warn('[bridge-plugin] pick.file: ' + r.error); return null; }
      list = r.files;
    }
    const out = cleanFiles(list);
    return out.length ? out : null;
  },
  async session() {
    const r = await hostOp('pick.session', {});
    if (!r || r.cancelled || typeof r.sessionId !== 'string' || !r.sessionId) return null;
    return { sessionId: r.sessionId, title: String(r.title || '') };
  },
};

const files = {
  async read(handle, { as = 'text' } = {}) {
    const r = await bfetch('_bridge/files/read?h=' + enc(handle));
    if (!r.ok) throw await responseError(r);
    if (as === 'json') return r.json();
    if (as === 'blob') return r.blob();
    if (as === 'arrayBuffer') return r.arrayBuffer();
    return r.text();
  },
  // data：字符串（按 UTF-8 存）、Blob、ArrayBuffer / TypedArray；别的对象存成 JSON 文本
  async write(handle, data) {
    let body = data;
    if (data == null) body = '';
    else if (typeof data !== 'string' && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) body = JSON.stringify(data);
    const r = await bfetch('_bridge/files/write?h=' + enc(handle), { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) throw await responseError(r);
    let j = null;
    try { j = await r.json(); } catch {}
    return j;
  },
  stat: (handle) => bjson('_bridge/files/stat?h=' + enc(handle)),
};

export const bridge = {
  get info() { return info; },
  config,
  options,
  actions,
  action: runAct,
  status,
  form,
  get embedded() { return embedded; },
  pluginId,
  context: () => ctxView(),
  app: () => (app ? { ...app } : null),
  ready: () => readyP,
  fetch: bfetch,
  json: bjson,
  can,
  nav,
  composer,
  kv,
  grants,
  requestGrant,
  chat,
  pick,
  files,
  on(event, fn) {
    const k = String(event);
    if (!listeners.has(k)) listeners.set(k, new Set());
    listeners.get(k).add(fn);
    if (k !== 'context' && k !== '_theme') openStream();   // 这两种是宿主给的，不用开事件流
    return () => listeners.get(k)?.delete(fn);
  },
  onTheme(fn) { return bridge.on('_theme', fn); },
  onStatus(fn) { return bridge.on('_status', fn); },
  toast(text, { error = false } = {}) { if (embedded) post({ type: 'toast', text: String(text), error: !!error }); else localToast(text, error); },
  async confirm({ title = '', desc = '', yes = '', danger = false } = {}) {
    if (embedded) return !!(await call('confirm', { title, desc, yes, danger }));
    return window.confirm([title, desc].filter(Boolean).join('\n\n'));
  },
  async blobUrl(path) { const r = await bfetch(path); if (!r.ok) throw new Error('HTTP ' + r.status); return URL.createObjectURL(await r.blob()); },
  openExternal(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) throw new Error('只能打开 http(s) 地址');
    if (embedded) post({ type: 'open', url: u }); else window.open(u, '_blank', 'noopener');
  },
  // 手机 App（hc=1）：插件页是原生另起的一页，交给 App 关掉（转场与回到主界面由它管）
  back() {
    if (embedded) post({ type: 'back' });
    else if (hc) location.href = 'bridge-host://close';
    else if (history.length > 1) history.back();
    else window.close();
  },
  // 用脚本跳到本插件别的页面：bridge.go('detail.html?id=3')。把 bridge 给的 #（嵌入时的口令、独立时的票据）接上，
  // 新页面照样连得上；直接 location.href = 'x.html' 会把 # 丢掉，嵌入时新页面宿主不再理它、独立时没了票据。
  // 只认本插件自己的页面（别的地址抛错，# 不能带出去）；page 自己带的 # 片段不保留（位置让给 bridge 的 #）
  go(page) {
    const u = ownPage(page);
    if (!u) throw new Error(L('只能跳到本插件自己的页面：', 'bridge.go() only opens pages of this plugin: ') + String(page ?? ''));
    location.assign(u.href.split('#')[0] + location.hash);
  },
};

export default bridge;
