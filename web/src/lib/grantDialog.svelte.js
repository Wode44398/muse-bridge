// 插件页面权限的授权框：数据层 + 对外入口，界面是 components/apps/GrantDialog.svelte。
//
//   askGrant({ plugin, pluginName, appTitle, perm, signal? }) → Promise<boolean>
//
// signal（可选 AbortSignal，向后兼容的扩展）：调用方不要结果了（PluginFrame 卸载、页面刷新 / 页内跳页换代）
// 就 abort——这一份按「不允许」回、不存授权；合并进同一个框的调用都撤了，框也收掉。不然孤儿框留在屏幕上，
// 用户在里面答完结果没人收，PluginFrame 那头「同时只挂一个」的闩也要等它关掉才复位，新页面的请求全被 409。
//
// 为什么 bridge 自己画、不让页面画：授权是「这个插件以后能不能以你的身份和 Claude 对话 / 读写你选中的文件」，
// 框要是页面画的，插件就能画一个假框骗点。所以框在主界面这一层（z 3600，盖过 iframe 与选择器；和应用内弹窗错开显示，见下），
// 文案里的应用名 / 插件名截断后再显示，框出现后一段时间内的按下——指针和按键都算——一律不算
// （防插件掐着时机诱导用户点中「允许」，或趁用户连着敲键时弹框、让 Tab / 方向键 + 回车 / 空格替他同意）。
//
// 结果口径：点「允许」→ POST /api/plugins/grants { plugin, perm, allow: true }，存成功才回 true；
// 存失败时框不关、在框里显示原因，用户可以再点「允许」重试或点「不允许」。「不允许」、Esc、系统返回 → false。
// 点框外不关（授权要明确表态）。组件没能加载时回 false，绝不退回系统弹窗（系统框没有防误触，也看不出是 bridge 画的）。
//
// 同一插件的同一权限已经有框挂着时，后来的调用并进同一个结果（页面连点「开始对话」不会叠一串框）。
//
// 和应用内弹窗（uiAlert / uiConfirm，含插件页面的 bridge.confirm，画在 DialogHost）不同时显示：两边各有一个
// window 捕获阶段的键盘监听和一个 focusin 焦点陷阱，同时开着时按键归谁看模块求值的先后——回车 / Esc 可能被
// 压在底下、看不见的那个弹窗拿去（替用户点了插件 confirm 的「确定」），两个陷阱还会在 focusin 里同步嵌套着
// 互相拉焦点直到栈溢出。所以应用内弹窗有一条在显示时，授权框先让开：排着的照排，已经显示的暂时收起，
// 等它答完再出来，默认焦点与防误触时间窗都重新起算。不反过来让应用内弹窗等授权框：那要改 dialogs.js /
// DialogHost（全站十几处在用的通用弹窗），让授权框等一步代价小得多。
import { api } from './api.js';
import { t, tc, tr } from './i18n.js';
import { showToast } from './toast.svelte.js';
import { selfMounter, clipText, onAbort } from './selfMount.js';
import { activeRequest } from './dialogState.svelte.js';

/** 页面权限：只有这两种走授权框；别的串一律回 false。 */
export const PAGE_PERMS = ['page.chat', 'page.files'];
const PLUGIN_RE = /^[a-z][a-z0-9-]{0,47}$/;
// 同时挂着的授权请求上限：正常一次一个；页面循环乱请求时，超出的直接按「不允许」回
export const GRANT_QUEUE_MAX = 8;
// 退场动画时长（与 DialogHost 一致）
export const GRANT_EXIT_MS = 220;
// 出现后的防误触时间窗：比 DialogHost 的 350 再长一点——插件能掐时机（先让用户在那个位置连点，再请求授权），
// 500ms 足够盖住连点的间隔，又远短于人读完一句话的时间
export const GRANT_GUARD_MS = 500;
export const APP_TITLE_MAX = 40;
export const PLUGIN_NAME_MAX = 60;

// queue 里有正在显示的、正在退场的（closing）和排队的；GrantDialog 渲染第一个没在退场的
export const grantState = $state({ queue: [] });
// 宿主登记（非响应式）：ready = 有一个 GrantDialog 已挂载认领；owner 防止挂了两份叠两层
export const grantHost = { ready: false, owner: null };
// 键盘处理由组件注入（它知道焦点在哪个按钮上、防误触时间窗从哪起算）；本模块的全局捕获监听只负责转交。
// keyUp 回 true = 这一下松开是组件吞掉的（时间窗里按下的键），本模块据此也不让它漏到底下
export const grantHooks = { key: null, keyUp: null };

let seq = 0;
const waiters = new Map();   // id → [{ resolve, off }, …]（合并进同一条的多次调用各有一个；off 摘掉 abort 监听）
let restoreTo = null;        // 框打开前的焦点，全部结束后还回去

/**
 * 权限说明（接在「「应用」想要」后面）。中文与服务端 discover.mjs 的 PERMISSIONS 逐字一致——
 * 授权框里说的和 设置 › 扩展 › 插件详情（撤销的地方）列的得是同一句话。
 * page.chat 用带语境的键：那句的英文在服务端字典里是列表用的句首大写，接在 “wants to” 后面要小写开头。
 */
export function permText(perm) {
  if (perm === 'page.chat') return tc('grant', '在应用页面里以你的身份和 Claude 对话');
  if (perm === 'page.files') return tc('grant', '读写你在选择器里选中的文件');
  return '';
}

/** 应用内弹窗（DialogHost）有一条正在显示（退场中的不算）。 */
const dialogBusy = () => !!activeRequest();

/** 第一条没在退场的，不管它是不是正被应用内弹窗挡着。 */
function liveGrant() {
  for (const r of grantState.queue) if (!r.closing) return r;
  return null;
}

/** 当前该显示的那条：应用内弹窗开着时让它先答完（见文件头），这段时间里没有授权框在显示。 */
export function activeGrant() {
  const r = liveGrant();
  return r && !dialogBusy() ? r : null;
}

/** 有没有授权框开着（选择器据此让出键盘与焦点）。 */
export function grantOpen() {
  return !!activeGrant();
}

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';
const findReq = (id) => grantState.queue.find((r) => r.id === id) || null;

function activeEl() {
  try { return hasDom() ? document.activeElement : null; } catch { return null; }
}
const inGrant = (el) => !!(el && typeof el.closest === 'function' && el.closest('[data-grant-host]'));
// 应用内弹窗的按钮：授权框要等它答完才出来，到那时这颗按钮已经拆掉，记它没用（焦点交给组件在出现时记下的那个）
const inDialog = (el) => !!(el && typeof el.closest === 'function' && el.closest('[data-dialog-host]'));

function restoreFocus() {
  const el = restoreTo;
  restoreTo = null;
  if (!el || typeof el.focus !== 'function' || el.isConnected === false) return;
  const now = activeEl();
  if (now && now !== document.body && now !== document.documentElement && !inGrant(now)) return;
  try { el.focus({ preventScroll: true }); } catch {}
}

function reducedMotion() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** 记一份等结果的调用；带 signal 的，abort 时只撤这一份（见 dropWaiter）。 */
function addWaiter(id, resolve, signal) {
  const list = waiters.get(id);
  if (!list) { resolve(false); return; }
  const w = { resolve, off: null };
  list.push(w);
  w.off = onAbort(signal, () => dropWaiter(id, w));
}

/**
 * 某个调用方 abort 了：它那份按「不允许」回（不存授权）。名下还有别人在等（同一插件同一权限合并进来的）就留着框；
 * 一个都不剩了就把框收掉——结算口径同「不允许」，正在保存的那次存上了也会被 allowGrant 撤回去。
 */
function dropWaiter(id, w) {
  const list = waiters.get(id);
  const i = list ? list.indexOf(w) : -1;
  if (i < 0) return;
  list.splice(i, 1);
  w.off?.();
  if (!list.length) settle(id, false);
  try { w.resolve(false); } catch {}
}

export function askGrant({ plugin, pluginName, appTitle, perm, signal } = {}) {
  if (!hasDom()) return Promise.resolve(false);
  const pid = String(plugin ?? '');
  if (!PLUGIN_RE.test(pid) || !PAGE_PERMS.includes(perm)) return Promise.resolve(false);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    // 同一插件同一权限已经挂着：并进去，一起拿结果
    const same = grantState.queue.find((r) => !r.closing && r.plugin === pid && r.perm === perm);
    if (same) { addWaiter(same.id, resolve, signal); return; }
    let live = 0;
    for (const r of grantState.queue) if (!r.closing) live += 1;
    if (live >= GRANT_QUEUE_MAX) { resolve(false); return; }
    const name = clipText(pluginName, PLUGIN_NAME_MAX) || pid;
    const req = {
      id: ++seq,
      plugin: pid,
      perm,
      pluginName: name,
      // 应用名缺省时用插件名（独立页面的旧票据可能没带标题）
      appTitle: clipText(appTitle, APP_TITLE_MAX) || clipText(name, APP_TITLE_MAX),
      busy: false,
      error: '',
      closing: false,
    };
    if (!live) { const el = activeEl(); if (!inGrant(el) && !inDialog(el)) restoreTo = el; }
    grantState.queue.push(req);
    waiters.set(req.id, []);
    addWaiter(req.id, resolve, signal);
    kick();
  });
}

/** 结算一条：标记退场、resolve 名下所有调用，动画播完出队。重复结算返回 false。 */
function settle(id, value, { instant = false } = {}) {
  const req = findReq(id);
  if (!req || req.closing) return false;
  req.closing = true;
  const list = waiters.get(id) || [];
  waiters.delete(id);
  if (!liveGrant()) restoreFocus();
  const drop = () => {
    const i = grantState.queue.findIndex((r) => r.id === id);
    if (i >= 0) grantState.queue.splice(i, 1);
  };
  if (instant || reducedMotion()) drop(); else setTimeout(drop, GRANT_EXIT_MS);
  for (const w of list) { w.off?.(); try { w.resolve(!!value); } catch {} }
  return true;
}

/** 「不允许」/ Esc / 系统返回。 */
export function denyGrant(id) {
  return settle(id, false);
}

function errText(e) {
  const raw = e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '';
  const msg = tr(String(raw || '')).slice(0, 200);
  if (msg) return msg;
  if (e?.status) return t('服务器返回 {code}', { code: e.status });
  return t('网络连接失败');
}

/** 「允许」：先存授权，存成功才结算为 true；失败把原因写在框里，框不关。 */
export async function allowGrant(id) {
  const req = findReq(id);
  if (!req || req.closing || req.busy) return;
  req.busy = true;
  req.error = '';
  const { plugin, perm } = req;
  let ok = false, error = '';
  try {
    const r = await api.post('/api/plugins/grants', { plugin, perm, allow: true });
    if (r && typeof r === 'object' && r.ok === false) throw Object.assign(new Error('grant refused'), { body: r });
    // 回包里带了授权表就核一下：表里真有这项才算存上（形状是 { [perm]: iso }，也容许数组）
    const g = r && typeof r === 'object' ? r.granted : null;
    if (Array.isArray(g) ? !g.includes(perm) : g && typeof g === 'object' ? !g[perm] : false) throw new Error('not granted');
    ok = true;
  } catch (e) {
    error = t('没能保存授权：{msg}', { msg: errText(e) });
  }
  const cur = findReq(id);
  if (!cur || cur.closing) {
    // 保存途中用户已经点了「不允许」（或框被收掉）：页面拿到的是 false，那这次存上的授权也撤回去，两边说法一致
    if (ok) api.post('/api/plugins/grants', { plugin, perm, allow: false }).catch(() => {});
    return;
  }
  if (ok) { settle(id, true); return; }
  cur.busy = false;
  cur.error = error;
}

// —— 宿主挂载 ——
const ensure = selfMounter(() => import('../components/apps/GrantDialog.svelte'));
function failAll() {
  let any = false;
  for (const r of [...grantState.queue]) if (!r.closing) { settle(r.id, false, { instant: true }); any = true; }
  if (any) showToast(t('授权框没能打开，请刷新页面后再试'), 'err');
}
function kick() {
  if (grantHost.ready) return;
  ensure().then(() => { if (!grantHost.ready) failAll(); }).catch((e) => {
    try { console.warn('[grant] 授权框没能加载：', e?.message || e); } catch {}   // i18n-ignore 只进控制台
    failAll();
  });
}

// —— 键盘：模块求值时在 window 捕获阶段注册（同 dialogs.js 的理由：抢在底下面板的 Esc 监听前面）——
// 授权框开着时所有按键都不给底下（选择器、应用页、全局快捷键），按住不放的 Enter / Esc 自动重复也不漏下去。
let held = null;
function onKeyDown(e) {
  if (held) {
    if (e.key === held && e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    held = null;
  }
  const before = grantHost.ready ? activeGrant() : null;
  if (!before) return;
  e.stopImmediatePropagation();
  try { grantHooks.key?.(e); } catch (err) { try { console.warn('[grant] 按键处理出错', err); } catch {} }   // i18n-ignore 只进控制台
  if ((e.key === 'Enter' || e.key === 'Escape') && activeGrant() !== before) held = e.key;
}
function onKeyUp(e) {
  if (held && e.key === held) { held = null; e.stopImmediatePropagation(); return; }
  if (!grantHost.ready) return;
  // 先给组件：防误触时间窗里按下、被吞掉的键，松开这一下也要 preventDefault——空格的原生 click 发在松开时。
  // 框已经答完也照样问：那一下按键本来就不算数，不能在松开时替底下的按钮点一下
  let swallowed = false;
  try { swallowed = !!grantHooks.keyUp?.(e); } catch (err) { try { console.warn('[grant] 按键处理出错', err); } catch {} }   // i18n-ignore 只进控制台
  if (swallowed || activeGrant()) e.stopImmediatePropagation();
}

if (hasDom()) {
  // 开发热更新会重新求值本模块：先摘掉上一份监听
  const prev = window.__bridgeGrantKeys;
  if (prev) {
    window.removeEventListener('keydown', prev.down, true);
    window.removeEventListener('keyup', prev.up, true);
  }
  window.__bridgeGrantKeys = { down: onKeyDown, up: onKeyUp };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
}
