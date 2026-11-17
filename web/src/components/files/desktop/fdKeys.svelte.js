// 工作空间 · 桌面版（FilesDesktop）的全局键盘（Explorer 式快捷键、键入定位）与排序 / 视图 / 图标大小 / 预览窗格的切换。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { tick, untrack } from 'svelte';
import { ui } from '../../../lib/state.svelte.js';
import { preview } from '../../../lib/preview.svelte.js';

export function createFdKeys(P) {
  // —— 全局键盘 ——
  let typeBuf = '', typeAt = 0;
  // 内嵌态不能吃整窗的键盘：工作台侧栏旁边就是 Claude 会话，用户在那儿按 Delete/F2
  // 不该动文件。所以只有焦点真的落在本面板内时才接管（点一下列表即获得焦点）。
  const kbdMine = () => (P.embedded ? !!P.rootEl && P.rootEl.contains(document.activeElement) : ui.screen === 'files');
  function onKey(e) {
    if (preview.open) return;                       // 沉浸查看器优先
    if (!kbdMine()) return;
    const inField = e.target.closest?.('input, textarea, [contenteditable]');
    if (e.key === 'Escape') {
      if (P.menu) { P.closeMenu(true); return; }
      if (P.sortOpen || P.addOpen || P.crumbPop || P.locPop) { P.sortOpen = false; P.addOpen = false; P.crumbPop = false; P.locPop = false; return; }
      if (P.ai.item) { P.ai.close(); return; }
      if (P.shareDlg) { if (!P.shareDlg.busy) P.shareDlg = null; return; }
      if (P.zipDlg) { if (!P.zipDlg.busy) P.zipDlg = null; return; }
      if (P.infoDlg) { P.infoDlg = null; return; }
      if (P.renaming) { P.renaming = null; return; }
      if (inField && inField === P.searchEl) { P.query = ''; P.searchEl.blur(); return; }
      if (P.query) { P.query = ''; return; }
      if (P.selected.size) { P.selected = new Set(); P.anchorRel = ''; }
      return;
    }
    // 菜单开着、焦点却不在菜单里（极少见：被别的脚本挪走）：方向键把焦点送回菜单，其余键不动列表
    if (P.menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const its = P.rootEl?.querySelectorAll('.ctx .ctx-mi:not(:disabled)') || [];
        try { its[e.key === 'ArrowDown' ? 0 : its.length - 1]?.focus({ preventScroll: true }); } catch {}
      }
      return;
    }
    if (inField || P.anyDialog) return;
    const ctrl = e.ctrlKey || e.metaKey;
    // 图标大小：焦点在列表区时 Ctrl+= / Ctrl+− 逐档换（与 Ctrl+滚轮同一条路：列表 ⇄ 64 ⇄ … ⇄ 240），拦掉浏览器缩放
    if (ctrl && !e.altKey && P.rowsEl?.contains(document.activeElement)
      && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) {
      e.preventDefault();
      stepIconSize(e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' ? -1 : 1);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); P.selectAll(); return; }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); P.setClipboard('copy'); return; }
    if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); P.setClipboard('cut'); return; }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); P.doPaste(); return; }
    if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); P.searchEl?.focus(); return; }
    if ((ctrl && e.key.toLowerCase() === 'l') || (e.altKey && e.key.toLowerCase() === 'd')) { e.preventDefault(); P.startAddr(); return; }
    if (e.key === 'F5') { e.preventDefault(); P.userRefresh(); return; }
    if (e.key === 'F2') { e.preventDefault(); const it = P.selectedRows()[0]; if (it && P.selected.size === 1) P.startRename(it); return; }
    if (e.key === 'Delete') { e.preventDefault(); P.doTrash(); return; }
    if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); if (P.canUp) P.goUp(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); P.goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); P.goFwd(); return; }
    if (e.key === 'Enter') { e.preventDefault(); const it = P.selectedRows()[0]; if (it) P.openItem(it); return; }
    // 空格：快速查看（键入定位途中的空格仍算名字的一部分）
    if (e.key === ' ' && !ctrl && !e.altKey && !(typeBuf && Date.now() - typeAt < 700)) { e.preventDefault(); if (!e.repeat) P.quickLookSel(); return; }
    if (e.altKey && !ctrl && e.code === 'KeyP') { e.preventDefault(); if (peekFits) togglePeek(); return; }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (!P.rows.length) return;
      e.preventDefault();
      let step = 1;
      if (P.view === 'grid') {
        // 列数按实际排出来的网格算（图标档变了列宽就变）
        const cols = Math.max(1, (getComputedStyle(P.rowsEl).gridTemplateColumns || '').split(' ').filter(Boolean).length);
        step = (e.key === 'ArrowDown' || e.key === 'ArrowUp') ? cols : 1;
      }
      const dir2 = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? step : -step;
      const cur = P.rows.findIndex((r) => r.rel === P.anchorRel);
      const next = Math.max(0, Math.min(P.rows.length - 1, cur < 0 ? 0 : cur + dir2));
      if (e.shiftKey && cur >= 0) {
        const [lo, hi] = cur < next ? [cur, next] : [next, cur];
        const s = new Set(P.selected);
        for (let i = lo; i <= hi; i++) s.add(P.rows[i].rel);
        P.selected = s; P.anchorRel = P.rows[next].rel;
        tick().then(() => { try { P.rowsEl?.querySelector(`[data-rel="${CSS.escape(P.rows[next].rel)}"]`)?.scrollIntoView({ block: 'nearest' }); } catch {} });
      } else P.focusRel(P.rows[next].rel);
      return;
    }
    // 键入定位（Explorer 式首字母跳转）
    if (e.key.length === 1 && !ctrl && !e.altKey) {
      const now = Date.now();
      typeBuf = (now - typeAt < 700 ? typeBuf : '') + e.key.toLowerCase();
      typeAt = now;
      const hit = P.rows.find((r) => r.name.toLowerCase().startsWith(typeBuf));
      if (hit) P.focusRel(hit.rel);
    }
  }

  function setSort(key) {
    if (P.mode === 'recent' && !P.searching) {
      P.recentSort = P.recentSort.key === key ? { key, dir: -P.recentSort.dir } : { key, dir: key === 'mtime' ? -1 : 1 };
      P.sortOpen = false;
      return;
    }
    if (P.sortKey === key) P.sortDir = -P.sortDir;
    else { P.sortKey = key; P.sortDir = key === 'mtime' ? -1 : 1; }
    P.sortOpen = false;
    P.savePrefs();
  }
  // 列表 ⇄ 图标是两套 {#each}：切换会把拿着焦点的那一行连同焦点一起销毁（焦点掉到 BODY，方向键、
  // 接着按的 Ctrl+= 都失去作用域，后者还会变成整页缩放）。焦点原本在列表区里的，切完还给同一项在新视图里的格子，
  // 找不到就给列表本身
  function setView(v) {
    const a = document.activeElement;
    const rel = P.rowsEl?.contains(a) ? (a?.dataset?.rel || P.anchorRel || '') : null;
    P.view = v; P.savePrefs();
    if (rel == null) return;
    tick().then(() => {
      const cur = document.activeElement;
      if (cur && cur !== document.body && cur !== document.documentElement && cur.isConnected) return;
      try { ((rel ? P.cellEls().get(rel) : null) || P.rowsEl)?.focus({ preventScroll: true }); } catch {}
    });
  }
  function setIconSize(px) { if (P.ICON_SIZES.includes(px) && px !== P.iconSize) { P.iconSize = px; P.savePrefs(); } }
  // 逐档：列表 ⇄ 最小图标 ⇄ … ⇄ 最大图标（Explorer 的 Ctrl+滚轮同一条路）
  function stepIconSize(d) {
    if (P.view !== 'grid') { if (d > 0) { P.iconSize = P.ICON_SIZES[0]; setView('grid'); } return; }
    const i = P.ICON_SIZES.indexOf(P.iconSize) + d;
    if (i < 0) { setView('list'); return; }
    if (i < P.ICON_SIZES.length) setIconSize(P.ICON_SIZES[i]);
  }
  // Ctrl+滚轮（触控板捏合也是 ctrl+wheel）：攒够一格再换档，免得一次捏合连跳好几档；顺手拦掉页面缩放
  $effect(() => {
    const el = P.rowsEl;
    if (!el) return;
    let acc = 0, accT = 0;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey) || preview.open) return;
      e.preventDefault();
      clearTimeout(accT); accT = setTimeout(() => (acc = 0), 220);
      acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(acc) < 60) return;
      const d = acc < 0 ? 1 : -1;
      acc = 0;
      untrack(() => stepIconSize(d));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(accT); };
  });
  function togglePeek() { P.peekOn = !P.peekOn; P.savePrefs(); }
  // 预览窗格只在宽处出（侧栏 + 列表 + 300 的窗格放得下），窄了自动让位、开关也收起
  const peekFits = $derived(P.tbW > 900);
  const peekShown = $derived(P.peekOn && peekFits);


  return {
    get onKey() { return onKey; },
    get peekFits() { return peekFits; },
    get peekShown() { return peekShown; },
    get setIconSize() { return setIconSize; },
    get setSort() { return setSort; },
    get setView() { return setView; },
    get togglePeek() { return togglePeek; },
  };
}
