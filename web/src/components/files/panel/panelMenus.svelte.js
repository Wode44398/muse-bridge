// 工作空间（手机 FilesPanel）各处菜单的条目（kit Menu）：位置胶囊、路径条「…」、位置管理、长按 / 行尾「…」、＋、显示方式。
// P 是外壳（FilesPanel.svelte）交出来的状态与动作视图，见那边的 P。
import { t, tc } from '../../../lib/i18n.js';
import { pluginOn } from '../../../lib/state.svelte.js';
import { canPreview } from '../../../lib/fileKinds.js';
import { uiIconSvg } from '../../../lib/fileGrid.js';
import { canAllFiles } from '../../../lib/localfs.js';
import { untitledMdName } from '../../../lib/files-business.js';
import { kindOf, newShareDialog } from '../../../lib/files/common.js';
import { G, locGlyph, locLabel } from './panelLook.js';
import { panelPluginOpenItems } from './panelPluginOpen.js';

export function createPanelMenus(P) {
  const locItems = $derived([
    ...P.cloudLocs.map((l) => ({
      label: l.id === 'ws' ? t('工作空间') : locLabel(l), icon: locGlyph(l), checked: l.id === P.cloudLocId,
      onclick: () => { P.locMenu = null; P.selectCloudLoc(l.id); },
    })),
    ...(P.convAbs ? [{ sep: true }, { label: t('对话文件夹'), detail: P.convName, icon: G.folder, onclick: () => { P.locMenu = null; P.goConv(); } }] : []),
  ]);
  const crumbItems = $derived(Array.from({ length: P.crumbHidden }, (_, k) => P.crumbHidden - 1 - k).map((i) => ({
    label: P.segLabel(P.segs[i], i), icon: G.folder, onclick: () => { P.crumbMenu = null; P.goSeg(i); },
  })).concat([{ sep: true }, { label: P.rootLabel, icon: P.locPill ? locGlyph(P.cloudLoc) : G.folder, onclick: () => { P.crumbMenu = null; P.goRoot(); } }]));
  // 位置管理 / 添加本地位置：原来是居中的警告框，现在是从按钮长出来的菜单（kit Menu），条目与显隐条件不变；
  // 移除位置那一步 doRemove 自己还会再确认一次
  const pcLocItems = $derived.by(() => {
    const loc = P.pcLocMenu?.loc;
    if (!loc) return [];
    return [
      { label: t('在文件资源管理器中显示'), icon: G.reveal, onclick: () => P.revealPcLoc(loc) },
      ...(loc.removable ? [{ sep: true }, { label: t('移除此位置'), icon: G.remove, destructive: true, onclick: () => P.removePcLoc(loc) }] : []),
    ];
  });
  const rootMenuItems = $derived.by(() => {
    const r = P.rootMenu?.root;
    if (!r) return [];
    return [
      ...(r.mode !== 'all' ? [{ label: t('重新选择文件夹'), icon: G.folder, onclick: () => P.doReselect(r) }, { sep: true }] : []),
      { label: t('移除此位置'), icon: G.remove, destructive: true, onclick: () => P.doRemove(r) },
    ];
  });
  const addLocItems = $derived([
    { label: t('选择手机文件夹'), icon: G.folderAdd, disabled: P.localPicking, onclick: P.doPickLocal },
    ...(canAllFiles() ? [{ label: t('整个手机存储'), symbol: 'iphone', disabled: P.localPicking, onclick: P.doPickAll }] : []),
  ]);
  function openAddLoc(el) { P.addLocAnchor = el; P.rootMenu = null; P.addSheet = true; }
  function menuAct(act, it) {
    P.menu = null;
    if (act === 'preview') P.openFile(it);
    else if (act === 'info') P.showInfo(it);
    else if (act === 'rename') P.renameTarget = { item: it, value: it.name };
    else if (act === 'delete') P.doDelete(it);
    else if (act === 'select') P.enterSelect(it.name);
    else if (act === 'ai') { P.ai.item = it; P.ai.view = 'root'; }
    else if (act === 'share') P.doShare(it);
    else if (act === 'sharelink') P.shareDlg = newShareDialog(it);
    else if (act === 'move') P.openMovePicker([it.name], 'move', it.parent ?? P.path);
    else if (act === 'copy') P.openMovePicker([it.name], 'copy', it.parent ?? P.path);
    else if (act === 'download') P.download(P.itemRel(it));
    else if (act === 'openwith') P.doOpenWith(it);
    else if (act === 'open') P.doDesktopOpen(it);
    else if (act === 'reveal') P.doDesktopReveal(it);
    else if (act === 'extract') P.doExtract(it);
    else if (act === 'compress') P.doCompress(it);
  }
  // 长按菜单的条目（kit Menu）：显隐条件与原菜单逐条一致；分组之间用 kit 的分隔线
  const menuItems = $derived.by(() => {
    if (!P.menu) return [];
    const it = P.menu.item, L = [];
    const add = (cond, label, act, more = {}) => { if (cond) L.push({ label, onclick: () => menuAct(act, it), ...more }); };
    const sep = () => { if (L.length && !L[L.length - 1].sep) L.push({ sep: true }); };
    if (!it.isDir && canPreview(it.name)) { add(true, t('预览'), 'preview', { icon: uiIconSvg('preview') }); sep(); }
    if (P.desktopNative) {
      add(true, t('用默认应用打开'), 'open', { symbol: 'arrow.up.forward.app' });
      add(true, t('在文件资源管理器中显示'), 'reveal', { icon: G.reveal });
      sep();
    }
    // 这台电脑的文件服务端看不到，发给 AI＝现读现传（文件夹给 Claude 走设备引用），同手机本地
    if (!P.readonly && !P.guest && (!P.desktopExtra || P.pcLocal)) {
      add(true, t('发送给 AI'), 'ai', { symbol: 'sparkles', tint: '#cb30e0' });
      sep();
      add(!P.desktopNative, t('分享'), 'share', { symbol: 'square.and.arrow.up' });
      // 分享链接由 bridge 服务端铸造，只认 vault 根下的 rel；桌面额外授权位置服务端不认识，必须隐藏
      add(!P.isLocal && !P.desktopExtra && pluginOn('share'), tc('files', '分享链接'), 'sharelink', { symbol: 'link' });
    }
    add(!it.isDir && !P.isLocal, P.desktopNative ? t('另存为…') : t('下载到本地'), 'download', { symbol: 'arrow.down.circle' });
    add(!it.isDir && (P.canOpenWith || P.desktopNative), t('打开方式'), 'openwith', { symbol: 'arrow.up.forward.app' });
    L.push(...panelPluginOpenItems(P, it));
    add(!it.isDir && !P.isLocal && !P.desktopExtra && kindOf(it.name) === 'zip' && !P.readonly, t('解压'), 'extract', { icon: G.zip });
    add(P.canZip, t('压缩…'), 'compress', { icon: G.zip });
    add((!P.isLocal || P.localOps.move) && !P.readonly, t('移动到'), 'move', { icon: G.folder });
    add((!P.isLocal || P.localOps.copy) && !P.readonly, tc('files', '复制'), 'copy', { icon: G.copy });
    add((!P.isLocal || P.localOps.rename) && !P.readonly, tc('files', '重命名'), 'rename', { symbol: 'square.and.pencil' });
    add(true, t('显示简介'), 'info', { symbol: 'info.circle' });
    add(!P.readonly && !(P.desktopNative && P.query), t('多选'), 'select', { icon: G.select });
    if ((!P.isLocal || P.localOps.del) && !P.readonly) {
      sep();
      add(true, P.trashing ? t('移到回收站') : t('删除'), 'delete', { symbol: 'trash', destructive: true });
    }
    return L;
  });
  // 右上「＋」菜单的条目
  const addItems = $derived([
    { label: P.desktopNative ? t('导入文件…') : t('上传文件'), symbol: 'square.and.arrow.up', onclick: P.pickUpload },
    ...(P.desktopNative ? [{ label: t('导入文件夹…'), icon: G.folderAdd, onclick: P.pickDirectoryImport }] : []),
    { label: t('新建文件夹'), icon: G.folderAdd, onclick: () => { P.addOpen = false; P.mkOpen = { value: '' }; } },
    { label: t('新建 Markdown 文件'), symbol: 'square.and.pencil', onclick: () => { P.addOpen = false; P.mdOpen = { value: untitledMdName(P.items.map((x) => x.name)) }; } },
    ...(P.desktopNative ? [{ label: t('添加电脑位置…'), icon: G.pcAdd, onclick: P.addDesktopLocation }] : []),
  ]);
  // 顶栏「…」：显示方式 / 排序 / 隐藏项 / 多选（iOS 文件 app 同款）。同一个排序键再点一下＝反向
  const viewItems = $derived.by(() => {
    if (!P.viewMenu) return [];
    const L = [
      { label: t('列表'), icon: uiIconSvg('list'), checked: P.viewMode === 'list', onclick: () => P.setView('list') },
      { label: t('图标'), icon: uiIconSvg('grid'), checked: P.viewMode === 'grid', onclick: () => P.setView('grid') },
      { label: t('大图标'), icon: uiIconSvg('large'), checked: P.viewMode === 'large', onclick: () => P.setView('large') },
      { sep: true },
    ];
    for (const [k, label] of [['name', t('名称')], ['mtime', t('修改日期')], ['size', t('大小')], ['type', t('种类')]]) {
      const on = P.sortPref.key === k;
      L.push({
        label, checked: on, icon: on ? uiIconSvg(P.sortPref.dir === 1 ? 'sortUp' : 'sortDown') : '',
        detail: on ? (P.sortPref.dir === 1 ? t('升序') : t('降序')) : '', onclick: () => P.setSort(k),
      });
    }
    if (P.hidSwitch) {
      L.push({ sep: true });
      L.push({ label: P.showHidden ? t('收起隐藏项') : t('显示隐藏项'), icon: uiIconSvg(P.showHidden ? 'eyeOff' : 'eye'), detail: t('{n} 项', { n: P.hidTotal }), onclick: P.toggleHidden });
    }
    if (!P.readonly && !(P.desktopNative && P.query) && (P.showFolders.length || P.showFiles.length)) {
      if (!P.hidSwitch) L.push({ sep: true });
      L.push({ label: t('多选'), icon: G.select, onclick: () => P.enterSelect() });
    }
    return L;
  });

  return {
    get addItems() { return addItems; },
    get addLocItems() { return addLocItems; },
    get crumbItems() { return crumbItems; },
    get locItems() { return locItems; },
    get menuItems() { return menuItems; },
    get openAddLoc() { return openAddLoc; },
    get pcLocItems() { return pcLocItems; },
    get rootMenuItems() { return rootMenuItems; },
    get viewItems() { return viewItems; },
  };
}
