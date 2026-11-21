// 插件页面的会话选择器：数据层 + 对外入口，界面是 components/pickers/SessionPickerSheet.svelte。
//
//   pickSession({ title = '', signal? } = {}) → Promise<{ sessionId, title } | null>
//
// signal（可选 AbortSignal，向后兼容的扩展）：abort 时按取消收掉（显示中的关掉、排着的出队），回 null。
// 口径同 filePicker.svelte.js：PluginFrame 卸载 / 页面换代时用，别留孤儿选择器。
//
// 列的是使用者自己的 Claude 会话（同文件分页「发送给 AI › 选择对话」那份列表：本地缓存先出、网络刷新殿后，
// 复用 lib/files-business.js 的 loadAiSessions / filterAiSessions），带搜索。取消回 null。
// 一次只开一个，后来的调用排队；和文件选择器排在同一条道上（lib/pickerLane.svelte.js），两个不会同时挂出来。
// 组件没能加载时回 null 并提示。
import { t } from './i18n.js';
import { showToast } from './toast.svelte.js';
import { selfMounter, clipText, onAbort } from './selfMount.js';
import { laneJoin, laneLeave, laneHead, aboveOpen } from './pickerLane.svelte.js';

const QUEUE_MAX = 6;

export const sessionPickState = $state({ queue: [] });   // [{ id, title }]
export const sessionPickHost = { ready: false, owner: null };

let seq = 0;
const waiters = new Map();   // id → { resolve, off }（off 摘掉 abort 监听）
const laneKey = (id) => 'session:' + id;

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/** 当前该显示的那个请求（道上轮到文件选择器时为 null）。 */
export function activeSessionPick() {
  const r = sessionPickState.queue[0];
  return r && laneHead() === laneKey(r.id) ? r : null;
}

export function pickSession({ title = '', signal } = {}) {
  if (!hasDom() || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (sessionPickState.queue.length >= QUEUE_MAX) { resolve(null); return; }
    const req = { id: ++seq, title: clipText(title, 60) };
    laneJoin(laneKey(req.id));
    sessionPickState.queue.push(req);
    waiters.set(req.id, { resolve, off: onAbort(signal, () => settleSessionPick(req.id, null)) });
    kick();
  });
}

/** 结算：value 为 { sessionId, title } 或 null（取消）。 */
export function settleSessionPick(id, value) {
  const i = sessionPickState.queue.findIndex((r) => r.id === id);
  if (i < 0) return false;
  sessionPickState.queue.splice(i, 1);
  const w = waiters.get(id);
  waiters.delete(id);
  w?.off?.();
  const sid = value && typeof value === 'object' ? String(value.sessionId || '') : '';
  const out = sid ? { sessionId: sid, title: String(value.title || '') } : null;
  laneLeave(laneKey(id));   // 道上排完了才把焦点还给打开前的地方
  try { w?.resolve(out); } catch {}
  return true;
}

const ensure = selfMounter(() => import('../components/pickers/SessionPickerSheet.svelte'));
function failAll() {
  const ids = sessionPickState.queue.map((r) => r.id);
  for (const id of ids) settleSessionPick(id, null);
  if (ids.length) showToast(t('会话选择器没能打开，请刷新页面后再试'), 'err');
}
function kick() {
  if (sessionPickHost.ready) return;
  ensure().then(() => { if (!sessionPickHost.ready) failAll(); }).catch((e) => {
    try { console.warn('[pickSession] 选择器没能加载：', e?.message || e); } catch {}   // i18n-ignore 只进控制台
    failAll();
  });
}

// Esc = 取消（授权框 / 应用内弹窗开着时这一下归它们）
function onKeyDown(e) {
  if (e.key !== 'Escape' || e.repeat || e.isComposing) return;
  const r = sessionPickHost.ready ? activeSessionPick() : null;
  if (!r || aboveOpen()) return;
  // 搜索框里有字：这一下 Esc 先清空搜索（type=search 的原生行为），再按一次才关
  if (e.target instanceof HTMLInputElement && e.target.value && e.target.closest?.('[data-picker-host]')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  settleSessionPick(r.id, null);
}
if (hasDom()) {
  const prev = window.__bridgeSessionPickKeys;
  if (prev) window.removeEventListener('keydown', prev, true);
  window.__bridgeSessionPickKeys = onKeyDown;
  window.addEventListener('keydown', onKeyDown, true);
}
