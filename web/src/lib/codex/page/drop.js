// 从 bridge 工作空间拖一份文件到 Codex 页上：先备成 uploads 素材，再挂进输入栏的待发附件。
// 手指（全域拖拽 dropZone）与鼠标（HTML5 拖拽）两条路都收在 dropWsFiles 里。

import { api } from '../../api.js';
import { kindOf } from '../../preview.svelte.js';
import { dropToast } from '../../dragdrop.svelte.js';
import { WS_FILE, dtHasWsFiles, wsDescriptorFrom } from '../../fileDrag.js';
import { t } from '../../i18n.js';
import { addAttachments } from '../composer/atts.svelte.js';
import { isCxThreadRef, dtHasCxThread, rawCxSideDrag, canQuoteCx, quoteCxThread, endCxMouseDrag } from '../chrome/sideDnd.svelte.js';

export async function dropWsFiles(rels, ws = '') {
  const out = [];
  for (const rel of rels) {
    try {
      const d = await api.fileToUpload(rel, true, ws);
      out.push({ name: d.name, path: d.path, size: 0, mime: '', kind: kindOf(d.name) });
    } catch {}
  }
  if (out.length) addAttachments(out);
  dropToast(out.length ? t('已挂进 Codex 的输入栏') : t('准备失败'));
}

// 手指：工作空间文件 = 挂进输入栏；侧栏线程 = 引用进当前线程（松在侧栏另一条线程上的由那一行接）
export const codexDrop = {
  key: 'chat:codex',
  effect: 'send',
  label: (p) => (isCxThreadRef(p) ? t('引用到这个对话') : p?.count > 1 ? t('把 {n} 项挂进这个对话', { n: p.count }) : t('挂进这个对话')),
  accept: (p) => (p?.type === WS_FILE && !!p.rels?.length) || (isCxThreadRef(p) && canQuoteCx(p.id)),
  drop: (p) => (isCxThreadRef(p) ? quoteCxThread({ id: p.id, title: p.name }) : dropWsFiles(p.rels, p.ctx?.ws || '')),
};

// 鼠标：线程松在对话区任意处（侧栏里没落在别的线程上的不算——那是拖了又放回去）
const threadOver = (e) => {
  if (!dtHasCxThread(e) || e.target?.closest?.('.cx-side')) return null;
  const r = rawCxSideDrag();
  return r && canQuoteCx(r.id) ? r : null;
};

export function onWsDragOver(e) {
  if (threadOver(e)) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch {} return; }
  if (!dtHasWsFiles(e)) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'copy'; } catch {}
}

export function onWsDrop(e) {
  const rec = threadOver(e);
  if (rec) { e.preventDefault(); endCxMouseDrag(); quoteCxThread(rec); return; }
  if (!dtHasWsFiles(e)) return;
  e.preventDefault();
  const desc = wsDescriptorFrom(e.dataTransfer);
  if (desc) dropWsFiles(desc.rels, desc.ws || '');
}
