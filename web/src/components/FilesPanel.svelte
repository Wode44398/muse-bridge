<script>
  // 工作空间（文件管理）。视觉＝iOS 27（token/配方实测自官方 UI Kit，见设计稿
  // 《工作空间页面demo.html》）；数据＝真实接 /api/files*（admin=vault，user=沙箱）。
  // admin 在根目录还有一行「位置」：主目录与各盘符，整台电脑都够得着（见 cloudLocs）。
  // 固定浅色 grouped 风（像 iOS 文件 app），不跟 bridge 暗主题。
  //
  // 云端：浏览/面包屑、分块上传、新建文件夹、重命名、删除、移动/复制、多选、搜索、
  //       预览、发送给 AI、分享、打开方式、解压、下载——全部真实。
  // 本地(SAF 多根)：浏览/预览/发送给 AI/分享/打开方式，长按菜单写操作(重命名/移动/复制/
  //       删除/多选)走新 apk 原生 localRename/localMove/localCopy/localDelete——逐个
  //       feature-detect，旧 apk 对应菜单项隐藏；「位置」主页(atHome)不出长按菜单。
  import { uiConfirm } from '../lib/dialogs.js';
  import { joinAbs } from '../lib/dragOut.js';
  import { onMount, setContext, untrack } from 'svelte';
  import GlassButton from './ios27/GlassButton.svelte';
  import Sym from './ios27/Sym.svelte';
  import MorphMenu from './ios27/MorphMenu.svelte';
  import { LiquidTabs } from '../lib/liquid/tabs.js';
  import { liquidPress } from '../lib/liquid/press.js';
  // 平滑圆角遮罩、文件夹图标：原版资源
  import sq26 from '../visuals/ios27/squircle26.svg';
  import wsIcon from '../visuals/assets/icons/workspace.png';
  import { isEn, locale, t, tc, tr } from '../lib/i18n.js';
  import { me, rootScreen, ui } from '../lib/state.svelte.js';
  import { api } from '../lib/api.js';
  import { downloads } from '../lib/downloads.svelte.js';
  import { uploads } from '../lib/uploads.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { openPreview as openPreviewRaw } from '../lib/preview.svelte.js';
  import { extOf, iconKindOf } from '../lib/fileKinds.js';
  import { isAlbumDir, loadSortPref, loadViewPrefs, saveSortPref, saveViewPrefs, typeIconSvg, viewFor, watchMeta, withView } from '../lib/fileGrid.js';
  import { hasLocalCopy, hasLocalDelete, hasLocalFs, hasLocalMove, hasLocalRename, hasLocalRoot, hasMultiRoot, hasOpenWith, hasShare, localList, localRootName, localRoots, pickLocalRoot, removeLocalRoot, requestAllFiles } from '../lib/localfs.js';
  import { hasNativeWorkspaceOps, hasPcLocalFs, isNativeDesktop, nativeLocLocalOnly, nativeWorkspaceAddLocation, nativeWorkspaceInspect, nativeWorkspaceList, nativeWorkspaceLocations, nativeWorkspaceRelease, nativeWorkspaceRemoveLocation, nativeWorkspaceReveal, nativeWorkspaceSearch, nativeWorkspaceThumbnail, onNativeWorkspaceChanged } from '../lib/nativeDesktop.js';
  import { onAgentFs, onAgentGoto, reportUi } from '../lib/uiReport.js';
  import { drag, dragScrollGuard, dropZone } from '../lib/dragdrop.svelte.js';
  import { filterFilesByName, makeFileComparator, nextSort, normalizeFileQuery } from '../lib/files-business.js';
  import { fmtSize, kindOf } from '../lib/files/common.js';
  import { AiSend } from '../lib/files/aiSend.svelte.js';
  import { ROOT_LIST_KEY, forgetRoot, recallLocs, recallRoot, recallRootMeta, rememberLocs, rememberRoot, rememberRootMeta } from '../lib/files/lastSeen.js';
  import { G, fmtTime, locGlyph, locLabel, resolveStart, winAbs } from './files/panel/panelLook.js';
  import { createPanelDrag } from './files/panel/panelDrag.svelte.js';
  import { createPanelOps } from './files/panel/panelOps.svelte.js';
  import { createPanelView } from './files/panel/panelView.svelte.js';
  import { createPanelMenus } from './files/panel/panelMenus.svelte.js';
  import PanelBody from './files/panel/PanelBody.svelte';
  import PanelSheets from './files/panel/PanelSheets.svelte';
  import PanelTransfers from './files/panel/PanelTransfers.svelte';

  const BASE = import.meta.env.BASE_URL;

  // readonly = 公开分享只读模式（SharePage 传入）：隐藏所有写操作入口（上传/新建/重命名/
  // 删除/移动/复制/多选/发送 AI），只留浏览 + 预览 + 下载。服务端对 share 身份写接口也一律 401。
  // onExit：内嵌宿主（Claude 工作台把本页整体挂进右侧栏）传入——根部返回时交还宿主
  // （回工作台菜单），并跳过全局 closer 注册（安卓返回由宿主 dock 的瞬态层接管）。
  // guest = 聊天快照访客（/c/ 链接，工作台内嵌）：文件读写照常（服务端已把 cwd 锁死在快照桶），
  // 但去掉「不属于这个身份」的入口——手机本地(SAF)切页、分享链接铸造（/api/share 对 snap 401）、
  // 发送给 AI（会牵出 Media Studio 这类快照够不着的东西）。
  // picker = 「新建项目」选择器形态（ProjectPicker 挂进来的）：同一套文件管理器，但只做
  // 一件事——把某个文件夹选成新项目的工作空间。写操作只留「新建文件夹」（要一个全新的空
  // 项目就在这儿建），文件只展示不可点开，长按不再出菜单而是【起拖】。
  // 选定手势只有「拖进底栏」这一个，不做点按兜底——点文件夹恒等于「进去」，一旦让它同时
  // 可能是「选它」就再也分不清用户想要哪个。拖源除了文件夹格子，还有顶部那条当前路径条
  // （＝把「我此刻所在的这个文件夹」本身拖走），补上「已经走进去了想选它自己」的死角。
  const {
    readonly = false, guest = false, onExit = null, theme = '', workspaceRoot = '', rootName = '',
    initialPath = null, initialOpen = '', previewHost = '',
    picker: wsPick = false, pickerLocations = [], pickerLocationId = '', onPickLocation = null,
    onPick: onPickWs = null, pickLabel = t('拖入选为工作空间'),
    // hostChrome：宿主自带标题行 / 收起钮（工作台卡片的放大·关闭、手机 sheet 的 ⌄）——顶栏 ‹ 只管
    // 「上一级」，到了最上层就不出；不再兼任「收起工作台」，与旁边几张卡同一套上手方式。
    hostChrome = false,
  } = $props();
  // P：本页状态与动作的视图（getter / setter 直通上面的 $state），交给拆出去的逻辑模块（files/panel/*.svelte.js）
  // 与子组件（files/panel/*.svelte）；模块各自的状态与动作建好后也挂到 P 上（expose），彼此都经 P 互相够得着。
  const P = {
    get BASE() { return BASE; },
    get addDesktopLocation() { return addDesktopLocation; },
    get addLocAnchor() { return addLocAnchor; }, set addLocAnchor(v) { addLocAnchor = v; },
    get addOpen() { return addOpen; }, set addOpen(v) { addOpen = v; },
    get addSheet() { return addSheet; }, set addSheet(v) { addSheet = v; },
    get ai() { return ai; },
    get atHome() { return atHome; },
    get atPcLoc() { return atPcLoc; },
    get canOpenWith() { return canOpenWith; },
    get canShare() { return canShare; },
    get cloudLoc() { return cloudLoc; },
    get cloudLocId() { return cloudLocId; }, set cloudLocId(v) { cloudLocId = v; },
    get cloudLocs() { return cloudLocs; }, set cloudLocs(v) { cloudLocs = v; },
    get cloudRoot() { return cloudRoot; },
    get convAbs() { return convAbs; },
    get convName() { return convName; },
    get crumbHidden() { return crumbHidden; },
    get crumbMenu() { return crumbMenu; }, set crumbMenu(v) { crumbMenu = v; },
    get desktopExtra() { return desktopExtra; },
    get desktopLocationId() { return desktopLocationId; }, set desktopLocationId(v) { desktopLocationId = v; },
    get desktopLocations() { return desktopLocations; }, set desktopLocations(v) { desktopLocations = v; },
    get desktopNative() { return desktopNative; },
    get doPickAll() { return doPickAll; },
    get doPickLocal() { return doPickLocal; },
    get doRemove() { return doRemove; },
    get doReselect() { return doReselect; },
    get enterDir() { return enterDir; },
    get enterSelect() { return enterSelect; },
    get exitSelect() { return exitSelect; },
    get fileInput() { return fileInput; }, set fileInput(v) { fileInput = v; },
    get goConv() { return goConv; },
    get goRoot() { return goRoot; },
    get goSeg() { return goSeg; },
    get guest() { return guest; },
    get hidSwitch() { return hidSwitch; },
    get hidTotal() { return hidTotal; },
    get infoItem() { return infoItem; }, set infoItem(v) { infoItem = v; },
    get infoLocation() { return infoLocation; },
    get isEmpty() { return isEmpty; },
    get isLocal() { return isLocal; },
    get itemRel() { return itemRel; },
    get items() { return items; }, set items(v) { items = v; },
    get listMeta() { return listMeta; }, set listMeta(v) { listMeta = v; },
    get load() { return load; },
    get loadErr() { return loadErr; }, set loadErr(v) { loadErr = v; },
    get locMenu() { return locMenu; }, set locMenu(v) { locMenu = v; },
    get locPill() { return locPill; },
    get localAvail() { return localAvail; },
    get localOps() { return localOps; },
    get localPicked() { return localPicked; }, set localPicked(v) { localPicked = v; },
    get localPicking() { return localPicking; }, set localPicking(v) { localPicking = v; },
    get mdOpen() { return mdOpen; }, set mdOpen(v) { mdOpen = v; },
    get menu() { return menu; }, set menu(v) { menu = v; },
    get meta() { return meta; }, set meta(v) { meta = v; },
    get mkOpen() { return mkOpen; }, set mkOpen(v) { mkOpen = v; },
    get multiRoot() { return multiRoot; },
    get onPickLocation() { return onPickLocation; },
    get onPickWs() { return onPickWs; },
    get openDots() { return openDots; },
    get openMenu() { return openMenu; },
    get openPreview() { return openPreview; },
    get openSearch() { return openSearch; },
    get path() { return path; }, set path(v) { path = v; },
    get pcHome() { return pcHome; }, set pcHome(v) { pcHome = v; },
    get pcLocAbs() { return pcLocAbs; }, set pcLocAbs(v) { pcLocAbs = v; },
    get pcLocMenu() { return pcLocMenu; }, set pcLocMenu(v) { pcLocMenu = v; },
    get pcLocal() { return pcLocal; },
    get pickerLocationId() { return pickerLocationId; },
    get pickerLocations() { return pickerLocations; },
    get pkAbs() { return pkAbs; },
    get pkDockEl() { return pkDockEl; }, set pkDockEl(v) { pkDockEl = v; },
    get pkDrag() { return pkDrag; }, set pkDrag(v) { pkDrag = v; },
    get preview() { return preview; }, set preview(v) { preview = v; },
    get q() { return q; },
    get query() { return query; }, set query(v) { query = v; },
    get readonly() { return readonly; },
    get recents() { return recents; },
    get removeDesktopLocation() { return removeDesktopLocation; },
    get removePcLoc() { return removePcLoc; },
    get renameTarget() { return renameTarget; }, set renameTarget(v) { renameTarget = v; },
    get revealPcLoc() { return revealPcLoc; },
    get rootEl() { return rootEl; }, set rootEl(v) { rootEl = v; },
    get rootLabel() { return rootLabel; },
    get rootMap() { return rootMap; },
    get rootMenu() { return rootMenu; }, set rootMenu(v) { rootMenu = v; },
    get roots() { return roots; }, set roots(v) { roots = v; },
    get scoped() { return scoped; },
    get scroller() { return scroller; }, set scroller(v) { scroller = v; },
    get segLabel() { return segLabel; },
    get segs() { return segs; },
    get selectCloudLoc() { return selectCloudLoc; },
    get selectDesktopLocation() { return selectDesktopLocation; },
    get selected() { return selected; }, set selected(v) { selected = v; },
    get selecting() { return selecting; }, set selecting(v) { selecting = v; },
    get setSort() { return setSort; },
    get setView() { return setView; },
    get shareDlg() { return shareDlg; }, set shareDlg(v) { shareDlg = v; },
    get showCloudLocs() { return showCloudLocs; },
    get showFiles() { return showFiles; },
    get showFolders() { return showFolders; },
    get showHidden() { return showHidden; }, set showHidden(v) { showHidden = v; },
    get sortPref() { return sortPref; }, set sortPref(v) { sortPref = v; },
    get tasks() { return tasks; }, set tasks(v) { tasks = v; },
    get title() { return title; },
    get toast() { return toast; },
    get toggleHidden() { return toggleHidden; },
    get toggleSel() { return toggleSel; },
    get viaViewer() { return viaViewer; },
    get viewMenu() { return viewMenu; }, set viewMenu(v) { viewMenu = v; },
    get viewMode() { return viewMode; },
    get wsPick() { return wsPick; },
    get xfers() { return xfers; },
    get zipDlg() { return zipDlg; }, set zipDlg(v) { zipDlg = v; },
  };
  const expose = (o) => Object.defineProperties(P, Object.getOwnPropertyDescriptors(o));
  // 内嵌态的文件预览/编辑也留在侧栏（host:'dock' → 侧栏内嵌 MediaViewer 实例接管，
  // 不再全屏）；独立分页维持全屏。影子包装：本文件所有 openPreview 调用点零改动。
  const openPreview = (items, idx, opts = {}) => openPreviewRaw(items, idx, { host: previewHost || (onExit ? 'dock' : 'app'), ...opts });
  // 内嵌在工作台（Claude/Codex/dimensio 的侧列或底部 sheet）与独立手机工作空间页都跟随全站明暗。
  // theme='light'|'dark'：宿主有自己的明暗档（dimensio）时强制跟宿主，左右两栏不许一明一暗。
  const embeddedUi = $derived(Boolean(onExit) || previewHost === 'dock');
  // 搜索行（关闭钮 + 搜索框）用 Figma iOS 27 kit 的液态玻璃（见样式区 .fg）；`?oldglass` 退回原毛玻璃配方
  const fg = typeof location === 'undefined' || !new URLSearchParams(location.search).has('oldglass');
  // iOS 27 kit 组件（components/ios27，与设置页同一套）按 'ios27' 上下文挑明暗两套烘焙玻璃。
  // 明暗：宿主强制档（theme）优先，否则跟全站 data-theme。独立页也跟（11-08 起：暗主题下不再亮一整屏白）。
  const iosDark = $derived(theme === 'dark' || (theme !== 'light' && ui.theme !== 'light'));
  setContext('ios27', { get dark() { return iosDark; } });
  let rootW = $state(390);         // 根元素宽：锚在右上角的菜单 / 面板按它换算 left
  let edgeOn = $state(false);
  // 状态栏高（--sat：app.css env() 或 apk 原生注入）：锚在顶栏按钮下方的菜单 / 面板据此定 top
  const satPx = () => { try { return parseFloat(getComputedStyle(rootEl || document.documentElement).getPropertyValue('--sat')) || 0; } catch { return 0; } };
  // 顶栏按钮底边（状态栏 + 内嵌时的 --tbg 呼吸距离 + 44 钮高）：菜单 / 传输面板锚在它下面
  // 宿主标题行已经隔开了卡片上缘：呼吸距离收到 4（与 .ws-root.chrome 的 --tbg 同值）
  const TBG = untrack(() => hostChrome) ? 4 : 12;
  const barBottom = () => satPx() + (embeddedUi ? TBG : 0) + 44;      // 内容滚到顶栏底下 → 滚动边缘效果显形（kit Scroll Edge Effect - Soft）
  // 没有对应 SF 字形的几处（文件夹、复制、云、压缩包…）沿用线稿，笔画粗细对齐 SF Regular
  // —— 电脑位置（admin 的整机访问）——
  // 桌面版左侧有「位置」（主进程授权的任意目录），手机版以前锁在身份工作空间根（admin=vault），
  // 库外的文件整个够不着。/api/project/locations 给出 工作空间 + 主目录 + 各盘符（与新建项目
  // 选择器同一份；授权边界仍由服务端 authorizeProjectPath 判——Pro/普通用户只拿到自己那一条，
  // 位置行就不出现）。选中「工作空间」时 cloudRoot=''，走身份根，行为与从前逐字一致；其余位置把
  // 绝对路径当 ws 交给 /api/files*（列表/预览/缩略图/上传/改名/移动/解压/分享/发给 AI 全都认 ws）。
  // 桌面壳走主进程的原生位置，不在这里。
  // 删除在电脑位置里改走电脑的回收站（与桌面版同一语义），身份工作空间里仍是原来的永久删除。
  //
  // workspaceRoot（内嵌工作台按会话目录挂载时的绝对路径）是【起点】不是围栏——与电脑形态
  // FilesDesktop 同一语义：挂载时按绝对路径落进【最深】的那个位置（vault 内的会话落「工作空间」，
  // 快照对话 ~/.bridge-quickchat/… 落「主目录」），位置行、返回链、本地页签和库内会话逐字一致。
  // 哪个位置都不含它（非 admin 越界、位置没拉到）才退回老形态：以 ws 为根（fenced）。
  // 选择器形态 / 分享只读 / 快照访客维持围栏。
  // 上次拿到的位置：进页即出，不晚一拍冒出来。冷启动从 lastKnown 快照起步——位置表常比列表还晚到，
  // 等它到了才长出位置胶囊、撤掉路径条，整页会往上跳一截
  const LOC_CACHE = (window.__bridgeFilesLocs ||= { list: me.kind === 'admin' ? recallLocs() : null });
  let cloudLocs = $state(me.kind === 'admin' ? LOC_CACHE.list || [] : []);
  // 位置表这次还没回来：管理员一定有「工作空间 + 主目录 + 盘符」好几条，全新安装（没快照）时先按有胶囊排顶栏，
  // 不先摆一行路径条再撤掉；真拉不到再退回路径条
  let locsPending = $state(!(me.kind === 'admin' && LOC_CACHE.list?.length));
  let cloudLocId = $state('ws');
  const cloudLoc = $derived(cloudLocs.find((l) => l.id === cloudLocId) || null);
  // 挂载时拍下（宿主换 ws 会按 key 重挂）；卸载后不再回读 props
  const startRoot = untrack(() => workspaceRoot);
  const canStart = untrack(() => !!startRoot && !readonly && !guest && !wsPick);
  let fenced = $state(!!startRoot);  // true＝以 startRoot 为根的老形态（起点尚未/无法落进某个位置）
  const cloudRoot = $derived(fenced ? startRoot : (cloudLoc && cloudLoc.id !== 'ws' ? cloudLoc.path : ''));
  const atPcLoc = $derived(!fenced && !!cloudRoot && !desktopNative);   // 此刻在「电脑位置」里，而不是身份工作空间（原生通道/这台电脑不算：那是另一套位置）
  const scoped = (url) => cloudRoot ? url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(cloudRoot) : url;

  // 列表内存缓存（SPA 存活期）：listKey → items；截断信息同样按 listKey 记（服务端对上千项的目录只回前 1500 项）
  const LIST_CACHE = (window.__bridgeFilesListCache ||= new Map());
  const LIST_META = (window.__bridgeFilesListMeta ||= new Map());     // listKey → { truncated, total }
  const NO_META = { truncated: false, total: 0 };
  // 进页默认落在身份工作空间根目录（独立分页、没指定起始路径、不走桌面壳原生通道）：内存缓存或上次的快照里有，
  // 就拿它当起始值——推进来的第一帧就是上次的内容；正文分组的淡入（PanelBody 的 in:swap）只留给真晚到的列表
  const startsAtRoot = untrack(() => !workspaceRoot && !readonly && (initialPath ?? ui.filesPath ?? '') === ''
    && !(isNativeDesktop() && hasNativeWorkspaceOps()));
  if (startsAtRoot && !LIST_CACHE.has(ROOT_LIST_KEY)) {
    const seen = recallRoot();
    if (seen) {
      LIST_CACHE.set(ROOT_LIST_KEY, seen.items);
      LIST_META.set(ROOT_LIST_KEY, seen.truncated ? { truncated: true, total: seen.total } : NO_META);
    }
  }
  const items0 = (startsAtRoot && LIST_CACHE.get(ROOT_LIST_KEY)) || [];

  let path = $state('');           // 当前相对路径（'' = 根）
  let items = $state(items0);
  let loading = $state(!items0.length);
  let scrolled = $state(false);
  let scroller = $state();

  let query = $state('');
  let searching = $state(false);
  let searchEl = $state();

  let selecting = $state(false);
  let selected = $state(new Set());

  let rootEl = $state();           // 根元素：长按菜单换算 fixed 定位坐标系用（见 openMenu）
  let menu = $state(null);         // 文件菜单 { item, point }（长按 / 右键，视口坐标）或 { item, anchor }（行尾「…」按钮）
  let infoItem = $state(null);     // 「显示简介」文件详情 { name, isDir, size, mtime, dir }
  let preview = $state(null);      // 文件预览 { name, rel, kind, url?, text?, loading }
  let renameTarget = $state(null); // 重命名 { item, value }
  let shareDlg = $state(null);     // 分享链接设置弹窗 { item, pwOn, password, ttl, busy, result }
  let addOpen = $state(false);     // + 菜单（上传/新建文件夹）
  let mkOpen = $state(null);       // 新建文件夹输入 { value }
  let mdOpen = $state(null);       // 新建 Markdown 输入 { value }
  let zipDlg = $state(null);       // 压缩选项 { rels, sub, isDir, name, format, level, formats, busy, note, gone }

  // —— picker 形态：拖拽选定 ——
  // pkDrag = 正在拖的那一份 { name, abs, x, y, over }（x/y 是 .ws-root 局部坐标，和长按菜单
  // 同一个坐标系：本页内嵌时外层带 transform，fixed 的包含块不是视口）。
  let pkDrag = $state(null);
  let pkDockEl = $state();         // 底栏元素（松手命中判定按它的 rect）
  const pkAbs = (rel) => joinAbs(workspaceRoot, rel);

  let ws = $state('cloud');        // cloud=PC 文件系统 / local=手机本地（SAF）；桌面客户端连远端服务端时 local=这台电脑
  const localAvail = $derived(!fenced && hasLocalFs()); // 围栏形态固定在 ws 根，不混入手机 SAF 位置
  // 「这台电脑」：桌面客户端连的是远端服务端时，「本地」分页换成这台电脑上授权过的文件夹（壳的原生位置）——
  // 同手机本地 SAF：在本机列目录、本地协议直读预览，不经过服务器。下面 desktopNative 那一整套原生通道直接复用。
  const pcAvail = $derived(!fenced && !readonly && !guest && !wsPick && isNativeDesktop() && hasPcLocalFs());
  const pcLocal = $derived(ws === 'local' && pcAvail);
  let pcHome = $state(true);         // 「这台电脑」位置主页（列出授权过的文件夹）；进了某个位置＝false
  let pcLocMenu = $state(null);      // 这台电脑位置的管理菜单 { loc, anchor }（从行尾「管理」按钮长出来）
  let pcLocAbs = $state({});         // 位置 id → 绝对路径（主页副标题；位置列表故意不带 path，向壳 inspect 根目录取）
  const canOpenWith = hasOpenWith(); // 原生「打开方式」可用（离线 apk 壳内；dev/在线壳=false，菜单项不显示）
  const canShare = hasShare();       // 原生「分享」可用（同上）
  // 本地写操作能力（新 apk 原生接口）：旧 apk 缺哪个就隐藏哪个菜单项/禁用哪个多选钮。
  const localOps = { del: hasLocalDelete(), rename: hasLocalRename(), move: hasLocalMove(), copy: hasLocalCopy() };
  // 「发送给 AI」选目标的状态与流程（lib/files/aiSend.svelte.js，与电脑版共用）；素材怎么备见 aiMaterial / aiTextContent。
  // 文案出自 files-business.js（别的模块）：toast 显示点兜一层 tr()
  const ai = new AiSend({ kindOf, material: (it, direct) => P.aiMaterial(it, direct), readText: (it) => P.aiTextContent(it), toast: (m) => toast(tr(m)) });
  let localPicked = $state(false); // 本地工作空间已有 ≥1 个位置
  let localPicking = $state(false);
  const isLocal = $derived(ws === 'local' && !pcLocal);   // 手机本地 SAF
  // —— 多根「本地位置」——
  const multiRoot = hasMultiRoot();  // 新 apk（支持多个本地位置）；旧 apk=false 走单根旧流程
  let roots = $state([]);            // 本地位置列表 [{id,name,mode}]
  let addSheet = $state(false);      // 「添加本地位置」菜单开着
  let addLocAnchor = $state(null);   // 它从哪儿长出来：顶栏「＋」或「添加文件夹」那一行的加号
  let addLocBtn = $state();
  let rootMenu = $state(null);       // 位置管理菜单 { root, anchor }（从行尾「管理」按钮长出来）
  const atHome = $derived(isLocal && multiRoot && localPicked && path === '');   // 「本地位置」主页
  const rootMap = $derived(Object.fromEntries(roots.map((r) => [r.id, r.name]))); // 根 id → 显示名
  let tasks = $state([]);          // 分享页的跟踪下载（传输面板；上传行在 uploads 引擎里）
  let transferOpen = $state(false);
  let toastMsg = $state('');
  let fileInput = $state();
  const desktopNative = $derived(pcLocal || (isNativeDesktop() && !workspaceRoot && !readonly && !guest && hasNativeWorkspaceOps()));
  let desktopLocationId = $state('primary');
  let desktopLocations = $state([]);
  let desktopMatches = $state([]);
  let desktopSearchBusy = $state(false);
  const desktopLocation = $derived(desktopLocations.find((item) => item.id === desktopLocationId));
  // 服务端不认识的原生位置（额外授权位置 / 这台电脑）：分享链接、解压、服务端压缩这些要服务端摸文件的动作都没有
  const desktopExtra = $derived(desktopNative && nativeLocLocalOnly(desktopLocationId));
  const cloudLocsOn = $derived(!fenced && !readonly && !guest && !wsPick);   // 这一形态有没有「电脑位置」这回事
  const showCloudLocs = $derived(cloudLocsOn && !isLocal && !desktopNative && cloudLocs.length > 1);
  // 位置胶囊：顶栏返回键右边那枚「⌂ 主目录 ⌃⌄」——「在电脑的哪儿」恒在手边，任何深度都能一下换盘，
  // 不必先退回根目录找那排位置钮。菜单里另有一行「对话文件夹」：起点（会话目录）走远了一键回去。
  const locPill = $derived(showCloudLocs || (locsPending && cloudLocsOn && !isLocal && !desktopNative && me.kind === 'admin'));
  const pillLabel = $derived(cloudLoc ? (cloudLoc.id === 'ws' ? t('工作空间') : locLabel(cloudLoc)) : t('工作空间'));
  let locMenu = $state(null);      // { x, y }
  // 顶栏「＋ / 位置胶囊 / 传输环」与路径条「…」的元素：点一下，菜单就从按钮本身长出来（ios27/MorphMenu）
  let addBtn = $state(), locBtn = $state(), xferBtn = $state(), crumbBtn = $state(), backBtn = $state(), viewBtn = $state();
  // 同排的顶栏按钮：哪个菜单展开时盖到了它们，它们就像水滴一样融进菜单、收起时再滴回来（ios27/MorphMenu neighbors）
  const topBtns = () => [backBtn, locBtn, viewBtn, addBtn, xferBtn, addLocBtn];
  // 有按钮融着：顶栏抬到菜单玻璃之上（符号流进 / 滴回来时看得见）。按菜单计数：一个还在收、另一个已经开了也不会提前放下
  let topFuseN = $state(0);
  const topFusing = $derived(topFuseN > 0);
  const onTopFuse = (on) => { topFuseN = Math.max(0, topFuseN + (on ? 1 : -1)); };
  // 底栏两个 Tab 的液态指示器（Kyant LiquidBottomTabs：按住拖、点按滑过去时化成透镜，lib/liquid/tabs.js）
  let tabBarEl = $state(), tabSelEl = $state(), tabRowU = $state(), tabRowS = $state(), tabGlowEl = $state();
  let ltabs = null;
  const tabW = () => tabRowU?.children?.[0]?.offsetWidth || 104;
  $effect(() => {
    const bar = tabBarEl, host = rootEl;
    if (!bar || !host || !tabRowU) return;
    const lt = untrack(() => new LiquidTabs({
      bar, pill: tabSelEl, rowU: tabRowU, rowS: tabRowS, glow: tabGlowEl, lensHost: host, count: 2,
      index: ws === 'local' ? 1 : 0, tabW: tabW(), pad: 4, selH: 54, dark: iosDark,
      onSelect: (i) => pickWs(i ? 'local' : 'cloud'),
    }));
    ltabs = lt;
    const ro = new ResizeObserver(() => { lt.setTabW(tabW()); lt.measure(); });
    ro.observe(bar);
    return () => { ro.disconnect(); lt.destroy(); if (ltabs === lt) ltabs = null; };
  });
  $effect(() => { const i = ws === 'local' ? 1 : 0; untrack(() => ltabs?.setIndex(i)); });
  $effect(() => { const d = iosDark; untrack(() => ltabs?.setDark(d)); });
  const convAbs = $derived(canStart && !fenced ? startRoot : '');
  const convName = $derived(convAbs ? (String(convAbs).split(/[\\/]/).filter(Boolean).pop() || convAbs) : '');
  function goConv() {
    const hit = resolveStart(cloudLocs, convAbs);
    if (hit) selectCloudLoc(hit.loc.id, hit.rel);
  }
  expose(createPanelMenus(P));
  // 菜单锚在触发它的那枚按钮下方：按 .ws-root 局部坐标算（内嵌时外层有 transform，fixed 的包含块是容器）
  function anchorBelow(e) {
    const r = e.currentTarget.getBoundingClientRect(), o = rootEl?.getBoundingClientRect() || { left: 0, top: 0 };
    return { x: Math.max(12, Math.min(r.left - o.left, rootW - 12 - 250)), y: r.bottom - o.top + 8 };
  }
  let loadErr = $state('');        // 当前目录打不开的原因（没权限等）：空态显示它，而不是「这个文件夹是空的」

  // —— 面包屑 / 分组 / 派生 ——
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const rootLabel = $derived(readonly ? t('分享空间') : pcLocal && pcHome ? t('这台电脑') : isLocal ? (multiRoot ? t('本地') : localRootName()) : (tr(desktopLocation?.name) || (fenced ? tr(rootName) : '') || (atPcLoc ? locLabel(cloudLoc) : '') || t('工作空间')));   // rootName 出自服务端 /api/project/locations（「工作空间」「主目录」）：显示点兜 tr()
  // 面包屑首段（本地多根时是根 id）翻译成显示名；其余段原样。
  const segLabel = (s, i) => (isLocal && multiRoot && i === 0 ? (rootMap[s] || s) : s);
  const title = $derived(segs.length ? (segs.length === 1 ? segLabel(segs[0], 0) : segs[segs.length - 1]) : rootLabel);
  // 路径条恒为一行：超过两级时中间收成「…」，点开是一张逐级向上的菜单（iOS 文件 app 标题菜单那套），
  // 长名字各段自己省略号——整机浏览时 .bridge-quickchat › <uuid> 这种路径不再折成两三行。
  const CRUMB_TAIL = 2;
  const crumbHidden = $derived(segs.length > CRUMB_TAIL ? segs.length - CRUMB_TAIL : 0);
  let crumbMenu = $state(null);    // 「…」展开的祖先菜单 { x, y }
  // —— 隐藏项（. 开头）——主目录、盘根、仓库根里大半是 .android/.cache/.git 这类，默认收起，
  // 分组标题右侧一个开关放出来；搜索时不收（找的就是它）。整个目录全是隐藏项时照常列出，不摆一屏空白。
  const HID_KEY = 'bridge.files.showHidden';
  let showHidden = $state((() => { try { return localStorage.getItem(HID_KEY) === '1'; } catch { return false; } })());
  function toggleHidden() { showHidden = !showHidden; try { localStorage.setItem(HID_KEY, showHidden ? '1' : '0'); } catch {} }
  const isHid = (it) => String(it?.name || '').startsWith('.');
  const visibleAll = $derived(desktopNative && q ? desktopMatches : q && srvMatches ? srvMatches : items);
  const hidTotal = $derived(q ? 0 : visibleAll.filter(isHid).length);
  const hidSwitch = $derived(hidTotal > 0 && hidTotal < visibleAll.length);   // 有隐藏项、也有普通项：才有「收起」这回事
  const visibleItems = $derived(hidSwitch && !showHidden ? visibleAll.filter((i) => !isHid(i)) : visibleAll);
  // —— 显示方式与排序（lib/fileGrid.js）：列表 / 图标 / 大图标全局一份，相册类文件夹（DCIM、截图……或以图片视频为主）另记一份、
  // 缺省就是图标视图；排序规则与电脑版、服务端列表、查看器画廊同一套（files-business.js makeFileComparator）。
  let viewPrefs = $state(loadViewPrefs());
  let sortPref = $state(loadSortPref());
  let viewMenu = $state(false);
  // 只有真在看一个文件夹的内容时才有「显示方式」：选择器只挑文件夹，本地位置主页与「这台电脑」主页是位置列表
  const gridOn = $derived(!wsPick && !atHome && !(pcLocal && pcHome));
  const albumDir = $derived(gridOn && isAlbumDir(segs.length ? title : '', items));
  const viewMode = $derived(gridOn ? viewFor(viewPrefs, albumDir) : 'list');
  function setView(mode) { viewPrefs = withView(viewPrefs, mode, albumDir); saveViewPrefs(viewPrefs); }
  function setSort(key) { sortPref = nextSort(sortPref, key); saveSortPref(sortPref); }
  // 种类排序：先按图标大类（图片 / 视频 / 文稿 / 表格…），同类再按扩展名
  const sortCmp = $derived(makeFileComparator({ ...sortPref, locale: locale(), typeOf: (it) => iconKindOf(it.name) + '.' + extOf(it.name) }));
  const folders = $derived(visibleItems.filter((i) => i.isDir).sort(sortCmp));
  const files = $derived(visibleItems.filter((i) => !i.isDir).sort(sortCmp));
  // 分享只读模式不出「最近」区：桶顶层就那几项，跟正文重复只添乱。
  // 电脑位置也不出：盘根/主目录顶层的「最近」是 DumpStack.log、NTUSER.DAT 这类系统文件，不是人要找的。
  const recents = $derived(
    !segs.length && !query && !readonly && !wsPick && !atPcLoc && !pcLocal    // 选择器只挑文件夹，「最近」全是文件，纯噪音
      ? [...files].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 6)
      : []
  );
  const q = $derived(normalizeFileQuery(query));
  const showFolders = $derived(q && !desktopNative ? filterFilesByName(folders, q) : folders);
  const showFiles = $derived(q && !desktopNative ? filterFilesByName(files, q) : files);
  const isEmpty = $derived(!loading && !desktopSearchBusy && !srvSearchBusy && !showFolders.length && !showFiles.length);

  // 传输面板 = 上传（全站共享引擎 uploads：网页 XHR / 手机原生服务）+ 手机 App 内置下载 + 分享页的跟踪下载，新的在上。
  const xfers = $derived([...uploads.list, ...uploads.native, ...downloads.list, ...tasks].sort((a, b) => (b.at || 0) - (a.at || 0)));
  const activeTasks = $derived(xfers.filter((tk) => tk.status === 'up'));
  const ringPct = $derived.by(() => {
    const a = xfers.filter((tk) => tk.status === 'up');
    if (!a.length) return xfers.length && xfers.every((tk) => tk.status === 'done') ? 1 : 0;
    const tot = a.reduce((s, tk) => s + tk.total, 0) || 1;
    return a.reduce((s, tk) => s + tk.sent, 0) / tot;
  });
  const allDone = $derived(xfers.length > 0 && xfers.every((tk) => tk.status !== 'up'));

  // —— 加载 / 导航（云端走 /api/files，本地走 SAF 原生桥）——
  // 乐观导航：进目录/返回/面包屑点下去**当帧就切 path**——列表缓存命中立即出上次内容、
  // 网络退到点击之后后台对账刷新；没缓存才亮 loading。弱网里返回不再「点了等一拍才动」。
  // 同目录刷新（agent fs 事件/写操作后对账）保留现有内容静默换新，不清屏不回顶。
  // （LIST_CACHE / LIST_META 声明在 items 之前：起始值要从它们取）
  let listMeta = $state(NO_META);
  const listKey = (p) => (isLocal ? 'local' : desktopNative ? 'dt:' + desktopLocationId : readonly ? 'share' : 'cloud') + '\x1f' + (cloudRoot || '') + '\x1f' + p;
  let shownKey = null;   // 当前 items 属于哪个 listKey（跨 ws/位置切换时避免误判「同目录」）
  let loadSeq = 0, loadCtrl = null;   // 竞态闸 + 在途请求中止柄（快速连点只认最后一次）
  async function load(p) {
    const my = ++loadSeq;
    if (pcLocal && pcHome) { showPcHome(); return; }   // 主页只列位置，没有目录可列
    if (isLocal) {
      try { items = localList(p); } catch { items = []; }
      path = p; loading = false; shownKey = listKey(p); loadErr = ''; listMeta = NO_META;
      if (scroller) scroller.scrollTop = 0; scrolled = false;
      return;
    }
    const key = listKey(p), same = key === shownKey;
    path = p;
    if (!same) {
      const cached = LIST_CACHE.get(key);
      if (cached) { items = cached; loading = false; } else { items = []; loading = true; }
      shownKey = key;
      loadErr = '';
      listMeta = LIST_META.get(key) || NO_META;
      if (scroller) scroller.scrollTop = 0;
      scrolled = false;
    } else if (!items.length) loading = true;
    loadCtrl?.abort();
    const ctrl = (loadCtrl = new AbortController());
    const timer = setTimeout(() => ctrl.abort(), 15000);   // 半开 socket 永挂兜底：15s 超时
    try {
      const r = desktopNative ? await nativeWorkspaceList(p, desktopLocationId) : await api.files(p, cloudRoot, { signal: ctrl.signal });
      const meta = r.truncated ? { truncated: true, total: r.total || 0 } : NO_META;
      LIST_CACHE.set(listKey(r.path ?? p), r.items || []);
      LIST_META.set(listKey(r.path ?? p), meta);
      if (listKey(r.path ?? p) === ROOT_LIST_KEY) rememberRoot(r.items || [], meta);
      if (my !== loadSeq) return;   // 已被更新的导航替代：结果只进缓存不上屏
      items = r.items || []; path = r.path || p; shownKey = listKey(path); loadErr = ''; listMeta = meta;
      if (desktopNative) hydrateDesktopThumbs(items, desktopLocationId);
    }
    catch (e) {
      // 断网 / 超时不动快照；只有确定打不开了（没登录 / 没权限 / 不存在）才作废，下次冷开别再先画它
      if (key === ROOT_LIST_KEY && [401, 403, 404].includes(e?.status)) forgetRoot();
      if (my !== loadSeq) return;
      const why = e?.name === 'AbortError' ? t('加载超时')
        : tr(e.body?.error || '') || (e.status === 404 ? t('这个文件夹不存在（可能已被移走或删除）') : e.status === 403 ? t('没有权限打开这个文件夹') : '') || tr(e.message || '');
      loadErr = why || t('加载失败');
      toast(e?.name === 'AbortError' ? why : t('加载失败：{reason}', { reason: why }));
    }
    finally { clearTimeout(timer); if (my === loadSeq) loading = false; }
  }
  // 缓存镜像：屏上列表怎么变（乐观删除/改名/上传后刷新），缓存跟着变——返回时不会把
  // 刚删的文件短暂「复活」。loading 中不写（别把还没到货的空列表当真相存起来）。
  $effect(() => {
    const list = items;
    if (loading || !shownKey || isLocal) return;
    LIST_CACHE.set(shownKey, list);
    if (shownKey === ROOT_LIST_KEY) untrack(() => rememberRoot(list, listMeta));
  });
  // —— 补充元数据（/api/files/meta）：视频时长角标、文件夹项目数、查看器先按宽高占好比例 ——
  // 列表先上屏、这份后到（没算完的接口会说 pending，隔一会儿再要）；换目录清空。桌面原生位置不走服务端，没有这份。
  let meta = $state({});
  let metaKey = '';
  $effect(() => {
    const key = ws + '\x1f' + (cloudRoot || '') + '\x1f' + (desktopNative ? desktopLocationId : '') + '\x1f' + path;
    const on = !isLocal && !desktopNative && !loading && !(pcLocal && pcHome) && items.length > 0;
    const p = path, root = cloudRoot;
    return untrack(() => {
      // 身份工作空间根目录：先摆上次的元数据（图标视图格子下的「N 项」跟列表一起出，不晚一拍填字）
      const atRoot = listKey(p) === ROOT_LIST_KEY;
      if (key !== metaKey) { metaKey = key; meta = (atRoot && recallRootMeta()) || {}; }
      if (!on) return;
      return watchMeta(() => api.filesMeta(p, root), (m) => {
        if (metaKey !== key) return;
        meta = { ...meta, ...m };
        if (atRoot) rememberRootMeta(meta);
      });
    });
  });
  // 手机本地 tab 没有这个接口：图标视图里文件夹的项目数现数——SAF 列目录是同步桥调用，一次数 6 个、让出主线程再数，最多 60 个
  $effect(() => {
    if (!isLocal || viewMode === 'list' || loading) return;
    const p = path, key = metaKey, hid = showHidden;
    const names = folders.slice(0, 60).map((f) => f.name).filter((n) => untrack(() => meta[n]?.n == null));
    if (!names.length) return;
    let i = 0, timer = 0;
    const step = () => {
      if (key !== metaKey) return;
      const add = {};
      for (const end = Math.min(i + 6, names.length); i < end; i++) {
        try {
          const list = localList(p ? p + '/' + names[i] : names[i]) || [];
          add[names[i]] = { n: hid ? list.length : list.filter((x) => !String(x?.name || '').startsWith('.')).length };
        } catch {}
      }
      meta = { ...meta, ...add };
      if (i < names.length) timer = setTimeout(step, 40);
    };
    timer = setTimeout(step, 120);
    return () => clearTimeout(timer);
  });
  function itemRel(item) { return item?.rel || (path ? path + '/' + item.name : item?.name || ''); }
  function enterDir(item) {
    if (selecting) { toggleSel(item.name); return; }
    if (query) closeSearch();
    load(itemRel(item));
  }
  // 位置根之上的上级（D:\Notes 工作空间根 → D:\Notes 落进 E 盘），落不进任何位置＝null
  const parentHit = $derived.by(() => {
    if (segs.length || isLocal || !cloudLocsOn || desktopNative || !cloudLoc?.path) return null;
    const s = String(cloudLoc.path).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (i < 0) return null;
    let up = s.slice(0, i);
    if (/^[A-Za-z]:$/.test(up)) up += '\\';
    else if (!up) up = '/';
    return resolveStart(cloudLocs, up);
  });
  // hostChrome 下 ‹ 出不出：还有地方可退（搜索 / 多选 / 子目录 / 位置根之上）才出
  const canBack = $derived(searching || selecting || segs.length > 0 || Boolean(parentHit) || (pcLocal && !pcHome));
  function goSeg(i) { load(segs.slice(0, i + 1).join('/')); }
  function goRoot() { load(''); }
  // 切电脑位置（p = 在那个位置里直接去的相对路径，agent 的 goto 用）。多选/搜索都属于上一个位置，一并收掉。
  function selectCloudLoc(id, p = '') {
    if (!cloudLocs.some((l) => l.id === id)) id = 'ws';
    if (id !== cloudLocId) {
      if (selecting) exitSelect();
      searching = false; query = '';
      cloudLocId = id;
    }
    load(p);
  }
  function goHome() {
    if (onExit) { onExit(); return; }   // 内嵌在 Claude 工作台里：根部返回=回工作台菜单
    ui.screen = rootScreen();           // 单 agent 模式没有主页：回那一页
  }

  // 系统返回键 / 侧滑：有搜索/多选/面包屑就逐级退，到根再回主页
  function back() {
    if (ai.item) { if (ai.view === 'chat') { ai.chatBack(); return; } if (ai.view === 'video') { ai.view = 'studio'; return; } if (ai.view === 'studio') { ai.view = 'root'; return; } ai.item = null; return; }
    if (rootMenu) { rootMenu = null; return; }
    if (pcLocMenu) { pcLocMenu = null; return; }
    if (addSheet) { addSheet = false; return; }
    if (infoItem) { infoItem = null; return; }
    if (P.picker) { P.picker = null; return; }
    if (preview) { preview = null; return; }
    if (menu) { menu = null; return; }
    if (viewMenu) { viewMenu = false; return; }
    if (locMenu) { locMenu = null; return; }
    if (crumbMenu) { crumbMenu = null; return; }
    if (addOpen) { addOpen = false; return; }
    if (mkOpen) { mkOpen = null; return; }
    if (shareDlg) { shareDlg = null; return; }
    if (renameTarget) { renameTarget = null; return; }
    if (transferOpen) { transferOpen = false; return; }
    if (searching) { searching = false; query = ''; return; }
    if (selecting) { exitSelect(); return; }
    if (segs.length) { load(segs.slice(0, -1).join('/')); return; }
    if (pcLocal && !pcHome) { showPcHome(); return; }   // 这台电脑某个位置的根 → 回位置主页（同手机本地）
    // 内嵌在工作台里：‹ 就是「上一级」——位置根之上还有父目录就换进含它的位置，到顶即止（收起交给宿主）
    if (hostChrome) { if (parentHit) selectCloudLoc(parentHit.loc.id, parentHit.rel); return; }
    // 电脑位置的根：独立分页先回「工作空间」再回主页；内嵌在工作台里直接交还宿主——
    // 从对话文件夹一路退上来，没理由在最后绕去 vault 根停一下。
    if (atPcLoc && !isLocal && !onExit) { selectCloudLoc('ws'); return; }
    if (readonly) return;   // 分享页没有主页可回（SharePage 外面没有 App 的 screen 体系）
    goHome();
  }
  // 独立分页时才注册全局返回 closer；内嵌态由宿主 dock 的瞬态返回层接管。
  $effect(() => { if (!onExit) return registerCloser('files', back); });

  // —— 工作区协同：① 视图上报（agent 的 workspace.view 知道用户面板在哪个目录）；
  // ② 订阅 agent 的 fs 刷新（agent 改完文件列表自动跟上）与 goto 导航。仅云端工作空间——
  // 手机 SAF 本地盘 agent 够不着，上报/刷新都没意义。
  $effect(() => { if (ws === 'cloud' && !readonly) reportUi({ files: { path, ws: cloudRoot || '', query: q || '' } }); });
  $effect(() => {
    if (ws !== 'cloud' || readonly) return;
    let timer = 0;
    const offFs = onAgentFs(() => { clearTimeout(timer); timer = setTimeout(() => load(path), 350); });
    // goto 的路径相对【身份文件根】：人在电脑位置里时先切回「工作空间」再去
    const offGoto = onAgentGoto((rootRel) => (atPcLoc ? selectCloudLoc('ws', rootRel) : load(rootRel)));
    return () => { clearTimeout(timer); offFs(); offGoto(); };
  });

  // ui.filesPath：一次性初始路径（内嵌宿主开工作台「文件」时预置成工作空间目录；
  // 消费即清，load 失败内部 toast 后停留根目录视图）。
  onMount(() => {
    let p0 = initialPath ?? ui.filesPath ?? '';
    if (initialPath == null) ui.filesPath = null;
    // Dimensio Projects 是给「新建项目」用的捷径，在文件管理器里它只是主目录下的一个文件夹
    const fetchLocs = () => api.projectLocations().then((r) => {
      const list = (r?.locations || []).filter((l) => l && l.id && l.path && l.id !== 'dimensio');
      cloudLocs = list;
      locsPending = false;
      LOC_CACHE.list = me.kind === 'admin' ? list : null;
      if (me.kind === 'admin') rememberLocs(list);
      if (cloudLocId !== 'ws' && !list.some((l) => l.id === cloudLocId)) selectCloudLoc('ws');   // 那个盘拔掉了
      return list;
    }, (e) => { locsPending = false; throw e; });
    // 起点落位：startRoot + 初始相对路径 → 最深的那个位置 + 位置内相对路径
    const settle = (list) => {
      const hit = resolveStart(list, joinAbs(startRoot, p0));
      if (!hit) return false;
      fenced = false; cloudLocId = hit.loc.id; p0 = hit.rel;
      return true;
    };
    let p;
    if (desktopNative) {
      nativeWorkspaceLocations().then((list) => {
        desktopLocations = list || [];
        if (!desktopLocations.some((item) => item.id === desktopLocationId)) desktopLocationId = 'primary';
      }).catch(() => {});
    } else if (canStart) {
      // 有上次的位置表：当帧落位、后台对账；没有就等位置表到了再落（拉不到＝留在围栏形态）
      if (LOC_CACHE.list && settle(LOC_CACHE.list)) fetchLocs().catch(() => {});
      else p = fetchLocs().then(settle, () => false).then(() => load(p0));
    } else if (cloudLocsOn) fetchLocs().catch(() => {});
    // initialOpen：列表就位后自动打开指定文件的面板内预览（文件产物卡/正文链接
    // 「在工作区里打开」走它）。一次性；列表里找不到（已删/改名）就安静停在目录。
    p ||= load(p0);
    if (initialOpen) Promise.resolve(p).then(() => {
      const it = items.find((f) => !f.isDir && f.name === initialOpen);
      if (it) P.openFile(it);
    }).catch(() => {});
    // 「这台电脑」分页是挂载后才切进去的：壳能列本机文件就先订上，事件来了再看此刻是不是原生通道
    if (!desktopNative && !(isNativeDesktop() && hasPcLocalFs())) return;
    let refreshTimer = 0, searchTimer = 0;
    const parentOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
    // 壳按目录推 { locationId, type, path, dir }；type='resync'＝系统通知缓冲区溢出（一下子变了太多），
    // 壳把有人看过的目录各推一条整体作废。后台连续写盘时一秒能来几十条，只认跟眼前这一屏有关的。
    const off = onNativeWorkspaceChanged((event) => {
      if (!desktopNative || (pcLocal && pcHome)) return;
      if (String(event?.locationId || 'primary') !== desktopLocationId) return;
      const changedDir = String(event?.dir || '');
      const resync = event?.type === 'resync';
      // 搜索结果可能落在位置里任何地方：任何变化都重搜，但 300ms 防抖，不跟着每条事件重跑索引查询
      if (q) {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const needle = q, locationId = desktopLocationId;
          if (!needle) return;
          try {
            const result = await nativeWorkspaceSearch(needle, locationId);
            if (q !== needle || desktopLocationId !== locationId) return;
            desktopMatches = result?.items || [];
            hydrateDesktopThumbs(desktopMatches, locationId, true);
          } catch {}
        }, 300);
      }
      // 列表：当前目录里增删改，或直接子目录里有变化（那一行的修改时间跟着变）；resync 无条件重列。
      // 主进程缓存已经主动失效，这里不再出现网络 loading，只做一次帧后对账。
      if (!resync && changedDir !== path && !(changedDir && parentOf(changedDir) === path)) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => load(path), 34);
    });
    return () => { clearTimeout(refreshTimer); clearTimeout(searchTimer); off?.(); };
  });
  // 换位置 / 面板卸载：告诉壳这个位置的目录监听可以先淘汰（老壳没这个方法就跳过）
  $effect(() => {
    const id = desktopLocationId;
    if (!desktopNative) return;
    return () => nativeWorkspaceRelease(id);
  });

  // —— 搜索 ——
  function openSearch() {
    if (pcLocal && pcHome) { toast(t('先进入一个位置再搜索')); return; }   // 搜索是在某个位置里按名字找
    searching = true; setTimeout(() => searchEl?.focus(), 60);
  }
  function closeSearch() { searching = false; query = ''; }
  // 云端目录被截断（上千项只回了前 1500）时，搜索改问服务端：它在整个目录里按名字筛完再截，
  // 截掉的那部分才找得到。没截断的目录照旧在已到手的列表里就地筛，不多发请求。
  let srvMatches = $state(null);     // 服务端筛出来的结果；null＝这次搜索没走服务端
  let srvSearchBusy = $state(false);
  $effect(() => {
    const needle = q, dir = path, root = cloudRoot;
    if (!needle || !listMeta.truncated || isLocal || desktopNative) { srvMatches = null; srvSearchBusy = false; return; }
    srvSearchBusy = true;
    let dead = false;
    const timer = setTimeout(async () => {
      try { const r = await api.files(dir, root, { q: needle }); if (!dead) srvMatches = r.items || []; }
      catch { if (!dead) srvMatches = []; }
      finally { if (!dead) srvSearchBusy = false; }
    }, 220);
    return () => { dead = true; clearTimeout(timer); };
  });
  $effect(() => {
    const needle = q;
    const locationId = desktopLocationId;
    if (!desktopNative || !needle) { desktopMatches = []; desktopSearchBusy = false; return; }
    desktopSearchBusy = true;
    const timer = setTimeout(async () => {
      try {
        const result = await nativeWorkspaceSearch(needle, locationId);
        if (q !== needle || desktopLocationId !== locationId) return;
        desktopMatches = result?.items || [];
        hydrateDesktopThumbs(desktopMatches, locationId, true);
      } catch { if (q === needle && desktopLocationId === locationId) desktopMatches = []; }
      finally { if (q === needle && desktopLocationId === locationId) desktopSearchBusy = false; }
    }, 160);
    return () => clearTimeout(timer);
  });

  async function hydrateDesktopThumbs(list, locationId, search = false) {
    // 文件夹沿用 Bridge 原来的统一蓝色文件夹图标；系统缩略图只用于文件。
    const candidates = list.filter((item) => !item.isDir).slice(0, 80);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const item = candidates[cursor++];
        try {
          const result = await nativeWorkspaceThumbnail(item.rel || itemRel(item), item.isDir ? 48 : 72, locationId);
          // 尺寸必须一起留着：主进程对没有缩略图提供程序的类型（.md/.log/.ps1…）会从
          // createThumbnailFromPath 回落到 app.getFileIcon，而它在 Windows 上封顶 32×32
          // ——不管请求多大都只给 32（实测 32/64/96/128/256 全回 32×32）。渲染层据此
          // 区分「系统类型图标」和「真缩略图」，前者绝不能按后者那样铺满裁切。
          if (result?.dataUrl) {
            item.nativeThumb = result.dataUrl;
            item.nativeThumbW = result.width || 0;
            item.nativeThumbH = result.height || 0;
          }
        } catch {}
      }
    }));
    if (desktopLocationId !== locationId) return;
    if (search) desktopMatches = [...desktopMatches];
    else items = [...items];
  }

  async function refreshDesktopLocations() {
    try { desktopLocations = await nativeWorkspaceLocations(); } catch {}
    if (!pcAvail) return;
    // 这台电脑主页的副标题＝各位置的完整路径（同一个 inspect 口子，按 id 记住）
    for (const loc of desktopLocations) {
      if (pcLocAbs[loc.id]) continue;
      nativeWorkspaceInspect('', loc.id).then((r) => { if (r?.absolutePath) pcLocAbs = { ...pcLocAbs, [loc.id]: r.absolutePath }; }).catch(() => {});
    }
  }
  async function addDesktopLocation() {
    addOpen = false;
    try {
      const result = await nativeWorkspaceAddLocation();
      await refreshDesktopLocations();
      if (!result?.canceled && result?.location?.id) {
        desktopLocationId = result.location.id;
        pcHome = false;
        query = ''; searching = false;
        await load('');
      }
    } catch (e) { toast(t('添加位置失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function selectDesktopLocation(locationId) {
    if (locationId === desktopLocationId && !(pcLocal && pcHome)) return;
    desktopLocationId = locationId;
    pcHome = false;
    query = ''; searching = false; selecting = false; selected = new Set();
    await load('');
  }
  async function removeDesktopLocation(location) {
    // 英文按 GLOSSARY §1.6 让确认钮复述动词；中文不传 okLabel，仍是 uiConfirm 默认的「确定」
    if (!location?.removable || !(await uiConfirm(t('从 Bridge 移除「{name}」？', { name: location.name }), { detail: t('不会删除其中的文件。'), okLabel: isEn() ? t('移除') : undefined }))) return;
    try {
      await nativeWorkspaceRemoveLocation(location.id);
      if (desktopLocationId === location.id) desktopLocationId = 'primary';
      await refreshDesktopLocations();
      await load('');
    } catch (e) { toast(t('移除位置失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // 这台电脑的位置主页：清掉当前目录的一切（多选/搜索/列表），只摆位置卡片
  function showPcHome() {
    loadSeq++;
    pcHome = true;
    if (selecting) exitSelect();
    searching = false; query = '';
    path = ''; items = []; loading = false; shownKey = null; loadErr = ''; listMeta = NO_META;
    if (scroller) scroller.scrollTop = 0;
    scrolled = false;
  }
  async function revealPcLoc(loc) {
    pcLocMenu = null;
    try { await nativeWorkspaceReveal('', loc.id); }
    catch (e) { toast(t('定位失败：{reason}', { reason: tr(e.message || '') })); }
  }
  function removePcLoc(loc) { pcLocMenu = null; removeDesktopLocation(loc); }

  // —— 多选 ——
  function enterSelect(seedName) { selecting = true; selected = new Set(seedName ? [seedName] : []); }
  function exitSelect() { selecting = false; selected = new Set(); }
  function toggleSel(name) {
    const s = new Set(selected);
    s.has(name) ? s.delete(name) : s.add(name);
    selected = s;
  }

  expose(createPanelDrag(P));
  // 长按 / 右键：菜单从按压点弹出（MorphMenu 长按形态，视口坐标；它自己换算到所在容器、夹进容器边界——
  // 本页内嵌进 Claude 工作台时外面那层 .dk-embed 带 transform，容器不是整块视口）。
  // 长按抬起后浏览器补发的那下 click 由 MorphMenu 当场就挡上的压暗层接住，不会秒关、也不会点穿到底下的行。
  function openMenu(e, item) {
    if (wsPick) return;                // 选择器形态没有长按菜单（长按＝起拖）
    P.pressTimer = null;
    try { navigator.vibrate?.(8); } catch {}
    menuHead = item;
    menu = { item, point: { x: e.clientX, y: e.clientY } };
  }
  // 行尾「…」：点一下从按钮本身长出来（按钮菜单形态）
  function openDots(e, item) {
    if (wsPick) return;
    menuHead = item;
    menu = menu ? null : { item, anchor: e.currentTarget };
  }
  // 菜单头部（缩略图 + 名字 + 大小 · 日期）：菜单收起动画期间 menu 已清空，头部还得在，所以单记一份不清
  let menuHead = $state(null);
  expose(createPanelOps(P));
  expose(createPanelView(P));

  // —— toast ——
  let toastTimer = null;
  // 查看器开着时（查看器里的改名 / 删除）提示改走查看器自己的 toast 层：本页的提示在 z 300 的查看器下面
  let toastOut = null;
  async function viaViewer(vctx, fn) {
    if (!vctx?.toast) return fn();
    toastOut = (m) => vctx.toast(m, { kind: isWarnText(m) ? 'err' : 'ok', ms: isWarnText(m) ? 3600 : 2200 });
    try { return await fn(); } finally { toastOut = null; }
  }
  function toast(m) {
    if (toastOut) { toastOut(m); return; }
    toastMsg = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastMsg = ''), toastWarn ? 4200 : 2200);
  }
  // 失败/受限类提示别再配绿勾：按文案判（几十个调用点，逐个传 kind 不值当）；进行中（…结尾）不带图标。
  // 英文界面另配一条：同一批提示的译文（字典 en/files-panel.js 的 Couldn’t / Can’t / … first 等），只在英文下判，中文判定不受影响。
  const isWarnText = (m) => /失败|没能|不支持|不能|无法|太多|过大|需在|请先|开发中/.test(m)   // i18n-ignore 匹配中文文案
    || (isEn() && /couldn[’']t|can[’']t|failed|not supported|isn[’']t supported|mobile app only|location first|in development|went wrong/i.test(m));
  const toastWarn = $derived(isWarnText(toastMsg));
  const toastBusy = $derived(/…$/.test(toastMsg));

  function onScroll() { scrolled = scroller && scroller.scrollTop > 36; edgeOn = !!scroller && scroller.scrollTop > 4; }

  function refreshRoots() { roots = multiRoot ? localRoots() : []; }
  function pickWs(w) {
    if (w === ws) return;
    if (selecting) exitSelect();
    searching = false; query = ''; addSheet = false; rootMenu = null; pcLocMenu = null;
    if (w === 'local' && pcAvail) {
      // 电脑客户端连远端服务端：「本地」＝这台电脑，先到位置主页（同手机本地的「本地位置」）
      ws = 'local';
      showPcHome();
      refreshDesktopLocations();
      return;
    }
    if (w === 'local') {
      if (!localAvail) { toast(t('本地工作空间需在手机 App 内使用')); return; }
      ws = 'local';
      if (multiRoot) {
        refreshRoots();
        if (roots.length) { localPicked = true; load(''); }             // 显示「本地位置」主页
        else { localPicked = false; items = []; loading = false; path = ''; }
      } else {
        if (hasLocalRoot()) { localPicked = true; load(''); }           // 旧 apk 单根：直接进
        else { localPicked = false; items = []; loading = false; path = ''; }
      }
      return;
    }
    ws = 'cloud'; load('');
  }
  // 追加一个手机文件夹为新位置（新旧 apk 通用；新 apk 会追加、旧 apk 覆盖单根）。
  async function doPickLocal() {
    if (localPicking) return;
    localPicking = true;
    const ok = await pickLocalRoot();
    localPicking = false; addSheet = false;
    if (multiRoot) { refreshRoots(); if (roots.length) { localPicked = true; load(''); } }
    else if (ok) { localPicked = true; load(''); }
  }
  // 授权整个手机存储（作为一个「整机」位置）。
  async function doPickAll() {
    if (localPicking) return;
    localPicking = true;
    const ok = await requestAllFiles();
    localPicking = false; addSheet = false;
    if (multiRoot) { refreshRoots(); if (roots.length) { localPicked = true; load(''); } }
    else if (ok) { localPicked = true; load(''); }
  }
  // 重新选择：开选择器选新的，选到了才替换旧位置（取消则原位置保留）。
  async function doReselect(root) {
    rootMenu = null;
    if (localPicking) return;
    localPicking = true;
    const before = new Set(roots.map((r) => r.id));
    await pickLocalRoot();
    localPicking = false;
    refreshRoots();
    if (roots.some((r) => !before.has(r.id))) { removeLocalRoot(root.id); refreshRoots(); }
    if (roots.length) { localPicked = true; load(''); }
    else { localPicked = false; items = []; path = ''; }
  }
  // 移除一个位置（不删手机上的文件）。
  async function doRemove(root) {
    rootMenu = null;
    if (!(await uiConfirm(t('移除「{name}」？', { name: root.name }), { detail: t('不会删除手机上的文件。'), okLabel: isEn() ? t('移除') : undefined }))) return;
    removeLocalRoot(root.id);
    refreshRoots();
    if (!roots.length) { localPicked = false; items = []; path = ''; }
    else load('');
  }
  // 电脑位置里直接给 Windows 完整路径（整机范围里「C 盘 / Users / …」不如一眼能复制的路径有用）
  const infoLocation = $derived(infoItem ? (atPcLoc && !isLocal ? winAbs(cloudRoot, infoItem.dir || '')
    : rootLabel + (infoItem.dir ? ' / ' + infoItem.dir.split('/').join(' / ') : '')) : '');
</script>


{#snippet mhead()}
  {#if menuHead}
    {@const it = menuHead}
    <div class="mhead">
      <span class="mh-th" class:dir={it.isDir}>
        {#if it.isDir}
          <img class="mh-fold" src={wsIcon} alt="" draggable="false" />
        {:else if P.iconThumb(it)}
          <img class="mh-ricon" src={it.nativeThumb} alt="" draggable="false" />
        {:else}
          <span class="mh-ic">{@html typeIconSvg(it.name)}</span>
          {#if P.cellThumbable(it)}<img class="mh-img" src={P.thumbSrc(it)} alt="" decoding="async" draggable="false" data-cloud={isLocal ? undefined : '1'} onload={P.thumbOk} onerror={P.thumbErr} />{/if}
        {/if}
      </span>
      <span class="mh-tx">
        <span class="mh-nm">{it.name}</span>
        <span class="mh-sub">{[it.isDir ? P.cellSub(it) : fmtSize(it.size), fmtTime(it.mtime)].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
  {/if}
{/snippet}


<div class="ws-root" class:narrow={rootW < 388} class:wpick={wsPick} class:embedded={embeddedUi} class:chrome={hostChrome} class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} class:ios-dark={iosDark} class:modal={!!(menu || addOpen || locMenu || crumbMenu || transferOpen || renameTarget || mkOpen || mdOpen || zipDlg || shareDlg || rootMenu || pcLocMenu || addSheet || ai.item || P.picker || infoItem || preview || viewMenu)} style:--sq={`url("${sq26}")`} bind:this={rootEl} bind:clientWidth={rootW} ondragover={P.dragOverRoot} ondragleave={P.dragLeaveRoot} ondrop={P.onDropUpload} role="presentation">
  <!-- 从桌面拖文件/文件夹进来：整块提示；拖在某个文件夹格子上时改说传进那个文件夹 -->
  {#if P.dropOn !== null}
    <div class="dropveil">
      <div class="dropveil-in">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span>{P.dropOn ? t('上传到「{name}」', { name: P.dropOn }) : t('上传到当前文件夹')}</span>
      </div>
    </div>
  {/if}
  <!-- 顶栏（kit「Toolbar - Top - iPhone」）：返回 + 添加 + 传输环，都是 kit 的 44 液态玻璃圆钮（GlassButton，
       与设置页同一张烘焙玻璃）；底下一层滚动边缘效果（Scroll Edge Effect - Soft）把滚上来的内容重度模糊。
       分享只读＝只留传输环当下载指示；根目录连返回键也不出——没有主页可回。 -->
  <div class="edge" class:on={edgeOn}></div>
  <div class="topbtns" class:fusing={topFusing}>
    {#if hostChrome ? canBack : !readonly || segs.length}
      <GlassButton bind:el={backBtn} symbol="chevron.backward" weight={600} aria={hostChrome && !searching && !selecting ? t('上一级') : t('返回')} onclick={back} />
    {/if}
    {#if locPill && !selecting}
      <GlassButton bind:el={locBtn} aria={t('位置：{name}', { name: pillLabel })} onclick={(e) => (locMenu = locMenu ? null : anchorBelow(e))}>
        <span class="lp-in">
          <span class="lp-ic">{@html locGlyph(cloudLoc || { id: cloudLocId })}</span>
          <span class="lp-nm">{pillLabel}</span>
          <span class="lp-chev"><Sym name="chevron.up.chevron.down" weight={600} size={12} /></span>
        </span>
      </GlassButton>
    {/if}
    <div style="flex:1"></div>
    {#if wsPick}
      <!-- 选择器只留「新建文件夹」：要一个全新的空项目就在这儿建，建完拖进底栏即可 -->
      <GlassButton symbol="plus" weight={500} aria={t('新建文件夹')} onclick={() => (mkOpen = { value: '' })} />
    {:else if pcLocal}
      <!-- 这台电脑：主页上＋＝授权一个新文件夹；位置里＝导入/新建（都是本机原生操作，不走传输面板） -->
      <GlassButton bind:el={addBtn} symbol="plus" weight={500} aria={pcHome ? t('添加位置') : t('添加')} onclick={() => (pcHome ? addDesktopLocation() : (addOpen = !addOpen))} />
    {:else if !isLocal}
      {#if !readonly}
        <GlassButton bind:el={addBtn} symbol="plus" weight={500} aria={t('添加')} onclick={() => (addOpen = !addOpen)} />
      {/if}
      <GlassButton bind:el={xferBtn} round aria={t('传输')} onclick={() => (transferOpen = !transferOpen)}>
        <span class="xfer" class:alldone={allDone}>
          <svg class="ringsvg" viewBox="0 0 44 44">
            <circle class="track" cx="22" cy="22" r="17" />
            <circle class="prog" cx="22" cy="22" r="17" stroke-dasharray="106.8" stroke-dashoffset={106.8 * (1 - ringPct)} />
          </svg>
          <svg class="arrows" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.5 6.5V13.5M4.5 13.5L2 11M4.5 13.5L7 11" /><path d="M11.5 9.5V2.5M11.5 2.5L9 5M11.5 2.5L14 5" />
          </svg>
          {#if activeTasks.length}<span class="badge">{activeTasks.length}</span>{/if}
        </span>
      </GlassButton>
    {:else if multiRoot && localPicked}
      <GlassButton bind:el={addLocBtn} symbol="plus" weight={500} aria={t('添加本地位置')} onclick={() => P.openAddLoc(addLocBtn)} />
    {/if}
    {#if gridOn}
      <GlassButton bind:el={viewBtn} symbol="ellipsis" weight={500} aria={t('显示方式')} onclick={() => (viewMenu = !viewMenu)} />
    {/if}
  </div>

  <!-- 顶栏与路径条的下拉菜单：点一下就从按钮本身长出来（iOS 26 下拉按钮的液滴形变，kit Menu 材质）。
       菜单一直挂着、open 只管展开 / 收起，收起动画才放得完；平铺在 .ws-root 里（玻璃要采得到底下的列表）。 -->
  <MorphMenu open={addOpen} anchor={addBtn} neighbors={topBtns()} onfuse={onTopFuse} width={250} items={P.addItems} onclose={() => (addOpen = false)} />
  <MorphMenu open={!!locMenu} anchor={locBtn} neighbors={topBtns()} onfuse={onTopFuse} width={250} title={tc('files', '位置')} items={P.locItems} onclose={() => (locMenu = null)} />
  <MorphMenu open={!!crumbMenu} anchor={crumbBtn} width={250} items={P.crumbItems} onclose={() => (crumbMenu = null)} />
  <MorphMenu open={addSheet} anchor={addLocAnchor} neighbors={topBtns()} onfuse={onTopFuse} width={250} title={t('添加本地位置')} items={P.addLocItems} onclose={() => (addSheet = false)} />
  <MorphMenu open={!!rootMenu} anchor={rootMenu?.anchor || null} width={250} title={rootMenu?.root.name || ''} items={P.rootMenuItems} onclose={() => (rootMenu = null)} />
  <MorphMenu open={!!pcLocMenu} anchor={pcLocMenu?.anchor || null} width={250} title={pcLocMenu ? pcLocAbs[pcLocMenu.loc.id] || tr(pcLocMenu.loc.name) : ''}
    items={P.pcLocItems} onclose={() => (pcLocMenu = null)} />
  <MorphMenu open={viewMenu} anchor={viewBtn} neighbors={topBtns()} onfuse={onTopFuse} width={250} items={P.viewItems} onclose={() => (viewMenu = false)} />

  <!-- 滚动内容 -->
  <div class="scroll" bind:this={scroller} onscroll={onScroll} use:dragScrollGuard use:dropZone={P.hereZone} class:dnd-here={drag.overKey === 'ws-here'}>
    <!-- 紧凑面包屑条（取代 34pt 大标题，省垂直空间）：父段蓝色可点、当前段黑色加粗 -->
    <!-- 有位置胶囊时，位置根上不摆路径条（名字就在顶栏上），直接是内容 -->
    {#if !(locPill && !segs.length && !selecting)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pathbar" class:wp-path={wsPick} class:wp-lift={wsPick && pkDrag?.abs === pkAbs(path)}
      onpointerdown={wsPick ? (e) => P.pkDown(e, title, path, true) : undefined}
      onpointermove={wsPick ? P.pressMove : undefined}
      onpointerup={wsPick ? P.pressUp : undefined}
      onpointercancel={wsPick ? P.pressUp : undefined}>
      {#if wsPick}
        <!-- 路径条自己也是拖源：已经走进这个文件夹了、想选它本身，不必退回上一级去拖它 -->
        <span class="wp-grip" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
      {/if}
      {#if selecting}
        <span class="sel-count">{t('已选择 {n} 项', { n: selected.size })}</span>
      {:else}
        {#if pcLocal && !pcHome}<button class="pb-seg" onclick={showPcHome}>{t('这台电脑')}</button><span class="pb-sep">›</span>{/if}
        {#if locPill}
          <button class="pb-root" class:dnd-on={drag.overKey === 'ws-crumb:-1'} use:dropZone={P.crumbZone(-1)} aria-label={rootLabel} onclick={goRoot}>{@html locGlyph(cloudLoc || { id: cloudLocId })}</button>
        {:else}
          <button class="pb-seg" class:cur={!segs.length} class:dnd-on={drag.overKey === 'ws-crumb:-1'} use:dropZone={P.crumbZone(-1)} onclick={goRoot}>{#if readonly}<svg class="pb-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 13.7a4.2 4.2 0 0 0 6.1.3l2.4-2.4a4.2 4.2 0 0 0-5.9-5.9l-1.3 1.3" /><path d="M13.7 10.3a4.2 4.2 0 0 0-6.1-.3l-2.4 2.4a4.2 4.2 0 0 0 5.9 5.9l1.3-1.3" /></svg>{/if}{rootLabel}</button>
        {/if}
        {#if crumbHidden}<span class="pb-sep">›</span><button class="pb-more" bind:this={crumbBtn} aria-label={t('上级文件夹')} onclick={(e) => (crumbMenu = crumbMenu ? null : anchorBelow(e))}>…</button>{/if}
        {#each segs as s, i}{#if i >= crumbHidden}<span class="pb-sep">›</span>{#if i < segs.length - 1}<button class="pb-seg" class:dnd-on={drag.overKey === 'ws-crumb:' + i} use:dropZone={P.crumbZone(i)} onclick={() => goSeg(i)}>{segLabel(s, i)}</button>{:else}<span class="pb-seg cur" title={segLabel(s, i)}>{segLabel(s, i)}</span>{/if}{/if}{/each}
      {/if}
    </div>
    {/if}

    <PanelBody {P} />
  </div>

  <!-- 选择器底栏：唯一的「选定」落点。长按文件夹（或顶部路径条）拖到这条上松手＝创建。
       刻意不做点按兜底——点文件夹恒等于「进去」，让同一次点按可能是「选它」就永远分不清。 -->
  {#if wsPick}
    <div class="wpdock" class:over={pkDrag?.over} class:armed={!!pkDrag} bind:this={pkDockEl}>
      <div class="wpdock-in">
        <span class="wpd-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /><path d="M12 16.5v-5M9.6 13.6 12 11.2l2.4 2.4" /></svg>
        </span>
        <span class="wpd-lb">
          {#if pkDrag?.over}{t('松手即可创建')}{:else if pkDrag}{t('拖到这里松手')}{:else}{pickLabel}{/if}
        </span>
        {#if !pkDrag}<span class="wpd-sub">{t('长按文件夹拖进来')}</span>{/if}
      </div>
    </div>
  {/if}

  <!-- 拖拽幽灵：跟手的那一份。坐标是 .ws-root 局部坐标（内嵌时外层带 transform，
       fixed 的包含块是容器不是视口——与长按菜单同一套换算）。 -->
  {#if pkDrag}
    <div class="wpghost" class:over={pkDrag.over} style="left:{pkDrag.x}px; top:{pkDrag.y}px">
      <img class="wpg-ic" src={wsIcon} alt="" draggable="false" />
      <span class="wpg-nm">{pkDrag.name || t('工作空间')}</span>
    </div>
  {/if}

  <!-- 底栏（分享只读整个不出：tab 切换/搜索/多选栏都是工作空间的事）。
       标签栏＝kit「Tab Bar - iPhone」：62 高胶囊，Liquid Glass - Regular - Small（tab62 三段切片烘焙玻璃），
       选中项垫一枚 Fills - Vibrant/Tertiary 胶囊、字形染 Accents/Blue；符号 18pt / 标签 10pt Semibold。
       右边搜索钮＝同材质 62 圆钮；搜索行＝kit「Toolbar - Bottom - iPhone / Search」（48 高）。 -->
  {#if !readonly && !wsPick}
  <div class="bottomwrap" class:searching class:selecting>
    <div class="bottombar">
      {#if !fenced && !guest}
        {#snippet tabCloud()}<span class="tab-ic">{@html G.cloud}</span><span class="lb">{t('工作空间')}</span>{/snippet}
        {#snippet tabLocal()}
          {#if pcAvail}<span class="tab-ic"><Sym name="desktopcomputer" weight={500} size={19} /></span><span class="lb">{t('这台电脑')}</span>
          {:else}<span class="tab-ic"><Sym name="iphone" weight={600} size={19} /></span><span class="lb">{t('本地')}</span>{/if}
        {/snippet}
        <!-- 指针手势挂在整条栏上（lib/liquid/tabs.js）；两层同样的 Tab：未选样式在指示器处挖洞、选中样式（染蓝）只在指示器里露出。
             上层的按钮只给键盘用（pointer-events: none），按下的透镜挂在 .ws-root 上压在栏之上 -->
        <div class="tabbar lg62" bind:this={tabBarEl} role="tablist" aria-label={t('工作空间')}>
          <span class="tabsel" bind:this={tabSelEl}></span>
          <div class="tabrow" bind:this={tabRowU}>
            <button class="tab" role="tab" aria-selected={ws === 'cloud'} onclick={() => pickWs('cloud')}>{@render tabCloud()}</button>
            <button class="tab" role="tab" aria-selected={ws === 'local'} onclick={() => pickWs('local')}>{@render tabLocal()}</button>
          </div>
          <div class="tabrow tabrow-s" bind:this={tabRowS} aria-hidden="true">
            <span class="tab">{@render tabCloud()}</span><span class="tab">{@render tabLocal()}</span>
          </div>
          <span class="tabglow" bind:this={tabGlowEl}></span>
        </div>
      {:else}<span></span>{/if}
      <button class="searchbtn lgo62" use:liquidPress aria-label={t('搜索')} onclick={openSearch}><Sym name="magnifyingglass" weight={600} size={20} /></button>
    </div>

    <div class="searchrow">
      <button class="closebtn" class:glass={!fg} class:fg use:liquidPress aria-label={t('关闭搜索')} onclick={closeSearch}><Sym name="xmark" weight={600} size={16} /></button>
      <div class="searchfield" class:glass={!fg} class:fg>
        <Sym name="magnifyingglass" weight={500} size={17} />
        <input bind:this={searchEl} bind:value={query} placeholder={t('搜索文件')} autocomplete="off" />
      </div>
    </div>

    <!-- 多选工具栏：同一张 62 高玻璃胶囊，按钮排法同 kit「Toolbar - Bottom - iPhone / Buttons」 -->
    <div class="selbar lg62">
      <button class="selact" onclick={() => toast(t('分享开发中'))}><Sym name="square.and.arrow.up" weight={400} size={19} /><span>{t('分享')}</span></button>
      <button class="selact" disabled={!selected.size || (isLocal && !localOps.move)} onclick={() => P.openMovePicker([...selected], 'move')}><span class="sa-ic">{@html G.folder}</span><span>{t('移动到')}</span></button>
      <button class="selact danger" disabled={!selected.size || (isLocal && !localOps.del)} onclick={P.multiDelete}><Sym name="trash" weight={400} size={19} /><span>{t('删除')}</span></button>
      <button class="selact done" onclick={exitSelect}><Sym name="checkmark" weight={600} size={18} /><span>{t('完成')}</span></button>
    </div>
  </div>
  {/if}

  <!-- 文件菜单：长按 / 右键从按压点弹出，行尾「…」从按钮长出来（同一份条目、同一套 kit Menu 材质） -->
  <MorphMenu open={!!menu} anchor={menu?.anchor || null} point={menu?.point || null} width={250} header={mhead}
    items={P.menuItems} onclose={() => (menu = null)} />

  <!-- 传输面板：从传输环长出来的玻璃面板（与菜单同一套液滴形变、同材质） -->
  <MorphMenu open={transferOpen} anchor={xferBtn} neighbors={topBtns()} onfuse={onTopFuse} width={Math.min(354, rootW - 28)} title={t('传输')} onclose={() => (transferOpen = false)}>
      <PanelTransfers {P} />
  </MorphMenu>

  <PanelSheets {P} />

  <!-- 提示条：kit 44 高玻璃胶囊（与顶栏按钮同一张烘焙玻璃），挂在顶栏中间 -->
  {#if toastMsg}<div class="toast" class:warn={toastWarn}>{#if toastWarn}<Sym name="exclamationmark.triangle.fill" weight={400} size={15} />{:else if !toastBusy}<Sym name="checkmark.circle.fill" weight={400} size={16} />{/if}<span>{toastMsg}</span></div>{/if}

  <input bind:this={fileInput} type="file" multiple onchange={P.onPick} style="display:none" />
</div>

<style>
  /* iOS 27（Apple「iOS and iPadOS 27」UI Kit，与设置页同一套取样：bridge build/design/ios27-settings）。
     独立手机页与内嵌进工作台（.embedded）都跟随明暗（.ios-dark，由 iosDark 算出）。
     颜色只走这些令牌；--i-* 是 components/ios27 那套 kit 组件读的同名令牌（Toggle / Segmented / TextField / Alert / Sheet）。 */
  .ws-root {
    --blue: #0088ff; --red: #ff383c; --green: #34c759; --orange: #ff8d28; --blue-soft: rgba(0,136,255,.1);
    --label: #000; --label2: rgba(60,60,67,.6); --label3: rgba(60,60,67,.3); --ink: #1a1a1a;
    --fill: rgba(120,120,128,.16); --fill3: rgba(118,118,128,.12); --field: rgba(120,120,128,.2);
    --bg: #f2f2f7; --card: #fff; --sep: #e6e6e6; --press: #d1d1d6; --paper: #fff;
    --glass-ink: #0c0c0e;                     /* kit Labels - Vibrant - Controls/Primary #1A1A1A LINEAR_BURN 落在玻璃上 */
    --tab-sel: rgba(0,0,0,.075);              /* kit Tab「Selection」Fills - Vibrant/Tertiary #EDEDED LINEAR_BURN 的等效 */
    --i-bg: var(--bg); --i-card: var(--card); --i-label: var(--label); --i-label2: var(--label2); --i-label3: var(--label3); --i-label4: rgba(60,60,67,.18);
    --i-sep: var(--sep); --i-fill1: rgba(120,120,120,.2); --i-fill2: rgba(120,120,128,.16); --i-fill3: rgba(118,118,128,.12); --i-fill4: rgba(116,116,128,.08);
    --i-press: var(--press); --i-seg-sel: #fff; --i-field: var(--field);
    --i-blue: var(--blue); --i-green: var(--green); --i-red: var(--red); --i-orange: var(--orange); --i-indigo: #6155f5; --i-pink: #ff2d55; --i-gray: #8e8e93;
    position: fixed; inset: 0; z-index: 40; background: var(--bg);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", system-ui, "PingFang SC", "Hiragino Sans GB", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif;
    color: var(--label); -webkit-font-smoothing: antialiased; user-select: none; -webkit-touch-callout: none; overflow: hidden;
    color-scheme: light;
  }
  .ws-root :global(svg) { display: block; }
  /* 内嵌进工作台且宿主是暗色：kit 暗色 grouped，底色对齐 Claude 的 #1f1f1e（维护者定的，不用 kit 的纯黑） */
  .ws-root.ios-dark {
    --blue: #0091ff; --red: #ff4245; --green: #30d158; --orange: #ff9230; --blue-soft: rgba(0,145,255,.18);
    --label: #fff; --label2: rgba(235,235,245,.7); --label3: rgba(235,235,245,.3); --ink: #f2f2f0;
    --fill: rgba(120,120,128,.32); --fill3: rgba(118,118,128,.24); --field: rgba(255,255,255,.12);
    --bg: #1f1f1e; --card: #2a2a29; --sep: #3d3d3c; --press: #3a3a3c; --paper: #2a2a29;
    --glass-ink: #fff; --tab-sel: rgba(255,255,255,.07);
    --i-label4: rgba(235,235,245,.16); --i-fill1: rgba(120,120,128,.36); --i-fill2: rgba(120,120,128,.32); --i-fill3: rgba(118,118,128,.24); --i-fill4: rgba(118,118,128,.18);
    --i-seg-sel: rgba(255,255,255,.27); --i-indigo: #6d7cff; --i-pink: #ff375f;
    color-scheme: dark;
  }

  /* 拖拽上传：整块虚线提示（pointer-events:none 让 dragover/drop 穿透到下面的文件夹格子，
     否则遮罩一盖住，「拖到某个文件夹上」就永远命中不了）+ 目标文件夹格子高亮 */
  .dropveil { position: absolute; inset: 8px; z-index: 60; pointer-events: none;
    display: flex; align-items: center; justify-content: center;
    border: 2px dashed var(--blue); border-radius: 26px; background: var(--blue-soft); }
  /* 文字压在文件夹格子上会糊成一片——收进一枚实底药丸，落在任何内容上都读得清 */
  .dropveil-in { display: flex; align-items: center; gap: 9px; padding: 11px 18px; border-radius: 999px;
    background: var(--paper); box-shadow: 0 6px 24px rgba(0,0,0,.16); color: var(--blue); font-size: 15px; font-weight: 600;
    max-width: 82%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dropveil-in svg { width: 20px; height: 20px; flex: none; }
  /* —— 全域拖拽的三处视觉：被拎走的原位 / 悬停在某一级面包屑 / 悬停在当前目录空白处 ——
     幽灵卡片由 DragLayer 画（全局唯一一层），这里只负责「源」和「落点」的状态。 */
  .pb-seg.dnd-on { background: var(--blue-soft); box-shadow: inset 0 0 0 1.5px var(--blue); border-radius: 8px; color: var(--blue); }
  .scroll.dnd-here { box-shadow: inset 0 0 0 2px rgba(0,136,255,.45); border-radius: 12px; }

  /* 旧毛玻璃配方：只剩 ?oldglass 调试开关退回去时用 */
  .glass { background: rgba(248,248,248,.55); backdrop-filter: blur(5px) saturate(1.9); -webkit-backdrop-filter: blur(5px) saturate(1.9);
    box-shadow: 0 0 0 .5px rgba(190,190,190,.5), 0 10px 22px rgba(0,0,0,.1), 0 2px 5px rgba(0,0,0,.05); }

  /* —— 顶栏：kit 44 玻璃圆钮（GlassButton）+ 滚动边缘效果 —— */
  /* 内嵌进工作台时 --sat 被宿主归零，顶栏玻璃钮会贴死在宿主的工具切换条下沿（相切，很挤）：
     留一段 --tbg 呼吸距离，内容 / 滚动边缘 / 锚在顶栏下的菜单都跟着下移同样的量（JS 侧见 TBG） */
  .ws-root { --tbg: 0px; }
  .ws-root.embedded { --tbg: 12px; }
  .ws-root.embedded.chrome { --tbg: 4px; }
  .topbtns { position: absolute; top: calc(var(--sat,0px) + var(--tbg)); left: 16px; right: 16px; height: 44px; z-index: 44; display: flex; align-items: center; gap: 12px; pointer-events: none; }
  .topbtns > :global(*) { pointer-events: auto; }
  /* 菜单把旁边的按钮融进去的那一段：整排抬到菜单玻璃（95）和内容（97）之上，不接点击（点到的是菜单的挡板） */
  .topbtns.fusing { z-index: 98; }
  .topbtns.fusing > :global(*) { pointer-events: none; }
  /* 滚动边缘效果（kit「Scroll Edge Effect - Soft」：顶上重度模糊 + 线性渐隐遮罩，同设置页 .edge） */
  .edge {
    position: absolute; left: 0; right: 0; top: 0; z-index: 43; height: calc(var(--sat,0px) + var(--tbg) + 76px); pointer-events: none; opacity: 0; transition: opacity 200ms linear;
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    background: linear-gradient(to bottom, color-mix(in srgb, var(--bg) 72%, transparent) 0%, color-mix(in srgb, var(--bg) 30%, transparent) 60%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%); mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%);
  }
  .edge.on { opacity: 1; }
  /* 菜单 / 表单页 / 警告框开着：它们自带一层 backdrop，页面上其余的让出去（同屏多层 backdrop，上层会静默失效） */
  .ws-root.modal :is(.edge, .lg62, .lgo62, .fg, .toast) { -webkit-backdrop-filter: none; backdrop-filter: none; }
  /* 没了模糊，边缘那层半透明底盖不住滚上来的字（宿主浮动标题行底下会叠出一行清晰的分组标题）：
     状态栏 / 浮动标题行（--sat）那段铺实底，往下照旧渐隐 */
  .ws-root.modal .edge {
    background: linear-gradient(to bottom, var(--bg) 0, var(--bg) calc(var(--sat,0px) + var(--tbg)), color-mix(in srgb, var(--bg) 55%, transparent) calc(var(--sat,0px) + var(--tbg) + 30px), transparent 100%);
  }
  /* 传输环：画在玻璃钮里面（GlassButton 的 children），环 + 上下箭头 + 角标 */
  .xfer { position: relative; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; }
  .xfer .ringsvg { position: absolute; inset: 0; width: 44px; height: 44px; transform: rotate(-90deg); }
  .xfer .track { fill: none; stroke: rgba(120,120,128,.24); stroke-width: 2.4; }
  .xfer .prog { fill: none; stroke: var(--blue); stroke-width: 2.4; stroke-linecap: round; transition: stroke-dashoffset .5s linear; }
  .xfer.alldone .prog { stroke: var(--green); }
  .xfer .arrows { width: 16px; height: 16px; }
  .xfer .badge { position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px; border-radius: 9px; background: var(--red); color: #fff; font-size: 12px; font-weight: 600; line-height: 18px; text-align: center; padding: 0 5px; }

  /* —— 滚动内容 ——
     container-type 挂在滚动区（容器查询只作用于【后代】，不能查自己）：本页既跑整页也内嵌在工作台侧栏里，
     格子分列必须看【容器】宽而不是视口宽——否则侧栏 300px 时会按 1280px 视口铺成 5 列。 */
  .scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; padding: calc(var(--sat,0px) + var(--tbg) + 58px) 0 calc(var(--sab,0px) + 104px); scrollbar-width: none; touch-action: pan-y;
    container-type: inline-size; }
  .scroll::-webkit-scrollbar { display: none; }
  /* 选择器底栏比标签栏高：内容区留够，别让最后一行文件夹钻到栏底下（拖不着） */
  .ws-root.wpick .scroll { padding-bottom: calc(var(--sab,0px) + 128px); }
  /* 面包屑条（取代 34pt 大标题，省垂直空间）：父段蓝色可点、当前段主色——字号取 kit 顶栏标题 17/22 Semibold */
  /* 面包屑条（取代 34pt 大标题，省垂直空间）：恒一行。父段次级色可点、当前段主色加粗——蓝色只留给顶栏的位置胶囊，
     一屏一个强调色。长名字各段自己省略号（当前段最后让），超过两级中间收成「…」。字号取 kit 顶栏标题 17/22。 */
  .pathbar { display: flex; align-items: center; gap: 4px; padding: 0 20px 8px; min-height: 26px; min-width: 0; white-space: nowrap; }
  .pb-seg { flex: 0 1 auto; min-width: 0; max-width: 46%; overflow: hidden; text-overflow: ellipsis; background: none; border: none; padding: 0;
    font: inherit; font-size: 17px; line-height: 22px; font-weight: 500; letter-spacing: -.43px; color: var(--label2); cursor: pointer; }
  /* 收缩量 ∝ flex-shrink × 宽：当前段让得更多，免得上一级被挤成「.bri…」 */
  .pb-seg.cur { flex-shrink: 4; max-width: none; font-weight: 600; color: var(--label); cursor: default; }
  .pb-seg:not(.cur):active { opacity: .55; }
  /* 位置的根在路径条里只是一枚字形（名字已经写在顶栏胶囊上了） */
  .pb-root { flex: none; width: 24px; height: 22px; display: inline-flex; align-items: center; justify-content: center; margin-left: -2px; padding: 0; border: 0; border-radius: 7px; background: none; color: var(--label2); cursor: pointer; }
  .pb-root :global(svg) { width: 19px; height: 19px; }
  .pb-root:active { opacity: .55; }
  /* 触屏：路径条的点按区扩到 44 高（视觉不变）。根字形与「…」用 ::after 外扩；段名要 overflow:hidden 出省略号、
     伪元素扩出去会被裁掉，改用上下 padding 撑高再用等量负 margin 抵掉，排版不动。拖放悬停时收回，免得高亮框变高 */
  @media (pointer: coarse) {
    .pb-root, .pb-more { position: relative; }
    .pb-root::after { content: ''; position: absolute; inset: -11px -10px; }
    .pb-more::after { content: ''; position: absolute; inset: -11px -7px; }
    .pb-seg:not(.cur):not(.dnd-on) { padding-block: 11px; margin-block: -11px; }
  }
  .pb-root.dnd-on { background: var(--blue-soft); box-shadow: inset 0 0 0 1.5px var(--blue); color: var(--blue); }
  .pb-more { flex: none; height: 22px; padding: 0 7px; border: 0; border-radius: 11px; background: var(--fill3); color: var(--label2); font: inherit; font-size: 15px; line-height: 22px; font-weight: 600; letter-spacing: 1px; cursor: pointer; }
  .pb-more:active { background: var(--fill); }
  .pb-share { width: 14px; height: 14px; margin-right: 5px; vertical-align: -1.5px; }
  .pb-sep { flex: none; color: var(--label3); font-size: 15px; }
  .sel-count { font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; color: var(--label); }

  /* 顶栏位置胶囊（kit pop-up button）：字形 + 位置名 + ⌃⌄，玻璃同顶栏圆钮；名字过长省略 */
  .lp-in { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: inherit; }
  .lp-ic { flex: none; display: inline-flex; color: var(--blue); }
  .lp-ic :global(svg) { width: 18px; height: 18px; }
  .lp-nm { min-width: 0; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; }
  .lp-chev { flex: none; display: inline-flex; opacity: .5; margin-left: -1px; }
  /* 窄档（rootW < 388：360 主流安卓 / 375 iPhone / 窄 sheet）：顶栏六枚（‹ 胶囊 ＋ 传输 …）宽档最少要 387px，
     放不下时「…」被切出右缘——胶囊收掉字形、钮间距收到 8（360 实测右缘正好落在 344） */
  .ws-root.narrow .topbtns { gap: 8px; }
  .ws-root.narrow .lp-ic { display: none; }
  .ws-root.narrow .lp-nm { max-width: 5.5em; }
  /* 再窄（320 档）收字形也不够：胶囊本身让出宽度，位置名省略（GlassButton 默认 flex:none） */
  .ws-root.narrow .topbtns > :global(.gb.cap) { flex: 0 1 auto; min-width: 0; }


  /* —— picker（新建项目选择器）形态 —— */
  /* 路径条＝「当前这个文件夹」本身的拖源：给它一块可按的底 + 左侧抓握点，让「这条也能拖」一眼看得出来。
     touch-action:none 是必须的——起拖后要靠 preventDefault 拦滚动，而 pan-y 的容器会先把这根手指判给滚动。 */
  .pathbar.wp-path { margin: 0 20px 8px; padding: 12px 16px; border-radius: 26px; background: var(--card); -webkit-mask-box-image: var(--sq) 42 / 42px; touch-action: none; cursor: grab; }
  .pathbar.wp-path:active { cursor: grabbing; }
  .wp-grip { width: 16px; height: 16px; color: var(--label3); flex: none; }
  .wp-grip svg { width: 100%; height: 100%; }
  /* 正在被拖走的那一份：原位淡下去，注意力跟着幽灵走 */
  .wp-lift { opacity: .34; }
  .wpdock { position: absolute; left: 0; right: 0; bottom: 0; z-index: 34;
    padding: 12px 16px calc(var(--sab,0px) + 14px);
    background: linear-gradient(to top, var(--bg) 62%, transparent); }
  .wpdock-in { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    min-height: 74px; border-radius: 26px; border: 2px dashed rgba(0,136,255,.42); background: var(--blue-soft);
    color: var(--blue); transition: background .16s ease, border-color .16s ease, transform .16s cubic-bezier(.22,1,.36,1); }
  .wpdock.armed .wpdock-in { border-color: rgba(0,136,255,.75); }
  /* 命中：实心蓝、微微放大——「松手就是它」这件事必须在指尖底下无歧义 */
  .wpdock.over .wpdock-in { border-style: solid; border-color: var(--blue); background: var(--blue); color: #fff; transform: scale(1.02); }
  .wpd-ic { width: 24px; height: 24px; }
  .wpd-ic svg { width: 100%; height: 100%; }
  .wpd-lb { font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; }
  .wpd-sub { font-size: 13px; line-height: 18px; opacity: .62; }
  .wpghost { position: absolute; z-index: 70; pointer-events: none; transform: translate(-50%, -50%) scale(1.04);
    display: flex; align-items: center; gap: 8px; max-width: 62%;
    padding: 8px 14px 8px 10px; border-radius: 18px; background: var(--card);
    box-shadow: 0 12px 30px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.10); }
  .wpghost.over { background: var(--blue); color: #fff; }
  .wpg-ic { width: 26px; height: 26px; object-fit: contain; flex: none; }
  .wpg-nm { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* 长按菜单的预览头 */
  .mhead { display: flex; align-items: center; gap: 12px; padding: 10px 14px 10px 12px; }
  .mh-th { position: relative; flex: 0 0 56px; width: 56px; height: 56px; border-radius: 10px; overflow: hidden; background: rgba(120,120,128,.16); display: flex; align-items: center; justify-content: center; color: inherit; }
  .mh-th.dir { background: none; }
  .mh-fold { width: 52px; height: 46px; object-fit: contain; }
  .mh-ricon { width: 28px; height: 28px; object-fit: contain; }
  .mh-ic { display: flex; opacity: .6; }
  .mh-ic :global(svg) { width: 28px; height: 28px; }
  .mh-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity var(--mo-quick) var(--ea-fade); }
  .mh-img:global(.ok) { opacity: 1; }
  .mh-th:has(> .mh-img:global(.ok)) .mh-ic { visibility: hidden; }   /* 透明 PNG 底下别透出类型图标 */
  .mh-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
  .mh-nm { font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.23px; color: inherit; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; word-break: break-word; }
  .mh-sub { font-size: 13px; line-height: 17px; color: inherit; opacity: .6; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* —— 底栏：kit Tab Bar（62 高胶囊）+ 搜索圆钮 + 搜索行 + 多选工具栏 ——
     玻璃＝构建期烘焙的「与底色无关」图层（Figma 原版管线跑 kit 的 Liquid Glass - Regular - Small，
     design/ios27-settings/tools/bake.mjs ws），::before 外扩 40 画；控件自身只留磨砂 6 换算的 backdrop 模糊（σ=6/√6）。 */
  .bottomwrap { position: absolute; left: 0; right: 0; bottom: calc(var(--sab,0px) + 25px); height: 62px; z-index: 30; }
  .bottombar { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 21px;
    transition: opacity .24s, transform .3s cubic-bezier(.32,.72,0,1); }
  .lg62 { position: relative; isolation: isolate; height: 62px; border-radius: 31px; color: var(--glass-ink);
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); }
  .lg62::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--ov-ios27-tab62-light) 0 216 fill / 0 72px / 40px stretch; }
  .ios-dark .lg62::before { border-image-source: var(--ov-ios27-tab62-dark); }
  .lgo62 { position: relative; isolation: isolate; flex: none; width: 62px; height: 62px; border-radius: 50%; border: 0; padding: 0; background: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center; color: var(--glass-ink); -webkit-tap-highlight-color: transparent;
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); transition: transform 420ms cubic-bezier(.3, 1.5, .45, 1); }
  .lgo62::before { content: ''; position: absolute; z-index: -1; inset: -40px; pointer-events: none; background: var(--ov-ios27-nav62-light) center / 142px 142px no-repeat; }
  .ios-dark .lgo62::before { background-image: var(--ov-ios27-nav62-dark); }
  /* 标签：kit「_Tab Bar Button - iPhone」——符号 18pt Semibold、标签 10/12 Semibold 字距 −0.1；选中垫胶囊 + 染蓝 */
  .tabbar { --tw: 104px; width: calc(2 * var(--tw) + 8px); flex: none; touch-action: pan-y; cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; }
  /* 选中垫片 / 两层 Tab / 光斑都按栏内局部坐标摆（lib/liquid/tabs.js 逐帧写 transform 与遮罩） */
  .tabsel { position: absolute; top: 0; left: 0; width: var(--tw); height: 54px; border-radius: 27px; background: var(--tab-sel); transform: translate(4px, 4px); pointer-events: none; }
  .tabrow { position: absolute; left: 4px; top: 4px; display: flex; pointer-events: none; }
  .tabrow-s { color: var(--blue); }
  .tabglow { position: absolute; inset: 0; border-radius: 31px; mix-blend-mode: plus-lighter; pointer-events: none; display: none; }
  .tab { position: relative; width: var(--tw); height: 54px; border: none; background: none; padding: 6px 8px 7px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
    color: inherit; border-radius: 27px; font: inherit; -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
  .tab:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
  .tab-ic { height: 28px; display: flex; align-items: center; justify-content: center; }
  .tab-ic :global(svg:not(.sym)) { width: 25px; height: 25px; }
  .tab .lb { font-size: 10px; line-height: 12px; font-weight: 600; letter-spacing: -.1px; }
  /* 320 一档的窄屏：两个标签收窄，给右边的搜索钮让出间距 */
  @media (max-width: 345px) { .tabbar { --tw: 88px; } .bottombar { padding: 0 16px; } }

  .searchrow { position: absolute; inset: 0; display: flex; align-items: center; gap: 12px; padding: 0 28px; opacity: 0; pointer-events: none; transform: translateY(8px) scale(.96); transition: opacity .26s, transform .3s cubic-bezier(.32,.72,0,1); }
  .bottomwrap.searching .bottombar { opacity: 0; pointer-events: none; transform: translateY(4px) scale(.97); }
  .bottomwrap.searching .searchrow { opacity: 1; pointer-events: auto; transform: none; }
  .closebtn { flex: 0 0 48px; width: 48px; height: 48px; border-radius: 50%; border: none; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--label); cursor: pointer; }
  /* min-width:0 + 输入框 width:0：否则输入框按 size=20 的固有宽度撑出最小宽度（安卓系统字体下更宽），
     360 宽的手机一聚焦搜索框就顶出屏幕右缘 */
  .searchfield { flex: 1; min-width: 0; height: 48px; border-radius: 24px; display: flex; align-items: center; gap: 6px; padding: 0 16px 0 14px; }
  .searchfield input { flex: 1; min-width: 0; width: 0; border: none; background: none; outline: none; height: 100%; font: inherit; font-size: 17px; letter-spacing: -.43px; color: var(--label); }
  .searchfield input::placeholder { color: var(--label3); }

  /* 搜索行的 Figma 液态玻璃（kit「Toolbar - Bottom - iPhone / Search」：48 高，Liquid Glass - Regular - Small）。
     ::before 外扩 24px 画构建期烘焙的「与底色无关」图层（做法见 bridge build/design/figma-glass-controls/bake.html，
     锚点＝本页底色 #f2f2f7 / 暗色 #1f1f1e），搜索框宽度随屏幕变：三段切片，两端各 64px 原样、中段逐列不变可拉伸。
     字色 = kit 标签色按其混合模式落在玻璃上的等效色：主色 #1a1a1a LINEAR_BURN → #0d0d0d，
     三级色 #bfbfbf LINEAR_BURN → #b1b1b3；暗色 #f5f5f5 / #404040 LINEAR_DODGE → #f5f5f5 / #747473。 */
  .fg { position: relative; isolation: isolate; background: none; -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); }
  .fg::before { content: ''; position: absolute; inset: -24px; z-index: -1; pointer-events: none; }
  .closebtn.fg { color: #0d0d0d; }
  .closebtn.fg::before { background: var(--ov-figma-glass-fp-orb48-light) center / 100% 100% no-repeat; }
  .searchfield.fg::before { border-style: solid; border-width: 0 64px; border-image: var(--ov-figma-glass-fp-cap48-light) 0 192 fill / 0 64px / 0 stretch; }
  .searchfield.fg, .searchfield.fg input { color: #0d0d0d; }
  .searchfield.fg input { caret-color: #0088ff; }
  .searchfield.fg input::placeholder { color: #b1b1b3; }
  .ios-dark .closebtn.fg { color: #f5f5f5; }
  .ios-dark .closebtn.fg::before { background-image: var(--ov-figma-glass-fp-orb48-dark); }
  .ios-dark .searchfield.fg::before { border-image-source: var(--ov-figma-glass-fp-cap48-dark); }
  .ios-dark .searchfield.fg, .ios-dark .searchfield.fg input { color: #f5f5f5; }
  .ios-dark .searchfield.fg input::placeholder { color: #747473; }

  /* 多选工具栏：同一张 62 高玻璃胶囊，四个「符号 + 10pt 标签」按钮均分 */
  .selbar { position: absolute; left: 21px; right: 21px; top: 0; display: flex; align-items: center; justify-content: space-around; padding: 0 8px; opacity: 0; pointer-events: none; transform: translateY(10px) scale(.96); transition: opacity .26s, transform .3s cubic-bezier(.32,.72,0,1); }
  .bottomwrap.selecting .selbar { opacity: 1; pointer-events: auto; transform: none; }
  .bottomwrap.selecting .bottombar { opacity: 0; pointer-events: none; }
  .selact { border: none; background: none; display: flex; flex-direction: column; align-items: center; gap: 2px; color: var(--blue); width: 76px; height: 54px; justify-content: center; border-radius: 27px; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .selact:active:not(:disabled) { background: var(--tab-sel); }
  .selact:disabled { color: var(--label3); }
  .selact.danger { color: var(--red); }
  .selact.danger:disabled { color: var(--label3); }
  .selact.done { color: var(--glass-ink); }
  .selact .sa-ic :global(svg) { width: 22px; height: 22px; }
  .selact > span:last-child { font-size: 10px; line-height: 12px; font-weight: 600; letter-spacing: -.1px; }

  /* 提示条：kit 44 高玻璃胶囊（cap44 三段切片，同顶栏按钮的烘焙玻璃），挂在顶栏下方正中（不压顶栏按钮） */
  .toast { position: fixed; top: calc(var(--sat,0px) + var(--tbg) + 52px); left: 50%; transform: translateX(-50%); z-index: 96; isolation: isolate;
    display: flex; align-items: center; gap: 7px; min-height: 44px; padding: 0 18px; border-radius: 22px; color: var(--glass-ink);
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px);
    font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.23px; animation: toastin .32s cubic-bezier(.25, 1.2, .4, 1);
    width: max-content; max-width: min(calc(100% - 32px), 560px); box-sizing: border-box; }
  .toast::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--ov-ios27-cap44-light) 0 210 fill / 0 70px / 40px stretch; }
  .ios-dark .toast::before { border-image-source: var(--ov-ios27-cap44-dark); }
  .toast > span { padding: 12px 0; overflow: hidden; text-overflow: ellipsis; }
  .toast :global(.sym) { color: var(--green); }
  .toast.warn :global(.sym) { color: var(--orange); }
  @keyframes toastin { from { opacity: 0; transform: translate(-50%, -10px) scale(.92); } }

</style>
