// 工作空间 · 桌面版（FilesDesktop）的右键菜单：弹出定位（换算到定位坐标系）、关闭还焦点、在别处再右键时重放，以及条目、空白处、位置三套菜单的条目。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { tick } from 'svelte';
import { me, pluginOn } from '../../../lib/state.svelte.js';
import { hasNativeFileClipboard, nativeWorkspaceReveal } from '../../../lib/nativeDesktop.js';
import { isEn, t, tc } from '../../../lib/i18n.js';
import { kindOf as fkKind } from '../../../lib/fileKinds.js';
import { kindOf } from '../../../lib/files/common.js';
import { fdPluginOpenEntries } from './fdPluginOpen.js';

export function createFdMenus(P) {
  // —— 右键菜单 ——
  function popupMenu(e, entries) {
    e.preventDefault(); e.stopPropagation();
    // 坐标必须换算到【定位坐标系】而不是视口：内嵌进工作台侧栏时外面那层 .dk-embed 带
    // transform，会把 fixed 的包含块从视口变成该容器——直接用 clientX/innerWidth 算出来的
    // 点落在容器外，被 overflow:hidden 裁掉，屏上就只剩一层空遮罩。整页时 rect = 视口，
    // 行为与从前完全一致。
    const box = P.rootEl?.getBoundingClientRect();
    const ox = box?.left || 0, oy = box?.top || 0;
    const vw = box?.width || window.innerWidth, vh = box?.height || window.innerHeight;
    const cx = e.clientX - ox, cy = e.clientY - oy;
    // 英文菜单项更长（“Move 3 items to Recycle Bin  Del”），贴右缘夹取按更宽的估值算，免得菜单右侧被裁
    const W = isEn() ? 264 : 236, H = entries.filter((x) => !x.sep).length * 32 + entries.filter((x) => x.sep).length * 9 + 10;
    const x = Math.min(Math.max(8, cx), Math.max(8, vw - W - 8));
    const y = cy + H > vh - 10 ? Math.max(8, cy - H) : cy;
    // 记下打开前的焦点（通常是右键的那一行），关菜单时还回去
    const a = document.activeElement;
    const ret = a?.closest?.('.ctx') ? P.menu?.ret : a;
    P.menu = { x, y, entries, ret };
    // 焦点移到第一个可用项：↑↓ 直接能选（鼠标打开时 :focus-visible 不亮，看不出焦点在哪）
    tick().then(() => { try { P.rootEl?.querySelector('.ctx .ctx-mi:not(:disabled)')?.focus({ preventScroll: true }); } catch {} });
  }
  function closeMenu(restore = false) {
    const ret = P.menu?.ret;
    P.menu = null;
    if (!restore) return;
    const el = ret?.isConnected && ret !== document.body ? ret : (P.anchorRel ? P.cellEls().get(P.anchorRel) : null) || P.rowsEl;
    try { el?.focus({ preventScroll: true }); } catch {}
  }
  function menuRun(entry) {
    closeMenu(true);
    if (!entry.disabled) entry.act?.();
  }
  // 菜单开着时在别处再右键：关掉旧菜单，在落点下面的元素上重放一次 contextmenu——落在行上就在那一行弹、
  // 落在空白处弹空白菜单、落在地址栏弹地址菜单（资源管理器同款）；落点没有菜单就只关掉并还焦点
  async function reMenu(e) {
    e.preventDefault();
    const x = e.clientX, y = e.clientY;
    const ret = P.menu?.ret;
    P.menu = null;
    await tick();
    const hit = document.elementFromPoint(x, y);
    if (hit && P.rootEl?.contains(hit)) hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }));
    if (!P.menu) try { (ret?.isConnected && ret !== document.body ? ret : P.rowsEl)?.focus({ preventScroll: true }); } catch {}
  }
  function openItemMenu(e, it) {
    if (P.renaming) P.commitRename();
    if (!P.selected.has(it.rel)) { P.selected = new Set([it.rel]); P.anchorRel = it.rel; }
    const multi = P.selected.size > 1;
    const k = kindOf(it.name);
    const previewable = it.isDir || fkKind(it.name) !== 'other';
    const entries = [];
    if (!multi) {
      // 不可预览类型（zip/exe/未知）不出「预览」——它们的打开动作就是下面的默认应用/定位。
      if (previewable) entries.push({ label: it.isDir ? t('打开') : t('预览'), act: () => P.openItem(it), bold: true });
      if (P.nativeFs && !it.isDir) {
        entries.push({ label: t('用默认应用打开'), act: () => P.doOpen(it) });
        entries.push({ label: t('打开方式…'), act: () => P.doOpenWith(it) });
      }
      if (P.nativeFs) entries.push({ label: t('在文件资源管理器中显示'), act: () => P.doReveal(it) });
      entries.push(...fdPluginOpenEntries(P, it));
      entries.push({ sep: true });
      if (P.serverOps || P.pcFs) {
        entries.push({ label: t('发送给 AI…'), act: () => P.ai.open(it), accent: true });
        if (P.serverOps && pluginOn('share')) entries.push({ label: t('分享链接…'), act: () => P.openShare(it) });
        if (P.serverOps && !it.isDir && k === 'zip') entries.push({ label: t('解压到当前文件夹'), act: () => P.doExtract(it) });
        entries.push({ sep: true });
      }
      if (!it.isDir) entries.push(P.nativeFs ? { label: t('另存为…'), act: () => P.doSaveAs(it) } : { label: t('下载到本地'), act: () => P.doDownload(it) });
    }
    // 多选同样能压（一起打进一个存档）；搜索结果跨目录，服务端只收同一文件夹里的项，搜索态不出
    if (P.canCompress && P.inBrowse) entries.push({ label: multi ? t('压缩 {n} 项…', { n: P.selected.size }) : t('压缩…'), act: P.doCompress });
    entries.push({ label: t('剪切'), hint: 'Ctrl+X', act: () => P.setClipboard('cut') });
    entries.push({ label: t('复制'), hint: 'Ctrl+C', act: () => P.setClipboard('copy') });
    if (!multi) {
      entries.push({ label: t('重命名'), hint: 'F2', act: () => P.startRename(it) });
      entries.push({ label: tc('explorer', '简介'), act: () => P.showInfo(it) });
    }
    entries.push({ sep: true });
    const n = P.selected.size;
    const delLabel = P.nativeFs
      ? (multi ? t('移到回收站（{n} 项）', { n }) : t('移到回收站'))
      : (multi ? t('删除（{n} 项）', { n }) : t('删除'));
    entries.push({ label: delLabel, hint: 'Del', act: () => P.doTrash(), danger: true });
    popupMenu(e, entries);
  }
  function openBlankMenu(e) {
    if (e.target.closest('[data-rel]')) return;
    const entries = [];
    if (P.inBrowse) {
      entries.push({ label: t('新建文件夹'), act: P.newFolder });
      entries.push({ label: t('新建 Markdown 文件'), act: P.newMarkdown });
      entries.push({ label: P.nativeFs ? t('导入文件…') : t('上传文件…'), act: () => P.importFiles(false) });
      entries.push({ label: P.nativeFs ? t('导入文件夹…') : t('上传文件夹…'), act: () => P.importFiles(true) });
      entries.push({ label: t('粘贴'), hint: 'Ctrl+V', act: P.doPaste, disabled: !P.canPaste && !(P.nativeFs && hasNativeFileClipboard()) });
      entries.push({ sep: true });
    }
    entries.push({ label: t('全选'), hint: 'Ctrl+A', act: P.selectAll });
    entries.push({ label: t('刷新'), hint: 'F5', act: P.userRefresh });
    popupMenu(e, entries);
  }
  function openLocMenu(e, loc) {
    const entries = [];
    if (loc.kind === 'native') entries.push({ label: t('在文件资源管理器中显示'), act: () => nativeWorkspaceReveal('', loc.id).catch(() => {}) });
    if (loc.abs && (P.nativeOk || loc.pc || me.kind === 'admin')) entries.push({ label: t('复制地址'), act: () => P.copyText(loc.abs, t('已复制路径')) });
    if (loc.removable) entries.push({ label: t('移除位置'), act: () => P.removeLocation(loc), danger: true });
    if (!entries.length) { e.preventDefault(); return; }
    popupMenu(e, entries);
  }


  return {
    get closeMenu() { return closeMenu; },
    get menuRun() { return menuRun; },
    get openBlankMenu() { return openBlankMenu; },
    get openItemMenu() { return openItemMenu; },
    get openLocMenu() { return openLocMenu; },
    get popupMenu() { return popupMenu; },
    get reMenu() { return reMenu; },
  };
}
