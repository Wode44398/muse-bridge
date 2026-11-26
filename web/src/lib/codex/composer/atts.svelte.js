// Codex 输入栏待发的附件（和输入栏本身的几个钩子）。放在模块里而不是组件里：
// 页面级的拖放区（工作空间文件拖进来、整页接住的系统文件）也要往这里塞，塞完输入栏自己会长出附件卡。
//
// 一项附件：{ id, name, size, mime, kind, path, progress, error, thumb }
//   path      上传好后服务端给的路径（发送时用它）；没好之前是 ''
//   progress  0–1 = 上传中；null = 好了或失败
//   thumb     图片缩略图（本地 File 的 blob URL，或已在服务器上的那份的产物地址）

import { api } from '../../api.js';
import { kindOf } from '../../fileKinds.js';
import { codexArtifactUrl } from '../../preview.svelte.js';
import { t } from '../../i18n.js';
import { errText } from '../store.svelte.js';

export const draft = $state({ atts: [] });

// 输入栏挂载时登记的几个动作（页面、斜杠命令之外的地方要聚焦输入栏 / 塞一段字时用）
const hooks = { focus: null, insert: null };
export function registerComposer(h) {
  Object.assign(hooks, h);
  return () => { for (const k of Object.keys(h)) if (hooks[k] === h[k]) hooks[k] = null; };
}
export const focusComposer = () => hooks.focus?.();
/** 往输入框光标处插一段字（比如从别处引用一句）。 */
export const insertIntoComposer = (text) => hooks.insert?.(text);

let seq = 0;
const nid = () => 'a' + (++seq).toString(36) + Date.now().toString(36).slice(-4);
const waiters = new Set();

function find(id) { return draft.atts.find((a) => a.id === id); }
/** 别处（引用对话）改完自己挂的卡后调：手上没在传的了就放行等着发送的那一下。 */
export function settleAtts() { settle(); }
function settle() {
  if (uploading()) return;
  for (const w of waiters) w();
  waiters.clear();
}

/** 系统文件（选择框、粘贴、拖进输入栏）：先放一张卡，边传边走进度。 */
export function addFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  for (const file of list) {
    const name = file.name || t('粘贴的图片');
    const kind = kindOf(name, file.type || '');
    const item = {
      id: nid(), name, size: file.size || 0, mime: file.type || '', kind, path: '', progress: 0, error: '',
      thumb: kind === 'image' ? URL.createObjectURL(file) : '',
    };
    draft.atts.push(item);
    const id = item.id;
    api.uploadBlob(name, file, {
      onProgress: (p) => { const a = find(id); if (a && a.progress != null) a.progress = Math.min(0.99, p); },
    }).then((d) => {
      const a = find(id);
      if (!a) return;
      a.path = d?.path || '';
      a.name = d?.name || a.name;
      a.progress = null;
      if (!a.path) a.error = t('上传失败');
    }, (e) => {
      const a = find(id);
      if (a) { a.progress = null; a.error = errText(e, t('上传失败')); }
    }).finally(settle);
  }
  return list.length;
}

/** 工作空间里的文件（从文件卡拖进来）：服务端先备一份成上传素材。 */
export async function addWsFiles(rels, ws = '') {
  const ids = [];
  for (const rel of rels || []) {
    const name = String(rel).split(/[\\/]/).pop() || String(rel);
    const item = { id: nid(), name, size: 0, mime: '', kind: kindOf(name), path: '', progress: 0, error: '', thumb: '' };
    draft.atts.push(item);
    ids.push(item.id);
  }
  await Promise.all(ids.map(async (id, i) => {
    try {
      const d = await api.fileToUpload(rels[i], true, ws);
      const a = find(id);
      if (!a) return;
      a.path = d?.path || '';
      a.name = d?.name || a.name;
      a.progress = null;
      if (!a.path) a.error = t('准备失败');
      else if (a.kind === 'image') a.thumb = codexArtifactUrl('', a.path, { name: a.name });
    } catch (e) {
      const a = find(id);
      if (a) { a.progress = null; a.error = errText(e, t('准备失败')); }
    }
  }));
  settle();
  return ids.length;
}

/** 已经在服务器上的（别处传好的）：直接挂上。list = [{ path, name, size?, mime?, kind? }] */
export function addAttachments(list) {
  let n = 0;
  for (const x of Array.isArray(list) ? list : []) {
    if (!x?.path) continue;
    const name = String(x.name || String(x.path).split(/[\\/]/).pop());
    const kind = x.kind && x.kind !== 'other' ? x.kind : kindOf(name, x.mime || '');
    draft.atts.push({
      id: nid(), name, size: x.size || 0, mime: x.mime || '', kind, path: x.path, progress: null, error: '',
      thumb: kind === 'image' ? codexArtifactUrl('', x.path, { name }) : '',
    });
    n++;
  }
  return n;
}

export function removeAtt(id) {
  const a = find(id);
  if (a?.thumb?.startsWith('blob:')) { try { URL.revokeObjectURL(a.thumb); } catch {} }
  draft.atts = draft.atts.filter((x) => x.id !== id);
  settle();
}

export const uploading = () => draft.atts.some((a) => a.progress != null);
export const readyAtts = () => draft.atts.filter((a) => a.path && !a.error);

/** 等手上的上传都结束（成功或失败）。 */
export function whenUploaded() {
  if (!uploading()) return Promise.resolve();
  return new Promise((r) => waiters.add(r));
}

/** 发出去之后清掉（缩略图的 blob 留给对话里那条消息用，不在这里回收）。 */
export function clearAtts() {
  draft.atts = [];
}

/** 发送时交给 store.send 的形状。 */
export const sendShape = (list) => list.map((a) => ({ path: a.path, name: a.name, kind: a.kind, mime: a.mime, size: a.size }));
