// Codex 侧栏拖放（同 Claude / Antigravity 侧栏）：线程拖进输入栏或侧栏另一条线程上松手 = 引用那条线程
// （服务端整理成 Markdown 落进 uploads，当一张「引用的对话」附件挂进输入栏，发送时 Codex 按需去读）。
// 鼠标走 HTML5 拖拽（载荷走 CX_SIDE_DT，跨 ThreadRow / 页面落点共享 cxSideDrag）；手指走全站长按拿起
// （lib/dragdrop.svelte.js，载荷 { type: CX_THREAD_REF, id, name }），原地按住再松手 = 这一行的菜单。

import { codex } from '../store.svelte.js';
import { codexApi } from '../api.js';
import { draft, focusComposer, settleAtts } from '../composer/atts.svelte.js';
import { dropToast } from '../../dragdrop.svelte.js';
import { t, tr } from '../../i18n.js';

export const CX_THREAD_REF = 'codex-thread';
export const CX_SIDE_DT = 'application/x-bridge-codex-side';

export const CHAT_GHOST_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4.5 20l1.2-3.5C4.6 15.3 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/><path d="M8.6 11h6.8M8.6 14h4.2"/></svg>';

/** 鼠标正在拖的线程（驱动落点显形）；raw 是同步副本——dragstart / dragover 不等 Svelte flush。 */
export const cxSideDrag = $state({ id: '', title: '' });
let raw = null;
export const rawCxSideDrag = () => raw;

export function beginCxMouseDrag(rec) {
  raw = rec;
  // dragstart 里同步改 DOM（落点显形）会让 Chromium 当场取消这次拖拽：下一拍再动
  setTimeout(() => { if (raw === rec) Object.assign(cxSideDrag, { id: rec.id, title: rec.title }); }, 0);
}
export function endCxMouseDrag() {
  raw = null;
  Object.assign(cxSideDrag, { id: '', title: '' });
}

export const isCxThreadRef = (p) => p?.type === CX_THREAD_REF && !!p.id;
/** 这次拖拽（HTML5）是不是一条 Codex 线程：dragover 里读不到 getData，只能看 types。 */
export const dtHasCxThread = (e) => { try { return [...(e.dataTransfer?.types || [])].includes(CX_SIDE_DT); } catch { return false; } };

/** 能不能把线程 id 引进「当前开着 curId 的线程」：不引自己，不重复引。 */
export function canQuoteCx(id, curId = codex.sessionId) {
  if (!id || id === curId) return false;
  return !draft.atts.some((a) => a.kind === 'chat' && a.quoteId === id);
}

let seq = 0;
/** 引进当前输入栏：先放一张「整理中」的卡，服务端回来再填路径。 */
export async function quoteCxThread({ id, title = '' }) {
  if (!id) return false;
  if (id === codex.sessionId) { dropToast(t('不能引用当前对话自己')); return false; }
  if (draft.atts.some((a) => a.kind === 'chat' && a.quoteId === id)) { dropToast(t('这个对话已经引用过了')); return false; }
  const name = title || t('（无标题）');
  draft.atts.push({ id: 'q' + (++seq).toString(36) + Date.now().toString(36).slice(-4), name, size: 0, mime: 'text/markdown', kind: 'chat', quoteId: id, count: null, path: '', progress: 0.5, error: '', thumb: '' });
  const live = draft.atts[draft.atts.length - 1];
  focusComposer();
  try {
    const r = await codexApi.quoteSession(id, title);
    if (draft.atts.indexOf(live) < 0) return false;            // 整理期间被移除了
    live.path = r?.path || '';
    live.name = r?.name || live.name;
    live.count = Number(r?.count) || 0;
    live.progress = null;
    if (!live.path) throw new Error('');
    dropToast(t('已引用对话「{title}」', { title: live.name }));
    return true;
  } catch (e) {
    const i = draft.atts.indexOf(live);
    if (i >= 0) draft.atts.splice(i, 1);
    const why = e?.body?.error || e?.message || '';
    dropToast(why ? t('引用失败：{reason}', { reason: tr(why) }) : t('引用失败'));
    return false;
  } finally { settleAtts(); }
}

/** 干净的拖拽图（浏览器默认把整行连悬停底色一起截下来）。样式复用 app.css 的 .bridge-side-ghost。 */
export function cxDragGhost(e, text) {
  try {
    const g = document.createElement('div');
    g.className = 'bridge-side-ghost';
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.style.cssText = 'display:inline-flex;align-items:center;width:14px;height:14px';
    ic.innerHTML = CHAT_GHOST_IC;
    const tx = document.createElement('span');
    tx.className = 't';
    tx.textContent = text || '';
    g.append(ic, tx);
    document.body.appendChild(g);
    e.dataTransfer.setDragImage(g, 16, Math.round(g.offsetHeight / 2) || 16);
    setTimeout(() => g.remove(), 0);
  } catch {}
}
