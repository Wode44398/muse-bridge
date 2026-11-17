// 工作空间 · 桌面版（FilesDesktop）的打开与查看器：同文件夹的图片视频组成画廊、文档组成翻页序列；空格快速查看；查看器里的改名 / 删除；关掉后回位高亮。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { uiConfirm } from '../../../lib/dialogs.js';
import { onMount, tick, untrack } from 'svelte';
import { closePreview, cloudFileUrl, preview, previewNext, previewPrev, previewRemove, previewReplace } from '../../../lib/preview.svelte.js';
import { nativeWorkspaceOpen, nativeWorkspaceOpenWith, nativeWorkspaceReveal, nativeWorkspaceSaveAs } from '../../../lib/nativeDesktop.js';
import { isEn, t, tr } from '../../../lib/i18n.js';
import { extOf, kindOf as fkKind } from '../../../lib/fileKinds.js';
import { buildSequence, rectOf } from '../../../lib/fileGrid.js';
import { askRename } from '../../../lib/renamePrompt.js';
import { baseKey } from '../../../lib/files/common.js';
import { EXEC_EXTS, joinPath, relUnder } from './fdLook.js';

export function createFdView(P) {
  // 额外位置（loc-* / 各盘）里打开的文件，绝对路径要是落在 primary（库）根内，就换算成 primary 的 rel：
  // md 双链 / 出链 / 反链 / 插图、服务端转 PDF、视频流都只认 primary（＝服务端的身份文件根），
  // 不换的话同一篇笔记从「E 盘」点进去链接全断、图裂（M10/T10）。不在库里的照旧按原位置走。
  function primaryRelOf(rel) {
    if (!P.nativeOk || !P.nativeFs || P.locationId === 'primary' || !P.curLoc?.abs) return null;   // 连远端时没有「库」可换算
    const rootAbs = P.locations.find((l) => l.id === 'primary')?.abs;
    if (!rootAbs) return null;
    const r = relUnder(rootAbs, joinPath(P.curLoc.abs, rel));
    return r ? r : null;
  }
  const srcItem = (it, kind) => {
    const pr = primaryRelOf(it.rel);
    return { origin: 'cloud', rel: pr ?? it.rel, name: it.name, kind, mt: it.mtime, ws: P.wsRoot, nativeLocation: P.nativeFs ? (pr != null ? 'primary' : P.locationId) : '' };
  };
  // —— 打开：同文件夹的图片与视频按列表顺序组成一个画廊，文档组成前后翻页序列，音频自成一组（lib/fileGrid.js buildSequence）——
  // 描述带上大小 / 修改时间 / 宽高 / 时长（查看器先按比例占好位、信息面板直接有数），图片视频再带格子在屏上的矩形（从它放大进入、关时缩回）。
  let openMap = null;          // 查看器里每一项的 key → 列表里的那一项（查看器里改名 / 删除、关闭后定位都靠它）
  let lastRel = '';            // 查看器里最后看的那一项
  let quickLook = false;       // 空格打开的快速查看：空格 / Esc 关，四个方向键都切换
  const srcOf = (it) => (it?.key && (openMap?.get(it.key) || openMap?.get(baseKey(it.key)))) || null;
  function cellEls() {
    const m = new Map();
    for (const el of P.rowsEl?.querySelectorAll('[data-rel]') || []) m.set(el.dataset.rel, el);
    return m;
  }
  function descOf(f, els) {
    const k = fkKind(f.name);
    const d = { ...srcItem(f, k), size: f.size, mt: f.mtime };
    const m = P.metaOf(f);
    if (m?.w > 0 && m?.h > 0) { d.width = m.w; d.height = m.h; }
    if (m?.dur > 0) d.duration = m.dur;
    if (k === 'image' || k === 'video') {
      const el = els?.get(f.rel);
      const r = rectOf(el?.querySelector('.ric-img, .tic-img') || el?.querySelector('.ric, .tic'), P.rowsEl);
      if (r) d.originRect = r;
      const th = P.thumbs[P.thumbKey(f.rel)];
      if (th) d.thumbUrl = th;
    }
    return d;
  }
  function startPreview(seq, index, quick = false) {
    P.openPreview(seq.map((f) => descOf(f, cellEls())), index, { actions: viewerActs() });
    if (!preview.open) return;
    openMap = new Map(preview.items.map((x, i) => [x.key, seq[i]]));
    lastRel = seq[index]?.rel || '';
    quickLook = quick;
  }
  // 空格快速查看（Finder 式）：选了多个就在选中的里面翻，只选一个就在整个文件夹的文件里翻（含没有内嵌查看器的，给信息卡）
  function quickLookSel() {
    const sel = P.selectedRows().filter((f) => !f.isDir);
    const cur = sel.find((f) => f.rel === P.anchorRel) || sel[0];
    if (!cur) return;
    const { seq, index } = buildSequence(sel.length > 1 ? sel : P.rows, cur, { groupOf: () => 'all', same: (a, b) => a.rel === b.rel });
    startPreview(seq, index, true);
  }
  // 应用级弹窗（改名框 / 确认框，挂在 body 上）结算后焦点可能掉到 BODY（打开它的元素在等待期间被重绘掉了）：
  // 还给打开前的元素；它不在了就给查看器根，查看器没开就给当前行 / 列表。弹窗退场动画约 220ms，前后各补一次。
  function refocusAfterDialog(ret) {
    const fix = () => {
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement) return;
      const vw = preview.open ? document.querySelector('.vw-root') : null;
      const el = ret?.isConnected && ret !== document.body ? ret : vw || (P.anchorRel ? cellEls().get(P.anchorRel) : null) || P.rowsEl;
      try { el?.focus({ preventScroll: true }); } catch {}
    };
    setTimeout(fix, 0);
    setTimeout(fix, 280);
  }
  // 查看器里的提示出在查看器自己的 toast 层（本页的 toast 在 z 300 的查看器下面，看不见）
  const sayIn = (vctx, m, kind = 'err') => (vctx?.toast ? vctx.toast(m, { kind, ms: 3200 }) : P.toast(m));
  // 改名框的明暗跟着所在的查看器走：媒体（图 / 视频 / 音频）恒暗，文档类跟随本页明暗（与删除确认框一致）
  const renameDark = (it) => (['image', 'video', 'audio'].includes(it?.kind) ? true : undefined);
  // 查看器顶栏 / 菜单里的动作（kit/actions.js）：发送给 AI 先关查看器再弹本页的对话框；改名用挂在 body 上的应用级改名框
  // （本页的弹层在 .fd-root 的层叠上下文里，压不过 z-index 300 的查看器）；删除先确认，删掉后停在下一项、删空就关。
  // 第二个参数是查看器给的 { toast }（失败提示出在查看器里）。
  function viewerActs() {
    const a = {};
    if (P.serverOps || P.pcFs) a.sendAi = (it) => {
      const f = srcOf(it);
      if (!f) return;
      closePreview();
      P.ai.open(f);
    };
    a.rename = async (it, vctx) => {
      const f = srcOf(it);
      if (!f) return;
      const ret = document.activeElement;
      const name = (await askRename(f.name, { touch: false, dark: renameDark(it) }))?.trim();
      refocusAfterDialog(ret);
      if (!name || name === f.name) return;
      try { await P.fsRename(f.rel, name); } catch (e) { sayIn(vctx, t('重命名失败：{reason}', { reason: tr(e.message || '') })); return; }
      const parent = P.parentOf(f.rel);
      const nf = { ...f, name, rel: (parent ? parent + '/' : '') + name };
      const i = preview.items.findIndex((x) => x.key === it.key);
      if (i >= 0 && openMap) {
        openMap.delete(baseKey(it.key));
        previewReplace(i, descOf(nf, null));
        openMap.set(preview.items[i].key, nf);
      }
      lastRel = nf.rel;
      P.refresh();
    };
    a.trash = async (it, vctx) => {
      const f = srcOf(it);
      if (!f) return;
      const ask = P.nativeFs ? t('移到回收站「{name}」？', { name: f.name }) : t('删除「{name}」？', { name: f.name });
      const okLabel = isEn() ? (P.nativeFs ? t('移到回收站') : t('删除')) : undefined;
      const ret = document.activeElement;
      const ok = await uiConfirm(ask, { detail: P.nativeFs ? '' : t('云端工作空间的删除不可撤销。'), okLabel, danger: true });
      refocusAfterDialog(ret);
      if (!ok) return;
      try { await P.fsRemove(f.rel); } catch (e) { sayIn(vctx, t('删除失败：{reason}', { reason: tr(e.message || '') })); return; }
      P.sizesTouched([f.rel]);
      const i = preview.items.findIndex((x) => x.key === it.key);
      openMap?.delete(baseKey(it.key));
      if (i >= 0) previewRemove(i);
      P.refresh();
    };
    return a;
  }
  // 关掉查看器：选中最后看的那一项，不在可视区就把列表滚过去（只滚本页列表，不牵动外层宿主），再短暂描一圈蓝——人知道刚才看到哪儿了
  let flashRel = $state('');
  let flashTimer = 0;
  $effect(() => {
    const open = preview.open, cur = preview.items[preview.index];
    untrack(() => {
      if (!openMap) return;
      if (open) { const f = srcOf(cur); if (f) lastRel = f.rel; return; }
      openMap = null; quickLook = false;
      if (lastRel) revealAfterClose(lastRel);
    });
  });
  async function revealAfterClose(rel) {
    if (!P.rows.some((r) => r.rel === rel)) return;
    P.selected = new Set([rel]); P.anchorRel = rel;
    await tick();
    const el = cellEls().get(rel);
    if (el && P.rowsEl) {
      const box = P.rowsEl.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.top < box.top + 4) P.rowsEl.scrollTop -= box.top + 8 - r.top;
      else if (r.bottom > box.bottom - 4) P.rowsEl.scrollTop += r.bottom - box.bottom + 8;
    }
    flashRel = rel;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashRel = ''), 1400);
  }
  // 快速查看的键：挂 window 捕获阶段，先于查看器自己的键盘处理（它在冒泡阶段）。空格＝Esc（走查看器的关闭动画）；
  // 四个方向键都切换上一项 / 下一项（视频里左右不再是快进快退——快速查看是翻看，不是播放）。
  onMount(() => {
    const onQuickKey = (e) => {
      if (!quickLook || !preview.open || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      // 只读的代码视图（CodeView 的 cm-content：电脑上为了能放光标选字仍是 contenteditable，但带 aria-readonly）不算输入框——
      // 速览打开时焦点会落进去，不放行的话空格关不掉、方向键也换不了项（Quick Look 无论预览什么，空格都能关）
      const fld = e.target?.closest?.('input, textarea, select, [contenteditable]');
      if (fld && !(fld.closest('.cm-editor') && (fld.getAttribute('contenteditable') === 'false' || fld.getAttribute('aria-readonly') === 'true'))) return;
      if (e.key === ' ') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        return;
      }
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d || preview.items.length < 2) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (d > 0) previewNext(); else previewPrev();
    };
    window.addEventListener('keydown', onQuickKey, true);
    return () => { window.removeEventListener('keydown', onQuickKey, true); clearTimeout(flashTimer); };
  });

  function openItem(it) {
    if (it.isDir) { P.enterDir(it.rel); return; }
    const ext = extOf(it.name);
    if (fkKind(it.name) !== 'other') {
      const { seq, index } = buildSequence(P.rows, it, { same: (a, b) => a.rel === b.rel });
      startPreview(seq, index);
      return;
    }
    // 可执行文件不因双击直接运行（右键仍可显式「用默认应用打开」）；其余类型交系统关联。
    if (EXEC_EXTS.includes(ext)) {
      if (!P.nativeFs) { doDownload(it); return; }
      doReveal(it); P.toast(t('可执行文件已在资源管理器中定位（右键可选择打开）')); return;
    }
    if (!P.nativeFs) { doDownload(it); return; }   // 云端没有「交给系统关联程序」这回事，落到下载
    doOpen(it);
  }
  const doOpen = (it) => nativeWorkspaceOpen(it.rel, P.locationId).catch((e) => P.toast(t('打开失败：{reason}', { reason: tr(e.message || '') })));
  const doOpenWith = (it) => nativeWorkspaceOpenWith(it.rel, P.locationId).catch((e) => P.toast(t('打开方式失败：{reason}', { reason: tr(e.message || '') })));
  const doReveal = (it) => nativeWorkspaceReveal(it.rel, P.locationId).catch((e) => P.toast(t('定位失败：{reason}', { reason: tr(e.message || '') })));
  function doSaveAs(it) {
    nativeWorkspaceSaveAs(it.rel, P.locationId)
      .then((r) => { if (!r?.canceled) P.toast(t('已保存到「{path}」', { path: r.path })); })
      .catch((e) => P.toast(t('保存失败：{reason}', { reason: tr(e.message || '') })));
  }
  // 云端通道的「另存为」＝浏览器下载（&dl=1 让服务端带上 Content-Disposition）。
  function doDownload(it) {
    const href = cloudFileUrl(it.rel, { dl: true, ws: P.wsRoot });
    const a = document.createElement('a');
    a.href = href; a.download = it.name; document.body.appendChild(a); a.click(); a.remove();
  }


  return {
    get cellEls() { return cellEls; },
    get doDownload() { return doDownload; },
    get doOpen() { return doOpen; },
    get doOpenWith() { return doOpenWith; },
    get doReveal() { return doReveal; },
    get doSaveAs() { return doSaveAs; },
    get flashRel() { return flashRel; }, set flashRel(v) { flashRel = v; },
    get openItem() { return openItem; },
    get quickLookSel() { return quickLookSel; },
    get refocusAfterDialog() { return refocusAfterDialog; },
  };
}
