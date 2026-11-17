// 工作空间 · 桌面版（FilesDesktop）的内部拖拽（同位置移动 / Ctrl=复制、桌面壳原生拖出）、从系统拖入导入或上传、空白处框选。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { joinAbs } from '../../../lib/dragOut.js';
import { hasNativeDragOut, nativeDragPaths, nativeDragWorkspace, nativePathForFile, nativeWorkspaceImportPaths, pcPathForFile } from '../../../lib/nativeDesktop.js';
import { WS_DT } from '../../../lib/fileDrag.js';
import { t, tr } from '../../../lib/i18n.js';
import { dtHasFiles } from '../../../lib/files/common.js';

export function createFdDrag(P) {
  // —— 内部拖拽（同位置移动 / Ctrl=复制）+ OS 拖入导入 ——
  let dragRels = null;
  function rowDragStart(e, it) {
    if (P.renaming) { e.preventDefault(); return; }
    if (!P.selected.has(it.rel)) { P.selected = new Set([it.rel]); P.anchorRel = it.rel; }
    dragRels = [...P.selected];
    // 桌面壳（#8）：换成原生 OS 拖拽——可拖进 Explorer/微信/Word，也可拖进聊天输入栏
    // （Composer 零拷贝直接引用）。拖回本页时 dragRels 仍在，内部移动分支照旧接管
    //（原生拖在自己窗口上同样触发 HTML5 dragover/drop）。Windows DoDragDrop 是模态——
    // promise resolve＝拖拽结束，在此清态并兜底刷新（外部 Shift 移动会把源文件搬走）。
    // 云端作用域（项目目录不在 primary 位置内）同样原生拖出：bridge 三形态都跑在本机，
    // 服务端绝对路径就是本机路径，拼位置根+rel 走 drag:start（主进程只做存在性校验）。
    if (hasNativeDragOut() && (P.nativeFs || P.wsRootLocal)) {
      e.preventDefault();
      const rels = dragRels;
      const run = P.nativeFs ? nativeDragWorkspace(rels, P.locationId) : nativeDragPaths(rels.map((r) => joinAbs(P.wsRoot, r)));
      run.catch(() => {}).finally(() => {
        if (dragRels === rels) { dragRels = null; P.dropOn = null; }
        P.refresh();
      });
      return;
    }
    // 描述符随拖拽一起走：拖回本页＝内部移动（认 dragRels），拖进对话＝按 rel 现场备素材
    // 挂进那个会话的输入栏（见 lib/fileDrag.js 的 attachDescriptorToAgent）。
    try {
      e.dataTransfer.effectAllowed = 'copyMove';
      // dirs 与 rels 一一对应：落点（如 dimensio 跨工作空间那条）要据此把文件夹挑出来说清楚
      const dirs = dragRels.map((rel) => Boolean(P.rows.find((x) => x.rel === rel)?.isDir));
      e.dataTransfer.setData(WS_DT, JSON.stringify({ rels: dragRels, dirs, ws: P.wsRoot, locationId: P.nativeFs ? P.locationId : '' }));
    } catch {}
  }
  function rowDragEnd() { dragRels = null; P.dropOn = null; }
  function dirDropOk(destRel) {
    if (!dragRels) return false;
    return dragRels.every((rel) => rel !== destRel && !destRel.startsWith(rel + '/'));
  }
  function dragOverDir(e, it) {
    if (!it.isDir || it.linkType === 'external-link') return;
    if (dragRels) {
      if (!dirDropOk(it.rel)) return;
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch {}
      P.dropOn = it.rel;
    } else if (dtHasFiles(e) && P.canDropImport && P.inBrowse) {
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      P.dropOn = it.rel;
    }
  }
  function dragOverPane(e) {
    if (dragRels) {
      if (!P.inBrowse) return;
      if (!dragRels.some((rel) => P.parentOf(rel) !== P.path) && !e.ctrlKey) return;   // 拖回原地无意义
      e.preventDefault();
      try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch {}
      P.dropOn = '';
    } else if (dtHasFiles(e) && P.canDropImport && P.inBrowse) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      P.dropOn = '';
    }
  }
  function dragLeavePane(e) { if (!e.currentTarget.contains(e.relatedTarget)) P.dropOn = null; }
  function dragOverCrumb(e, destRel) {
    if (!dragRels || destRel == null) return;   // 位置根之上的段属于别的位置，不收拖放
    if (destRel === P.path || !dirDropOk(destRel)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch {}
    P.dropOn = 'crumb:' + destRel;
  }
  async function onDrop(e) {
    const target = P.dropOn; P.dropOn = null;
    if (target === null) return;
    e.preventDefault(); e.stopPropagation();
    const destRel = target.startsWith('crumb:') ? target.slice(6) : (target ? target : P.path);
    if (dragRels) {
      const rels = dragRels; dragRels = null;
      await P.doTransferInto(destRel, rels, e.ctrlKey);
      return;
    }
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!P.nativeFs) { await P.uploadFiles(files, destRel); return; }
    const paths = files.map(P.pcOk ? pcPathForFile : nativePathForFile).filter(Boolean);
    if (!paths.length) { P.toast(t('无法读取拖入的文件路径')); return; }
    P.busyLabel = t('导入中…');
    try {
      const r = await nativeWorkspaceImportPaths(destRel, paths, P.locationId);
      const n = r.items?.length || 0, f = r.errors?.length || 0;
      P.toast(n ? (f ? t('已导入 {n} 项，{f} 项失败', { n, f }) : t('已导入 {n} 项', { n })) : (r.errors?.[0] ? tr(r.errors[0]) : t('导入失败')));
    } catch (err) { P.toast(t('导入失败：{reason}', { reason: tr(err.message || '') })); }
    P.busyLabel = '';
    await P.refresh();
  }

  // —— 框选（空白处按下拖出选择矩形）——
  function paneDown(e) {
    if (e.button !== 0 || P.renaming) return;
    try { P.rowsEl?.focus({ preventScroll: true }); } catch {}
    if (e.target.closest('[data-rel]') || e.target.closest('.fd-colhead')) return;
    const keep = e.ctrlKey || e.metaKey ? new Set(P.selected) : new Set();
    const x0 = e.clientX, y0 = e.clientY;
    let active = false;
    const move = (ev) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      active = true;
      const l = Math.min(x0, ev.clientX), tp = Math.min(y0, ev.clientY);
      const r = Math.max(x0, ev.clientX), b = Math.max(y0, ev.clientY);
      const box = P.rootEl?.getBoundingClientRect();
      P.marquee = { l: l - (box?.left || 0), t: tp - (box?.top || 0), w: r - l, h: b - tp };
      const next = new Set(keep);
      for (const el of P.rowsEl?.querySelectorAll('[data-rel]') || []) {
        const bb = el.getBoundingClientRect();
        if (bb.left < r && bb.right > l && bb.top < b && bb.bottom > tp) next.add(el.dataset.rel);
      }
      P.selected = next;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!active) { P.selected = keep; P.anchorRel = ''; }
      P.marquee = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }


  return {
    get dragLeavePane() { return dragLeavePane; },
    get dragOverCrumb() { return dragOverCrumb; },
    get dragOverDir() { return dragOverDir; },
    get dragOverPane() { return dragOverPane; },
    get onDrop() { return onDrop; },
    get paneDown() { return paneDown; },
    get rowDragEnd() { return rowDragEnd; },
    get rowDragStart() { return rowDragStart; },
  };
}
