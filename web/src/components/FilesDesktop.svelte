<script>
  import { uiConfirm } from '../lib/dialogs.js';
  import { joinAbs } from '../lib/dragOut.js';
  import { createFlip } from '../lib/flipLayout.js';
  // 工作空间 · 桌面版（Electron 壳独占，isNativeDesktop && hasNativeWorkspaceOps 时替换
  // FilesPanel 整页）。形态 = Finder/Explorer 杂交：左侧位置栏 + 工具栏 + 高密度列表/图标
  // 双视图 + 右键菜单 + 全键盘 + 剪贴板（剪切/复制/粘贴）+ 内部拖拽移动 + OS 拖入原生导入。
  // 数据全走桌面主进程 IPC（见 client/desktop/main.cjs workspace 段），不碰 /api/files；
  // 仍走 bridge 服务端的只有三件需要服务端身份的事：发送给 AI、分享链接、解压（都仅 primary）。
  // 视觉沿用工作空间的 iOS 浅色 grouped 语言（蓝 #0088ff / bg #f2f2f7），密度按 PC 标准。
  import { onMount, tick, untrack } from 'svelte';
  import { ui, compose, vertex as vsState, me, caps, session, agentOn, pluginOn } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { api, authHeaders } from '../lib/api.js';
  import { apiUrl } from '../lib/server.js';
  import { sendFile } from '../lib/uploads.svelte.js';
  import { openPreview as openPreviewRaw, cloudFileUrl, preview } from '../lib/preview.svelte.js';
  import { openSession, newConversation } from '../lib/chat.svelte.js';
  // Gemini 的对话控制器属于功能扩展：经 services 按需加载（开着才加载），不静态 import。
  import { mods, ensureModule } from '../modules/services.svelte.js';
  import { getCachedSessions, getCachedVertexSessions } from '../lib/cache.js';
  import { titleFor } from '../lib/library.svelte.js';
  import { relTime } from '../lib/format.js';
  import {
    AI_NAMES, SHARE_TTLS, fileAiCapabilities, filterAiSessions, filterFilesByName, formatShareExpiry,
    loadAiSessions, normalizeFileQuery, sendFileToAi, shareClipboardText,
    shareRequest, shareResult,
    untitledMdName, COMPRESS_FORMATS, COMPRESS_LEVELS, loadCompressFormats, compressDefaultName, runCompress,
  } from '../lib/files-business.js';
  import {
    nativeWorkspaceList, nativeWorkspaceRelease, onNativeWorkspaceChanged, nativeWorkspaceLocations, nativeWorkspaceAddLocation,
    nativeWorkspaceRemoveLocation, nativeWorkspaceMkdir, nativeWorkspaceRename, nativeWorkspaceTrash,
    nativeWorkspaceCreateFile, hasNativeCompressWizard, nativeCompressWizard,
    nativeWorkspaceMove, nativeWorkspaceCopy, nativeWorkspaceOpen, nativeWorkspaceOpenWith,
    nativeWorkspaceReveal, nativeWorkspaceInspect, nativeWorkspaceThumbnail, nativeWorkspaceSearch,
    nativeWorkspaceImportFiles, nativeWorkspaceImportDirectory, nativeWorkspaceSaveAs,
    hasNativeWorkspaceDropImport, nativeWorkspaceImportPaths, hasNativeWorkspaceRecent, nativeWorkspaceRecent,
    nativePathForFile, hasNativeDragOut, nativeDragWorkspace, nativeDragPaths,
    isNativeDesktop, hasNativeWorkspaceOps,
    hasNativeDirSizes, nativeWorkspaceDirSizes, onNativeDirSize,
    hasNativeFileClipboard, nativeClipboardWriteFiles, nativeClipboardPasteWorkspace, nativeClipboardClearOwn,
  } from '../lib/nativeDesktop.js';
  import { reportUi, onAgentFs, onAgentGoto } from '../lib/uiReport.js';
  import { WS_DT } from '../lib/fileDrag.js';
  import { t, tc, tr, locale, isEn } from '../lib/i18n.js';
  import { ovUrl } from '../lib/overlay.svelte.js';

  const BASE = import.meta.env.BASE_URL;
  // 文件夹图标：公开版自带，私有 overlay 有同名原版就换成它
  const wsIcon = $derived(ovUrl('assets/icons/workspace.png'));

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

  // —— 位置与数据通道 ——
  const nativeOk = isNativeDesktop() && hasNativeWorkspaceOps();
  const idLocId = nativeOk ? 'primary' : 'ws';   // 身份文件根所在的位置（桌面壳 primary＝服务端 vaultPath）
  // [{ id, name, kind:'native'|'cloud', root（云端 ws 作用域，''=身份根）, abs（根的绝对路径）, removable, hidden }]
  // 上次拿到的列表按形态缓存在 window 上：每次换会话侧栏都会重挂，进来即出、不晚一拍冒出侧栏。
  const LOC_LIST = (window.__bridgeFdLocList ||= { native: null, cloud: null });
  let locations = $state((nativeOk ? LOC_LIST.native : LOC_LIST.cloud) || []);
  // 有起点时先不认任何位置：位置列表（含各根绝对路径）到齐、按路径落好位再说，免得先闪一下身份根
  let locationId = $state(untrack(() => workspaceRoot) ? '' : idLocId);
  const curLoc = $derived(locations.find((l) => l.id === locationId) || null);
  // 列表没到之前 primary 先按原生算（独立分页老路，首屏不等位置列表）
  const nativeFs = $derived(nativeOk && (curLoc ? curLoc.kind === 'native' : locationId === 'primary'));
  // 云端通道的作用域根（/api/files?ws=）：'' = 身份文件根
  const wsRoot = $derived(!nativeFs && curLoc?.kind === 'cloud' ? curLoc.root : '');
  const scopedTo = (url, root) => (root ? url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(root) : url);
  // 内嵌时预览留在侧栏（host='dock'），独立分页仍是全屏——影子包装，调用点零改动。
  const openPreview = (items, idx) => openPreviewRaw(items, idx, { host: previewHost || (embedded ? 'dock' : 'app') });

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
  let aiDlg = $state(null);             // { item, view:'root'|'vertex'|'video'|'chat', chat }
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
  let sortOpen = $state(false);
  let addOpen = $state(false);
  let hist = { back: [], fwd: [] };     // 导航历史（不需要响应式渲染，仅按钮禁用态用计数）
  let histN = $state({ back: 0, fwd: 0 });

  try {
    const saved = JSON.parse(localStorage.getItem('bridge.fd.prefs') || '{}');
    if (saved.view === 'grid' || saved.view === 'list') view = saved.view;
    if (['name', 'mtime', 'size', 'type'].includes(saved.sortKey)) sortKey = saved.sortKey;
    if (saved.sortDir === -1) sortDir = -1;
  } catch {}
  function savePrefs() { try { localStorage.setItem('bridge.fd.prefs', JSON.stringify({ view, sortKey, sortDir })); } catch {} }

  // 「最近」是本机索引（每个原生位置一份）：人在云端临时位置里点它，落到 primary 的最近。
  const canRecent = $derived(nativeOk && hasNativeWorkspaceRecent());
  // 从桌面拖文件进来：原生走 importPaths（零拷贝拿本机路径），云端走分块上传。
  const canDropImport = $derived(nativeFs ? hasNativeWorkspaceDropImport() : true);
  // srvRoot = bridge 服务端摸这份文件时用的 ws 作用域（发给 AI / 分享链接 / 解压都要它），null＝摸不到。
  // 云端通道本身就是服务端；原生 primary 就是服务端的身份文件根；其余原生位置（各盘、外加目录）
  // 对 admin 按根的绝对路径交给服务端 ws 作用域（服务端 authorizeProjectPath 再判一次）。
  const srvRoot = $derived(!nativeFs ? wsRoot : locationId === 'primary' ? '' : (me.kind === 'admin' && curLoc?.abs) || null);
  const serverOps = $derived(srvRoot !== null);
  const locName = (l) => (/^drive-/.test(l?.id || '') ? t('{d} 盘', { d: String(l.name || '').replace(/:$/, '') }) : tr(l?.name || ''));
  const rootLabel = $derived((curLoc && locName(curLoc)) || tr(rootName) || t('工作空间'));
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const searching = $derived(query.trim().length > 0);
  const q = $derived(normalizeFileQuery(query));
  const inBrowse = $derived(mode === 'browse' && !searching);

  // —— 绝对路径（Windows 盘符 / UNC / POSIX 三种形态）——
  const isWinAbs = (p) => /^[A-Za-z]:|^\\\\/.test(String(p || ''));
  const sepOf = (p) => (isWinAbs(p) ? '\\' : '/');
  // 统一分隔符、去掉尾分隔符（'E:\' → 'E:'，'/' → ''）；比较用 foldAbs（Windows 不分大小写）
  const normAbs = (p) => { const s = String(p || ''); return (isWinAbs(s) ? s.replace(/\//g, '\\') : s).replace(/[\\/]+$/, ''); };
  const foldAbs = (p) => { const s = normAbs(p); return isWinAbs(s) ? s.toLowerCase() : s; };
  // 盘根 'E:\' 直接去掉尾分隔符会变成 'E:'（Windows 上那是「E 盘当前目录」），所以只在没有尾分隔符时才补
  function joinPath(base, rel) {
    const b = String(base || ''), sep = sepOf(b);
    const r = String(rel || '').split(/[\\/]+/).filter(Boolean).join(sep);
    if (!r) return b;
    return /[\\/]$/.test(b) ? b + r : b + sep + r;
  }
  // target 在 root 之内 → root 相对路径（'/' 分隔，''=就是根）；不在 → null
  function relUnder(root, target) {
    const r = foldAbs(root), tg = foldAbs(target), sep = sepOf(target);
    if (tg === r) return '';
    if (!tg.startsWith(r + sep)) return null;
    return normAbs(target).slice(normAbs(root).length + 1).split(/[\\/]+/).filter(Boolean).join('/');
  }
  // 绝对路径拆成地址栏各段：[{ label, abs }]，首段是盘符 / UNC 共享 / '/'
  function splitAbs(abs) {
    const a = String(abs || '');
    if (!isWinAbs(a)) {
      const parts = a.split('/').filter(Boolean);
      return [{ label: '/', abs: '/' }, ...parts.map((p, i) => ({ label: p, abs: '/' + parts.slice(0, i + 1).join('/') }))];
    }
    const norm = normAbs(a);
    const unc = norm.match(/^\\\\[^\\]+\\[^\\]+/);
    const head = unc ? unc[0] : norm.slice(0, 2).toUpperCase();
    const parts = norm.slice(head.length).split('\\').filter(Boolean);
    return [{ label: head, abs: unc ? head : head + '\\' }, ...parts.map((p, i) => ({ label: p, abs: head + '\\' + parts.slice(0, i + 1).join('\\') }))];
  }
  const baseName = (p) => normAbs(p).split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  // 绝对路径落进哪个位置：取【最深】的那个（D:\Notes\x 落 Claude，不落 E:\）
  function resolveAbs(abs) {
    let best = null;
    for (const loc of locations) {
      if (!loc.abs) continue;
      const rel = relUnder(loc.abs, abs);
      if (rel == null) continue;
      if (!best || normAbs(loc.abs).length > normAbs(best.loc.abs).length) best = { loc, rel };
    }
    return best;
  }
  // 地址栏给不给看完整路径：桌面壳（本机自己的盘）或 admin；沙箱身份仍是「根名 › 子目录」，绝对路径不出服务器
  const absOk = $derived(Boolean(curLoc?.abs) && (nativeOk || me.kind === 'admin'));
  // 人在「哪个位置都不含」的临时位置里（桌面壳没添加那个盘）：admin 的服务端 ws 作用域对任意已存在
  // 目录放行，↑ / 地址栏上级段就让临时位置跟着往上漂，而不是在会话目录根上卡死。
  const canFloat = $derived((curLoc?.id === 'session' || /^abs:/.test(curLoc?.id || '')) && me.kind === 'admin');
  const curAbs = $derived(curLoc?.abs ? joinPath(curLoc.abs, path) : '');
  const homeAbs = $derived(home || workspaceRoot);
  const homeLabel = $derived(home ? baseName(home) : (tr(rootName) || baseName(workspaceRoot)));
  const atHome = $derived(Boolean(homeAbs && curAbs && inBrowse && foldAbs(curAbs) === foldAbs(homeAbs)));
  // 侧栏：桌面壳恒在；网页上只有一个可去处（非 admin 只拿到自己那条）就不摆
  const sideLocs = $derived(locations.filter((l) => !l.hidden));
  const showSide = $derived(nativeOk || locations.length > 1);
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
  const toggleView = () => setView(view === 'list' ? 'grid' : 'list');
  // 搜索框聚焦态也进 Svelte 状态：它的宽度变化（mini 32px ↔ 展开 150/260px）和分档一样走 FLIP，
  // 不再靠 CSS transition——两套动画叠在一起会互相拆台（transition 起步时布局还是旧宽，FLIP 量到的是假新位）。
  let searchFocus = $state(false);

  const SORTS = [['name', t('名称')], ['mtime', t('修改时间')], ['size', t('大小')], ['type', t('类型')]];

  // 面包屑头部折叠：放不下就从根开始一段段收进「…」（点开是被收起的层级），尾巴＝当前目录永远露着。
  // 首版靠 overflow:hidden 从右边裁，窄列里每一段都缩成两个字、当前目录反而看不见。
  let crumbsEl = $state();
  let crumbHide = $state(0);
  let crumbPop = $state(false);
  let crumbSqueeze = $state(false);   // 头部已全部折叠仍溢出 → 允许当前段省略号
  let locPop = $state(false);         // 窄列里的「位置」下拉（位置栏收起时的入口）
  let addrEdit = $state(null);        // 地址栏编辑态：输入框里的路径文本（null＝显示面包屑）
  const addrOn = $derived(addrEdit !== null);
  // 地址栏各段：{ label, rel }＝当前位置内（rel 相对位置根，''=根）；{ label, abs }＝位置根之上的
  // 上级目录（E: › Vault 在 Claude 位置之上），点它按绝对路径换到含它的位置（E:\ 那个），
  // 没有位置含它就只显示不可点（ok=false）。
  const crumbList = $derived.by(() => {
    const inner = segs.map((s, i) => ({ label: s, rel: segs.slice(0, i + 1).join('/') }));
    if (!absOk) return [{ label: rootLabel, rel: '' }, ...inner];
    const parts = splitAbs(curLoc.abs);
    const head = parts.map((p, i) => (i === parts.length - 1 ? { label: p.label, rel: '' } : { label: p.label, abs: p.abs, ok: canFloat || Boolean(resolveAbs(p.abs)) }));
    return [...head, ...inner];
  });
  const crumbItems = $derived(crumbList.map((c) => c.label));
  const crumbRel = (i) => crumbList[i]?.rel ?? null;   // null＝位置根之上（不收拖放：跨位置移动不在这条路上）
  const crumbOk = (i) => crumbList[i]?.rel != null || Boolean(crumbList[i]?.ok);
  function gotoCrumb(i) {
    crumbPop = false;
    const c = crumbList[i];
    if (!c) return;
    if (c.rel == null) { if (c.ok) goAbs(c.abs, { float: canFloat }); return; }
    if (c.rel === '') goRoot(); else navTo({ mode: 'browse', path: c.rel });
  }

  // —— 地址栏编辑（Explorer 式：点空白处 / Ctrl+L / Alt+D 换成完整路径文本，可复制、可输入跳转）——
  const canAddr = $derived(absOk && inBrowse);
  function startAddr() { if (!canAddr) return; crumbPop = false; locPop = false; addrEdit = curAbs; }
  function addrClick(e) { if (addrEdit === null && !e.target.closest?.('button, input')) startAddr(); }
  function addrFocus(node) { node.focus(); node.select(); }
  function addrKey(e) {
    e.stopPropagation();   // Esc/Backspace 这些是全局快捷键（清选择 / 上一级），输入框里的键别漏出去
    if (e.key === 'Escape') { e.preventDefault(); addrEdit = null; rowsEl?.focus({ preventScroll: true }); }
    else if (e.key === 'Enter') { e.preventDefault(); commitAddr(); }
  }
  // 输入的路径：绝对路径照用；相对路径按当前目录拼；. 与 .. 就地化简
  function typedAbs(v) {
    const parts = splitAbs(isWinAbs(v) || v.startsWith('/') ? v : joinPath(curAbs, v));
    const out = [];
    for (const p of parts.slice(1)) { if (p.label === '..') out.pop(); else if (p.label !== '.') out.push(p.label); }
    return joinPath(parts[0].abs, out.join('/'));
  }
  async function commitAddr() {
    const v = String(addrEdit ?? '').trim().replace(/^"(.*)"$/, '$1');
    addrEdit = null;
    rowsEl?.focus({ preventScroll: true });
    if (!v) return;
    const abs = typedAbs(v);
    if (foldAbs(abs) !== foldAbs(curAbs)) await goAbs(abs);
  }
  function addrMenu(e) {
    if (!absOk) return;
    popupMenu(e, [
      { label: t('复制地址'), act: () => copyText(curAbs, t('已复制路径')) },
      { label: t('编辑地址'), hint: 'Ctrl+L', act: startAddr, disabled: !canAddr },
    ]);
  }
  // 折叠档位按【缓存的自然宽度】算，不在 DOM 上反复试：
  //   · 路径 / 搜索 / 模式变了（离散事件）：先全展开一帧，量出每段左缘到末尾的距离存起来；
  //   · 列宽变了（拖侧栏，每帧都来）：只拿缓存和当前可用宽度算出 crumbHide，一步到位。
  // 首版每个像素都「归零→逐段 tick 折回去」，每一步都触发一次工具栏 FLIP、幽灵叠幽灵，拖侧栏时顶栏抽搐。
  const CMORE_W = 30;          // 「…」钮 26px + margin-left 4px（见 .crumb-more / .tb-btn.ell）
  let crumbTail = null;        // tail[i] = 从第 i 段左缘到内容末尾的宽度（第 i 段前的分隔符不计——它随头部一起收走）
  let crumbFit = 0;
  function fitCrumbs() {
    const el = crumbsEl;
    if (!el || !crumbTail) return;
    const cs = getComputedStyle(el);
    // 可用宽＝不带「…」钮时框内的内容宽；当前带着钮就把钮占的宽度加回来，结果与当前档位无关、不会自激振荡
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + (crumbHide > 0 ? CMORE_W : 0);
    let h = 0, sq = false;
    if (crumbTail[0] > avail + 1) {
      h = crumbTail.findIndex((w, i) => i > 0 && w <= avail - CMORE_W + 1);
      if (h < 0) { h = crumbTail.length - 1; sq = true; }
    }
    if (h !== crumbHide) crumbHide = h;
    if (sq !== crumbSqueeze) crumbSqueeze = sq;
  }
  $effect(() => {
    crumbItems; searching; mode;   // 内容变了才重量
    crumbHide = 0; crumbSqueeze = false; crumbTail = null;
    const my = ++crumbFit;
    tick().then(() => {
      const inner = crumbsEl?.firstElementChild;
      if (my !== crumbFit || !inner) return;
      const kids = [...inner.children];
      const segEls = kids.filter((k) => k.classList.contains('crumb'));
      const end = kids.length ? kids[kids.length - 1].offsetLeft + kids[kids.length - 1].offsetWidth : 0;
      // offsetLeft 不含 transform（FLIP 途中也量得准）；recent 模式只有一段，tail 长度 1 → 永不折叠
      crumbTail = segEls.map((k) => end - k.offsetLeft);
      fitCrumbs();
    });
  });
  // 框宽变化（拖列宽 / 分档 / 搜索框展开 / 「…」钮出没）一律走这里；crumbsEl 在第一行与第二行之间换挂时重新盯
  $effect(() => {
    const el = crumbsEl;
    if (!el) return;
    const ro = new ResizeObserver(() => fitCrumbs());
    ro.observe(el);
    untrack(fitCrumbs);
    return () => ro.disconnect();
  });

  // —— 工具栏 FLIP（须放在 crumbHide/crumbSqueeze 声明之后：$effect.pre 在初始化时就同步跑一次）：分档 / 面包屑折叠 / 搜索展开 / 视图切换引起的重排，同一个图形从旧位平移形变过去，
  // 消失的淡出、新出的淡入（lib/flipLayout.js）。pre 在 DOM 变之前拍旧位，post 在 DOM 变之后量新位。 ——
  let toolbarEl = $state();
  const tbFlip = createFlip(() => toolbarEl);
  $effect.pre(() => { tbTier; crumbHide; crumbSqueeze; view; searchFocus; searching; mode; addrOn; untrack(() => tbFlip.snapshot()); });
  $effect(() => { tbTier; crumbHide; crumbSqueeze; view; searchFocus; searching; mode; addrOn; untrack(() => tbFlip.play()); });
  $effect(() => () => tbFlip.destroy());

  // —— 文件夹大小（壳主进程后台递归统计，算完一个推一个；老壳/网页没有这座桥 → 保持「—」）——
  // 键 = scope|rel：scope 区分授权位置与云端根，切位置时旧作业的尾包记在它自己名下、不串台。
  // 重算期间旧值继续显示（文件一变整列闪「…」太吵），新的最终值到了直接覆盖。
  const canDirSize = $derived(hasNativeDirSizes() && (nativeFs || Boolean(wsRoot)));
  const dsScope = $derived(nativeFs ? 'loc:' + locationId : 'ws:' + wsRoot);
  const dsClient = 'fd-' + Math.random().toString(36).slice(2, 10);   // 同一窗口里可能同时挂着好几个工作空间面板
  let dirSizes = $state({});
  const dirSizeOf = (it) => (it?.isDir && !it.linkType ? dirSizes[dsScope + '|' + it.rel] : undefined);
  let dsBump = $state(0);
  let dsSent = '';
  let dsFresh = false;                  // 下一轮全部重算（F5）
  let dsStale = { items: new Set(), dirs: new Set() };
  function requestDirSizes({ fresh = false } = {}) {
    if (fresh) dsFresh = true;
    dsBump++;
  }
  // 云端作用域没有文件 watcher，面板自己动过什么自己报：items＝被移走/删掉的项本身（连子树带上级
  // 作废），dirs＝收进了东西的目标文件夹（只作废它和上级，里面没动的子树继续用缓存）。
  function sizesTouched(items = [], dirs = []) {
    if (nativeFs || !canDirSize) return;
    for (const rel of items) dsStale.items.add(rel);
    for (const rel of dirs) dsStale.dirs.add(rel);
    dsBump++;
  }
  let dsSoonTimer = 0, dsSoonFirst = 0;
  // 文件变化后稍等再重问：主进程已按变化路径把祖先的缓存作废，未变的子树秒回。持续写入时
  // 尾随防抖会一直推迟，最多憋 4 秒也发一次。
  function requestDirSizesSoon() {
    const now = Date.now();
    if (!dsSoonTimer) dsSoonFirst = now;
    clearTimeout(dsSoonTimer);
    dsSoonTimer = setTimeout(() => { dsSoonTimer = 0; requestDirSizes(); }, now - dsSoonFirst > 4000 ? 0 : 800);
  }
  $effect(() => {
    if (!canDirSize) return;
    const bump = dsBump, scope = dsScope;
    const list = searching ? searchItems : mode === 'recent' ? recentItems : items;
    const rels = list.filter((it) => it.isDir && !it.linkType).slice(0, 1000).map((it) => it.rel);
    const sig = scope + '#' + bump + '#' + [...rels].sort().join('\n');
    if (sig === dsSent) return;
    dsSent = sig;
    const payload = { client: dsClient, scope, rels, fresh: dsFresh, staleItems: [...dsStale.items], staleDirs: [...dsStale.dirs] };
    dsFresh = false; dsStale = { items: new Set(), dirs: new Set() };
    if (nativeFs) payload.locationId = locationId; else payload.root = wsRoot;
    untrack(() => nativeWorkspaceDirSizes(payload).then((r) => {
      for (const [rel, v] of Object.entries(r?.results || {})) dirSizes[scope + '|' + rel] = { ...v, done: true };
    }).catch(() => {}));
  });
  onMount(() => {
    if (!hasNativeDirSizes()) return;
    const off = onNativeDirSize((e) => {
      if (e?.client !== dsClient) return;
      const k = e.scope + '|' + e.key;
      if (e.error) { if (!dirSizes[k]) dirSizes[k] = { error: true, done: true }; return; }
      if (!e.done && dirSizes[k]?.done) return;   // 重算途中的半截数不盖掉上一次的最终值
      dirSizes[k] = { size: e.size, files: e.files, partial: e.partial, done: e.done };
    });
    return () => {
      off?.(); clearTimeout(dsSoonTimer);
      nativeWorkspaceDirSizes({ client: dsClient, rels: [] }).catch(() => {});   // 空清单＝取消本面板的作业
    };
  });
  function dirSizeLabel(it) {
    if (it.linkType || !canDirSize) return '—';
    const d = dirSizeOf(it);
    if (!d) return '…';
    if (d.error) return '—';
    return (d.partial && d.done ? '≥ ' : '') + fmtSize(d.size);
  }
  function dirInfoLabel(it) {
    const d = dirSizeOf(it);
    if (it.linkType || !canDirSize || d?.error) return t('文件夹');
    if (!d) return t('计算中…');
    const size = (d.partial && d.done ? '≥ ' : '') + fmtSize(d.size), n = (d.files || 0).toLocaleString(locale());
    return d.done ? t('{size}（{n} 个文件）', { size, n }) : t('{size}（{n} 个文件，统计中…）', { size, n });
  }
  function dirSizeTitle(it) {
    const d = dirSizeOf(it);
    if (!d || d.error) return undefined;
    const n = (d.files || 0).toLocaleString(locale());
    if (!d.done) return t('{n} 个文件（统计中…）', { n });
    return d.partial ? t('{n} 个文件（项目过多，只统计了一部分）', { n }) : t('{n} 个文件', { n });
  }

  // —— 行数据（排序：文件夹恒在前，组内按列排）——
  // 「最近」视图有独立排序态（天然 mtime 倒序），不吃浏览视图的持久化列排序。
  let recentSort = $state({ key: 'mtime', dir: -1 });
  const effSort = $derived(mode === 'recent' && !searching ? recentSort : { key: sortKey, dir: sortDir });
  const listSource = $derived(searching ? searchItems : mode === 'recent' ? recentItems : items);
  const rows = $derived.by(() => {
    const arr = [...listSource];
    const dirCmp = (a, b) => Number(b.isDir) - Number(a.isDir);
    const key = effSort.key, dir = effSort.dir;
    const sizeKey = (it) => (it.isDir ? (dirSizeOf(it)?.size ?? -1) : it.size || 0);
    const cmp = (a, b) => {
      if (key === 'mtime') return ((a.mtime || 0) - (b.mtime || 0)) * dir;
      if (key === 'size') return (sizeKey(a) - sizeKey(b)) * dir;
      if (key === 'type') return String(extOf(a.name)).localeCompare(String(extOf(b.name))) * dir || a.name.localeCompare(b.name, locale());
      return a.name.localeCompare(b.name, locale()) * dir;
    };
    arr.sort((a, b) => dirCmp(a, b) || cmp(a, b));
    return arr;
  });
  const showParentCol = $derived(searching || mode === 'recent');
  const cutSet = $derived(clipboard?.mode === 'cut' && clipboard.locationId === locationId ? new Set(clipboard.rels) : new Set());
  const canPaste = $derived(Boolean(clipboard && clipboard.locationId === locationId && inBrowse));
  const listBusy = $derived(searching ? searchBusy : mode === 'recent' ? recentLoading : loading);
  const anyDialog = $derived(Boolean(menu || infoDlg || shareDlg || zipDlg || aiDlg || sortOpen || addOpen || crumbPop || locPop || renaming));

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
  async function goAbs(abs, { float = false } = {}) {
    let hit = resolveAbs(abs);
    if (!hit && homeAbs && foldAbs(abs) === foldAbs(homeAbs)) hit = { loc: sessionLocFor(homeAbs), rel: '' };
    if (!hit && float && me.kind === 'admin') hit = { loc: floatLocFor(abs), rel: '' };
    if (!hit) {
      toast(nativeOk ? t('「{path}」不在已添加的位置里，可在左侧「添加位置…」里授权', { path: abs }) : t('「{path}」不在可访问的位置里', { path: abs }));
      return false;
    }
    await navTo({ locationId: hit.loc.id, mode: 'browse', path: hit.rel });
    return true;
  }
  const goHomeDir = () => { if (!atHome) goAbs(homeAbs); };

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
  const userRefresh = () => { requestDirSizes({ fresh: true }); return refresh(true); };

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
      try {
        const r = await api.projectLocations();
        list = (r?.locations || []).filter((l) => l && l.id && l.path && l.id !== 'dimensio')
          .map((l) => ({ id: l.id, name: l.name, kind: 'cloud', root: l.id === 'ws' ? '' : l.path, abs: l.path, removable: false }));
      } catch {}
      if (!list?.length) list = [{ id: 'ws', name: t('工作空间'), kind: 'cloud', root: '', abs: '', removable: false }];
      LOC_LIST.cloud = list;
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
    const hit = resolveAbs(joinPath(workspaceRoot, p0));
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
      if (it) openItem(it);
    }).catch(() => {});
    if (!nativeOk) return;
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
      if (canDirSize && under(dir, path)) requestDirSizesSoon();
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
  const thumbSize = () => (view === 'grid' ? 160 : 48);
  const thumbKey = (rel) => rel + '@' + thumbSize();
  async function loadThumb(p) {
    const key = thumbKey(p.rel);
    if (p.isDir || thumbs[key] !== undefined) return;
    thumbs[key] = '';   // 占位防重复请求
    // 云端只有图片有服务端衍生缩略图（sharp）；其余类型留给矢量占位图标，
    // 别去请求一个必然 404 的地址。
    if (!nativeFs) {
      if (kindOf(p.name || p.rel) === 'img') thumbs[key] = cloudFileUrl(p.rel, { thumb: true, mt: p.mtime, ws: wsRoot });
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
  $effect(() => { view; const list = listSource; untrack(() => hydrateEager(list)); });
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
  const OFFICE_EXTS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
  const EXEC_EXTS = ['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'lnk'];
  const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();
  // 文件管理器词表（与 FilesPanel 同款：img/mov/audio/pdf/zip/md/html/text/doc）。
  // 注意 preview.svelte.js 的 kindOf 是另一套预览路由词表（image/video/markdown/other），不能混用。
  function kindOf(name) {
    const e = extOf(name);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(e)) return 'img';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(e)) return 'mov';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(e)) return 'zip';
    if (['md', 'markdown'].includes(e)) return 'md';
    if (['html', 'htm'].includes(e)) return 'html';
    if (['txt', 'js', 'ts', 'json', 'css', 'mjs', 'svelte', 'py', 'sh', 'yml', 'yaml', 'log'].includes(e)) return 'text';
    return 'doc';
  }
  // 额外位置（loc-* / 各盘）里打开的文件，绝对路径要是落在 primary（库）根内，就换算成 primary 的 rel：
  // md 双链 / 出链 / 反链 / 插图、服务端转 PDF、视频流都只认 primary（＝服务端的身份文件根），
  // 不换的话同一篇笔记从「E 盘」点进去链接全断、图裂（M10/T10）。不在库里的照旧按原位置走。
  function primaryRelOf(rel) {
    if (!nativeFs || locationId === 'primary' || !curLoc?.abs) return null;
    const rootAbs = locations.find((l) => l.id === 'primary')?.abs;
    if (!rootAbs) return null;
    const r = relUnder(rootAbs, joinPath(curLoc.abs, rel));
    return r ? r : null;
  }
  const srcItem = (it, kind) => {
    const pr = primaryRelOf(it.rel);
    return { origin: 'cloud', rel: pr ?? it.rel, name: it.name, kind, mt: it.mtime, ws: wsRoot, nativeLocation: nativeFs ? (pr != null ? 'primary' : locationId) : '' };
  };
  function openItem(it) {
    if (it.isDir) { enterDir(it.rel); return; }
    const k = kindOf(it.name), ext = extOf(it.name);
    if (k === 'img') {
      const imgs = rows.filter((f) => !f.isDir && kindOf(f.name) === 'img');
      const idx = Math.max(0, imgs.findIndex((f) => f.rel === it.rel));
      openPreview(imgs.map((f) => srcItem(f, 'image')), idx);
      return;
    }
    if (k === 'mov' || k === 'audio') { openPreview([srcItem(it, k === 'mov' ? 'video' : 'audio')], 0); return; }
    if (k === 'md' || k === 'text') { openPreview([{ ...srcItem(it, k === 'md' ? 'markdown' : 'text') }], 0); return; }
    if (k === 'html') { openPreview([srcItem(it, 'html')], 0); return; }
    if (k === 'pdf') { openPreview([srcItem(it, 'pdf')], 0); return; }
    if (OFFICE_EXTS.includes(ext)) { openPreview([srcItem(it, 'office')], 0); return; }
    // 可执行文件不因双击直接运行（右键仍可显式「用默认应用打开」）；其余类型交系统关联。
    if (EXEC_EXTS.includes(ext)) {
      if (!nativeFs) { doDownload(it); return; }
      doReveal(it); toast(t('可执行文件已在资源管理器中定位（右键可选择打开）')); return;
    }
    if (!nativeFs) { doDownload(it); return; }   // 云端没有「交给系统关联程序」这回事，落到下载
    doOpen(it);
  }
  const doOpen = (it) => nativeWorkspaceOpen(it.rel, locationId).catch((e) => toast(t('打开失败：{reason}', { reason: tr(e.message || '') })));
  const doOpenWith = (it) => nativeWorkspaceOpenWith(it.rel, locationId).catch((e) => toast(t('打开方式失败：{reason}', { reason: tr(e.message || '') })));
  const doReveal = (it) => nativeWorkspaceReveal(it.rel, locationId).catch((e) => toast(t('定位失败：{reason}', { reason: tr(e.message || '') })));
  function doSaveAs(it) {
    nativeWorkspaceSaveAs(it.rel, locationId)
      .then((r) => { if (!r?.canceled) toast(t('已保存到「{path}」', { path: r.path })); })
      .catch((e) => toast(t('保存失败：{reason}', { reason: tr(e.message || '') })));
  }
  // 云端通道的「另存为」＝浏览器下载（&dl=1 让服务端带上 Content-Disposition）。
  function doDownload(it) {
    const href = cloudFileUrl(it.rel, { dl: true, ws: wsRoot });
    const a = document.createElement('a');
    a.href = href; a.download = it.name; document.body.appendChild(a); a.click(); a.remove();
  }

  // —— 文件操作 ——
  async function doTrash() {
    const list = [...selected];
    if (!list.length) return;
    // 原生通道走系统回收站（可撤销），云端通道是真删——所以措辞与确认都不一样。
    // 英文按 GLOSSARY §1.6 让确认钮复述动词（Delete）；中文不传 okLabel，仍是原来的「确定」
    if (!nativeFs && !(await uiConfirm(t('删除选中的 {n} 项？', { n: list.length }), { detail: t('云端工作空间的删除不可撤销。'), okLabel: isEn() ? t('删除') : undefined }))) return;
    busyLabel = nativeFs ? t('移到回收站…') : t('删除中…');
    let fail = 0;
    for (const rel of list) { try { await fsRemove(rel); } catch { fail++; } }
    busyLabel = '';
    sizesTouched(list);
    selected = new Set(); anchorRel = '';
    toast(fail ? t('{n} 项删除失败', { n: fail }) : (nativeFs ? t('已把 {n} 项移到回收站', { n: list.length }) : t('已删除 {n} 项', { n: list.length })));
    await refresh();
  }
  function startRename(it) {
    selected = new Set([it.rel]); anchorRel = it.rel;
    renaming = { rel: it.rel, value: it.name };
  }
  async function commitRename() {
    const r = renaming; renaming = null;
    if (!r) return;
    const name = r.value.trim();
    const oldName = r.rel.split('/').pop();
    if (!name || name === oldName) return;
    try {
      await fsRename(r.rel, name);
      const parent = parentOf(r.rel);
      const newRel = (parent ? parent + '/' : '') + name;
      selected = new Set([newRel]); anchorRel = newRel;
      await refresh();
    } catch (e) { toast(t('重命名失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // 重命名输入框：自动聚焦并选中主文件名（不含扩展名），键盘事件不外泄给全局快捷键。
  // 选区要等一拍：use: 先于 bind:value 执行，此刻 value 还是空串，当场 setSelectionRange 等于什么都没选，
  // 随后填值光标落到末尾——F2 改名 / 新建后键入就成了在旧名后面追加（「未命名.md周报」）。
  function renameInput(node) {
    node.focus();
    queueMicrotask(() => {
      if (document.activeElement !== node) return;
      const dot = node.value.lastIndexOf('.');
      node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
    });
  }
  async function newFolder() {
    if (!inBrowse) return;
    const names = new Set(items.map((x) => x.name));
    // 新文件夹的默认名跟界面语言走（英文 Windows 同款「New folder (2)」）
    let name = t('新建文件夹'), i = 2;
    while (names.has(name)) name = t('新建文件夹 {n}', { n: i++ });
    try {
      await fsMkdir(path, name);
      await load(path);
      const rel = (path ? path + '/' : '') + name;
      focusRel(rel);
      renaming = { rel, value: name };
    } catch (e) { toast(t('新建失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // 新建 Markdown：同资源管理器「新建文本文档」——先按默认名（未命名.md）建好，再原地进入重命名
  //（只选中主文件名，回车即定；不改名直接回车也行）。
  async function newMarkdown() {
    if (!inBrowse) return;
    const name = untitledMdName(items.map((x) => x.name));
    try {
      await fsNewFile(path, name);
      await load(path);
      const rel = (path ? path + '/' : '') + name;
      focusRel(rel);
      renaming = { rel, value: name };
    } catch (e) { toast(t('新建失败：{reason}', { reason: tr(e.body?.error || e.body || e.message || '') })); }
  }
  // 剪贴板两层：面板内部记一份 rel 清单（同位置粘贴直接按 rel 复制/移动，快且保留剪切语义），
  // 同时把真实文件写进 Windows 剪贴板（CF_HDROP）——资源管理器/微信/Word 里 Ctrl+V 都能粘。
  // 云端作用域同样可写：壳与 bridge 服务端在同一台机器，工作空间根 + rel 就是本机路径（与拖出同口径）。
  const canSysClipboard = $derived(hasNativeFileClipboard() && (nativeFs || Boolean(wsRoot)));
  let clipSeq = 0;
  function setClipboard(mode2) {
    if (!selected.size) return;
    const rels = [...selected], id = ++clipSeq, cut = mode2 === 'cut', n = rels.length;
    clipboard = { mode: mode2, locationId, rels, id, sys: false };
    toast(cut ? t('已剪切 {n} 项', { n }) : t('已复制 {n} 项', { n }));
    if (!canSysClipboard) return;
    const payload = nativeFs ? { rels, locationId, cut } : { root: wsRoot, rels, cut };
    const fail = (msg) => {
      if (clipboard?.id !== id) return;
      const reason = msg ? tr(msg) : t('未知错误');
      toast(cut ? t('已剪切 {n} 项，但没能写进系统剪贴板：{reason}', { n, reason }) : t('已复制 {n} 项，但没能写进系统剪贴板：{reason}', { n, reason }));
    };
    nativeClipboardWriteFiles(payload).then((r) => {
      if (r?.ok) { if (clipboard?.id === id) clipboard.sys = true; }
      else if (!r?.superseded) fail(r?.error);
    }).catch((e) => fail(e?.message));
  }
  // 「已移动 / 已复制 n 项（，f 项失败）」——粘贴与拖放共用；英文语序不同，整句一个键
  const doneMsg = (moved, n, f = 0) => (f
    ? (moved ? t('已移动 {n} 项，{f} 项失败', { n, f }) : t('已复制 {n} 项，{f} 项失败', { n, f }))
    : (moved ? t('已移动 {n} 项', { n }) : t('已复制 {n} 项', { n })));
  async function doPaste() {
    if (!inBrowse) return;
    // 先看系统剪贴板：资源管理器里复制/剪切的文件、别的面板或别的位置复制的文件都从这里进来。
    // 剪贴板仍是本面板刚写的那份、且内部清单能直接处理（同位置）时，主进程只回报 ours，交给下面。
    if (nativeFs && hasNativeFileClipboard()) {
      busyLabel = t('粘贴中…');
      let r;
      try { r = await nativeClipboardPasteWorkspace({ rel: path, locationId, skipOurs: canPaste }); }
      catch (e) { r = { handled: false, reason: 'error', error: e?.message }; }
      busyLabel = '';
      if (r?.handled) {
        if (r.cut) clipboard = null;
        const n = r.items?.length || 0;
        toast(n ? doneMsg(r.cut, n, r.errors?.length || 0) : (r.errors?.[0] ? tr(r.errors[0]) : t('粘贴失败')));
        await refresh();
        return;
      }
      if (r?.reason === 'empty') {
        // 内部清单同步进过系统剪贴板、如今那里已经没有文件：被别处的复制顶掉了，或剪切已在资源管理器里粘走。
        if (clipboard?.sys) clipboard = null;
        if (!canPaste) { toast(t('剪贴板里没有文件')); return; }
      }
    }
    if (!canPaste) return;
    const { mode: m, rels } = clipboard;
    busyLabel = m === 'cut' ? t('移动中…') : t('复制中…');
    let ok = 0, err = '';
    for (const rel of rels) {
      if (m === 'cut' && parentOf(rel) === path) { ok++; continue; }   // 原地剪切=无操作
      if (path === rel || path.startsWith(rel + '/')) { err = t('不能把文件夹放进它自身'); continue; }
      try { await (m === 'cut' ? fsMove : fsCopy)(rel, path); ok++; }
      catch (e) { err = e.body?.error || e.message || err; }
    }
    busyLabel = '';
    if (m === 'cut') {
      const wasSys = clipboard?.sys;
      clipboard = null;
      if (wasSys) nativeClipboardClearOwn().catch(() => {});   // 源文件已搬走，别让资源管理器再粘一次
    }
    sizesTouched(m === 'cut' ? rels : [], [path]);
    toast(ok ? doneMsg(m === 'cut', ok) : (err ? tr(err) : t('操作失败')));
    await refresh();
  }
  async function doTransferInto(destRel, rels, copy) {
    const list = rels.filter((rel) => copy || parentOf(rel) !== destRel);
    if (!list.length) return;
    busyLabel = copy ? t('复制中…') : t('移动中…');
    let ok = 0, err = '';
    for (const rel of list) {
      if (destRel === rel || destRel.startsWith(rel + '/')) { err = t('不能把文件夹放进它自身'); continue; }
      try { await (copy ? fsCopy : fsMove)(rel, destRel); ok++; }
      catch (e) { err = e.body?.error || e.message || err; }
    }
    busyLabel = '';
    sizesTouched(copy ? [] : list, [destRel]);
    toast(ok ? doneMsg(!copy, ok) : (err ? tr(err) : t('操作失败')));
    await refresh();
  }

  let extracting = false;
  async function doExtract(it) {
    if (extracting) return;
    extracting = true;
    toast(t('解压中…'));
    try { const r = await api.extractFile(it.rel, srvRoot); toast(t('已解压到「{name}」', { name: r.name })); await refresh(); }
    catch (e) { toast(t('解压失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
    finally { extracting = false; }
  }

  // —— 压缩 ——
  // 桌面壳（Windows）：直接弹系统自带的「创建存档」向导（资源管理器 压缩为 → 其他选项 同一个窗口），
  // 格式/方法/级别都在那里选，压缩进度也是系统的。壳与 bridge 服务端同机，云端作用域的根就是本机路径。
  // 其余情形（浏览器里的电脑版、旧壳）：内置选项对话框 → bridge 服务端压缩（/api/files/compress）。
  const wizardOk = $derived(hasNativeCompressWizard() && (nativeFs || Boolean(wsRoot)));
  const canCompress = $derived(wizardOk || serverOps);
  let wizardOpen = false;
  async function doCompress() {
    const rels = [...selected];
    if (!rels.length) return;
    if (wizardOk) {
      if (wizardOpen) { toast(t('系统压缩窗口已经开着')); return; }
      wizardOpen = true;
      toast(t('正在打开系统压缩窗口…'));
      let r;
      try { r = await nativeCompressWizard(nativeFs ? { rels, locationId } : { root: wsRoot, rels }); }
      catch (e) { r = { ok: false, error: e?.message }; }
      finally { wizardOpen = false; }
      if (r?.busy) { toast(t('系统压缩窗口已经开着')); return; }
      if (r?.ok) {
        if (!r.archive) return;   // 用户点了取消
        const name = baseName(r.archive);
        toast(t('已压缩为「{name}」', { name }));
        await refresh();
        // 存档落在当前目录（默认如此）就选中它；用户在向导里另选了位置则只提示
        if (curAbs && foldAbs(joinPath(curAbs, name)) === foldAbs(r.archive) && inBrowse) focusRel((path ? path + '/' : '') + name);
        return;
      }
      // 向导起不来（系统太旧没有这个窗口等）：有服务端通道就退回内置选项
      if (!serverOps) { toast(t('压缩失败：{reason}', { reason: tr(r?.error || '') })); return; }
    }
    if (!serverOps) return;
    const picked = rels.map((rel) => items.find((x) => x.rel === rel) || searchItems.find((x) => x.rel === rel) || { name: rel.split('/').pop(), isDir: false });
    const dirName = segs.length ? segs[segs.length - 1] : rootLabel;
    zipDlg = {
      rels, sub: rels.length === 1 ? picked[0].name : t('{n} 项', { n: rels.length }),
      name: compressDefaultName(picked, dirName), format: 'zip', level: 'normal',
      formats: ['zip', '7z', 'tar.gz'], busy: false, note: '',
    };
    loadCompressFormats(api).then((formats) => { if (zipDlg) zipDlg.formats = formats; });
  }
  async function runZipDlg() {
    const d = zipDlg;
    if (!d || d.busy || !d.name.trim()) return;
    d.busy = true; d.note = t('正在压缩…');
    const dir = path;
    try {
      const r = await runCompress(api, d.rels, { format: d.format, level: d.level, name: d.name.trim() }, srvRoot, {
        onTick: (st) => { if (zipDlg === d) d.note = st.bytes ? t('正在压缩… 已写入 {size}', { size: fmtSize(st.bytes) }) : t('正在压缩…'); },
      });
      if (zipDlg === d) zipDlg = null;
      toast(t('已压缩为「{name}」', { name: r.name }));
      await refresh();
      if (path === dir && inBrowse) focusRel((dir ? dir + '/' : '') + r.name);
    } catch (e) {
      if (zipDlg === d) { d.busy = false; d.note = ''; }
      toast(t('压缩失败：{reason}', { reason: tr(e.body?.error || e.message || '') }));
    }
  }

  async function importFiles(directory = false) {
    addOpen = false;
    if (!inBrowse) return;
    // 云端通道没有「系统文件对话框直接导入」这条路，改成浏览器选文件 → 分块上传。
    if (!nativeFs) { (directory ? dirUploadInput : fileUploadInput)?.click(); return; }
    try {
      const r = await (directory ? nativeWorkspaceImportDirectory(path, locationId) : nativeWorkspaceImportFiles(path, locationId));
      if (!r?.canceled) { toast(t('已导入 {n} 项', { n: r.items?.length || 0 })); await load(path, { keepSel: true }); }
    } catch (e) { toast(t('导入失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // —— 云端上传（与手机版工作空间同一个上传引擎 lib/uploads.svelte.js：分块并行、卡住/断线自动重发）——
  // webkitRelativePath 存在＝选的是整个文件夹，按相对路径原样铺进目标目录（mk=1 让服务端建子目录）。
  let fileUploadInput = $state(), dirUploadInput = $state();
  async function onUploadPick(e) {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    await uploadFiles(list, path);
  }
  async function uploadFiles(list, destDir) {
    if (!list.length) return;
    let ok = 0;
    for (const f of list) {
      const rel = (f.webkitRelativePath || '').split('/').slice(0, -1).join('/');
      const dir = [destDir, rel].filter(Boolean).join('/');
      busyLabel = t('上传 {name}…', { name: f.name });
      try {
        await sendFile(f, {
          dir, ws: wsRoot, mk: !!rel,
          onProgress: (sent, total) => { busyLabel = t('上传 {name}…', { name: f.name }) + (total > 0 ? ' ' + Math.floor((sent / total) * 100) + '%' : ''); },
        });
        ok++;
      } catch (err) {
        const m = typeof err.body === 'string' ? err.body : err.body?.error;
        toast(t('上传失败：{reason}', { reason: m ? tr(m) : f.name }));
      }
    }
    busyLabel = '';
    sizesTouched([], [destDir]);
    if (ok) toast(t('已上传 {n} 项', { n: ok }));
    await refresh();
  }
  async function addLocation() {
    addOpen = false;
    try {
      const r = await nativeWorkspaceAddLocation();
      await refreshLocations();
      if (!r?.canceled && r?.location?.id) selectLocation(r.location.id);
    } catch (e) { toast(t('添加位置失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function removeLocation(loc) {
    if (!loc?.removable) return;
    if (!(await uiConfirm(t('从 The Bridge 移除「{name}」？', { name: tr(loc.name) }), { detail: t('不会删除电脑上的文件。'), okLabel: isEn() ? t('移除') : undefined }))) return;
    try {
      await nativeWorkspaceRemoveLocation(loc.id);
      if (locationId === loc.id) { locationId = 'primary'; await load(''); }
      await refreshLocations();
    } catch (e) { toast(t('移除位置失败：{reason}', { reason: tr(e.message || '') })); }
  }

  // —— 简介 ——
  async function showInfo(it) {
    infoDlg = { name: it.name, isDir: it.isDir, size: it.size, mtime: it.mtime, rel: it.rel, dir: it.parent ?? parentOf(it.rel), loading: nativeFs };
    if (!nativeFs) return;   // 云端没有 inspect（磁盘占用/属主之类是本机概念），列表里那几项就是全部
    try {
      const d = await nativeWorkspaceInspect(it.rel, locationId);
      if (infoDlg?.rel === it.rel) infoDlg = { ...infoDlg, ...d, loading: false };
    } catch (e) {
      if (infoDlg?.rel === it.rel) infoDlg = { ...infoDlg, loading: false, inspectError: e.message || t('读取失败') };
    }
  }
  async function copyText(text, note = t('已复制')) {
    try { await navigator.clipboard.writeText(text); toast(note); } catch { toast(t('复制失败')); }
  }

  // —— 分享链接（仅 primary：由 bridge 服务端铸造）。文件也铸成只含它的分享空间（/w/），同 FilesPanel ——
  function openShare(it) { shareDlg = { item: it, pwOn: false, password: '', ttl: 24, busy: false, result: null }; }
  async function doShareLink() {
    const d = shareDlg;
    if (!d || d.busy) return;
    const request = shareRequest(d);
    if (request.error) { toast(tr(request.error)); return; }
    d.busy = true;
    try {
      const r = await api.shareSpaceMint([d.item.rel], request.options, srvRoot);
      d.result = shareResult(r, request.password);
    } catch (e) { toast(t('创建分享失败：{reason}', { reason: tr(e.body?.error || e.body || e.message || '') })); }
    d.busy = false;
  }
  const fmtExpire = formatShareExpiry;

  // —— 发送给 AI（仅 primary：服务端要能摸到源文件）——
  function openAi(it) { aiDlg = { item: it, view: 'root', chat: null }; }
  // 文件类型决定能投给哪些模块，再与这个身份开着的 agent 取交集（服务端下发的 me.agents）。
  const aiCaps = $derived.by(() => {
    const c = fileAiCapabilities(aiDlg?.item, kindOf);
    const g = agentOn('gemini');
    return { ...c, claude: agentOn('claude'), gemini: c.gemini && g, video: c.video && g, image: c.image && g, audio: c.audio && g, music: c.music && g };
  });
  async function aiMaterial(it, direct = false) {
    const kind = it.isDir ? 'folder' : (kindOf(it.name) === 'img' ? 'image' : 'file');
    try {
      const up = await api.fileToUpload(it.rel, !direct, srvRoot);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(it.rel, { ws: srvRoot }) : null };
    } catch (e) { toast(t('准备失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return null; }
  }
  async function aiTextContent(it) {
    try {
      const res = await fetch(apiUrl(scopedTo('/api/file?path=' + encodeURIComponent(it.rel), srvRoot)), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) return null;
      return (await res.text()).slice(0, 30000);
    } catch { return null; }
  }
  function pickAI(target) {
    if (target === 'claude' || target === 'gemini') { openChatPick(target); return; }
    const it = aiDlg?.item; aiDlg = null;
    if (it) sendToAI(it, target);
  }
  function pickVideoSlot(slot) { const it = aiDlg?.item; aiDlg = null; if (it) sendToAI(it, 'video', slot); }
  async function openChatPick(target) {
    aiDlg = { ...aiDlg, view: 'chat', chat: { target, sessions: [], loading: true, q: '' } };
    const st = aiDlg.chat;
    await loadAiSessions(target, {
      cached: (tg) => tg === 'claude' ? getCachedSessions() : getCachedVertexSessions(),
      remote: (tg) => tg === 'claude' ? api.sessions() : api.vertexSessions(),
      current: () => aiDlg?.chat === st,
      onCached: (sessions) => { st.sessions = sessions; },
      onDone: (sessions) => { if (sessions) st.sessions = sessions; st.loading = false; },
    });
  }
  function pickChat(sel) {
    const it = aiDlg?.item, tg = aiDlg?.chat?.target;
    aiDlg = null;
    if (it && tg) sendToAI(it, tg, undefined, sel);
  }
  const chatTitle = (s) => tr(aiDlg?.chat?.target === 'claude' ? titleFor(s.id, s.title) : s.title) || t('（无标题）');   // 服务端占位标题（「（进行中…）」「(无标题)」）走 tr
  const aiChatCur = $derived(aiDlg?.chat?.target === 'claude' ? session.id : aiDlg?.chat?.target === 'gemini' ? mods.gemini?.vchat.sessionId : null);
  const aiChatFiltered = $derived.by(() => {
    const c = aiDlg?.chat;
    if (!c) return [];
    return filterAiSessions(c.sessions, c.q, chatTitle);
  });
  function ensureVideoModelFor(slot) {
    const def = caps.data?.veo?.defaults?.model || 'veo-3.1-fast-generate-001';
    const m = vsState.videoModel || def;
    const ic = caps.data?.veo?.imgCaps?.[m] || {};
    const ok = slot === 'last' ? !!ic.last : (ic.ref || 0) > 0;
    if (!ok) vsState.videoModel = def;
  }
  async function sendToAI(it, target, slot, sess) {
    if (target === 'gemini') await ensureModule(target);   // 对话控制器在扩展里，先确保加载
    await sendFileToAi(it, target, slot, sess, {
      kindOf,
      material: aiMaterial,
      readText: aiTextContent,
      toast,
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
            vsState.func = 'chat';
            vsState.chatDraftAtts = [...(vsState.chatDraftAtts || []), attachment];
          },
        },
      },
      mediaState: vsState,
      ensureVideoModel: ensureVideoModelFor,
      navigate: (screen) => { ui.screen = screen; },
    });
  }

  // —— 右键菜单 ——
  function popupMenu(e, entries) {
    e.preventDefault(); e.stopPropagation();
    // 坐标必须换算到【定位坐标系】而不是视口：内嵌进工作台侧栏时外面那层 .dk-embed 带
    // transform，会把 fixed 的包含块从视口变成该容器——直接用 clientX/innerWidth 算出来的
    // 点落在容器外，被 overflow:hidden 裁掉，屏上就只剩一层空遮罩。整页时 rect = 视口，
    // 行为与从前完全一致。
    const box = rootEl?.getBoundingClientRect();
    const ox = box?.left || 0, oy = box?.top || 0;
    const vw = box?.width || window.innerWidth, vh = box?.height || window.innerHeight;
    const cx = e.clientX - ox, cy = e.clientY - oy;
    // 英文菜单项更长（“Move 3 items to Recycle Bin  Del”），贴右缘夹取按更宽的估值算，免得菜单右侧被裁
    const W = isEn() ? 264 : 236, H = entries.filter((x) => !x.sep).length * 30 + entries.filter((x) => x.sep).length * 9 + 12;
    const x = Math.min(Math.max(8, cx), Math.max(8, vw - W - 8));
    const y = cy + H > vh - 10 ? Math.max(8, cy - H) : cy;
    menu = { x, y, entries };
  }
  function menuRun(entry) {
    menu = null;
    if (!entry.disabled) entry.act?.();
  }
  function openItemMenu(e, it) {
    if (renaming) commitRename();
    if (!selected.has(it.rel)) { selected = new Set([it.rel]); anchorRel = it.rel; }
    const multi = selected.size > 1;
    const k = kindOf(it.name);
    const previewable = it.isDir || ['img', 'mov', 'audio', 'md', 'text', 'html', 'pdf'].includes(k) || OFFICE_EXTS.includes(extOf(it.name));
    const entries = [];
    if (!multi) {
      // 不可预览类型（zip/exe/未知）不出「预览」——它们的打开动作就是下面的默认应用/定位。
      if (previewable) entries.push({ label: it.isDir ? t('打开') : t('预览'), act: () => openItem(it), bold: true });
      if (nativeFs && !it.isDir) {
        entries.push({ label: t('用默认应用打开'), act: () => doOpen(it) });
        entries.push({ label: t('打开方式…'), act: () => doOpenWith(it) });
      }
      if (nativeFs) entries.push({ label: t('在文件资源管理器中显示'), act: () => doReveal(it) });
      entries.push({ sep: true });
      if (serverOps) {
        entries.push({ label: t('发送给 AI…'), act: () => openAi(it), accent: true });
        if (pluginOn('share')) entries.push({ label: t('分享链接…'), act: () => openShare(it) });
        if (!it.isDir && k === 'zip') entries.push({ label: t('解压到当前文件夹'), act: () => doExtract(it) });
        entries.push({ sep: true });
      }
      if (!it.isDir) entries.push(nativeFs ? { label: t('另存为…'), act: () => doSaveAs(it) } : { label: t('下载到本地'), act: () => doDownload(it) });
    }
    // 多选同样能压（一起打进一个存档）；搜索结果跨目录，服务端只收同一文件夹里的项，搜索态不出
    if (canCompress && inBrowse) entries.push({ label: multi ? t('压缩 {n} 项…', { n: selected.size }) : t('压缩…'), act: doCompress });
    entries.push({ label: t('剪切'), hint: 'Ctrl+X', act: () => setClipboard('cut') });
    entries.push({ label: t('复制'), hint: 'Ctrl+C', act: () => setClipboard('copy') });
    if (!multi) {
      entries.push({ label: t('重命名'), hint: 'F2', act: () => startRename(it) });
      entries.push({ label: tc('explorer', '简介'), act: () => showInfo(it) });
    }
    entries.push({ sep: true });
    const n = selected.size;
    const delLabel = nativeFs
      ? (multi ? t('移到回收站（{n} 项）', { n }) : t('移到回收站'))
      : (multi ? t('删除（{n} 项）', { n }) : t('删除'));
    entries.push({ label: delLabel, hint: 'Del', act: () => doTrash(), danger: true });
    popupMenu(e, entries);
  }
  function openBlankMenu(e) {
    if (e.target.closest('[data-rel]')) return;
    const entries = [];
    if (inBrowse) {
      entries.push({ label: t('新建文件夹'), act: newFolder });
      entries.push({ label: t('新建 Markdown 文件'), act: newMarkdown });
      entries.push({ label: nativeFs ? t('导入文件…') : t('上传文件…'), act: () => importFiles(false) });
      entries.push({ label: nativeFs ? t('导入文件夹…') : t('上传文件夹…'), act: () => importFiles(true) });
      entries.push({ label: t('粘贴'), hint: 'Ctrl+V', act: doPaste, disabled: !canPaste && !(nativeFs && hasNativeFileClipboard()) });
      entries.push({ sep: true });
    }
    entries.push({ label: t('全选'), hint: 'Ctrl+A', act: selectAll });
    entries.push({ label: t('刷新'), hint: 'F5', act: userRefresh });
    popupMenu(e, entries);
  }
  function openLocMenu(e, loc) {
    const entries = [];
    if (loc.kind === 'native') entries.push({ label: t('在文件资源管理器中显示'), act: () => nativeWorkspaceReveal('', loc.id).catch(() => {}) });
    if (loc.abs && (nativeOk || me.kind === 'admin')) entries.push({ label: t('复制地址'), act: () => copyText(loc.abs, t('已复制路径')) });
    if (loc.removable) entries.push({ label: t('移除位置'), act: () => removeLocation(loc), danger: true });
    if (!entries.length) { e.preventDefault(); return; }
    popupMenu(e, entries);
  }

  // —— 内部拖拽（同位置移动 / Ctrl=复制）+ OS 拖入导入 ——
  let dragRels = null;
  function rowDragStart(e, it) {
    if (renaming) { e.preventDefault(); return; }
    if (!selected.has(it.rel)) { selected = new Set([it.rel]); anchorRel = it.rel; }
    dragRels = [...selected];
    // 桌面壳（#8）：换成原生 OS 拖拽——可拖进 Explorer/微信/Word，也可拖进聊天输入栏
    // （Composer 零拷贝直接引用）。拖回本页时 dragRels 仍在，内部移动分支照旧接管
    //（原生拖在自己窗口上同样触发 HTML5 dragover/drop）。Windows DoDragDrop 是模态——
    // promise resolve＝拖拽结束，在此清态并兜底刷新（外部 Shift 移动会把源文件搬走）。
    // 云端作用域（项目目录不在 primary 位置内）同样原生拖出：bridge 三形态都跑在本机，
    // 服务端绝对路径就是本机路径，拼位置根+rel 走 drag:start（主进程只做存在性校验）。
    if (hasNativeDragOut() && (nativeFs || wsRoot)) {
      e.preventDefault();
      const rels = dragRels;
      const run = nativeFs ? nativeDragWorkspace(rels, locationId) : nativeDragPaths(rels.map((r) => joinAbs(wsRoot, r)));
      run.catch(() => {}).finally(() => {
        if (dragRels === rels) { dragRels = null; dropOn = null; }
        refresh();
      });
      return;
    }
    // 描述符随拖拽一起走：拖回本页＝内部移动（认 dragRels），拖进对话＝按 rel 现场备素材
    // 挂进那个会话的输入栏（见 lib/fileDrag.js 的 attachDescriptorToAgent）。
    try {
      e.dataTransfer.effectAllowed = 'copyMove';
      // dirs 与 rels 一一对应：落点（如 dimensio 跨工作空间那条）要据此把文件夹挑出来说清楚
      const dirs = dragRels.map((rel) => Boolean(rows.find((x) => x.rel === rel)?.isDir));
      e.dataTransfer.setData(WS_DT, JSON.stringify({ rels: dragRels, dirs, ws: wsRoot, locationId: nativeFs ? locationId : '' }));
    } catch {}
  }
  function rowDragEnd() { dragRels = null; dropOn = null; }
  const dtHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
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
      dropOn = it.rel;
    } else if (dtHasFiles(e) && canDropImport && inBrowse) {
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      dropOn = it.rel;
    }
  }
  function dragOverPane(e) {
    if (dragRels) {
      if (!inBrowse) return;
      if (!dragRels.some((rel) => parentOf(rel) !== path) && !e.ctrlKey) return;   // 拖回原地无意义
      e.preventDefault();
      try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch {}
      dropOn = '';
    } else if (dtHasFiles(e) && canDropImport && inBrowse) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      dropOn = '';
    }
  }
  function dragLeavePane(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = null; }
  function dragOverCrumb(e, destRel) {
    if (!dragRels || destRel == null) return;   // 位置根之上的段属于别的位置，不收拖放
    if (destRel === path || !dirDropOk(destRel)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; } catch {}
    dropOn = 'crumb:' + destRel;
  }
  async function onDrop(e) {
    const target = dropOn; dropOn = null;
    if (target === null) return;
    e.preventDefault(); e.stopPropagation();
    const destRel = target.startsWith('crumb:') ? target.slice(6) : (target ? target : path);
    if (dragRels) {
      const rels = dragRels; dragRels = null;
      await doTransferInto(destRel, rels, e.ctrlKey);
      return;
    }
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!nativeFs) { await uploadFiles(files, destRel); return; }
    const paths = files.map(nativePathForFile).filter(Boolean);
    if (!paths.length) { toast(t('无法读取拖入的文件路径')); return; }
    busyLabel = t('导入中…');
    try {
      const r = await nativeWorkspaceImportPaths(destRel, paths, locationId);
      const n = r.items?.length || 0, f = r.errors?.length || 0;
      toast(n ? (f ? t('已导入 {n} 项，{f} 项失败', { n, f }) : t('已导入 {n} 项', { n })) : (r.errors?.[0] ? tr(r.errors[0]) : t('导入失败')));
    } catch (err) { toast(t('导入失败：{reason}', { reason: tr(err.message || '') })); }
    busyLabel = '';
    await refresh();
  }

  // —— 框选（空白处按下拖出选择矩形）——
  function paneDown(e) {
    if (e.button !== 0 || renaming) return;
    try { rowsEl?.focus({ preventScroll: true }); } catch {}
    if (e.target.closest('[data-rel]') || e.target.closest('.fd-colhead')) return;
    const keep = e.ctrlKey || e.metaKey ? new Set(selected) : new Set();
    const x0 = e.clientX, y0 = e.clientY;
    let active = false;
    const move = (ev) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      active = true;
      const l = Math.min(x0, ev.clientX), tp = Math.min(y0, ev.clientY);
      const r = Math.max(x0, ev.clientX), b = Math.max(y0, ev.clientY);
      const box = rootEl?.getBoundingClientRect();
      marquee = { l: l - (box?.left || 0), t: tp - (box?.top || 0), w: r - l, h: b - tp };
      const next = new Set(keep);
      for (const el of rowsEl?.querySelectorAll('[data-rel]') || []) {
        const bb = el.getBoundingClientRect();
        if (bb.left < r && bb.right > l && bb.top < b && bb.bottom > tp) next.add(el.dataset.rel);
      }
      selected = next;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!active) { selected = keep; anchorRel = ''; }
      marquee = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // —— 全局键盘 ——
  let typeBuf = '', typeAt = 0;
  // 内嵌态不能吃整窗的键盘：工作台侧栏旁边就是 Claude 会话，用户在那儿按 Delete/F2
  // 不该动文件。所以只有焦点真的落在本面板内时才接管（点一下列表即获得焦点）。
  const kbdMine = () => (embedded ? !!rootEl && rootEl.contains(document.activeElement) : ui.screen === 'files');
  function onKey(e) {
    if (preview.open) return;                       // 沉浸查看器优先
    if (!kbdMine()) return;
    const inField = e.target.closest?.('input, textarea, [contenteditable]');
    if (e.key === 'Escape') {
      if (menu) { menu = null; return; }
      if (sortOpen || addOpen || crumbPop || locPop) { sortOpen = false; addOpen = false; crumbPop = false; locPop = false; return; }
      if (aiDlg) { aiDlg = null; return; }
      if (shareDlg) { if (!shareDlg.busy) shareDlg = null; return; }
      if (zipDlg) { if (!zipDlg.busy) zipDlg = null; return; }
      if (infoDlg) { infoDlg = null; return; }
      if (renaming) { renaming = null; return; }
      if (inField && inField === searchEl) { query = ''; searchEl.blur(); return; }
      if (query) { query = ''; return; }
      if (selected.size) { selected = new Set(); anchorRel = ''; }
      return;
    }
    if (inField || anyDialog) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); setClipboard('copy'); return; }
    if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); setClipboard('cut'); return; }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); doPaste(); return; }
    if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); searchEl?.focus(); return; }
    if ((ctrl && e.key.toLowerCase() === 'l') || (e.altKey && e.key.toLowerCase() === 'd')) { e.preventDefault(); startAddr(); return; }
    if (e.key === 'F5') { e.preventDefault(); userRefresh(); return; }
    if (e.key === 'F2') { e.preventDefault(); const it = selectedRows()[0]; if (it && selected.size === 1) startRename(it); return; }
    if (e.key === 'Delete') { e.preventDefault(); doTrash(); return; }
    if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); if (canUp) goUp(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goFwd(); return; }
    if (e.key === 'Enter') { e.preventDefault(); const it = selectedRows()[0]; if (it) openItem(it); return; }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (!rows.length) return;
      e.preventDefault();
      let step = 1;
      if (view === 'grid') {
        const cols = Math.max(1, Math.floor((rowsEl?.clientWidth || 800) / 120));
        step = (e.key === 'ArrowDown' || e.key === 'ArrowUp') ? cols : 1;
      }
      const dir2 = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? step : -step;
      const cur = rows.findIndex((r) => r.rel === anchorRel);
      const next = Math.max(0, Math.min(rows.length - 1, cur < 0 ? 0 : cur + dir2));
      if (e.shiftKey && cur >= 0) {
        const [lo, hi] = cur < next ? [cur, next] : [next, cur];
        const s = new Set(selected);
        for (let i = lo; i <= hi; i++) s.add(rows[i].rel);
        selected = s; anchorRel = rows[next].rel;
        tick().then(() => { try { rowsEl?.querySelector(`[data-rel="${CSS.escape(rows[next].rel)}"]`)?.scrollIntoView({ block: 'nearest' }); } catch {} });
      } else focusRel(rows[next].rel);
      return;
    }
    // 键入定位（Explorer 式首字母跳转）
    if (e.key.length === 1 && !ctrl && !e.altKey) {
      const now = Date.now();
      typeBuf = (now - typeAt < 700 ? typeBuf : '') + e.key.toLowerCase();
      typeAt = now;
      const hit = rows.find((r) => r.name.toLowerCase().startsWith(typeBuf));
      if (hit) focusRel(hit.rel);
    }
  }

  function setSort(key) {
    if (mode === 'recent' && !searching) {
      recentSort = recentSort.key === key ? { key, dir: -recentSort.dir } : { key, dir: key === 'mtime' ? -1 : 1 };
      sortOpen = false;
      return;
    }
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === 'mtime' ? -1 : 1; }
    sortOpen = false;
    savePrefs();
  }
  function setView(v) { view = v; savePrefs(); }

  // —— 展示 helpers ——
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // 日期交给 Intl（按界面语言）：中文仍是「9月28日 15:04 / 2025/09/28 15:04 / 2025年9月28日 15:04」，
  // 英文按 GLOSSARY §1.9 出 12 小时制「Sep 28, 3:04 PM / Sep 28, 2025, 3:04 PM」。
  const dtf = (d, o) => new Intl.DateTimeFormat(locale(), o).format(d);
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date(), en = isEn();
    const p = (n) => String(n).padStart(2, '0');
    const hm = en ? dtf(d, { hour: 'numeric', minute: '2-digit' }) : `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return t('今天 {time}', { time: hm });
    const yd = new Date(now); yd.setDate(now.getDate() - 1);
    if (d.toDateString() === yd.toDateString()) return t('昨天 {time}', { time: hm });
    const sameYear = d.getFullYear() === now.getFullYear();
    if (en) return dtf(d, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return dtf(d, sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + hm;
  }
  function fmtFull(ms) {
    if (!ms) return '—';
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    if (isEn()) return dtf(d, { dateStyle: 'medium', timeStyle: 'short' });
    return dtf(d, { year: 'numeric', month: 'long', day: 'numeric' }) + ` ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // 「类型」列：扩展名 + 类别（PNG 图片 / PNG image）；英文语序与中文一致但要小写名词，故每类一个带 {ext} 的键
  const KIND_LABEL = {
    img: (ext) => t('{ext} 图片', { ext }),
    mov: (ext) => t('{ext} 视频', { ext }),
    audio: (ext) => t('{ext} 音频', { ext }),
    pdf: (ext) => t('{ext} PDF 文稿', { ext }),
    zip: (ext) => t('{ext} 压缩归档', { ext }),
    md: (ext) => (isEn() ? t('Markdown 文件') : `${ext} Markdown`),   // 中文仍是「MD Markdown」；英文「MD Markdown」读着像重复，改用 Windows 口吻的类型名（110px 类型列放得下）
    text: (ext) => t('{ext} 文本', { ext }),
    html: (ext) => t('{ext} 网页', { ext }),
    apk: (ext) => t('{ext} 安装包', { ext }),
  };
  function typeLabel(it) {
    if (it.isDir) return t('文件夹');
    const ext = extOf(it.name);
    if (!ext) return t('文件');
    const lb = KIND_LABEL[kindOf(it.name)];
    return lb ? lb(ext.toUpperCase()) : t('{ext} 文件', { ext: ext.toUpperCase() });
  }
  // iOS 文件 app 风类型图标（缩略图/系统图标到位前的占位）
  const TYPE_COLOR = { pdf: '#ff3b30', img: '#32ade6', mov: '#5856d6', audio: '#ff2d55', zip: '#ff9500', md: '#8e8e93', text: '#8e8e93', apk: '#34c759', html: '#ff8d28', doc: '#007aff' };
  function fileIcon(name) {
    const k = kindOf(name);
    const c = TYPE_COLOR[k] || '#007aff';
    const label = name.includes('.') ? (name.split('.').pop() || '').toUpperCase().slice(0, 4) : '';
    return `<svg viewBox="0 0 28 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 4a3 3 0 0 1 3-3h11.5L25 8.5V30a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4Z" fill="#fff" stroke="#d6d6da" stroke-width="1"/>
      <path d="M17.5 1 25 8.5h-5.5A2 2 0 0 1 17.5 6.5V1Z" fill="#e6e6ea"/>
      <rect x="3" y="20.5" width="22" height="9.5" rx="2.6" fill="${c}"/>
      ${label ? `<text x="14" y="27.4" font-size="6" font-weight="700" letter-spacing="-.2" fill="#fff" text-anchor="middle" font-family="'Segoe UI',sans-serif">${label}</text>` : ''}
    </svg>`;
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

<svelte:window onkeydown={onKey} />

<div class="fd-root" class:embedded class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} bind:this={rootEl} role="presentation" oncontextmenu={(e) => e.preventDefault()}>
  <!-- 工具栏：外层 .fd-toolbar 吃右上避让（--fd-avoid-r＝窗控，内嵌时宿主可另给），
       内层 .fd-tb 才是排版容器，宽度用 ResizeObserver 量出来分档（见 tbTier）。 -->
  {#snippet locIcon(loc)}
    {#if loc.id === 'primary' || loc.id === 'ws'}
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
    {#if showSide && addrEdit === null}
      <div class="tb-drop locs">
        <button class="tb-btn" title={tc('explorer', '位置')} aria-label={tc('explorer', '位置')} onclick={() => { locPop = !locPop; crumbPop = false; sortOpen = false; addOpen = false; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6.5" width="17" height="11" rx="2.6"/><path d="M7.2 13.6h.01M10.6 13.6h6.2"/></svg>
        </button>
        {#if locPop}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (locPop = false)}></button>
          <div class="pop left locs-pop">
            {#if homeAbs}
              <button class="pop-mi" class:on={atHome} title={homeAbs} onclick={() => { locPop = false; goHomeDir(); }}>{@render homeIcon()}<span class="pm-nm">{homeLabel}</span></button>
            {/if}
            {#if canRecent}
              <button class="pop-mi" class:on={mode === 'recent' && !searching} onclick={() => { locPop = false; openRecent(); }}>
                <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 2"/></svg><span class="pm-nm">{t('最近')}</span>
              </button>
            {/if}
            {#if homeAbs || canRecent}<div class="pop-sep"></div>{/if}
            {#each sideLocs as loc (loc.id)}
              <button class="pop-mi" class:on={locOn(loc)} title={loc.abs || undefined} onclick={() => { locPop = false; selectLocation(loc.id); }}>{@render locIcon(loc)}<span class="pm-nm">{locName(loc)}</span></button>
            {/each}
            {#if nativeOk}
              <div class="pop-sep"></div>
              <button class="pop-mi" onclick={() => { locPop = false; addLocation(); }}>{t('添加位置…')}</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if crumbHide > 0 && addrEdit === null && !(mode === 'recent' && !searching)}
      <div class="tb-drop crumb-more" data-flip="cmore">
        <button class="tb-btn ell" title={t('被收起的上级目录')} aria-label={t('展开上级目录')} onclick={() => { crumbPop = !crumbPop; locPop = false; sortOpen = false; addOpen = false; }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg>
        </button>
        {#if crumbPop}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (crumbPop = false)}></button>
          <div class="pop left">
            {#each crumbItems.slice(0, crumbHide) as it, i (i)}
              <button class="pop-mi" style:padding-left="{9 + i * 10}px" disabled={!crumbOk(i)} onclick={() => gotoCrumb(i)}>
                <svg class="pm-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/></svg>{it}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <!-- 地址栏：点段跳转；点空白处 / Ctrl+L 换成可编辑的完整路径（Enter 跳转、Esc 放弃），右键复制路径 -->
    <div class="fd-crumbs" class:squeeze={crumbSqueeze} class:editing={addrEdit !== null} class:addr={canAddr}
      role="presentation" bind:this={crumbsEl} data-flip="crumbs" data-flip-morph="x"
      title={canAddr && addrEdit === null ? curAbs : undefined} onclick={addrClick} oncontextmenu={addrMenu}>
      <div class="fd-crumbs-in" data-flip-inner>
        {#if addrEdit !== null}
          <input class="addr-in" bind:value={addrEdit} use:addrFocus onkeydown={addrKey} onblur={() => (addrEdit = null)}
            spellcheck="false" autocomplete="off" aria-label={t('地址')} />
        {:else if mode === 'recent' && !searching}
          <span class="crumb cur" data-flip="crumb-recent" data-flip-anchor="left">{t('最近')}</span>
        {:else}
          {#each crumbItems as it, i (i)}
            {#if i >= crumbHide}
              {#if i > crumbHide}<svg class="crumb-sep" data-flip="csep-{i}" data-flip-anchor="left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 6 6 6-6 6"/></svg>{/if}
              {#if i === crumbItems.length - 1}
                <span class="crumb cur" data-flip="crumb-{i}" data-flip-anchor="left">{it}</span>
              {:else if !crumbOk(i)}
                <span class="crumb off" data-flip="crumb-{i}" data-flip-anchor="left">{it}</span>
              {:else}
                <button class="crumb" data-flip="crumb-{i}" data-flip-anchor="left" class:dropin={dropOn === 'crumb:' + crumbRel(i)}
                  onclick={() => gotoCrumb(i)} ondragover={(e) => dragOverCrumb(e, crumbRel(i))} ondrop={onDrop}>{it}</button>
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
      <button class="pop-mi" onclick={() => setSort(k2)}>
        <span class="pm-check">{#if effSort.key === k2}✓{/if}</span>{lb}
        {#if effSort.key === k2}<span class="pm-dir">{effSort.dir === 1 ? t('升序') : t('降序')}</span>{/if}
      </button>
    {/each}
  {/snippet}

  <div class="fd-toolbar" bind:this={toolbarEl}>
    <div class="fd-tb" class:t1={tbTier >= 1} class:t2={tbTier >= 2} class:t3={tbTier >= 3} class:t4={tbTier >= 4} bind:this={tbEl}>
      {#if !hostChrome}
        <button class="tb-btn" data-flip="home" title={embedded ? t('返回工作台') : t('返回主页')} onclick={goHome} aria-label={embedded ? t('返回工作台') : t('返回主页')}>
          {#if embedded}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9h12v-9"/></svg>
          {/if}
        </button>
      {/if}
      {#if tbTier < 2}
        {#if !hostChrome}<span class="tb-gap"></span>{/if}
        <button class="tb-btn" data-flip="back" title={t('后退（Alt+←）')} aria-label={t('后退')} disabled={!histN.back} onclick={goBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>
        </button>
      {/if}
      {#if tbTier < 1}
        <button class="tb-btn" data-flip="fwd" title={t('前进（Alt+→）')} aria-label={t('前进')} disabled={!histN.fwd} onclick={goFwd}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>
        </button>
      {/if}
      <button class="tb-btn" data-flip="up" title={t('上一级（Backspace）')} aria-label={t('上一级')} disabled={!canUp} onclick={goUp}>
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
          <button class="seg" data-flip="view-list" class:on={view === 'list'} title={tc('explorer', '列表视图')} aria-label={tc('explorer', '列表视图')} onclick={() => setView('list')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" stroke-width="2.6"/></svg>
          </button>
          <button class="seg" data-flip="view-grid" class:on={view === 'grid'} title={tc('explorer', '图标视图')} aria-label={tc('explorer', '图标视图')} onclick={() => setView('grid')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>
          </button>
        </div>
      {:else}
        <button class="tb-btn" data-flip={view === 'list' ? 'view-list' : 'view-grid'} title={view === 'list' ? tc('explorer', '切换为图标视图') : tc('explorer', '切换为列表视图')} aria-label={t('切换视图')} onclick={toggleView}>
          {#if view === 'list'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" stroke-width="2.6"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/></svg>
          {/if}
        </button>
      {/if}

      {#if tbTier < 3}
        <div class="tb-drop sort" data-flip="sort">
          <button class="tb-btn" title={t('排序')} aria-label={t('排序')} onclick={() => { sortOpen = !sortOpen; addOpen = false; crumbPop = false; }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5v14M7 19l-3-3M7 19l3-3"/><path d="M17 19V5M17 5l-3 3M17 5l3 3"/></svg>
          </button>
          {#if sortOpen}
            <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (sortOpen = false)}></button>
            <div class="pop">{@render sortItems()}</div>
          {/if}
        </div>
      {/if}

      <div class="tb-drop add" data-flip="add">
        <button class="tb-btn" title={t('新建 / 导入')} aria-label={t('新建或导入')} onclick={() => { addOpen = !addOpen; sortOpen = false; crumbPop = false; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        {#if addOpen}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (addOpen = false)}></button>
          <div class="pop">
            <button class="pop-mi" disabled={!inBrowse} onclick={() => { addOpen = false; newFolder(); }}>{t('新建文件夹')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => { addOpen = false; newMarkdown(); }}>{t('新建 Markdown 文件')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => importFiles(false)}>{nativeFs ? t('导入文件…') : t('上传文件…')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => importFiles(true)}>{nativeFs ? t('导入文件夹…') : t('上传文件夹…')}</button>
            {#if nativeFs}
              <div class="pop-sep"></div>
              <button class="pop-mi" onclick={addLocation}>{t('添加电脑位置…')}</button>
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
        <div class="side-sec">{tc('explorer', '位置')}</div>
        {#each sideLocs as loc (loc.id)}
          <button class="side-row" class:on={locOn(loc)} title={nativeOk || me.kind === 'admin' ? loc.abs || undefined : undefined}
            onclick={() => selectLocation(loc.id)} oncontextmenu={(e) => openLocMenu(e, loc)}>
            {@render locIcon(loc)}
            <span class="side-nm">{locName(loc)}</span>
          </button>
        {/each}
        {#if nativeOk}
          <button class="side-row add" onclick={addLocation}>
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
          <button class="ch name" onclick={() => setSort('name')}>{t('名称')}{#if effSort.key === 'name'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
          {#if showParentCol}
            <span class="ch parent">{t('位置')}</span>
          {/if}
          <button class="ch mtime" onclick={() => setSort('mtime')}>{t('修改时间')}{#if effSort.key === 'mtime'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
          {#if !showParentCol}
            <button class="ch type" onclick={() => setSort('type')}>{t('类型')}{#if effSort.key === 'type'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
          {/if}
          <button class="ch size" onclick={() => setSort('size')}>{t('大小')}{#if effSort.key === 'size'}<span class="ch-dir">{effSort.dir === 1 ? '▲' : '▼'}</span>{/if}</button>
        </div>
      {/if}

      <!-- tabindex=-1：内嵌态的全局快捷键靠「焦点是否在本面板内」判作用域，点一下列表即取得焦点 -->
      <div class="fd-rows" class:grid={view === 'grid'} class:dropin={dropOn === ''}
        bind:this={rowsEl} role="presentation" tabindex="-1"
        onpointerdown={paneDown} oncontextmenu={openBlankMenu}
        ondragover={dragOverPane} ondragleave={dragLeavePane} ondrop={onDrop}>
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
            <div class="row" data-rel={it.rel} role="button" tabindex="-1"
              class:sel={selected.has(it.rel)} class:cut={cutSet.has(it.rel)} class:dropin={dropOn === it.rel}
              draggable="true"
              ondragstart={(e) => rowDragStart(e, it)} ondragend={rowDragEnd}
              ondragover={(e) => dragOverDir(e, it)} ondrop={onDrop}
              onclick={(e) => clickRow(e, it)} ondblclick={() => { if (!renaming) openItem(it); }}
              oncontextmenu={(e) => openItemMenu(e, it)}>
              <span class="cell name">
                <span class="ric" use:thumbWatch={{ rel: it.rel, name: it.name, mtime: it.mtime, isDir: it.isDir, locationId }}>
                  {#if it.isDir}
                    <img class="ric-dir" src={wsIcon} alt="" draggable="false" />
                  {:else if thumbs[thumbKey(it.rel)]}
                    <img class="ric-img" src={thumbs[thumbKey(it.rel)]} alt="" draggable="false" />
                  {:else}
                    <span class="ric-ph">{@html fileIcon(it.name)}</span>
                  {/if}
                </span>
                {#if renaming?.rel === it.rel}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <input class="rn-input" use:renameInput bind:value={renaming.value}
                    onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = null; }}
                    onblur={commitRename} onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()} />
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
              <span class="cell size" class:pend={it.isDir && canDirSize && !it.linkType && !dirSizeOf(it)?.done} title={it.isDir ? dirSizeTitle(it) : undefined}>{it.isDir ? dirSizeLabel(it) : fmtSize(it.size)}</span>
            </div>
          {/each}
        {:else}
          {#each rows as it (it.rel)}
            <div class="tile" data-rel={it.rel} role="button" tabindex="-1"
              class:sel={selected.has(it.rel)} class:cut={cutSet.has(it.rel)} class:dropin={dropOn === it.rel}
              draggable="true"
              ondragstart={(e) => rowDragStart(e, it)} ondragend={rowDragEnd}
              ondragover={(e) => dragOverDir(e, it)} ondrop={onDrop}
              onclick={(e) => clickRow(e, it)} ondblclick={() => { if (!renaming) openItem(it); }}
              oncontextmenu={(e) => openItemMenu(e, it)}>
              <span class="tic" use:thumbWatch={{ rel: it.rel, name: it.name, mtime: it.mtime, isDir: it.isDir, locationId }}>
                {#if it.isDir}
                  <img class="tic-dir" src={wsIcon} alt="" draggable="false" />
                {:else if thumbs[thumbKey(it.rel)]}
                  <img class="tic-img" src={thumbs[thumbKey(it.rel)]} alt="" draggable="false" />
                {:else}
                  <span class="tic-ph">{@html fileIcon(it.name)}</span>
                {/if}
              </span>
              {#if renaming?.rel === it.rel}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <input class="rn-input tile-rn" use:renameInput bind:value={renaming.value}
                  onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') renaming = null; }}
                  onblur={commitRename} onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()} />
              {:else}
                <span class="tnm" title={it.name}>{it.name}</span>
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
      </div>
    </div>
  </div>

  <!-- 右键菜单 -->
  {#if menu}
    <button class="menu-scrim" aria-label={t('关闭')} onclick={() => (menu = null)} oncontextmenu={(e) => { e.preventDefault(); menu = null; }}></button>
    <div class="ctx" style="left:{menu.x}px; top:{menu.y}px">
      {#each menu.entries as en, i (i)}
        {#if en.sep}
          <div class="ctx-sep"></div>
        {:else}
          <button class="ctx-mi" class:danger={en.danger} class:accent={en.accent} class:bold={en.bold} disabled={en.disabled} onclick={() => menuRun(en)}>
            <span class="ctx-lb">{en.label}</span>
            {#if en.hint}<span class="ctx-hint">{en.hint}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- 框选矩形 -->
  {#if marquee}
    <div class="marquee" style="left:{marquee.l}px; top:{marquee.t}px; width:{marquee.w}px; height:{marquee.h}px"></div>
  {/if}

  <!-- 简介 -->
  {#if infoDlg}
    <div class="dlg-mask" onclick={() => (infoDlg = null)} role="presentation">
      <div class="dlg info" onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="info-top">
          {#if infoDlg.isDir}<img class="info-ico" src={wsIcon} alt="" />{:else}<span class="info-ico file">{@html fileIcon(infoDlg.name)}</span>{/if}
          <div class="info-name">{infoDlg.name}</div>
        </div>
        <div class="info-rows">
          <div class="ir"><span>{t('种类')}</span><b>{typeLabel(infoDlg)}</b></div>
          <div class="ir"><span>{t('大小')}</span><b>{infoDlg.isDir ? dirInfoLabel(infoDlg) : fmtSize(infoDlg.size)}</b></div>
          <div class="ir"><span>{t('修改时间')}</span><b>{fmtFull(infoDlg.mtime)}</b></div>
          <div class="ir"><span>{t('位置')}</span><b class="loc sel-text">{absOk ? joinPath(curLoc.abs, infoDlg.dir || '') : rootLabel + (infoDlg.dir ? ' / ' + infoDlg.dir.split('/').join(' / ') : '')}</b></div>
          {#if infoDlg.loading}<div class="ir"><span>{t('Windows 属性')}</span><b>{t('读取中…')}</b></div>{/if}
          {#if infoDlg.absolutePath}
            <div class="ir"><span>{t('完整路径')}</span><b class="loc selectable" title={t('点击复制')} role="button" tabindex="0" onclick={() => copyText(infoDlg.absolutePath, t('已复制路径'))} onkeydown={(e) => e.key === 'Enter' && copyText(infoDlg.absolutePath, t('已复制路径'))}>{infoDlg.absolutePath}</b></div>
            <div class="ir"><span>{t('访问')}</span><b>{infoDlg.readable ? t('可读') : t('不可读')} · {infoDlg.writable ? t('可写') : t('只读')}{infoDlg.longPath ? ' · ' + t('长路径') : ''}</b></div>
          {/if}
          {#if infoDlg.linkType}<div class="ir"><span>{t('链接')}</span><b class="loc sel-text">{infoDlg.linkType}{infoDlg.linkTarget ? ` → ${infoDlg.linkTarget}` : ''}</b></div>{/if}
          {#if infoDlg.acl}<div class="ir acl"><span>ACL</span><pre>{infoDlg.acl}</pre></div>{/if}
          {#if infoDlg.inspectError}<div class="ir"><span>{t('Windows 属性')}</span><b class="sel-text">{tr(infoDlg.inspectError)}</b></div>{/if}
        </div>
        <div class="dlg-btns">
          <button class="btn" onclick={() => { nativeWorkspaceReveal(infoDlg.rel, locationId).catch(() => {}); }}>{t('在资源管理器中显示')}</button>
          <button class="btn go" onclick={() => (infoDlg = null)}>{t('完成')}</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 分享链接 -->
  {#if shareDlg}
    <div class="dlg-mask" onclick={() => { if (!shareDlg.busy) shareDlg = null; }} role="presentation">
      <div class="dlg" onclick={(e) => e.stopPropagation()} role="presentation">
        {#if !shareDlg.result}
          <h3>{t('分享链接')}</h3>
          <p class="dlg-sub">{shareDlg.item.isDir ? '📁 ' : ''}{shareDlg.item.name}</p>
          <div class="sh-row">
            <span>{t('启用分享密码')}</span>
            <button class="sw" class:on={shareDlg.pwOn} role="switch" aria-checked={shareDlg.pwOn} aria-label={t('启用分享密码')} onclick={() => (shareDlg.pwOn = !shareDlg.pwOn)}><span class="knob"></span></button>
          </div>
          {#if shareDlg.pwOn}
            <input class="dlg-input" bind:value={shareDlg.password} placeholder={t('设置分享密码')} maxlength="64" onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') doShareLink(); }} />
          {/if}
          <div class="sh-ttl">
            {#each SHARE_TTLS as ttl (ttl.h)}
              <button class:on={shareDlg.ttl === ttl.h} onclick={() => (shareDlg.ttl = ttl.h)}>{ttl.lb}</button>
            {/each}
          </div>
          <div class="dlg-btns">
            <button class="btn" onclick={() => (shareDlg = null)}>{t('取消')}</button>
            <button class="btn go" disabled={shareDlg.busy} onclick={doShareLink}>{shareDlg.busy ? t('创建中…') : t('创建链接')}</button>
          </div>
        {:else}
          <h3>{t('链接已创建')}</h3>
          <p class="dlg-sub">{shareDlg.item.isDir ? '📁 ' : ''}{shareDlg.item.name}</p>
          <button class="sh-url" onclick={() => copyText(shareClipboardText(shareDlg.result), t('已复制链接'))}>{shareDlg.result.url}</button>
          <p class="sh-meta">{t('{time} 过期', { time: fmtExpire(shareDlg.result.expiresAt) })}{#if shareDlg.result.pw} · {t('密码')} <b class="sel-text">{shareDlg.result.pw}</b>{/if}</p>
          <div class="dlg-btns">
            <button class="btn" onclick={() => (shareDlg = null)}>{t('完成')}</button>
            <button class="btn go" onclick={() => copyText(shareClipboardText(shareDlg.result), t('已复制链接'))}>{t('复制链接')}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- 压缩（内置选项：桌面壳以外；桌面壳弹的是系统「创建存档」窗口） -->
  {#if zipDlg}
    <div class="dlg-mask" onclick={() => { if (!zipDlg.busy) zipDlg = null; }} role="presentation">
      <div class="dlg" onclick={(e) => e.stopPropagation()} role="presentation">
        <h3>{t('压缩')}</h3>
        <p class="dlg-sub">{zipDlg.sub}</p>
        <div class="zp-lb">{t('存档名称')}</div>
        <div class="zp-name">
          <input class="dlg-input" bind:value={zipDlg.name} disabled={zipDlg.busy} spellcheck="false"
            onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') runZipDlg(); }} />
          <span class="zp-ext">{COMPRESS_FORMATS.find((f) => f.value === zipDlg.format)?.ext}</span>
        </div>
        <div class="zp-lb">{t('格式')}</div>
        <div class="sh-ttl">
          {#each COMPRESS_FORMATS.filter((f) => zipDlg.formats.includes(f.value)) as f (f.value)}
            <button class:on={zipDlg.format === f.value} disabled={zipDlg.busy} onclick={() => (zipDlg.format = f.value)}>{f.label}</button>
          {/each}
        </div>
        <div class="zp-lb">{t('压缩级别')}</div>
        <div class="sh-ttl">
          {#each COMPRESS_LEVELS as lv (lv.value)}
            <button class:on={zipDlg.level === lv.value} disabled={zipDlg.busy} onclick={() => (zipDlg.level = lv.value)}>{tr(lv.lb)}</button>
          {/each}
        </div>
        {#if zipDlg.note}<p class="sh-meta zp-note">{zipDlg.note}</p>{/if}
        <div class="dlg-btns">
          <button class="btn" disabled={zipDlg.busy} onclick={() => (zipDlg = null)}>{t('取消')}</button>
          <button class="btn go" disabled={zipDlg.busy || !zipDlg.name.trim()} onclick={runZipDlg}>{zipDlg.busy ? t('正在压缩…') : t('压缩')}</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- 发送给 AI -->
  {#if aiDlg}
    <div class="dlg-mask" onclick={() => (aiDlg = null)} role="presentation">
      <div class="dlg ai" onclick={(e) => e.stopPropagation()} role="presentation">
        {#if aiDlg.view === 'root'}
          <h3>{t('发送「{name}」给', { name: aiDlg.item.name })}</h3>
          {#if aiCaps.claude}
            <button class="ai-opt" onclick={() => pickAI('claude')}>
              <span class="ai-ic" style="background:#d97757"><svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2.5l2 6.1 6.1 1.9-6.1 2L12 18.5l-2-6-6.1-2 6.1-1.9z"/></svg></span>
              <span class="ai-lb">Claude<small>{t('当附件向 Claude 提问')}</small></span>
              <svg class="ai-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
            </button>
          {/if}
          {#if aiCaps.gemini}
            <button class="ai-opt" onclick={() => (aiDlg = { ...aiDlg, view: 'vertex' })}>
              <span class="ai-ic"><img src="{BASE}assets/icons/gemini.svg" alt="" /></span>
              <span class="ai-lb">Vertex<small>{t('Gemini 对话 / 生成视频·图片·语音·音乐')}</small></span>
              <svg class="ai-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
            </button>
          {/if}
        {:else if aiDlg.view === 'vertex'}
          <h3><button class="ai-back" aria-label={t('返回')} onclick={() => (aiDlg = { ...aiDlg, view: 'root' })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{t('发送给 Vertex')}</h3>
          {#if aiCaps.gemini}
            <button class="ai-opt" onclick={() => pickAI('gemini')}>
              <span class="ai-ic"><img src="{BASE}assets/icons/gemini.svg" alt="" /></span>
              <span class="ai-lb">{t('Gemini 对话')}<small>{t('当附件提问')}</small></span>
              <svg class="ai-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
            </button>
          {/if}
          {#if aiCaps.video}
            <button class="ai-opt" onclick={() => (aiCaps.mode === 'image' ? (aiDlg = { ...aiDlg, view: 'video' }) : pickAI('video'))}>
              <span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2l4.6 2.8L10 14.8z" fill="#fff" stroke="none"/></svg></span>
              <span class="ai-lb">{t('视频生成')}<small>{aiCaps.mode === 'image' ? t('作为首帧 / 尾帧 / 偏好图') : t('作为提示词')}</small></span>
            </button>
          {/if}
          {#if aiCaps.image}
            <button class="ai-opt" onclick={() => pickAI('image')}>
              <span class="ai-ic" style="background:#0088ff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.5" fill="#fff" stroke="none"/><path d="M4 16.5l5-4 4 3 3-2 4 3"/></svg></span>
              <span class="ai-lb">{t('图片生成')}<small>{aiCaps.mode === 'image' ? t('作为改图素材') : t('作为提示词')}</small></span>
            </button>
          {/if}
          {#if aiCaps.audio}
            <button class="ai-opt" onclick={() => pickAI('audio')}>
              <span class="ai-ic" style="background:#ff2d55"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M5 10v4M9 7.5v9M13 9v6M17 6v12M21 10v4"/></svg></span>
              <span class="ai-lb">{t('语音合成')}<small>{t('作为朗读文本')}</small></span>
            </button>
          {/if}
          {#if aiCaps.music}
            <button class="ai-opt" onclick={() => pickAI('music')}>
              <span class="ai-ic" style="background:#ff8d28"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="2.6" fill="#fff" stroke="none"/><circle cx="17" cy="16" r="2.6" fill="#fff" stroke="none"/></svg></span>
              <span class="ai-lb">{t('音乐生成')}<small>{t('作为描述')}</small></span>
            </button>
          {/if}
        {:else if aiDlg.view === 'video'}
          <h3><button class="ai-back" aria-label={t('返回')} onclick={() => (aiDlg = { ...aiDlg, view: 'vertex' })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{t('这张图用作')}</h3>
          <button class="ai-opt" onclick={() => pickVideoSlot('first')}><span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7.5 5.5v13" stroke-width="2.6"/></svg></span><span class="ai-lb">{t('首帧素材')}<small>{t('视频从这张图开始')}</small></span></button>
          <button class="ai-opt" onclick={() => pickVideoSlot('last')}><span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M16.5 5.5v13" stroke-width="2.6"/></svg></span><span class="ai-lb">{t('尾帧素材')}<small>{t('视频结束于这张图')}</small></span></button>
          <button class="ai-opt" onclick={() => pickVideoSlot('ref')}><span class="ai-ic" style="background:#6d7cff"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/></svg></span><span class="ai-lb">{t('偏好图')}<small>{t('带入主体 / 风格参考（Veo 3.1）')}</small></span></button>
        {:else if aiDlg.view === 'chat' && aiDlg.chat}
          <h3><button class="ai-back" aria-label={t('返回')} onclick={() => (aiDlg = { ...aiDlg, view: aiDlg.chat.target === 'claude' ? 'root' : 'vertex', chat: null })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>{t('发送到 {name} · 选择对话', { name: AI_NAMES[aiDlg.chat.target] })}</h3>
          <div class="ai-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input type="search" placeholder={t('搜索对话')} bind:value={aiDlg.chat.q} onkeydown={(e) => e.stopPropagation()} />
          </div>
          <button class="ai-opt" onclick={() => pickChat('new')}>
            <span class="ai-ic" style="background:#34c759"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg></span>
            <span class="ai-lb">{t('新对话')}<small>{t('开一个新对话，附件挂进输入栏')}</small></span>
          </button>
          <div class="ai-list">
            {#each aiChatFiltered as s (s.id)}
              <button class="ai-row" onclick={() => pickChat(s.id)}>
                {#if aiDlg.chat.target === 'claude'}<span class="ai-dot" class:work={s.thinking} class:ask={!s.thinking && s.pending}></span>{/if}
                <span class="ai-title">{chatTitle(s)}</span>
                {#if s.id === aiChatCur}<span class="ai-cur">{t('当前')}</span>{/if}
                {#if s.mtime}<span class="ai-time">{relTime(s.mtime)}</span>{/if}
              </button>
            {:else}
              <div class="ai-empty">{aiDlg.chat.loading ? t('加载中…') : aiDlg.chat.q ? t('没有匹配的对话') : t('还没有历史对话')}</div>
            {/each}
          </div>
        {/if}
        <div class="dlg-btns"><button class="btn" onclick={() => (aiDlg = null)}>{t('取消')}</button></div>
      </div>
    </div>
  {/if}

  {#if toastMsg}<div class="toast">{toastMsg}</div>{/if}

  {#if !nativeFs}
    <input class="hidden-input" bind:this={fileUploadInput} type="file" multiple onchange={onUploadPick} />
    <input class="hidden-input" bind:this={dirUploadInput} type="file" webkitdirectory multiple onchange={onUploadPick} />
  {/if}
</div>

<style>
  /* 桌面工作空间：跟随全站明暗（data-theme），Explorer 级密度；宿主有自己的明暗档时（dimensio）
     经 theme 属性强制 .th-light / .th-dark，与旁边的对话区保持同一档。
     暗色是默认（与 :root 一致：data-theme 缺省即暗）——Claude 底 #1f1f1e 上的 iOS 暗色语言；
     浅色沿用工作空间家族的 iOS 浅色语言（蓝 #0071e3、#f2f2f7）。所有颜色只走下列令牌，别再就地写死。 */
  .fd-root {
    --blue: #4f9dff; --blue-soft: rgba(79, 157, 255, .16); --red: #ff6961;
    --bg: #1f1f1e; --panel: #262625; --bar: rgba(31, 31, 30, .94); --side-bg: rgba(35, 35, 34, .7);
    --ink: #ececea; --ink2: rgba(235, 235, 240, .62); --ink3: rgba(235, 235, 240, .4);
    --sep: rgba(255, 255, 255, .09); --hover: rgba(255, 255, 255, .07); --row-alt: rgba(255, 255, 255, .03);
    --seg-bg: rgba(255, 255, 255, .08); --field-bg: #1b1b1a; --pop-bg: rgba(44, 44, 42, .98); --dlg-bg: #2a2a29;
    --mask: rgba(0, 0, 0, .5); --pop-shadow: 0 10px 34px rgba(0, 0, 0, .55); --ctx-shadow: 0 12px 44px rgba(0, 0, 0, .6);
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
    --blue: #0071e3; --blue-soft: rgba(0, 113, 227, .1); --red: #ff383c;
    --bg: #f2f2f7; --panel: #fff; --bar: rgba(248, 248, 250, .92); --side-bg: rgba(242, 242, 246, .8);
    --ink: #1d1d1f; --ink2: rgba(60, 60, 67, .62); --ink3: rgba(60, 60, 67, .4);
    --sep: rgba(60, 60, 67, .1); --hover: rgba(120, 120, 128, .09); --row-alt: rgba(120, 120, 128, .045);
    --seg-bg: rgba(120, 120, 128, .1); --field-bg: #fff; --pop-bg: rgba(252, 252, 253, .97); --dlg-bg: #fbfbfd;
    --mask: rgba(20, 20, 24, .3); --pop-shadow: 0 10px 34px rgba(0, 0, 0, .16); --ctx-shadow: 0 12px 44px rgba(0, 0, 0, .2);
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
  .fd-rows:focus { outline: none; }   /* tabindex=-1 只为拿焦点判快捷键作用域，不该画焦点框 */

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
  .crumb { flex: 0 0 auto; border: 0; background: none; padding: 3px 7px; border-radius: 6px; font-size: 13px; color: var(--ink2); cursor: pointer; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crumb:hover { background: var(--hover); color: var(--ink); }
  .crumb.cur { color: var(--ink); font-weight: 600; cursor: default; }
  /* 头部全收进「…」了还放不下：这时才让当前目录那段省略号（先折叠、后压缩） */
  .fd-crumbs.squeeze .crumb.cur { flex: 0 1 auto; min-width: 56px; }
  .crumb.cur:hover { background: none; }
  .crumb.dropin { background: var(--blue-soft); color: var(--blue); outline: 1.5px solid var(--blue); }
  .crumb-sep { width: 13px; height: 13px; color: var(--ink3); flex: 0 0 auto; }
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
  .pop-mi:hover:not(:disabled) .side-ic { color: #fff; }
  .tb-btn.ell { width: 26px; height: 26px; border-radius: 7px; color: var(--ink2); }
  .tb-btn.ell svg { width: 15px; height: 15px; }
  .pop.left { left: 0; right: auto; }
  .pop-cap { padding: 5px 9px 2px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--ink3); }
  .pm-ic { width: 14px; height: 14px; flex: 0 0 auto; color: var(--ink2); margin-right: 4px; }
  .pop-mi:hover:not(:disabled) .pm-ic { color: #fff; }
  .crumb-note { margin-left: 8px; font-size: 12px; color: var(--blue); background: var(--blue-soft); padding: 2px 8px; border-radius: 20px; }
  .fd-search { flex: 0 0 auto; display: flex; align-items: center; width: 200px; height: 32px; padding: 0 9px; background: var(--panel); border: 1px solid var(--sep); border-radius: 9px; overflow: hidden; transition: border-color .15s; }
  .fd-search-in { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; height: 100%; }
  /* 宽度变化（聚焦展开 / mini 档）全走 FLIP，不写 transition */
  .fd-search.focus { width: 260px; border-color: rgba(0, 113, 227, .5); }
  .fd-search.active { border-color: rgba(0, 113, 227, .5); }
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
  .pop { position: absolute; top: 36px; right: 0; z-index: 61; min-width: 168px; padding: 5px; background: var(--pop-bg); border: 1px solid var(--sep); border-radius: 11px; box-shadow: var(--pop-shadow); }
  .pop-mi { display: flex; align-items: center; gap: 4px; width: 100%; padding: 6px 9px; border: 0; border-radius: 7px; background: none; text-align: left; font-size: 13px; color: var(--ink); cursor: pointer; }
  .pop-mi:hover:not(:disabled) { background: var(--blue); color: #fff; }
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
  .side-sec { padding: 10px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--ink3); }
  .side-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px; background: none; text-align: left; font-size: 13px; color: var(--ink); cursor: pointer; }
  .side-row:hover { background: var(--hover); }
  .side-row.on { background: rgba(0, 113, 227, .13); color: var(--blue); font-weight: 600; }
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
  .row.sel { background: rgba(0, 113, 227, .16); }
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
  .ric-ph { width: 15px; height: 18px; display: block; }
  .ric-ph :global(svg) { width: 100%; height: 100%; display: block; }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .lk { flex: 0 0 auto; margin-left: 2px; padding: 1px 6px; border-radius: 20px; background: rgba(120, 120, 128, .14); font-size: 10px; color: var(--ink2); }
  .rn-input { flex: 1; min-width: 60px; height: 24px; padding: 0 6px; border: 1.5px solid var(--blue); border-radius: 6px; background: var(--field-bg); font: inherit; font-size: 13px; color: var(--ink); outline: none; user-select: text; }

  /* 图标视图 */
  .fd-rows.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); align-content: start; gap: 2px; padding: 10px; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 10px 6px 8px; border-radius: 10px; cursor: default; }
  .tile:hover:not(.sel) { background: var(--hover); }
  .tile.sel { background: rgba(0, 113, 227, .16); }
  .tic { width: 62px; height: 62px; display: grid; place-items: center; }
  .tic-dir { width: 58px; height: 58px; object-fit: contain; }
  .tic-img { max-width: 62px; max-height: 62px; border-radius: 7px; box-shadow: 0 1px 4px rgba(0, 0, 0, .14); }
  .tic-ph { width: 44px; height: 54px; display: block; }
  .tic-ph :global(svg) { width: 100%; height: 100%; display: block; }
  .tnm { max-width: 100%; font-size: 12px; line-height: 1.3; text-align: center; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-all; }
  .tile-rn { width: 100%; text-align: center; }

  /* 状态栏 */
  .fd-status { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; height: 26px; padding: 0 14px; border-top: 1px solid var(--sep); background: var(--bar); font-size: 11.5px; color: var(--ink2); }
  .st-fill { flex: 1; }
  .st-busy { display: flex; align-items: center; gap: 6px; color: var(--blue); }
  .spin { width: 14px; height: 14px; border: 2px solid rgba(0, 113, 227, .25); border-top-color: var(--blue); border-radius: 50%; animation: fd-spin .8s linear infinite; }
  .spin.sm { width: 11px; height: 11px; border-width: 1.5px; }
  @keyframes fd-spin { to { transform: rotate(360deg); } }

  /* 空态 */
  .fd-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 90px 20px; color: var(--ink2); font-size: 13px; }
  .fd-rows.grid .fd-empty { grid-column: 1 / -1; }
  .fd-empty .big { font-size: 40px; }
  .fd-empty small { font-size: 12px; color: var(--ink3); }

  /* 右键菜单 */
  .menu-scrim { position: fixed; inset: 0; z-index: 80; border: 0; background: transparent; cursor: default; padding: 0; }
  .ctx { position: fixed; z-index: 81; min-width: 236px; padding: 5px; background: var(--pop-bg); border: 1px solid var(--sep); border-radius: 11px; box-shadow: var(--ctx-shadow); animation: fd-pop .12s ease; }
  @keyframes fd-pop { from { opacity: 0; transform: scale(.97); } }
  .ctx-mi { display: flex; align-items: center; width: 100%; padding: 6px 10px; border: 0; border-radius: 7px; background: none; text-align: left; font-size: 13px; color: var(--ink); cursor: pointer; }
  .ctx-mi:hover:not(:disabled) { background: var(--blue); color: #fff; }
  .ctx-mi:hover:not(:disabled) .ctx-hint { color: rgba(255, 255, 255, .75); }
  .ctx-mi:disabled { color: var(--ink3); cursor: default; }
  .ctx-mi.danger { color: var(--red); }
  .ctx-mi.danger:hover:not(:disabled) { background: var(--red); color: #fff; }
  .ctx-mi.accent { color: var(--blue); font-weight: 600; }
  .ctx-mi.accent:hover:not(:disabled) { color: #fff; }
  .ctx-mi.bold { font-weight: 600; }
  .ctx-lb { flex: 1; }
  .ctx-hint { margin-left: 18px; font-size: 11px; color: var(--ink3); }
  .ctx-sep { height: 1px; margin: 4px 9px; background: var(--sep); }

  /* 框选 */
  .marquee { position: fixed; z-index: 70; border: 1px solid rgba(0, 113, 227, .8); background: rgba(0, 113, 227, .12); pointer-events: none; }

  /* 弹窗 */
  .dlg-mask { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: var(--mask); animation: fd-fade .14s ease; }
  @keyframes fd-fade { from { opacity: 0; } }
  .dlg { width: 400px; max-width: calc(100% - 32px); max-height: calc(100% - 56px); overflow-y: auto; padding: 18px; background: var(--dlg-bg); border-radius: 15px; box-shadow: 0 22px 70px rgba(0, 0, 0, .3); animation: fd-rise .16s cubic-bezier(.2, .8, .3, 1); }
  @keyframes fd-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
  .dlg h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 15px; font-weight: 700; }
  .dlg-sub { margin: -4px 0 12px; font-size: 12.5px; color: var(--ink2); word-break: break-all; }
  .dlg-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .btn { padding: 7px 16px; border: 0; border-radius: 9px; background: rgba(120, 120, 128, .13); font-size: 13px; font-weight: 600; color: var(--ink); cursor: pointer; }
  .btn:hover { background: rgba(120, 120, 128, .2); }
  .btn.go { background: var(--blue); color: #fff; }
  .btn.go:hover { filter: brightness(1.08); }
  .btn.go:disabled { opacity: .55; cursor: default; }
  .dlg-input { width: 100%; margin: 8px 0 2px; padding: 8px 10px; border: 1px solid var(--sep); border-radius: 9px; background: var(--field-bg); color: var(--ink); font: inherit; font-size: 13px; outline: none; user-select: text; }
  .dlg-input:focus { border-color: var(--blue); }

  /* 简介 */
  .dlg.info { width: 440px; }
  .info-top { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 4px 0 12px; }
  .info-ico { width: 52px; height: 52px; object-fit: contain; }
  .info-ico.file { width: 44px; height: 52px; display: block; }
  .info-ico.file :global(svg) { width: 100%; height: 100%; }
  .info-name { font-size: 15px; font-weight: 600; text-align: center; word-break: break-all; }
  .info-rows { border-top: 1px solid var(--sep); }
  .ir { display: flex; align-items: baseline; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--sep); }
  .ir span { flex: 0 0 70px; font-size: 12.5px; color: var(--ink2); }
  .ir b { flex: 1; font-size: 12.5px; font-weight: 500; text-align: right; word-break: break-all; }
  .ir b.loc { text-align: right; }
  .ir b.selectable { user-select: text; cursor: pointer; color: var(--blue); }
  .ir.acl { display: block; }
  .ir.acl pre { margin: 6px 0 0; padding: 8px; max-height: 110px; overflow: auto; border-radius: 8px; background: rgba(120, 120, 128, .1); user-select: text; white-space: pre-wrap; word-break: break-all; font: 11px/1.35 Consolas, monospace; }

  /* 分享 */
  .sh-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; font-size: 13px; }
  .sw { position: relative; width: 44px; height: 26px; border: 0; border-radius: 20px; background: rgba(120, 120, 128, .22); cursor: pointer; transition: background .18s; padding: 0; }
  .sw.on { background: #34c759; }
  .sw .knob { position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: transform .18s; }
  .sw.on .knob { transform: translateX(18px); }
  .sh-ttl { display: flex; gap: 6px; margin-top: 8px; }
  .sh-ttl button { flex: 1; padding: 7px 0; border: 1px solid var(--sep); border-radius: 8px; background: var(--field-bg); font-size: 12.5px; color: var(--ink); cursor: pointer; }
  .sh-ttl button.on { border-color: var(--blue); background: var(--blue-soft); color: var(--blue); font-weight: 600; }
  .sh-url { display: block; width: 100%; margin: 6px 0 4px; padding: 10px; border: 1px dashed rgba(0, 113, 227, .5); border-radius: 9px; background: var(--blue-soft); font-size: 12.5px; color: var(--blue); word-break: break-all; text-align: left; cursor: pointer; user-select: text; }
  .sh-meta { margin: 2px 0 0; font-size: 12px; color: var(--ink2); }
  .zp-lb { margin: 12px 0 0; font-size: 12px; font-weight: 600; color: var(--ink2); }
  .zp-name { display: flex; align-items: center; gap: 6px; }
  .zp-name .dlg-input { flex: 1; min-width: 0; margin-top: 6px; }
  .zp-ext { margin-top: 4px; font-size: 13px; color: var(--ink2); white-space: nowrap; }
  .sh-ttl button:disabled { opacity: .55; cursor: default; }
  .zp-note { margin-top: 12px; }

  /* 发送给 AI */
  .dlg.ai { width: 420px; }
  .ai-back { display: grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: 7px; background: none; color: var(--ink2); cursor: pointer; padding: 0; }
  .ai-back:hover { background: var(--hover); }
  .ai-back svg { width: 15px; height: 15px; }
  .ai-opt { display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 10px; border: 0; border-radius: 11px; background: none; text-align: left; cursor: pointer; }
  .ai-opt:hover { background: var(--hover); }
  .ai-ic { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto; overflow: hidden; }
  .ai-ic svg { width: 19px; height: 19px; }
  .ai-ic img { width: 100%; height: 100%; object-fit: cover; }
  .ai-lb { flex: 1; display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; font-weight: 600; }
  .ai-lb small { font-size: 11.5px; font-weight: 400; color: var(--ink2); }
  .ai-chev { width: 15px; height: 15px; color: var(--ink3); }
  .ai-search { display: flex; align-items: center; gap: 7px; margin: 2px 0 8px; padding: 7px 10px; border: 1px solid var(--sep); border-radius: 9px; background: var(--field-bg); }
  .ai-search svg { width: 14px; height: 14px; color: var(--ink3); }
  .ai-search input { flex: 1; border: 0; background: none; outline: none; font-size: 13px; color: var(--ink); user-select: text; }
  .ai-list { max-height: 300px; overflow-y: auto; }
  .ai-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 9px; background: none; text-align: left; cursor: pointer; }
  .ai-row:hover { background: var(--hover); }
  .ai-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(120, 120, 128, .35); flex: 0 0 auto; }
  .ai-dot.work { background: #34c759; }
  .ai-dot.ask { background: #ff9500; }
  .ai-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .ai-cur { flex: 0 0 auto; padding: 1px 7px; border-radius: 20px; background: var(--blue-soft); font-size: 10.5px; color: var(--blue); }
  .ai-time { flex: 0 0 auto; font-size: 11px; color: var(--ink3); }
  .ai-empty { padding: 20px 0; text-align: center; font-size: 12.5px; color: var(--ink3); }

  /* toast */
  .toast { position: fixed; left: 50%; bottom: 44px; z-index: 120; transform: translateX(-50%); padding: 9px 18px; border-radius: 22px; background: rgba(28, 28, 32, .92); color: #fff; font-size: 13px; box-shadow: 0 8px 26px rgba(0, 0, 0, .3); animation: fd-rise .18s ease; white-space: nowrap; max-width: 86%; overflow: hidden; text-overflow: ellipsis; }

  /* 英文界面（html[lang=en]，lib/i18n.js 设置）：英文比中文长，只在英文下放宽/加省略号，中文外观不动 */
  :global(html[lang='en']) .cell.mtime { text-overflow: ellipsis; }                 /* “Sep 28, 2025, 3:04 PM” 在窄列档会被硬裁 */
  :global(html[lang='en']) .ir span { flex-basis: 112px; }                           /* 简介标签列：Date modified / Windows properties 不折行（440px 对话框，值列仍够宽） */
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
