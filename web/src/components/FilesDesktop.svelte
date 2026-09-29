<script>
  import { uiConfirm } from '../lib/dialogs.js';
  import { createFlip } from '../lib/flipLayout.js';
  // 工作空间 · 电脑浏览器版（鼠标/触控板）：Finder/Explorer 式的工作空间界面，由
  // dock/WorkspaceEmbed 以 embedded 形态挂进 Claude 工作台与 dimensio 工作台的侧列
  // （宽屏 + 精确指针时；手指走 FilesPanel）。形态 = 工具栏 + 高密度列表/图标双视图 +
  // 右键菜单 + 全键盘 + 面板内剪贴板（剪切/复制/粘贴）+ 内部拖拽移动 + 拖入文件上传。
  // 数据全走 bridge 服务端的 /api/files*（与手机版工作空间同一条链路、同一套权限）。
  // 视觉沿用工作空间的 iOS grouped 语言，密度按鼠标操作的标准。
  import { onMount, tick, untrack } from 'svelte';
  import { ui, compose, session, agentOn } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { api } from '../lib/api.js';
  import { openPreview as openPreviewRaw, cloudFileUrl, preview } from '../lib/preview.svelte.js';
  import { openSession, newConversation } from '../lib/chat.svelte.js';
  import { getCachedSessions } from '../lib/cache.js';
  import { titleFor } from '../lib/library.svelte.js';
  import { relTime } from '../lib/format.js';
  import {
    SHARE_TTLS, filterAiSessions, filterFilesByName, formatShareExpiry,
    loadAiSessions, normalizeFileQuery, sendFileToAi, shareClipboardText,
    shareRequest, shareResult,
  } from '../lib/files-business.js';
  import { reportUi, onAgentFs, onAgentGoto } from '../lib/uiReport.js';
  import { WS_DT } from '../lib/fileDrag.js';
  import { t, tc, tr, locale, isEn } from '../lib/i18n.js';

  const BASE = import.meta.env.BASE_URL;

  // —— 形态 ——
  //   embedded：挂进工作台侧列的紧凑形态——返回交还宿主、全局键盘只在面板真正持有焦点时生效
  //   （否则在旁边的 Claude 会话里按个 Delete 就把文件删了）。
  //   workspaceRoot：作用域根（会话的项目目录），所有 /api/files* 请求都带上它。
  const {
    embedded = false, theme = '', workspaceRoot = '', rootName = '', initialPath = null, initialOpen = '',
    previewHost = '', onExit = null,
  } = $props();
  const scoped = (url) => (workspaceRoot ? url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(workspaceRoot) : url);
  // 内嵌时预览留在侧栏（host='dock'），独立分页仍是全屏——影子包装，调用点零改动。
  const openPreview = (items, idx) => openPreviewRaw(items, idx, { host: previewHost || (embedded ? 'dock' : 'app') });

  // 本组件从头到尾拿 rel（根相对路径）当每一项的【主键】：选中、剪贴板、重命名、拖拽、
  // data-rel 全靠它。/api/files 只给 name（个别接口另带 parent），
  // 不补的话所有 rel 都是 undefined——最直接的后果是 `renaming?.rel === it.rel` 变成
  // undefined===undefined 恒真，整列表当场渲染成一排重命名输入框。
  const withRel = (list, base) => (list || []).map((it) => {
    if (it.rel) return it;
    const dir = it.parent ?? base ?? '';
    return { ...it, rel: dir ? dir + '/' + it.name : it.name };
  });

  // 统一数据入口：其余代码只认 fs*。
  const fsList = (p) => api.files(p, workspaceRoot);
  const fsMkdir = (p, name) => api.mkdir(p, name, workspaceRoot);
  const fsRename = (rel, name) => api.renameFile(rel, name, workspaceRoot);
  const fsRemove = (rel) => api.deleteFile(rel, workspaceRoot);
  const fsMove = (rel, dest) => api.moveFile(rel, dest, workspaceRoot);
  const fsCopy = (rel, dest) => api.copyFile(rel, dest, workspaceRoot);

  // —— 核心状态 ——
  let path = $state('');
  let items = $state([]);
  let loading = $state(true);
  let truncated = $state(false);
  let query = $state('');
  let searchEl = $state();
  let selected = $state(new Set());     // 以 rel 为键
  let anchorRel = $state('');           // shift 范围选择锚点 & 键盘焦点
  let renaming = $state(null);          // { rel, value }
  let clipboard = $state(null);         // { mode:'cut'|'copy', rels }（面板内剪贴板）
  let menu = $state(null);              // { x, y, entries }
  let infoDlg = $state(null);
  let shareDlg = $state(null);
  let aiDlg = $state(null);             // { item, chat: { sessions, loading, q } }
  let busyLabel = $state('');
  let toastMsg = $state('');
  let dropOn = $state(null);            // null=没在拖 / ''=当前目录 / rel=某个文件夹
  let marquee = $state(null);           // { l, t, w, h } 视口坐标
  let rowsEl = $state();
  let rootEl = $state();                // 根元素：内嵌时它才是 fixed 的包含块（见 popupMenu）
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

  const rootLabel = $derived(tr(rootName) || t('工作空间'));
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const searching = $derived(query.trim().length > 0);
  const q = $derived(normalizeFileQuery(query));
  const inBrowse = $derived(!searching);

  // —— 工具栏分档（.fd-tb 实测宽度，不用 @container：容器查询量的是整列宽，扣不掉右上
  // 避让区——Claude 顶栏胶囊在内嵌态能吃掉 240px，首版就是因此把钮挤到胶囊底下）——
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
  const crumbItems = $derived([rootLabel, ...segs]);
  const crumbRel = (i) => (i === 0 ? '' : segs.slice(0, i).join('/'));
  const gotoCrumb = (i) => { crumbPop = false; if (i === 0) goRoot(); else goSeg(i - 1); };
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
    crumbItems; searching;   // 内容变了才重量
    crumbHide = 0; crumbSqueeze = false; crumbTail = null;
    const my = ++crumbFit;
    tick().then(() => {
      const inner = crumbsEl?.firstElementChild;
      if (my !== crumbFit || !inner) return;
      const kids = [...inner.children];
      const segEls = kids.filter((k) => k.classList.contains('crumb'));
      const end = kids.length ? kids[kids.length - 1].offsetLeft + kids[kids.length - 1].offsetWidth : 0;
      // offsetLeft 不含 transform（FLIP 途中也量得准）
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
  $effect.pre(() => { tbTier; crumbHide; crumbSqueeze; view; searchFocus; searching; untrack(() => tbFlip.snapshot()); });
  $effect(() => { tbTier; crumbHide; crumbSqueeze; view; searchFocus; searching; untrack(() => tbFlip.play()); });
  $effect(() => () => tbFlip.destroy());

  // —— 行数据（排序：文件夹恒在前，组内按列排）——
  // 搜索＝就地过滤当前目录（服务端没有全局索引；与手机版工作空间同一套语义）。
  const effSort = $derived({ key: sortKey, dir: sortDir });
  const listSource = $derived(searching ? filterFilesByName(items, q) : items);
  const rows = $derived.by(() => {
    const arr = [...listSource];
    const dirCmp = (a, b) => Number(b.isDir) - Number(a.isDir);
    const key = effSort.key, dir = effSort.dir;
    const sizeKey = (it) => (it.isDir ? -1 : it.size || 0);
    const cmp = (a, b) => {
      if (key === 'mtime') return ((a.mtime || 0) - (b.mtime || 0)) * dir;
      if (key === 'size') return (sizeKey(a) - sizeKey(b)) * dir;
      if (key === 'type') return String(extOf(a.name)).localeCompare(String(extOf(b.name))) * dir || a.name.localeCompare(b.name, locale());
      return a.name.localeCompare(b.name, locale()) * dir;
    };
    arr.sort((a, b) => dirCmp(a, b) || cmp(a, b));
    return arr;
  });
  const showParentCol = $derived(searching);
  const cutSet = $derived(clipboard?.mode === 'cut' ? new Set(clipboard.rels) : new Set());
  const canPaste = $derived(Boolean(clipboard && inBrowse));
  const listBusy = $derived(loading);
  const anyDialog = $derived(Boolean(menu || infoDlg || shareDlg || aiDlg || sortOpen || addOpen || crumbPop || renaming));

  // —— 导航（含历史）——
  const snapshot = () => ({ path });
  async function applyNav(next) {
    path = next.path;
    query = ''; selected = new Set(); anchorRel = ''; renaming = null;
    await load(next.path);
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
  const canUp = $derived(inBrowse ? segs.length > 0 : true);
  async function goUp() {
    if (!inBrowse) { await navTo({ path }); return; }   // 搜索中＝退出搜索回到当前目录
    if (segs.length) await navTo({ path: segs.slice(0, -1).join('/') });
  }
  const enterDir = (rel) => navTo({ path: rel });
  const goSeg = (i) => navTo({ path: segs.slice(0, i + 1).join('/') });
  const goRoot = () => navTo({ path: '' });
  // 独立分页＝回主页；内嵌态＝把返回交还宿主（工作台菜单 / 收起侧栏）。
  function goHome() { if (onExit) { onExit(); return; } closePage('files'); }

  async function load(p = path, { keepSel = false } = {}) {
    loading = true;
    try {
      const r = await fsList(p);
      path = r.path ?? p;
      items = withRel(r.items, path); truncated = Boolean(r.truncated);
      if (keepSel) {
        const rels = new Set(items.map((x) => x.rel));
        selected = new Set([...selected].filter((x) => rels.has(x)));
      }
    } catch (e) { items = []; truncated = false; toast(t('加载失败：{reason}', { reason: tr(e.message || '') })); }
    loading = false;
  }
  const refresh = () => load(path, { keepSel: true });

  onMount(() => {
    // initialPath：内嵌宿主指定的起始目录（工作台侧栏按会话工作空间挂载时用）；
    // 没传才吃 ui.filesPath 那份一次性预置（独立分页老路）。
    const p0 = initialPath ?? ui.filesPath ?? '';
    if (initialPath == null) ui.filesPath = null;
    path = p0;
    const first = load(p0);
    // initialOpen：列表就位后自动打开指定文件的预览（产物卡「在工作区里打开」走它）。
    if (initialOpen) Promise.resolve(first).then(() => {
      const it = rows.find((f) => !f.isDir && f.name === initialOpen);
      if (it) openItem(it);
    }).catch(() => {});
  });

  // 刷新由 agent 的 fs 事件驱动（服务端没有推给本面板的文件 watcher），
  // 顺带上报当前目录，让 agent 的 workspace.view 知道用户在看哪儿——与手机版同一套。
  $effect(() => {
    reportUi({ files: { path, ws: workspaceRoot || '', query: q || '' } });
  });
  $effect(() => {
    let tm = 0;
    const offFs = onAgentFs(() => { clearTimeout(tm); tm = setTimeout(() => load(path, { keepSel: true }), 350); });
    const offGoto = onAgentGoto((rootRel) => navTo({ path: rootRel }));
    return () => { clearTimeout(tm); offFs(); offGoto(); };
  });

  // —— 缩略图：只有图片有服务端衍生缩略图（sharp）；其余类型用矢量占位图标，
  // 别去请求一个必然 404 的地址。<img loading="lazy"> 负责滚动懒取。——
  const thumbOf = (it) => (!it.isDir && kindOf(it.name) === 'img' ? cloudFileUrl(it.rel, { thumb: true, mt: it.mtime, ws: workspaceRoot }) : '');

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
  const srcItem = (it, kind) => ({ origin: 'cloud', rel: it.rel, name: it.name, kind, mt: it.mtime, ws: workspaceRoot });
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
    doDownload(it);   // 不可预览的类型（压缩包/可执行/未知）落到浏览器下载
  }
  // 下载＝浏览器下载（&dl=1 让服务端带上 Content-Disposition）。
  function doDownload(it) {
    const href = cloudFileUrl(it.rel, { dl: true, ws: workspaceRoot });
    const a = document.createElement('a');
    a.href = href; a.download = it.name; document.body.appendChild(a); a.click(); a.remove();
  }

  // —— 文件操作 ——
  async function doDelete() {
    const list = [...selected];
    if (!list.length) return;
    // 服务端删除是真删、不可撤销，先确认。
    if (!(await uiConfirm(t('删除选中的 {n} 项？', { n: list.length }), { detail: t('删除后不可恢复。'), okLabel: isEn() ? t('删除') : undefined }))) return;
    busyLabel = t('删除中…');
    let fail = 0;
    for (const rel of list) { try { await fsRemove(rel); } catch { fail++; } }
    busyLabel = '';
    selected = new Set(); anchorRel = '';
    toast(fail ? t('{n} 项删除失败', { n: fail }) : t('已删除 {n} 项', { n: list.length }));
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
  function renameInput(node) {
    node.focus();
    const dot = node.value.lastIndexOf('.');
    node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
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
  // 剪贴板：面板内部记一份 rel 清单，粘贴时按 rel 在同一作用域内复制/移动（保留剪切语义）。
  function setClipboard(mode2) {
    if (!selected.size) return;
    const rels = [...selected];
    clipboard = { mode: mode2, rels };
    toast(mode2 === 'cut' ? t('已剪切 {n} 项', { n: rels.length }) : t('已复制 {n} 项', { n: rels.length }));
  }
  // 「已移动 / 已复制 n 项（，f 项失败）」——粘贴与拖放共用；英文语序不同，整句一个键
  const doneMsg = (moved, n, f = 0) => (f
    ? (moved ? t('已移动 {n} 项，{f} 项失败', { n, f }) : t('已复制 {n} 项，{f} 项失败', { n, f }))
    : (moved ? t('已移动 {n} 项', { n }) : t('已复制 {n} 项', { n })));
  async function doPaste() {
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
    if (m === 'cut') clipboard = null;
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
    toast(ok ? doneMsg(!copy, ok) : (err ? tr(err) : t('操作失败')));
    await refresh();
  }

  let extracting = false;
  async function doExtract(it) {
    if (extracting) return;
    extracting = true;
    toast(t('解压中…'));
    try { const r = await api.extractFile(it.rel, workspaceRoot); toast(t('已解压到「{name}」', { name: r.name })); await refresh(); }
    catch (e) { toast(t('解压失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
    finally { extracting = false; }
  }

  // 浏览器选文件 / 文件夹 → 分块上传。
  function pickUpload(directory = false) {
    addOpen = false;
    if (!inBrowse) return;
    (directory ? dirUploadInput : fileUploadInput)?.click();
  }
  // —— 上传（与手机版工作空间同一个 /api/files/upload：1MB 一片，服务端流式落盘）——
  // webkitRelativePath 存在＝选的是整个文件夹，按相对路径原样铺进目标目录。
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
      const id = 'up' + Math.random().toString(36).slice(2, 12);
      const CHUNK = 1024 * 1024;
      try {
        for (let off = 0; off < f.size || off === 0; off += CHUNK) {
          const last = off + CHUNK >= f.size ? 1 : 0;
          await api.post(scoped(`/api/files/upload?path=${encodeURIComponent(dir)}&id=${id}&last=${last}&name=${encodeURIComponent(f.name)}`), f.slice(off, off + CHUNK));
          if (last) break;
        }
        ok++;
      } catch (err) { toast(t('上传失败：{reason}', { reason: err.body?.error ? tr(err.body.error) : f.name })); }
    }
    busyLabel = '';
    if (ok) toast(t('已上传 {n} 项', { n: ok }));
    await refresh();
  }

  // —— 简介（列表里已有的那几项就是全部）——
  function showInfo(it) {
    infoDlg = { name: it.name, isDir: it.isDir, size: it.size, mtime: it.mtime, rel: it.rel, dir: it.parent ?? parentOf(it.rel) };
  }
  async function copyText(text, note = t('已复制')) {
    try { await navigator.clipboard.writeText(text); toast(note); } catch { toast(t('复制失败')); }
  }

  // —— 分享链接（由 bridge 服务端铸造）。文件也铸成只含它的分享空间（/w/），同 FilesPanel ——
  function openShare(it) { shareDlg = { item: it, pwOn: false, password: '', ttl: 24, busy: false, result: null }; }
  async function doShareLink() {
    const d = shareDlg;
    if (!d || d.busy) return;
    const request = shareRequest(d);
    if (request.error) { toast(tr(request.error)); return; }
    d.busy = true;
    try {
      const r = await api.shareSpaceMint([d.item.rel], request.options, workspaceRoot);
      d.result = shareResult(r, request.password);
    } catch (e) { toast(t('创建分享失败：{reason}', { reason: tr(e.body?.error || e.body || e.message || '') })); }
    d.busy = false;
  }
  const fmtExpire = formatShareExpiry;

  // —— 发送给 AI（Claude）：选一个对话（或新开），文件当附件挂进它的输入栏 ——
  async function openAi(it) {
    aiDlg = { item: it, chat: { sessions: [], loading: true, q: '' } };
    const st = aiDlg.chat;   // 读回来的是状态代理：后面按身份比较、就地改写都认它
    await loadAiSessions('claude', {
      cached: () => getCachedSessions(),
      remote: () => api.sessions(),
      current: () => aiDlg?.chat === st,
      onCached: (sessions) => { st.sessions = sessions; },
      onDone: (sessions) => { if (sessions) st.sessions = sessions; st.loading = false; },
    });
  }
  async function aiMaterial(it, direct = false) {
    const kind = it.isDir ? 'folder' : (kindOf(it.name) === 'img' ? 'image' : 'file');
    try {
      const up = await api.fileToUpload(it.rel, !direct, workspaceRoot);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(it.rel, { ws: workspaceRoot }) : null };
    } catch (e) { toast(t('准备失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return null; }
  }
  function pickChat(sel) {
    const it = aiDlg?.item;
    aiDlg = null;
    if (it) sendToAI(it, sel);
  }
  const chatTitle = (s) => tr(titleFor(s.id, s.title)) || t('（无标题）');   // 服务端占位标题走 tr
  const aiChatFiltered = $derived.by(() => {
    const c = aiDlg?.chat;
    if (!c) return [];
    return filterAiSessions(c.sessions, c.q, chatTitle);
  });
  async function sendToAI(it, sess) {
    await sendFileToAi(it, sess, {
      material: aiMaterial,
      toast,
      chat: {
        current: () => session.id,
        newChat: () => newConversation(),
        load: (id) => openSession(id),
        attach: (attachment) => compose.attachments.push(attachment),
      },
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
      // 不可预览类型（zip/exe/未知）不出「预览」——它们的打开动作就是下面的「下载到本地」。
      if (previewable) {
        entries.push({ label: it.isDir ? t('打开') : t('预览'), act: () => openItem(it), bold: true });
        entries.push({ sep: true });
      }
      if (agentOn('claude')) entries.push({ label: t('发送给 AI…'), act: () => openAi(it), accent: true });
      entries.push({ label: t('分享链接…'), act: () => openShare(it) });
      if (!it.isDir && k === 'zip') entries.push({ label: t('解压到当前文件夹'), act: () => doExtract(it) });
      entries.push({ sep: true });
      if (!it.isDir) entries.push({ label: t('下载到本地'), act: () => doDownload(it) });
    }
    entries.push({ label: t('剪切'), hint: 'Ctrl+X', act: () => setClipboard('cut') });
    entries.push({ label: t('复制'), hint: 'Ctrl+C', act: () => setClipboard('copy') });
    if (!multi) {
      entries.push({ label: t('重命名'), hint: 'F2', act: () => startRename(it) });
      entries.push({ label: tc('explorer', '简介'), act: () => showInfo(it) });
    }
    entries.push({ sep: true });
    entries.push({ label: multi ? t('删除（{n} 项）', { n: selected.size }) : t('删除'), hint: 'Del', act: () => doDelete(), danger: true });
    popupMenu(e, entries);
  }
  function openBlankMenu(e) {
    if (e.target.closest('[data-rel]')) return;
    const entries = [];
    if (inBrowse) {
      entries.push({ label: t('新建文件夹'), act: newFolder });
      entries.push({ label: t('上传文件…'), act: () => pickUpload(false) });
      entries.push({ label: t('上传文件夹…'), act: () => pickUpload(true) });
      entries.push({ label: t('粘贴'), hint: 'Ctrl+V', act: doPaste, disabled: !canPaste });
      entries.push({ sep: true });
    }
    entries.push({ label: t('全选'), hint: 'Ctrl+A', act: selectAll });
    entries.push({ label: t('刷新'), hint: 'F5', act: refresh });
    popupMenu(e, entries);
  }

  // —— 内部拖拽（同作用域移动 / Ctrl=复制）+ 拖入文件上传 ——
  let dragRels = null;
  function rowDragStart(e, it) {
    if (renaming) { e.preventDefault(); return; }
    if (!selected.has(it.rel)) { selected = new Set([it.rel]); anchorRel = it.rel; }
    dragRels = [...selected];
    // 描述符随拖拽一起走：拖回本页＝内部移动（认 dragRels），拖进对话＝按 rel 现场备素材
    // 挂进那个会话的输入栏（见 lib/fileDrag.js 的 attachDescriptorToAgent）。
    try {
      e.dataTransfer.effectAllowed = 'copyMove';
      // dirs 与 rels 一一对应：落点（如 dimensio 跨工作空间那条）要据此把文件夹挑出来说清楚
      const dirs = dragRels.map((rel) => Boolean(rows.find((x) => x.rel === rel)?.isDir));
      e.dataTransfer.setData(WS_DT, JSON.stringify({ rels: dragRels, dirs, ws: workspaceRoot }));
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
    } else if (dtHasFiles(e) && inBrowse) {
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
    } else if (dtHasFiles(e) && inBrowse) {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      dropOn = '';
    }
  }
  function dragLeavePane(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = null; }
  function dragOverCrumb(e, destRel) {
    if (!dragRels) return;
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
    if (files.length) await uploadFiles(files, destRel);
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
      if (sortOpen || addOpen) { sortOpen = false; addOpen = false; return; }
      if (aiDlg) { aiDlg = null; return; }
      if (shareDlg) { if (!shareDlg.busy) shareDlg = null; return; }
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
    if (e.key === 'F5') { e.preventDefault(); refresh(); return; }
    if (e.key === 'F2') { e.preventDefault(); const it = selectedRows()[0]; if (it && selected.size === 1) startRename(it); return; }
    if (e.key === 'Delete') { e.preventDefault(); doDelete(); return; }
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
  // 「类型」列：扩展名 + 类别（PNG 图片 / PNG image）；英文语序与中文一致但要小写名词，故每类一个带 {ext} 的键。
  // doc 不在表里 → 走 typeLabel 的「{ext} 文件」兜底。
  const KIND_LABEL = {
    img: (ext) => t('{ext} 图片', { ext }),
    mov: (ext) => t('{ext} 视频', { ext }),
    audio: (ext) => t('{ext} 音频', { ext }),
    pdf: (ext) => t('{ext} PDF 文稿', { ext }),
    zip: (ext) => t('{ext} 压缩归档', { ext }),
    md: (ext) => (isEn() ? t('Markdown 文件') : `${ext} Markdown`),
    text: (ext) => t('{ext} 文本', { ext }),
    html: (ext) => t('{ext} 网页', { ext }),
  };
  function typeLabel(it) {
    if (it.isDir) return t('文件夹');
    const ext = extOf(it.name);
    if (!ext) return t('文件');
    const lb = KIND_LABEL[kindOf(it.name)];
    return lb ? lb(ext.toUpperCase()) : t('{ext} 文件', { ext: ext.toUpperCase() });
  }
  // iOS 文件 app 风类型图标（没有缩略图时的占位）
  const TYPE_COLOR = { pdf: '#ff3b30', img: '#32ade6', mov: '#5856d6', audio: '#ff2d55', zip: '#ff9500', md: '#8e8e93', text: '#8e8e93', html: '#ff8d28', doc: '#007aff' };
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
    if (!searching && truncated) parts.push(t('目录超过 2000 项，仅显示前 2000'));
    return parts.join(' · ');
  });

  let toastTimer = null;
  function toast(m) { toastMsg = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastMsg = ''), 2400); }
</script>

<svelte:window onkeydown={onKey} />

<div class="fd-root" class:embedded class:th-light={theme === 'light'} class:th-dark={theme === 'dark'} bind:this={rootEl} role="presentation" oncontextmenu={(e) => e.preventDefault()}>
  <!-- 工具栏：外层 .fd-toolbar 吃右上避让（--fd-avoid-r，内嵌时由宿主给），
       内层 .fd-tb 才是排版容器，宽度用 ResizeObserver 量出来分档（见 tbTier）。 -->
  {#snippet crumbs()}
    {#if crumbHide > 0}
      <div class="tb-drop crumb-more" data-flip="cmore">
        <button class="tb-btn ell" title={t('被收起的上级目录')} aria-label={t('展开上级目录')} onclick={() => { crumbPop = !crumbPop; sortOpen = false; addOpen = false; }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg>
        </button>
        {#if crumbPop}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (crumbPop = false)}></button>
          <div class="pop left">
            {#each crumbItems.slice(0, crumbHide) as it, i (i)}
              <button class="pop-mi" style:padding-left="{9 + i * 10}px" onclick={() => gotoCrumb(i)}>
                <svg class="pm-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/></svg>{it}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <div class="fd-crumbs" class:squeeze={crumbSqueeze} role="presentation" bind:this={crumbsEl} data-flip="crumbs" data-flip-morph="x">
      <div class="fd-crumbs-in" data-flip-inner>
        {#each crumbItems as it, i (i)}
          {#if i >= crumbHide}
            {#if i > crumbHide}<svg class="crumb-sep" data-flip="csep-{i}" data-flip-anchor="left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 6 6 6-6 6"/></svg>{/if}
            {#if i < crumbItems.length - 1}
              <button class="crumb" data-flip="crumb-{i}" data-flip-anchor="left" class:dropin={dropOn === 'crumb:' + crumbRel(i)}
                onclick={() => gotoCrumb(i)} ondragover={(e) => dragOverCrumb(e, crumbRel(i))} ondrop={onDrop}>{it}</button>
            {:else}
              <span class="crumb cur" data-flip="crumb-{i}" data-flip-anchor="left">{it}</span>
            {/if}
          {/if}
        {/each}
        {#if searching}<span class="crumb-note" data-flip="cnote" data-flip-anchor="left">{t('搜索「{query}」', { query: query.trim() })}</span>{/if}
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
      <button class="tb-btn" data-flip="home" title={embedded ? t('返回工作台') : t('返回主页')} onclick={goHome} aria-label={embedded ? t('返回工作台') : t('返回主页')}>
        {#if embedded}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4l8 7.2"/><path d="M6 10v9h12v-9"/></svg>
        {/if}
      </button>
      {#if tbTier < 2}
        <span class="tb-gap"></span>
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
        <button class="tb-btn" title={t('新建 / 上传')} aria-label={t('新建或上传')} onclick={() => { addOpen = !addOpen; sortOpen = false; crumbPop = false; }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        {#if addOpen}
          <button class="pop-scrim" aria-label={t('关闭')} onclick={() => (addOpen = false)}></button>
          <div class="pop">
            <button class="pop-mi" disabled={!inBrowse} onclick={() => { addOpen = false; newFolder(); }}>{t('新建文件夹')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => pickUpload(false)}>{t('上传文件…')}</button>
            <button class="pop-mi" disabled={!inBrowse} onclick={() => pickUpload(true)}>{t('上传文件夹…')}</button>
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
            {searching ? t('未找到相关文件') : t('这个文件夹是空的')}
            {#if inBrowse}<small>{t('把文件拖进窗口即可上传')}</small>{/if}
          </div>
        {:else if view === 'list'}
          {#each rows as it (it.rel)}
            {@const th = thumbOf(it)}
            <div class="row" data-rel={it.rel} role="button" tabindex="-1"
              class:sel={selected.has(it.rel)} class:cut={cutSet.has(it.rel)} class:dropin={dropOn === it.rel}
              draggable="true"
              ondragstart={(e) => rowDragStart(e, it)} ondragend={rowDragEnd}
              ondragover={(e) => dragOverDir(e, it)} ondrop={onDrop}
              onclick={(e) => clickRow(e, it)} ondblclick={() => { if (!renaming) openItem(it); }}
              oncontextmenu={(e) => openItemMenu(e, it)}>
              <span class="cell name">
                <span class="ric">
                  {#if it.isDir}
                    <img class="ric-dir" src="{BASE}assets/icons/workspace.png" alt="" draggable="false" />
                  {:else if th}
                    <img class="ric-img" src={th} alt="" loading="lazy" draggable="false" />
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
              <span class="cell size">{it.isDir ? '—' : fmtSize(it.size)}</span>
            </div>
          {/each}
        {:else}
          {#each rows as it (it.rel)}
            {@const th = thumbOf(it)}
            <div class="tile" data-rel={it.rel} role="button" tabindex="-1"
              class:sel={selected.has(it.rel)} class:cut={cutSet.has(it.rel)} class:dropin={dropOn === it.rel}
              draggable="true"
              ondragstart={(e) => rowDragStart(e, it)} ondragend={rowDragEnd}
              ondragover={(e) => dragOverDir(e, it)} ondrop={onDrop}
              onclick={(e) => clickRow(e, it)} ondblclick={() => { if (!renaming) openItem(it); }}
              oncontextmenu={(e) => openItemMenu(e, it)}>
              <span class="tic">
                {#if it.isDir}
                  <img class="tic-dir" src="{BASE}assets/icons/workspace.png" alt="" draggable="false" />
                {:else if th}
                  <img class="tic-img" src={th} alt="" loading="lazy" draggable="false" />
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
          {#if infoDlg.isDir}<img class="info-ico" src="{BASE}assets/icons/workspace.png" alt="" />{:else}<span class="info-ico file">{@html fileIcon(infoDlg.name)}</span>{/if}
          <div class="info-name">{infoDlg.name}</div>
        </div>
        <div class="info-rows">
          <div class="ir"><span>{t('种类')}</span><b>{typeLabel(infoDlg)}</b></div>
          <div class="ir"><span>{t('大小')}</span><b>{infoDlg.isDir ? t('文件夹') : fmtSize(infoDlg.size)}</b></div>
          <div class="ir"><span>{t('修改时间')}</span><b>{fmtFull(infoDlg.mtime)}</b></div>
          <div class="ir"><span>{t('位置')}</span><b class="loc">{rootLabel}{infoDlg.dir ? ' / ' + infoDlg.dir.split('/').join(' / ') : ''}</b></div>
        </div>
        <div class="dlg-btns">
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
          <p class="sh-meta">{t('{time} 过期', { time: fmtExpire(shareDlg.result.expiresAt) })}{#if shareDlg.result.pw} · {t('密码')} <b>{shareDlg.result.pw}</b>{/if}</p>
          <div class="dlg-btns">
            <button class="btn" onclick={() => (shareDlg = null)}>{t('完成')}</button>
            <button class="btn go" onclick={() => copyText(shareClipboardText(shareDlg.result), t('已复制链接'))}>{t('复制链接')}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- 发送给 AI -->
  {#if aiDlg}
    <div class="dlg-mask" onclick={() => (aiDlg = null)} role="presentation">
      <div class="dlg ai" onclick={(e) => e.stopPropagation()} role="presentation">
        {#if aiDlg.chat}
          <h3>{t('发送到 {name} · 选择对话', { name: 'Claude' })}</h3>
          <p class="dlg-sub">{aiDlg.item.isDir ? '📁 ' : ''}{aiDlg.item.name}</p>
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
                <span class="ai-dot" class:work={s.thinking} class:ask={!s.thinking && s.pending}></span>
                <span class="ai-title">{chatTitle(s)}</span>
                {#if s.id === session.id}<span class="ai-cur">{t('当前')}</span>{/if}
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

  <input class="hidden-input" bind:this={fileUploadInput} type="file" multiple onchange={onUploadPick} />
  <input class="hidden-input" bind:this={dirUploadInput} type="file" webkitdirectory multiple onchange={onUploadPick} />
</div>

<style>
  /* 桌面工作空间：跟随全站明暗（data-theme），Explorer 级密度；宿主有自己的明暗档时（dimensio）
     经 theme 属性强制 .th-light / .th-dark，与旁边的对话区保持同一档。
     暗色是默认（与 :root 一致：data-theme 缺省即暗）——Claude 底 #1f1f1e 上的 iOS 暗色语言；
     浅色沿用工作空间家族的 iOS 浅色语言（蓝 #0071e3、#f2f2f7）。所有颜色只走下列令牌，别再就地写死。 */
  .fd-root {
    --blue: #4f9dff; --blue-soft: rgba(79, 157, 255, .16); --red: #ff6961;
    --bg: #1f1f1e; --panel: #262625; --bar: rgba(31, 31, 30, .94);
    --ink: #ececea; --ink2: rgba(235, 235, 240, .62); --ink3: rgba(235, 235, 240, .4);
    --sep: rgba(255, 255, 255, .09); --hover: rgba(255, 255, 255, .07); --row-alt: rgba(255, 255, 255, .03);
    --seg-bg: rgba(255, 255, 255, .08); --field-bg: #1b1b1a; --pop-bg: rgba(44, 44, 42, .98); --dlg-bg: #2a2a29;
    --mask: rgba(0, 0, 0, .5); --pop-shadow: 0 10px 34px rgba(0, 0, 0, .55); --ctx-shadow: 0 12px 44px rgba(0, 0, 0, .6);
    /* 右上避让：整页形态让出窗控覆盖区（--wco-right，没有即 0）；内嵌形态听宿主的 --dock-avoid-r */
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
    --bg: #f2f2f7; --panel: #fff; --bar: rgba(248, 248, 250, .92);
    --ink: #1d1d1f; --ink2: rgba(60, 60, 67, .62); --ink3: rgba(60, 60, 67, .4);
    --sep: rgba(60, 60, 67, .1); --hover: rgba(120, 120, 128, .09); --row-alt: rgba(120, 120, 128, .045);
    --seg-bg: rgba(120, 120, 128, .1); --field-bg: #fff; --pop-bg: rgba(252, 252, 253, .97); --dlg-bg: #fbfbfd;
    --mask: rgba(20, 20, 24, .3); --pop-shadow: 0 10px 34px rgba(0, 0, 0, .16); --ctx-shadow: 0 12px 44px rgba(0, 0, 0, .2);
    color-scheme: light;
  }
  /* 内嵌形态（工作台侧栏）：让开状态栏、密度略收、去掉整页才需要的留白；
     右上听宿主给的 --dock-avoid-r，没给就退回整页的避让 */
  .fd-root.embedded { z-index: 1; --fd-avoid-r: var(--dock-avoid-r, var(--wco-right, 0px)); }
  .fd-root.embedded .fd-toolbar { padding-top: calc(var(--sat) + 8px); }
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

  /* 发送给 AI */
  .dlg.ai { width: 420px; }
  .ai-opt { display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 10px; border: 0; border-radius: 11px; background: none; text-align: left; cursor: pointer; }
  .ai-opt:hover { background: var(--hover); }
  .ai-ic { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto; overflow: hidden; }
  .ai-ic svg { width: 19px; height: 19px; }
  .ai-lb { flex: 1; display: flex; flex-direction: column; gap: 1px; font-size: 13.5px; font-weight: 600; }
  .ai-lb small { font-size: 11.5px; font-weight: 400; color: var(--ink2); }
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

  /* ── 窄列（工作台侧栏常态 ≈ 300–640px）自适应 ─────────────────────────────
     【必须留在文件末尾】：@container 不加特异性，同名规则按源顺序后者胜，放前面会被
     上文的 .fd-search{width:200px} / .fd-crumbs{min-width:0} / .tb-seg{display:flex} 盖掉。
     列表：固定列 150+110+86 一加就把名称列挤成零宽、行图标裁成一条缝——名称是正文，
     其它列按宽度逐级让位：先收类型，再收大小，只留修改时间。
     工具栏不在这里分档：它按 .fd-tb 的实测宽度走 JS tier（tbTier），因为 @container
     量的是整列宽、扣不掉右上避让区（Claude 顶栏胶囊等）。这里只保证子项不收缩。 */
  .tb-btn, .tb-seg, .tb-drop, .fd-search { flex: 0 0 auto; }
  .fd-crumbs { min-width: 64px; }
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
