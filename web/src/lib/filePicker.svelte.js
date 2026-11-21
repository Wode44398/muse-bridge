// 插件页面的文件选择器：数据层 + 对外入口，界面是 components/pickers/FilePickerSheet.svelte。
//
//   pickFiles({ multiple = false, accept = '', title = '', signal? } = {}) → Promise<[{ rel, ws, name, size }] | null>
//
// signal（可选 AbortSignal，向后兼容的扩展）：调用方不要结果了（PluginFrame 卸载、页面换代）就 abort，
// 按取消收掉——正在显示的关掉，排着的直接出队，Promise 回 null。孤儿选择器留在屏幕上，用户选完结果没人收。
//
// 浏览的是「这个身份的文件根」（同文件分页不带 ws 时的根，rel 相对它、ws 恒为 ''），页面拿不到路径——
// 调用方（PluginFrame / 手机中转）拿这里的结果去 POST /api/plugins/handles 换句柄，只把句柄和文件名交给页面。
// 取消（✕、Esc、系统返回、点遮罩、下滑）回 null。
//
// 一次只开一个：再次调用排在后面，前一个结束后接着弹（不同 iframe 各自发起时互不打断）。
// 和会话选择器排在同一条道上（lib/pickerLane.svelte.js），两个选择器也不会同时挂出来。
// 组件没能加载时回 null 并提示，页面那头按「取消」处理。
import { t } from './i18n.js';
import { showToast } from './toast.svelte.js';
import { selfMounter, clipText, onAbort } from './selfMount.js';
import { laneJoin, laneLeave, laneHead, aboveOpen } from './pickerLane.svelte.js';

/** 一次最多选几个：与 POST /api/plugins/handles 每次 20 项的上限一致。 */
export const FILE_PICK_MAX = 20;
const QUEUE_MAX = 6;

export const filePickState = $state({ queue: [] });   // [{ id, multiple, accept, title }]
export const filePickHost = { ready: false, owner: null };

let seq = 0;
const waiters = new Map();   // id → { resolve, off }（off 摘掉 abort 监听）
const laneKey = (id) => 'file:' + id;

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/** 当前该显示的那个请求（道上轮到会话选择器时为 null）。 */
export function activeFilePick() {
  const r = filePickState.queue[0];
  return r && laneHead() === laneKey(r.id) ? r : null;
}

export function pickFiles({ multiple = false, accept = '', title = '', signal } = {}) {
  if (!hasDom() || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (filePickState.queue.length >= QUEUE_MAX) { resolve(null); return; }
    const req = {
      id: ++seq,
      multiple: !!multiple,
      accept: String(accept ?? '').slice(0, 200),
      title: clipText(title, 60),
    };
    laneJoin(laneKey(req.id));
    filePickState.queue.push(req);
    waiters.set(req.id, { resolve, off: onAbort(signal, () => settleFilePick(req.id, null)) });
    kick();
  });
}

/** 结算当前请求：items 为数组（已选文件）或 null（取消）。 */
export function settleFilePick(id, items) {
  const i = filePickState.queue.findIndex((r) => r.id === id);
  if (i < 0) return false;
  filePickState.queue.splice(i, 1);
  const w = waiters.get(id);
  waiters.delete(id);
  w?.off?.();
  let out = null;
  if (Array.isArray(items)) {
    out = items.slice(0, FILE_PICK_MAX).map((it) => ({
      rel: String(it.rel || ''), ws: '', name: String(it.name || ''), size: Number(it.size) || 0,
    })).filter((it) => it.rel);
    if (!out.length) out = null;
  }
  laneLeave(laneKey(id));   // 道上排完了才把焦点还给打开前的地方
  try { w?.resolve(out); } catch {}
  return true;
}

// —— 宿主挂载 ——
const ensure = selfMounter(() => import('../components/pickers/FilePickerSheet.svelte'));
function failAll() {
  const ids = filePickState.queue.map((r) => r.id);
  for (const id of ids) settleFilePick(id, null);
  if (ids.length) showToast(t('文件选择器没能打开，请刷新页面后再试'), 'err');
}
function kick() {
  if (filePickHost.ready) return;
  ensure().then(() => { if (!filePickHost.ready) failAll(); }).catch((e) => {
    try { console.warn('[pickFiles] 选择器没能加载：', e?.message || e); } catch {}   // i18n-ignore 只进控制台
    failAll();
  });
}

// —— 键盘：Esc = 取消（授权框 / 应用内弹窗开着时这一下归它们：它们的监听不一定先注册，这里自己让）——
function onKeyDown(e) {
  if (e.key !== 'Escape' || e.repeat || e.isComposing) return;
  const r = filePickHost.ready ? activeFilePick() : null;
  if (!r || aboveOpen()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  settleFilePick(r.id, null);
}
if (hasDom()) {
  const prev = window.__bridgeFilePickKeys;
  if (prev) window.removeEventListener('keydown', prev, true);
  window.__bridgeFilePickKeys = onKeyDown;
  window.addEventListener('keydown', onKeyDown, true);
}
