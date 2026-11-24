<script>
  // 工作空间 · 桌面版（Electron 壳独占，isNativeDesktop && hasNativeWorkspaceOps 时替换
  // FilesPanel 整页）。形态 = Finder/Explorer 杂交：左侧位置栏 + 工具栏 + 高密度列表/图标
  // 双视图 + 右键菜单 + 全键盘 + 剪贴板（剪切/复制/粘贴）+ 内部拖拽移动 + OS 拖入原生导入。
  // 数据全走桌面主进程 IPC（见 client/desktop/main.cjs workspace 段），不碰 /api/files；
  // 仍走 bridge 服务端的只有三件需要服务端身份的事：发送给 AI、分享链接、解压（都仅 primary）。
  // 视觉沿用工作空间的 iOS 浅色 grouped 语言（蓝 #0088ff / bg #f2f2f7），密度按 PC 标准。
  import { createFlip } from '../lib/flipLayout.js';
  import { onMount, tick, untrack } from 'svelte';
  import { me, ui } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { isPageWindow } from '../lib/windowPage.svelte.js';
  import { api } from '../lib/api.js';
  import { cloudFileUrl, openPreview as openPreviewRaw } from '../lib/preview.svelte.js';
  import { filterFilesByName, makeFileComparator, normalizeFileQuery } from '../lib/files-business.js';
  import { hasNativeWorkspaceDropImport, hasNativeWorkspaceOps, hasNativeWorkspaceRecent, hasPcDropImport, hasPcLocalFs, isNativeDesktop, nativeWorkspaceCopy, nativeWorkspaceCreateFile, nativeWorkspaceInspect, nativeWorkspaceList, nativeWorkspaceLocations, nativeWorkspaceMkdir, nativeWorkspaceMove, nativeWorkspaceRecent, nativeWorkspaceRelease, nativeWorkspaceRename, nativeWorkspaceSearch, nativeWorkspaceThumbnail, nativeWorkspaceTrash, onNativeWorkspaceChanged, serverOnThisMachine } from '../lib/nativeDesktop.js';
  import { onAgentFs, onAgentGoto, reportUi } from '../lib/uiReport.js';
  import { locale, t, tc, tr } from '../lib/i18n.js';
  import { extOf, iconKindOf } from '../lib/fileKinds.js';
  import { cloudThumbable, extBadge, fmtDur, loadSortPref, nameHtml, saveSortPref, uiIconSvg, watchMeta } from '../lib/fileGrid.js';
  import { tip } from './preview/kit/tooltip.js';
  // 文件夹图标：原版资源
  import wsIcon from '../visuals/assets/icons/workspace.png';
  import { fmtSize, kindOf } from '../lib/files/common.js';
  import { AiSend } from '../lib/files/aiSend.svelte.js';
  import { addrFocus, baseName, fileIcon, fmtTime, foldAbs, joinPath, normAbs, relUnder, renameInput, splitAbs, typeLabel } from './files/desktop/fdLook.js';
  import { createFdCrumbs } from './files/desktop/fdCrumbs.svelte.js';
  import { createFdDirSizes } from './files/desktop/fdDirSizes.svelte.js';
  import { createFdView } from './files/desktop/fdView.svelte.js';
  import { createFdOps } from './files/desktop/fdOps.svelte.js';
  import { createFdMenus } from './files/desktop/fdMenus.svelte.js';
  import { createFdDrag } from './files/desktop/fdDrag.svelte.js';
  import { createFdKeys } from './files/desktop/fdKeys.svelte.js';
  import FdPeek from './files/desktop/FdPeek.svelte';
  import FdContextMenu from './files/desktop/FdContextMenu.svelte';
  import FdDialogs from './files/desktop/FdDialogs.svelte';

  const BASE = import.meta.env.BASE_URL;

  // —— 形态与数据通道 ——
  // 本组件原本是「桌面壳独占 + 原生 IPC」的整页工作空间。为了让【工作台侧栏】在电脑上也用上
  // 同一套电脑化 UI（而不是塞一份手机版 FilesPanel 进去），加了两件事：
  //   ① embedded：挂进侧栏的紧凑形态——返回交还宿主、窄了自动收起位置栏、全局键盘只在
  //      面板真正持有焦点时生效（否则在 Claude 会话里按个 Delete 就把文件删了）。
  //   ② 全盘：workspaceRoot（会话工作目录的绝对路径）只是【起点】，不是围栏。左侧位置栏恒在——
  //      桌面壳＝主进程授权的本机位置（Claude / E:\ / D:\ …），网页＝服务端 /api/project/locations
  //      （工作空间 / 主目录 / 各盘符）；起点按绝对路径落进【最深】的那个位置。哪个位置都不含它时
  //      （桌面壳没添加那个盘），补一个以它为根的临时位置，走 bridge 服务端 /api/files?ws=（与手机版
  //      同一条链路、同一套权限）。数据通道按【当前位置】分流：原生位置走 IPC，云端位置走服务端；
  //      原生独占的能力（回收站/资源管理器/系统缩略图/另存为）在云端位置按 caps 自动隐藏，不做半吊子模拟。
  //      地址栏显示完整绝对路径（E: › Vault › Claude › …），点空白处可直接输入路径跳转。
  const {
    embedded = false, theme = '', workspaceRoot = '', rootName = '', initialPath = null, initialOpen = '',
    previewHost = '', onExit = null,
    // home：宿主会话的工作目录（绝对路径），侧栏「通用」里给一行直达；缺省＝workspaceRoot。
    home = '',
    // hostChrome：宿主自带卡片标题行（放大 / 关闭）——工具栏不再摆「返回工作台」，收起只认宿主那颗 ✕，
    // 与工作台里其它卡片同一套手势；↑ 只管上一级。
    hostChrome = false,
  } = $props();
  // P：本页状态与动作的视图（getter / setter 直通这里的 $state），交给拆出去的逻辑模块（files/desktop/*.svelte.js）
  // 与子组件（files/desktop/*.svelte）；模块各自的状态与动作建好后也挂到 P 上（expose），彼此都经 P 互相够得着。
  const P = {
    get BASE() { return BASE; },
    get ICON_SIZES() { return ICON_SIZES; },
    get absOk() { return absOk; },
    get addOpen() { return addOpen; }, set addOpen(v) { addOpen = v; },
    get ai() { return ai; },
    get anchorRel() { return anchorRel; }, set anchorRel(v) { anchorRel = v; },
    get anyDialog() { return anyDialog; },
    get busyLabel() { return busyLabel; }, set busyLabel(v) { busyLabel = v; },
    get canDropImport() { return canDropImport; },
    get canFloat() { return canFloat; },
    get canPaste() { return canPaste; },
    get canUp() { return canUp; },
    get clipboard() { return clipboard; }, set clipboard(v) { clipboard = v; },
    get curAbs() { return curAbs; },
    get curLoc() { return curLoc; },
    get dropOn() { return dropOn; }, set dropOn(v) { dropOn = v; },
    get durOf() { return durOf; },
    get embedded() { return embedded; },
    get enterDir() { return enterDir; },
    get focusRel() { return focusRel; },
    get fsCopy() { return fsCopy; },
    get fsMkdir() { return fsMkdir; },
    get fsMove() { return fsMove; },
    get fsNewFile() { return fsNewFile; },
    get fsRemove() { return fsRemove; },
    get fsRename() { return fsRename; },
    get goAbs() { return goAbs; },
    get goBack() { return goBack; },
    get goFwd() { return goFwd; },
    get goRoot() { return goRoot; },
    get goUp() { return goUp; },
    get iconSize() { return iconSize; }, set iconSize(v) { iconSize = v; },
    get inBrowse() { return inBrowse; },
    get infoDlg() { return infoDlg; }, set infoDlg(v) { infoDlg = v; },
    get items() { return items; }, set items(v) { items = v; },
    get load() { return load; },
    get locationId() { return locationId; }, set locationId(v) { locationId = v; },
    get locations() { return locations; }, set locations(v) { locations = v; },
    get marquee() { return marquee; }, set marquee(v) { marquee = v; },
    get menu() { return menu; }, set menu(v) { menu = v; },
    get metaOf() { return metaOf; },
    get mode() { return mode; }, set mode(v) { mode = v; },
    get nativeFs() { return nativeFs; },
    get nativeOk() { return nativeOk; },
    get navTo() { return navTo; },
    get openPreview() { return openPreview; },
    get parentOf() { return parentOf; },
    get path() { return path; }, set path(v) { path = v; },
    get pcFs() { return pcFs; },
    get pcOk() { return pcOk; },
    get peekOn() { return peekOn; }, set peekOn(v) { peekOn = v; },
    get query() { return query; }, set query(v) { query = v; },
    get recentItems() { return recentItems; }, set recentItems(v) { recentItems = v; },
    get recentSort() { return recentSort; }, set recentSort(v) { recentSort = v; },
    get refresh() { return refresh; },
    get refreshLocations() { return refreshLocations; },
    get renaming() { return renaming; }, set renaming(v) { renaming = v; },
    get resolveAbs() { return resolveAbs; },
    get rootEl() { return rootEl; }, set rootEl(v) { rootEl = v; },
    get rootLabel() { return rootLabel; },
    get rows() { return rows; },
    get rowsEl() { return rowsEl; }, set rowsEl(v) { rowsEl = v; },
    get savePrefs() { return savePrefs; },
    get scopedTo() { return scopedTo; },
    get searchEl() { return searchEl; }, set searchEl(v) { searchEl = v; },
    get searchItems() { return searchItems; }, set searchItems(v) { searchItems = v; },
    get searching() { return searching; },
    get segs() { return segs; },
    get selectAll() { return selectAll; },
    get selectLocation() { return selectLocation; },
    get selected() { return selected; }, set selected(v) { selected = v; },
    get selectedRows() { return selectedRows; },
    get serverOps() { return serverOps; },
    get shareDlg() { return shareDlg; }, set shareDlg(v) { shareDlg = v; },
    get showParentCol() { return showParentCol; },
    get sortDir() { return sortDir; }, set sortDir(v) { sortDir = v; },
    get sortKey() { return sortKey; }, set sortKey(v) { sortKey = v; },
    get sortOpen() { return sortOpen; }, set sortOpen(v) { sortOpen = v; },
    get srvRoot() { return srvRoot; },
    get tbW() { return tbW; }, set tbW(v) { tbW = v; },
    get thumbKey() { return thumbKey; },
    get thumbs() { return thumbs; }, set thumbs(v) { thumbs = v; },
    get toast() { return toast; },
    get userRefresh() { return userRefresh; },
    get view() { return view; }, set view(v) { view = v; },
    get wsRoot() { return wsRoot; },
    get wsRootLocal() { return wsRootLocal; },
    get zipDlg() { return zipDlg; }, set zipDlg(v) { zipDlg = v; },
  };
  const expose = (o) => Object.defineProperties(P, Object.getOwnPropertyDescriptors(o));

  // —— 位置与数据通道 ——
  const nativeOk = isNativeDesktop() && hasNativeWorkspaceOps();
  // 「这台电脑」：桌面客户端连的是远端服务端时，位置栏在服务器的位置之外再列一组本机授权过的文件夹
  // （壳的原生位置，同手机 App 的本地 SAF）——本机直接列目录、本地协议直读预览，字节不经过服务器。
  // 这组位置服务端不认识：分享链接 / 解压 / 零拷贝发给 AI 都没有，发给 AI 改成现读现传（lib/pcLocal.js）。
  const pcOk = !nativeOk && isNativeDesktop() && hasPcLocalFs();
  const nativeAny = nativeOk || pcOk;
  const idLocId = nativeOk ? 'primary' : 'ws';   // 身份文件根所在的位置（桌面壳 primary＝服务端 vaultPath）
  // [{ id, name, kind:'native'|'cloud', root（云端 ws 作用域，''=身份根）, abs（根的绝对路径）, removable, hidden, pc（这台电脑）}]
  // 上次拿到的列表按形态缓存在 window 上：每次换会话侧栏都会重挂，进来即出、不晚一拍冒出侧栏。
  const LOC_LIST = (window.__bridgeFdLocList ||= { native: null, cloud: null, pc: null });
  let locations = $state(nativeOk ? (LOC_LIST.native || []) : [...(LOC_LIST.cloud || []), ...((pcOk && LOC_LIST.pc) || [])]);
  // 有起点时先不认任何位置：位置列表（含各根绝对路径）到齐、按路径落好位再说，免得先闪一下身份根
  let locationId = $state(untrack(() => workspaceRoot) ? '' : idLocId);
  const curLoc = $derived(locations.find((l) => l.id === locationId) || null);
  // 列表没到之前 primary 先按原生算（独立分页老路，首屏不等位置列表）
  const nativeFs = $derived(nativeOk ? (curLoc ? curLoc.kind === 'native' : locationId === 'primary') : pcOk && curLoc?.kind === 'native');
  const pcFs = $derived(pcOk && nativeFs);   // 此刻在「这台电脑」的某个位置里
  // 按绝对路径落位时只在同一边找：服务器和这台电脑的路径长得一样（都是 C:\…），混着找会把会话目录落进本机的盘
  const absKind = $derived(pcOk ? (curLoc?.kind || 'cloud') : '');
  // 云端通道的作用域根（/api/files?ws=）：'' = 身份文件根
  const wsRoot = $derived(!nativeFs && curLoc?.kind === 'cloud' ? curLoc.root : '');
  const scopedTo = (url, root) => (root ? url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(root) : url);
  // 内嵌时预览留在侧栏（host='dock'），独立分页仍是全屏——影子包装，调用点零改动。
  const openPreview = (items, idx, opts = {}) => openPreviewRaw(items, idx, { host: previewHost || (embedded ? 'dock' : 'app'), ...opts });

  // 本组件从头到尾拿 rel（根相对路径）当每一项的【主键】：选中、剪贴板、重命名、拖拽、
  // data-rel 全靠它。原生 IPC 每项自带 rel，云端 /api/files 只给 name（+ 搜索结果的 parent），
  // 不补的话所有 rel 都是 undefined——最直接的后果是 `renaming?.rel === it.rel` 变成
  // undefined===undefined 恒真，整列表当场渲染成一排重命名输入框。
  const withRel = (list, base) => (list || []).map((it) => {
    if (it.rel) return it;
    const dir = it.parent ?? base ?? '';
    return { ...it, rel: dir ? dir + '/' + it.name : it.name };
  });

  // 统一数据入口：上面这两条通道的唯一分叉处，其余代码只认 fs*。
  // fresh：用户主动刷新时让主进程跳过列表缓存（云端通道本来就现拉）
  const fsList = (p, fresh = false) => (nativeFs ? nativeWorkspaceList(p, locationId, fresh ? { fresh: true } : null) : api.files(p, wsRoot));
  const fsMkdir = (p, name) => (nativeFs ? nativeWorkspaceMkdir(p, name, locationId) : api.mkdir(p, name, wsRoot));
  const fsNewFile = (p, name) => (nativeFs ? nativeWorkspaceCreateFile(p, name, '', locationId) : api.newFile(p, name, wsRoot));
  const fsRename = (rel, name) => (nativeFs ? nativeWorkspaceRename(rel, name, locationId) : api.renameFile(rel, name, wsRoot));
  const fsRemove = (rel) => (nativeFs ? nativeWorkspaceTrash(rel, locationId) : api.deleteFile(rel, wsRoot));
  const fsMove = (rel, dest) => (nativeFs ? nativeWorkspaceMove(rel, dest, locationId) : api.moveFile(rel, dest, wsRoot));
  const fsCopy = (rel, dest) => (nativeFs ? nativeWorkspaceCopy(rel, dest, locationId) : api.copyFile(rel, dest, wsRoot));

  // —— 核心状态 ——
  let mode = $state('browse');          // browse | recent
  let path = $state('');
  let items = $state([]);
  let loading = $state(true);
  let truncated = $state(false);
  let recentItems = $state([]);
  let recentLoading = $state(false);
  let query = $state('');
  let searchEl = $state();
  let searchItems = $state([]);
  let searchBusy = $state(false);
  let searchTruncated = $state(false);
  let selected = $state(new Set());     // 以 rel 为键
  let anchorRel = $state('');           // shift 范围选择锚点 & 键盘焦点
  let renaming = $state(null);          // { rel, value }
  let clipboard = $state(null);         // { mode:'cut'|'copy', locationId, rels, id, sys }（sys=已同步写进系统剪贴板）
  let menu = $state(null);              // { x, y, entries }
  let infoDlg = $state(null);
  let shareDlg = $state(null);
  let zipDlg = $state(null);            // 内置压缩选项 { rels, sub, name, format, level, formats, busy, note }
  // 「发送给 AI」的状态与流程（lib/files/aiSend.svelte.js，与手机版共用）；素材怎么备见 aiMaterial / aiTextContent
  const ai = new AiSend({ kindOf, material: (it, direct) => P.aiMaterial(it, direct), readText: (it) => P.aiTextContent(it), toast: (m) => toast(m) });
  let busyLabel = $state('');
  let toastMsg = $state('');
  let dropOn = $state(null);            // null=没在拖 / ''=当前目录 / rel=某个文件夹
  let marquee = $state(null);           // { l, t, w, h } 视口坐标
  let rowsEl = $state();
  let rootEl = $state();                // 根元素：内嵌时它才是 fixed 的包含块（见 popupMenu）
  let thumbs = $state({});              // rel@size → dataUrl（跨目录缓存，位置切换清空）
  let sortKey = $state('name');         // name | mtime | size | type
  let sortDir = $state(1);              // 1 升 / -1 降
  let view = $state('list');            // list | grid
  // 图标视图的图标边长档（Ctrl+滚轮 / 状态栏滑杆逐档切；最小档再往小就回列表）
  const ICON_SIZES = [64, 96, 128, 176, 240];
  let iconSize = $state(96);
  let peekOn = $state(false);           // 右侧预览窗格（Alt+P，默认关）
  let sortOpen = $state(false);
  let addOpen = $state(false);
  let hist = { back: [], fwd: [] };     // 导航历史（不需要响应式渲染，仅按钮禁用态用计数）
  let histN = $state({ back: 0, fwd: 0 });

  {
    // 排序与手机版共用一份（bridge.files.sort，规则同 makeFileComparator）；没记过时沿用本页旧偏好
    const old = { key: 'name', dir: 1 };
    try {
      const saved = JSON.parse(localStorage.getItem('bridge.fd.prefs') || '{}');
      if (saved.view === 'grid' || saved.view === 'list') view = saved.view;
      if (['name', 'mtime', 'size', 'type'].includes(saved.sortKey)) old.key = saved.sortKey;
      if (saved.sortDir === -1) old.dir = -1;
      if (ICON_SIZES.includes(saved.iconSize)) iconSize = saved.iconSize;
      if (saved.peek === true) peekOn = true;
    } catch {}
    const s = loadSortPref(old);
    sortKey = s.key; sortDir = s.dir;
  }
  function savePrefs() {
    try { localStorage.setItem('bridge.fd.prefs', JSON.stringify({ view, sortKey, sortDir, iconSize, peek: peekOn })); } catch {}
    saveSortPref({ key: sortKey, dir: sortDir });
  }

  // 「最近」是本机索引（每个原生位置一份）：人在云端临时位置里点它，落到 primary 的最近。
  const canRecent = $derived(nativeOk && hasNativeWorkspaceRecent());
  // 从桌面拖文件进来：原生走 importPaths（零拷贝拿本机路径），云端走分块上传。
  const canDropImport = $derived(nativeFs ? (pcOk ? hasPcDropImport() : hasNativeWorkspaceDropImport()) : true);
  // 云端作用域的绝对根只有服务端在本机时才是本机路径（系统剪贴板 / 拖出 / 文件夹大小 / 压缩向导都按本机路径干活）；
  // 连远端时那是服务器上的路径，交给壳就成了这台电脑上同名的别的东西
  const wsRootLocal = $derived(Boolean(wsRoot) && serverOnThisMachine());
  // srvRoot = bridge 服务端摸这份文件时用的 ws 作用域（发给 AI / 分享链接 / 解压都要它），null＝摸不到。
  // 云端通道本身就是服务端；原生 primary 就是服务端的身份文件根；其余原生位置（各盘、外加目录）
  // 对 admin 按根的绝对路径交给服务端 ws 作用域（服务端 authorizeProjectPath 再判一次）。
  // 这台电脑的位置（连远端时的原生位置）服务端一律摸不到。
  const srvRoot = $derived(!nativeFs ? wsRoot : !nativeOk ? null : locationId === 'primary' ? '' : (me.kind === 'admin' && curLoc?.abs) || null);
  const serverOps = $derived(srvRoot !== null);
  const locName = (l) => (/^drive-/.test(l?.id || '') ? t('{d} 盘', { d: String(l.name || '').replace(/:$/, '') }) : tr(l?.name || ''));
  const rootLabel = $derived((curLoc && locName(curLoc)) || tr(rootName) || t('工作空间'));
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const searching = $derived(query.trim().length > 0);
  const q = $derived(normalizeFileQuery(query));
  const inBrowse = $derived(mode === 'browse' && !searching);

  // 绝对路径落进哪个位置：取【最深】的那个（D:\Notes\x 落 Claude，不落 E:\）
  // kind：只在服务器（'cloud'）或这台电脑（'native'）那一边找；''＝不限（只有一边的形态）
  function resolveAbs(abs, kind = absKind) {
    let best = null;
    for (const loc of locations) {
      if (!loc.abs || (kind && loc.kind !== kind)) continue;
      const rel = relUnder(loc.abs, abs);
      if (rel == null) continue;
      if (!best || normAbs(loc.abs).length > normAbs(best.loc.abs).length) best = { loc, rel };
    }
    return best;
  }
  // 地址栏给不给看完整路径：桌面壳（本机自己的盘）或 admin；沙箱身份仍是「根名 › 子目录」，绝对路径不出服务器
  const absOk = $derived(Boolean(curLoc?.abs) && (nativeOk || curLoc.kind === 'native' || me.kind === 'admin'));
  // 人在「哪个位置都不含」的临时位置里（桌面壳没添加那个盘）：admin 的服务端 ws 作用域对任意已存在
  // 目录放行，↑ / 地址栏上级段就让临时位置跟着往上漂，而不是在会话目录根上卡死。
  const canFloat = $derived((curLoc?.id === 'session' || /^abs:/.test(curLoc?.id || '')) && me.kind === 'admin');
  const curAbs = $derived(curLoc?.abs ? joinPath(curLoc.abs, path) : '');
  const homeAbs = $derived(home || workspaceRoot);
  const homeLabel = $derived(home ? baseName(home) : (tr(rootName) || baseName(workspaceRoot)));
  const atHome = $derived(Boolean(homeAbs && curAbs && inBrowse && !pcFs && foldAbs(curAbs) === foldAbs(homeAbs)));   // 会话目录在服务器上，这台电脑里同名路径不算
  // 侧栏：桌面壳恒在；网页上只有一个可去处（非 admin 只拿到自己那条）就不摆
  const sideLocs = $derived(locations.filter((l) => !l.hidden));
  const srvSide = $derived(sideLocs.filter((l) => !l.pc));
  const pcSide = $derived(sideLocs.filter((l) => l.pc));
  const showSide = $derived(nativeAny || locations.length > 1);
  // 位置行的选中态：正停在会话目录时让给「会话目录」那一行，侧栏只亮一处
  const locOn = (loc) => locationId === loc.id && (mode === 'browse' || searching) && !atHome;

  // —— 工具栏分档（.fd-tb 实测宽度，不用 @container：容器查询量的是整列宽，扣不掉右上
  // 避让区——窗控 + Claude 顶栏胶囊在内嵌态能吃掉 240px，首版就是因此把钮挤到胶囊底下）——
  //   t0 全量 | t1 收前进、搜索缩成图标 | t2 收后退、视图分段换单钮 | t3 排序并入 ＋ 菜单 | t4 面包屑换到第二行
  let tbEl = $state();
  let tbW = $state(9999);
  const tbTier = $derived(tbW > 620 ? 0 : tbW > 520 ? 1 : tbW > 440 ? 2 : tbW > 372 ? 3 : 4);
  $effect(() => {
    const el = tbEl;
    if (!el) return;
    const ro = new ResizeObserver((ents) => { const w = ents[0]?.contentRect?.width; if (w) tbW = w; });
    ro.observe(el);
    tbW = el.clientWidth || tbW;
    return () => ro.disconnect();
  });
  const toggleView = () => P.setView(view === 'list' ? 'grid' : 'list');
  // 搜索框聚焦态也进 Svelte 状态：它的宽度变化（mini 32px ↔ 展开 150/260px）和分档一样走 FLIP，
  // 不再靠 CSS transition——两套动画叠在一起会互相拆台（transition 起步时布局还是旧宽，FLIP 量到的是假新位）。
  let searchFocus = $state(false);

  const SORTS = [['name', t('名称')], ['mtime', t('修改时间')], ['size', t('大小')], ['type', t('类型')]];

  expose(createFdCrumbs(P));

  // —— 工具栏 FLIP（须放在 crumbHide/crumbSqueeze 声明之后：$effect.pre 在初始化时就同步跑一次）：分档 / 面包屑折叠 / 搜索展开 / 视图切换引起的重排，同一个图形从旧位平移形变过去，
  // 消失的淡出、新出的淡入（lib/flipLayout.js）。pre 在 DOM 变之前拍旧位，post 在 DOM 变之后量新位。 ——
  let toolbarEl = $state();
  const tbFlip = createFlip(() => toolbarEl);
  $effect.pre(() => { tbTier; P.crumbHide; P.crumbSqueeze; view; searchFocus; searching; mode; P.addrOn; untrack(() => tbFlip.snapshot()); });
  $effect(() => { tbTier; P.crumbHide; P.crumbSqueeze; view; searchFocus; searching; mode; P.addrOn; untrack(() => tbFlip.play()); });
  $effect(() => () => tbFlip.destroy());

  expose(createFdDirSizes(P));
  // —— 行数据（排序：文件夹恒在前，组内按列排）——
  // 「最近」视图有独立排序态（天然 mtime 倒序），不吃浏览视图的持久化列排序。
  let recentSort = $state({ key: 'mtime', dir: -1 });
  const effSort = $derived(mode === 'recent' && !searching ? recentSort : { key: sortKey, dir: sortDir });
  const listSource = $derived(searching ? searchItems : mode === 'recent' ? recentItems : items);
  // 比较器与手机版、服务端列表顺序同一套（files-business.js makeFileComparator）：名称自然序（file2 < file10），
  // 类型按「图标大类.扩展名」，文件夹大小没算出来的排在算出来的后面、不随方向翻转。
  const rows = $derived.by(() => [...listSource].sort(makeFileComparator({
    key: effSort.key, dir: effSort.dir, locale: locale(),
    typeOf: (it) => iconKindOf(it.name) + '.' + extOf(it.name),
    dirSize: (it) => P.dirSizeOf(it)?.size ?? null,
  })));
  const showParentCol = $derived(searching || mode === 'recent');
  const cutSet = $derived(clipboard?.mode === 'cut' && clipboard.locationId === locationId ? new Set(clipboard.rels) : new Set());
  const canPaste = $derived(Boolean(clipboard && clipboard.locationId === locationId && inBrowse));
  const listBusy = $derived(searching ? searchBusy : mode === 'recent' ? recentLoading : loading);
  const anyDialog = $derived(Boolean(menu || infoDlg || shareDlg || zipDlg || ai.item || sortOpen || addOpen || P.crumbPop || P.locPop || renaming));

  // —— 导航（含历史）——
  const snapshot = () => ({ locationId, mode, path });
  async function applyNav(next) {
    if (next.locationId !== locationId) thumbs = {};   // 缩略图按 rel 缓存，跨位置同名 rel 会串
    locationId = next.locationId; mode = next.mode; path = next.path;
    query = ''; selected = new Set(); anchorRel = ''; renaming = null;
    if (mode === 'recent') await loadRecent();
    else await load(next.path);
  }
  async function navTo(next) {
    hist.back.push(snapshot()); hist.fwd = [];
    histN = { back: hist.back.length, fwd: 0 };
    await applyNav({ ...snapshot(), ...next });
  }
  async function goBack() {
    const prev = hist.back.pop(); if (!prev) return;
    hist.fwd.push(snapshot()); histN = { back: hist.back.length, fwd: hist.fwd.length };
    await applyNav(prev);
  }
  async function goFwd() {
    const next = hist.fwd.pop(); if (!next) return;
    hist.back.push(snapshot()); histN = { back: hist.back.length, fwd: hist.fwd.length };
    await applyNav(next);
  }
  // 位置根之上的上级：D:\Notes（工作空间位置的根）→ D:\Notes 落进 E 盘位置。从前 ↑ 只认位置内的
  // 相对路径，一回到工作空间 / 会话目录的根就灰掉，明明地址栏上还有父目录。
  const upAbs = $derived.by(() => {
    if (segs.length || !absOk) return '';
    const parts = splitAbs(curLoc.abs);
    if (parts.length < 2) return '';
    const p = parts[parts.length - 2].abs;
    return canFloat || resolveAbs(p) ? p : '';
  });
  const canUp = $derived(inBrowse ? segs.length > 0 || Boolean(upAbs) : true);
  async function goUp() {
    if (!inBrowse) { await navTo({ mode: 'browse' }); return; }
    if (segs.length) await navTo({ path: segs.slice(0, -1).join('/') });
    else if (upAbs) await goAbs(upAbs, { float: canFloat });
  }
  const enterDir = (rel) => navTo({ mode: 'browse', path: rel });
  const goRoot = () => navTo({ mode: 'browse', path: '' });
  // 「最近」是原生位置的索引：人在云端临时位置里时落到 primary 的最近
  const openRecent = () => navTo({ mode: 'recent', locationId: nativeFs ? locationId : 'primary' });
  const selectLocation = (id) => { if (id !== locationId || mode !== 'browse' || path) navTo({ locationId: id, mode: 'browse', path: '' }); };
  // 独立分页＝回主页；内嵌态＝把返回交还宿主（工作台菜单 / 收起侧栏）。
  function goHome() { if (onExit) { onExit(); return; } closePage('files'); }

  // 起点不在任何位置里时补的临时位置：以它为根、走服务端 ws 作用域（与从前侧栏挂会话目录同一条链路）。
  // 不进侧栏「位置」列表——侧栏「通用」那一行（会话目录）就是它的入口。
  function sessionLocFor(abs) {
    let loc = locations.find((l) => l.id === 'session');
    if (loc && foldAbs(loc.abs) === foldAbs(abs)) return loc;
    loc = { id: 'session', name: (foldAbs(abs) === foldAbs(workspaceRoot) && rootName) || baseName(abs), kind: 'cloud', root: abs, abs, removable: false, hidden: true };
    locations = [...locations.filter((l) => l.id !== 'session'), loc];
    return locations.find((l) => l.id === 'session');
  }
  // 临时位置往上漂出来的上级：每个目录一个独立 id（不复用 'session'——导航历史里记的是 位置 id + 相对路径，
  // 换掉同一个 id 的根，后退就会落到错的目录）。同样不进侧栏。
  function floatLocFor(abs) {
    const id = 'abs:' + foldAbs(abs);
    if (!locations.some((l) => l.id === id)) {
      locations = [...locations, { id, name: baseName(abs), kind: 'cloud', root: abs, abs, removable: false, hidden: true }];
    }
    return locations.find((l) => l.id === id);
  }
  // 按绝对路径跳转（地址栏输入 / 位置根之上的上级段 / 侧栏「会话目录」）
  // float：没有位置含它时，让临时位置换成以它为根（见 canFloat）
  // kind：在哪一边找（见 resolveAbs）——会话目录恒在服务器那边；临时位置也只在服务器那边漂
  async function goAbs(abs, { float = false, kind = absKind } = {}) {
    let hit = resolveAbs(abs, kind);
    const onSrv = kind !== 'native';
    if (!hit && onSrv && homeAbs && foldAbs(abs) === foldAbs(homeAbs)) hit = { loc: sessionLocFor(homeAbs), rel: '' };
    if (!hit && onSrv && float && me.kind === 'admin') hit = { loc: floatLocFor(abs), rel: '' };
    if (!hit) {
      toast(nativeOk || kind === 'native' ? t('「{path}」不在已添加的位置里，可在左侧「添加位置…」里授权', { path: abs }) : t('「{path}」不在可访问的位置里', { path: abs }));
      return false;
    }
    await navTo({ locationId: hit.loc.id, mode: 'browse', path: hit.rel });
    return true;
  }
  const goHomeDir = () => { if (!atHome) goAbs(homeAbs, { kind: pcOk ? 'cloud' : '' }); };

  let loadSeq = 0;
  async function load(p = path, { keepSel = false, fresh = false } = {}) {
    const my = ++loadSeq;
    loading = true;
    try {
      const r = await fsList(p, fresh);
      if (my !== loadSeq) return;   // 已被更新的导航替代（跨位置连点时旧结果别落进新位置）
      path = r.path ?? p;
      items = withRel(r.items, path); truncated = Boolean(r.truncated);
      hydrateEager(items);
      if (keepSel) {
        const rels = new Set(items.map((x) => x.rel));
        selected = new Set([...selected].filter((x) => rels.has(x)));
      }
    } catch (e) {
      if (my !== loadSeq) return;
      items = []; truncated = false; toast(t('加载失败：{reason}', { reason: tr(e.body?.error || e.message || '') }));
    }
    loading = false;
  }
  async function loadRecent() {
    if (!canRecent) { recentItems = []; recentLoading = false; return; }
    recentLoading = true;
    try { const r = await nativeWorkspaceRecent(locationId, 80); recentItems = withRel(r.items, ''); hydrateEager(recentItems); }
    catch { recentItems = []; }
    recentLoading = false;
  }
  const refresh = (fresh = false) => (mode === 'recent' && !searching ? loadRecent() : load(path, { keepSel: true, fresh: fresh === true }));
  // 用户主动刷新（F5 / 右键「刷新」）：文件夹大小丢缓存重算，列表也跳过主进程缓存现读盘。
  const userRefresh = () => { P.requestDirSizes({ fresh: true }); return refresh(true); };

  // 各原生位置根的绝对路径：位置列表故意不带 path（renderer 只拿不透明 id 做写操作），
  // 地址栏要显示完整路径、起点要按路径落位，就向主进程 inspect 一次根目录（与「简介」同一个口子），按 id 缓存。
  const LOC_ABS = (window.__bridgeFdLocAbs ||= new Map());
  async function nativeLocAbs(id) {
    if (LOC_ABS.has(id)) return LOC_ABS.get(id);
    try {
      const abs = (await nativeWorkspaceInspect('', id))?.absolutePath || '';
      if (abs) LOC_ABS.set(id, abs);
      return abs;
    } catch { return ''; }
  }
  async function refreshLocations() {
    let list = null;
    if (nativeOk) {
      try {
        const raw = (await nativeWorkspaceLocations()) || [];
        const abs = await Promise.all(raw.map((l) => nativeLocAbs(l.id)));
        list = raw.map((l, i) => ({ ...l, kind: 'native', abs: abs[i] || '' }));
        LOC_LIST.native = list;
      } catch {}
    } else {
      // 与手机版「电脑位置」同一份：admin＝工作空间 + 主目录 + 各盘符，其余身份只有自己那一条。
      // Dimensio Projects 是「新建项目」的捷径，在文件管理器里它只是主目录下的一个文件夹。
      // 这台电脑那组（pcOk）与服务器那份并行拉，各自失败互不拖累。
      const [srv, pc] = await Promise.all([
        api.projectLocations().catch(() => null),
        pcOk ? nativeWorkspaceLocations().then(async (raw) => {
          const abs = await Promise.all((raw || []).map((l) => nativeLocAbs(l.id)));
          return (raw || []).map((l, i) => ({ ...l, kind: 'native', pc: true, abs: abs[i] || '' }));
        }).catch(() => null) : null,
      ]);
      list = (srv?.locations || []).filter((l) => l && l.id && l.path && l.id !== 'dimensio')
        .map((l) => ({ id: l.id, name: l.name, kind: 'cloud', root: l.id === 'ws' ? '' : l.path, abs: l.path, removable: false }));
      if (!list.length) list = [{ id: 'ws', name: t('工作空间'), kind: 'cloud', root: '', abs: '', removable: false }];
      LOC_LIST.cloud = list;
      if (pc) LOC_LIST.pc = pc;
      if (pcOk) list = [...list, ...(LOC_LIST.pc || [])];
    }
    if (!list) return;
    // 临时位置（会话目录 + 往上漂出来的上级）不在服务端列表里，刷新时原样留着
    locations = [...list, ...locations.filter((l) => l.id === 'session' || /^abs:/.test(l.id))];
    // 当前位置没了（被移除 / 那个盘拔掉了）：回身份根。locationId 为空＝起点还在落位，不动它
    if (locationId && !locations.some((l) => l.id === locationId)) { locationId = idLocId; mode = 'browse'; await load(''); }
  }
  // 起点落位：没有绝对路径起点（独立分页 / 工作空间就在身份根里）＝身份根 + 相对路径，位置列表后台到；
  // 有起点＝等位置（含各根绝对路径）到齐，落进最深的那个位置；哪个都不含它就补一个临时位置。
  async function startAt(p0) {
    if (!workspaceRoot) {
      refreshLocations();
      path = p0;
      return load(p0);
    }
    await refreshLocations();
    const hit = resolveAbs(joinPath(workspaceRoot, p0), pcOk ? 'cloud' : '');   // 会话目录在服务器上
    const loc = hit ? hit.loc : sessionLocFor(workspaceRoot);
    const rel = hit ? hit.rel : p0;
    locationId = loc.id; path = rel;
    return load(rel);
  }

  onMount(() => {
    // initialPath：内嵌宿主指定的起始目录（工作台侧栏按会话工作空间挂载时用，相对 workspaceRoot）；
    // 没传才吃 ui.filesPath 那份一次性预置（独立分页老路）。
    const p0 = initialPath ?? ui.filesPath ?? '';
    if (initialPath == null) ui.filesPath = null;
    const first = startAt(p0);
    // initialOpen：列表就位后自动打开指定文件的预览（产物卡「在工作区里打开」走它）。
    if (initialOpen) Promise.resolve(first).then(() => {
      const it = rows.find((f) => !f.isDir && f.name === initialOpen);
      if (it) P.openItem(it);
    }).catch(() => {});
    if (!nativeAny) return;
    let browseTimer = 0, recentTimer = 0, searchTimer = 0;
    // 壳按目录推 { locationId, type, path, dir }：dir＝变化落在哪个目录；type='resync'＝系统通知缓冲区溢出，
    // 壳把有人看过的目录各推一条「整体作废」。整盘位置上后台写盘（编译、同步盘）能一秒几十条，
    // 只认跟眼前这一屏有关的，免得每条都重列当前目录、重算文件夹大小、重跑搜索。
    const under = (dir, base) => !base || dir === base || dir.startsWith(base + '/');
    const parentOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
    const off = onNativeWorkspaceChanged((event) => {
      if (!nativeFs || String(event?.locationId || 'primary') !== locationId) return;
      const dir = String(event?.dir || '');
      const resync = event?.type === 'resync';
      if (mode === 'recent' && !searching) {
        clearTimeout(recentTimer); recentTimer = setTimeout(loadRecent, 600);
        return;
      }
      if (searching) { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(q), 300); return; }
      // 文件夹大小：当前目录或它下面任意一层变了，列表里某个文件夹的大小才可能变
      if (P.canDirSize && under(dir, path)) P.requestDirSizesSoon();
      // 列表本身：当前目录里增删改，或直接子目录里有变化（那一行的修改时间跟着变）；resync 无条件重列
      if (!resync && dir !== path && !(dir && parentOf(dir) === path)) return;
      clearTimeout(browseTimer);
      browseTimer = setTimeout(() => load(path, { keepSel: true }), 34);
    });
    return () => { clearTimeout(browseTimer); clearTimeout(recentTimer); clearTimeout(searchTimer); off?.(); };
  });
  // 换位置 / 组件卸载：告诉壳这个位置的目录监听可以先淘汰（老壳没这个方法就跳过）
  $effect(() => {
    const id = locationId;
    if (!nativeFs || !id) return;
    return () => nativeWorkspaceRelease(id);
  });

  // 云端通道：改由 agent 的 fs 事件驱动刷新（原生通道那条 watcher 在这儿不存在），
  // 顺带上报当前目录，让 agent 的 workspace.view 知道用户在看哪儿——与手机版同一套。
  $effect(() => {
    if (nativeFs) return;
    reportUi({ files: { path, ws: wsRoot, query: q || '' } });
  });
  $effect(() => {
    if (nativeFs) return;
    let fsTimer = 0;
    const offFs = onAgentFs(() => { clearTimeout(fsTimer); fsTimer = setTimeout(() => load(path, { keepSel: true }), 350); });
    // goto 的路径相对【身份文件根】：人在别的位置里时先换回身份根所在的位置
    const offGoto = onAgentGoto((rootRel) => navTo({ locationId: idLocId, mode: 'browse', path: rootRel }));
    return () => { clearTimeout(fsTimer); offFs(); offGoto(); };
  });

  // —— 搜索（原生索引，防抖 + 序号守卫）——
  let searchSeq = 0;
  async function runSearch(needle) {
    const seq = ++searchSeq;
    if (!needle) { searchItems = []; searchBusy = false; searchTruncated = false; return; }
    // 云端没有服务端全局索引：就地过滤当前目录（与手机版工作空间同一套语义）。
    if (!nativeFs) {
      searchItems = withRel(filterFilesByName(items, needle), path);
      searchTruncated = false; searchBusy = false;
      return;
    }
    searchBusy = true;
    try {
      const r = await nativeWorkspaceSearch(needle, locationId);
      if (seq !== searchSeq) return;
      searchItems = withRel(r?.items, ''); searchTruncated = Boolean(r?.truncated);
      hydrateEager(searchItems);
    } catch { if (seq === searchSeq) searchItems = []; }
    if (seq === searchSeq) searchBusy = false;
  }
  $effect(() => {
    const needle = q;
    if (!needle) { searchSeq++; searchItems = []; searchBusy = false; searchTruncated = false; return; }
    searchBusy = true;
    const timer = setTimeout(() => runSearch(needle), 160);
    return () => clearTimeout(timer);
  });

  // —— 缩略图 / 原生图标（IntersectionObserver 懒取；Windows 给所有类型返回关联图标）——
  let io = null;
  onMount(() => {
    io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const p = en.target.__fd;
        if (p) loadThumb(p);
      }
    }, { rootMargin: '160px' });
    return () => { io?.disconnect(); io = null; };
  });
  // 列表 48；图标视图按图标边长 × 设备像素比取 160 / 320 / 512 三档（云端 512 走 640 的 grid 档）
  const thumbSize = () => {
    if (view !== 'grid') return 48;
    const px = iconSize * Math.min(3, globalThis.devicePixelRatio || 1);
    return px <= 160 ? 160 : px <= 320 ? 320 : 512;
  };
  const thumbKey = (rel) => rel + '@' + thumbSize();
  async function loadThumb(p) {
    const key = thumbKey(p.rel);
    if (p.isDir || thumbs[key] !== undefined) return;
    thumbs[key] = '';   // 占位防重复请求
    // 云端：图片与视频两档都有服务端缩略图；图标视图另有 PDF / Office 首页、音频封面（失败 404，见 thumbBad 退回线稿图标）。
    // 其余类型别去请求一个必然 404 的地址。
    if (!nativeFs) {
      const grid = view === 'grid';
      if (cloudThumbable(p.name || p.rel, grid)) thumbs[key] = cloudFileUrl(p.rel, { thumb: !grid || thumbSize() < 512, grid: grid && thumbSize() >= 512, mt: p.mtime, ws: wsRoot });
      return;
    }
    try {
      const r = await nativeWorkspaceThumbnail(p.rel, thumbSize(), p.locationId);
      if (r?.dataUrl) thumbs[key] = r.dataUrl;
    } catch {}
  }
  // 首屏主动水合（Explorer 式：可见图标即时出，不等滚动）；滚动后的长尾仍靠 IO 懒取。
  function hydrateEager(list) {
    for (const it of list.filter((x) => !x.isDir).slice(0, 40)) loadThumb({ rel: it.rel, name: it.name, mtime: it.mtime, isDir: false, locationId });
  }
  // 视图切换（list 48px ↔ grid 160px 两档缓存独立）后，给当前列表按新尺寸补一轮。
  // untrack：hydrateEager 内部读写 thumbs，不能让它成为本效果的依赖（否则每张图回来都重跑）。
  $effect(() => { view; iconSize; const list = listSource; untrack(() => hydrateEager(list)); });
  // 缩略图加载失败（云端 404 / 解码失败）：这一档记成空串，格子退回类型线稿图标，也不再重试
  function thumbBad(rel) { thumbs[thumbKey(rel)] = ''; }
  function thumbWatch(node, p) {
    node.__fd = p;
    const arm = () => { if (io && !p.isDir && thumbs[thumbKey(p.rel)] === undefined) io.observe(node); };
    arm();
    return {
      update(np) { node.__fd = p = np; io?.unobserve(node); arm(); },
      destroy() { io?.unobserve(node); },
    };
  }

  // —— 选择 ——
  function clickRow(e, it) {
    if (renaming) return;
    const idx = rows.findIndex((r) => r.rel === it.rel);
    if (e.shiftKey && anchorRel) {
      const a = rows.findIndex((r) => r.rel === anchorRel);
      if (a >= 0 && idx >= 0) {
        const [lo, hi] = a < idx ? [a, idx] : [idx, a];
        const next = e.ctrlKey || e.metaKey ? new Set(selected) : new Set();
        for (let i = lo; i <= hi; i++) next.add(rows[i].rel);
        selected = next;
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(it.rel) ? next.delete(it.rel) : next.add(it.rel);
      selected = next; anchorRel = it.rel;
      return;
    }
    selected = new Set([it.rel]); anchorRel = it.rel;
  }
  function selectAll() { selected = new Set(rows.map((r) => r.rel)); }
  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const selectedRows = () => rows.filter((r) => selected.has(r.rel));

  function focusRel(rel) {
    anchorRel = rel; selected = new Set([rel]);
    tick().then(() => {
      try { rowsEl?.querySelector(`[data-rel="${CSS.escape(rel)}"]`)?.scrollIntoView({ block: 'nearest' }); } catch {}
    });
  }

  // —— 打开 ——
  expose(createFdView(P));
  expose(createFdOps(P));
  expose(createFdMenus(P));
  expose(createFdDrag(P));
  expose(createFdKeys(P));
  // 补充元数据（/api/files/meta：图片宽高、视频时长、文件夹项目数）——服务端摸得到这个目录时才有（srvRoot）；换目录清空
  let meta = $state({});
  let metaKey = '';
  const metaOn = $derived(inBrowse && serverOps && !loading && items.length > 0);
  $effect(() => {
    const on = metaOn, p = path, root = srvRoot, key = locationId + '\x1f' + (root ?? '') + '\x1f' + p;
    return untrack(() => {
      if (key !== metaKey) { metaKey = key; meta = {}; }
      if (!on) return;
      return watchMeta(() => api.filesMeta(p, root), (m) => { if (metaKey === key) meta = { ...meta, ...m }; });
    });
  });
  const metaOf = (it) => (inBrowse && it && parentOf(it.rel) === path ? meta[it.name] || null : null);
  const durOf = (it) => { const d = metaOf(it)?.dur; return d > 0 ? fmtDur(d) : ''; };
  // 图标视图名字下面那行（图标够大才出）：文件夹＝项目数，图片＝像素尺寸，其余＝大小
  function tileSub(it) {
    if (iconSize < 128) return '';
    const m = metaOf(it);
    if (it.isDir) return m?.n != null ? t('{n} 项', { n: m.n }) : '';
    if (m?.w > 0 && m?.h > 0) return `${m.w} × ${m.h}`;
    return fmtSize(it.size);
  }
  const statusText = $derived.by(() => {
    const parts = [t('{n} 项', { n: rows.length })];
    if (selected.size) parts.push(t('已选 {n} 项', { n: selected.size }));
    if (searching && searchTruncated) parts.push(t('结果超过 200 条，已截断'));
    else if (!searching && mode === 'browse' && truncated) parts.push(t('目录超过 2000 项，仅显示前 2000'));
    return parts.join(' · ');
  });

  let toastTimer = null;
  function toast(m) { toastMsg = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastMsg = ''), 2400); }
</script>


<svelte:window onkeydown={P.onKey} />

<div class="fd-root" class:embedded class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} bind:this={rootEl} role="presentation" oncontextmenu={(e) => e.preventDefault()}>
  <!-- 工具栏：外层 .fd-toolbar 吃右上避让（--fd-avoid-r＝窗控，内嵌时宿主可另给），
       内层 .fd-tb 才是排版容器，宽度用 ResizeObserver 量出来分档（见 tbTier）。 -->
  {#snippet locIcon(loc)}
    {#if loc.pc && loc.id === 'primary'}
      <!-- 这台电脑的默认文件夹（连远端时 primary 不是服务器的库，是客户端自己的工作区目录） -->
      <svg class="side-ic accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/></svg>
    {:else if loc.id === 'primary' || loc.id === 'ws'}
      <svg class="side-ic accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9h12v-9"/></svg>
    {:else if loc.id === 'home'}
      <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.4" r="3.4"/><path d="M5.2 19.5c.9-3.4 3.5-5.2 6.8-5.2s5.9 1.8 6.8 5.2"/></svg>
    {:else if /^drive-/.test(loc.id) || /^[A-Za-z]:\\?$/.test(loc.name || '')}
      <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6.5" width="17" height="11" rx="2.6"/><path d="M7.2 13.6h.01M10.6 13.6h6.2"/></svg>
    {:else}
      <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>
    {/if}
  {/snippet}
  {#snippet homeIcon()}
    <svg class="side-ic accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5h13A2.5 2.5 0 0 1 21 7.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.6 3.4V17h-.9A2.5 2.5 0 0 1 3 14.5v-7A2.5 2.5 0 0 1 5.5 5Z"/><path d="M8 10.2h8M8 13h5"/></svg>
  {/snippet}

  {#snippet crumbs()}
    <!-- 位置下拉：只在位置栏因窄列收起时露出（见样式表 .tb-drop.locs），窄侧栏里一样能换盘 -->
    {#if showSide && P.addrEdit === null}
      <div class="tb-drop locs">
        <button class="tb-btn" aria-label={tc('explorer', '位置')} use:tip={tc('explorer', '位置')} onclick={() => { P.locPop = !P.locPop; P.crumbPop = false; sortOpen = false; addOpen = false; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6.5" width="17" height="11" rx="2.6"/><path d="M7.2 13.6h.01M10.6 13.6h6.2"/></svg>
        </button>
        {#if P.locPop}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (P.locPop = false)}></button>
          <div class="pop left locs-pop">
            {#if homeAbs}
              <button class="pop-mi" class:on={atHome} title={homeAbs} onclick={() => { P.locPop = false; goHomeDir(); }}>{@render homeIcon()}<span class="pm-nm">{homeLabel}</span></button>
            {/if}
            {#if canRecent}
              <button class="pop-mi" class:on={mode === 'recent' && !searching} onclick={() => { P.locPop = false; openRecent(); }}>
                <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2"/></svg><span class="pm-nm">{t('最近')}</span>
              </button>
            {/if}
            {#if homeAbs || canRecent}<div class="pop-sep"></div>{/if}
            {#each srvSide as loc (loc.id)}
              <button class="pop-mi" class:on={locOn(loc)} title={loc.abs || undefined} onclick={() => { P.locPop = false; selectLocation(loc.id); }}>{@render locIcon(loc)}<span class="pm-nm">{locName(loc)}</span></button>
            {/each}
            {#if pcOk}
              <div class="pop-sep"></div>
              <div class="pop-cap">{t('这台电脑')}</div>
              {#each pcSide as loc (loc.id)}
                <button class="pop-mi" class:on={locOn(loc)} title={loc.abs || undefined} onclick={() => { P.locPop = false; selectLocation(loc.id); }}>{@render locIcon(loc)}<span class="pm-nm">{locName(loc)}</span></button>
              {/each}
            {/if}
            {#if nativeAny}
              <div class="pop-sep"></div>
              <button class="pop-mi" onclick={() => { P.locPop = false; P.addLocation(); }}>{pcOk ? t('添加这台电脑上的文件夹…') : t('添加位置…')}</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if P.crumbHide > 0 && P.addrEdit === null && !(mode === 'recent' && !searching)}
      <div class="tb-drop crumb-more" data-flip="cmore">
        <button class="tb-btn ell" aria-label={t('展开上级目录')} use:tip={t('展开上级目录')} onclick={() => { P.crumbPop = !P.crumbPop; P.locPop = false; sortOpen = false; addOpen = false; }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg>
        </button>
        {#if P.crumbPop}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (P.crumbPop = false)}></button>
          <div class="pop left">
            {#each P.crumbItems.slice(0, P.crumbHide) as it, i (i)}
              <button class="pop-mi" style:padding-left="{9 + i * 10}px" disabled={!P.crumbOk(i)} onclick={() => P.gotoCrumb(i)}>
                <svg class="pm-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/></svg>{it}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <!-- 地址栏：点段跳转；点空白处 / Ctrl+L 换成可编辑的完整路径（Enter 跳转、Esc 放弃），右键复制路径 -->
    <div class="fd-crumbs" class:squeeze={P.crumbSqueeze} class:editing={P.addrEdit !== null} class:addr={P.canAddr}
      role="presentation" bind:this={P.crumbsEl} data-flip="crumbs" data-flip-morph="x"
      title={P.canAddr && P.addrEdit === null ? curAbs : undefined} onclick={P.addrClick} oncontextmenu={P.addrMenu}>
      <div class="fd-crumbs-in" data-flip-inner>
        {#if P.addrEdit !== null}
          <input class="addr-in" bind:value={P.addrEdit} use:addrFocus onkeydown={P.addrKey} onblur={() => (P.addrEdit = null)}
            spellcheck="false" autocomplete="off" aria-label={t('地址')} />
        {:else if mode === 'recent' && !searching}
          <span class="crumb cur" data-flip="crumb-recent" data-flip-anchor="left">{t('最近')}</span>
        {:else}
          {#each P.crumbItems as it, i (i)}
            {#if i >= P.crumbHide}
              {#if i > P.crumbHide}<svg class="crumb-sep" data-flip="csep-{i}" data-flip-anchor="left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 6 6 6-6 6"/></svg>{/if}
              {#if i === P.crumbItems.length - 1}
                <span class="crumb cur" data-flip="crumb-{i}" data-flip-anchor="left">{it}</span>
              {:else if !P.crumbOk(i)}
                <span class="crumb off" data-flip="crumb-{i}" data-flip-anchor="left">{it}</span>
              {:else}
                <button class="crumb" data-flip="crumb-{i}" data-flip-anchor="left" class:dropin={dropOn === 'crumb:' + P.crumbRel(i)}
                  onclick={() => P.gotoCrumb(i)} ondragover={(e) => P.dragOverCrumb(e, P.crumbRel(i))} ondrop={P.onDrop}>{it}</button>
              {/if}
            {/if}
          {/each}
          {#if searching}<span class="crumb-note" data-flip="cnote" data-flip-anchor="left">{t('搜索「{query}」', { query: query.trim() })}</span>{/if}
        {/if}
      </div>
    </div>
  {/snippet}

  {#snippet sortItems()}
    {#each SORTS as [k2, lb] (k2)}
      <button class="pop-mi" onclick={() => P.setSort(k2)}>
        <span class="pm-check">{#if effSort.key === k2}✓{/if}</span>{lb}
        {#if effSort.key === k2}<span class="pm-dir">{effSort.dir === 1 ? t('升序') : t('降序')}</span>{/if}
      </button>
    {/each}
  {/snippet}

  <div class="fd-toolbar" bind:this={toolbarEl}>
    <div class="fd-tb" class:t1={tbTier >= 1} class:t2={tbTier >= 2} class:t3={tbTier >= 3} class:t4={tbTier >= 4} bind:this={tbEl}>
      {#if !hostChrome && (embedded || !isPageWindow())}
        <button class="tb-btn" data-flip="home" use:tip={embedded ? t('返回工作台') : t('返回主页')} onclick={goHome}>
          {#if embedded}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9h12v-9"/></svg>
          {/if}
        </button>
      {/if}
      {#if tbTier < 2}
        {#if !hostChrome && (embedded || !isPageWindow())}<span class="tb-gap"></span>{/if}
        <button class="tb-btn" data-flip="back" aria-label={t('后退')} use:tip={{ label: t('后退'), kbd: 'Alt+←' }} disabled={!histN.back} onclick={goBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>
        </button>
      {/if}
      {#if tbTier < 1}
        <button class="tb-btn" data-flip="fwd" aria-label={t('前进')} use:tip={{ label: t('前进'), kbd: 'Alt+→' }} disabled={!histN.fwd} onclick={goFwd}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>
        </button>
      {/if}
      <button class="tb-btn" data-flip="up" aria-label={t('上一级')} use:tip={{ label: t('上一级'), kbd: 'Backspace' }} disabled={!canUp} onclick={goUp}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18V7"/><path d="m7 11 5-5 5 5"/></svg>
      </button>

      {#if tbTier < 4}{@render crumbs()}{:else}<span class="tb-fill"></span>{/if}

      <div class="fd-search" class:active={searching} class:mini={tbTier >= 1} class:focus={searchFocus} data-flip="search" data-flip-morph="x"
        onfocusin={() => (searchFocus = true)} onfocusout={() => (searchFocus = false)}>
        <div class="fd-search-in" data-flip-inner>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
          <input bind:this={searchEl} bind:value={query} placeholder={t('搜索 {name}', { name: rootLabel })} autocomplete="off" spellcheck="false" />
          {#if query}<button class="sx" aria-label={t('清除搜索')} onclick={() => { query = ''; searchEl?.focus(); }}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button>{/if}
        </div>
      </div>

      {#if tbTier < 2}
        <div class="tb-seg" data-flip="seg" role="group" aria-label={t('视图')}>
          <button class="seg" data-flip="view-list" class:on={view === 'list'} aria-pressed={view === 'list'} aria-label={tc('explorer', '列表视图')} use:tip={tc('explorer', '列表视图')} onclick={() => P.setView('list')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" stroke-width="2.6"/></svg>
          </button>
          <button class="seg" data-flip="view-grid" class:on={view === 'grid'} aria-pressed={view === 'grid'} aria-label={tc('explorer', '图标视图')} use:tip={tc('explorer', '图标视图')} onclick={() => P.setView('grid')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>
          </button>
        </div>
        {#if P.peekFits}
          <button class="tb-btn peek" data-flip="peek" class:on={peekOn} aria-pressed={peekOn} use:tip={{ label: t('预览窗格'), kbd: 'Alt+P' }} onclick={P.togglePeek}>{@html uiIconSvg('pane', 1.8)}</button>
        {/if}
      {:else}
        <button class="tb-btn" data-flip={view === 'list' ? 'view-list' : 'view-grid'} use:tip={view === 'list' ? tc('explorer', '切换为图标视图') : tc('explorer', '切换为列表视图')} onclick={toggleView}>
          {#if view === 'list'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" stroke-width="2.6"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>
          {/if}
        </button>
      {/if}

      {#if tbTier < 3}
        <div class="tb-drop sort" data-flip="sort">
          <button class="tb-btn" aria-label={t('排序')} use:tip={t('排序')} onclick={() => { sortOpen = !sortOpen; addOpen = false; P.crumbPop = false; }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5v14M7 19l-3-3M7 19l3-3"/><path d="M17 19V5M17 5l-3 3M17 5l3 3"/></svg>
          </button>
          {#if sortOpen}
            <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (sortOpen = false)}></button>
            <div class="pop">{@render sortItems()}</div>
          {/if}
        </div>
      {/if}

      <div class="tb-drop add" data-flip="add">
        <button class="tb-btn" aria-label={t('新建或导入')} use:tip={t('新建 / 导入')} onclick={() => { addOpen = !addOpen; sortOpen = false; P.crumbPop = false; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        {#if addOpen}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (addOpen = false)}></button>
          <div class="pop">
            <button class="pop-mi" disabled={!inBrowse} onclick={() => { addOpen = false; P.newFolder(); }}>{t('新建文件夹')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => { addOpen = false; P.newMarkdown(); }}>{t('新建 Markdown 文件')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => P.importFiles(false)}>{nativeFs ? t('导入文件…') : t('上传文件…')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => P.importFiles(true)}>{nativeFs ? t('导入文件夹…') : t('上传文件夹…')}</button>
            {#if nativeFs}
              <div class="pop-sep"></div>
              <button class="pop-mi" onclick={P.addLocation}>{t('添加电脑位置…')}</button>
            {/if}
            {#if tbTier >= 3}
              <div class="pop-sep"></div>
              <div class="pop-cap">{t('排序')}</div>
              {@render sortItems()}
            {/if}
          </div>
        {/if}
      </div>
    </div>
    {#if tbTier >= 4}
      <div class="fd-tb2">{@render crumbs()}</div>
    {/if}
  </div>

  <div class="fd-body">
    <!-- 侧栏：通用（会话目录 / 最近）+ 位置。无论挂在哪个会话、起点在哪个盘，都是同一份
         全盘位置（桌面壳＝本机授权位置，网页＝服务端给的工作空间/主目录/各盘）。
         内嵌变窄时由 @container 自动收起，收起后入口挪到地址栏左侧的位置下拉。 -->
    {#if showSide}
    <div class="fd-side">
      <div class="fd-side-in">
        {#if homeAbs || canRecent}
          <div class="side-sec">{tc('explorer', '通用')}</div>
        {/if}
        {#if homeAbs}
          <button class="side-row" class:on={atHome} title={t('本会话的工作目录：{path}', { path: homeAbs })}
            onclick={goHomeDir} oncontextmenu={(e) => e.preventDefault()}>
            {@render homeIcon()}
            <span class="side-nm">{homeLabel}</span>
          </button>
        {/if}
        {#if canRecent}
          <button class="side-row" class:on={mode === 'recent' && !searching}
            onclick={openRecent} oncontextmenu={(e) => e.preventDefault()}>
            <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2"/></svg>
            <span class="side-nm">{t('最近')}</span>
          </button>
        {/if}
        <!-- 连远端服务端时分两组：服务器上的位置 / 这台电脑上授权过的文件夹（本机直读，不经服务器） -->
        <div class="side-sec">{pcOk ? t('服务器') : tc('explorer', '位置')}</div>
        {#each srvSide as loc (loc.id)}
          <button class="side-row" class:on={locOn(loc)} title={nativeOk || me.kind === 'admin' ? loc.abs || undefined : undefined}
            onclick={() => selectLocation(loc.id)} oncontextmenu={(e) => P.openLocMenu(e, loc)}>
            {@render locIcon(loc)}
            <span class="side-nm">{locName(loc)}</span>
          </button>
        {/each}
        {#if pcOk}
          <div class="side-sec">{t('这台电脑')}</div>
          {#each pcSide as loc (loc.id)}
            <button class="side-row" class:on={locOn(loc)} title={loc.abs || undefined}
              onclick={() => selectLocation(loc.id)} oncontextmenu={(e) => P.openLocMenu(e, loc)}>
              {@render locIcon(loc)}
              <span class="side-nm">{locName(loc)}</span>
            </button>
          {/each}
        {/if}
        {#if nativeAny}
          <button class="side-row add" onclick={P.addLocation}>
            <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>
            <span class="side-nm">{t('添加位置…')}</span>
          </button>
        {/if}
      </div>
    </div>
    {/if}

    <!-- 主区 -->
    <div class="fd-main">
      {#if view === 'list'}
        <div class="fd-colhead">
          <button class="ch name" onclick={() => P.setSort('name')}>{t('名称')}{#if effSort.key === 'name'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
          {#if showParentCol}
            <span class="ch parent">{t('位置')}</span>
          {/if}
          <button class="ch mtime" onclick={() => P.setSort('mtime')}>{t('修改时间')}{#if effSort.key === 'mtime'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
          {#if !showParentCol}
            <button class="ch type" onclick={() => P.setSort('type')}>{t('类型')}{#if effSort.key === 'type'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
          {/if}
          <button class="ch size" onclick={() => P.setSort('size')}>{t('大小')}{#if effSort.key === 'size'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
        </div>
      {/if}

      <!-- 列表整块是一个 Tab 停靠点（同资源管理器：Tab 进来，方向键在行间移动选中）；内嵌态的全局快捷键靠「焦点是否在本面板内」判作用域，
           点一下列表即取得焦点。键盘焦点的提示画在锚点行上（data-anchor），不给整块画框 -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="fd-rows" class:grid={view === 'grid'} class:dropin={dropOn === ''} style:--tile={view === 'grid' ? iconSize + 'px' : null}
        bind:this={rowsEl} role="presentation" tabindex="0"
        onpointerdown={P.paneDown} oncontextmenu={P.openBlankMenu}
        ondragover={P.dragOverPane} ondragleave={P.dragLeavePane} ondrop={P.onDrop}>
        {#if listBusy && !rows.length}
          <div class="fd-empty"><span class="spin"></span>{searching ? t('正在搜索…') : t('正在读取…')}</div>
        {:else if !rows.length}
          <div class="fd-empty">
            <div class="big">{searching ? '🔍' : '📂'}</div>
            {searching ? t('未找到相关文件') : mode === 'recent' ? t('还没有最近文件') : t('这个文件夹是空的')}
            {#if inBrowse && canDropImport}<small>{t('把文件拖进窗口即可导入')}</small>{/if}
          </div>
        {:else if view === 'list'}
          {#each rows as it (it.rel)}
            <div class="row" data-rel={it.rel} data-anchor={it.rel === anchorRel || undefined} role="button" tabindex="-1"
              class:sel={selected.has(it.rel)} class:cut={cutSet.has(it.rel)} class:dropin={dropOn === it.rel} class:flash={P.flashRel === it.rel}
              draggable="true"
              ondragstart={(e) => P.rowDragStart(e, it)} ondragend={P.rowDragEnd}
              ondragover={(e) => P.dragOverDir(e, it)} ondrop={P.onDrop}
              onclick={(e) => clickRow(e, it)} ondblclick={() => { if (!renaming) P.openItem(it); }}
              oncontextmenu={(e) => P.openItemMenu(e, it)}>
              <span class="cell name">
                <span class="ric" use:thumbWatch={{ rel: it.rel, name: it.name, mtime: it.mtime, isDir: it.isDir, locationId }}>
                  {#if it.isDir}
                    <img class="ric-dir" src={wsIcon} alt="" draggable="false" />
                  {:else if thumbs[thumbKey(it.rel)]}
                    <img class="ric-img" src={thumbs[thumbKey(it.rel)]} alt="" draggable="false" decoding="async" onerror={() => thumbBad(it.rel)} />
                  {:else}
                    <span class="ric-ph">{@html fileIcon(it.name)}</span>
                  {/if}
                </span>
                {#if renaming?.rel === it.rel}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <input class="rn-input" use:renameInput bind:value={renaming.value}
                    onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') P.commitRename(); else if (e.key === 'Escape') renaming = null; }}
                    onblur={P.commitRename} onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()} />
                {:else}
                  <span class="nm" title={it.name}>{it.name}</span>
                  {#if it.linkType}<span class="lk">{it.linkType === 'external-link' ? t('外部链接') : t('链接')}</span>{/if}
                {/if}
              </span>
              {#if showParentCol}
                <span class="cell parent" title={it.parent || rootLabel}>{it.parent || rootLabel}</span>
              {/if}
              <span class="cell mtime">{fmtTime(it.mtime)}</span>
              {#if !showParentCol}
                <span class="cell type">{typeLabel(it)}</span>
              {/if}
              <span class="cell size" class:pend={it.isDir && P.canDirSize && !it.linkType && !P.dirSizeOf(it)?.done} title={it.isDir ? P.dirSizeTitle(it) : undefined}>{it.isDir ? P.dirSizeLabel(it) : fmtSize(it.size)}</span>
            </div>
          {/each}
        {:else}
          {#each rows as it (it.rel)}
            <div class="tile" data-rel={it.rel} data-anchor={it.rel === anchorRel || undefined} role="button" tabindex="-1"
              class:sel={selected.has(it.rel)} class:cut={cutSet.has(it.rel)} class:dropin={dropOn === it.rel} class:flash={P.flashRel === it.rel}
              draggable="true"
              ondragstart={(e) => P.rowDragStart(e, it)} ondragend={P.rowDragEnd}
              ondragover={(e) => P.dragOverDir(e, it)} ondrop={P.onDrop}
              onclick={(e) => clickRow(e, it)} ondblclick={() => { if (!renaming) P.openItem(it); }}
              oncontextmenu={(e) => P.openItemMenu(e, it)}>
              <span class="tic" use:thumbWatch={{ rel: it.rel, name: it.name, mtime: it.mtime, isDir: it.isDir, locationId }}>
                {#if it.isDir}
                  <img class="tic-dir" src={wsIcon} alt="" draggable="false" />
                {:else if thumbs[thumbKey(it.rel)]}
                  <span class="tic-media">
                    <img class="tic-img" src={thumbs[thumbKey(it.rel)]} alt="" draggable="false" decoding="async" onerror={() => thumbBad(it.rel)} />
                    {#if durOf(it)}<b class="tic-dur">{durOf(it)}</b>{/if}
                  </span>
                {:else}
                  <span class="tic-ph">{@html fileIcon(it.name)}{#if extBadge(it.name)}<b class="tic-ext">{extBadge(it.name)}</b>{/if}</span>
                {/if}
              </span>
              {#if renaming?.rel === it.rel}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <input class="rn-input tile-rn" use:renameInput bind:value={renaming.value}
                  onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') P.commitRename(); else if (e.key === 'Escape') renaming = null; }}
                  onblur={P.commitRename} onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()} />
              {:else}
                <span class="tnm" title={it.name}>{@html nameHtml(it.name)}</span>
                {#if tileSub(it)}<span class="tsub">{tileSub(it)}</span>{/if}
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      <div class="fd-status">
        <span>{statusText}</span>
        <span class="st-fill"></span>
        {#if busyLabel}<span class="st-busy"><span class="spin sm"></span>{busyLabel}</span>{/if}
        {#if listBusy && rows.length}<span class="st-busy"><span class="spin sm"></span></span>{/if}
        {#if view === 'grid'}
          <input class="st-zoom" type="range" min="0" max={ICON_SIZES.length - 1} step="1" value={ICON_SIZES.indexOf(iconSize)}
            oninput={(e) => P.setIconSize(ICON_SIZES[Number(e.currentTarget.value)])} use:tip={{ label: t('图标大小'), kbd: t('Ctrl+= / Ctrl+− / Ctrl+滚轮') }} />
        {/if}
      </div>
    </div>

    <FdPeek {P} />
  </div>

  <FdContextMenu {P} />

  <!-- 框选矩形 -->
  {#if marquee}
    <div class="marquee" style="left:{marquee.l}px; top:{marquee.t}px; width:{marquee.w}px; height:{marquee.h}px"></div>
  {/if}

  <FdDialogs {P} />

  {#if toastMsg}<div class="toast">{toastMsg}</div>{/if}

  {#if !nativeFs}
    <input class="hidden-input" bind:this={P.fileUploadInput} type="file" multiple onchange={P.onUploadPick} />
    <input class="hidden-input" bind:this={P.dirUploadInput} type="file" webkitdirectory multiple onchange={P.onUploadPick} />
  {/if}
</div>

<style>
  /* 桌面工作空间：跟随全站明暗（data-theme），Explorer 级密度；宿主有自己的明暗档时（dimensio）
     经 theme 属性强制 .th-light / .th-dark，与旁边的对话区保持同一档。
     暗色是默认（与 :root 一致：data-theme 缺省即暗）——Claude 底 #1f1f1e 上的 iOS 暗色语言；
     浅色沿用工作空间家族的 iOS 浅色语言（蓝 #0071e3、#f2f2f7）。所有颜色只走下列令牌，别再就地写死。 */
  .fd-root {
    --blue: #4f9dff; --blue-soft: rgba(79, 157, 255, .16); --blue-sel: rgba(79, 157, 255, .2); --blue-line: rgba(79, 157, 255, .55); --red: #ff6961;
    --bg: #1f1f1e; --panel: #262625; --bar: rgba(31, 31, 30, .94); --side-bg: rgba(35, 35, 34, .7);
    --ink: #ececea; --ink2: rgba(235, 235, 240, .62); --ink3: rgba(235, 235, 240, .4);
    --sep: rgba(255, 255, 255, .09); --hover: rgba(255, 255, 255, .07); --row-alt: rgba(255, 255, 255, .03);
    --seg-bg: rgba(255, 255, 255, .08); --field-bg: #1b1b1a; --pop-bg: rgba(44, 44, 42, .98); --dlg-bg: #2a2a29;
    --mask: rgba(0, 0, 0, .5); --pop-shadow: 0 10px 34px rgba(0, 0, 0, .55); --ctx-shadow: 0 12px 44px rgba(0, 0, 0, .6);
    --pop-hover: rgba(255, 255, 255, .08);
    /* 右上避让：整页形态只让系统窗控；内嵌形态听宿主的 --dock-avoid-r（Claude 工作台不给：它在桌面壳下
       把首行让给窗控当标题栏带、子树 --wco-right 归零，故内嵌时恒为 0） */
    --fd-avoid-r: var(--wco-right, 0px);
    color-scheme: dark;
    position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column;
    background: var(--bg); color: var(--ink);
    font: 400 13px/1.45 -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
    -webkit-font-smoothing: antialiased; user-select: none; overscroll-behavior: contain;
    /* 容器查询锚点：内嵌进工作台侧栏时"宽窄"由这一列说了算，跟视口无关
       （侧栏可以被拖到 320px，视口却仍是 2560）。 */
    container-type: inline-size;
  }
  :global(html[data-theme='light']) .fd-root:not(.th-dark), .fd-root.th-light {
    --blue: #0071e3; --blue-soft: rgba(0, 113, 227, .1); --blue-sel: rgba(0, 113, 227, .16); --blue-line: rgba(0, 113, 227, .5); --red: #ff383c;
    --bg: #f2f2f7; --panel: #fff; --bar: rgba(248, 248, 250, .92); --side-bg: rgba(242, 242, 246, .8);
    --ink: #1d1d1f; --ink2: rgba(60, 60, 67, .62); --ink3: rgba(60, 60, 67, .4);
    --sep: rgba(60, 60, 67, .1); --hover: rgba(120, 120, 128, .09); --row-alt: rgba(120, 120, 128, .045);
    --seg-bg: rgba(120, 120, 128, .1); --field-bg: #fff; --pop-bg: rgba(252, 252, 253, .97); --dlg-bg: #fbfbfd;
    --mask: rgba(20, 20, 24, .3); --pop-shadow: 0 10px 34px rgba(0, 0, 0, .16); --ctx-shadow: 0 12px 44px rgba(0, 0, 0, .2);
    --pop-hover: rgba(120, 120, 128, .12);
    color-scheme: light;
  }
  /* 内嵌形态（工作台侧栏）：让开状态栏、密度略收、去掉整页才需要的留白；
     右上听宿主给的 --dock-avoid-r，没给就只让窗控（Claude 工作台子树里窗控占宽已归零） */
  .fd-root.embedded { z-index: 1; --fd-avoid-r: var(--dock-avoid-r, var(--wco-right, 0px)); }
  .fd-root.embedded .fd-toolbar { padding-top: calc(var(--sat) + 8px); }
  /* 侧栏在窄【列】里先让位——正文列表才是主角。
     和文件末尾那条 @media (max-width:680px) 是两个轴：那条管「整窗很窄」，
     这条管「窗很宽但这一列被拖窄了」（内嵌进工作台侧栏的常态）。 */
  /* 窄列收侧栏 / 面包屑边距的 @container 规则见文件末尾（@container 不加特异性，
     写在这里会被后文 .fd-side{display:flex} 按源顺序盖掉——首版就是这么失效的）。 */
  /* 窄列自适应（@container 分档）统一放在本 <style> 末尾——@container 不加特异性，
     写在前面会被后文同名规则按源顺序盖掉（首版就是这么失效的）。 */
  .hidden-input { display: none; }
  .fd-rows:focus { outline: none; }   /* 整块不画焦点框：键盘焦点画在锚点行上；还没有锚点时才给整块描一圈内框 */
  .fd-rows:focus-visible [data-anchor] { box-shadow: inset 0 0 0 1.5px var(--blue); }
  .fd-rows:focus-visible:not(:has([data-anchor])) { box-shadow: inset 0 0 0 2px var(--blue-line); }

  /* —— 工具栏 —— */
  .fd-toolbar { position: relative; box-sizing: border-box; flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; padding-right: calc(10px + var(--fd-avoid-r)); background: var(--bar); border-bottom: 1px solid var(--sep); }
  /* FLIP 进行中：裁掉溢出（多出的第二行随高度动画渐显、离场幽灵不越界）。平时不裁——下拉菜单是 absolute 挂在里面的 */
  .fd-toolbar:global(.flip-anim) { overflow: hidden; }
  .fd-toolbar:global(.flip-anim) .pop-scrim { display: none; }
  .fd-tb, .fd-tb2 { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .fd-tb2 .fd-crumbs { margin: 0; }
  .tb-fill { flex: 1 1 auto; }
  .tb-gap { width: 6px; }
  .tb-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 8px; background: none; color: var(--ink); cursor: pointer; }
  .tb-btn svg { width: 17px; height: 17px; }
  .tb-btn:hover:not(:disabled) { background: var(--hover); }
  .tb-btn:disabled { color: var(--ink3); cursor: default; }
  .fd-crumbs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; margin: 0 8px; padding: 0 6px; height: 32px; background: var(--panel); border: 1px solid var(--sep); border-radius: 9px; overflow: hidden; white-space: nowrap; }
  /* 内层不收缩：外层量 scrollWidth 才量得出溢出（折叠判据）；FLIP 时它承担反向缩放，段落文字不变形 */
  .fd-crumbs-in { display: flex; align-items: center; gap: 1px; flex: 0 0 auto; max-width: 100%; }
  .fd-crumbs.squeeze .fd-crumbs-in { flex: 0 1 auto; min-width: 0; }
  .crumb { flex: 0 0 auto; height: 28px; line-height: 28px; min-width: 28px; border: 0; background: none; padding: 0 8px; border-radius: 6px; font-size: 13px; color: var(--ink2); cursor: pointer; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crumb:hover { background: var(--hover); color: var(--ink); }
  .crumb.cur { color: var(--ink); font-weight: 600; cursor: default; }
  /* 头部全收进「…」了还放不下：这时才让当前目录那段省略号（先折叠、后压缩） */
  .fd-crumbs.squeeze .crumb.cur { flex: 0 1 auto; min-width: 56px; }
  .crumb.cur:hover { background: none; }
  .crumb.dropin { background: var(--blue-soft); color: var(--blue); outline: 1.5px solid var(--blue); }
  .crumb-sep { width: 13px; height: 13px; color: var(--ink2); flex: 0 0 auto; }
  .crumb-more { display: flex; align-items: center; margin-left: 4px; }
  /* 位置栏之上的上级段（含它的位置没添加）：只显示、不可点 */
  .crumb.off { color: var(--ink3); cursor: default; }
  .crumb.off:hover { background: none; color: var(--ink3); }
  /* 地址栏：段与段之间的空白可点（进入编辑），编辑态整框换成输入框 */
  .fd-crumbs.addr { cursor: text; }
  .fd-crumbs.editing { border-color: var(--blue); box-shadow: 0 0 0 2px var(--blue-soft); }
  .fd-crumbs.editing .fd-crumbs-in { flex: 1 1 auto; min-width: 0; }
  .addr-in { flex: 1 1 auto; width: 0; min-width: 0; height: 26px; padding: 0 4px; border: 0; outline: 0; background: none; font: inherit; font-size: 13px; color: var(--ink); }
  /* 位置下拉：位置栏收起（窄列 / 窄窗）时才露出，与文件末尾 @container / @media 收侧栏同一档 */
  .tb-drop.locs { display: none; align-items: center; }
  .locs-pop { min-width: 200px; max-width: 280px; max-height: min(60vh, 420px); overflow: auto; }
  .locs-pop .pop-mi { gap: 8px; }
  .locs-pop .pop-mi.on { color: var(--blue); font-weight: 600; }
  .pm-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tb-btn.ell { width: 26px; height: 26px; border-radius: 7px; color: var(--ink2); }
  .tb-btn.ell svg { width: 15px; height: 15px; }
  .pop.left { left: 0; right: auto; }
  .pop-cap { padding: 5px 9px 2px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--ink2); }
  .pm-ic { width: 14px; height: 14px; flex: 0 0 auto; color: var(--ink2); margin-right: 4px; }
  .crumb-note { margin-left: 8px; font-size: 12px; color: var(--blue); background: var(--blue-soft); padding: 2px 8px; border-radius: 20px; }
  .fd-search { flex: 0 0 auto; display: flex; align-items: center; width: 200px; height: 32px; padding: 0 9px; background: var(--panel); border: 1px solid var(--sep); border-radius: 9px; overflow: hidden; transition: border-color .15s; }
  .fd-search-in { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; height: 100%; }
  /* 宽度变化（聚焦展开 / mini 档）全走 FLIP，不写 transition */
  .fd-search.focus { width: 260px; border-color: var(--blue-line); }
  .fd-search.active { border-color: var(--blue-line); }
  .fd-search svg { width: 14px; height: 14px; color: var(--ink3); flex: 0 0 auto; }
  .fd-search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 13px; color: var(--ink); transition: opacity .16s ease; }
  .fd-search .sx { display: grid; place-items: center; width: 18px; height: 18px; border: 0; border-radius: 50%; background: rgba(120, 120, 128, .18); color: var(--ink2); cursor: pointer; padding: 0; }
  .fd-search .sx svg { width: 9px; height: 9px; color: inherit; }
  /* mini（t1 起）：只剩一枚图标，聚焦/有词时再展开 */
  .fd-search.mini { width: 32px; padding: 0 8px; }
  .fd-search.mini input { opacity: 0; width: 0; }
  .fd-search.mini.focus, .fd-search.mini.active { width: 150px; padding: 0 9px; }
  .fd-search.mini.focus input, .fd-search.mini.active input { opacity: 1; width: auto; }
  .fd-tb.t3 .fd-search.mini.focus, .fd-tb.t3 .fd-search.mini.active { width: 120px; }
  .tb-seg { display: flex; margin-left: 6px; background: var(--seg-bg); border-radius: 8px; padding: 2px; }
  .seg { display: grid; place-items: center; width: 32px; height: 26px; border: 0; border-radius: 6px; background: none; color: var(--ink2); cursor: pointer; }
  .seg svg { width: 15px; height: 15px; }
  .seg.on { background: var(--panel); color: var(--blue); box-shadow: 0 1px 2px rgba(0, 0, 0, .1); }
  .tb-drop { position: relative; }
  .pop-scrim { position: fixed; inset: 0; z-index: 60; border: 0; background: transparent; cursor: default; }
  .pop { position: absolute; top: 36px; right: 0; z-index: 61; min-width: 168px; padding: 4px; background: var(--pop-bg); border: 1px solid var(--sep); border-radius: 12px; box-shadow: var(--pop-shadow); }
  .pop-mi { display: flex; align-items: center; gap: 4px; width: 100%; min-height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: none; text-align: left; font-size: 14px; color: var(--ink); cursor: pointer; }
  .pop-mi:hover:not(:disabled) { background: var(--pop-hover); }
  .pop-mi:disabled { color: var(--ink3); cursor: default; }
  .pop-sep { height: 1px; margin: 4px 8px; background: var(--sep); }
  .pm-check { width: 16px; flex: 0 0 auto; font-size: 12px; }
  .pm-dir { margin-left: auto; font-size: 11px; opacity: .68; }

  /* —— 主体 —— */
  .fd-body { flex: 1; display: flex; min-height: 0; }
  /* 位置栏＝抽屉：外层 flex-basis 208↔0 走过渡，内层固定 208px 贴住右缘——收起时内容随左缘一起退出画面，
     拉宽时从左边缘抽出来（不是原地压扁、也不是一帧出现）。 */
  .fd-side { flex: 0 0 208px; display: flex; flex-direction: column; align-items: flex-end; min-width: 0; background: var(--side-bg); border-right: 1px solid var(--sep); overflow: hidden auto;
    transition: flex-basis var(--mo-base) var(--ea-std), border-right-width var(--mo-base) var(--ea-std); }
  .fd-side-in { flex: 1 0 auto; width: 208px; box-sizing: border-box; display: flex; flex-direction: column; padding: 8px 8px 10px; }
  .side-sec { padding: 10px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--ink2); }
  .side-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px; background: none; text-align: left; font-size: 13px; color: var(--ink); cursor: pointer; }
  .side-row:hover { background: var(--hover); }
  .side-row.on { background: var(--blue-soft); color: var(--blue); font-weight: 600; }
  .side-row.add { color: var(--ink2); }
  .side-ic { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ink2); }
  .side-row.on .side-ic { color: var(--blue); }
  .side-ic.accent { color: var(--blue); }
  .side-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .fd-main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--panel); }

  /* 列表表头 */
  .fd-colhead { flex: 0 0 auto; display: flex; align-items: center; padding: 0 12px; height: 30px; border-bottom: 1px solid var(--sep); background: var(--panel); transition: padding var(--mo-base) var(--ea-std); }
  .ch { display: flex; align-items: center; gap: 4px; border: 0; background: none; padding: 0 8px; height: 100%; font-size: 12px; color: var(--ink2); cursor: pointer; text-align: left; white-space: nowrap; }
  /* 列的显隐/宽度档位（下文 @container）走过渡而不是一帧切换：flex-basis 收到 0 + padding 归零 + 淡出，
     名称列（flex:1）随布局逐帧回填。overflow:hidden 让收窄途中的文字被裁而不是撑开。 */
  .ch, .cell.parent, .cell.mtime, .cell.type, .cell.size { overflow: hidden; transition: flex-basis var(--mo-base) var(--ea-std), padding var(--mo-base) var(--ea-std), margin var(--mo-base) var(--ea-std), opacity var(--mo-quick) var(--ea-fade); }
  .ch:hover { color: var(--ink); }
  span.ch { cursor: default; }
  .ch-dir { font-size: 8px; color: var(--blue); }
  .ch.name { flex: 1 1 auto; min-width: 0; margin-left: 28px; }
  .ch.parent { flex: 0 0 220px; }
  .ch.mtime { flex: 0 0 150px; }
  .ch.type { flex: 0 0 110px; }
  .ch.size { flex: 0 0 86px; justify-content: flex-end; }

  /* 行 */
  .fd-rows { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 18px; position: relative; }
  .fd-rows.dropin { box-shadow: inset 0 0 0 2px var(--blue); border-radius: 2px; }
  .row { display: flex; align-items: center; padding: 0 6px; height: 30px; border-radius: 7px; cursor: default; }
  .row:nth-child(even):not(.sel) { background: var(--row-alt); }
  .row:hover:not(.sel) { background: var(--hover); }
  .row.sel { background: var(--blue-sel); }
  .row.cut, .tile.cut { opacity: .5; }
  .row.dropin, .tile.dropin { outline: 2px solid var(--blue); outline-offset: -2px; background: var(--blue-soft); }
  .cell { min-width: 0; }
  .cell.name { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; overflow: hidden; }
  .cell.parent { flex: 0 0 220px; padding: 0 8px; font-size: 12px; color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell.mtime { flex: 0 0 150px; padding: 0 8px; font-size: 12px; color: var(--ink2); white-space: nowrap; }
  .cell.type { flex: 0 0 110px; padding: 0 8px; font-size: 12px; color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell.size { flex: 0 0 86px; padding: 0 8px; font-size: 12px; color: var(--ink2); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cell.size.pend { color: var(--ink3); }
  .ric { position: relative; width: 20px; height: 20px; flex: 0 0 auto; display: grid; place-items: center; }
  .ric-dir { width: 20px; height: 20px; object-fit: contain; }
  .ric-img { width: 20px; height: 20px; object-fit: cover; border-radius: 4px; }
  .ric-ph { width: 18px; height: 18px; display: block; color: var(--ink2); }
  .ric-ph :global(svg) { width: 100%; height: 100%; display: block; }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .lk { flex: 0 0 auto; margin-left: 2px; padding: 1px 6px; border-radius: 20px; background: rgba(120, 120, 128, .14); font-size: 10px; color: var(--ink2); }
  .rn-input { flex: 1; min-width: 60px; height: 24px; padding: 0 6px; border: 1.5px solid var(--blue); border-radius: 6px; background: var(--field-bg); font: inherit; font-size: 13px; color: var(--ink); outline: none; user-select: text; }

  /* 图标视图 */
  /* 图标边长 --tile 由图标档给（64 / 96 / 128 / 176 / 240），列宽跟着它走；换档是一帧切换，不做宽高动画 */
  .fd-rows.grid { --tile: 96px; display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(var(--tile) + 30px), 1fr)); align-content: start; gap: 2px; padding: 10px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 10px 6px 8px; border-radius: 10px; cursor: default; content-visibility: auto; contain-intrinsic-size: auto calc(var(--tile) + 64px); }
  .tile:hover:not(.sel) { background: var(--hover); }
  .tile.sel { background: var(--blue-sel); }
  .tic { width: var(--tile); height: var(--tile); display: grid; place-items: center; }
  .tic-dir { width: 94%; height: 94%; object-fit: contain; }
  /* 缩略图按原比例放进方框（桌面文件管理器的习惯），时长角标贴着图本身的右下角 */
  .tic-media { position: relative; display: block; max-width: 100%; max-height: 100%; line-height: 0; }
  .tic-img { display: block; max-width: var(--tile); max-height: var(--tile); border-radius: 6px; box-shadow: 0 0 0 .5px var(--sep), 0 1px 4px rgba(0, 0, 0, .14); }
  .tic-dur { position: absolute; right: 4px; bottom: 4px; padding: 1px 5px; border-radius: 4px; background: rgba(0, 0, 0, .58); color: #fff; font-size: 10.5px; font-weight: 600; line-height: 15px; font-variant-numeric: tabular-nums; pointer-events: none; }
  .tic-ph { display: flex; flex-direction: column; align-items: center; gap: calc(var(--tile) * .05); color: var(--ink2); }
  .tic-ph :global(svg) { width: calc(var(--tile) * .5); height: calc(var(--tile) * .5); display: block; }
  .tic-ext { font-size: 10px; font-weight: 600; letter-spacing: .03em; line-height: 1; color: var(--ink3); }
  .tnm { max-width: 100%; font-size: 12px; line-height: 1.3; text-align: center; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .tsub { margin-top: -3px; max-width: 100%; font-size: 11px; line-height: 1.3; color: var(--ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  /* 关掉查看器后描一圈蓝：刚才看到的是哪一项（选中底色照旧，不被动画盖掉） */
  .row.flash, .tile.flash { animation: fd-flash 1.3s var(--ea-fade); }
  @keyframes fd-flash { 0%, 55% { box-shadow: inset 0 0 0 2px var(--blue); } 100% { box-shadow: inset 0 0 0 2px transparent; } }
  .tile-rn { width: 100%; text-align: center; }

  /* 状态栏 */
  .fd-status { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; height: 26px; padding: 0 14px; border-top: 1px solid var(--sep); background: var(--bar); font-size: 11.5px; color: var(--ink2); }
  .st-fill { flex: 1; }
  .st-busy { display: flex; align-items: center; gap: 6px; color: var(--blue); }
  .st-zoom { width: 96px; height: 18px; margin: 0; accent-color: var(--blue); cursor: pointer; }
  .tb-btn.on { background: var(--seg-bg); color: var(--blue); }
  .tb-btn.peek :global(svg) { width: 17px; height: 17px; display: block; }

  /* 按钮提示（kit/tooltip.js）在查看器外挂到 body：要压过本页（z 40）与内嵌宿主 */
  :global(body > .vw-tip) { z-index: 3600; }
  @media (prefers-reduced-motion: reduce) {
    .row.flash, .tile.flash { animation: none; box-shadow: inset 0 0 0 2px var(--blue); }
  }
  .spin { width: 14px; height: 14px; border: 2px solid var(--blue-soft); border-top-color: var(--blue); border-radius: 50%; animation: fd-spin .8s linear infinite; }
  .spin.sm { width: 11px; height: 11px; border-width: 1.5px; }
  @keyframes fd-spin { to { transform: rotate(360deg); } }

  /* 空态 */
  .fd-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 90px 20px; color: var(--ink2); font-size: 13px; }
  .fd-rows.grid .fd-empty { grid-column: 1 / -1; }
  .fd-empty .big { font-size: 40px; }
  .fd-empty small { font-size: 12px; color: var(--ink3); }

  /* 框选 */
  .marquee { position: fixed; z-index: 70; border: 1px solid var(--blue-line); background: var(--blue-soft); pointer-events: none; }

  @keyframes fd-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
  /* toast */
  .toast { position: fixed; left: 50%; bottom: 44px; z-index: 120; transform: translateX(-50%); padding: 9px 18px; border-radius: 22px; background: rgba(28, 28, 32, .92); color: #fff; font-size: 13px; box-shadow: 0 8px 26px rgba(0, 0, 0, .3); animation: fd-rise .18s ease; white-space: nowrap; max-width: 86%; overflow: hidden; text-overflow: ellipsis; }

  /* 英文界面（html[lang=en]，lib/i18n.js 设置）：英文比中文长，只在英文下放宽/加省略号，中文外观不动 */
  :global(html[lang='en']) .cell.mtime { text-overflow: ellipsis; }                 /* “Sep 28, 2025, 3:04 PM” 在窄列档会被硬裁 */
  :global(html[lang='en']) .fd-status > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }   /* 状态栏一行放不下时省略，不撑出第二行 */
  /* 排序 / 新建下拉挂在 30px 宽的 .tb-drop 里，宽度按 min-content 算：英文「Date modified … Descending」
     会在单词间折成两行。不折行后弹层按最宽一项撑开（right:0，向左长）；面包屑弹层（.left）装的是文件夹名，不动 */
  :global(html[lang='en']) .pop:not(.left) .pop-mi { white-space: nowrap; }

  /* 窄窗：侧栏退场（同 @container 那条，走抽屉过渡） */
  @media (max-width: 680px) {
    .fd-side { flex-basis: 0; border-right-width: 0; }
    .tb-drop.locs { display: flex; }
  }

  /* ── 窄列（工作台侧栏常态 ≈ 300–640px）自适应 ─────────────────────────────
     【必须留在文件末尾】：@container 不加特异性，同名规则按源顺序后者胜，放前面会被
     上文的 .fd-search{width:200px} / .fd-crumbs{min-width:0} / .tb-seg{display:flex} 盖掉。
     列表：固定列 150+110+86 一加就把名称列挤成零宽、行图标裁成一条缝——名称是正文，
     其它列按宽度逐级让位：先收类型，再收大小，只留修改时间。
     工具栏不在这里分档：它按 .fd-tb 的实测宽度走 JS tier（tbTier），因为 @container
     量的是整列宽、扣不掉右上避让区（窗控 + Claude 顶栏胶囊）。这里只保证子项不收缩。 */
  .tb-btn, .tb-seg, .tb-drop, .fd-search { flex: 0 0 auto; }
  .fd-crumbs { min-width: 64px; }
  @container (max-width: 700px) {
    .fd-side { flex-basis: 0; border-right-width: 0; }
    .tb-drop.locs { display: flex; }
  }
  @container (max-width: 640px) {
    .ch.type, .cell.type { flex-basis: 0; padding-left: 0; padding-right: 0; opacity: 0; min-width: 0; pointer-events: none; }
    .ch.mtime, .cell.mtime { flex-basis: 118px; }
    .ch.parent, .cell.parent { flex-basis: 150px; }
    .ch.size, .cell.size { flex-basis: 72px; }
  }
  @container (max-width: 560px) {
    .fd-crumbs { margin: 0 4px; }
  }
  @container (max-width: 500px) {
    .ch.size, .cell.size, .ch.parent, .cell.parent { flex-basis: 0; padding-left: 0; padding-right: 0; opacity: 0; min-width: 0; pointer-events: none; }
    .ch.mtime, .cell.mtime { flex-basis: 104px; }
    .fd-colhead { padding: 0 8px; }
    .ch.name { margin-left: 22px; }
  }
  @container (max-width: 380px) {
    .ch.mtime, .cell.mtime { flex-basis: 0; padding-left: 0; padding-right: 0; opacity: 0; min-width: 0; pointer-events: none; }
    .fd-crumbs { min-width: 48px; margin: 0 2px; }
  }
</style>
