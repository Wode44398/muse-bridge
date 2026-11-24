// Antigravity 侧栏拖放协同状态与动作：
//   · 会话拖进输入栏 / 侧栏另一条会话 = 引用这段对话（导出 Markdown 到 uploads 当附件挂进草稿）；
//   · 工作空间拖进输入栏 = 直接引用这个文件夹（零拷贝挂入 kind:'folder' 附件）。
// 鼠标 HTML5 拖拽在跨组件共享状态时经 agySideDrag 同步；触屏长按拿起走全局 lib/dragdrop.svelte.js。

import { agy, pushAgyFolder } from './store.svelte.js';
import { agyApi } from './api.js';
import { normCmpDir } from './session-groups.js';
import { dropToast } from '../dragdrop.svelte.js';
import { t, tr } from '../i18n.js';

export const AGY_CHAT_REF = 'agy-session';
export const AGY_PROJ_REF = 'agy-project';
export const AGY_SIDE_DT = 'application/x-bridge-agy-side';

export const CHAT_GHOST_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4.5 20l1.2-3.5C4.6 15.3 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/><path d="M8.6 11h6.8M8.6 14h4.2"/></svg>';

// 当前鼠标 HTML5 拖拽载荷（跨 Sidebar / SessionRow / Composer 共享）
export const agySideDrag = $state({
  kind: '',     // '' | 'session' | 'project'
  id: '',
  path: '',
  title: '',
  cwd: '',
});

// 同步副本，避免 dragstart/dragover 在 Svelte flush 前读到旧值
let rawSideDrag = null;
export const getRawAgySideDrag = () => rawSideDrag;

export function beginAgyMouseDrag(rec) {
  rawSideDrag = rec;
  // 延迟一拍改响应式状态：dragstart 内同步改 DOM（如收起会话行、亮起落点）会导致 Chromium 立刻取消拖拽
  setTimeout(() => {
    if (rawSideDrag !== rec) return;
    Object.assign(agySideDrag, {
      kind: rec.kind || '',
      id: rec.id || '',
      path: rec.path || '',
      title: rec.title || '',
      cwd: rec.cwd || '',
    });
  }, 0);
}

export function endAgyMouseDrag() {
  rawSideDrag = null;
  Object.assign(agySideDrag, { kind: '', id: '', path: '', title: '', cwd: '' });
}

export const isAgyChatRef = (p) => p?.type === AGY_CHAT_REF && !!p.id;
export const isAgyProjRef = (p) => p?.type === AGY_PROJ_REF && !!p.path;

export function canQuoteAgy(id, curId = agy.sessionId) {
  if (!id || id === curId) return false;
  return !agy.draftAtts.some((a) => a.kind === 'chat' && a.quoteId === id);
}

export function canRefAgyFolder(dirPath) {
  const key = normCmpDir(dirPath);
  if (!key) return false;
  return !agy.draftAtts.some((a) => a.path && normCmpDir(a.path) === key);
}

export async function quoteAgySession({ id, title = '', cwd = '' } = {}) {
  if (!id) return false;
  if (id === agy.sessionId) {
    dropToast(t('不能引用当前对话自己'));
    return false;
  }
  if (agy.draftAtts.some((a) => a.kind === 'chat' && a.quoteId === id)) {
    dropToast(t('这个对话已经引用过了'));
    return false;
  }
  agy.draftAtts.push({
    path: '',
    name: title || t('未命名对话'),
    kind: 'chat',
    quoteId: id,
    url: '',
    count: null,
    pending: true,
  });
  const live = agy.draftAtts[agy.draftAtts.length - 1];
  try {
    const r = await agyApi.quoteSession({ id, title, cwd });
    if (agy.draftAtts.indexOf(live) < 0) return false;
    live.path = r.path;
    live.name = r.name || live.name;
    live.count = Number(r.count) || 0;
    live.pending = false;
    dropToast(t('已引用对话「{title}」', { title: live.name }));
    return true;
  } catch (err) {
    const idx = agy.draftAtts.indexOf(live);
    if (idx >= 0) agy.draftAtts.splice(idx, 1);
    const why = err?.body?.error || err?.message || '';
    dropToast(why ? t('引用失败：{reason}', { reason: tr(why) }) : t('引用失败'));
    return false;
  }
}

export function refAgyFolder({ path: dirPath, name = '' } = {}) {
  const key = normCmpDir(dirPath);
  if (!key) return false;
  if (agy.draftAtts.some((a) => a.path && normCmpDir(a.path) === key)) {
    dropToast(t('这个文件夹已经引用过了'));
    return false;
  }
  const label = name || String(dirPath).split(/[\\/]/).filter(Boolean).pop() || 'folder';
  pushAgyFolder(dirPath, label);
  dropToast(t('已引用文件夹「{name}」', { name: label }));
  return true;
}

// 干净的 HTML5 拖拽幽灵卡（复用 app.css 里的 .bridge-side-ghost）
export function makeAgyDragGhost(ev, text, kind = 'session') {
  try {
    const g = document.createElement('div');
    g.className = 'bridge-side-ghost' + (kind === 'project' ? ' proj' : '');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.style.display = 'inline-flex';
    ic.style.alignItems = 'center';
    ic.innerHTML = kind === 'project'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4.5 20l1.2-3.5C4.6 15.3 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/></svg>';
    const tx = document.createElement('span');
    tx.className = 't';
    tx.textContent = text || '';
    g.append(ic, tx);
    document.body.appendChild(g);
    ev.dataTransfer.setDragImage(g, 16, Math.round(g.offsetHeight / 2) || 16);
    setTimeout(() => g.remove(), 0);
  } catch {}
}
