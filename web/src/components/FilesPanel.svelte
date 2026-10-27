<script>
  import { uiConfirm } from '../lib/dialogs.js';
  import { canDragOut, startDragOut } from '../lib/dragOut.js';
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
  import { onMount, setContext, untrack } from 'svelte';
  import GlassButton from './ios27/GlassButton.svelte';
  import Sym from './ios27/Sym.svelte';
  import Menu from './ios27/Menu.svelte';
  import Sheet from './ios27/Sheet.svelte';
  import Alert from './ios27/Alert.svelte';
  import Popover from './ios27/Popover.svelte';
  import TextField from './ios27/TextField.svelte';
  import Toggle from './ios27/Toggle.svelte';
  import Segmented from './ios27/Segmented.svelte';
  import sq26_pub from '../assets/ios27/squircle26.svg';
  import { ovUrl } from '../lib/overlay.svelte.js';
  // 平滑圆角遮罩、文件夹图标：公开版自带，私有 overlay 有同名原版就换成它
  const sq26 = $derived(ovUrl('ios27/squircle26.svg', sq26_pub));
  const wsIcon = $derived(ovUrl('assets/icons/workspace.png'));
  import { t, tc, tr, locale, isEn } from '../lib/i18n.js';
  import { ui, compose, vertex as vs, me, caps, session, agentOn, rootScreen, pluginOn } from '../lib/state.svelte.js';
  import { api, authHeaders, getToken } from '../lib/api.js';
  import { apiUrl, isOffline, mediaFallbackUrl } from '../lib/server.js';
  import { downloads, hasNativeDownload, startDownload, cancelDownload, openDownload, retryDownload, clearFinishedDownloads } from '../lib/downloads.svelte.js';
  import { uploads, startUpload, startTreeUpload, hasNativeUpload, pickNativeUpload, cancelUpload as cancelUp, retryUpload, clearFinishedUploads, onUploaded } from '../lib/uploads.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { openPreview as openPreviewRaw, cloudFileUrl } from '../lib/preview.svelte.js';
  import { openSession, newConversation } from '../lib/chat.svelte.js';
  // Gemini 的对话控制器属于功能扩展：经 services 按需加载（开着才加载），不静态 import。
  import { mods, ensureModule } from '../modules/services.svelte.js';
  import { getCachedSessions, getCachedVertexSessions } from '../lib/cache.js';
  import { titleFor } from '../lib/library.svelte.js';
  import { relTime } from '../lib/format.js';
  import { entriesFromDrop, walkEntries, groupByRoot, skipNote } from '../lib/dirDrop.js';
  import { hasLocalFs, hasLocalRoot, localRootName, pickLocalRoot, localList, localReadText, localReadB64, localImgDataUrl, localFileUrl, canAllFiles, requestAllFiles, hasOpenWith, openWith, hasShare, shareFile, hasMultiRoot, localRoots, removeLocalRoot, hasLocalDelete, hasLocalRename, hasLocalMove, hasLocalCopy, localDelete, localRename, localMove, localCopy, hasLocalThumb, localThumbUrl } from '../lib/localfs.js';
  import {
    isNativeDesktop, hasNativeWorkspaceOps, nativeWorkspaceList, nativeWorkspaceRelease, onNativeWorkspaceChanged,
    nativeWorkspaceLocations, nativeWorkspaceAddLocation, nativeWorkspaceRemoveLocation,
    nativeWorkspaceMkdir, nativeWorkspaceRename, nativeWorkspaceTrash,
    nativeWorkspaceMove, nativeWorkspaceCopy, nativeWorkspaceOpen, nativeWorkspaceOpenWith,
    nativeWorkspaceReveal, nativeWorkspaceInspect, nativeWorkspaceThumbnail,
    nativeWorkspaceSearch, nativeWorkspaceImportFiles, nativeWorkspaceImportDirectory,
    nativeWorkspaceSaveAs, nativeWorkspaceCreateFile, hasNativeCompressWizard, nativeCompressWizard,
  } from '../lib/nativeDesktop.js';
  import { reportUi, onAgentFs, onAgentGoto } from '../lib/uiReport.js';
  import { drag, dropZone, beginDrag, addToDrag, isDragging, dragScrollGuard, HOLD_MS, MOVE_TOL } from '../lib/dragdrop.svelte.js';
  import { folderDropZone, wsFilePayload } from '../lib/fileDrag.js';
  import {
    AI_NAMES, SHARE_TTLS, fileAiCapabilities, filterAiSessions, filterFilesByName,
    formatShareExpiry, loadAiSessions, normalizeFileQuery, sendFileToAi,
    shareClipboardText, shareRequest, shareResult,
    untitledMdName, withMdExt, COMPRESS_FORMATS, COMPRESS_LEVELS, loadCompressFormats, compressDefaultName, runCompress,
  } from '../lib/files-business.js';

  const BASE = import.meta.env.BASE_URL;

  // readonly = 公开分享只读模式（SharePage 传入）：隐藏所有写操作入口（上传/新建/重命名/
  // 删除/移动/复制/多选/发送 AI），只留浏览 + 预览 + 下载。服务端对 share 身份写接口也一律 401。
  // onExit：内嵌宿主（Claude 工作台把本页整体挂进右侧栏）传入——根部返回时交还宿主
  // （回工作台菜单），并跳过全局 closer 注册（安卓返回由宿主 dock 的瞬态层接管）。
  // guest = 聊天快照访客（/c/ 链接，工作台内嵌）：文件读写照常（服务端已把 cwd 锁死在快照桶），
  // 但去掉「不属于这个身份」的入口——手机本地(SAF)切页、分享链接铸造（/api/share 对 snap 401）、
  // 发送给 AI（会牵出 Vertex 这类快照够不着的东西）。
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
  // 内嵌态的文件预览/编辑也留在侧栏（host:'dock' → 侧栏内嵌 MediaViewer 实例接管，
  // 不再全屏）；独立分页维持全屏。影子包装：本文件所有 openPreview 调用点零改动。
  const openPreview = (items, idx) => openPreviewRaw(items, idx, { host: previewHost || (onExit ? 'dock' : 'app') });
  // 内嵌在工作台（Claude/Codex/dimensio 的侧列或底部 sheet）：跟随全站明暗；独立手机工作空间页维持固定浅色。
  // theme='light'|'dark'：宿主有自己的明暗档（dimensio）时强制跟宿主，左右两栏不许一明一暗。
  const embeddedUi = $derived(Boolean(onExit) || previewHost === 'dock');
  // 搜索行（关闭钮 + 搜索框）用 Figma iOS 27 kit 的液态玻璃（见样式区 .fg）；`?oldglass` 退回原毛玻璃配方
  const fg = typeof location === 'undefined' || !new URLSearchParams(location.search).has('oldglass');
  // iOS 27 kit 组件（components/ios27，与设置页同一套）按 'ios27' 上下文挑明暗两套烘焙玻璃。
  // 独立工作空间页固定浅色；内嵌进工作台时跟宿主（theme 强制档优先，否则跟全站 data-theme）。
  const iosDark = $derived(embeddedUi && (theme === 'dark' || (theme !== 'light' && ui.theme !== 'light')));
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
  const G = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>',
    folderAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
    zip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V7"/><path d="M12 11v5M12 16l-2.2-2.2M12 16l2.2-2.2"/></svg>',
    reveal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7h7l2 2h8v10h-17z"/><path d="M12 12v4M10 14h4"/></svg>',
    select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5 11 15.5 16.5 9.5"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.8 19a4.6 4.6 0 0 1-.6-9.16 5.8 5.8 0 0 1 11.2-1.32A4.9 4.9 0 0 1 16.6 19H6.8Z"/></svg>',
    pcAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h16v13H4z"/><path d="M8 3v3M16 3v3M12 10v5M9.5 12.5h5"/></svg>',
  };
  // 「发送给 AI」各目标的小图标（白字形，垫在 kit 彩色圆角方块上，同设置页 IconTile）
  const AI_IC = {
    claude: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2.5l2 6.1 6.1 1.9-6.1 2L12 18.5l-2-6 -6.1-2 6.1-1.9z"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2l4.6 2.8L10 14.8z" fill="#fff" stroke="none"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.5" fill="#fff" stroke="none"/><path d="M4 16.5l5-4 4 3 3-2 4 3"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M5 10v4M9 7.5v9M13 9v6M17 6v12M21 10v4"/></svg>',
    music: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="2.6" fill="#fff" stroke="none"/><circle cx="17" cy="16" r="2.6" fill="#fff" stroke="none"/></svg>',
    first: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 5.5v13" stroke-width="2.6"/></svg>',
    last: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M16.5 5.5v13" stroke-width="2.6"/></svg>',
    ref: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  };

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
  const LOC_CACHE = (window.__bridgeFilesLocs ||= { list: null });   // 上次拿到的位置：进页即出，不晚一拍冒出来
  let cloudLocs = $state(me.kind === 'admin' ? LOC_CACHE.list || [] : []);
  let cloudLocId = $state('ws');
  const cloudLoc = $derived(cloudLocs.find((l) => l.id === cloudLocId) || null);
  // 挂载时拍下（宿主换 ws 会按 key 重挂）；卸载后不再回读 props
  const startRoot = untrack(() => workspaceRoot);
  const canStart = untrack(() => !!startRoot && !readonly && !guest && !wsPick);
  let fenced = $state(!!startRoot);  // true＝以 startRoot 为根的老形态（起点尚未/无法落进某个位置）
  const cloudRoot = $derived(fenced ? startRoot : (cloudLoc && cloudLoc.id !== 'ws' ? cloudLoc.path : ''));
  const atPcLoc = $derived(!fenced && !!cloudRoot);   // 此刻在「电脑位置」里，而不是身份工作空间
  // target 在 root 之内 → root 相对路径（'/' 分隔，''＝就是根）；不在 → null。Windows 路径不分大小写
  function relUnderAbs(root, target) {
    const win = /^([a-z]:|\\\\)/i.test(String(root || ''));
    const norm = (p) => { const s = String(p || ''); return (win ? s.replace(/\//g, '\\') : s).replace(/[\\/]+$/, ''); };
    const cmp = (s) => (win ? s.toLowerCase() : s);
    const r = norm(root), tg = norm(target);
    if (cmp(tg) === cmp(r)) return '';
    if (!cmp(tg).startsWith(cmp(r) + (win ? '\\' : '/'))) return null;
    return tg.slice(r.length + 1).split(/[\\/]+/).filter(Boolean).join('/');
  }
  // 绝对路径落进哪个位置：取最深的那个（D:\Notes\x 落「工作空间」，不落 E:\）
  function resolveStart(list, abs) {
    let best = null;
    for (const loc of list || []) {
      const rel = relUnderAbs(loc.path, abs);
      if (rel != null && (!best || String(loc.path).length > String(best.loc.path).length)) best = { loc, rel };
    }
    return best;
  }
  const locLabel = (l) => (/^drive-/.test(l?.id || '') ? t('{d} 盘', { d: String(l.name || '').replace(/:$/, '') }) : tr(l?.name || ''));
  const LOC_GLYPH = {
    ws: '<path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9h12v-9"/>',
    home: '<circle cx="12" cy="8.4" r="3.4"/><path d="M5.2 19.5c.9-3.4 3.5-5.2 6.8-5.2s5.9 1.8 6.8 5.2"/>',
    drive: '<rect x="3.5" y="6.5" width="17" height="11" rx="2.6"/><path d="M7.2 13.6h.01M10.6 13.6h6.2"/>',
    dir: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>',
  };
  const locGlyph = (l) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${LOC_GLYPH[l?.id === 'ws' ? 'ws' : l?.id === 'home' ? 'home' : /^drive-/.test(l?.id || '') ? 'drive' : 'dir']}</svg>`;
  // Windows 形态的完整路径（简介里给人看的），盘根 'C:\' 拼子路径不能先剥尾分隔符
  const winAbs = (root, rel) => (rel ? (/[\\/]$/.test(root) ? root : root + '\\') + rel : root).replace(/\//g, '\\');
  const scoped = (url) => cloudRoot ? url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(cloudRoot) : url;

  let path = $state('');           // 当前相对路径（'' = 根）
  let items = $state([]);
  let loading = $state(true);
  let scrolled = $state(false);
  let scroller = $state();

  let query = $state('');
  let searching = $state(false);
  let searchEl = $state();

  let selecting = $state(false);
  let selected = $state(new Set());

  let rootEl = $state();           // 根元素：长按菜单换算 fixed 定位坐标系用（见 openMenu）
  let menu = $state(null);         // 长按菜单 { item, x, y, ox, oy }（x/y 是【局部】坐标）
  let menuArmed = false;           // 菜单出现 300ms 后才响应点击（防长按抬起的 click 误触/秒关）
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
  let pkTimer = null, pkFrom = null, pkPid = -1;
  // 盘根 'E:\' 直接去掉尾分隔符会变成 'E:'——那在 Windows 上是「E 盘的当前目录」而不是根，
  // path.resolve('E:','x') 能拼出完全不相干的路径。所以只在没有尾分隔符时才补一个。
  const joinAbs = (base, rel) => {
    const b = String(base || '');
    if (!rel) return b;
    return /[\\/]$/.test(b) ? b + rel : b + '/' + rel;
  };
  const pkAbs = (rel) => joinAbs(workspaceRoot, rel);

  let ws = $state('cloud');        // cloud=PC 文件系统 / local=手机本地（SAF）
  const localAvail = $derived(!fenced && hasLocalFs()); // 围栏形态固定在 ws 根，不混入手机 SAF 位置
  const canOpenWith = hasOpenWith(); // 原生「打开方式」可用（离线 apk 壳内；dev/在线壳=false，菜单项不显示）
  const canShare = hasShare();       // 原生「分享」可用（同上）
  // 本地写操作能力（新 apk 原生接口）：旧 apk 缺哪个就隐藏哪个菜单项/禁用哪个多选钮。
  const localOps = { del: hasLocalDelete(), rename: hasLocalRename(), move: hasLocalMove(), copy: hasLocalCopy() };
  let aiPick = $state(null);         // 「发送给 AI」选目标的 item
  let aiView = $state('root');       // 菜单层级：root（Claude/Vertex）/ vertex（子菜单）/ chat（选择对话）
  let aiChat = $state(null);         // 「选择对话」层：{ target, from, sessions, loading, q }
  let localPicked = $state(false); // 本地工作空间已有 ≥1 个位置
  let localPicking = $state(false);
  const isLocal = $derived(ws === 'local');
  // —— 多根「本地位置」——
  const multiRoot = hasMultiRoot();  // 新 apk（支持多个本地位置）；旧 apk=false 走单根旧流程
  let roots = $state([]);            // 本地位置列表 [{id,name,mode}]
  let addSheet = $state(false);      // 「添加本地位置」sheet
  let rootMenu = $state(null);       // 位置管理菜单 { root }
  const atHome = $derived(isLocal && multiRoot && localPicked && path === '');   // 「本地位置」主页
  const rootMap = $derived(Object.fromEntries(roots.map((r) => [r.id, r.name]))); // 根 id → 显示名
  let tasks = $state([]);          // 分享页的跟踪下载（传输面板；上传行在 uploads 引擎里）
  let transferOpen = $state(false);
  let toastMsg = $state('');
  let fileInput = $state();
  const desktopNative = $derived(isNativeDesktop() && !workspaceRoot && !readonly && !guest && hasNativeWorkspaceOps());
  let desktopLocationId = $state('primary');
  let desktopLocations = $state([]);
  let desktopMatches = $state([]);
  let desktopSearchBusy = $state(false);
  const desktopLocation = $derived(desktopLocations.find((item) => item.id === desktopLocationId));
  const desktopExtra = $derived(desktopNative && desktopLocationId !== 'primary');
  const cloudLocsOn = $derived(!fenced && !readonly && !guest && !wsPick);   // 这一形态有没有「电脑位置」这回事
  const showCloudLocs = $derived(cloudLocsOn && !isLocal && !desktopNative && cloudLocs.length > 1);
  // 位置胶囊：顶栏返回键右边那枚「⌂ 主目录 ⌃⌄」——「在电脑的哪儿」恒在手边，任何深度都能一下换盘，
  // 不必先退回根目录找那排位置钮。菜单里另有一行「对话文件夹」：起点（会话目录）走远了一键回去。
  const locPill = $derived(showCloudLocs);
  const pillLabel = $derived(cloudLoc ? (cloudLoc.id === 'ws' ? t('工作空间') : locLabel(cloudLoc)) : t('工作空间'));
  let locMenu = $state(null);      // { x, y }
  const convAbs = $derived(canStart && !fenced ? startRoot : '');
  const convName = $derived(convAbs ? (String(convAbs).split(/[\\/]/).filter(Boolean).pop() || convAbs) : '');
  function goConv() {
    const hit = resolveStart(cloudLocs, convAbs);
    if (hit) selectCloudLoc(hit.loc.id, hit.rel);
  }
  const locItems = $derived([
    ...cloudLocs.map((l) => ({
      label: l.id === 'ws' ? t('工作空间') : locLabel(l), icon: locGlyph(l), checked: l.id === cloudLocId,
      onclick: () => { locMenu = null; selectCloudLoc(l.id); },
    })),
    ...(convAbs ? [{ sep: true }, { label: t('对话文件夹'), detail: convName, icon: G.folder, onclick: () => { locMenu = null; goConv(); } }] : []),
  ]);
  // 菜单锚在触发它的那枚按钮下方：按 .ws-root 局部坐标算（内嵌时外层有 transform，fixed 的包含块是容器）
  function anchorBelow(e) {
    const r = e.currentTarget.getBoundingClientRect(), o = rootEl?.getBoundingClientRect() || { left: 0, top: 0 };
    return { x: Math.max(12, Math.min(r.left - o.left, rootW - 12 - 250)), y: r.bottom - o.top + 8 };
  }
  let loadErr = $state('');        // 当前目录打不开的原因（没权限等）：空态显示它，而不是「这个文件夹是空的」

  // —— 面包屑 / 分组 / 派生 ——
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const rootLabel = $derived(readonly ? t('分享空间') : isLocal ? (multiRoot ? t('本地') : localRootName()) : (tr(desktopLocation?.name) || (fenced ? tr(rootName) : '') || (atPcLoc ? locLabel(cloudLoc) : '') || t('工作空间')));   // rootName 出自服务端 /api/project/locations（「工作空间」「主目录」）：显示点兜 tr()
  // 面包屑首段（本地多根时是根 id）翻译成显示名；其余段原样。
  const segLabel = (s, i) => (isLocal && multiRoot && i === 0 ? (rootMap[s] || s) : s);
  const title = $derived(segs.length ? (segs.length === 1 ? segLabel(segs[0], 0) : segs[segs.length - 1]) : rootLabel);
  // 路径条恒为一行：超过两级时中间收成「…」，点开是一张逐级向上的菜单（iOS 文件 app 标题菜单那套），
  // 长名字各段自己省略号——整机浏览时 .bridge-quickchat › <uuid> 这种路径不再折成两三行。
  const CRUMB_TAIL = 2;
  const crumbHidden = $derived(segs.length > CRUMB_TAIL ? segs.length - CRUMB_TAIL : 0);
  let crumbMenu = $state(null);    // 「…」展开的祖先菜单 { x, y }
  const crumbItems = $derived(Array.from({ length: crumbHidden }, (_, k) => crumbHidden - 1 - k).map((i) => ({
    label: segLabel(segs[i], i), icon: G.folder, onclick: () => { crumbMenu = null; goSeg(i); },
  })).concat([{ sep: true }, { label: rootLabel, icon: locPill ? locGlyph(cloudLoc) : G.folder, onclick: () => { crumbMenu = null; goRoot(); } }]));
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
  const folders = $derived(visibleItems.filter((i) => i.isDir));
  const files = $derived(visibleItems.filter((i) => !i.isDir));
  // 分享只读模式不出「最近」区：桶顶层就那几项，跟正文重复只添乱。
  // 电脑位置也不出：盘根/主目录顶层的「最近」是 DumpStack.log、NTUSER.DAT 这类系统文件，不是人要找的。
  const recents = $derived(
    !segs.length && !query && !readonly && !wsPick && !atPcLoc    // 选择器只挑文件夹，「最近」全是文件，纯噪音
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
  const LIST_CACHE = (window.__bridgeFilesListCache ||= new Map());   // listKey → items（SPA 存活期内存缓存）
  // 截断信息同样按 listKey 记：服务端对上千项的目录（Temp、System32、下载）只回前 1500 项。
  const LIST_META = (window.__bridgeFilesListMeta ||= new Map());     // listKey → { truncated, total }
  const NO_META = { truncated: false, total: 0 };
  let listMeta = $state(NO_META);
  const listKey = (p) => (ws === 'local' ? 'local' : desktopNative ? 'dt:' + desktopLocationId : readonly ? 'share' : 'cloud') + '\x1f' + (cloudRoot || '') + '\x1f' + p;
  let shownKey = null;   // 当前 items 属于哪个 listKey（跨 ws/位置切换时避免误判「同目录」）
  let loadSeq = 0, loadCtrl = null;   // 竞态闸 + 在途请求中止柄（快速连点只认最后一次）
  async function load(p) {
    const my = ++loadSeq;
    if (ws === 'local') {
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
      if (my !== loadSeq) return;   // 已被更新的导航替代：结果只进缓存不上屏
      items = r.items || []; path = r.path || p; shownKey = listKey(path); loadErr = ''; listMeta = meta;
      if (desktopNative) hydrateDesktopThumbs(items, desktopLocationId);
    }
    catch (e) {
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
  $effect(() => { const list = items; if (!loading && shownKey && ws !== 'local') LIST_CACHE.set(shownKey, list); });
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
  const canBack = $derived(searching || selecting || segs.length > 0 || Boolean(parentHit));
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
    if (aiPick) { if (aiView === 'chat') { chatBack(); return; } if (aiView === 'video') { aiView = 'vertex'; return; } if (aiView === 'vertex') { aiView = 'root'; return; } aiPick = null; return; }
    if (rootMenu) { rootMenu = null; return; }
    if (addSheet) { addSheet = false; return; }
    if (infoItem) { infoItem = null; return; }
    if (picker) { picker = null; return; }
    if (preview) { preview = null; return; }
    if (menu) { menu = null; return; }
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
      LOC_CACHE.list = me.kind === 'admin' ? list : null;
      if (cloudLocId !== 'ws' && !list.some((l) => l.id === cloudLocId)) selectCloudLoc('ws');   // 那个盘拔掉了
      return list;
    });
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
      if (it) openFile(it);
    }).catch(() => {});
    if (!desktopNative) return;
    let refreshTimer = 0, searchTimer = 0;
    const parentOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
    // 壳按目录推 { locationId, type, path, dir }；type='resync'＝系统通知缓冲区溢出（一下子变了太多），
    // 壳把有人看过的目录各推一条整体作废。后台连续写盘时一秒能来几十条，只认跟眼前这一屏有关的。
    const off = onNativeWorkspaceChanged((event) => {
      if (ws !== 'cloud') return;
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
  function openSearch() { searching = true; setTimeout(() => searchEl?.focus(), 60); }
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
  }
  async function addDesktopLocation() {
    addOpen = false;
    try {
      const result = await nativeWorkspaceAddLocation();
      await refreshDesktopLocations();
      if (!result?.canceled && result?.location?.id) {
        desktopLocationId = result.location.id;
        query = ''; searching = false;
        await load('');
      }
    } catch (e) { toast(t('添加位置失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function selectDesktopLocation(locationId) {
    if (locationId === desktopLocationId) return;
    desktopLocationId = locationId;
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

  // —— 多选 ——
  function enterSelect(seedName) { selecting = true; selected = new Set(seedName ? [seedName] : []); }
  function exitSelect() { selecting = false; selected = new Set(); }
  function toggleSel(name) {
    const s = new Set(selected);
    s.has(name) ? s.delete(name) : s.add(name);
    selected = s;
  }

  // —— 长按 ——（picker 形态下同一个长按改成「起拖」，见 pkDown）
  //
  // 触屏语义（2026-08-30 起）：按住＝把这一份【拿起来】，不再当场弹菜单；
  //   · 原地按住再松手 → 补出长按菜单（onStay 回调，与从前一样的入口）
  //   · 按住后挪动     → 就是拖拽，落在哪儿由那个落点决定（本页文件夹＝移动、对话页＝挂进输入栏）
  // 鼠标不改：长按恒出菜单（PC 上还有右键，硬套「按住＝拿起」只会挡住既有习惯）。
  let pressTimer = null, pressXY = null;
  const holdMouse = 450;
  // 这一次按压是不是手指——决定要不要吞掉浏览器自己那发长按 contextmenu（见 onCtxMenu）。
  let pressTouch = false;
  // 正被按住、还没到起拖门槛的那一份：像 iOS 一样先轻轻「压」下去，让人知道再按一会儿就拿起来了
  let armRel = $state('');
  function pressDown(e, item) {
    pressTouch = false;
    if (wsPick) { pkDown(e, item.name, itemRel(item), item.isDir); return; }
    if (selecting || atHome) return;   // 「本地位置」主页是根列表（有专属管理菜单），不出长按菜单
    if (isDragging()) return;          // 已经拎着一份了：这根手指是来翻页/加叠的，别再拿起第二份
    pressTouch = e.pointerType !== 'mouse';
    pressXY = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType, el: e.currentTarget };
    const lift = pressTouch && canLift;
    if (lift) armRel = itemRel(item);
    pressTimer = setTimeout(() => { pressTimer = null; armRel = ''; if (lift) liftItem(item); else openMenu({ clientX: pressXY.x, clientY: pressXY.y }, item); }, lift ? HOLD_MS : holdMouse);
  }
  function pressMove(e) {
    if (wsPick) { pkMoveArm(e); return; }
    if (!pressTimer || !pressXY || e.pointerId !== pressXY.pointerId) return;
    // 起拖前挪超过 MOVE_TOL＝在滚列表，作罢。门槛必须低于浏览器自己的 touch slop（8px）：
    // 一过 slop 它就把这根手指判给滚动，再拎起来也拦不住列表跟着跑。
    if (Math.hypot(e.clientX - pressXY.x, e.clientY - pressXY.y) > MOVE_TOL) { clearTimeout(pressTimer); pressTimer = null; armRel = ''; }
  }
  function pressUp() {
    pressTouch = false;
    if (wsPick) { pkCancelArm(); return; }
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    armRel = '';
  }

  // —— 桌面壳：鼠标拖行/卡/文件夹＝Windows 原生文件拖拽（可拖进 Explorer/微信输入框/聊天输入栏）——
  // 手机端仍是「按住＝拿起」那套；这里只在壳里、非手机本地盘、非选择器形态时挂 draggable。
  // 多选态拖其中一个已选项＝整组一起拖。拖回本页文件夹＝内部移动（nativeDragRels 在场时
  // dragover/drop 不走上传分支）。Windows DoDragDrop 是模态——promise resolve 即这场拖拽结束，
  // 在此清态并对账刷新（外部 Shift 移动会把源文件搬走）。
  const dragOutOn = $derived(canDragOut() && !isLocal && !wsPick && !readonly && !guest);
  let nativeDragRels = null;
  function dragOutSrc(rels) {
    if (desktopNative) return { rels, locationId: desktopLocationId };
    if (cloudRoot) return { paths: rels.map((r) => joinAbs(cloudRoot, r)) };
    return { rels, locationId: 'primary' };   // 身份文件根＝桌面壳 primary 位置（server 形态同一处 vaultPath）
  }
  function rowDragStart(e, item) {
    if (!dragOutOn) return;
    e.preventDefault(); e.stopPropagation();
    pressUp();
    const rels = selecting && selected.has(item.name) ? [...selected].map((n) => joinPath(path, n)) : [itemRel(item)];
    nativeDragRels = rels;
    startDragOut(dragOutSrc(rels)).catch(() => {}).finally(() => {
      if (nativeDragRels === rels) { nativeDragRels = null; dropOn = null; if (alive) load(path); }
    });
  }
  async function moveNativeDragged(rels, destRel) {
    const root = cloudRoot || '', nativeLoc = desktopNative ? desktopLocationId : '';
    let ok = 0, fail = 0;
    for (const rel of rels) {
      if (rel === destRel || destRel.startsWith(rel + '/')) continue;
      const r = await moveSnapInto({ rel, local: false, root, nativeLoc }, destRel);
      if (r.ok) ok++; else fail++;
    }
    if (fail) toast(t('移动失败 {n} 项', { n: fail })); else if (ok) toast(ok > 1 ? t('已移动 {n} 项', { n: ok }) : t('已移动'));
    if (selecting) exitSelect();
    if (alive) await load(path);
  }

  // 长按到 ~500ms 时，安卓/iOS 浏览器会自己补一发 contextmenu。手指这条路我们已经有自己的
  // 语义（按住＝拿起、原地松手＝出菜单），所以必须吞掉它——否则菜单会盖在刚拎起来的那一份
  // 上面，连背景都点不动（v4.65 上机后的现象）。preventDefault 照旧无条件调：那是拦系统
  // 自带的长按菜单/取词，本来就该拦。鼠标右键（pressTouch=false）仍照常出菜单。
  function onCtxMenu(e, item) {
    e.preventDefault();
    if (pressTouch || isDragging()) return;
    openMenu(e, item);
  }

  // —— 全域拖拽：拖源侧 ——
  // 只读分享空间不给拖（那儿本来就没有写操作），多选态也不给（多选有自己的批量工具条）。
  const canLift = $derived(!readonly && !wsPick && !selecting && !atHome);
  // 正被拎着的那一叠（原位淡出，像 iOS 那样"被拿走了"）；幽灵落地/飞回后 drag.on 归零才恢复
  let liftRels = $state(new Set());
  $effect(() => { if (!drag.on && liftRels.size) liftRels = new Set(); });

  // 作用域指纹：云端(可带 ws 根) / 手机本地 SAF / 桌面原生位置——只有同作用域才谈得上「移动」
  const dragCtx = $derived({ origin: isLocal ? 'local' : desktopNative ? 'native' : 'cloud', ws: cloudRoot || '', locationId: desktopNative ? desktopLocationId : '' });

  // 本页的三类落点：当前目录（列表空白处）/ 某个文件夹格子 / 面包屑上的某一级。
  // 只读分享空间与选择器形态整体关掉（那儿没有写操作）。
  // 文件夹格子与面包屑都带 spring：拎着东西在上面悬停一会儿就自动进去/退到那一级（iOS 的
  // spring-loaded folders），单指也能一路钻到目标目录再松手。
  // onDone：本页是【目标】时搬完刷新——跨作用域拖放的源面板在别处（工作台里那个），它的 afterMove 刷不到这里。
  const zoneDone = () => { if (alive) load(path); };
  const hereZone = $derived(folderDropZone({ key: 'ws-here', name: title, ctx: dragCtx, rel: path, disabled: readonly || wsPick, onDone: zoneDone }));
  const folderZone = (f) => folderDropZone({ key: 'ws-dir:' + itemRel(f), name: f.name, ctx: dragCtx, rel: itemRel(f), disabled: readonly || wsPick, spring: () => enterDir(f), onDone: zoneDone });
  const crumbZone = (i) => folderDropZone({ key: 'ws-crumb:' + i, name: i < 0 ? rootLabel : segLabel(segs[i], i), ctx: dragCtx, rel: i < 0 ? '' : segs.slice(0, i + 1).join('/'), disabled: readonly || wsPick, spring: () => (i < 0 ? goRoot() : goSeg(i)), onDone: zoneDone });

  // 拖拽会【活过本页的卸载】——另一根手指收起工作台、切走分页，源面板就没了。所以起拖那一刻
  // 必须把「这一份是谁、在哪个作用域」整个拍成快照：
  //   · rel 用当时的目录算（拖到一半用户已翻去别的目录，再 itemRel 会拼出不存在的路径 → 404）；
  //   · 作用域字段更要命——workspaceRoot 是 props，卸载后它的 getter 会一路读到宿主已清空的
  //     filesMount，直接抛 "Cannot read properties of null (reading 'ws')"（实测）。
  //     root 取的是 cloudRoot（含电脑位置），拎着它切到别的位置再放下＝跨根搬运。
  // 快照之后，落地这两件事只吃纯数据，与组件生死无关。
  const liftSnap = (item) => ({
    rel: itemRel(item), name: item.name, isDir: !!item.isDir,
    local: isLocal, root: cloudRoot || '', nativeLoc: desktopNative ? desktopLocationId : '',
  });
  let alive = true;
  $effect(() => () => { alive = false; });

  // destCtx 非空＝跨作用域（云端 ↔ 云端，两个根都在服务端）：源按快照里的 root、目标按落点的 ws，
  // /api/files/move 带 fromWs 一次搬完（跨卷服务端自己回落 copy+rm）。
  async function moveSnapInto(snap, destRel, destCtx = null) {
    try {
      if (snap.local) { const r = localMove(snap.rel, destRel); if (r?.error) return { ok: false, error: r.error }; }
      else if (snap.nativeLoc) await nativeWorkspaceMove(snap.rel, destRel, snap.nativeLoc);
      else if (destCtx && destCtx.origin === 'cloud' && (destCtx.ws || '') !== (snap.root || '')) await api.moveFile(snap.rel, destRel, destCtx.ws || '', snap.root || '');
      else await api.moveFile(snap.rel, destRel, snap.root);
    } catch (e) { return { ok: false, error: e.body?.error || e.message || '' }; }
    return { ok: true };
  }
  // 整叠搬完统一对账：面板还在才刷新（不在就没人看了）
  async function afterMove() { if (alive) await load(path); }
  // 与 aiMaterial 同一条服务端链路，但只吃快照——源面板卸载后照样能把素材备出来。
  async function materialOf(snap, direct = false) {
    const kind = snap.isDir ? 'folder' : (kindOf(snap.name) === 'img' ? 'image' : 'file');
    try {
      if (snap.local) {
        if (snap.isDir) return null;      // 手机本地文件夹没有可发送的形态
        let up;
        try {
          const resp = await fetch(localFileUrl(snap.rel));
          if (!resp.ok) throw new Error('本地流不可用');   // i18n-ignore 内部信号：下面 catch 吞掉，不上屏
          up = await api.uploadBlob(snap.name, await resp.blob(), { timeout: 600000 });
        } catch {
          const b64 = localReadB64(snap.rel);
          if (!b64) throw new Error('读取失败');   // i18n-ignore 外层 catch 只回 null，不上屏
          up = await api.upload(snap.name, b64);
        }
        return { path: up.path, name: up.name, kind, url: kind === 'image' ? localImgDataUrl(snap.rel, snap.name) : null };
      }
      const up = await api.fileToUpload(snap.rel, !direct, snap.root);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(snap.rel, { ws: snap.root }) : null };
    } catch { return null; }
  }

  const ghostOf = (item) => ({ name: item.name, isDir: !!item.isDir, iconHtml: item.isDir ? '' : fileIcon(item.name), thumb: thumbable(item) ? thumbSrc(item) : '' });
  function liftItem(item) {
    const el = pressXY?.el || null;
    const pid = pressXY?.pointerId ?? -1;
    const x = pressXY?.x ?? 0, y = pressXY?.y ?? 0;
    const snap = liftSnap(item);
    liftRels = new Set([snap.rel]);
    const payload = wsFilePayload({
      items: [snap], ctx: dragCtx,
      moveOne: (s, destRel, destCtx) => moveSnapInto(s, destRel, destCtx),
      materialOne: (s, direct) => materialOf(s, direct),
      afterMove,
    });
    const ok = beginDrag(payload, {
      x, y, pointerId: pid, pointerType: pressXY?.pointerType || 'touch', sourceEl: el,
      ghost: ghostOf(item),
      onStay: () => openMenu({ clientX: x, clientY: y }, item),
    });
    if (!ok) liftRels = new Set();
  }
  // 拎着一份时另一根手指点到别的文件＝加进这一叠（iOS 同款），而不是把它点开。
  // 文件夹不加叠：点文件夹恒等于「进去」——那是另一根手指认路的方式（场景：一手拎着、一手翻目录）。
  function stackToDrag(item) {
    const snap = liftSnap(item);
    if (addToDrag(snap, ghostOf(item))) liftRels = new Set([...liftRels, snap.rel]);
  }

  // —— picker 形态：长按起拖 → 拖进底栏 → 松手即选定 ——
  // 只有文件夹能拖（文件不是工作空间）。鼠标走的是同一套 Pointer Events，所以按住拖同样成立。
  function pkDown(e, name, rel, isDir) {
    if (!isDir || pkDrag) return;
    pkCancelArm();
    pkPid = e.pointerId;
    pkFrom = { x: e.clientX, y: e.clientY, name, rel };
    pkTimer = setTimeout(() => pkStart(), 420);
  }
  function pkMoveArm(e) {
    if (!pkTimer || !pkFrom) return;
    // 起拖前手指挪超过 9px＝用户在滚列表，取消这次长按（与长按菜单同一阈值）
    if (Math.hypot(e.clientX - pkFrom.x, e.clientY - pkFrom.y) > 9) pkCancelArm();
  }
  function pkCancelArm() { if (pkTimer) { clearTimeout(pkTimer); pkTimer = null; } pkFrom = null; }
  // 拖起来之后列表不能再跟着滚：touchmove 必须 passive:false + preventDefault 才拦得住
  // WebView 的滚动。监听器在 picker 挂载期间【常驻】而不是起拖时才挂：合成器在 touchstart
  // 那一刻就定下这根手指的 touchmove 能否被拦——手势中途才挂的阻塞监听收到的是
  // cancelable=false 的事件。常驻之后文件夹格子就不必 touch-action:none（那会让铺满
  // 格子的列表在手机/折叠屏上几乎滑不动，只剩格缝能滑）。
  const pkBlockTouch = (e) => { if (pkDrag && e.cancelable) e.preventDefault(); };
  $effect(() => {
    if (!wsPick) return;
    window.addEventListener('touchmove', pkBlockTouch, { passive: false });
    return () => window.removeEventListener('touchmove', pkBlockTouch);
  });
  function pkStart() {
    if (!pkFrom) return;
    const { name, rel, x, y } = pkFrom;
    pkTimer = null;
    try { navigator.vibrate?.(12); } catch {}
    pkDrag = { name, abs: pkAbs(rel), ...pkLocal(x, y), over: false };
    window.addEventListener('pointermove', pkMove, { passive: false });
    window.addEventListener('pointerup', pkUp);
    window.addEventListener('pointercancel', pkUp);
  }
  function pkLocal(cx, cy) {
    const box = rootEl?.getBoundingClientRect();
    return { x: cx - (box?.left || 0), y: cy - (box?.top || 0) };
  }
  function pkOverDock(cx, cy) {
    const r = pkDockEl?.getBoundingClientRect();
    return !!r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }
  function pkMove(e) {
    if (!pkDrag || (pkPid >= 0 && e.pointerId !== pkPid)) return;   // 多指：只认起拖的那根
    if (e.cancelable) e.preventDefault();
    pkDrag = { ...pkDrag, ...pkLocal(e.clientX, e.clientY), over: pkOverDock(e.clientX, e.clientY) };
  }
  function pkUp(e) {
    if (pkPid >= 0 && e.pointerId !== pkPid) return;
    const drag = pkDrag;
    pkEnd();
    if (!drag) return;
    if (pkOverDock(e.clientX, e.clientY)) {
      try { navigator.vibrate?.(18); } catch {}
      onPickWs?.(drag.abs);
    }
  }
  function pkEnd() {
    pkDrag = null; pkPid = -1;
    pkCancelArm();
    window.removeEventListener('pointermove', pkMove);
    window.removeEventListener('pointerup', pkUp);
    window.removeEventListener('pointercancel', pkUp);
  }
  function openMenu(e, item) {
    if (wsPick) return;                // 选择器形态没有长按菜单（长按＝起拖）
    pressTimer = null;
    try { navigator.vibrate?.(8); } catch {}
    // 菜单宽 250、估高，避让边缘；从按压点缩放出现。
    // 坐标必须换算到【定位坐标系】而不是视口：.ctxmenu 是 position:fixed，本页内嵌进
    // Claude 工作台时外面那层 .dk-embed 带 transform，会把 fixed 的包含块从视口变成该容器
    // ——直接用 clientX/innerWidth 算出来的点落在容器外，被 overflow:hidden 裁掉，
    // 屏上就只剩背景层、菜单不见了。根元素 .ws-root 自身是 fixed inset:0，它的 rect
    // 恰好就是这个坐标系的原点与尺寸；独立整页时 rect = 整个视口，行为与原来一致。
    const box = rootEl?.getBoundingClientRect();
    const ox0 = box?.left || 0, oy0 = box?.top || 0;
    const vw = box?.width || window.innerWidth, vh = box?.height || window.innerHeight;
    const cx = e.clientX - ox0, cy = e.clientY - oy0;   // 按压点（局部坐标）
    const W = 250;
    const x = Math.min(Math.max(12, cx - W / 2), Math.max(12, vw - W - 12));
    const yRaw = cy + 14;
    const estH = 360;
    const y = yRaw + estH > vh - 20 ? Math.max(60, cy - estH - 10) : yRaw;
    const ox = ((cx - x) / W) * 100;
    const oy = y > cy ? 0 : 100;
    menu = { item, x, y, ox, oy };
    // 菜单出现后短暂锁定（300ms）：长按抬起会合成一次 click 落在刚出现的 scrim/菜单项上，
    // 不锁的话菜单一闪即关（真机 bug）。锁定期内忽略 scrim 关闭和菜单项点击。
    menuArmed = false;
    setTimeout(() => { menuArmed = true; }, 300);
  }
  function menuAct(act) {
    if (!menuArmed) return;            // 锁定期内的误触（长按抬起的 click）忽略
    const it = menu.item; menu = null;
    if (act === 'info') showInfo(it);
    else if (act === 'rename') renameTarget = { item: it, value: it.name };
    else if (act === 'delete') doDelete(it);
    else if (act === 'select') enterSelect(it.name);
    else if (act === 'ai') { aiPick = it; aiView = 'root'; }
    else if (act === 'share') doShare(it);
    else if (act === 'sharelink') shareDlg = { item: it, pwOn: false, password: '', ttl: 24, busy: false, result: null };
    else if (act === 'move') openMovePicker([it.name], 'move', it.parent ?? path);
    else if (act === 'copy') openMovePicker([it.name], 'copy', it.parent ?? path);
    else if (act === 'download') download(itemRel(it));
    else if (act === 'openwith') doOpenWith(it);
    else if (act === 'open') doDesktopOpen(it);
    else if (act === 'reveal') doDesktopReveal(it);
    else if (act === 'extract') doExtract(it);
    else if (act === 'compress') doCompress(it);
  }
  // 长按菜单的条目（kit Menu）：显隐条件与原菜单逐条一致；分组之间用 kit 的分隔线
  const menuItems = $derived.by(() => {
    if (!menu) return [];
    const it = menu.item, L = [];
    const add = (cond, label, act, more = {}) => { if (cond) L.push({ label, onclick: () => menuAct(act), ...more }); };
    const sep = () => { if (L.length && !L[L.length - 1].sep) L.push({ sep: true }); };
    if (desktopNative) {
      add(true, t('用默认应用打开'), 'open', { symbol: 'arrow.up.forward.app' });
      add(true, t('在文件资源管理器中显示'), 'reveal', { icon: G.reveal });
      sep();
    }
    if (!readonly && !guest && !desktopExtra) {
      add(true, t('发送给 AI'), 'ai', { symbol: 'sparkles', tint: '#cb30e0' });
      sep();
      add(!desktopNative, t('分享'), 'share', { symbol: 'square.and.arrow.up' });
      // 分享链接由 bridge 服务端铸造，只认 vault 根下的 rel；桌面额外授权位置服务端不认识，必须隐藏
      add(!isLocal && !desktopExtra && pluginOn('share'), tc('files', '分享链接'), 'sharelink', { symbol: 'link' });
    }
    add(!it.isDir && !isLocal, desktopNative ? t('另存为…') : t('下载到本地'), 'download', { symbol: 'arrow.down.circle' });
    add(!it.isDir && (canOpenWith || desktopNative), t('打开方式'), 'openwith', { symbol: 'arrow.up.forward.app' });
    add(!it.isDir && !isLocal && !desktopExtra && kindOf(it.name) === 'zip' && !readonly, t('解压'), 'extract', { icon: G.zip });
    add(canZip, t('压缩…'), 'compress', { icon: G.zip });
    add((!isLocal || localOps.move) && !readonly, t('移动到'), 'move', { icon: G.folder });
    add((!isLocal || localOps.copy) && !readonly, tc('files', '复制'), 'copy', { icon: G.copy });
    add((!isLocal || localOps.rename) && !readonly, tc('files', '重命名'), 'rename', { symbol: 'square.and.pencil' });
    add(true, t('显示简介'), 'info', { symbol: 'info.circle' });
    add(!readonly && !(desktopNative && query), t('多选'), 'select', { icon: G.select });
    if ((!isLocal || localOps.del) && !readonly) {
      sep();
      add(true, trashing ? t('移到回收站') : t('删除'), 'delete', { symbol: 'trash', destructive: true });
    }
    return L;
  });
  // 右上「＋」菜单的条目
  const addItems = $derived([
    { label: desktopNative ? t('导入文件…') : t('上传文件'), symbol: 'square.and.arrow.up', onclick: pickUpload },
    ...(desktopNative ? [{ label: t('导入文件夹…'), icon: G.folderAdd, onclick: pickDirectoryImport }] : []),
    { label: t('新建文件夹'), icon: G.folderAdd, onclick: () => { addOpen = false; mkOpen = { value: '' }; } },
    { label: t('新建 Markdown 文件'), symbol: 'square.and.pencil', onclick: () => { addOpen = false; mdOpen = { value: untitledMdName(items.map((x) => x.name)) }; } },
    ...(desktopNative ? [{ label: t('添加电脑位置…'), icon: G.pcAdd, onclick: addDesktopLocation }] : []),
  ]);

  // 「解压」：服务端用电脑上的解压工具（WinRAR UnRAR / bsdtar）解到同目录同名文件夹。
  // 请求同步等解压完成（大包可能要等一会儿），完成后刷新列表定位到新文件夹。
  let extracting = $state(false);
  async function doExtract(item) {
    if (extracting) return;
    extracting = true;
    toast(t('解压中…'));
    try { const r = await api.extractFile(itemRel(item), cloudRoot); toast(t('已解压到「{name}」', { name: r.name })); await load(path); }
    catch (e) { toast(t('解压失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
    finally { extracting = false; }
  }
  // 「打开方式」：用其他安卓应用打开。云端=拼带鉴权绝对 URL 交原生 HTTP 拉取（admin ?token / user 靠 cookie，原生侧附）；本地=传 rel 原生直取。
  function doOpenWith(item) {
    const r = itemRel(item);
    if (desktopNative) { nativeWorkspaceOpenWith(r, desktopLocationId).catch((e) => toast(t('打开方式失败：{reason}', { reason: tr(e.message || '') }))); return; }
    if (ws === 'local') { openWith('', r, item.name, true); return; }
    const tok = getToken();
    const url = apiUrl(scoped('/api/file?path=' + encodeURIComponent(r)) + (tok ? '&token=' + encodeURIComponent(tok) : ''));
    openWith(url, r, item.name, false);
  }
  async function doDesktopOpen(item) {
    try { await nativeWorkspaceOpen(itemRel(item), desktopLocationId); }
    catch (e) { toast(t('打开失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function doDesktopReveal(item) {
    try { await nativeWorkspaceReveal(itemRel(item), desktopLocationId); }
    catch (e) { toast(t('定位失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function showInfo(item) {
    infoItem = { name: item.name, isDir: item.isDir, size: item.size, mtime: item.mtime, dir: item.parent ?? path, rel: itemRel(item), loading: desktopNative };
    if (!desktopNative) return;
    try {
      const detail = await nativeWorkspaceInspect(itemRel(item), desktopLocationId);
      if (infoItem?.rel === itemRel(item)) infoItem = { ...infoItem, ...detail, loading: false };
    } catch (e) {
      if (infoItem?.rel === itemRel(item)) infoItem = { ...infoItem, loading: false, inspectError: tr(e.message || '') || t('读取失败') };
    }
  }

  // 「分享链接」：学 qq-bot 铸公开链接（可选密码 + 过期时间）。文件和文件夹一律走
  // /api/share-space 拷成只读分享空间出 /w/<token>——单文件就是「只有一个文件的空间」，
  // 访客点开预览（md 渲染而非源码）、右键/长按下载，与文件夹分享同一套页面。/s/ 直链
  // （/api/share）只留给要裸下载地址的 API 调用方。仅云端，本地手机文件不出此项。
  async function doShareLink() {
    const d = shareDlg;
    if (!d || d.busy) return;
    const request = shareRequest(d);
    if (request.error) { toast(tr(request.error)); return; }
    d.busy = true;
    const r0 = itemRel(d.item);
    try {
      const r = await api.shareSpaceMint([r0], request.options, cloudRoot);
      // 未配公网域名时后端 url 为空 → 用当前源拼（同源可用；隧道/局域网访客按访问源）。
      d.result = shareResult(r, request.password);
    } catch (e) { toast(t('创建分享失败：{reason}', { reason: tr(e.body?.error || e.body || e.message || '') })); }
    d.busy = false;
  }
  async function copyShare() {
    const d = shareDlg; if (!d?.result) return;
    // 带密码时连密码一起拷，方便直接转发给对方。
    const text = shareClipboardText(d.result);
    try { await navigator.clipboard.writeText(text); toast(t('已复制链接')); }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        toast(t('已复制链接'));
      } catch { toast(t('复制失败，请长按链接手动复制')); }
    }
  }
  const fmtExpire = formatShareExpiry;

  // 「分享」：走系统 ACTION_SEND 转发文件（同 openWith 取文件，意图改分享）。
  function doShare(item) {
    if (item.isDir) { toast(t('暂不支持分享文件夹')); return; }
    if (!canShare) { toast(t('分享需在手机 App 内使用')); return; }
    const r = itemRel(item);
    if (ws === 'local') { shareFile('', r, item.name, true); return; }
    const tok = getToken();
    const url = apiUrl(scoped('/api/file?path=' + encodeURIComponent(r)) + (tok ? '&token=' + encodeURIComponent(tok) : ''));
    shareFile(url, r, item.name, false);
  }

  // —— 「发送给 AI」：菜单两层（Claude / Vertex→子菜单），按素材类型决定 Vertex 子项是否出现 ——
  // 能力判定：item 类型 → 哪些 Vertex 目标能吃它当输入素材（对话类恒有；媒体类按图/文本可用）。
  // 文件类型决定能投给哪些模块，再与这个身份开着的 agent 取交集（服务端下发的 me.agents）。
  const aiCaps = $derived.by(() => {
    const c = fileAiCapabilities(aiPick, kindOf);
    const g = agentOn('gemini');
    return { ...c, claude: agentOn('claude'), gemini: c.gemini && g, video: c.video && g, image: c.image && g, audio: c.audio && g, music: c.music && g };
  });
  // 弄成可投递素材：云端 fileToUpload（Claude direct=零拷贝直给源绝对路径，agent 本机直读；
  // Gemini/媒体默认拷 uploads——Vertex 要读内容上传且有 ownUpload 守卫）；本地 SAF base64→upload。
  async function aiMaterial(item, direct = false) {
    const r = itemRel(item);
    const kind = item.isDir ? 'folder' : (kindOf(item.name) === 'img' ? 'image' : 'file');
    try {
      if (ws === 'local') {
        if (item.isDir) { toast(t('本地文件夹暂不支持发送')); return null; }
        // 优先原生流式（/__localfile → uploadBlob，大文件不受 20MB base64 限制、blob 走磁盘
        // 后备不爆内存）；原生流不可用（在线壳/dev）或失败 → 退回 base64 单发。
        let up;
        try {
          const resp = await fetch(localFileUrl(r));
          if (!resp.ok) throw new Error('本地流不可用');   // i18n-ignore 内部信号：下面 catch 吞掉，不上屏
          up = await api.uploadBlob(item.name, await resp.blob(), { timeout: 600000 });
        } catch {
          const b64 = localReadB64(r); if (!b64) throw new Error(t('读取失败'));
          up = await api.upload(item.name, b64);
        }
        return { path: up.path, name: up.name, kind, url: kind === 'image' ? localImgDataUrl(r, item.name) : null };
      }
      const up = await api.fileToUpload(r, !direct, cloudRoot);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(r, { ws: cloudRoot }) : null };
    } catch (e) { toast(t('准备失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return null; }
  }
  // 读文本素材内容（注入媒体面板提示词栏用），封顶 30000 字。
  async function aiTextContent(item) {
    const r = itemRel(item);
    try {
      if (ws === 'local') { const txt = localReadText(r); return txt == null ? null : String(txt).slice(0, 30000); }
      const res = await fetch(apiUrl(scoped('/api/file?path=' + encodeURIComponent(r))), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) return null;
      return (await res.text()).slice(0, 30000);
    } catch { return null; }
  }
  function pickAI(target) {
    if (target === 'claude' || target === 'gemini') { openChatPick(target); return; }   // 对话类：先选会话再投递
    const it = aiPick; aiPick = null; aiView = 'root';
    if (it) sendToAI(it, target);
  }
  function pickVideoSlot(slot) { const it = aiPick; aiPick = null; aiView = 'root'; if (it) sendToAI(it, 'video', slot); }

  // —— 「选择对话」层（微信「选择聊天」式）：新对话 / 历史会话列表 + 搜索 ——
  // 列表本地缓存先出（Claude/Gemini 有 IndexedDB 快照秒开），网络刷新殿后。
  async function openChatPick(target) {
    aiChat = { target, from: aiView, sessions: [], loading: true, q: '' };
    aiView = 'chat';
    const st = aiChat;   // 代理引用：用户退出/重进后 aiChat 换了对象，旧请求返回即作废
    await loadAiSessions(target, {
      cached: (tg) => tg === 'claude' ? getCachedSessions() : getCachedVertexSessions(),
      remote: (tg) => tg === 'claude' ? api.sessions() : api.vertexSessions(),
      current: () => aiChat === st,
      onCached: (sessions) => { st.sessions = sessions; },
      onDone: (sessions) => { if (sessions) st.sessions = sessions; st.loading = false; },
    });
  }
  function chatBack() { aiView = aiChat?.from || 'root'; aiChat = null; }
  function pickChat(sel) {   // sel: 'new' | 会话 id
    const it = aiPick, tg = aiChat?.target;
    aiPick = null; aiView = 'root'; aiChat = null;
    if (it && tg) sendToAI(it, tg, undefined, sel);
  }
  const chatTitle = (s) => tr(aiChat?.target === 'claude' ? titleFor(s.id, s.title) : s.title) || t('（无标题）');   // 服务端占位标题（「（进行中…）」「(无标题)」）走 tr
  const aiChatCur = $derived(aiChat?.target === 'claude' ? session.id : aiChat?.target === 'gemini' ? mods.gemini?.vchat.sessionId : null);
  const aiChatFiltered = $derived.by(() => {
    if (!aiChat) return [];
    return filterAiSessions(aiChat.sessions, aiChat.q, chatTitle);
  });
  // 尾帧/偏好图：确保当前视频模型支持该槽，否则复位到默认 3.1（不然进面板会被剪枝清掉）。
  function ensureVideoModelFor(slot) {
    const def = caps.data?.veo?.defaults?.model || 'veo-3.1-fast-generate-001';
    const m = vs.videoModel || def;
    const ic = caps.data?.veo?.imgCaps?.[m] || {};
    const ok = slot === 'last' ? !!ic.last : (ic.ref || 0) > 0;
    if (!ok) vs.videoModel = def;
  }
  async function sendToAI(item, target, slot, sess) {
    if (target === 'gemini') await ensureModule(target);   // 对话控制器在扩展里，先确保加载
    await sendFileToAi(item, target, slot, sess, {
      kindOf,
      material: aiMaterial,
      readText: aiTextContent,
      toast: (m) => toast(tr(m)),   // 文案出自 files-business.js（别的模块）：显示点兜一层 tr()
      chats: {
        claude: {
          current: () => session.id,
          newChat: newConversation,
          load: openSession,
          attach: (attachment) => compose.attachments.push(attachment),
        },
        gemini: {
          current: () => mods.gemini?.vchat.sessionId,
          newChat: (...a) => mods.gemini?.vnewChat(...a),
          load: (...a) => mods.gemini?.vloadSession(...a),
          attach: (attachment) => {
            vs.func = 'chat';
            vs.chatDraftAtts = [...(vs.chatDraftAtts || []), attachment];
          },
        },
      },
      mediaState: vs,
      ensureVideoModel: ensureVideoModelFor,
      navigate: (screen) => { ui.screen = screen; },
    });
  }

  // —— 文件操作 ——
  async function doRename() {
    const { item, value } = renameTarget;
    const name = value.trim();
    renameTarget = null;
    if (!name || name === item.name) return;
    const prev = items;
    items = items.map((x) => (x.name === item.name ? { ...x, name } : x));   // 乐观改名（即时），失败回滚
    if (isLocal) {
      const r = localRename(rel(item.name), name);
      if (r.error) { items = prev; toast(t('重命名失败：{reason}', { reason: tr(r.error) })); }
      return;
    }
    if (desktopNative) {
      try { await nativeWorkspaceRename(itemRel(item), name, desktopLocationId); }
      catch (e) { items = prev; toast(t('重命名失败：{reason}', { reason: tr(e.message || '') })); }
      return;
    }
    try { await api.renameFile(rel(item.name), name, cloudRoot); }
    catch (e) { items = prev; toast(t('重命名失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  // 电脑位置（整机任意目录）里的删除＝送进电脑的回收站，可在电脑上还原（桌面版同款）；
  // 身份工作空间里维持原来的永久删除。确认框把完整路径摆出来——整机范围里同名的东西太多。
  const trashing = $derived(desktopNative || (atPcLoc && !isLocal));
  async function doDelete(item) {
    // 中文与原先逐字相同（动词 +「名」？+ 文件夹附注）；英文按整句各出一条。
    const ask = trashing ? t('移到回收站「{name}」？', { name: item.name })
      : item.isDir ? t('删除「{name}」？（含其中全部内容）', { name: item.name })
      : t('删除「{name}」？', { name: item.name });
    const detail = atPcLoc && !isLocal ? winAbs(cloudRoot, itemRel(item)) + '\n' + t('可以在电脑的回收站里还原。') : '';
    // 确认钮：英文复述动词（§1.6）；中文不传，仍是默认「确定」
    const okLabel = isEn() ? (trashing ? t('移到回收站') : t('删除')) : undefined;
    if (!(await uiConfirm(ask, { detail, okLabel }))) return;
    const prev = items;
    items = items.filter((x) => x.name !== item.name);   // 乐观移除（即时），失败回滚
    if (isLocal) {
      const r = localDelete(rel(item.name));
      if (r.error) { items = prev; toast(t('删除失败：{reason}', { reason: tr(r.error) })); }
      return;
    }
    if (desktopNative) {
      try { await nativeWorkspaceTrash(itemRel(item), desktopLocationId); toast(t('已移到回收站')); }
      catch (e) { items = prev; toast(t('删除失败：{reason}', { reason: tr(e.message || '') })); }
      return;
    }
    if (atPcLoc) {
      try { await api.trashFiles([itemRel(item)], cloudRoot); toast(t('已移到回收站')); }
      catch (e) { items = prev; toast(t('删除失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
      return;
    }
    try { await api.deleteFile(rel(item.name), cloudRoot); }
    catch (e) { items = prev; toast(t('删除失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  async function multiDelete() {
    const names = [...selected];
    const ask = trashing ? t('把选中的 {n} 项移到回收站？', { n: names.length }) : t('删除选中的 {n} 项？', { n: names.length });
    const okLabel = isEn() ? (trashing ? t('移到回收站') : t('删除')) : undefined;   // 同上：只英文复述动词
    if (!names.length || !(await uiConfirm(ask, { detail: atPcLoc && !isLocal ? t('可以在电脑的回收站里还原。') : '', okLabel }))) return;
    const sel = new Set(names), prev = items;
    items = items.filter((x) => !sel.has(x.name));   // 乐观移除（即时）
    exitSelect();
    let fail = 0, why = '';
    if (atPcLoc && !isLocal) {
      // 一次送完：每次回收都要在电脑上起一个 PowerShell，逐项发请求会慢到按秒数
      try {
        const r = await api.trashFiles(names.map((n) => rel(n)), cloudRoot);
        const bad = (r?.results || []).filter((x) => !x.ok);
        fail = bad.length; why = bad[0]?.error || '';
      } catch (e) { fail = names.length; why = e.body?.error || e.message || ''; }
      if (fail) { await load(path); toast(why ? t('{n} 项没能移到回收站：{reason}', { n: fail, reason: tr(why) }) : t('{n} 项没能移到回收站', { n: fail })); }
      else toast(t('已把 {n} 项移到回收站', { n: names.length }));
      return;
    }
    for (const n of names) {
      if (isLocal) { if (localDelete(rel(n)).error) fail++; }
      else if (desktopNative) { try { await nativeWorkspaceTrash(rel(n), desktopLocationId); } catch { fail++; } }
      else { try { await api.deleteFile(rel(n), cloudRoot); } catch { fail++; } }
    }
    if (fail) { await load(path); toast(t('{n} 项删除失败', { n: fail })); }   // 有失败才重拉准确状态
  }
  async function doMkdir() {
    const name = (mkOpen.value || '').trim();
    mkOpen = null;
    if (!name) return;
    try {
      if (desktopNative) await nativeWorkspaceMkdir(path, name, desktopLocationId);
      else await api.mkdir(path, name, cloudRoot);
      toast(t('已新建文件夹')); await load(path);
    }
    catch (e) { toast(t('新建失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  const rel = (name) => (path ? path + '/' + name : name);

  // 新建 Markdown：起名（默认「未命名.md」，没写扩展名自动补 .md）→ 建空文件 → 直接打开编辑器开写
  async function doNewMd() {
    const raw = (mdOpen?.value || '').trim();
    mdOpen = null;
    if (!raw) return;
    const name = withMdExt(raw);
    try {
      if (desktopNative) await nativeWorkspaceCreateFile(path, name, '', desktopLocationId);
      else await api.newFile(path, name, cloudRoot);
    } catch (e) {
      const why = e.body?.error || e.body || e.message || '';
      toast(why === 'exists' || e.status === 409 ? t('已有同名文件「{name}」', { name }) : t('新建失败：{reason}', { reason: tr(why) }));
      return;
    }
    await load(path);
    openDocPreview({ name, rel: rel(name) }, 'md', { startMode: 'live' });
  }

  // —— 压缩 ——
  // 桌面壳（Windows，本机路径可得）：直接弹系统自带的「创建存档」向导，格式/级别/进度都是系统的；
  // 手机、网页、旧壳：内置选项 sheet → bridge 服务端压缩（/api/files/compress，后台任务 + 轮询）。
  const zipWizard = $derived(hasNativeCompressWizard() && (desktopNative || /^([A-Za-z]:|\\\\)/.test(cloudRoot)));
  const zipServer = $derived(!desktopNative || !desktopExtra);
  const canZip = $derived(!isLocal && !readonly && !guest && !wsPick && (zipWizard || zipServer));
  let wizardOpen = false;
  async function doCompress(item) {
    const r0 = itemRel(item);
    if (zipWizard) {
      if (wizardOpen) { toast(t('系统压缩窗口已经开着')); return; }
      wizardOpen = true;
      toast(t('正在打开系统压缩窗口…'));
      let r;
      try { r = await nativeCompressWizard(desktopNative ? { rels: [r0], locationId: desktopLocationId } : { root: cloudRoot, rels: [r0] }); }
      catch (e) { r = { ok: false, error: e?.message }; }
      finally { wizardOpen = false; }
      if (r?.busy) { toast(t('系统压缩窗口已经开着')); return; }
      if (r?.ok) {
        if (r.archive) { toast(t('已压缩为「{name}」', { name: r.archive.split(/[\\/]/).pop() })); await load(path); }
        return;
      }
      if (!zipServer) { toast(t('压缩失败：{reason}', { reason: tr(r?.error || '') })); return; }
    }
    const dirName = path.split('/').filter(Boolean).pop() || rootLabel;
    zipDlg = {
      rels: [r0], sub: item.name, isDir: item.isDir,
      name: compressDefaultName([item], dirName), format: 'zip', level: 'normal',
      formats: ['zip', '7z', 'tar.gz'], busy: false, note: '', gone: null,
    };
    loadCompressFormats(api).then((formats) => { if (zipDlg) zipDlg.formats = formats; });
  }
  async function runZipDlg() {
    const d = zipDlg;
    if (!d || d.busy || !d.name.trim()) return;
    d.busy = true; d.note = t('正在压缩…');
    const gone = { aborted: false };
    d.gone = gone;
    const dir = path;
    try {
      const r = await runCompress(api, d.rels, { format: d.format, level: d.level, name: d.name.trim() }, desktopNative ? '' : cloudRoot, {
        signal: gone,
        onTick: (st) => { if (zipDlg === d) d.note = st.bytes ? t('正在压缩… 已写入 {size}', { size: fmtSize(st.bytes) }) : t('正在压缩…'); },
      });
      if (r.state === 'detached') return;   // 中途关了 sheet：服务端照常压完，存档稍后出现在原文件夹
      if (zipDlg === d) zipDlg = null;
      toast(t('已压缩为「{name}」', { name: r.name }));
      if (path === dir) await load(path);
    } catch (e) {
      if (zipDlg === d) { d.busy = false; d.note = ''; }
      toast(t('压缩失败：{reason}', { reason: tr(e.body?.error || e.message || '') }));
    }
  }
  function closeZipDlg() {
    const d = zipDlg;
    if (!d) return;
    if (d.busy && d.gone) { d.gone.aborted = true; toast(t('压缩在后台继续，完成后出现在原文件夹')); }
    zipDlg = null;
  }

  // —— 移动到 / 复制到：目录选择器 sheet（浏览文件夹树选目标）。云端走 /api/files，
  //    本地走 localList（''=位置列表，进入某位置后才能确认投放；跨位置=原生复制+删源）——
  // root/rootLabel＝目标所在的根（云端才有意义）：缺省是当前位置；admin 在选择器根目录还能切到别的
  // 电脑位置——「把 D 盘下载里的东西挪进工作空间」就是在这儿选的，服务端按 fromWs 跨根搬（跨盘自动拷+删）。
  let picker = $state(null);   // { mode:'move'|'copy', names:[源名], srcDir, path, items, loading, root, rootLabel }
  async function openMovePicker(names, mode, sourceDir = path) {
    if (!names.length) return;
    picker = { mode, names: [...names], srcDir: sourceDir, path: '', items: [], loading: true, root: cloudRoot, rootLabel };
    await pickerLoad('');
  }
  async function pickerLoad(p) {
    if (!picker) return;
    picker.path = p; picker.loading = true; picker = { ...picker };
    const want = picker;
    let dirs = [];
    if (isLocal) { try { dirs = localList(p).filter((i) => i.isDir); } catch {} }
    else {
      try {
        const r = desktopNative ? await nativeWorkspaceList(p, desktopLocationId) : await api.files(p, want.root);
        dirs = (r.items || []).filter((i) => i.isDir && i.linkType !== 'external-link');
      } catch {}
    }
    if (!picker || picker.root !== want.root || picker.path !== p) return;   // 期间又换了位置/目录：旧结果作废
    picker.items = dirs; picker.loading = false; picker = { ...picker };
  }
  function pickerEnter(name) { pickerLoad(picker.path ? picker.path + '/' + name : name); }
  function pickerCrumb(i) { pickerLoad(picker.path.split('/').filter(Boolean).slice(0, i + 1).join('/')); }
  const locRoot = (l) => (l.id === 'ws' ? '' : l.path);
  function pickerSetLoc(l) {
    if (!picker || locRoot(l) === picker.root) return;
    picker = { ...picker, root: locRoot(l), rootLabel: l.id === 'ws' ? t('工作空间') : locLabel(l), items: [] };
    pickerLoad('');
  }
  async function pickerConfirm() {
    const { mode, names, srcDir, path: dest, root: destRoot } = picker;
    if (isLocal) {
      if (multiRoot && !dest) { toast(t('请先进入一个位置')); return; }   // 位置列表页不能当目标
      picker = null;
      toast(mode === 'move' ? t('移动中…') : t('复制中…'));
      await new Promise((r) => setTimeout(r, 30));   // 让 toast 先上屏——原生 move/copy 是同步桥调用会阻塞 JS
      let okN = 0, err = '';
      for (const n of names) {
        const r = (mode === 'move' ? localMove : localCopy)(srcDir ? srcDir + '/' + n : n, dest);
        if (r.error) err = r.error; else okN++;
      }
      if (selecting) exitSelect();
      toast(okN ? (mode === 'move' ? t('已移动 {n} 项', { n: okN }) : t('已复制 {n} 项', { n: okN })) : (tr(err) || t('操作失败')));
      await load(path);
      return;
    }
    picker = null;
    // 目标在另一个电脑位置：源按当前根、目标按它的根，服务端一次搬完（跨盘时自动拷贝+删源）
    const cross = !desktopNative && (destRoot ?? cloudRoot) !== cloudRoot;
    if (cross) toast(mode === 'move' ? t('移动中…') : t('复制中…'));
    let okN = 0, err = '';
    for (const n of names) {
      try {
        const source = srcDir ? srcDir + '/' + n : n;
        if (desktopNative) await (mode === 'move' ? nativeWorkspaceMove : nativeWorkspaceCopy)(source, dest, desktopLocationId);
        else if (cross) await (mode === 'move' ? api.moveFile : api.copyFile)(source, dest, destRoot, cloudRoot);
        else await (mode === 'move' ? api.moveFile : api.copyFile)(source, dest, cloudRoot);
        okN++;
      }
      catch (e) { err = e.body?.error || (typeof e.body === 'string' ? e.body : '') || err; }
    }
    if (selecting) exitSelect();
    toast(okN ? (mode === 'move' ? t('已移动 {n} 项', { n: okN }) : t('已复制 {n} 项', { n: okN })) : (tr(err) || t('操作失败')));
    await load(path);
  }
  const pickerDestName = $derived.by(() => {
    if (!picker) return '';
    const ps = picker.path.split('/').filter(Boolean);
    if (!ps.length) return isLocal ? t('本地') : (picker.rootLabel || t('工作空间'));
    const last = ps[ps.length - 1];
    return isLocal && multiRoot && ps.length === 1 ? (rootMap[last] || last) : last;   // 首段=根 id → 显示名
  });
  const pickerBtnLabel = $derived(!picker ? '' : isLocal && multiRoot && !picker.path ? t('请先进入一个位置')
    : picker.mode === 'move' ? t('移动到「{name}」', { name: pickerDestName }) : t('复制到「{name}」', { name: pickerDestName }));

  // —— 上传（进度入传输面板；执行在 lib/uploads.svelte.js：手机 App 走原生服务、其余走 XHR 分块）——
  async function pickUpload() {
    addOpen = false;
    if (!desktopNative) {
      // 手机 App：原生选文件 + 原生上传（退后台/锁屏照传）；没有原生桥才走网页 <input type=file>
      if (hasNativeUpload() && pickNativeUpload({ dir: path, ws: cloudRoot })) return;
      fileInput?.click();
      return;
    }
    try {
      const result = await nativeWorkspaceImportFiles(path, desktopLocationId);
      if (!result?.canceled) { toast(t('已导入 {n} 个文件', { n: result.items?.length || 0 })); await load(path); }
    } catch (e) { toast(t('导入失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // 有文件传进了当前看着的目录 → 刷新列表（上传可能是在别的页面/别的目录时发起、现在才完成）
  $effect(() => onUploaded(({ ws: w, dirs }) => {
    if (!isLocal && (w || '') === (cloudRoot || '') && dirs.includes(path)) load(path);
  }));
  async function pickDirectoryImport() {
    addOpen = false;
    try {
      const result = await nativeWorkspaceImportDirectory(path, desktopLocationId);
      if (!result?.canceled) { toast(t('文件夹已导入')); await load(path); }
    } catch (e) { toast(t('导入失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function onPick(e) {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of list) uploadOne(f);
  }
  let uid = 0;
  function uploadOne(file, intoDir) {
    startUpload(file, { dir: intoDir ?? path, ws: cloudRoot });   // 拖到某个文件夹上时传进那个文件夹，否则当前目录
  }
  // —— 桌面拖拽上传（网盘式：拖在某个文件夹上就传进那个文件夹，拖在空白处传进当前目录）——
  // 只在云端工作空间生效：手机本地(SAF)那侧没有这条通路，只读分享空间更不该能写。
  // dropOn：null=没在拖 / ''=当前目录 / '<文件夹名>'=某个文件夹（用来点亮目标）。
  let dropOn = $state(null);
  const canDrop = $derived(!readonly && !isLocal && !desktopNative);
  const dtHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const joinPath = (a, b) => [a, b].filter(Boolean).join('/');

  function dragOverRoot(e) {
    if (nativeDragRels) return;   // 自己拖出去的项悬在空白处＝原地，不算落点
    if (!canDrop || !dtHasFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropOn = '';
  }
  function dragLeaveRoot(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = null; }
  // 文件夹格子自己拦下 dragover（stopPropagation），根的处理器就不会把目标又抹回当前目录。
  function dragOverFolder(e, name) {
    if (nativeDragRels) {   // 自己拖出去的项拖回文件夹＝内部移动（不能进自己/自己的子目录）
      const dest = joinPath(path, name);
      if (nativeDragRels.some((r) => r === dest || dest.startsWith(r + '/'))) return;
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      dropOn = name;
      return;
    }
    if (!canDrop || !dtHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropOn = name;
  }

  async function onDropUpload(e) {
    if (nativeDragRels) {
      e.preventDefault(); e.stopPropagation();
      const target = dropOn, rels = nativeDragRels;
      dropOn = null; nativeDragRels = null;
      if (target) await moveNativeDragged(rels, joinPath(path, target));
      return;
    }
    if (!canDrop || !dtHasFiles(e)) { dropOn = null; return; }
    e.preventDefault(); e.stopPropagation();
    const target = dropOn;                       // 先取：dropOn 马上要清
    dropOn = null;
    const baseDir = target ? joinPath(path, target) : path;
    const entries = entriesFromDrop(e);          // 同步取，await 之后 dataTransfer 就废了
    const loose = [...(e.dataTransfer.files || [])];
    if (!entries.length) { for (const f of loose) uploadOne(f, baseDir); return; }  // 老浏览器兜底
    // 整树上传不设 Composer 那种小上限——这是网盘，用户拖多少传多少。
    const { items, stat } = await walkEntries(entries, { maxFiles: 5000, maxBytes: 8e9, maxFileBytes: 2e9 });
    if (!items.length) return;
    const note = skipNote(stat);
    if (note) toast(tr(note));   // 文案出自 dirDrop.js（别的模块）：显示点兜一层 tr()
    for (const g of groupByRoot(items)) {
      if (g.isDir) await uploadTree(g.name, g.items, baseDir);
      else for (const it of g.items) await uploadOne(it.file, baseDir);
    }
  }

  // 整个文件夹作为【一条】传输任务（几百个文件铺成几百行没法看）：进度按累计字节算。
  function uploadTree(rootName, items, baseDir) {
    const list = items.map((it) => ({ file: it.file, dir: joinPath(baseDir, it.rel.split('/').slice(0, -1).join('/')) }));   // rel 含顶层文件夹名
    startTreeUpload(rootName, list, { ws: cloudRoot, baseDir });
  }

  // 取消在途任务：上传交给引擎（掐断在途请求 + 让服务端删半截文件）；下载按来源各自取消。
  function cancelTask(task) {
    if (task.status !== 'up') return;
    if (task.up) { cancelUp(task.id); toast(t('已取消上传 {name}', { name: task.name })); return; }
    if (task.native) { cancelDownload(task.id); toast(t('已取消下载 {name}', { name: task.name })); return; }
    task.status = 'cancelled';
    try { task.ctrl.abort(); } catch {}
    tasks = [...tasks];
    toast(t('已取消下载 {name}', { name: task.name }));
  }

  // —— 预览 ——
  const OFFICE_EXTS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
  // 统一构造查看器条目：云端走 /api（origin cloud），本地走 SAF 原生流式（origin local，url=/__localfile，带 Range）。
  // mt=mtime：让查看器衍生图 URL 与列表图标完全一致（命中浏览器缓存秒出 blur 底）+ 文件替换后自动 bust。
  const srcItem = (it, kind) => ({ origin: ws === 'local' ? 'local' : 'cloud', rel: itemRel(it), name: it.name, kind, mt: it.mtime, ws: cloudRoot, nativeLocation: desktopNative ? desktopLocationId : '' });
  async function openFile(item) {
    if (wsPick) return;                // 选择器形态只挑文件夹：文件列出来是给你认路的，不点开
    if (selecting) { toggleSel(item.name); return; }
    const k = kindOf(item.name);
    const r = itemRel(item);
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    if (k === 'img') { openImagePreview(item); return; }                                              // 图片画廊
    if (k === 'mov' || k === 'audio') { openPreview([srcItem(item, k === 'mov' ? 'video' : 'audio')], 0); return; }  // 音视频（本地走原生流式）
    if (k === 'md' || k === 'text') { openDocPreview(item, k); return; }                              // md/文本 编辑
    if (k === 'html') {                                                                               // HTML → 沙箱 iframe 直接渲染
      if (ws === 'local') openPreview([{ origin: 'local', rel: r, name: item.name, kind: 'html', text: localReadText(r) }], 0);
      else openPreview([{ origin: 'cloud', rel: r, name: item.name, kind: 'html', ws: cloudRoot, nativeLocation: desktopNative ? desktopLocationId : '' }], 0);
      return;
    }
    if (k === 'pdf') { openPreview([srcItem(item, 'pdf')], 0); return; }                              // PDF
    if (OFFICE_EXTS.includes(ext)) { openPreview([srcItem(item, 'office')], 0); return; }             // Office
    preview = { name: item.name, rel: r, kind: 'other', local: ws === 'local' };                     // 其余（压缩包等）
  }

  // md/文本 → 沉浸式文档查看/编辑器（云端 fetch；本地 SAF 已读文本）
  function openDocPreview(item, k, extra = {}) {
    const r = itemRel(item);
    const kind = k === 'md' ? 'markdown' : 'text';
    if (ws === 'local') openPreview([{ origin: 'local', rel: r, name: item.name, kind, text: localReadText(r), ...extra }], 0);
    else openPreview([{ origin: 'cloud', rel: r, name: item.name, kind, ws: cloudRoot, nativeLocation: desktopNative ? desktopLocationId : '', ...extra }], 0);
  }

  // 图片 → openPreview：当前目录全部图片做画廊（云端 URL / 本地原生流式 URL，均轻量，可左右滑/缩放）。
  function openImagePreview(item) {
    const imgs = showFiles.filter((f) => kindOf(f.name) === 'img');
    const idx = Math.max(0, imgs.findIndex((f) => f.name === item.name));
    openPreview(imgs.map((f) => srcItem(f, 'image')), idx);
  }
  function nativeDownload(r) {
    const name = r.split('/').pop() || 'download';
    // &name=：APK 原生 DownloadListener 用它做精确文件名（含中文）；网页端浏览器按 Content-Disposition。
    let href = apiUrl(scoped('/api/file?path=' + encodeURIComponent(r)) + '&dl=1&name=' + encodeURIComponent(name));
    // 离线壳里下载走原生 DownloadManager（另一条 HTTP 请求，带不上 JS 的 Bearer 头）——admin 把
    // token 拼进 URL（/api/file 在 ?token 白名单内）；普通用户靠 WebView cookie（原生侧已附）兜底。
    const tok = getToken();
    if (isOffline() && tok) href += '&token=' + encodeURIComponent(tok);
    const a = document.createElement('a');
    a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function download(r) {
    if (desktopNative) {
      nativeWorkspaceSaveAs(r, desktopLocationId).then((result) => { if (!result?.canceled) toast(t('已保存到电脑')); }).catch((e) => toast(t('保存失败：{reason}', { reason: tr(e.message || '') })));
      return;
    }
    if (hasNativeDownload()) { appDownload(r); return; }
    if (readonly) { downloadTracked(r); return; }
    nativeDownload(r);
  }
  // 手机 App：app 自己下到手机「下载」文件夹（原生下载器，带 Bearer 头），进度进本页「传输」面板；
  // 不再跳系统浏览器。原生桥拒收（极旧壳）才退回 <a download>。
  function appDownload(r) {
    const name = r.split('/').pop() || 'download';
    const url = apiUrl(scoped('/api/file?path=' + encodeURIComponent(r)) + '&dl=1&name=' + encodeURIComponent(name));
    if (startDownload({ url, name, quiet: true })) toast(t('开始下载 {name}', { name }));
    else nativeDownload(r);
  }
  // 分享页下载：fetch 流式读进度 → 顶栏环 + 传输面板有真实状态（访客在这页的核心动作就是
  // 下载，不能毫无反馈）。数据攒成 Blob 后触发保存；大文件 Blob 内存风险大，超阈值掐掉这条
  // 流退回浏览器原生下载（自带下载管理）；流式中途失败同样退回原生兜底。
  const TRACK_MAX = 300 * 1024 * 1024;
  async function downloadTracked(r) {
    const name = r.split('/').pop() || 'download';
    const id = 'd' + Date.now() + (uid++);
    tasks = [{ id, name, total: 0, sent: 0, status: 'up', kind: kindOf(name), bps: 0, lastT: 0, ctrl: new AbortController(), dl: true, at: Date.now() }, ...tasks];
    // 【Svelte5 深代理坑】必须拿数组元素的代理来改——push 进 $state 后改裸字面量，
    // 代理 signal 不更新，UI 永远 0%（同 webview 上传 0% 卡死的老病，先例判法照抄）。
    const tk = tasks[0];
    try {
      const res = await fetch(apiUrl(scoped('/api/file?path=' + encodeURIComponent(r))), { headers: authHeaders(), credentials: 'same-origin', signal: tk.ctrl.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      tk.total = Number(res.headers.get('content-length')) || 0;
      if (tk.total > TRACK_MAX) {
        try { tk.ctrl.abort(); } catch {}
        tasks = tasks.filter((x) => x.id !== id);
        nativeDownload(r);
        toast(t('文件较大，已交给浏览器下载'));
        return;
      }
      const reader = res.body.getReader();
      const chunks = [];
      tk.lastT = performance.now();
      let uiSent = 0, lastUi = 0, sent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        sent += value.byteLength;
        const now = performance.now();
        if (now - lastUi > 150) {   // 节流：chunk 很密，逐个驱动响应式会拖死列表
          const dt = (now - tk.lastT) / 1000;
          if (dt > 0) { const inst = (sent - uiSent) / dt; tk.bps = tk.bps ? tk.bps * 0.6 + inst * 0.4 : inst; }
          tk.lastT = now; uiSent = sent; lastUi = now;
          tk.sent = sent;
        }
      }
      tk.sent = sent;
      tk.total = Math.max(tk.total, sent) || 1;
      const blob = new Blob(chunks);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      tk.sent = tk.total; tk.status = 'done';
      toast(t('已下载 {name}', { name }));
      setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 4000);
    } catch (e) {
      if (tk.status === 'cancelled' || e?.name === 'AbortError') {   // 用户取消：短暂显示后清行
        setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 2500);
        return;
      }
      tasks = tasks.filter((x) => x.id !== id);
      nativeDownload(r);   // 流式失败退回原生下载，至少能下到
    }
  }

  // —— toast ——
  let toastTimer = null;
  function toast(m) { toastMsg = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastMsg = ''), toastWarn ? 4200 : 2200); }
  // 失败/受限类提示别再配绿勾：按文案判（几十个调用点，逐个传 kind 不值当）；进行中（…结尾）不带图标。
  // 英文界面另配一条：同一批提示的译文（字典 en/files-panel.js 的 Couldn’t / Can’t / … first 等），只在英文下判，中文判定不受影响。
  const toastWarn = $derived(/失败|没能|不支持|不能|无法|太多|过大|需在|请先|开发中/.test(toastMsg)   // i18n-ignore 匹配中文文案
    || (isEn() && /couldn[’']t|can[’']t|failed|not supported|isn[’']t supported|mobile app only|location first|in development|went wrong/i.test(toastMsg)));
  const toastBusy = $derived(/…$/.test(toastMsg));

  function onScroll() { scrolled = scroller && scroller.scrollTop > 36; edgeOn = !!scroller && scroller.scrollTop > 4; }

  function refreshRoots() { roots = multiRoot ? localRoots() : []; }
  function pickWs(w) {
    if (w === ws) return;
    if (selecting) exitSelect();
    searching = false; query = ''; addSheet = false; rootMenu = null;
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
  const rootIcon = (mode) => (mode === 'all' ? PHONE_GLYPH : FOLDER_GLYPH);

  // —— helpers ——
  function kindOf(name) {
    const e = (name.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(e)) return 'img';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(e)) return 'mov';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(e)) return 'zip';
    if (['md', 'markdown'].includes(e)) return 'md';
    if (['html', 'htm'].includes(e)) return 'html';   // 点开直接渲染（HtmlView），不看源码
    if (['txt', 'js', 'ts', 'json', 'css', 'mjs', 'svelte', 'py', 'sh', 'yml', 'yaml', 'log'].includes(e)) return 'text';
    return 'doc';
  }
  const FICON = {
    apk: '#34c759', md: '#8e8e93', text: '#8e8e93', doc: '#8e8e93', pdf: '#ff383c',
    zip: '#ff8d28', mov: '#6d7cff', img: '#0088ff', audio: '#ff2d55',
  };
  const iconColor = (name) => FICON[kindOf(name)] || '#8e8e93';
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // 格式器按需建一次复用（fmtTime 每行文件都调；切语言会整页重载，locale 运行期不变）
  const DTF = {};
  const dtf = (k, o) => (DTF[k] ??= new Intl.DateTimeFormat(locale(), o));
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    // 中文输出与原先一致：「09:05」「9月28日」；英文「9:05 AM」「Sep 28」
    if (sameDay) return dtf('hm', { timeStyle: 'short' }).format(d);
    const yd = new Date(now); yd.setDate(now.getDate() - 1);
    if (d.toDateString() === yd.toDateString()) return t('昨天');
    return dtf('md', { month: 'short', day: 'numeric' }).format(d);
  }
  // 简介用：完整日期时间（中文「2026年9月28日 09:05」，英文「Sep 28, 2026, 9:05 AM」）
  function fmtFull(ms) {
    if (!ms) return '—';
    return dtf('full', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  }
  // 简介用：文件种类描述（按扩展名/类型）
  const KIND_LABEL = { img: t('图片'), mov: t('视频'), audio: t('音频'), pdf: t('PDF 文稿'), zip: t('压缩归档'), md: t('Markdown 文稿'), text: t('文本文稿'), doc: t('文稿'), apk: t('安卓安装包') };
  function typeLabel(item) {
    if (item.isDir) return t('文件夹');
    const ext = (item.name.split('.').pop() || '').toUpperCase();
    const base = KIND_LABEL[kindOf(item.name)] || t('文件');
    return item.name.includes('.') ? t('{kind}（.{ext}）', { kind: base, ext: ext.toLowerCase() }) : base;
  }
  // 电脑位置里直接给 Windows 完整路径（整机范围里「C 盘 / Users / …」不如一眼能复制的路径有用）
  const infoLocation = $derived(infoItem ? (atPcLoc && !isLocal ? winAbs(cloudRoot, infoItem.dir || '')
    : rootLabel + (infoItem.dir ? ' / ' + infoItem.dir.split('/').join(' / ') : '')) : '');
  // 传输行：第一行右侧＝百分比或终态；第二行＝「已传 / 总大小 · 实时速度」（排队/重连时换成说明，失败给原因）。
  // 总大小未知（下载响应缺 content-length）时只显示已传字节，别出 NaN%。
  const pctOf = (tk) => (tk.total > 0 ? Math.min(100, Math.floor((tk.sent / tk.total) * 100)) : 0);
  const xferState = (tk) => tk.status === 'done' ? t('完成') : tk.status === 'error' ? t('失败') : tk.status === 'cancelled' ? t('已取消')
    : tk.total > 0 ? pctOf(tk) + '%' : '';
  function xferDetail(tk) {
    if (tk.status === 'error') return tk.error || '';
    if (tk.status === 'done') return tk.total > 0 ? fmtSize(tk.total) : '';
    if (tk.status === 'cancelled') return tk.total > 0 ? fmtSize(tk.total) : '';
    if (tk.note === 'queued') return t('排队中…');
    const amount = tk.total > 0 ? fmtSize(tk.sent) + ' / ' + fmtSize(tk.total) : fmtSize(tk.sent);
    if (tk.note === 'retry') return amount + ' · ' + t('网络不稳，重连中…');
    return amount + (tk.bps > 0 ? ' · ' + fmtSize(tk.bps) + '/s' : '');
  }

  // 「本地位置」行图标：文件夹（蓝）/ 整机存储（绿手机）
  const FOLDER_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="#0088ff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>';
  const PHONE_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="#34c759" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10.5 18.6h3"/></svg>';
  const GLYPH = {
    img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="9" cy="9.6" r="1.7"/><path d="m6 17 4.2-4.4 3 3 2.4-2.5 2.9 3.1"/>',
    mov: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="m10.3 9.5 4.4 2.5-4.4 2.5v-5Z" fill="#fff" stroke="none"/>',
    audio: '<path d="M9 17.5V6.8l9-2v10.7"/><circle cx="6.8" cy="17.5" r="2.3"/><circle cx="15.8" cy="15.5" r="2.3"/>',
    pdf: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/>',
    zip: '<rect x="4.5" y="6" width="15" height="13" rx="2.4"/><path d="M12 6v13" stroke-dasharray="2.4 2"/>',
    apk: '<rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M10.5 18h3"/>',
    md: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>',
    text: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h4"/>',
    doc: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/>',
    dir: '<path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/>',
  };
  const fileGlyph = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH[k] || GLYPH.doc}</svg>`;

  // iOS 文件 app 原版风文件图标：白色文档纸 + 右上折角 + 底部彩色类型标签条
  const TYPE_COLOR = { pdf: '#ff3b30', img: '#32ade6', mov: '#5856d6', audio: '#ff2d55', zip: '#ff9500', md: '#8e8e93', text: '#8e8e93', apk: '#34c759', doc: '#007aff' };
  function fileIcon(name) {
    const k = kindOf(name);
    const c = TYPE_COLOR[k] || '#007aff';
    const label = name.includes('.') ? (name.split('.').pop() || '').toUpperCase().slice(0, 4) : '';
    return `<svg viewBox="0 0 28 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 4a3 3 0 0 1 3-3h11.5L25 8.5V30a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4Z" fill="#fff" stroke="#d6d6da" stroke-width="1"/>
      <path d="M17.5 1 25 8.5h-5.5A2 2 0 0 1 17.5 6.5V1Z" fill="#e6e6ea"/>
      <rect x="3" y="20.5" width="22" height="9.5" rx="2.6" fill="${c}"/>
      ${label ? `<text x="14" y="27.4" font-size="6" font-weight="700" letter-spacing="-.2" fill="#fff" text-anchor="middle" font-family="-apple-system,'SF Pro Text',sans-serif">${label}</text>` : ''}
    </svg>`;
  }

  // —— 媒体缩略图：图片/视频行叠真实预览图，加载完成才淡入——加载前类型图标就是占位缓冲。
  // 云端走 /api/file?thumb=1（图片 sharp 320 webp / 视频 ffmpeg 抽帧，失败 404 不喂原字节）；
  // 本地 tab（离线壳内）：新 apk 走 /__localfile&thumb=1 原生缩略（图片+视频，SAF 系统缩略
  // 优先+兜底自解/抽帧）；旧 apk 退回图片全尺寸流式、视频保持类型图标。
  const canLocalThumb = hasLocalThumb() && isOffline();
  const thumbable = (it) => {
    if (it.isDir) return false;
    if (it.nativeThumb) return true;
    const k = kindOf(it.name);
    if (!isLocal) return k === 'img' || k === 'mov';
    if (canLocalThumb) return k === 'img' || k === 'mov';
    return k === 'img' && isOffline();
  };
  // 拿到的是「系统类型图标」而不是真缩略图：小且正方（Windows 回落的 32×32）。
  // 按尺寸判而不是按扩展名判——PDF/Office 这类真有缩略图提供程序的，回来的是大图或非
  // 正方的整页预览，那种仍该按缩略图铺满。
  const iconThumb = (it) => !!it.nativeThumb && it.nativeThumbW > 0
    && it.nativeThumbW === it.nativeThumbH && it.nativeThumbW <= 48;
  const thumbSrc = (it) => (it.nativeThumb || (isLocal
    ? (canLocalThumb ? localThumbUrl(rel(it.name)) : localFileUrl(rel(it.name)))
    : cloudFileUrl(itemRel(it), { thumb: true, mt: it.mtime, ws: cloudRoot, nativeLocation: desktopNative ? desktopLocationId : '' })));
  const thumbOk = (e) => e.currentTarget.classList.add('ok');
  // 失败：云端先按 mediaFallbackUrl 做一次 LAN→隧道自愈重试（媒体 <img> 没有 fetch 那套
  // noteNetFail 自愈，见 server.js）；仍失败/本地失败 → 保持透明，底下类型图标继续兜底。
  function thumbErr(e) {
    const img = e.currentTarget;
    if (img.dataset.cloud && !img.dataset.retried) {
      img.dataset.retried = '1';
      const next = mediaFallbackUrl(img.src);
      if (next !== img.src) { img.src = next; return; }
    }
    img.classList.remove('ok');
  }
</script>

{#snippet hidToggle()}
  <button class="hid-tg" onclick={toggleHidden}>{showHidden ? t('收起隐藏项') : t('显示隐藏项')}<small>{hidTotal}</small></button>
{/snippet}

<div class="ws-root" class:narrow={rootW < 350} class:wpick={wsPick} class:embedded={embeddedUi} class:chrome={hostChrome} class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} class:ios-dark={iosDark} class:modal={!!(menu || addOpen || locMenu || crumbMenu || transferOpen || renameTarget || mkOpen || mdOpen || zipDlg || shareDlg || rootMenu || addSheet || aiPick || picker || infoItem || preview)} style:--sq={`url("${sq26}")`} bind:this={rootEl} bind:clientWidth={rootW} ondragover={dragOverRoot} ondragleave={dragLeaveRoot} ondrop={onDropUpload} role="presentation">
  <!-- 从桌面拖文件/文件夹进来：整块提示；拖在某个文件夹格子上时改说传进那个文件夹 -->
  {#if dropOn !== null}
    <div class="dropveil">
      <div class="dropveil-in">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span>{dropOn ? t('上传到「{name}」', { name: dropOn }) : t('上传到当前文件夹')}</span>
      </div>
    </div>
  {/if}
  <!-- 顶栏（kit「Toolbar - Top - iPhone」）：返回 + 添加 + 传输环，都是 kit 的 44 液态玻璃圆钮（GlassButton，
       与设置页同一张烘焙玻璃）；底下一层滚动边缘效果（Scroll Edge Effect - Soft）把滚上来的内容重度模糊。
       分享只读＝只留传输环当下载指示；根目录连返回键也不出——没有主页可回。 -->
  <div class="edge" class:on={edgeOn}></div>
  <div class="topbtns">
    {#if hostChrome ? canBack : !readonly || segs.length}
      <GlassButton symbol="chevron.backward" weight={600} aria={hostChrome && !searching && !selecting ? t('上一级') : t('返回')} onclick={back} />
    {/if}
    {#if locPill && !selecting}
      <GlassButton aria={t('位置：{name}', { name: pillLabel })} onclick={(e) => (locMenu = anchorBelow(e))}>
        <span class="lp-in">
          <span class="lp-ic">{@html locGlyph(cloudLoc)}</span>
          <span class="lp-nm">{pillLabel}</span>
          <span class="lp-chev"><Sym name="chevron.up.chevron.down" weight={600} size={12} /></span>
        </span>
      </GlassButton>
    {/if}
    <div style="flex:1"></div>
    {#if wsPick}
      <!-- 选择器只留「新建文件夹」：要一个全新的空项目就在这儿建，建完拖进底栏即可 -->
      <GlassButton symbol="plus" weight={500} aria={t('新建文件夹')} onclick={() => (mkOpen = { value: '' })} />
    {:else if !isLocal}
      {#if !readonly}
        <GlassButton symbol="plus" weight={500} aria={t('添加')} onclick={() => (addOpen = !addOpen)} />
      {/if}
      <GlassButton round aria={t('传输')} onclick={() => (transferOpen = !transferOpen)}>
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
      <GlassButton symbol="plus" weight={500} aria={t('添加本地位置')} onclick={() => { addSheet = true; rootMenu = null; }} />
    {/if}
  </div>

  {#if addOpen}
    <Menu x={Math.max(12, rootW - 14 - 250)} y={barBottom() + 16} width={250} origin="top right" title=""
      items={addItems} onclose={() => (addOpen = false)} />
  {/if}
  {#if locMenu}
    <Menu x={locMenu.x} y={locMenu.y} width={250} origin="top left" title={tc('files', '位置')}
      items={locItems} onclose={() => (locMenu = null)} />
  {/if}
  {#if crumbMenu}
    <Menu x={crumbMenu.x} y={crumbMenu.y} width={250} origin="top left" title=""
      items={crumbItems} onclose={() => (crumbMenu = null)} />
  {/if}

  <!-- 滚动内容 -->
  <div class="scroll" bind:this={scroller} onscroll={onScroll} use:dragScrollGuard use:dropZone={hereZone} class:dnd-here={drag.overKey === 'ws-here'}>
    <!-- 紧凑面包屑条（取代 34pt 大标题，省垂直空间）：父段蓝色可点、当前段黑色加粗 -->
    <!-- 有位置胶囊时，位置根上不摆路径条（名字就在顶栏上），直接是内容 -->
    {#if !(locPill && !segs.length && !selecting)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pathbar" class:wp-path={wsPick} class:wp-lift={wsPick && pkDrag?.abs === pkAbs(path)}
      onpointerdown={wsPick ? (e) => pkDown(e, title, path, true) : undefined}
      onpointermove={wsPick ? pressMove : undefined}
      onpointerup={wsPick ? pressUp : undefined}
      onpointercancel={wsPick ? pressUp : undefined}>
      {#if wsPick}
        <!-- 路径条自己也是拖源：已经走进这个文件夹了、想选它本身，不必退回上一级去拖它 -->
        <span class="wp-grip" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
      {/if}
      {#if selecting}
        <span class="sel-count">{t('已选择 {n} 项', { n: selected.size })}</span>
      {:else}
        {#if locPill}
          <button class="pb-root" class:dnd-on={drag.overKey === 'ws-crumb:-1'} use:dropZone={crumbZone(-1)} aria-label={rootLabel} onclick={goRoot}>{@html locGlyph(cloudLoc)}</button>
        {:else}
          <button class="pb-seg" class:cur={!segs.length} class:dnd-on={drag.overKey === 'ws-crumb:-1'} use:dropZone={crumbZone(-1)} onclick={goRoot}>{#if readonly}<svg class="pb-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 13.7a4.2 4.2 0 0 0 6.1.3l2.4-2.4a4.2 4.2 0 0 0-5.9-5.9l-1.3 1.3" /><path d="M13.7 10.3a4.2 4.2 0 0 0-6.1-.3l-2.4 2.4a4.2 4.2 0 0 0 5.9 5.9l1.3-1.3" /></svg>{/if}{rootLabel}</button>
        {/if}
        {#if crumbHidden}<span class="pb-sep">›</span><button class="pb-more" aria-label={t('上级文件夹')} onclick={(e) => (crumbMenu = anchorBelow(e))}>…</button>{/if}
        {#each segs as s, i}{#if i >= crumbHidden}<span class="pb-sep">›</span>{#if i < segs.length - 1}<button class="pb-seg" class:dnd-on={drag.overKey === 'ws-crumb:' + i} use:dropZone={crumbZone(i)} onclick={() => goSeg(i)}>{segLabel(s, i)}</button>{:else}<span class="pb-seg cur" title={segLabel(s, i)}>{segLabel(s, i)}</span>{/if}{/if}{/each}
      {/if}
    </div>
    {/if}

    {#if isLocal && !localPicked}
      <!-- 本地工作空间未授权：引导用户用系统选择器选一个手机文件夹 -->
      <div class="local-intro">
        <img class="li-icon" src={wsIcon} alt="" />
        <h3>{t('本地工作空间')}</h3>
        {#if localAvail}
          <p>{t('选择手机里的一个文件夹设为本地工作空间，')}<br />{t('在这里浏览预览它的文件。')}</p>
          <button class="li-pick" disabled={localPicking} onclick={doPickLocal}>{localPicking ? t('请在系统选择器中选择…') : t('选择手机文件夹')}</button>
          {#if canAllFiles()}
            <button class="li-pick alt" disabled={localPicking} onclick={doPickAll}>{t('授权整个手机存储')}</button>
            <p class="li-hint">{t('「整个手机」一次授权后可访问全部用户文件（除各 App 私有数据区，那是系统保护的）。需在系统设置里打开「所有文件访问」开关。')}</p>
          {/if}
        {:else}
          <p>{t('本地工作空间用于浏览手机本地文件，')}<br />{t('需要在手机 App 内使用。')}</p>
        {/if}
      </div>
    {:else if atHome}
      <!-- 本地位置主页：每个已授权文件夹一行（可进入/管理），底部「添加文件夹」 -->
      <div class="sechead"><h2>{t('本地位置')}</h2></div>
      <div class="filecard loc-list">
        {#each roots as r (r.id)}
          <div class="frow" role="button" tabindex="0" onclick={() => load(r.id)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && load(r.id)}>
            <span class="loc-ic">{@html rootIcon(r.mode)}</span>
            <span class="meta"><span class="nm">{r.name}</span><span class="fsub">{r.mode === 'all' ? t('整机存储') : t('手机文件夹')}</span></span>
            <button class="dots" aria-label={t('管理')} onclick={(e) => { e.stopPropagation(); rootMenu = { root: r }; }}><Sym name="ellipsis.circle" weight={400} size={20} /></button>
          </div>
        {/each}
      </div>
      <div class="filecard">
        <button class="frow loc-add" disabled={localPicking} onclick={() => (addSheet = true)}>
          <span class="loc-ic"><Sym name="plus.circle.fill" weight={400} size={24} /></span>
          <span class="meta"><span class="nm">{t('添加文件夹')}</span></span>
        </button>
      </div>
      <p class="loc-note">{t('这些是你授权 The Bridge 访问的手机文件夹，可随时增删。Claude 的手机文件工具也在这些位置内活动。')}</p>
    {:else}

    {#if wsPick && pickerLocations.length > 1}
      <!-- 位置栏：文件管理器本身锁在身份工作空间根（admin=vault），可真实项目一大半在库外
           （claude-bridge / agent trading / Dimensio Projects…）。这一条把可达范围补回整机，
           授权边界仍由服务端 authorizeProjectPath 判——Pro 只会拿到自己那一条，这行不出现。 -->
      <div class="sechead"><h2>{tc('files', '位置')}</h2></div>
      <div class="desktop-locations">
        {#each pickerLocations as loc (loc.id)}
          <button class="desktop-location" class:on={loc.id === pickerLocationId} onclick={() => onPickLocation?.(loc)}>
            <span class="dl-icon">📁</span><span>{tr(loc.name)}</span>
          </button>
        {/each}
      </div>
    {/if}


    {#if desktopNative && !path && !query && desktopLocations.length}
      <div class="sechead"><h2>{tc('files', '位置')}</h2></div>
      <div class="desktop-locations">
        {#each desktopLocations as loc (loc.id)}
          <div class="desktop-location" class:on={loc.id === desktopLocationId} role="button" tabindex="0"
            onclick={() => selectDesktopLocation(loc.id)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectDesktopLocation(loc.id)}>
            <span class="dl-icon">📁</span><span>{tr(loc.name)}</span>
            {#if loc.removable}<button class="dl-remove" aria-label={t('移除位置')} onclick={(e) => { e.stopPropagation(); removeDesktopLocation(loc); }}>×</button>{/if}
          </div>
        {/each}
        <button class="desktop-location add" onclick={addDesktopLocation}><span class="dl-icon">＋</span><span>{t('添加位置')}</span></button>
      </div>
    {/if}

    {#if listMeta.truncated && !q && !isLocal && !desktopNative && items.length}
      <!-- 上千项的目录服务端只给前 1500 项（文件夹排在前面）：放在顶上明说——放底部要先划过 1500 项才看得见——
           并把人引到能找全的搜索上（截断时搜索改问服务端，见 srvMatches） -->
      <div class="trunc-note">{t('这里一共 {total} 项，只列出了前 {shown} 项（文件夹排在前面），其余的可以', { total: listMeta.total, shown: items.length })}<button onclick={openSearch}>{t('按名字搜索')}</button>{t('。')}</div>
    {/if}

    {#if recents.length}
      <div class="sechead"><h2>{t('最近')}</h2></div>
      <div class="recents">
        {#each recents as it (it.name)}
          <button class="rcard" class:dnd-lift={liftRels.has(itemRel(it))} class:dnd-arm={armRel === itemRel(it)} draggable={dragOutOn ? 'true' : undefined} ondragstart={(e) => rowDragStart(e, it)}
            onpointerdown={(e) => pressDown(e, it)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
            onclick={() => (isDragging() ? stackToDrag(it) : openFile(it))} oncontextmenu={(e) => onCtxMenu(e, it)}>
            <!-- 彩色渐变底只属于「真要铺一张图」的格子：图片文件万一取不到缩略图、
                 回落成 32×32 系统图标时，别在渐变底上摆一个小灰纸片。 -->
            <span class="thumb" class:img={kindOf(it.name) === 'img' && !iconThumb(it)} style={kindOf(it.name) === 'img' && !iconThumb(it) ? 'background:linear-gradient(135deg,#ffd29d,#ff8db1)' : ''}>
              {#if kindOf(it.name) !== 'img' && !iconThumb(it)}<span class="ic">{@html fileIcon(it.name)}</span>{/if}
              {#if iconThumb(it)}
                <!-- 系统类型图标：占位 SVG 直接让位（图标底是透明的，叠着会露出下面那张纸），
                     dataUrl 本就在内存里，不用 .ok 淡入那套。 -->
                <img class="ricon" src={it.nativeThumb} alt="" draggable="false" />
              {:else if thumbable(it)}
                <img class="rthumb" src={thumbSrc(it)} alt="" loading="lazy" decoding="async" draggable="false"
                  data-cloud={isLocal ? undefined : '1'} onload={thumbOk} onerror={thumbErr} />
                {#if kindOf(it.name) === 'mov'}<span class="rplay"><svg viewBox="0 0 24 24"><path d="M8.4 5.8v12.4L19 12z" /></svg></span>{/if}
              {/if}
            </span>
            <span class="nm">{it.name}</span>
            <span class="mt">{fmtTime(it.mtime)}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if showFolders.length}
      <div class="sechead" class:has-act={hidSwitch}><h2>{tc('files', '文件夹')}</h2>{#if hidSwitch}{@render hidToggle()}{/if}</div>
      <div class="foldergrid">
        {#each showFolders as f (f.rel || f.name)}
          <button class="folder" class:sel={selected.has(f.name)} class:dropin={dropOn === f.name || drag.overKey === 'ws-dir:' + itemRel(f)} draggable={dragOutOn ? 'true' : undefined} ondragstart={(e) => rowDragStart(e, f)}
            class:wp-lift={wsPick && pkDrag?.abs === pkAbs(itemRel(f))} class:dnd-lift={liftRels.has(itemRel(f))} class:dnd-arm={armRel === itemRel(f)}
            class:dnd-spring={drag.springKey === 'ws-dir:' + itemRel(f)}
            use:dropZone={folderZone(f)}
            ondragover={(e) => dragOverFolder(e, f.name)} ondrop={onDropUpload}
            onpointerdown={(e) => pressDown(e, f)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
            onclick={() => enterDir(f)} oncontextmenu={(e) => onCtxMenu(e, f)}>
            {#if selecting}<span class="selc" class:on={selected.has(f.name)}>{#if selected.has(f.name)}<Sym name="checkmark.circle.fill" weight={400} size={22} />{/if}</span>{/if}
            <img class="ficon" src={wsIcon} alt="" draggable="false" />
            <span class="nm">{f.name}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if showFiles.length}
      <div class="sechead" class:has-act={hidSwitch && !showFolders.length}><h2>{tc('files', '文件')}</h2>{#if hidSwitch && !showFolders.length}{@render hidToggle()}{/if}</div>
      <div class="filecard">
        {#each showFiles as f (f.rel || f.name)}
          <div class="frow" class:sel={selected.has(f.name)} class:wp-flat={wsPick} class:dnd-lift={liftRels.has(itemRel(f))} class:dnd-arm={armRel === itemRel(f)} role="button" tabindex="0" draggable={dragOutOn ? 'true' : undefined} ondragstart={(e) => rowDragStart(e, f)}
            onpointerdown={(e) => pressDown(e, f)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
            onclick={() => (isDragging() ? stackToDrag(f) : openFile(f))} oncontextmenu={(e) => onCtxMenu(e, f)}>
            {#if selecting}<span class="selc" class:on={selected.has(f.name)}>{#if selected.has(f.name)}<Sym name="checkmark.circle.fill" weight={400} size={22} />{/if}</span>{/if}
            <span class="ficon-sm">
              {@html fileIcon(f.name)}
              {#if thumbable(f)}
                <img class="fthumb" src={thumbSrc(f)} alt="" loading="lazy" decoding="async" draggable="false"
                  data-cloud={isLocal ? undefined : '1'} onload={thumbOk} onerror={thumbErr} />
                {#if kindOf(f.name) === 'mov'}<span class="fplay"><svg viewBox="0 0 24 24"><path d="M8.4 5.8v12.4L19 12z" /></svg></span>{/if}
              {/if}
            </span>
            <span class="meta"><span class="nm">{f.name}</span><span class="fsub">{f.parent ? `${f.parent} · ` : ''}{fmtTime(f.mtime)} · {fmtSize(f.size)}{f.linkType ? ` · ${f.linkType === 'external-link' ? t('外部链接（只读）') : t('链接')}` : ''}</span></span>
            {#if !wsPick}
              <button class="dots" aria-label={t('更多')} onclick={(e) => { e.stopPropagation(); openMenu(e, f); }}><Sym name="ellipsis.circle" weight={400} size={20} /></button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if isEmpty}
      <!-- 打不开（没权限/不存在/断网）与「真的是空的」分开说：整机浏览时前者很常见 -->
      <div class="empty"><div class="big">{query ? '🔍' : loadErr ? (/权限|permission/i.test(loadErr) ? '🔒' : '⚠️') : '📂'}</div>{query ? t('未找到相关文件') : loadErr || t('这个文件夹是空的')}</div>
    {/if}
    {/if}
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
      {#if !fenced && !guest}<div class="tabbar lg62">
        <span class="tabsel" style="transform:translateX({ws === 'local' ? 100 : 0}%)"></span>
        <button class="tab" class:on={ws === 'cloud'} onclick={() => pickWs('cloud')}>
          <span class="tab-ic">{@html G.cloud}</span>
          <span class="lb">{t('工作空间')}</span>
        </button>
        <button class="tab" class:on={ws === 'local'} onclick={() => pickWs('local')}>
          <span class="tab-ic"><Sym name="iphone" weight={600} size={19} /></span>
          <span class="lb">{t('本地')}</span>
        </button>
      </div>{:else}<span></span>{/if}
      <button class="searchbtn lgo62" aria-label={t('搜索')} onclick={openSearch}><Sym name="magnifyingglass" weight={600} size={20} /></button>
    </div>

    <div class="searchrow">
      <button class="closebtn" class:glass={!fg} class:fg aria-label={t('关闭搜索')} onclick={closeSearch}><Sym name="xmark" weight={600} size={16} /></button>
      <div class="searchfield" class:glass={!fg} class:fg>
        <Sym name="magnifyingglass" weight={500} size={17} />
        <input bind:this={searchEl} bind:value={query} placeholder={t('搜索文件')} autocomplete="off" />
      </div>
    </div>

    <!-- 多选工具栏：同一张 62 高玻璃胶囊，按钮排法同 kit「Toolbar - Bottom - iPhone / Buttons」 -->
    <div class="selbar lg62">
      <button class="selact" onclick={() => toast(t('分享开发中'))}><Sym name="square.and.arrow.up" weight={400} size={19} /><span>{t('分享')}</span></button>
      <button class="selact" disabled={!selected.size || (isLocal && !localOps.move)} onclick={() => openMovePicker([...selected], 'move')}><span class="sa-ic">{@html G.folder}</span><span>{t('移动到')}</span></button>
      <button class="selact danger" disabled={!selected.size || (isLocal && !localOps.del)} onclick={multiDelete}><Sym name="trash" weight={400} size={19} /><span>{t('删除')}</span></button>
      <button class="selact done" onclick={exitSelect}><Sym name="checkmark" weight={600} size={18} /><span>{t('完成')}</span></button>
    </div>
  </div>
  {/if}

  <!-- 长按菜单（kit Menu：Liquid Glass Medium 圆角 34，从按压点缩放出现） -->
  {#if menu}
    <Menu x={menu.x} y={menu.y} width={250} origin="{menu.ox}% {menu.oy}%" title={menu.item.name}
      items={menuItems} onclose={() => { if (menuArmed) menu = null; }} />
  {/if}

  <!-- 传输面板：锚在传输环下方的玻璃面板（kit Popover，与菜单同材质） -->
  {#if transferOpen}
    <Popover right={14} y={barBottom() + 16} width={Math.min(354, rootW - 28)} label={t('传输')} onclose={() => (transferOpen = false)}>
      <div class="tp-head"><h3>{t('传输')}</h3>{#if xfers.some((x) => x.status !== 'up')}<button onclick={() => { tasks = tasks.filter((x) => x.status === 'up'); clearFinishedUploads(); clearFinishedDownloads(); }}>{t('清除已完成')}</button>{/if}</div>
      {#if !xfers.length}
        <div class="tp-empty">{t('暂无传输任务')}</div>
      {:else}
        <div class="tp-list">
          {#each xfers as task (task.id)}
            <div class="task">
              <span class="ticon" style="background:{task.status === 'error' ? 'var(--red)' : task.status === 'done' ? 'var(--green)' : task.status === 'cancelled' ? '#aeaeb2' : iconColor(task.name)}">{@html fileGlyph(task.kind || kindOf(task.name))}</span>
              <span class="tmeta">
                <span class="r1"><span class="nm">{task.name}</span><span class="spd" class:err={task.status === 'error'}>{xferState(task)}</span></span>
                <span class="track"><span class="fillb" class:up={task.status !== 'error' && task.status !== 'cancelled'} class:off={task.status === 'cancelled'} style="width:{task.status === 'done' ? 100 : pctOf(task)}%"></span></span>
                <span class="r2" class:err={task.status === 'error'}>{xferDetail(task) || ' '}</span>
              </span>
              {#if task.status === 'up'}
                <button class="tp-x" aria-label={task.up ? t('取消上传') : t('取消下载')} onclick={() => cancelTask(task)}><Sym name="xmark.circle.fill" weight={400} size={22} /></button>
              {:else if task.dl && task.native && task.status === 'done'}
                <!-- 下好的文件在手机「下载」文件夹里：点「打开」交给系统选 app 打开 -->
                <button class="tp-open" onclick={() => { if (!openDownload(task.id)) toast(t('无法打开这个文件')); }}>{t('打开')}</button>
              {:else if task.status === 'error' && task.retry}
                <button class="tp-open" onclick={() => (task.up ? retryUpload(task.id) : retryDownload(task.id))}>{t('重试')}</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Popover>
  {/if}

  <!-- 文件预览（只给接不住的类型兜底：压缩包等）：kit 表单页 -->
  {#if preview}
    <Sheet title={preview.name} closeLabel={t('关闭')} onclose={() => (preview = null)}>
      <div class="pv-body">
        {#if preview.loading}<div class="pv-loading">{t('加载中…')}</div>
        {:else if preview.kind === 'img'}<img src={preview.url} alt={preview.name} />
        {:else if preview.kind === 'text'}<pre>{preview.text}</pre>
        {:else}
          <div class="pv-other">
            <div class="big">{@html fileIcon(preview.name)}</div>
            <p>{t('该类型暂不支持内嵌预览')}</p>
            {#if !isLocal && kindOf(preview.name) === 'zip' && !readonly}<button class="k-btn prom" disabled={extracting} onclick={() => { const n = preview.name; preview = null; doExtract({ name: n }); }}>{extracting ? t('解压中…') : t('解压到当前文件夹')}</button>{/if}
            {#if !isLocal}<button class="k-btn" onclick={() => download(preview.rel)}>{t('下载文件')}</button>{/if}
          </div>
        {/if}
      </div>
    </Sheet>
  {/if}

  <!-- 重命名 / 新建文件夹：kit 警告框 + 文本框（同设置页「服务器地址」） -->
  {#if renameTarget}
    <Alert title={t('重命名')} onclose={() => (renameTarget = null)}
      actions={[{ label: t('确定'), role: 'default', onclick: doRename }, { label: t('取消'), role: 'cancel', onclick: () => (renameTarget = null) }]}>
      <TextField bind:value={renameTarget.value} onkeydown={(e) => e.key === 'Enter' && doRename()} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}
  {#if mdOpen}
    <Alert title={t('新建 Markdown 文件')} onclose={() => (mdOpen = null)}
      actions={[{ label: t('创建'), role: 'default', onclick: doNewMd }, { label: t('取消'), role: 'cancel', onclick: () => (mdOpen = null) }]}>
      <TextField bind:value={mdOpen.value} placeholder={t('文件名')} onkeydown={(e) => e.key === 'Enter' && doNewMd()} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}
  {#if mkOpen}
    <Alert title={t('新建文件夹')} onclose={() => (mkOpen = null)}
      actions={[{ label: t('创建'), role: 'default', onclick: doMkdir }, { label: t('取消'), role: 'cancel', onclick: () => (mkOpen = null) }]}>
      <TextField bind:value={mkOpen.value} placeholder={t('文件夹名称')} onkeydown={(e) => e.key === 'Enter' && doMkdir()} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}

  <!-- 分享链接：设置（密码开关 + 过期时间）→ 结果（链接 + 复制）。kit 表单页 + 分组卡 + 开关 + 分段 -->
  {#if shareDlg}
    {#if !shareDlg.result}
      <Sheet title={tc('files', '分享链接')} closeLabel={t('取消')} confirmLabel={shareDlg.busy ? t('创建中…') : t('创建链接')}
        confirmDisabled={shareDlg.busy} onclose={() => { if (!shareDlg?.busy) shareDlg = null; }} onconfirm={doShareLink}>
        <p class="k-cap">{#if shareDlg.item.isDir}<span class="k-cap-ic">{@html G.folder}</span>{/if}{shareDlg.item.name}</p>
        <div class="k-card">
          <div class="k-row">
            <span class="k-tx">{t('启用分享密码')}</span>
            <Toggle checked={shareDlg.pwOn} onchange={() => (shareDlg.pwOn = !shareDlg.pwOn)} label={t('启用分享密码')} />
          </div>
        </div>
        {#if shareDlg.pwOn}
          <div class="k-gap"><TextField bind:value={shareDlg.password} placeholder={t('设置分享密码')} maxlength="64" onkeydown={(e) => e.key === 'Enter' && doShareLink()} autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
        {/if}
        <h4 class="k-head">{t('过期时间')}</h4>
        <Segmented options={SHARE_TTLS.map((x) => ({ value: x.h, label: tr(x.lb) }))} value={shareDlg.ttl} onchange={(v) => (shareDlg.ttl = v)} label={t('过期时间')} />
        <div class="pk-foot">
          <button class="k-btn prom wide" disabled={shareDlg.busy} onclick={doShareLink}>{shareDlg.busy ? t('创建中…') : t('创建链接')}</button>
        </div>
      </Sheet>
    {:else}
      <Sheet title={t('链接已创建')} closeLabel={t('完成')} confirmLabel={t('复制链接')} onclose={() => (shareDlg = null)} onconfirm={copyShare}>
        <p class="k-cap">{#if shareDlg.item.isDir}<span class="k-cap-ic">{@html G.folder}</span>{/if}{shareDlg.item.name}</p>
        <button class="k-card k-url" onclick={copyShare}>{shareDlg.result.url}</button>
        <p class="k-foot">
          {t('{time} 过期', { time: fmtExpire(shareDlg.result.expiresAt) })}
          {#if shareDlg.result.pw}<br />{t('访问密码')} <b class="sel-text">{shareDlg.result.pw}</b>{t('（复制时一并带上）')}{/if}
        </p>
        <div class="pk-foot">
          <button class="k-btn prom wide" onclick={copyShare}>{t('复制链接')}</button>
        </div>
      </Sheet>
    {/if}
  {/if}

  <!-- 压缩选项：名称 + 格式 + 级别（kit 表单页）。压缩期间可直接关掉，服务端照常压完 -->
  {#if zipDlg}
    <Sheet title={t('压缩')} closeLabel={zipDlg.busy ? t('后台继续') : t('取消')} confirmLabel={zipDlg.busy ? t('正在压缩…') : t('压缩')}
      confirmDisabled={zipDlg.busy || !zipDlg.name.trim()} onclose={closeZipDlg} onconfirm={runZipDlg}>
      <p class="k-cap">{#if zipDlg.isDir}<span class="k-cap-ic">{@html G.folder}</span>{/if}{zipDlg.sub}</p>
      <h4 class="k-head">{t('存档名称')}</h4>
      <div class="k-gap zp-name">
        <TextField bind:value={zipDlg.name} placeholder={t('存档名称')} disabled={zipDlg.busy} onkeydown={(e) => e.key === 'Enter' && runZipDlg()} autocapitalize="off" autocorrect="off" spellcheck="false" />
        <span class="zp-ext">{COMPRESS_FORMATS.find((f) => f.value === zipDlg.format)?.ext}</span>
      </div>
      <h4 class="k-head">{t('格式')}</h4>
      <Segmented options={COMPRESS_FORMATS.filter((f) => zipDlg.formats.includes(f.value)).map((f) => ({ value: f.value, label: f.label }))}
        value={zipDlg.format} disabled={zipDlg.busy} onchange={(v) => (zipDlg.format = v)} label={t('格式')} />
      <h4 class="k-head zp-gap">{t('压缩级别')}</h4>
      <Segmented options={COMPRESS_LEVELS.map((x) => ({ value: x.value, label: tr(x.lb) }))}
        value={zipDlg.level} disabled={zipDlg.busy} onchange={(v) => (zipDlg.level = v)} label={t('压缩级别')} />
      <p class="k-foot">{zipDlg.note || t('存档放在同一个文件夹里，重名自动编号')}</p>
    </Sheet>
  {/if}

  <!-- 本地位置管理 / 添加本地位置：kit 动作单（警告框形态、按钮竖排） -->
  {#if rootMenu}
    <Alert title={rootMenu.root.name}
      message={rootMenu.root.mode === 'all' ? t('不再作为本地位置（手机文件不删）') : t('撤销授权（不删除手机上的文件）')}
      onclose={() => (rootMenu = null)}
      actions={[
        ...(rootMenu.root.mode !== 'all' ? [{ label: t('重新选择文件夹'), role: 'plain', onclick: () => doReselect(rootMenu.root) }] : []),
        { label: t('移除此位置'), role: 'destructive', onclick: () => doRemove(rootMenu.root) },
        { label: t('取消'), role: 'cancel', onclick: () => (rootMenu = null) },
      ]} />
  {/if}
  {#if addSheet}
    <Alert title={t('添加本地位置')} message={localPicking ? t('请在系统选择器中选择…') : t('浏览、预览、发给 AI')}
      onclose={() => (addSheet = false)}
      actions={[
        { label: t('选择手机文件夹'), role: 'plain', disabled: localPicking, onclick: doPickLocal },
        ...(canAllFiles() ? [{ label: t('整个手机存储'), role: 'plain', disabled: localPicking, onclick: doPickAll }] : []),
        { label: t('取消'), role: 'cancel', onclick: () => (addSheet = false) },
      ]} />
  {/if}

  <!-- 「发送给 AI」目标选择：kit 表单页 + 分组列表；子层（Vertex / 视频素材位 / 选择对话）左钮换成返回 -->
  {#snippet aiOpt(onclick, bg, icon, img, label, sub, chev)}
    <button class="k-row k-btnrow" {onclick}>
      <span class="k-tile" style:background={bg || null}>{#if img}<img src={img} alt="" />{:else}{@html icon}{/if}</span>
      <span class="k-tx">{label}<small>{sub}</small></span>
      {#if chev}<Sym name="chevron.right" weight={600} size={15} class="k-chev" />{/if}
    </button>
  {/snippet}
  {#if aiPick}
    <Sheet closeLabel={t('取消')} backLabel={t('返回')}
      title={aiView === 'root' ? t('发送「{name}」给', { name: aiPick.name })
        : aiView === 'vertex' ? t('发送「{name}」给 Vertex', { name: aiPick.name })
        : aiView === 'video' ? t('视频生成 · 这张图用作')
        : t('发送到 {name} · 选择对话', { name: AI_NAMES[aiChat?.target] || '' })}
      onback={aiView === 'root' ? null : aiView === 'chat' ? chatBack : aiView === 'video' ? () => (aiView = 'vertex') : () => (aiView = 'root')}
      onclose={() => { aiPick = null; aiView = 'root'; }}>
      {#if aiView === 'root'}
        <div class="k-card">
          {#if aiCaps.claude}{@render aiOpt(() => pickAI('claude'), '#d97757', AI_IC.claude, '', 'Claude', t('当附件向 Claude 提问'), true)}{/if}
          {#if aiCaps.gemini}{@render aiOpt(() => (aiView = 'vertex'), '', '', BASE + 'assets/icons/gemini.svg', 'Vertex', t('Gemini 对话 / 生成视频·图片·语音·音乐'), true)}{/if}
        </div>
      {:else if aiView === 'vertex'}
        <div class="k-card">
          {#if aiCaps.gemini}{@render aiOpt(() => pickAI('gemini'), '', '', BASE + 'assets/icons/gemini.svg', t('Gemini 对话'), t('当附件提问'), true)}{/if}
        </div>
        {#if aiCaps.video || aiCaps.image || aiCaps.audio || aiCaps.music}
          <div class="k-card">
            {#if aiCaps.video}{@render aiOpt(() => (aiCaps.mode === 'image' ? (aiView = 'video') : pickAI('video')), 'var(--i-indigo)', AI_IC.video, '', t('视频生成'), aiCaps.mode === 'image' ? t('选首帧 / 尾帧 / 偏好图') : t('作为提示词'), aiCaps.mode === 'image')}{/if}
            {#if aiCaps.image}{@render aiOpt(() => pickAI('image'), 'var(--i-blue)', AI_IC.image, '', t('图片生成'), aiCaps.mode === 'image' ? t('作为改图素材') : t('作为提示词'), false)}{/if}
            {#if aiCaps.audio}{@render aiOpt(() => pickAI('audio'), 'var(--i-pink)', AI_IC.audio, '', t('语音合成'), t('作为朗读文本'), false)}{/if}
            {#if aiCaps.music}{@render aiOpt(() => pickAI('music'), 'var(--i-orange)', AI_IC.music, '', t('音乐生成'), t('作为描述'), false)}{/if}
          </div>
        {/if}
      {:else if aiView === 'video'}
        <div class="k-card">
          {@render aiOpt(() => pickVideoSlot('first'), 'var(--i-indigo)', AI_IC.first, '', t('首帧素材'), t('视频从这张图开始'), false)}
          {@render aiOpt(() => pickVideoSlot('last'), 'var(--i-indigo)', AI_IC.last, '', t('尾帧素材'), t('视频结束于这张图'), false)}
          {@render aiOpt(() => pickVideoSlot('ref'), 'var(--i-indigo)', AI_IC.ref, '', t('偏好图'), t('带入主体 / 风格参考（Veo 3.1）'), false)}
        </div>
      {:else if aiView === 'chat' && aiChat}
        <label class="k-search"><Sym name="magnifyingglass" weight={500} size={17} /><input type="search" placeholder={t('搜索对话')} bind:value={aiChat.q} /></label>
        <div class="k-card">
          {@render aiOpt(() => pickChat('new'), 'var(--i-green)', AI_IC.plus, '', t('新对话'), t('开一个新对话，附件挂进输入栏'), false)}
        </div>
        <div class="k-card">
          {#each aiChatFiltered as s (s.id)}
            <button class="k-row k-btnrow k-chat" onclick={() => pickChat(s.id)}>
              {#if aiChat.target === 'claude'}<span class="ai-chat-dot {s.thinking ? 'work' : s.pending ? 'ask' : ''}"></span>{/if}
              <span class="k-tx k-one">{chatTitle(s)}</span>
              {#if s.id === aiChatCur}<span class="ai-chat-cur">{t('当前')}</span>{/if}
              {#if s.mtime}<span class="k-val">{relTime(s.mtime)}</span>{/if}
            </button>
          {:else}
            <div class="k-row k-empty">{aiChat.loading ? t('加载中…') : aiChat.q ? t('没有匹配的对话') : t('还没有历史对话')}</div>
          {/each}
        </div>
      {/if}
    </Sheet>
  {/if}

  <!-- 移动到 / 复制到 目录选择器：kit 表单页；✓ 与底部大按钮是同一件事——放到当前浏览的这一层 -->
  {#if picker}
    <Sheet title={picker.mode === 'move' ? t('移动 {n} 项到…', { n: picker.names.length }) : t('复制 {n} 项到…', { n: picker.names.length })}
      closeLabel={t('取消')} confirmLabel={pickerBtnLabel} confirmDisabled={isLocal && multiRoot && !picker.path}
      onclose={() => (picker = null)} onconfirm={pickerConfirm}>
      <div class="pk-crumb">
        <button class:cur={!picker.path} onclick={() => pickerLoad('')}>{isLocal ? t('本地') : (picker.rootLabel || t('工作空间'))}</button>
        {#each picker.path.split('/').filter(Boolean) as s, i}<span class="pb-sep">›</span><button class:cur={i === picker.path.split('/').filter(Boolean).length - 1} onclick={() => pickerCrumb(i)}>{segLabel(s, i)}</button>{/each}
      </div>
      {#if showCloudLocs && !picker.path}
        <!-- 目标也可以在别的电脑位置：跨根的移动/复制由服务端一次做完 -->
        <div class="desktop-locations cloud-locs pk-locs">
          {#each cloudLocs as loc (loc.id)}
            <button class="desktop-location" class:on={locRoot(loc) === picker.root} onclick={() => pickerSetLoc(loc)}>
              <span class="dl-svg">{@html locGlyph(loc)}</span><span>{loc.id === 'ws' ? t('工作空间') : locLabel(loc)}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if picker.loading}<div class="pk-empty">{t('加载中…')}</div>
      {:else if !picker.items.length}<div class="pk-empty">{t('这里没有子文件夹')}<br /><small>{isLocal && multiRoot && !picker.path ? t('还没有已授权的本地位置') : t('可直接放到当前位置')}</small></div>
      {:else}
        <div class="k-card">
          {#each picker.items as f (f.name)}
            <button class="k-row k-btnrow" onclick={() => pickerEnter(f.name)}>
              <img class="pk-fico" src={wsIcon} alt="" />
              <span class="k-tx k-one">{f.label || f.name}</span>
              <Sym name="chevron.right" weight={600} size={15} class="k-chev" />
            </button>
          {/each}
        </div>
      {/if}
      <div class="pk-foot">
        <button class="k-btn prom wide" disabled={isLocal && multiRoot && !picker.path} onclick={pickerConfirm}>{pickerBtnLabel}</button>
      </div>
    </Sheet>
  {/if}

  <!-- 显示简介：kit 表单页 + 分组卡（左标签右值） -->
  {#if infoItem}
    <Sheet title={t('显示简介')} closeLabel={t('完成')} onclose={() => (infoItem = null)}>
      <div class="info-top">
        {#if infoItem.isDir}<img class="info-ico" src={wsIcon} alt="" />{:else}<span class="info-ico file">{@html fileIcon(infoItem.name)}</span>{/if}
        <div class="info-name">{infoItem.name}</div>
      </div>
      <div class="k-card">
        <div class="k-row"><span class="k-tx">{t('种类')}</span><span class="k-val">{typeLabel(infoItem)}</span></div>
        <div class="k-row"><span class="k-tx">{t('大小')}</span><span class="k-val">{infoItem.isDir ? t('文件夹') : fmtSize(infoItem.size)}</span></div>
        <div class="k-row"><span class="k-tx">{t('修改时间')}</span><span class="k-val">{fmtFull(infoItem.mtime)}</span></div>
        <div class="k-row top"><span class="k-tx">{t('位置')}</span><span class="k-val wrap selectable">{infoLocation}</span></div>
        {#if infoItem.loading}<div class="k-row"><span class="k-tx">{t('Windows 属性')}</span><span class="k-val">{t('读取中…')}</span></div>{/if}
        {#if infoItem.absolutePath}<div class="k-row top"><span class="k-tx">{t('完整路径')}</span><span class="k-val wrap selectable">{infoItem.absolutePath}</span></div>{/if}
        {#if infoItem.linkType}<div class="k-row top"><span class="k-tx">{t('链接')}</span><span class="k-val wrap selectable">{infoItem.linkType}{infoItem.linkTarget ? ` → ${infoItem.linkTarget}` : ''}</span></div>{/if}
        {#if infoItem.absolutePath}<div class="k-row"><span class="k-tx">{t('访问')}</span><span class="k-val">{infoItem.readable ? t('可读') : t('不可读')} · {infoItem.writable ? t('可写') : t('只读')}{infoItem.longPath ? ' · ' + t('长路径') : ''}</span></div>{/if}
        {#if infoItem.inspectError}<div class="k-row top"><span class="k-tx">{t('Windows 属性')}</span><span class="k-val wrap">{infoItem.inspectError}</span></div>{/if}
      </div>
      {#if infoItem.acl}<h4 class="k-head">ACL</h4><pre class="k-acl">{infoItem.acl}</pre>{/if}
    </Sheet>
  {/if}

  <!-- 提示条：kit 44 高玻璃胶囊（与顶栏按钮同一张烘焙玻璃），挂在顶栏中间 -->
  {#if toastMsg}<div class="toast" class:warn={toastWarn}>{#if toastWarn}<Sym name="exclamationmark.triangle.fill" weight={400} size={15} />{:else if !toastBusy}<Sym name="checkmark.circle.fill" weight={400} size={16} />{/if}<span>{toastMsg}</span></div>{/if}

  <input bind:this={fileInput} type="file" multiple onchange={onPick} style="display:none" />
</div>

<style>
  /* iOS 27（Apple「iOS and iPadOS 27」UI Kit，与设置页同一套取样：bridge build/design/ios27-settings）。
     独立手机页固定浅色 grouped；内嵌进工作台（.embedded）时跟随宿主明暗（.ios-dark，由 iosDark 算出）。
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
  .folder.dropin { background: var(--blue-soft); box-shadow: inset 0 0 0 2px var(--blue); border-radius: 18px; }

  /* —— 全域拖拽的三处视觉：被拎走的原位 / 悬停在某一级面包屑 / 悬停在当前目录空白处 ——
     幽灵卡片由 DragLayer 画（全局唯一一层），这里只负责「源」和「落点」的状态。 */
  .dnd-lift { opacity: .34; transition: opacity .12s ease; }
  /* 按住还没到门槛：整个长按期间慢慢压下去，松手/挪开即弹回（iOS 拿起前的那一下「压」） */
  .dnd-arm, .folder.dnd-arm:active { transform: scale(.955); transition: transform .42s cubic-bezier(.25, .7, .3, 1); }
  .frow.dnd-arm { background: var(--fill3); }
  /* 弹簧倒计时：格子轻轻起伏两下，配合幽灵上的进度环，说明「再停一会儿就进去了」 */
  .folder.dnd-spring { animation: dndSpringPulse .65s ease-in-out; }
  @keyframes dndSpringPulse { 35% { transform: scale(1.07); } 70% { transform: scale(1.02); } 100% { transform: scale(1.07); } }
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
  /* 320 档（小屏安卓 / 窄 sheet）：顶栏四枚放不下——胶囊收掉字形、钮间距收到 8 */
  .ws-root.narrow .topbtns { gap: 8px; }
  .ws-root.narrow .lp-ic { display: none; }
  .ws-root.narrow .lp-nm { max-width: 5.5em; }

  /* 分组标题右侧的「隐藏项」开关：15pt 蓝字 + 次级色计数 */
  .sechead.has-act { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .hid-tg { flex: none; border: 0; padding: 0; background: none; font: inherit; font-size: 15px; line-height: 20px; letter-spacing: -.23px; color: var(--blue); cursor: pointer; }
  .hid-tg:active { opacity: .55; }
  .hid-tg small { margin-left: 4px; font-size: 13px; color: var(--label2); font-variant-numeric: tabular-nums; }

  .desktop-location { flex: none; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; border: 0; border-radius: 999px;
    font: inherit; font-size: 15px; line-height: 20px; font-weight: 500; letter-spacing: -.23px; color: var(--blue); background: var(--fill3); cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: transform .16s cubic-bezier(.2,0,0,1); }
  .desktop-location:active { transform: scale(.96); }
  .desktop-location.on { background: var(--blue); color: #fff; }
  .desktop-locations { display: flex; gap: 8px; overflow-x: auto; padding: 0 20px 4px; scrollbar-width: none; }
  .desktop-locations::-webkit-scrollbar { display: none; }
  .desktop-location { max-width: 220px; white-space: nowrap; }
  .desktop-location > span:last-child { overflow: hidden; text-overflow: ellipsis; }
  .dl-icon { font-size: 15px; }
  .cloud-locs { padding-bottom: 6px; }
  .dl-svg { display: inline-flex; width: 17px; height: 17px; flex: none; }
  .dl-svg :global(svg) { width: 17px; height: 17px; }
  .dl-remove { display: grid; place-items: center; width: 18px; height: 18px; margin-left: 2px; padding: 0; border: 0; border-radius: 50%; background: rgba(255,255,255,.28); color: inherit; font-size: 15px; line-height: 1; }
  .desktop-location:not(.on) .dl-remove { background: var(--fill); color: var(--label2); }
  .pk-locs { flex: none; padding: 0 0 12px; }
  .trunc-note { margin: 6px 20px 0; padding: 10px 14px; border-radius: 18px; background: var(--fill3); font-size: 13px; line-height: 18px; color: var(--label2); }
  .trunc-note button { background: none; border: none; padding: 0 2px; font: inherit; font-weight: 600; color: var(--blue); }

  /* —— picker（新建项目选择器）形态 —— */
  /* 路径条＝「当前这个文件夹」本身的拖源：给它一块可按的底 + 左侧抓握点，让「这条也能拖」一眼看得出来。
     touch-action:none 是必须的——起拖后要靠 preventDefault 拦滚动，而 pan-y 的容器会先把这根手指判给滚动。 */
  .pathbar.wp-path { margin: 0 20px 8px; padding: 12px 16px; border-radius: 26px; background: var(--card); -webkit-mask-box-image: var(--sq) 42 / 42px; touch-action: none; cursor: grab; }
  .pathbar.wp-path:active { cursor: grabbing; }
  .wp-grip { width: 16px; height: 16px; color: var(--label3); flex: none; }
  .wp-grip svg { width: 100%; height: 100%; }
  /* 正在被拖走的那一份：原位淡下去，注意力跟着幽灵走 */
  .wp-lift { opacity: .34; }
  /* 选择器里的文件只是「认路用」的参照物，不可点开——去掉一切可交互暗示 */
  .wp-flat { opacity: .55; cursor: default; }
  .wp-flat:active { background: none; }
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

  /* 分组标题：kit「Header / Type=Prominent」20/25 Semibold、字距 −0.45，左内距 16（卡片左缘 + 正文对齐） */
  .sechead { padding: 18px 20px 8px; }
  .sechead h2 { margin: 0; font-size: 20px; line-height: 25px; font-weight: 600; letter-spacing: -.45px; }

  /* 最近：图标与文字都左对齐（同左缘），卡片收窄、间距收紧 */
  .recents { display: flex; gap: 12px; overflow-x: auto; padding: 4px 20px 8px; scrollbar-width: none; }
  .recents::-webkit-scrollbar { display: none; }
  .rcard { flex: 0 0 78px; min-width: 0; background: none; border: none; padding: 0; text-align: left; cursor: pointer; color: inherit; }
  .rcard .thumb { position: relative; width: 78px; height: 66px; border-radius: 14px; overflow: hidden; display: flex; align-items: center; justify-content: flex-start; }
  .rcard .thumb.img { box-shadow: 0 0 0 .5px rgba(60,60,67,.12), 0 2px 8px rgba(0,0,0,.06); background-size: cover; background-position: center; }
  .rcard .thumb .ic { display: flex; }
  .rcard .thumb .ic :global(svg) { width: 54px; height: 64px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.14)); }
  /* 系统类型图标：占位 SVG 的同一个左对齐槽位里 contain，最多放大到 48px。
     绝不能像媒体缩略图那样 absolute+cover 铺满整块 78×66——Windows 只给得出 32×32，
     铺满＝放大 2.44 倍再纵向裁掉 12px（纸的上下沿和折角全被切没，还糊）。 */
  .rcard .thumb .ricon { width: 54px; height: 100%; padding: 9px 3px; box-sizing: border-box; object-fit: contain; }
  /* 最近卡片缩略图：叠在渐变底/类型图标上层，加载完成才淡入（加载前它们就是占位缓冲）。
     .ok 由 onload 运行时挂上，必须 :global 否则被 Svelte 当未使用选择器剪掉。 */
  .rthumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s ease; }
  .rthumb:global(.ok) { opacity: 1; }
  .rcard .nm { display: block; max-width: 78px; margin-top: 6px; font-size: 13px; line-height: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rcard .mt { display: block; font-size: 12px; line-height: 15px; color: var(--label2); }

  /* 文件夹格子按【容器】宽度分列（容器＝上面的 .scroll）：侧栏 300px 仍是 3 列，整页跑在折叠屏展开态才铺到 4–5 列。 */
  .foldergrid { display: grid; grid-template-columns: repeat(3, 1fr); row-gap: 14px; padding: 6px 14px 0; }
  @container (min-width: 620px) { .foldergrid { grid-template-columns: repeat(4, 1fr); } }
  @container (min-width: 900px) { .foldergrid { grid-template-columns: repeat(5, 1fr); } }
  .folder { position: relative; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px 6px; border-radius: 18px; background: none; border: none; cursor: pointer; color: inherit;
    transition: transform .22s cubic-bezier(.32,.72,0,1), background .2s; }
  .folder:active { transform: scale(.94); }
  .folder.sel { background: var(--blue-soft); }
  .folder .ficon { width: 84px; height: 74px; flex: none; object-fit: contain; filter: drop-shadow(0 4px 7px rgba(40,120,200,.26)); }
  .folder .nm { width: 100%; font-size: 13px; line-height: 18px; font-weight: 500; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* 多选圈：kit 列表的选择标记——未选 Labels/Tertiary 空心圈，选中 checkmark.circle.fill 蓝 */
  .selc { display: flex; align-items: center; justify-content: center; border-radius: 50%; color: var(--blue); }
  .selc:not(.on) { box-shadow: inset 0 0 0 1.5px var(--label3); }
  .folder .selc { position: absolute; top: 6px; left: 14px; width: 22px; height: 22px; background: var(--paper); box-shadow: 0 0 0 2px var(--paper); }
  .folder .selc:not(.on) { box-shadow: inset 0 0 0 1.5px var(--label3), 0 0 0 2px var(--paper); }
  .frow .selc { flex: 0 0 22px; width: 22px; height: 22px; }

  /* 文件 / 位置列表：kit 分组卡（Grouped Table View：圆角 26、Figma 平滑 60%——9 宫遮罩还原；左右内缩 20）。
     行＝kit「Row」带副标题：正文 17/22、副文 15/20 Labels/Secondary，分隔线 1pt 从正文起到右内边距止 */
  .filecard { margin: 6px 20px 0; background: var(--card); border-radius: 26px; -webkit-mask-box-image: var(--sq) 42 / 42px; overflow: hidden; }
  .frow { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; padding: 0 6px 0 14px; cursor: pointer; transition: background .15s;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; }
  .frow:active { background: var(--press); }
  .frow.sel { background: var(--blue-soft); }
  .frow + .frow::before { content: ''; position: absolute; top: 0; left: 60px; right: 16px; height: 1px; background: var(--sep); }
  .ficon-sm { position: relative; flex: 0 0 34px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; }
  .ficon-sm :global(svg) { width: 28px; height: 35px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.06)); }
  /* 文件行缩略图：盖在类型图标上层，加载完成才淡入；失败保持透明露出图标 */
  .fthumb { position: absolute; inset: 0; width: 34px; height: 34px; object-fit: cover; border-radius: 7px;
    box-shadow: 0 0 0 .5px var(--sep); background: var(--paper); opacity: 0; transition: opacity .25s ease; }
  .fthumb:global(.ok) { opacity: 1; }
  /* 视频播放角标：跟随各自缩略图淡入（缩略没出来时不遮类型图标） */
  .fplay, .rplay { position: absolute; inset: 0; margin: auto; display: flex; align-items: center; justify-content: center;
    background: rgba(20,20,24,.45); border-radius: 50%; opacity: 0; transition: opacity .25s ease; pointer-events: none; }
  .fplay { width: 16px; height: 16px; }
  .rplay { width: 24px; height: 24px; }
  .fplay svg, .rplay svg { width: 60%; height: 60%; fill: #fff; filter: none; margin-left: 6%; }
  .fthumb:global(.ok) + .fplay, .rthumb:global(.ok) + .rplay { opacity: 1; }
  .frow .meta { flex: 1; min-width: 0; padding: 9px 0; }
  .frow .meta .nm { display: block; font-size: 17px; line-height: 22px; letter-spacing: -.43px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frow .meta .fsub { display: block; font-size: 15px; line-height: 20px; letter-spacing: -.23px; color: var(--label2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frow .dots { flex: 0 0 44px; height: 44px; border: none; background: none; display: flex; align-items: center; justify-content: center; color: var(--blue); border-radius: 50%; padding: 0; }
  .frow .dots:active { background: var(--fill); }

  .empty { padding: 60px 20px; text-align: center; color: var(--label2); font-size: 17px; line-height: 22px; }
  .empty .big { font-size: 44px; margin-bottom: 12px; opacity: .6; }

  /* 本地工作空间未授权引导：kit 大按钮（Button - Liquid Glass - Text / Large：50 高胶囊、17 Semibold；Prominent 蓝底白字） */
  .local-intro { padding: 56px 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .li-icon { width: 88px; height: 74px; object-fit: contain; filter: drop-shadow(0 6px 11px rgba(40,120,200,.3)); }
  .local-intro h3 { margin: 4px 0 0; font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -.26px; }
  .local-intro p { margin: 0; font-size: 17px; line-height: 22px; color: var(--label2); }
  .li-pick { margin-top: 10px; min-width: 220px; height: 50px; padding: 0 28px; border: none; border-radius: 25px; background: var(--blue); color: #fff; font: inherit; font-size: 17px; font-weight: 600; letter-spacing: -.43px; }
  .li-pick:active:not(:disabled) { transform: scale(.97); }
  .li-pick:disabled { opacity: .55; }
  .li-pick.alt { margin-top: 0; background: var(--field); color: var(--blue); }
  .li-hint { font-size: 13px; line-height: 18px; color: var(--label2); max-width: 300px; }

  /* —— 本地位置主页 —— */
  .loc-list { margin-top: 2px; }
  .loc-ic { flex: 0 0 34px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; color: var(--green); }
  .loc-ic :global(svg) { width: 30px; height: 30px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.06)); }
  .loc-ic :global(svg.sym) { width: auto; height: auto; filter: none; }
  .frow.loc-add { margin: 0; min-height: 52px; }
  .frow.loc-add .nm { color: var(--blue); }
  .frow.loc-add:disabled { opacity: .55; }
  .loc-note { margin: 0; padding: 8px 36px 22px; font-size: 13px; line-height: 18px; color: var(--label2); }

  /* —— 底栏：kit Tab Bar（62 高胶囊）+ 搜索圆钮 + 搜索行 + 多选工具栏 ——
     玻璃＝构建期烘焙的「与底色无关」图层（Figma 原版管线跑 kit 的 Liquid Glass - Regular - Small，
     design/ios27-settings/tools/bake.mjs ws），::before 外扩 40 画；控件自身只留磨砂 6 换算的 backdrop 模糊（σ=6/√6）。 */
  .bottomwrap { position: absolute; left: 0; right: 0; bottom: calc(var(--sab,0px) + 25px); height: 62px; z-index: 30; }
  .bottombar { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 21px;
    transition: opacity .24s, transform .3s cubic-bezier(.32,.72,0,1); }
  .lg62 { position: relative; isolation: isolate; height: 62px; border-radius: 31px; color: var(--glass-ink);
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); }
  .lg62::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--ov-ios27-tab62-light, url(../assets/ios27/tab62-light.png)) 0 216 fill / 0 72px / 40px stretch; }
  .ios-dark .lg62::before { border-image-source: var(--ov-ios27-tab62-dark, url(../assets/ios27/tab62-dark.png)); }
  .lgo62 { position: relative; isolation: isolate; flex: none; width: 62px; height: 62px; border-radius: 50%; border: 0; padding: 0; background: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center; color: var(--glass-ink); -webkit-tap-highlight-color: transparent;
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); transition: transform 420ms cubic-bezier(.3, 1.5, .45, 1); }
  .lgo62::before { content: ''; position: absolute; z-index: -1; inset: -40px; pointer-events: none; background: var(--ov-ios27-nav62-light, url(../assets/ios27/nav62-light.png)) center / 142px 142px no-repeat; }
  .ios-dark .lgo62::before { background-image: var(--ov-ios27-nav62-dark, url(../assets/ios27/nav62-dark.png)); }
  .lgo62:active { transform: scale(1.08); transition: transform 160ms cubic-bezier(.2, 0, 0, 1); }
  /* 标签：kit「_Tab Bar Button - iPhone」——符号 18pt Semibold、标签 10/12 Semibold 字距 −0.1；选中垫胶囊 + 染蓝 */
  .tabbar { display: flex; align-items: center; padding: 0 4px; }
  .tabsel { position: absolute; top: 4px; left: 4px; width: 104px; height: 54px; border-radius: 27px; background: var(--tab-sel); transition: transform .34s cubic-bezier(.3,1.25,.4,1); }
  .tab { position: relative; width: 104px; height: 54px; border: none; background: none; padding: 6px 8px 7px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
    color: inherit; border-radius: 27px; font: inherit; cursor: pointer; transition: color .22s; -webkit-tap-highlight-color: transparent; }
  .tab-ic { height: 28px; display: flex; align-items: center; justify-content: center; }
  .tab-ic :global(svg:not(.sym)) { width: 25px; height: 25px; }
  .tab .lb { font-size: 10px; line-height: 12px; font-weight: 600; letter-spacing: -.1px; }
  .tab.on { color: var(--blue); }
  /* 320 一档的窄屏：两个标签收窄，给右边的搜索钮让出间距 */
  @media (max-width: 345px) { .tab, .tabsel { width: 88px; } .bottombar { padding: 0 16px; } }

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
  .closebtn.fg::before { background: var(--ov-figma-glass-fp-orb48-light, url(../assets/figma-glass/fp-orb48-light.png)) center / 100% 100% no-repeat; }
  .searchfield.fg::before { border-style: solid; border-width: 0 64px; border-image: var(--ov-figma-glass-fp-cap48-light, url(../assets/figma-glass/fp-cap48-light.png)) 0 192 fill / 0 64px / 0 stretch; }
  .searchfield.fg, .searchfield.fg input { color: #0d0d0d; }
  .searchfield.fg input { caret-color: #0088ff; }
  .searchfield.fg input::placeholder { color: #b1b1b3; }
  .ios-dark .closebtn.fg { color: #f5f5f5; }
  .ios-dark .closebtn.fg::before { background-image: var(--ov-figma-glass-fp-orb48-dark, url(../assets/figma-glass/fp-orb48-dark.png)); }
  .ios-dark .searchfield.fg::before { border-image-source: var(--ov-figma-glass-fp-cap48-dark, url(../assets/figma-glass/fp-cap48-dark.png)); }
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

  /* —— 传输面板（kit Popover 里的内容）—— */
  .tp-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px 8px; }
  .tp-head h3 { margin: 0; font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; }
  .tp-head button { border: none; background: none; color: var(--blue); font: inherit; font-size: 15px; padding: 4px 2px; cursor: pointer; }
  .tp-empty { padding: 14px 22px 24px; color: var(--label2); font-size: 15px; text-align: center; }
  .tp-list { max-height: 50vh; overflow-y: auto; padding-bottom: 10px; }
  .task { display: flex; align-items: center; gap: 12px; padding: 9px 18px 9px 22px; }
  .task .ticon { flex: 0 0 30px; height: 30px; border-radius: 7.5px; display: flex; align-items: center; justify-content: center; }
  .task .ticon :global(svg) { width: 18px; height: 18px; }
  .task .tmeta { flex: 1; min-width: 0; }
  .task .r1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .task .nm { font-size: 15px; line-height: 20px; font-weight: 500; letter-spacing: -.23px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task .spd { font-size: 13px; color: var(--label2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .task .spd.err, .task .r2.err { color: var(--red); }
  .task .r2 { display: block; margin-top: 5px; font-size: 12px; line-height: 16px; color: var(--label2); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task .track { display: block; margin-top: 6px; height: 4px; border-radius: 2px; background: var(--fill); overflow: hidden; }
  .task .fillb { display: block; height: 100%; border-radius: 2px; background: var(--blue); transition: width .3s linear; }
  .task .fillb.up { background: var(--green); }
  .task .fillb.off { background: var(--label3); }
  .task .tp-x { flex: none; border: none; background: none; color: var(--label3); display: flex; align-items: center; justify-content: center; padding: 2px; cursor: pointer; }
  /* 下好的「打开」、失败的「重试」：iOS 列表里那种浅底胶囊小按钮 */
  .task .tp-open { flex: none; border: none; background: var(--fill); color: var(--blue); font: inherit; font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.23px; padding: 4px 13px; border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .task .tp-open:active { background: var(--press); }

  /* —— kit 表单页里的内容件（Sheet 正文）：分组卡、行、标题、脚注、按钮 —— */
  .k-card { display: block; width: 100%; margin: 0 0 16px; background: var(--card); border-radius: 26px; -webkit-mask-box-image: var(--sq) 42 / 42px; overflow: hidden; border: 0; padding: 0; font: inherit; color: inherit; text-align: left; }
  .k-row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 11px 16px; border: 0; background: none; font: inherit; color: inherit; text-align: left; }
  .k-row.top { align-items: flex-start; }
  .k-row + .k-row::before { content: ''; position: absolute; left: 16px; right: 16px; top: 0; height: 1px; background: var(--sep); }
  .k-btnrow { cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .k-btnrow:active { background: var(--press); }
  .k-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 17px; line-height: 22px; letter-spacing: -.43px; }
  .k-tx small { font-size: 15px; line-height: 20px; letter-spacing: -.23px; color: var(--label2); }
  .k-tx small:lang(en) { white-space: normal; }
  .k-one { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k-val { flex: none; max-width: 60%; font-size: 17px; line-height: 22px; letter-spacing: -.43px; color: var(--label2); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k-val.wrap { flex: 1; max-width: none; white-space: normal; word-break: break-all; }
  .k-val.selectable { user-select: text; }
  .k-row :global(.k-chev) { color: var(--label3); flex: none; }
  /* 彩色圆角方块（同设置页 IconTile：30×30、圆角 7.5） */
  .k-tile { flex: none; width: 30px; height: 30px; border-radius: 7.5px; display: flex; align-items: center; justify-content: center; background: var(--fill3); overflow: hidden; }
  .k-tile img { width: 22px; height: 22px; object-fit: contain; }
  .k-tile :global(svg) { width: 19px; height: 19px; }
  .k-head { margin: 4px 0 8px; padding: 0 16px; font-size: 17px; line-height: 22px; font-weight: 600; color: var(--label2); }
  .k-cap { margin: 0 0 14px; padding: 0 16px; display: flex; align-items: center; gap: 6px; justify-content: center; font-size: 15px; line-height: 20px; color: var(--label2); word-break: break-all; text-align: center; }
  .k-cap-ic { display: inline-flex; width: 17px; height: 17px; flex: none; }
  .k-cap-ic :global(svg) { width: 17px; height: 17px; }
  .k-foot { margin: 0 0 16px; padding: 8px 16px 0; font-size: 13px; line-height: 18px; color: var(--label2); text-align: center; }
  .k-foot b { color: var(--label); }
  .k-gap { margin: -6px 0 16px; }
  .zp-name { display: flex; align-items: center; gap: 8px; }
  .zp-name > :global(:first-child) { flex: 1; min-width: 0; }
  .zp-ext { flex: none; font-size: 15px; color: var(--label2); }
  .zp-gap { margin-top: 18px; }
  .k-url { padding: 14px 16px; font-size: 15px; line-height: 20px; color: var(--blue); word-break: break-all; cursor: pointer; }
  .k-acl { margin: 0 0 16px; padding: 12px 14px; max-height: 140px; overflow: auto; border-radius: 18px; background: var(--card); color: var(--label2); user-select: text; white-space: pre-wrap; word-break: break-all; font: 12px/1.4 ui-monospace, Consolas, monospace; }
  .k-empty { justify-content: center; color: var(--label2); font-size: 15px; }
  .k-chat { gap: 10px; }
  /* 搜索框：kit「_Search」——Fills 底、圆角 胶囊、放大镜 + 17pt 占位字 */
  .k-search { display: flex; align-items: center; gap: 6px; height: 44px; margin: 0 0 14px; padding: 0 14px; border-radius: 22px; background: var(--field); color: var(--label2); }
  .k-search input { flex: 1; min-width: 0; border: none; background: none; outline: none; font: inherit; font-size: 17px; letter-spacing: -.43px; color: var(--label); }
  .k-search input::placeholder { color: var(--label3); }
  /* kit 大按钮（Button - Liquid Glass - Text / Large）：50 高胶囊、17 Semibold；Prominent＝蓝底白字，否则 Fills 底蓝字 */
  .k-btn { height: 50px; padding: 0 26px; border: none; border-radius: 25px; background: var(--field); color: var(--blue); font: inherit; font-size: 17px; font-weight: 600; letter-spacing: -.43px; cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: transform 160ms cubic-bezier(.2,0,0,1), filter 160ms linear; }
  .k-btn.prom { background: var(--blue); color: #fff; }
  .k-btn.wide { width: 100%; }
  .k-btn:active:not(:disabled) { transform: scale(.97); filter: brightness(.94); }
  .k-btn:disabled { opacity: .45; cursor: default; }

  /* 文件预览（Sheet 正文） */
  .pv-body { display: flex; min-height: 0; }
  .pv-body img { width: 100%; height: auto; object-fit: contain; border-radius: 18px; }
  .pv-body pre { flex: 1; margin: 0; padding: 14px 16px; border-radius: 18px; background: var(--card); font: 13px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: var(--ink); user-select: text; }
  .pv-loading { flex: 1; display: flex; align-items: center; justify-content: center; padding: 60px; color: var(--label2); }
  .pv-other { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 30px 8px 16px; }
  .pv-other .big { display: flex; }
  .pv-other .big :global(svg) { width: 62px; height: 76px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.1)); }
  .pv-other p { margin: 0; color: var(--label2); font-size: 15px; }

  /* 移动到 / 复制到（Sheet 正文） */
  .pk-crumb { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 0 16px 12px; }
  .pk-crumb button { background: none; border: none; padding: 0; font: inherit; font-size: 15px; line-height: 20px; color: var(--blue); cursor: pointer; }
  .pk-crumb button.cur { color: var(--label); font-weight: 600; }
  .pk-fico { width: 30px; height: 26px; object-fit: contain; flex: none; }
  .pk-empty { padding: 36px 16px 30px; text-align: center; color: var(--label2); font-size: 15px; line-height: 22px; }
  .pk-empty small { color: var(--label3); font-size: 13px; }
  /* 底部的大按钮钉在表单页正文底：目录再长也不用划到底才点得到 */
  .pk-foot { position: sticky; bottom: 0; margin: 0 -16px; padding: 10px 16px 2px; background: linear-gradient(to top, color-mix(in srgb, var(--bg) 70%, transparent) 60%, transparent); }

  /* 显示简介（Sheet 正文） */
  .info-top { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 0 18px; }
  .info-ico { width: 64px; height: 56px; object-fit: contain; }
  .info-ico.file :global(svg) { width: 50px; height: 62px; }
  .info-name { font-size: 17px; line-height: 22px; font-weight: 600; text-align: center; word-break: break-all; padding: 0 12px; }

  /* 提示条：kit 44 高玻璃胶囊（cap44 三段切片，同顶栏按钮的烘焙玻璃），挂在顶栏下方正中（不压顶栏按钮） */
  .toast { position: fixed; top: calc(var(--sat,0px) + var(--tbg) + 52px); left: 50%; transform: translateX(-50%); z-index: 96; isolation: isolate;
    display: flex; align-items: center; gap: 7px; min-height: 44px; padding: 0 18px; border-radius: 22px; color: var(--glass-ink);
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px);
    font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.23px; animation: toastin .32s cubic-bezier(.25, 1.2, .4, 1);
    width: max-content; max-width: min(calc(100% - 32px), 560px); box-sizing: border-box; }
  .toast::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--ov-ios27-cap44-light, url(../assets/ios27/cap44-light.png)) 0 210 fill / 0 70px / 40px stretch; }
  .ios-dark .toast::before { border-image-source: var(--ov-ios27-cap44-dark, url(../assets/ios27/cap44-dark.png)); }
  .toast > span { padding: 12px 0; overflow: hidden; text-overflow: ellipsis; }
  .toast :global(.sym) { color: var(--green); }
  .toast.warn :global(.sym) { color: var(--orange); }
  @keyframes toastin { from { opacity: 0; transform: translate(-50%, -10px) scale(.92); } }

  /* 「选择对话」里的状态点与「当前」徽标 */
  .ai-chat-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--label3); }
  .ai-chat-dot.work { background: #d97757; animation: aidot 1.2s ease-in-out infinite; }
  .ai-chat-dot.ask { background: var(--orange); animation: aidot 1.2s ease-in-out infinite; }
  @keyframes aidot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .ai-chat-cur { font-size: 12px; line-height: 16px; color: var(--label2); background: var(--fill3); border-radius: 6px; padding: 2px 7px; flex: none; }
</style>
