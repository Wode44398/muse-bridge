<script>
  import { uiConfirm } from '../lib/dialogs.js';
  import { t, tc, tr, locale } from '../lib/i18n.js';
  // 工作空间（文件管理）。视觉＝iOS 27（token/配方实测自官方 UI Kit，见设计稿
  // 《工作空间页面demo.html》）；数据＝真实接 /api/files*（admin=vault，user=沙箱）。
  // 固定浅色 grouped 风（像 iOS 文件 app），不跟 bridge 暗主题。
  //
  // 服务端文件系统：浏览/面包屑、分块上传、新建文件夹、重命名、删除、移动/复制、多选、搜索、
  // 预览、发送给 AI、分享链接、解压、下载——全部真实。
  import { onMount } from 'svelte';
  import { ui, compose, session, agentOn, rootScreen } from '../lib/state.svelte.js';
  import { api, authHeaders } from '../lib/api.js';
  import { apiUrl } from '../lib/server.js';
  import { registerCloser } from '../lib/nav.js';
  import { openPreview as openPreviewRaw, cloudFileUrl } from '../lib/preview.svelte.js';
  import { openSession, newConversation } from '../lib/chat.svelte.js';
  import { getCachedSessions } from '../lib/cache.js';
  import { titleFor } from '../lib/library.svelte.js';
  import { relTime } from '../lib/format.js';
  import { entriesFromDrop, walkEntries, groupByRoot, skipNote, pool } from '../lib/dirDrop.js';
  import { reportUi, onAgentFs, onAgentGoto } from '../lib/uiReport.js';
  import { drag, dropZone, beginDrag, addToDrag, isDragging, dragScrollGuard, HOLD_MS, MOVE_TOL } from '../lib/dragdrop.svelte.js';
  import { folderDropZone, wsFilePayload } from '../lib/fileDrag.js';
  import {
    AI_NAMES, SHARE_TTLS, filterAiSessions, filterFilesByName,
    formatShareExpiry, loadAiSessions, normalizeFileQuery, sendFileToAi,
    shareClipboardText, shareRequest, shareResult,
  } from '../lib/files-business.js';

  const BASE = import.meta.env.BASE_URL;

  // readonly = 公开分享只读模式（SharePage 传入）：隐藏所有写操作入口（上传/新建/重命名/
  // 删除/移动/复制/多选/发送 AI），只留浏览 + 预览 + 下载。服务端对 share 身份写接口也一律 401。
  // onExit：内嵌宿主（Claude 工作台把本页整体挂进右侧栏）传入——根部返回时交还宿主
  // （回工作台菜单），并跳过全局 closer 注册（返回键由宿主 dock 的瞬态层接管）。
  // guest = 聊天快照访客（/c/ 链接，工作台内嵌）：文件读写照常（服务端已把 cwd 锁死在快照桶），
  // 但去掉「不属于这个身份」的入口——分享链接铸造（/api/share 对 snap 401）、
  // 发送给 AI（会牵出快照够不着的对话）。
  // picker = 「新建项目」选择器形态（ProjectPicker 挂进来的）：同一套文件管理器，但只做
  // 一件事——把某个文件夹选成新项目的工作空间。写操作只留「新建文件夹」（要一个全新的空
  // 项目就在这儿建），文件只展示不可点开，长按不再出菜单而是【起拖】。
  // 选定手势只有「拖进底栏」这一个，不做点按兜底——点文件夹恒等于「进去」，一旦让它同时
  // 可能是「选它」就再也分不清用户想要哪个。拖源除了文件夹格子，还有顶部那条当前路径条
  // （＝把「我此刻所在的这个文件夹」本身拖走），补上「已经走进去了想选它自己」的死角。
  const {
    readonly = false, guest = false, onExit = null, theme = '', workspaceRoot = '', rootName = '',
    // 管理员的位置切换条（独立工作空间页用）：[{ id, name, path }]，第一条恒为「工作空间」；onLocation(loc) 由宿主换根
    locations = null, locationId = 'ws', onLocation = null,
    initialPath = null, initialOpen = '', previewHost = '',
    picker: wsPick = false, pickerLocations = [], pickerLocationId = '', onPickLocation = null,
    onPick: onPickWs = null, pickLabel = t('拖入选为工作空间'),
  } = $props();
  // 内嵌态的文件预览/编辑也留在侧栏（host:'dock' → 侧栏内嵌 MediaViewer 实例接管，
  // 不再全屏）；独立分页维持全屏。影子包装：本文件所有 openPreview 调用点零改动。
  const openPreview = (items, idx) => openPreviewRaw(items, idx, { host: previewHost || (onExit ? 'dock' : 'app') });
  // 内嵌在工作台（Claude/dimensio 的侧列或底部 sheet）：跟随全站明暗；独立工作空间页维持固定浅色。
  // theme='light'|'dark'：宿主有自己的明暗档（dimensio）时强制跟宿主，左右两栏不许一明一暗。
  const embeddedUi = $derived(Boolean(onExit) || previewHost === 'dock');
  // 搜索行（关闭钮 + 搜索框）用 Figma iOS 27 kit 的液态玻璃（见样式区 .fg）；`?oldglass` 退回原毛玻璃配方
  const fg = typeof location === 'undefined' || !new URLSearchParams(location.search).has('oldglass');
  const scoped = (url) => workspaceRoot ? url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(workspaceRoot) : url;

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

  // —— picker 形态：拖拽选定 ——
  // pkDrag = 正在拖的那一份 { name, abs, x, y, over }（x/y 是 .ws-root 局部坐标，和长按菜单
  // 同一个坐标系：本页内嵌时外层带 transform，fixed 的包含块不是视口）。
  let pkDrag = $state(null);
  let pkDockEl = $state();         // 底栏元素（松手命中判定按它的 rect）
  let pkTimer = null, pkFrom = null, pkPid = -1;
  // base 已以分隔符结尾（如根 '/'）时直接拼；去掉尾分隔符再补会改变盘根这类路径的含义。
  // 所以只在没有尾分隔符时才补一个。
  const joinAbs = (base, rel) => {
    const b = String(base || '');
    if (!rel) return b;
    return /[\\/]$/.test(b) ? b + rel : b + '/' + rel;
  };
  const pkAbs = (rel) => joinAbs(workspaceRoot, rel);

  let aiPick = $state(null);         // 「发送给 AI」要发的那个 item
  let aiChat = $state(null);         // 「选择对话」层：{ sessions, loading, q }
  let tasks = $state([]);          // 上传任务（传输面板）
  let transferOpen = $state(false);
  let toastMsg = $state('');
  let fileInput = $state();

  // —— 面包屑 / 分组 / 派生 ——
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const rootLabel = $derived(readonly ? t('分享空间') : (tr(rootName) || t('工作空间')));   // rootName 出自服务端：显示点兜 tr()
  const title = $derived(segs.length ? segs[segs.length - 1] : rootLabel);
  const folders = $derived(items.filter((i) => i.isDir));
  const files = $derived(items.filter((i) => !i.isDir));
  // 分享只读模式不出「最近」区：桶顶层就那几项，跟正文重复只添乱。
  const recents = $derived(
    !segs.length && !query && !readonly && !wsPick    // 选择器只挑文件夹，「最近」全是文件，纯噪音
      ? [...files].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 6)
      : []
  );
  const q = $derived(normalizeFileQuery(query));
  const showFolders = $derived(q ? filterFilesByName(folders, q) : folders);
  const showFiles = $derived(q ? filterFilesByName(files, q) : files);
  const isEmpty = $derived(!loading && !showFolders.length && !showFiles.length);

  const activeTasks = $derived(tasks.filter((tk) => tk.status === 'up'));
  const ringPct = $derived.by(() => {
    const a = tasks.filter((tk) => tk.status === 'up');
    if (!a.length) return tasks.length && tasks.every((tk) => tk.status === 'done') ? 1 : 0;
    const tot = a.reduce((s, tk) => s + tk.total, 0) || 1;
    return a.reduce((s, tk) => s + tk.sent, 0) / tot;
  });
  const allDone = $derived(tasks.length > 0 && tasks.every((tk) => tk.status !== 'up'));

  // —— 加载 / 导航（/api/files）——
  // 乐观导航：进目录/返回/面包屑点下去**当帧就切 path**——列表缓存命中立即出上次内容、
  // 网络退到点击之后后台对账刷新；没缓存才亮 loading。弱网里返回不再「点了等一拍才动」。
  // 同目录刷新（agent fs 事件/写操作后对账）保留现有内容静默换新，不清屏不回顶。
  const LIST_CACHE = (window.__bridgeFilesListCache ||= new Map());   // listKey → items（SPA 存活期内存缓存）
  const listKey = (p) => (readonly ? 'share' : 'cloud') + '\x1f' + (workspaceRoot || '') + '\x1f' + p;
  let shownKey = null;   // 当前 items 属于哪个 listKey（跨位置切换时避免误判「同目录」）
  let loadSeq = 0, loadCtrl = null;   // 竞态闸 + 在途请求中止柄（快速连点只认最后一次）
  async function load(p) {
    const my = ++loadSeq;
    const key = listKey(p), same = key === shownKey;
    path = p;
    if (!same) {
      const cached = LIST_CACHE.get(key);
      if (cached) { items = cached; loading = false; } else { items = []; loading = true; }
      shownKey = key;
      if (scroller) scroller.scrollTop = 0;
      scrolled = false;
    } else if (!items.length) loading = true;
    loadCtrl?.abort();
    const ctrl = (loadCtrl = new AbortController());
    const timer = setTimeout(() => ctrl.abort(), 15000);   // 半开 socket 永挂兜底：15s 超时
    try {
      const r = await api.files(p, workspaceRoot, { signal: ctrl.signal });
      LIST_CACHE.set(listKey(r.path ?? p), r.items || []);
      if (my !== loadSeq) return;   // 已被更新的导航替代：结果只进缓存不上屏
      items = r.items || []; path = r.path || p; shownKey = listKey(path);
    }
    catch (e) {
      if (my !== loadSeq) return;
      toast(e?.name === 'AbortError' ? t('加载超时') : t('加载失败：{reason}', { reason: tr(e.body?.error || e.message || '') }));
    }
    finally { clearTimeout(timer); if (my === loadSeq) loading = false; }
  }
  // 缓存镜像：屏上列表怎么变（乐观删除/改名/上传后刷新），缓存跟着变——返回时不会把
  // 刚删的文件短暂「复活」。loading 中不写（别把还没到货的空列表当真相存起来）。
  $effect(() => { const list = items; if (!loading && shownKey) LIST_CACHE.set(shownKey, list); });
  function itemRel(item) { return item?.rel || (path ? path + '/' + item.name : item?.name || ''); }
  function enterDir(item) {
    if (selecting) { toggleSel(item.name); return; }
    if (query) closeSearch();
    load(itemRel(item));
  }
  function goSeg(i) { load(segs.slice(0, i + 1).join('/')); }
  function goRoot() { load(''); }
  function goHome() {
    if (onExit) { onExit(); return; }   // 内嵌在 Claude 工作台里：根部返回=回工作台菜单
    ui.screen = rootScreen();           // 单 agent 模式没有主页：回那一页
  }

  // 系统返回键 / 侧滑：有搜索/多选/面包屑就逐级退，到根再回主页
  function back() {
    if (aiPick) { closeAi(); return; }
    if (infoItem) { infoItem = null; return; }
    if (picker) { picker = null; return; }
    if (preview) { preview = null; return; }
    if (menu) { menu = null; return; }
    if (addOpen) { addOpen = false; return; }
    if (mkOpen) { mkOpen = null; return; }
    if (shareDlg) { shareDlg = null; return; }
    if (renameTarget) { renameTarget = null; return; }
    if (transferOpen) { transferOpen = false; return; }
    if (searching) { searching = false; query = ''; return; }
    if (selecting) { exitSelect(); return; }
    if (segs.length) { load(segs.slice(0, -1).join('/')); return; }
    if (readonly) return;   // 分享页没有主页可回（SharePage 外面没有 App 的 screen 体系）
    goHome();
  }
  // 独立分页时才注册全局返回 closer；内嵌态由宿主 dock 的瞬态返回层接管。
  $effect(() => { if (!onExit) return registerCloser('files', back); });

  // —— 工作区协同：① 视图上报（agent 的 workspace.view 知道用户面板在哪个目录）；
  // ② 订阅 agent 的 fs 刷新（agent 改完文件列表自动跟上）与 goto 导航。分享只读页不参与。
  $effect(() => { if (!readonly) reportUi({ files: { path, ws: workspaceRoot || '', query: q || '' } }); });
  $effect(() => {
    if (readonly) return;
    let timer = 0;
    const offFs = onAgentFs(() => { clearTimeout(timer); timer = setTimeout(() => load(path), 350); });
    const offGoto = onAgentGoto((rootRel) => load(rootRel));
    return () => { clearTimeout(timer); offFs(); offGoto(); };
  });

  // ui.filesPath：一次性初始路径（内嵌宿主开工作台「文件」时预置成工作空间目录；
  // 消费即清，load 失败内部 toast 后停留根目录视图）。
  onMount(() => {
    const p0 = initialPath ?? ui.filesPath ?? '';
    if (initialPath == null) ui.filesPath = null;
    // initialOpen：列表就位后自动打开指定文件的面板内预览（文件产物卡/正文链接
    // 「在工作区里打开」走它）。一次性；列表里找不到（已删/改名）就安静停在目录。
    const p = load(p0);
    if (initialOpen) Promise.resolve(p).then(() => {
      const it = items.find((f) => !f.isDir && f.name === initialOpen);
      if (it) openFile(it);
    }).catch(() => {});
  });

  // —— 搜索 ——
  function openSearch() { searching = true; setTimeout(() => searchEl?.focus(), 60); }
  function closeSearch() { searching = false; query = ''; }

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
    if (selecting) return;
    if (isDragging()) return;         // 已经拎着一份了：这根手指是来翻页/加叠的，别再拿起第二份
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

  // 长按到 ~500ms 时，移动端浏览器会自己补一发 contextmenu。手指这条路我们已经有自己的
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
  const canLift = $derived(!readonly && !wsPick && !selecting);
  // 正被拎着的那一叠（原位淡出，像 iOS 那样"被拿走了"）；幽灵落地/飞回后 drag.on 归零才恢复
  let liftRels = $state(new Set());
  $effect(() => { if (!drag.on && liftRels.size) liftRels = new Set(); });

  // 作用域指纹：服务端文件系统 + ws 根——同根才谈得上「移动」，不同根走跨根搬运（见 moveSnapInto）
  const dragCtx = $derived({ origin: 'cloud', ws: workspaceRoot || '' });

  // 本页的三类落点：当前目录（列表空白处）/ 某个文件夹格子 / 面包屑上的某一级。
  // 只读分享空间与选择器形态整体关掉（那儿没有写操作）。
  // 文件夹格子与面包屑都带 spring：拎着东西在上面悬停一会儿就自动进去/退到那一级（iOS 的
  // spring-loaded folders），单指也能一路钻到目标目录再松手。
  // onDone：本页是【目标】时搬完刷新——跨作用域拖放的源面板在别处（工作台里那个），它的 afterMove 刷不到这里。
  const zoneDone = () => { if (alive) load(path); };
  const hereZone = $derived(folderDropZone({ key: 'ws-here', name: title, ctx: dragCtx, rel: path, disabled: readonly || wsPick, onDone: zoneDone }));
  const folderZone = (f) => folderDropZone({ key: 'ws-dir:' + itemRel(f), name: f.name, ctx: dragCtx, rel: itemRel(f), disabled: readonly || wsPick, spring: () => enterDir(f), onDone: zoneDone });
  const crumbZone = (i) => folderDropZone({ key: 'ws-crumb:' + i, name: i < 0 ? rootLabel : segs[i], ctx: dragCtx, rel: i < 0 ? '' : segs.slice(0, i + 1).join('/'), disabled: readonly || wsPick, spring: () => (i < 0 ? goRoot() : goSeg(i)), onDone: zoneDone });

  // 拖拽会【活过本页的卸载】——另一根手指收起工作台、切走分页，源面板就没了。所以起拖那一刻
  // 必须把「这一份是谁、在哪个作用域」整个拍成快照：
  //   · rel 用当时的目录算（拖到一半用户已翻去别的目录，再 itemRel 会拼出不存在的路径 → 404）；
  //   · 作用域字段更要命——workspaceRoot 是 props，卸载后它的 getter 会一路读到宿主已清空的
  //     filesMount，直接抛 "Cannot read properties of null (reading 'ws')"（实测）。
  // 快照之后，落地这两件事只吃纯数据，与组件生死无关。
  const liftSnap = (item) => ({
    rel: itemRel(item), name: item.name, isDir: !!item.isDir, root: workspaceRoot || '',
  });
  let alive = true;
  $effect(() => () => { alive = false; });

  // destCtx 非空＝跨作用域（云端 ↔ 云端，两个根都在服务端）：源按快照里的 root、目标按落点的 ws，
  // /api/files/move 带 fromWs 一次搬完（跨卷服务端自己回落 copy+rm）。
  async function moveSnapInto(snap, destRel, destCtx = null) {
    try {
      if (destCtx && destCtx.origin === 'cloud' && (destCtx.ws || '') !== (snap.root || '')) await api.moveFile(snap.rel, destRel, destCtx.ws || '', snap.root || '');
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
    else if (act === 'ai') openAiPick(it);
    else if (act === 'sharelink') shareDlg = { item: it, pwOn: false, password: '', ttl: 24, busy: false, result: null };
    else if (act === 'move') openMovePicker([it.name], 'move', it.parent ?? path);
    else if (act === 'copy') openMovePicker([it.name], 'copy', it.parent ?? path);
    else if (act === 'download') download(itemRel(it));
    else if (act === 'extract') doExtract(it);
  }

  // 「解压」：服务端用本机的解压工具（bsdtar 等）解到同目录同名文件夹。
  // 请求同步等解压完成（大包可能要等一会儿），完成后刷新列表定位到新文件夹。
  let extracting = $state(false);
  async function doExtract(item) {
    if (extracting) return;
    extracting = true;
    toast(t('解压中…'));
    try { const r = await api.extractFile(itemRel(item), workspaceRoot); toast(t('已解压到「{name}」', { name: r.name })); await load(path); }
    catch (e) { toast(t('解压失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
    finally { extracting = false; }
  }
  function showInfo(item) {
    infoItem = { name: item.name, isDir: item.isDir, size: item.size, mtime: item.mtime, dir: item.parent ?? path };
  }

  // 「分享链接」：学 qq-bot 铸公开链接（可选密码 + 过期时间）。文件和文件夹一律走
  // /api/share-space 拷成只读分享空间出 /w/<token>——单文件就是「只有一个文件的空间」，
  // 访客点开预览（md 渲染而非源码）、右键/长按下载，与文件夹分享同一套页面。/s/ 直链
  // （/api/share）只留给要裸下载地址的 API 调用方。
  async function doShareLink() {
    const d = shareDlg;
    if (!d || d.busy) return;
    const request = shareRequest(d);
    if (request.error) { toast(tr(request.error)); return; }
    d.busy = true;
    const r0 = itemRel(d.item);
    try {
      const r = await api.shareSpaceMint([r0], request.options, workspaceRoot);
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

  // —— 「发送给 AI」：选一个 Claude 对话（或新对话），把文件挂进它的输入栏 ——
  // 入口只在这个身份开着 Claude 时出现（服务端下发的 me.agents，见 agentOn）。
  // 弄成可投递素材：fileToUpload（direct=零拷贝直给源绝对路径，Claude 在服务器本机直读；否则拷进 uploads）。
  async function aiMaterial(item, direct = false) {
    const r = itemRel(item);
    const kind = item.isDir ? 'folder' : (kindOf(item.name) === 'img' ? 'image' : 'file');
    try {
      const up = await api.fileToUpload(r, !direct, workspaceRoot);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(r, { ws: workspaceRoot }) : null };
    } catch (e) { toast(t('准备失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return null; }
  }
  // —— 「选择对话」层（微信「选择聊天」式）：新对话 / 历史会话列表 + 搜索 ——
  // 列表本地缓存先出（IndexedDB 快照秒开），网络刷新殿后。
  async function openAiPick(item) {
    aiPick = item;
    aiChat = { sessions: [], loading: true, q: '' };
    const st = aiChat;   // 代理引用：用户退出/重进后 aiChat 换了对象，旧请求返回即作废
    await loadAiSessions('claude', {
      cached: () => getCachedSessions(),
      remote: () => api.sessions(),
      current: () => aiChat === st,
      onCached: (sessions) => { st.sessions = sessions; },
      onDone: (sessions) => { if (sessions) st.sessions = sessions; st.loading = false; },
    });
  }
  function closeAi() { aiPick = null; aiChat = null; }
  function pickChat(sel) {   // sel: 'new' | 会话 id
    const it = aiPick;
    closeAi();
    if (it) sendToAI(it, sel);
  }
  const chatTitle = (s) => tr(titleFor(s.id, s.title)) || t('（无标题）');   // 服务端占位标题走 tr
  const aiChatFiltered = $derived.by(() => {
    if (!aiChat) return [];
    return filterAiSessions(aiChat.sessions, aiChat.q, chatTitle);
  });
  async function sendToAI(item, sess) {
    await sendFileToAi(item, sess, {
      material: aiMaterial,
      toast,
      chat: {
        current: () => session.id,
        newChat: newConversation,
        load: openSession,
        attach: (attachment) => compose.attachments.push(attachment),
      },
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
    try { await api.renameFile(rel(item.name), name, workspaceRoot); }
    catch (e) { items = prev; toast(t('重命名失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  async function doDelete(item) {
    if (!(await uiConfirm(item.isDir ? t('删除「{name}」？（含其中全部内容）', { name: item.name }) : t('删除「{name}」？', { name: item.name })))) return;
    const prev = items;
    items = items.filter((x) => x.name !== item.name);   // 乐观移除（即时），失败回滚
    try { await api.deleteFile(rel(item.name), workspaceRoot); }
    catch (e) { items = prev; toast(t('删除失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  async function multiDelete() {
    const names = [...selected];
    if (!names.length || !(await uiConfirm(t('删除选中的 {n} 项？', { n: names.length })))) return;
    const sel = new Set(names);
    items = items.filter((x) => !sel.has(x.name));   // 乐观移除（即时）
    exitSelect();
    let fail = 0;
    for (const n of names) {
      try { await api.deleteFile(rel(n), workspaceRoot); } catch { fail++; }
    }
    if (fail) { await load(path); toast(t('{n} 项删除失败', { n: fail })); }   // 有失败才重拉准确状态
  }
  async function doMkdir() {
    const name = (mkOpen.value || '').trim();
    mkOpen = null;
    if (!name) return;
    try {
      await api.mkdir(path, name, workspaceRoot);
      toast(t('已新建文件夹')); await load(path);
    }
    catch (e) { toast(t('新建失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  const rel = (name) => (path ? path + '/' + name : name);

  // —— 移动到 / 复制到：目录选择器 sheet（浏览文件夹树选目标，走 /api/files）——
  let picker = $state(null);   // { mode:'move'|'copy', names:[源名], srcDir, path, items, loading }
  async function openMovePicker(names, mode, sourceDir = path) {
    if (!names.length) return;
    picker = { mode, names: [...names], srcDir: sourceDir, path: '', items: [], loading: true };
    await pickerLoad('');
  }
  async function pickerLoad(p) {
    if (!picker) return;
    picker.path = p; picker.loading = true; picker = { ...picker };
    let dirs = [];
    try {
      const r = await api.files(p, workspaceRoot);
      dirs = (r.items || []).filter((i) => i.isDir && i.linkType !== 'external-link');
    } catch {}
    if (!picker) return;
    picker.items = dirs; picker.loading = false; picker = { ...picker };
  }
  function pickerEnter(name) { pickerLoad(picker.path ? picker.path + '/' + name : name); }
  function pickerCrumb(i) { pickerLoad(picker.path.split('/').filter(Boolean).slice(0, i + 1).join('/')); }
  async function pickerConfirm() {
    const { mode, names, srcDir, path: dest } = picker;
    picker = null;
    let okN = 0, err = '';
    for (const n of names) {
      try {
        const source = srcDir ? srcDir + '/' + n : n;
        await (mode === 'move' ? api.moveFile : api.copyFile)(source, dest, workspaceRoot);
        okN++;
      }
      catch (e) { err = e.body?.error || err; }
    }
    if (selecting) exitSelect();
    toast(okN ? (mode === 'move' ? t('已移动 {n} 项', { n: okN }) : t('已复制 {n} 项', { n: okN })) : (tr(err) || t('操作失败')));
    await load(path);
  }
  const pickerDestName = $derived.by(() => {
    if (!picker) return '';
    const ps = picker.path.split('/').filter(Boolean);
    return ps.length ? ps[ps.length - 1] : t('工作空间');
  });

  // —— 上传（分块，进度入传输面板）——
  function pickUpload() {
    addOpen = false;
    fileInput?.click();
  }
  async function onPick(e) {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of list) uploadOne(f);
  }
  let uid = 0;
  async function uploadOne(file, intoDir) {
    const id = 'u' + Date.now() + (uid++);
    const dir = intoDir ?? path;   // 拖到某个文件夹上时传进那个文件夹，否则当前目录
    // bps=传输速率（每片完成用 片字节/耗时 做 EMA 平滑）；ctrl=取消通道（abort 掐断在途分块请求）。
    const task = { id, name: file.name, total: file.size || 1, sent: 0, status: 'up', kind: kindOf(file.name), bps: 0, lastT: 0, ctrl: new AbortController() };
    tasks = [task, ...tasks];
    const CHUNK = 1024 * 1024;
    const idr = 'up' + Math.random().toString(36).slice(2, 12);
    try {
      task.lastT = performance.now();
      for (let off = 0; off < file.size || off === 0; off += CHUNK) {
        const chunk = file.slice(off, off + CHUNK);
        const last = off + CHUNK >= file.size ? 1 : 0;
        const url = scoped(`/api/files/upload?path=${encodeURIComponent(dir)}&id=${idr}&last=${last}&name=${encodeURIComponent(file.name)}`);
        await api.post(url, chunk, { signal: task.ctrl.signal });
        const now = performance.now(), dt = (now - task.lastT) / 1000;
        const sent = Math.min(file.size, off + CHUNK);
        if (dt > 0) { const inst = (sent - task.sent) / dt; task.bps = task.bps ? task.bps * 0.6 + inst * 0.4 : inst; }
        task.lastT = now; task.sent = sent;
        tasks = [...tasks];   // 触发响应
        if (last) break;
      }
      task.status = 'done'; tasks = [...tasks];
      if (dir === path) await load(path);
      toast(t('已上传 {name}', { name: file.name }));
      setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 4000);
    } catch (e) {
      if (task.status === 'cancelled' || e?.name === 'AbortError') {   // 用户取消：不算错误，短暂显示后自动清行
        tasks = [...tasks];
        setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 2500);
        return;
      }
      task.status = 'error'; tasks = [...tasks];
      toast(t('上传失败：{reason}', { reason: tr(e.body?.error) || file.name }));
    }
  }
  // —— 桌面拖拽上传（网盘式：拖在某个文件夹上就传进那个文件夹，拖在空白处传进当前目录）——
  // 只读分享空间不能写，不接。
  // dropOn：null=没在拖 / ''=当前目录 / '<文件夹名>'=某个文件夹（用来点亮目标）。
  let dropOn = $state(null);
  const canDrop = $derived(!readonly);
  const dtHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const joinPath = (a, b) => [a, b].filter(Boolean).join('/');

  function dragOverRoot(e) {
    if (!canDrop || !dtHasFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropOn = '';
  }
  function dragLeaveRoot(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = null; }
  // 文件夹格子自己拦下 dragover（stopPropagation），根的处理器就不会把目标又抹回当前目录。
  function dragOverFolder(e, name) {
    if (!canDrop || !dtHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropOn = name;
  }

  async function onDropUpload(e) {
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
  async function uploadTree(rootName, items, baseDir) {
    const id = 'u' + Date.now() + (uid++);
    const total = items.reduce((a, x) => a + (x.file.size || 0), 0) || 1;
    const task = { id, name: rootName, total, sent: 0, status: 'up', kind: 'dir', bps: 0, lastT: performance.now(), ctrl: new AbortController() };
    tasks = [task, ...tasks];
    try {
      await pool(items, 4, async (it) => {
        const sub = it.rel.split('/').slice(0, -1).join('/');       // rel 含顶层文件夹名
        const dir = joinPath(baseDir, sub);
        const idr = 'up' + Math.random().toString(36).slice(2, 12);
        // mk=1 让服务端按需建子目录；整文件一次发（upload-chunk 侧是流式落盘，不吃内存）。
        const url = scoped(`/api/files/upload?path=${encodeURIComponent(dir)}&id=${idr}&last=1&mk=1&name=${encodeURIComponent(it.file.name)}`);
        await api.post(url, it.file, { signal: task.ctrl.signal });
        const now = performance.now(), dt = (now - task.lastT) / 1000;
        if (dt > 0) { const inst = (it.file.size || 0) / dt; task.bps = task.bps ? task.bps * 0.6 + inst * 0.4 : inst; }
        task.lastT = now;
        task.sent = Math.min(total, task.sent + (it.file.size || 0));
        tasks = [...tasks];
      });
      task.status = 'done'; task.sent = total; tasks = [...tasks];
      await load(path);
      toast(t('已上传 {name}（{n} 个文件）', { name: rootName, n: items.length }));
      setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 4000);
    } catch (e) {
      if (task.status === 'cancelled' || e?.name === 'AbortError') {
        tasks = [...tasks];
        setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 2500);
        return;
      }
      task.status = 'error'; tasks = [...tasks];
      toast(t('上传失败：{reason}', { reason: tr(e.body?.error) || rootName }));
    }
  }

  // 取消在途上传：标记 + abort（在途分块立断，片间空隙则下一片立断）。服务端残留的隐藏
  // .part-* 由下次上传首片的 sweepStaleParts 清理，不用专门收拾。
  function cancelUpload(task) {
    if (task.status !== 'up') return;
    task.status = 'cancelled';
    try { task.ctrl.abort(); } catch {}
    tasks = [...tasks];
    toast(task.dl ? t('已取消下载 {name}', { name: task.name }) : t('已取消上传 {name}', { name: task.name }));
  }

  // —— 预览 ——
  const OFFICE_EXTS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
  // 统一构造查看器条目：走 /api（origin cloud）。
  // mt=mtime：让查看器衍生图 URL 与列表图标完全一致（命中浏览器缓存秒出 blur 底）+ 文件替换后自动 bust。
  const srcItem = (it, kind) => ({ origin: 'cloud', rel: itemRel(it), name: it.name, kind, mt: it.mtime, ws: workspaceRoot });
  async function openFile(item) {
    if (wsPick) return;                // 选择器形态只挑文件夹：文件列出来是给你认路的，不点开
    if (selecting) { toggleSel(item.name); return; }
    const k = kindOf(item.name);
    const r = itemRel(item);
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    if (k === 'img') { openImagePreview(item); return; }                                              // 图片画廊
    if (k === 'mov' || k === 'audio') { openPreview([srcItem(item, k === 'mov' ? 'video' : 'audio')], 0); return; }  // 音视频
    if (k === 'md' || k === 'text') { openDocPreview(item, k); return; }                              // md/文本 编辑
    if (k === 'html') {                                                                               // HTML → 沙箱 iframe 直接渲染
      openPreview([{ origin: 'cloud', rel: r, name: item.name, kind: 'html', ws: workspaceRoot }], 0);
      return;
    }
    if (k === 'pdf') { openPreview([srcItem(item, 'pdf')], 0); return; }                              // PDF
    if (OFFICE_EXTS.includes(ext)) { openPreview([srcItem(item, 'office')], 0); return; }             // Office
    preview = { name: item.name, rel: r, kind: 'other' };                                            // 其余（压缩包等）
  }

  // md/文本 → 沉浸式文档查看/编辑器（服务端 fetch）
  function openDocPreview(item, k) {
    const kind = k === 'md' ? 'markdown' : 'text';
    openPreview([{ origin: 'cloud', rel: itemRel(item), name: item.name, kind, ws: workspaceRoot }], 0);
  }

  // 图片 → openPreview：当前目录全部图片做画廊（服务端 URL，轻量，可左右滑/缩放）。
  function openImagePreview(item) {
    const imgs = showFiles.filter((f) => kindOf(f.name) === 'img');
    const idx = Math.max(0, imgs.findIndex((f) => f.name === item.name));
    openPreview(imgs.map((f) => srcItem(f, 'image')), idx);
  }
  // 交给浏览器直接下载（自带下载管理）。&name=：指定下载文件名（含中文）；浏览器按 Content-Disposition 落盘。
  function plainDownload(r) {
    const name = r.split('/').pop() || 'download';
    const href = apiUrl(scoped('/api/file?path=' + encodeURIComponent(r)) + '&dl=1&name=' + encodeURIComponent(name));
    const a = document.createElement('a');
    a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function download(r) {
    if (readonly) { downloadTracked(r); return; }
    plainDownload(r);
  }
  // 分享页下载：fetch 流式读进度 → 顶栏环 + 传输面板有真实状态（访客在这页的核心动作就是
  // 下载，不能毫无反馈）。数据攒成 Blob 后触发保存；大文件 Blob 内存风险大，超阈值掐掉这条
  // 流退回浏览器原生下载（自带下载管理）；流式中途失败同样退回原生兜底。
  const TRACK_MAX = 300 * 1024 * 1024;
  async function downloadTracked(r) {
    const name = r.split('/').pop() || 'download';
    const id = 'd' + Date.now() + (uid++);
    tasks = [{ id, name, total: 0, sent: 0, status: 'up', kind: kindOf(name), bps: 0, lastT: 0, ctrl: new AbortController(), dl: true }, ...tasks];
    // 【Svelte5 深代理坑】必须拿数组元素的代理来改——push 进 $state 后改裸字面量，
    // 代理 signal 不更新，UI 永远 0%（同上传 0% 卡死的老病，先例判法照抄）。
    const tk = tasks[0];
    try {
      const res = await fetch(apiUrl(scoped('/api/file?path=' + encodeURIComponent(r))), { headers: authHeaders(), credentials: 'same-origin', signal: tk.ctrl.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      tk.total = Number(res.headers.get('content-length')) || 0;
      if (tk.total > TRACK_MAX) {
        try { tk.ctrl.abort(); } catch {}
        tasks = tasks.filter((x) => x.id !== id);
        plainDownload(r);
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
      plainDownload(r);   // 流式失败退回浏览器直接下载，至少能下到
    }
  }

  // —— toast ——
  let toastTimer = null;
  function toast(m) { toastMsg = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastMsg = ''), toastWarn ? 4200 : 2200); }
  // 失败/受限类提示别再配绿勾：按文案判（几十个调用点，逐个传 kind 不值当）；进行中（…结尾）不带图标。
  const toastWarn = $derived(/失败|没能|不支持|不能|无法|太多|过大|请先|开发中/.test(toastMsg));
  const toastBusy = $derived(/…$/.test(toastMsg));

  function onScroll() { scrolled = scroller && scroller.scrollTop > 36; }

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
    md: '#8e8e93', text: '#8e8e93', doc: '#8e8e93', pdf: '#ff383c',
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
  const KIND_LABEL = { img: t('图片'), mov: t('视频'), audio: t('音频'), pdf: t('PDF 文稿'), zip: t('压缩归档'), md: t('Markdown 文稿'), text: t('文本文稿'), doc: t('文稿') };
  function typeLabel(item) {
    if (item.isDir) return t('文件夹');
    const ext = (item.name.split('.').pop() || '').toUpperCase();
    const base = KIND_LABEL[kindOf(item.name)] || t('文件');
    return item.name.includes('.') ? t('{kind}（.{ext}）', { kind: base, ext: ext.toLowerCase() }) : base;
  }
  const infoLocation = $derived(infoItem ? (rootLabel + (infoItem.dir ? ' / ' + infoItem.dir.split('/').join(' / ') : '')) : '');
  // 传输行右侧文案：真速率（EMA）+ 进度百分比；首片完成前还没有速率样本，先只给百分比。
  // 总大小未知（下载响应缺 content-length）时退化显示已传字节，别出 NaN%。
  const fmtSpeed = (tk) => (tk.bps > 0 ? fmtSize(tk.bps) + '/s · ' : '') + (tk.total > 0 ? Math.min(100, Math.round((tk.sent / tk.total) * 100)) + '%' : fmtSize(tk.sent));

  const GLYPH = {
    img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="9" cy="9.6" r="1.7"/><path d="m6 17 4.2-4.4 3 3 2.4-2.5 2.9 3.1"/>',
    mov: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="m10.3 9.5 4.4 2.5-4.4 2.5v-5Z" fill="#fff" stroke="none"/>',
    audio: '<path d="M9 17.5V6.8l9-2v10.7"/><circle cx="6.8" cy="17.5" r="2.3"/><circle cx="15.8" cy="15.5" r="2.3"/>',
    pdf: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/>',
    zip: '<rect x="4.5" y="6" width="15" height="13" rx="2.4"/><path d="M12 6v13" stroke-dasharray="2.4 2"/>',
    md: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>',
    text: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h4"/>',
    doc: '<path d="M6 3.5h8l4 4V20.5h-12V3.5Z"/><path d="M14 3.5v4h4"/>',
    dir: '<path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/>',
  };
  const fileGlyph = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH[k] || GLYPH.doc}</svg>`;

  // iOS 文件 app 原版风文件图标：白色文档纸 + 右上折角 + 底部彩色类型标签条
  const TYPE_COLOR = { pdf: '#ff3b30', img: '#32ade6', mov: '#5856d6', audio: '#ff2d55', zip: '#ff9500', md: '#8e8e93', text: '#8e8e93', doc: '#007aff' };
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
  // 走 /api/file?thumb=1（图片 sharp 320 webp / 视频 ffmpeg 抽帧，失败 404 不喂原字节）。
  const thumbable = (it) => !it.isDir && (kindOf(it.name) === 'img' || kindOf(it.name) === 'mov');
  const thumbSrc = (it) => cloudFileUrl(itemRel(it), { thumb: true, mt: it.mtime, ws: workspaceRoot });
  const thumbOk = (e) => e.currentTarget.classList.add('ok');
  // 失败 → 保持透明，底下类型图标继续兜底。
  const thumbErr = (e) => e.currentTarget.classList.remove('ok');
</script>

<div class="ws-root" class:wpick={wsPick} class:embedded={embeddedUi} class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} bind:this={rootEl} ondragover={dragOverRoot} ondragleave={dragLeaveRoot} ondrop={onDropUpload} role="presentation">
  <!-- 从桌面拖文件/文件夹进来：整块提示；拖在某个文件夹格子上时改说传进那个文件夹 -->
  {#if dropOn !== null}
    <div class="dropveil">
      <div class="dropveil-in">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
        <span>{dropOn ? t('上传到「{name}」', { name: dropOn }) : t('上传到当前文件夹')}</span>
      </div>
    </div>
  {/if}
  <!-- 顶部玻璃钮：返回 + 添加 + 传输环（分享只读=只留传输环当下载指示；根目录连返回键也不出——没有主页可回） -->
  <div class="topbtns">
    {#if !readonly || segs.length}
      <button class="gbtn" aria-label={t('返回')} onclick={back}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
    {/if}
    <div style="flex:1"></div>
    {#if wsPick}
      <!-- 选择器只留「新建文件夹」：要一个全新的空项目就在这儿建，建完拖进底栏即可 -->
      <button class="gbtn" aria-label={t('新建文件夹')} onclick={() => (mkOpen = { value: '' })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /><path d="M12 11v5M9.5 13.5h5" /></svg>
      </button>
    {:else}
      {#if !readonly}
        <button class="gbtn" aria-label={t('添加')} onclick={() => (addOpen = !addOpen)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      {/if}
      <button class="gbtn ring" class:alldone={allDone} aria-label={t('传输')} onclick={() => (transferOpen = !transferOpen)}>
        <svg class="ringsvg" viewBox="0 0 44 44">
          <circle class="track" cx="22" cy="22" r="18" />
          <circle class="prog" cx="22" cy="22" r="18" stroke-dasharray="113.1" stroke-dashoffset={113.1 * (1 - ringPct)} />
        </svg>
        <svg class="arrows" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.5 6.5V13.5M4.5 13.5L2 11M4.5 13.5L7 11" /><path d="M11.5 9.5V2.5M11.5 2.5L9 5M11.5 2.5L14 5" />
        </svg>
        {#if activeTasks.length}<span class="badge">{activeTasks.length}</span>{/if}
      </button>
    {/if}
  </div>

  {#if addOpen}
    <button class="add-scrim" aria-label={t('关闭')} onclick={() => (addOpen = false)}></button>
    <div class="addmenu">
      <button class="mi" onclick={pickUpload}><span class="micon" style="color:#0088ff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M12 4 7 9M12 4l5 5" /><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></svg></span><span class="mlb">{t('上传文件')}</span></button>
      <button class="mi" onclick={() => { addOpen = false; mkOpen = { value: '' }; }}><span class="micon" style="color:#0088ff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /><path d="M12 11v5M9.5 13.5h5" /></svg></span><span class="mlb">{t('新建文件夹')}</span></button>
    </div>
  {/if}

  <!-- 滚动内容 -->
  <div class="scroll" bind:this={scroller} onscroll={onScroll} use:dragScrollGuard use:dropZone={hereZone} class:dnd-here={drag.overKey === 'ws-here'}>
    <!-- 紧凑面包屑条（取代 34pt 大标题，省垂直空间）：父段蓝色可点、当前段黑色加粗 -->
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
        <button class="pb-seg" class:cur={!segs.length} class:dnd-on={drag.overKey === 'ws-crumb:-1'} use:dropZone={crumbZone(-1)} onclick={goRoot}>{#if readonly}<svg class="pb-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 13.7a4.2 4.2 0 0 0 6.1.3l2.4-2.4a4.2 4.2 0 0 0-5.9-5.9l-1.3 1.3" /><path d="M13.7 10.3a4.2 4.2 0 0 0-6.1-.3l-2.4 2.4a4.2 4.2 0 0 0 5.9 5.9l1.3-1.3" /></svg>{/if}{rootLabel}</button>
        {#each segs as s, i}<span class="pb-sep">›</span>{#if i < segs.length - 1}<button class="pb-seg" class:dnd-on={drag.overKey === 'ws-crumb:' + i} use:dropZone={crumbZone(i)} onclick={() => goSeg(i)}>{s}</button>{:else}<span class="pb-seg cur">{s}</span>{/if}{/each}
      {/if}
    </div>
    <!-- 管理员的位置切换（工作空间 / 主目录 / 各盘符或「/」）：与新建项目选择器同一份 /api/project/locations -->
    {#if locations && locations.length > 1 && onLocation && !wsPick && !selecting}
      <div class="locbar" role="tablist" aria-label={tc('files', '位置')}>
        {#each locations as l (l.id)}
          <button class="loc" class:on={l.id === locationId} role="tab" aria-selected={l.id === locationId} title={l.path} onclick={() => onLocation(l)}>{tr(l.name)}</button>
        {/each}
      </div>
    {/if}

    {#if wsPick && pickerLocations.length > 1}
      <!-- 位置栏：文件管理器本身锁在身份工作空间根（admin=vault），可真实项目往往在库外。
           这一条把可达范围补回整机，授权边界仍由服务端 authorizeProjectPath 判——Pro 只会
           拿到自己那一条，这行不出现。 -->
      <div class="sechead"><h2>{tc('files', '位置')}</h2></div>
      <div class="desktop-locations">
        {#each pickerLocations as loc (loc.id)}
          <button class="desktop-location" class:on={loc.id === pickerLocationId} onclick={() => onPickLocation?.(loc)}>
            <span class="dl-icon">📁</span><span>{tr(loc.name)}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if recents.length}
      <div class="sechead"><h2>{t('最近')}</h2></div>
      <div class="recents">
        {#each recents as it (it.name)}
          <button class="rcard" class:dnd-lift={liftRels.has(itemRel(it))} class:dnd-arm={armRel === itemRel(it)}
            onpointerdown={(e) => pressDown(e, it)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
            onclick={() => (isDragging() ? stackToDrag(it) : openFile(it))} oncontextmenu={(e) => onCtxMenu(e, it)}>
            <!-- 图片格子铺彩色渐变底（缩略图加载前/失败时的占位），其余类型出文件图标 -->
            <span class="thumb" class:img={kindOf(it.name) === 'img'} style={kindOf(it.name) === 'img' ? 'background:linear-gradient(135deg,#ffd29d,#ff8db1)' : ''}>
              {#if kindOf(it.name) !== 'img'}<span class="ic">{@html fileIcon(it.name)}</span>{/if}
              {#if thumbable(it)}
                <img class="rthumb" src={thumbSrc(it)} alt="" loading="lazy" decoding="async" draggable="false"
                  onload={thumbOk} onerror={thumbErr} />
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
      <div class="sechead"><h2>{tc('files', '文件夹')}</h2></div>
      <div class="foldergrid">
        {#each showFolders as f (f.rel || f.name)}
          <button class="folder" class:sel={selected.has(f.name)} class:dropin={dropOn === f.name || drag.overKey === 'ws-dir:' + itemRel(f)}
            class:wp-lift={wsPick && pkDrag?.abs === pkAbs(itemRel(f))} class:dnd-lift={liftRels.has(itemRel(f))} class:dnd-arm={armRel === itemRel(f)}
            class:dnd-spring={drag.springKey === 'ws-dir:' + itemRel(f)}
            use:dropZone={folderZone(f)}
            ondragover={(e) => dragOverFolder(e, f.name)} ondrop={onDropUpload}
            onpointerdown={(e) => pressDown(e, f)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
            onclick={() => enterDir(f)} oncontextmenu={(e) => onCtxMenu(e, f)}>
            {#if selecting}<span class="selc" class:on={selected.has(f.name)}>{#if selected.has(f.name)}<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7" /></svg>{/if}</span>{/if}
            <img class="ficon" src="{BASE}assets/icons/workspace.png" alt="" draggable="false" />
            <span class="nm">{f.name}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if showFiles.length}
      <div class="sechead"><h2>{tc('files', '文件')}</h2></div>
      <div class="filecard">
        {#each showFiles as f (f.rel || f.name)}
          <div class="frow" class:sel={selected.has(f.name)} class:wp-flat={wsPick} class:dnd-lift={liftRels.has(itemRel(f))} class:dnd-arm={armRel === itemRel(f)} role="button" tabindex="0"
            onpointerdown={(e) => pressDown(e, f)} onpointermove={pressMove} onpointerup={pressUp} onpointercancel={pressUp}
            onclick={() => (isDragging() ? stackToDrag(f) : openFile(f))} oncontextmenu={(e) => onCtxMenu(e, f)}>
            {#if selecting}<span class="selc" class:on={selected.has(f.name)}>{#if selected.has(f.name)}<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7" /></svg>{/if}</span>{/if}
            <span class="ficon-sm">
              {@html fileIcon(f.name)}
              {#if thumbable(f)}
                <img class="fthumb" src={thumbSrc(f)} alt="" loading="lazy" decoding="async" draggable="false"
                  onload={thumbOk} onerror={thumbErr} />
                {#if kindOf(f.name) === 'mov'}<span class="fplay"><svg viewBox="0 0 24 24"><path d="M8.4 5.8v12.4L19 12z" /></svg></span>{/if}
              {/if}
            </span>
            <span class="meta"><span class="nm">{f.name}</span><span class="fsub">{f.parent ? `${f.parent} · ` : ''}{fmtTime(f.mtime)} · {fmtSize(f.size)}{f.linkType ? ` · ${f.linkType === 'external-link' ? t('外部链接（只读）') : t('链接')}` : ''}</span></span>
            {#if !wsPick}
              <button class="dots" aria-label={t('更多')} onclick={(e) => { e.stopPropagation(); openMenu(e, f); }}>
                <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if isEmpty}
      <div class="empty"><div class="big">{query ? '🔍' : '📂'}</div>{query ? t('未找到相关文件') : t('这个文件夹是空的')}</div>
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
      <img class="wpg-ic" src="{BASE}assets/icons/workspace.png" alt="" draggable="false" />
      <span class="wpg-nm">{pkDrag.name || t('工作空间')}</span>
    </div>
  {/if}

  <!-- 底部玻璃枕（分享只读整个不出：搜索/多选栏都是工作空间的事） -->
  {#if !readonly && !wsPick}
  <div class="bottomwrap" class:searching class:selecting>
    <div class="bottombar">
      <button class="searchbtn glass" aria-label={t('搜索')} onclick={openSearch}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m20 20-4.4-4.4" /></svg>
      </button>
    </div>

    <div class="searchrow">
      <button class="closebtn" class:glass={!fg} class:fg aria-label={t('关闭搜索')} onclick={closeSearch}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2.5 2.5l11 11M13.5 2.5l-11 11" /></svg>
      </button>
      <div class="searchfield" class:glass={!fg} class:fg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m20 20-4.4-4.4" /></svg>
        <input bind:this={searchEl} bind:value={query} placeholder={t('搜索文件')} autocomplete="off" />
      </div>
    </div>

    <div class="selbar glass">
      <button class="selact" onclick={() => toast(t('分享开发中'))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M12 3 8 7M12 3l4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg><span>{t('分享')}</span></button>
      <button class="selact" disabled={!selected.size} onclick={() => openMovePicker([...selected], 'move')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /></svg><span>{t('移动到')}</span></button>
      <button class="selact danger" disabled={!selected.size} onclick={multiDelete}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 11.3A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.7L17.5 7" /></svg><span>{t('删除')}</span></button>
      <button class="selact done" onclick={exitSelect}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7" /></svg><span>{t('完成')}</span></button>
    </div>
  </div>
  {/if}

  <!-- 长按菜单 -->
  {#if menu}
    <button class="menu-back" aria-label={t('关闭')} onclick={() => { if (menuArmed) menu = null; }} oncontextmenu={(e) => { e.preventDefault(); if (menuArmed) menu = null; }}></button>
    <div class="ctxmenu" style="left:{menu.x}px; top:{menu.y}px; --ox:{menu.ox}%; --oy:{menu.oy}%">
      {#if !readonly && !guest}
        {#if agentOn('claude')}
          <button class="mi ai" onclick={() => menuAct('ai')}><span class="micon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.6L18 8l-4.4 1.4L12 14l-1.6-4.6L6 8l4.4-1.4L12 2Z" /><path d="M18 13l.9 2.5L21.5 16l-2.6.8L18 19.5l-.9-2.7L14.5 16l2.6-.5L18 13Z" /></svg></span><span class="mlb">{t('发送给 AI')}</span></button>
          <div class="msep"></div>
        {/if}
        <button class="mi" onclick={() => menuAct('sharelink')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 13.7a4.2 4.2 0 0 0 6.1.3l2.4-2.4a4.2 4.2 0 0 0-5.9-5.9l-1.3 1.3" /><path d="M13.7 10.3a4.2 4.2 0 0 0-6.1-.3l-2.4 2.4a4.2 4.2 0 0 0 5.9 5.9l1.3-1.3" /></svg></span><span class="mlb">{tc('files', '分享链接')}</span></button>
      {/if}
      {#if !menu.item.isDir}
        <button class="mi" onclick={() => menuAct('download')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5" /><path d="M5 20h14" /></svg></span><span class="mlb">{t('下载到本地')}</span></button>
      {/if}
      {#if !menu.item.isDir && kindOf(menu.item.name) === 'zip' && !readonly}
        <button class="mi" onclick={() => menuAct('extract')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V7" /><path d="M12 11v5M12 16l-2.2-2.2M12 16l2.2-2.2" /></svg></span><span class="mlb">{t('解压')}</span></button>
      {/if}
      {#if !readonly}
        <button class="mi" onclick={() => menuAct('move')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" /></svg></span><span class="mlb">{t('移动到')}</span></button>
        <button class="mi" onclick={() => menuAct('copy')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></svg></span><span class="mlb">{tc('files', '复制')}</span></button>
        <button class="mi" onclick={() => menuAct('rename')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4Z" /><path d="M13.5 6.5l4 4" /></svg></span><span class="mlb">{tc('files', '重命名')}</span></button>
      {/if}
      <button class="mi" onclick={() => menuAct('info')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6h.01" /></svg></span><span class="mlb">{t('显示简介')}</span></button>
      {#if !readonly}
        <button class="mi" onclick={() => menuAct('select')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12.5 11 15.5 16.5 9.5" /></svg></span><span class="mlb">{t('多选')}</span></button>
        <div class="msep"></div>
        <button class="mi destructive" onclick={() => menuAct('delete')}><span class="micon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 11.3A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.7L17.5 7" /></svg></span><span class="mlb">{t('删除')}</span></button>
      {/if}
    </div>
  {/if}

  <!-- 传输面板 -->
  {#if transferOpen}
    <button class="tp-scrim" aria-label={t('关闭')} onclick={() => (transferOpen = false)}></button>
    <div class="transferpanel glass-strong">
      <div class="tp-head"><h3>{t('传输')}</h3>{#if tasks.length}<button onclick={() => (tasks = tasks.filter((x) => x.status === 'up'))}>{t('清除已完成')}</button>{/if}</div>
      {#if !tasks.length}
        <div class="tp-empty">{t('暂无传输任务')}</div>
      {:else}
        {#each tasks as task (task.id)}
          <div class="task">
            <span class="ticon" style="background:{task.status === 'error' ? '#ff383c' : task.status === 'done' ? '#34c759' : task.status === 'cancelled' ? '#aeaeb2' : iconColor(task.name)}">{@html fileGlyph(task.kind)}</span>
            <span class="tmeta">
              <span class="r1"><span class="nm">{task.name}</span><span class="spd">{task.status === 'done' ? t('完成') : task.status === 'error' ? t('失败') : task.status === 'cancelled' ? t('已取消') : fmtSpeed(task)}</span></span>
              <span class="track"><span class="fillb" class:up={task.status !== 'error' && task.status !== 'cancelled'} class:off={task.status === 'cancelled'} style="width:{task.total > 0 ? Math.round((task.sent / task.total) * 100) : 0}%"></span></span>
            </span>
            {#if task.status === 'up'}
              <button class="tp-x" aria-label={t('取消上传')} onclick={() => cancelUpload(task)}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  <!-- 文件预览 -->
  {#if preview}
    <div class="pv-mask" onclick={() => (preview = null)} role="presentation">
      <div class="pv-card glass-strong" onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="pv-head"><span class="pv-name">{preview.name}</span>
          <button class="pv-dl" onclick={() => download(preview.rel)} aria-label={t('下载')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5" /><path d="M5 20h14" /></svg></button>
          <button class="pv-x" onclick={() => (preview = null)} aria-label={t('关闭')}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 2.5l11 11M13.5 2.5l-11 11" /></svg></button>
        </div>
        <div class="pv-body">
          {#if preview.loading}<div class="pv-loading">{t('加载中…')}</div>
          {:else if preview.kind === 'img'}<img src={preview.url} alt={preview.name} />
          {:else if preview.kind === 'text'}<pre>{preview.text}</pre>
          {:else}<div class="pv-other"><div class="big">{@html fileIcon(preview.name)}</div><p>{t('该类型暂不支持内嵌预览')}</p>{#if kindOf(preview.name) === 'zip' && !readonly}<button class="pv-dlbtn" disabled={extracting} onclick={() => { const n = preview.name; preview = null; doExtract({ name: n }); }}>{extracting ? t('解压中…') : t('解压到当前文件夹')}</button>{/if}<button class="pv-dlbtn" onclick={() => download(preview.rel)}>{t('下载文件')}</button></div>{/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- 重命名 sheet -->
  {#if renameTarget}
    <div class="dlg-mask" onclick={() => (renameTarget = null)} role="presentation">
      <div class="dlg" onclick={(e) => e.stopPropagation()} role="presentation">
        <h3>{t('重命名')}</h3>
        <input bind:value={renameTarget.value} onkeydown={(e) => e.key === 'Enter' && doRename()} />
        <div class="dlg-btns"><button class="cancel" onclick={() => (renameTarget = null)}>{t('取消')}</button><button class="go" onclick={doRename}>{t('确定')}</button></div>
      </div>
    </div>
  {/if}

  <!-- 分享链接：设置（密码开关 + 过期时间）→ 结果（链接 + 复制） -->
  {#if shareDlg}
    <div class="dlg-mask" onclick={() => { if (!shareDlg.busy) shareDlg = null; }} role="presentation">
      <div class="dlg sharedlg" onclick={(e) => e.stopPropagation()} role="presentation">
        {#if !shareDlg.result}
          <h3>{t('分享链接')}</h3>
          <p class="sh-file">{shareDlg.item.isDir ? '📁 ' : ''}{shareDlg.item.name}</p>
          <div class="sh-row">
            <span class="sh-lb">{t('启用分享密码')}</span>
            <button class="sw" class:on={shareDlg.pwOn} role="switch" aria-checked={shareDlg.pwOn} aria-label={t('启用分享密码')} onclick={() => (shareDlg.pwOn = !shareDlg.pwOn)}><span class="knob"></span></button>
          </div>
          {#if shareDlg.pwOn}
            <input class="sh-pw" bind:value={shareDlg.password} placeholder={t('设置分享密码')} maxlength="64" onkeydown={(e) => e.key === 'Enter' && doShareLink()} />
          {/if}
          <div class="sh-row col">
            <span class="sh-lb">{t('过期时间')}</span>
            <div class="sh-ttl">
              {#each SHARE_TTLS as ttl (ttl.h)}
                <button class:on={shareDlg.ttl === ttl.h} onclick={() => (shareDlg.ttl = ttl.h)}>{tr(ttl.lb)}</button>
              {/each}
            </div>
          </div>
          <div class="dlg-btns">
            <button class="cancel" onclick={() => (shareDlg = null)}>{t('取消')}</button>
            <button class="go" disabled={shareDlg.busy} onclick={doShareLink}>{shareDlg.busy ? t('创建中…') : t('创建链接')}</button>
          </div>
        {:else}
          <h3>{t('链接已创建')}</h3>
          <p class="sh-file">{shareDlg.item.isDir ? '📁 ' : ''}{shareDlg.item.name}</p>
          <button class="sh-url" onclick={copyShare}>{shareDlg.result.url}</button>
          <p class="sh-meta">
            {t('{time} 过期', { time: fmtExpire(shareDlg.result.expiresAt) })}
            {#if shareDlg.result.pw}<br />{t('访问密码')} <b>{shareDlg.result.pw}</b>{t('（复制时一并带上）')}{/if}
          </p>
          <div class="dlg-btns">
            <button class="cancel" onclick={() => (shareDlg = null)}>{t('完成')}</button>
            <button class="go" onclick={copyShare}>{t('复制链接')}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- 新建文件夹 sheet -->
  {#if mkOpen}
    <div class="dlg-mask" onclick={() => (mkOpen = null)} role="presentation">
      <div class="dlg" onclick={(e) => e.stopPropagation()} role="presentation">
        <h3>{t('新建文件夹')}</h3>
        <input bind:value={mkOpen.value} placeholder={t('文件夹名称')} onkeydown={(e) => e.key === 'Enter' && doMkdir()} />
        <div class="dlg-btns"><button class="cancel" onclick={() => (mkOpen = null)}>{t('取消')}</button><button class="go" onclick={doMkdir}>{t('创建')}</button></div>
      </div>
    </div>
  {/if}

  <!-- 「发送给 AI」：选一个 Claude 对话（或新对话）挂进输入栏（底部动作单） -->
  {#if aiPick && aiChat}
    <div class="ai-mask" onclick={closeAi} role="presentation">
      <div class="ai-sheet" onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="ai-title">{t('发送「{name}」到 {agent} · 选择对话', { name: aiPick.name, agent: AI_NAMES.claude })}</div>
        <div class="ai-chat-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" placeholder={t('搜索对话')} bind:value={aiChat.q} />
        </div>
        <button class="ai-opt" onclick={() => pickChat('new')}>
          <span class="ai-ic" style="background:#34c759"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg></span>
          <span class="ai-lb">{t('新对话')}<small>{t('开一个新对话，附件挂进输入栏')}</small></span>
        </button>
        <div class="ai-chat-list">
          {#each aiChatFiltered as s (s.id)}
            <button class="ai-chat-row" onclick={() => pickChat(s.id)}>
              <span class="ai-chat-dot {s.thinking ? 'work' : s.pending ? 'ask' : ''}"></span>
              <span class="ai-chat-title">{chatTitle(s)}</span>
              {#if s.id === session.id}<span class="ai-chat-cur">{t('当前')}</span>{/if}
              {#if s.mtime}<span class="ai-chat-time">{relTime(s.mtime)}</span>{/if}
            </button>
          {:else}
            <div class="ai-chat-empty">{aiChat.loading ? t('加载中…') : aiChat.q ? t('没有匹配的对话') : t('还没有历史对话')}</div>
          {/each}
        </div>
        <button class="ai-cancel" onclick={closeAi}>{t('取消')}</button>
      </div>
    </div>
  {/if}

  <!-- 移动到 / 复制到 目录选择器 -->
  {#if picker}
    <div class="pk-mask" onclick={() => (picker = null)} role="presentation">
      <div class="pk glass-strong" onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="pk-head">
          <button class="pk-cancel" onclick={() => (picker = null)}>{t('取消')}</button>
          <span class="pk-title">{picker.mode === 'move' ? t('移动 {n} 项到…', { n: picker.names.length }) : t('复制 {n} 项到…', { n: picker.names.length })}</span>
          <span style="width:40px"></span>
        </div>
        <div class="pk-crumb">
          <button class:cur={!picker.path} onclick={() => pickerLoad('')}>{t('工作空间')}</button>
          {#each picker.path.split('/').filter(Boolean) as s, i}<span class="pb-sep">›</span><button class:cur={i === picker.path.split('/').filter(Boolean).length - 1} onclick={() => pickerCrumb(i)}>{s}</button>{/each}
        </div>
        <div class="pk-list">
          {#if picker.loading}<div class="pk-empty">{t('加载中…')}</div>
          {:else if !picker.items.length}<div class="pk-empty">{t('这里没有子文件夹')}<br /><small>{t('可直接放到当前位置')}</small></div>
          {:else}
            {#each picker.items as f (f.name)}
              <button class="pk-row" onclick={() => pickerEnter(f.name)}>
                <img class="pk-fico" src="{BASE}assets/icons/workspace.png" alt="" />
                <span class="pk-nm">{f.label || f.name}</span>
                <svg class="pk-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </button>
            {/each}
          {/if}
        </div>
        <button class="pk-confirm" onclick={pickerConfirm}>{picker.mode === 'move' ? t('移动到「{name}」', { name: pickerDestName }) : t('复制到「{name}」', { name: pickerDestName })}</button>
      </div>
    </div>
  {/if}

  <!-- 显示简介：文件详细信息 -->
  {#if infoItem}
    <div class="dlg-mask" onclick={() => (infoItem = null)} role="presentation">
      <div class="info-card" onclick={(e) => e.stopPropagation()} role="presentation">
        <div class="info-top">
          {#if infoItem.isDir}<img class="info-ico" src="{BASE}assets/icons/workspace.png" alt="" />{:else}<span class="info-ico file">{@html fileIcon(infoItem.name)}</span>{/if}
          <div class="info-name">{infoItem.name}</div>
        </div>
        <div class="info-rows">
          <div class="ir"><span>{t('种类')}</span><b>{typeLabel(infoItem)}</b></div>
          <div class="ir"><span>{t('大小')}</span><b>{infoItem.isDir ? t('文件夹') : fmtSize(infoItem.size)}</b></div>
          <div class="ir"><span>{t('修改时间')}</span><b>{fmtFull(infoItem.mtime)}</b></div>
          <div class="ir"><span>{t('位置')}</span><b class="loc">{infoLocation}</b></div>
        </div>
        <button class="info-done" onclick={() => (infoItem = null)}>{t('完成')}</button>
      </div>
    </div>
  {/if}

  {#if toastMsg}<div class="toast" class:warn={toastWarn}>{#if toastWarn}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.2M12 16.3h.01" /></svg>{:else if !toastBusy}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 7.5" /></svg>{/if}<span>{toastMsg}</span></div>{/if}

  <input bind:this={fileInput} type="file" multiple onchange={onPick} style="display:none" />
</div>

<style>
  /* iOS 27 token（实测官方 UI Kit）。独立页固定浅色 grouped；内嵌进工作台（.embedded）
     时跟随全站明暗（见下方暗色块）。所有颜色只走这些令牌，别再就地写死。 */
  .ws-root {
    --blue: #0088ff; --red: #ff383c; --green: #34c759; --blue-soft: rgba(0,136,255,.1);
    --label: #000; --label2: rgba(60,60,67,.6); --label3: rgba(60,60,67,.3); --ink: #1a1a1a; --sub: #8a8a8e;
    --fill: rgba(120,120,128,.16); --fill3: rgba(116,116,128,.08); --field: rgba(118,118,128,.12); --soft: #f0f0f2; --soft2: #e6e6ea;
    --bg: #f2f2f7; --card: #fff; --sep: rgba(60,60,67,.12); --press: #ededed; --hair: #e6e6e6;
    --glass: rgba(248,248,248,.55); --glass-strong: rgba(247,247,247,.82); --menu: rgba(247,247,247,.86); --toast: rgba(247,247,247,.88);
    --ring: rgba(190,190,190,.5); --hi: rgba(255,255,255,.95); --hi2: rgba(255,255,255,.6); --edge: rgba(105,105,105,.22);
    --sheet: rgba(250,250,250,.96); --paper: #fff; --dot: #d5d5da; --chev: #c4c4c8; --ph: #b0b0b4;
    position: fixed; inset: 0; z-index: 40; background: var(--bg);
    font-family: -apple-system, 'SF Pro Text', BlinkMacSystemFont, 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', sans-serif;
    color: var(--label); -webkit-font-smoothing: antialiased; user-select: none; -webkit-touch-callout: none; overflow: hidden;
  }
  .ws-root :global(svg) { display: block; }
  /* 内嵌进工作台且全站为暗色：iOS 暗色 grouped，底色对齐 Claude 的 #1f1f1e（data-theme 缺省即暗）。 */
  :global(html:not([data-theme='light'])) .ws-root.embedded:not(.th-light), .ws-root.embedded.th-dark {
    --blue: #4f9dff; --red: #ff6961; --green: #30d158; --blue-soft: rgba(79,157,255,.18);
    --label: #f2f2f0; --label2: rgba(235,235,245,.6); --label3: rgba(235,235,245,.3); --ink: #f2f2f0; --sub: #98989d;
    --fill: rgba(120,120,128,.36); --fill3: rgba(118,118,128,.2); --field: rgba(118,118,128,.24); --soft: rgba(118,118,128,.2); --soft2: rgba(118,118,128,.3);
    --bg: #1f1f1e; --card: #2a2a29; --sep: rgba(255,255,255,.1); --press: #3a3a3c; --hair: rgba(255,255,255,.1);
    --glass: rgba(44,44,42,.62); --glass-strong: rgba(40,40,38,.88); --menu: rgba(44,44,42,.9); --toast: rgba(44,44,42,.9);
    --ring: rgba(255,255,255,.12); --hi: rgba(255,255,255,.12); --hi2: rgba(255,255,255,.06); --edge: rgba(0,0,0,.35);
    --sheet: rgba(40,40,38,.97); --paper: #2a2a29; --dot: #48484a; --chev: #636366; --ph: #6e6e73;
    color-scheme: dark;
  }

  /* 拖拽上传：整块虚线提示（pointer-events:none 让 dragover/drop 穿透到下面的文件夹格子，
     否则遮罩一盖住，「拖到某个文件夹上」就永远命中不了）+ 目标文件夹格子高亮 */
  .dropveil { position: absolute; inset: 8px; z-index: 60; pointer-events: none;
    display: flex; align-items: center; justify-content: center;
    border: 2px dashed var(--blue); border-radius: 18px; background: var(--blue-soft); }
  /* 文字压在文件夹格子上会糊成一片——收进一枚实底药丸，落在任何内容上都读得清 */
  .dropveil-in { display: flex; align-items: center; gap: 9px; padding: 11px 18px; border-radius: 999px;
    background: var(--paper); box-shadow: 0 6px 24px rgba(0,0,0,.16); color: var(--blue); font-size: 14px; font-weight: 500;
    max-width: 82%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .dropveil-in svg { width: 20px; height: 20px; flex: none; }
  .folder.dropin { background: var(--blue-soft); box-shadow: inset 0 0 0 2px var(--blue); border-radius: 14px; }

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

  /* 玻璃配方（kit Materials Small UI） */
  .glass { background: var(--glass); backdrop-filter: blur(5px) saturate(1.9); -webkit-backdrop-filter: blur(5px) saturate(1.9);
    box-shadow: 0 0 0 .5px var(--ring), 0 10px 22px rgba(0,0,0,.1), 0 2px 5px rgba(0,0,0,.05),
      inset 0 1.4px 1px -.6px var(--hi), inset 0 -1.2px 1px -.6px var(--hi2),
      inset 1.6px 0 1.6px -1.2px var(--edge), inset -1.6px 0 1.6px -1.2px var(--edge); }
  .glass-strong { background: var(--glass-strong); backdrop-filter: blur(30px) saturate(1.9); -webkit-backdrop-filter: blur(30px) saturate(1.9);
    box-shadow: 0 0 0 .5px var(--ring), 0 18px 46px rgba(0,0,0,.25), inset 0 1.4px 1px -.6px var(--hi); }

  /* 顶部玻璃钮 */
  .topbtns { position: absolute; top: calc(var(--sat,0px) + 10px); left: 14px; right: 14px; z-index: 44; display: flex; align-items: center; gap: 12px; pointer-events: none; }
  .gbtn { pointer-events: auto; position: relative; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--label);
    background: var(--glass); backdrop-filter: blur(4px) saturate(1.9); -webkit-backdrop-filter: blur(4px) saturate(1.9);
    box-shadow: 0 0 0 .5px var(--ring), 0 8px 15px rgba(0,0,0,.05), inset 0 1.2px 1px -.5px var(--hi), inset 0 -1px 1px -.5px var(--hi2);
    transition: transform .18s cubic-bezier(.32,.72,0,1); }
  .gbtn:active { transform: scale(.92); }
  .gbtn svg { width: 21px; height: 21px; }
  .gbtn.ring .ringsvg { position: absolute; inset: 0; width: 44px; height: 44px; transform: rotate(-90deg); }
  .gbtn.ring .track { fill: none; stroke: rgba(120,120,128,.22); stroke-width: 2.6; }
  .gbtn.ring .prog { fill: none; stroke: var(--blue); stroke-width: 2.6; stroke-linecap: round; transition: stroke-dashoffset .5s linear; }
  .gbtn.ring.alldone .prog { stroke: var(--green); }
  .gbtn.ring .arrows { width: 16px; height: 16px; }
  .gbtn.ring .badge { position: absolute; top: -2px; right: -2px; min-width: 17px; height: 17px; border-radius: 9px; background: var(--blue); color: #fff; font-size: 11px; font-weight: 600; line-height: 17px; text-align: center; padding: 0 4px; box-shadow: 0 0 0 2px var(--bg); }

  /* 添加菜单 */
  .add-scrim { position: fixed; inset: 0; z-index: 45; }
  .addmenu { position: absolute; top: calc(var(--sat,0px) + 58px); right: 14px; z-index: 46; width: 200px; border-radius: 18px; padding: 6px;
    background: var(--menu); backdrop-filter: blur(30px) saturate(1.9); -webkit-backdrop-filter: blur(30px) saturate(1.9);
    box-shadow: 0 0 0 .5px var(--ring), 0 14px 40px rgba(0,0,0,.22); animation: pop .2s cubic-bezier(.32,1.2,.4,1); transform-origin: top right; }
  @keyframes pop { from { opacity: 0; transform: scale(.85); } to { opacity: 1; transform: none; } }

  /* 滚动内容 */
  /* container-type 挂在滚动区（容器查询只作用于【后代】，不能查自己）：
     本页既跑整页也内嵌在工作台侧栏里，格子分列必须看【容器】宽而不是视口宽——
     否则侧栏 300px 时会按 1280px 视口铺成 5 列。inline-size 只建立宽度轴容器，不影响滚动。 */
  .scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; padding: calc(var(--sat,0px) + 66px) 0 calc(var(--sab,0px) + 100px); scrollbar-width: none; touch-action: pan-y;
    container-type: inline-size; }
  .scroll::-webkit-scrollbar { display: none; }
  /* 选择器底栏比玻璃枕高：内容区留够，别让最后一行文件夹钻到栏底下（拖不着） */
  .ws-root.wpick .scroll { padding-bottom: calc(var(--sab,0px) + 128px); }
  /* 紧凑面包屑条（取代大标题） */
  .pathbar { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding: 0 18px 8px; min-height: 26px; }
  .locbar { display: flex; gap: 6px; overflow-x: auto; padding: 0 18px 10px; scrollbar-width: none; }
  .locbar::-webkit-scrollbar { display: none; }
  .loc { flex: none; padding: 5px 12px; border: 0; border-radius: 999px; font-size: 13px; font-weight: 500; color: var(--label); background: var(--fill, rgba(120,120,128,.14)); cursor: pointer; }
  .loc.on { background: var(--blue); color: #fff; }
  .pb-seg { background: none; border: none; padding: 0; font-size: 17px; font-weight: 600; letter-spacing: -.02em; color: var(--blue); }
  .pb-seg.cur { color: var(--label); }

  /* —— picker（新建项目选择器）形态 —— */
  /* 路径条＝「当前这个文件夹」本身的拖源：给它一块可按的底 + 左侧抓握点，让「这条也能拖」
     一眼看得出来。touch-action:none 是必须的——起拖后要靠 preventDefault 拦滚动，
     而 pan-y 的容器会先把这根手指判给滚动。 */
  .pathbar.wp-path { margin: 0 12px 8px; padding: 8px 12px; border-radius: 13px; background: var(--card);
    box-shadow: 0 1px 2px rgba(0,0,0,.05); touch-action: none; cursor: grab; }
  .pathbar.wp-path:active { cursor: grabbing; }
  .wp-grip { width: 16px; height: 16px; color: var(--label3); flex: none; }
  .wp-grip svg { width: 100%; height: 100%; }
  /* 正在被拖走的那一份：原位淡下去，注意力跟着幽灵走 */
  .wp-lift { opacity: .34; }
  /* 选择器里的文件只是「认路用」的参照物，不可点开——去掉一切可交互暗示 */
  .wp-flat { opacity: .55; cursor: default; }
  .wp-flat:active { background: none; }
  /* 文件夹格子保持 pan-y（继承 .scroll）：列表要能按着格子滑。起拖后的拦滚动交给常驻的
     window touchmove（passive:false）——长按 420ms 期间手指没越过滑动阈值，浏览器还没开滚，
     起拖后的第一个越阈 touchmove 被 preventDefault 就不会开滚。 */

  .wpdock { position: absolute; left: 0; right: 0; bottom: 0; z-index: 34;
    padding: 12px 14px calc(var(--sab,0px) + 14px);
    background: linear-gradient(to top, var(--bg) 62%, transparent); }
  .wpdock-in { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    min-height: 74px; border-radius: 18px; border: 2px dashed rgba(0,136,255,.42); background: var(--blue-soft);
    color: var(--blue); transition: background .16s ease, border-color .16s ease, transform .16s cubic-bezier(.22,1,.36,1); }
  .wpdock.armed .wpdock-in { border-color: rgba(0,136,255,.75); background: var(--blue-soft); }
  /* 命中：实心蓝、微微放大——「松手就是它」这件事必须在指尖底下无歧义 */
  .wpdock.over .wpdock-in { border-style: solid; border-color: var(--blue); background: var(--blue); color: #fff; transform: scale(1.02); }
  .wpd-ic { width: 24px; height: 24px; }
  .wpd-ic svg { width: 100%; height: 100%; }
  .wpd-lb { font-size: 15px; font-weight: 640; letter-spacing: -.01em; }
  .wpd-sub { font-size: 12px; opacity: .62; }

  .wpghost { position: absolute; z-index: 70; pointer-events: none; transform: translate(-50%, -50%) scale(1.04);
    display: flex; align-items: center; gap: 8px; max-width: 62%;
    padding: 8px 14px 8px 10px; border-radius: 15px; background: var(--card);
    box-shadow: 0 12px 30px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.10); }
  .wpghost.over { background: var(--blue); color: #fff; }
  .wpg-ic { width: 26px; height: 26px; object-fit: contain; flex: none; }
  .wpg-nm { font-size: 14px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pb-share { width: 14px; height: 14px; margin-right: 5px; vertical-align: -1.5px; }
  .pb-sep { color: var(--label3); font-size: 15px; }
  .sel-count { font-size: 17px; font-weight: 600; letter-spacing: -.02em; color: var(--label); }

  .sechead { padding: 22px 16px 8px; }
  .sechead h2 { font-size: 20px; line-height: 25px; font-weight: 600; letter-spacing: -.01em; }
  .desktop-locations { display:flex; gap:8px; overflow-x:auto; padding:0 16px 4px; scrollbar-width:none; }
  .desktop-locations::-webkit-scrollbar { display:none; }
  .desktop-location { flex:0 0 auto; min-height:38px; max-width:220px; display:flex; align-items:center; gap:7px; border:1px solid rgba(0,122,255,.16); border-radius:12px; padding:7px 10px; background:var(--card); color:var(--label); font:600 13px/1.2 inherit; box-shadow:0 1px 2px rgba(0,0,0,.04); cursor:pointer; }
  .desktop-location.on { color:var(--blue); border-color:rgba(0,122,255,.42); background:var(--blue-soft); }
  .dl-icon { font-size:16px; }

  /* 最近：图标与文字都左对齐（同左缘），卡片收窄、间距收紧 */
  .recents { display: flex; gap: 12px; overflow-x: auto; padding: 4px 16px 8px; scrollbar-width: none; }
  .recents::-webkit-scrollbar { display: none; }
  .rcard { flex: 0 0 78px; min-width: 0; background: none; border: none; padding: 0; text-align: left; cursor: pointer; }
  .rcard .thumb { position: relative; width: 78px; height: 66px; border-radius: 14px; overflow: hidden; display: flex; align-items: center; justify-content: flex-start; }
  .rcard .thumb.img { box-shadow: 0 0 0 .5px rgba(60,60,67,.12), 0 2px 8px rgba(0,0,0,.06); background-size: cover; background-position: center; }
  .rcard .thumb .ic { display: flex; }
  .rcard .thumb .ic :global(svg) { width: 54px; height: 64px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.14)); }
  /* 最近卡片缩略图：叠在渐变底/类型图标上层，加载完成才淡入（加载前它们就是占位缓冲）。
     .ok 由 onload 运行时挂上，必须 :global 否则被 Svelte 当未使用选择器剪掉。 */
  .rthumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s ease; }
  .rthumb:global(.ok) { opacity: 1; }
  .rcard .nm { display: block; max-width: 78px; margin-top: 6px; font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rcard .mt { display: block; font-size: 11px; line-height: 13px; color: var(--label2); }

  /* 文件夹格子按【容器】宽度分列（容器＝上面的 .scroll）：侧栏 300px 仍是 3 列，
     整页跑在折叠屏展开态才铺到 4–5 列。 */
  .foldergrid { display: grid; grid-template-columns: repeat(3, 1fr); row-gap: 18px; padding: 6px 12px 0; }
  @container (min-width: 620px) { .foldergrid { grid-template-columns: repeat(4, 1fr); } }
  @container (min-width: 900px) { .foldergrid { grid-template-columns: repeat(5, 1fr); } }
  .folder { position: relative; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px 6px; border-radius: 18px; background: none; border: none; cursor: pointer;
    transition: transform .22s cubic-bezier(.32,.72,0,1), background .2s; }
  .folder:active { transform: scale(.94); }
  .folder.sel { background: var(--blue-soft); }
  .folder .ficon { width: 84px; height: 74px; flex: none; object-fit: contain; filter: drop-shadow(0 4px 7px rgba(40,120,200,.26)); }
  .folder .nm { width: 100%; font-size: 13px; line-height: 18px; font-weight: 500; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* 多选圈：未选中灰空心、选中蓝底白勾（两态由 .on 切换） */
  .selc { display: flex; align-items: center; justify-content: center; border: 1.8px solid var(--label3); background: transparent; transition: background .15s, border-color .15s; }
  .selc.on { background: var(--blue); border-color: var(--blue); }
  .selc :global(svg) { width: 13px; height: 13px; }
  .folder .selc { position: absolute; top: 6px; left: 14px; width: 22px; height: 22px; border-radius: 50%; box-shadow: 0 0 0 2px var(--paper); }
  .folder .selc:not(.on) { background: var(--paper); }

  .filecard { margin: 6px 16px 0; background: var(--card); border-radius: 26px; overflow: hidden; box-shadow: 0 0 0 .5px rgba(60,60,67,.06); }
  .frow { position: relative; display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 0 6px 0 12px; cursor: pointer; transition: background .15s; }
  .frow:active { background: var(--fill3); }
  .frow.sel { background: var(--blue-soft); }
  .frow + .frow::before { content: ''; position: absolute; top: 0; left: 60px; right: 0; height: .5px; background: var(--sep); }
  .frow .selc { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 50%; }
  .ficon-sm { position: relative; flex: 0 0 34px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; }
  .ficon-sm :global(svg) { width: 28px; height: 35px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.06)); }
  /* 文件行缩略图：盖在类型图标上层，加载完成才淡入；失败保持透明露出图标 */
  .fthumb { position: absolute; inset: 0; width: 34px; height: 34px; object-fit: cover; border-radius: 7px;
    box-shadow: 0 0 0 .5px var(--sep); background: var(--paper); opacity: 0; transition: opacity .25s ease; }
  .fthumb:global(.ok) { opacity: 1; }
  /* 视频播放角标：跟随各自缩略图淡入（缩略没出来时不遮类型图标） */
  .fplay, .rplay { position: absolute; inset: 0; margin: auto; display: flex; align-items: center; justify-content: center;
    background: rgba(20,20,24,.45); border-radius: 50%; opacity: 0; transition: opacity .25s ease; pointer-events: none;
    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
  .fplay { width: 16px; height: 16px; }
  .rplay { width: 24px; height: 24px; }
  .fplay svg, .rplay svg { width: 60%; height: 60%; fill: #fff; filter: none; margin-left: 6%; }
  .fthumb:global(.ok) + .fplay, .rthumb:global(.ok) + .rplay { opacity: 1; }
  .frow .meta { flex: 1; min-width: 0; padding: 8px 0; }
  .frow .meta .nm { display: block; font-size: 16px; line-height: 21px; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frow .meta .fsub { display: block; font-size: 13px; line-height: 18px; color: var(--label2); }
  .frow .dots { flex: 0 0 40px; height: 40px; border: none; background: none; display: flex; align-items: center; justify-content: center; color: var(--label2); border-radius: 50%; }
  .frow .dots:active { background: var(--fill); }
  .frow .dots svg { width: 19px; height: 19px; }

  .empty { padding: 60px 16px; text-align: center; color: var(--label2); font-size: 15px; }
  .empty .big { font-size: 44px; margin-bottom: 12px; opacity: .6; }

  /* 底部玻璃枕 */
  .bottomwrap { position: absolute; left: 0; right: 0; bottom: calc(var(--sab,0px) + 16px); height: 62px; z-index: 30; }
  .bottombar { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 21px;
    transition: opacity .24s, transform .3s cubic-bezier(.32,.72,0,1); }
  .searchbtn { width: 62px; height: 62px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; color: var(--label); transition: transform .25s; }
  .searchbtn:active { transform: scale(.92); }
  .searchbtn svg { width: 23px; height: 23px; }

  .searchrow { position: absolute; inset: 0; display: flex; align-items: center; gap: 12px; padding: 0 28px; opacity: 0; pointer-events: none; transform: translateY(8px) scale(.96); transition: opacity .26s, transform .3s cubic-bezier(.32,.72,0,1); }
  .bottomwrap.searching .bottombar { opacity: 0; pointer-events: none; transform: translateY(4px) scale(.97); }
  .bottomwrap.searching .searchrow { opacity: 1; pointer-events: auto; transform: none; }
  .closebtn { flex: 0 0 48px; width: 48px; height: 48px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; color: var(--label); }
  .closebtn svg { width: 17px; height: 17px; }
  .searchfield { flex: 1; height: 48px; border-radius: 24px; display: flex; align-items: center; gap: 8px; padding: 0 16px; }
  .searchfield svg { flex: 0 0 18px; width: 18px; height: 18px; color: var(--sub); }
  .searchfield input { flex: 1; border: none; background: none; outline: none; height: 100%; font: inherit; font-size: 17px; letter-spacing: -.02em; color: var(--label); }
  .searchfield input::placeholder { color: var(--sub); }

  /* 搜索行的 Figma 液态玻璃（iOS 27 kit「Accessory Bar - iPhone/Search」同款：Liquid Glass - Regular - Small）。
     ::before 外扩 24px 画构建期烘焙的「与底色无关」图层（Figma 原版着色器；锚点＝本页底色 #f2f2f7 / 暗色 #1f1f1e），
     控件自身只留磨砂半径 6 换算的 backdrop 模糊，底色与滚过的内容从下面透上来（不做折射）。
     搜索框宽度随屏幕变：三段切片，两端各 64px 原样、中段逐列不变可拉伸（核对误差 ≤3/255）。
     字色 = kit 标签色按其混合模式落在玻璃上的等效色：主色 #1a1a1a LINEAR_BURN → #0d0d0d，
     三级色 #bfbfbf LINEAR_BURN → #b1b1b3；暗色 #f5f5f5 / #404040 LINEAR_DODGE → #f5f5f5 / #747473。 */
  .fg { position: relative; isolation: isolate; background: none; -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); }
  .fg::before { content: ''; position: absolute; inset: -24px; z-index: -1; pointer-events: none; }
  .closebtn.fg { color: #0d0d0d; }
  .closebtn.fg::before { background: url(../assets/figma-glass/fp-orb48-light.png) center / 100% 100% no-repeat; }
  .searchfield.fg::before { border-style: solid; border-width: 0 64px; border-image: url(../assets/figma-glass/fp-cap48-light.png) 0 192 fill / 0 64px / 0 stretch; }
  .searchfield.fg svg, .searchfield.fg input { color: #0d0d0d; }
  .searchfield.fg input { caret-color: #0088ff; }
  .searchfield.fg input::placeholder { color: #b1b1b3; }
  :global(html:not([data-theme='light'])) .ws-root.embedded:not(.th-light) .closebtn.fg, .ws-root.embedded.th-dark .closebtn.fg { color: #f5f5f5; }
  :global(html:not([data-theme='light'])) .ws-root.embedded:not(.th-light) .closebtn.fg::before, .ws-root.embedded.th-dark .closebtn.fg::before { background-image: url(../assets/figma-glass/fp-orb48-dark.png); }
  :global(html:not([data-theme='light'])) .ws-root.embedded:not(.th-light) .searchfield.fg::before, .ws-root.embedded.th-dark .searchfield.fg::before { border-image-source: url(../assets/figma-glass/fp-cap48-dark.png); }
  :global(html:not([data-theme='light'])) .ws-root.embedded:not(.th-light) .searchfield.fg :is(svg, input), .ws-root.embedded.th-dark .searchfield.fg :is(svg, input) { color: #f5f5f5; }
  :global(html:not([data-theme='light'])) .ws-root.embedded:not(.th-light) .searchfield.fg input::placeholder, .ws-root.embedded.th-dark .searchfield.fg input::placeholder { color: #747473; }

  .selbar { position: absolute; left: 21px; right: 21px; top: 0; height: 62px; border-radius: 31px; display: flex; align-items: center; justify-content: space-around; padding: 0 10px; opacity: 0; pointer-events: none; transform: translateY(10px) scale(.96); transition: opacity .26s, transform .3s cubic-bezier(.32,.72,0,1); }
  .bottomwrap.selecting .selbar { opacity: 1; pointer-events: auto; transform: none; }
  .bottomwrap.selecting .bottombar { opacity: 0; pointer-events: none; }
  .selact { border: none; background: none; display: flex; flex-direction: column; align-items: center; gap: 2px; color: var(--blue); width: 80px; padding: 6px 0; border-radius: 14px; font: inherit; }
  .selact:disabled { color: var(--label3); }
  .selact.danger { color: var(--red); }
  .selact.danger:disabled { color: var(--label3); }
  .selact.done { color: var(--label); }
  .selact svg { width: 21px; height: 21px; }
  .selact span { font-size: 10px; font-weight: 600; }

  /* 长按菜单 */
  /* 长按菜单的背景层：只做「点外面关掉」的命中区，刻意不做虚化——
     菜单本体自带毛玻璃+阴影，足以与内容分层；整片 blur 反而把文件列表糊掉、看不清
     自己长按的是哪一个。保持完全透明，不加任何底色。 */
  .menu-back { position: fixed; inset: 0; z-index: 70; background: transparent; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .ctxmenu { position: fixed; z-index: 72; width: 250px; border-radius: 26px; padding: 6px;
    background: var(--glass-strong); backdrop-filter: blur(30px) saturate(1.9); -webkit-backdrop-filter: blur(30px) saturate(1.9);
    box-shadow: 0 0 0 .5px var(--ring), 0 18px 46px rgba(0,0,0,.25), inset 0 1.4px 1px -.6px var(--hi);
    transform-origin: var(--ox) var(--oy); animation: menupop .32s cubic-bezier(.34,1.22,.36,1); }
  @keyframes menupop { from { opacity: 0; transform: scale(.16); } to { opacity: 1; transform: none; } }
  .mi { display: flex; align-items: center; width: 100%; height: 42px; border-radius: 20px; padding: 0 10px 0 12px; border: none; background: none; color: var(--label); }
  .mi:active { background: var(--press); }
  .mi .micon { flex: 0 0 30px; display: flex; align-items: center; color: var(--label); }
  .mi .micon svg { width: 20px; height: 20px; }
  .mi .mlb { flex: 1; text-align: left; font-size: 17px; letter-spacing: -.02em; font-weight: 400; }
  .mi.destructive { color: var(--red); }
  .mi.ai .micon { color: #cb30e0; }
  .msep { height: 9px; margin: 0 -6px; position: relative; }
  .msep::after { content: ''; position: absolute; left: 0; right: 0; top: 4px; height: 1px; background: var(--hair); }

  /* 传输面板 */
  .tp-scrim { position: fixed; inset: 0; z-index: 54; background: none; }
  .transferpanel { position: absolute; top: calc(var(--sat,0px) + 62px); right: 14px; width: min(354px, calc(100vw - 28px)); border-radius: 26px; z-index: 56; overflow: hidden; animation: tppop .42s cubic-bezier(.34,1.18,.36,1); transform-origin: top right; }
  @keyframes tppop { from { opacity: 0; transform: scale(.2); } to { opacity: 1; transform: none; } }
  .tp-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 10px; }
  .tp-head h3 { font-size: 17px; font-weight: 600; letter-spacing: -.02em; }
  .tp-head button { border: none; background: none; color: var(--blue); font: inherit; font-size: 15px; padding: 4px 2px; }
  .tp-empty { padding: 16px 18px 22px; color: var(--label2); font-size: 14px; text-align: center; }
  .task { display: flex; align-items: center; gap: 12px; padding: 9px 18px; }
  .task .ticon { flex: 0 0 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; }
  .task .ticon :global(svg) { width: 20px; height: 20px; }
  .task .tmeta { flex: 1; min-width: 0; }
  .task .r1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .task .nm { font-size: 14px; font-weight: 500; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task .spd { font-size: 12px; color: var(--label2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .task .track { margin-top: 6px; height: 4px; border-radius: 2px; background: var(--fill); overflow: hidden; }
  .task .fillb { height: 100%; border-radius: 2px; background: var(--blue); transition: width .3s linear; }
  .task .fillb.up { background: var(--green); }
  .task .fillb.off { background: var(--label3); }
  .task .tp-x { flex: 0 0 26px; height: 26px; border: none; border-radius: 50%; background: var(--fill); color: var(--label2); display: flex; align-items: center; justify-content: center; padding: 0; }
  .task .tp-x svg { width: 11px; height: 11px; }
  .task .tp-x:active { filter: brightness(.9); }

  /* 预览模态 */
  .pv-mask { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: calc(var(--sat,0px) + 20px) 16px calc(var(--sab,0px) + 20px); animation: fade .2s; }
  .pv-card { width: 100%; max-width: 560px; max-height: 100%; border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; }
  .pv-head { display: flex; align-items: center; gap: 10px; padding: 14px 12px 14px 18px; border-bottom: .5px solid var(--sep); }
  .pv-name { flex: 1; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pv-dl, .pv-x { width: 34px; height: 34px; border-radius: 50%; border: none; background: var(--fill); color: var(--label); display: flex; align-items: center; justify-content: center; }
  .pv-dl svg { width: 19px; height: 19px; } .pv-x svg { width: 15px; height: 15px; }
  .pv-body { flex: 1; min-height: 0; overflow: auto; display: flex; }
  .pv-body img { width: 100%; height: auto; object-fit: contain; }
  .pv-body pre { flex: 1; margin: 0; padding: 16px; font: 13px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: var(--ink); }
  .pv-loading { flex: 1; display: flex; align-items: center; justify-content: center; padding: 60px; color: var(--label2); }
  .pv-other { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 50px 20px; }
  .pv-other .big { display: flex; }
  .pv-other .big :global(svg) { width: 62px; height: 76px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.1)); }
  .pv-other p { color: var(--label2); font-size: 14px; }
  .pv-dlbtn, .dlg .go { background: var(--blue); color: #fff; border: none; border-radius: 22px; padding: 11px 26px; font: inherit; font-size: 16px; font-weight: 600; }

  /* 对话框 sheet */
  .dlg-mask { position: fixed; inset: 0; z-index: 82; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; padding: 0 36px; animation: fade .2s; }
  .dlg { width: 100%; max-width: 320px; background: var(--sheet); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 22px; padding: 22px 20px 16px; }
  .dlg h3 { font-size: 18px; font-weight: 600; text-align: center; }
  .dlg input { width: 100%; height: 44px; margin: 16px 0; border: none; outline: none; border-radius: 12px; background: var(--field); color: var(--label); padding: 0 14px; font: inherit; font-size: 16px; }
  .dlg-btns { display: flex; gap: 10px; }
  .dlg-btns button { flex: 1; height: 46px; border-radius: 23px; border: none; font: inherit; font-size: 16px; }
  .dlg-btns .cancel { background: var(--field); color: var(--label); }
  .dlg-btns .go { font-weight: 600; }
  .dlg-btns .go:disabled { opacity: .55; }

  /* 分享链接弹窗 */
  .sharedlg .sh-file { margin: 6px 0 10px; text-align: center; font-size: 13px; color: var(--label2); word-break: break-all; }
  .sh-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 2px; }
  .sh-row.col { flex-direction: column; align-items: stretch; gap: 9px; margin-bottom: 14px; }
  .sh-lb { font-size: 15px; color: var(--label); }
  .sw { position: relative; width: 51px; height: 31px; border-radius: 16px; border: none; padding: 0; flex: none; background: rgba(120,120,128,.24); transition: background .2s; }
  .sw.on { background: var(--green); }
  .sw .knob { position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.22); transition: transform .2s; }
  .sw.on .knob { transform: translateX(20px); }
  .sharedlg input.sh-pw { margin: 4px 0 8px; }
  .sh-ttl { display: flex; gap: 6px; }
  .sh-ttl button { flex: 1; height: 34px; border: none; border-radius: 10px; background: var(--field); font: inherit; font-size: 13px; color: var(--label); }
  .sh-ttl button.on { background: var(--blue); color: #fff; font-weight: 600; }
  .sh-url { display: block; width: 100%; margin: 4px 0 10px; padding: 12px 13px; border: none; border-radius: 12px; background: var(--field); font: inherit; font-size: 13px; color: var(--blue); word-break: break-all; text-align: left; line-height: 1.5; }
  .sh-meta { margin: 0 0 14px; text-align: center; font-size: 12.5px; color: var(--label2); line-height: 1.7; }
  .sh-meta b { color: var(--label); }

  /* 移动到/复制到 目录选择器（底部滑入 sheet） */
  .pk-mask { position: fixed; inset: 0; z-index: 84; background: rgba(0,0,0,.4); display: flex; align-items: flex-end; animation: fade .2s; }
  .pk { width: 100%; max-height: 82%; min-height: 52%; display: flex; flex-direction: column; border-radius: 26px 26px 0 0; padding: 0 0 calc(var(--sab,0px) + 12px); animation: pkup .34s cubic-bezier(.32,.72,0,1); }
  @keyframes pkup { from { transform: translateY(100%); } to { transform: none; } }
  .pk-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; }
  .pk-cancel { width: 40px; border: none; background: none; color: var(--blue); font: inherit; font-size: 16px; text-align: left; padding: 0; }
  .pk-cancel:lang(en) { width: auto; min-width: 40px; }   /* 「Cancel」比两个汉字宽，英文下按内容撑开 */
  .pk-title { font-size: 16px; font-weight: 600; }
  .pk-crumb { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 0 18px 8px; }
  .pk-crumb button { background: none; border: none; padding: 0; font: inherit; font-size: 14px; color: var(--blue); }
  .pk-crumb button.cur { color: var(--label); font-weight: 600; }
  .pk-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px; scrollbar-width: none; }
  .pk-list::-webkit-scrollbar { display: none; }
  .pk-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 54px; padding: 0 10px; border: none; background: none; border-radius: 14px; }
  .pk-row:active { background: var(--fill); }
  .pk-fico { width: 38px; height: 32px; object-fit: contain; flex: none; }
  .pk-nm { flex: 1; text-align: left; font-size: 16px; color: var(--label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pk-chev { width: 18px; height: 18px; color: var(--label3); flex: none; }
  .pk-empty { padding: 50px 16px; text-align: center; color: var(--label2); font-size: 15px; line-height: 1.7; }
  .pk-empty small { color: var(--label3); font-size: 13px; }
  .pk-confirm { margin: 8px 16px 0; height: 52px; border: none; border-radius: 26px; background: var(--blue); color: #fff; font: inherit; font-size: 17px; font-weight: 600; box-shadow: 0 6px 16px rgba(0,136,255,.35); }
  .pk-confirm:active { filter: brightness(1.08); }
  .pk-confirm:disabled { background: var(--fill); color: var(--label3); box-shadow: none; }

  /* 显示简介 文件详情卡 */
  .info-card { width: 100%; max-width: 320px; background: var(--sheet); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 22px; padding: 22px 20px 16px; }
  .info-top { display: flex; flex-direction: column; align-items: center; gap: 10px; padding-bottom: 16px; border-bottom: .5px solid var(--sep); }
  .info-ico { width: 64px; height: 56px; object-fit: contain; }
  .info-ico.file :global(svg) { width: 50px; height: 62px; }
  .info-name { font-size: 16px; font-weight: 600; text-align: center; word-break: break-all; }
  .info-rows { padding: 6px 0 14px; }
  .ir { display: flex; align-items: baseline; gap: 12px; padding: 9px 0; border-bottom: .5px solid var(--sep); }
  .ir:last-child { border-bottom: none; }
  .ir span { flex: 0 0 64px; font-size: 14px; color: var(--label2); }
  /* 英文标签（Date modified / Windows properties）比 64px 宽：只在英文下按内容撑开，中文不变 */
  .ir span:lang(en) { flex: 0 0 auto; min-width: 64px; max-width: 50%; }
  .ir b { flex: 1; font-size: 14px; font-weight: 500; text-align: right; }
  .ir b.loc { font-weight: 400; color: var(--label2); word-break: break-all; }
  .info-done { width: 100%; height: 46px; border: none; border-radius: 23px; background: var(--blue); color: #fff; font: inherit; font-size: 16px; font-weight: 600; }

  /* toast */
  .toast { position: fixed; top: calc(var(--sat,0px) + 14px); left: 50%; transform: translateX(-50%); z-index: 90; display: flex; align-items: center; gap: 7px; padding: 10px 18px; border-radius: 22px;
    background: var(--toast); backdrop-filter: blur(24px) saturate(1.8); -webkit-backdrop-filter: blur(24px) saturate(1.8);
    box-shadow: 0 0 0 .5px var(--ring), 0 8px 24px rgba(0,0,0,.16); font-size: 14px; font-weight: 500; animation: toastin .3s;
    width: max-content; max-width: min(calc(100vw - 32px), 640px); box-sizing: border-box; line-height: 1.4; }
  .toast svg { width: 16px; height: 16px; flex: none; color: var(--green); }
  .toast.warn svg { color: #ff9500; }
  @keyframes toastin { from { opacity: 0; transform: translate(-50%,-12px); } to { opacity: 1; transform: translateX(-50%); } }

  /* 「发送给 AI」目标选择 — 底部动作单 */
  .ai-mask { position: fixed; inset: 0; z-index: 95; background: rgba(0,0,0,.32); display: flex; align-items: flex-end; justify-content: center; animation: aifade .2s; }
  @keyframes aifade { from { opacity: 0; } to { opacity: 1; } }
  .ai-sheet { width: 100%; max-width: 460px; background: var(--paper); border-radius: 18px 18px 0 0; padding: 6px 10px max(10px, var(--sab)); box-shadow: 0 -8px 30px rgba(0,0,0,.18); animation: aiup .26s cubic-bezier(.22,1,.36,1); }
  @keyframes aiup { from { transform: translateY(100%); } to { transform: none; } }
  .ai-title { font-size: 13px; color: var(--sub); text-align: center; padding: 13px 8px 9px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ai-opt { width: 100%; display: flex; align-items: center; gap: 13px; padding: 12px 12px; border-radius: 12px; font-size: 16px; color: var(--label); text-align: left; }
  .ai-opt:active { background: var(--soft); }
  .ai-ic { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex: none; background: var(--soft); overflow: hidden; }
  .ai-ic svg { width: 22px; height: 22px; }
  .ai-lb { font-weight: 500; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .ai-lb small { font-size: 12px; color: var(--sub); font-weight: 400; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ai-cancel { width: 100%; margin-top: 5px; padding: 13px; border-radius: 12px; font-size: 16px; font-weight: 600; color: var(--label); background: var(--soft); }
  .ai-cancel:active { background: var(--soft2); }
  /* 「选择对话」层（微信「选择聊天」式）：搜索 + 新对话 + 历史会话列表 */
  .ai-chat-search { display: flex; align-items: center; gap: 8px; margin: 2px 2px 6px; padding: 8px 12px; border-radius: 10px; background: var(--soft); }
  .ai-chat-search svg { width: 16px; height: 16px; color: var(--sub); flex: none; }
  .ai-chat-search input { flex: 1; min-width: 0; border: none; background: none; font-size: 15px; color: var(--label); outline: none; }
  .ai-chat-search input::placeholder { color: var(--ph); }
  .ai-chat-list { max-height: 44vh; overflow-y: auto; overscroll-behavior: contain; margin-top: 2px; border-top: 0.5px solid var(--hair); }
  .ai-chat-row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px 10px; font-size: 15px; color: var(--label); text-align: left; border-bottom: 0.5px solid var(--hair); }
  .ai-chat-row:active { background: var(--soft); }
  .ai-chat-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ai-chat-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dot); }
  .ai-chat-dot.work { background: #d97757; animation: aidot 1.2s ease-in-out infinite; }
  .ai-chat-dot.ask { background: #ff9500; animation: aidot 1.2s ease-in-out infinite; }
  @keyframes aidot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .ai-chat-cur { font-size: 11px; color: var(--sub); background: var(--soft); border-radius: 5px; padding: 2px 6px; flex: none; }
  .ai-chat-time { font-size: 12px; color: var(--sub); flex: none; }
  .ai-chat-empty { text-align: center; color: var(--sub); font-size: 13px; padding: 26px 0 20px; }
</style>
