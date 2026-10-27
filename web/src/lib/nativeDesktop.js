// bridge-client 桌面原生能力桥。所有调用都 feature-detect：网页版与 Android 壳
// 没有 window.BridgeDesktop 时保持原路径，不引入任何桌面分支副作用。

const D = typeof window !== 'undefined' ? window.BridgeDesktop : null;

export const isNativeDesktop = () => Boolean(D);
// 服务端是不是就在这台电脑上。是：本机绝对路径服务端认得（零拷贝附件、原生选文件夹、本地协议直读工作空间）；
// 否（壳连的是 VPS 等远端服务端）：这台电脑只是「设备」，文件只能上传过去，工作空间是服务器上的那份。
// 壳经 connection.isLocal 同步告诉；没有这个接口的老壳只会连本机服务端。
// 一页只问一次（10-21 回归 R2）：isLocal() 每调一次就是一趟 sendSync，主进程还要现读盘、现解密设备令牌，
// 而缩略图、md 嵌图、设备芯片这些热路径一屏能调上百次。换服务器 = 壳重载页面，所以页内缓存不会过期。
// 问的时候抛错（壳正忙 / 老壳半残）不记账，下次再问。
let localCache = null;
export const serverOnThisMachine = () => {
  if (localCache !== null) return localCache;
  if (!D) return (localCache = false);
  if (typeof D.connection?.isLocal !== 'function') return (localCache = true);
  try { return (localCache = Boolean(D.connection.isLocal())); } catch { return true; }
};
export const hasNativeWorkspace = () => Boolean(D?.workspace?.list) && serverOnThisMachine();

// opts.fresh：用户主动刷新（F5 / 右键「刷新」）时跳过主进程的列表缓存；老壳不认第三个参数，照常走缓存
export async function nativeWorkspaceList(rel = '', locationId = 'primary', opts = null) {
  if (!hasNativeWorkspace()) throw new Error('native workspace unavailable');
  return opts?.fresh ? D.workspace.list(rel, locationId, { fresh: true }) : D.workspace.list(rel, locationId);
}
// 离开某个位置（换位置 / 关掉文件面板）：主进程给它挂的目录监听排到最先淘汰（不当场关，别的视图还在看也无妨）。
// 老壳没有这个方法就什么都不做。
export function nativeWorkspaceRelease(locationId) {
  if (!locationId || typeof D?.workspace?.release !== 'function') return;
  try { Promise.resolve(D.workspace.release(locationId)).catch(() => {}); } catch { /* 老壳半残 */ }
}

export function nativeWorkspaceFileUrl(rel = '', locationId = 'primary') {
  return D?.workspace?.fileUrl && serverOnThisMachine() ? D.workspace.fileUrl(rel, locationId) : '';
}

export function onNativeWorkspaceChanged(fn) {
  return D?.workspace?.onChanged ? D.workspace.onChanged(fn) : () => {};
}

export const hasNativeWorkspaceOps = () => Boolean(D?.workspace?.trash && D?.workspace?.importFiles) && serverOnThisMachine();
export const nativeWorkspaceLocations = () => D?.workspace?.locations?.() || Promise.resolve([]);
export const nativeWorkspaceAddLocation = () => D?.workspace?.addLocation?.();
export const nativeWorkspaceRemoveLocation = (locationId) => D?.workspace?.removeLocation?.(locationId);
export const nativeWorkspaceMkdir = (rel, name, locationId = 'primary') => D.workspace.mkdir(rel, name, locationId);
// 新建文件（只建不覆盖）。没有 createFile 的旧壳退回 writeText——它会覆盖，调用方须先按列表避开重名
export const nativeWorkspaceCreateFile = (rel, name, content = '', locationId = 'primary') => (D.workspace.createFile
  ? D.workspace.createFile(rel, name, content, locationId)
  : D.workspace.writeText(rel ? rel + '/' + name : name, content, locationId).then(() => ({ ok: true, name })));
// Windows 自带「创建存档」向导（只有新壳有；旧壳/非 Windows 走内置压缩选项）。
// payload：{ rels, locationId }（原生位置）或 { root, rels }（云端作用域绝对根）；向导关掉后回 { ok, archive, busy?, error? }
export const hasNativeCompressWizard = () => Boolean(D?.workspace?.compressWizard) && /Windows/i.test(navigator.userAgent);
export const nativeCompressWizard = (payload) => D.workspace.compressWizard(payload);
export const nativeWorkspaceRename = (rel, name, locationId = 'primary') => D.workspace.rename(rel, name, locationId);
export const nativeWorkspaceTrash = (rel, locationId = 'primary') => D.workspace.trash(rel, locationId);
export const nativeWorkspaceMove = (rel, dest, locationId = 'primary') => D.workspace.move(rel, dest, locationId);
export const nativeWorkspaceCopy = (rel, dest, locationId = 'primary') => D.workspace.copy(rel, dest, locationId);
export const nativeWorkspaceOpen = (rel, locationId = 'primary') => D.workspace.open(rel, locationId);
export const nativeWorkspaceOpenWith = (rel, locationId = 'primary') => D.workspace.openWith(rel, locationId);
export const nativeWorkspaceReveal = (rel, locationId = 'primary') => D.workspace.reveal(rel, locationId);
export const nativeWorkspaceInspect = (rel, locationId = 'primary') => D.workspace.inspect(rel, locationId);
export const nativeWorkspaceThumbnail = (rel, size = 64, locationId = 'primary') => D.workspace.thumbnail(rel, size, locationId);
export const nativeWorkspaceWriteText = (rel, content, locationId = 'primary') => D.workspace.writeText(rel, content, locationId);
export const nativeWorkspaceSearch = (query, locationId = 'primary') => D.workspace.search(query, locationId);
export const nativeWorkspaceImportFiles = (rel = '', locationId = 'primary') => D.workspace.importFiles(rel, locationId);
export const nativeWorkspaceImportDirectory = (rel = '', locationId = 'primary') => D.workspace.importDirectory(rel, locationId);
export const nativeWorkspaceSaveAs = (rel, locationId = 'primary') => D.workspace.saveAs(rel, locationId);
// 系统原生「选择文件夹」——新建项目专用。对话框回的是这台电脑上的绝对路径，只有服务端就在这台电脑上时
// 它才认得；连远端服务端（或老壳没有这个 IPC）→ false，自动回落到选服务器上文件夹的那套选择器。
export const hasNativePickDirectory = () => Boolean(D?.app?.pickDirectory) && serverOnThisMachine();
export async function nativePickDirectory(defaultPath = '') {
  if (!hasNativePickDirectory()) return '';
  try {
    const r = await D.app.pickDirectory(defaultPath || '');
    return r && !r.canceled && r.path ? String(r.path) : '';
  } catch { return ''; }
}
// 新壳才有的三件（旧包 feature-detect 隐藏对应入口）：OS 拖入按绝对路径原生复制、最近文件、File→路径。
export const hasNativeWorkspaceDropImport = () => Boolean(D?.workspace?.importPaths && D?.workspace?.pathForFile) && serverOnThisMachine();
export const nativeWorkspaceImportPaths = (rel, paths, locationId = 'primary') => D.workspace.importPaths(rel, paths, locationId);
export const hasNativeWorkspaceRecent = () => Boolean(D?.workspace?.recent);
export const nativeWorkspaceRecent = (locationId = 'primary', limit = 50) => D.workspace.recent(locationId, limit);
// 连远端服务端时回空串：本机路径对服务器没意义，调用方（输入框附件）据此改走上传。
export const nativePathForFile = (file) => { if (!serverOnThisMachine()) return ''; try { return D?.workspace?.pathForFile?.(file) || ''; } catch { return ''; } };
// 文件夹递归大小（主进程后台统计、逐个推回）与系统剪贴板里的文件（CF_HDROP）。老壳没有 → 恒 false，
// 大小列保持「—」、复制粘贴只在面板内部生效（原行为）。
export const hasNativeDirSizes = () => Boolean(D?.workspace?.dirSizes && D?.workspace?.onDirSize);
export const nativeWorkspaceDirSizes = (payload) => D.workspace.dirSizes(payload);
export const onNativeDirSize = (fn) => (D?.workspace?.onDirSize ? D.workspace.onDirSize(fn) : () => {});
export const hasNativeFileClipboard = () => Boolean(D?.clipboard?.writeFiles && D?.clipboard?.pasteWorkspace);
export const nativeClipboardWriteFiles = (payload) => D.clipboard.writeFiles(payload);
export const nativeClipboardPasteWorkspace = (payload) => D.clipboard.pasteWorkspace(payload);
export const nativeClipboardClearOwn = () => D?.clipboard?.clearOwn?.() || Promise.resolve({ ok: false });

// viewport = 期望的逻辑视口（CSS 像素）：壳按 contain 把视图缩放居中摆进 element，
// 页面照完整视口排版后【整体缩小】，而不是被面板宽度裁掉。不传＝老行为（视图铺满）。
export async function mountNativeBrowser(targetId, element, viewport) {
  if (!D?.browser?.mount || !targetId || !element) return false;
  // 全屏浮层（文件预览/灯箱）压着时让位：原生视图是 OS 级控件，恒在 DOM 之上。
  if (nativeOverlayActive()) { unmountNativeBrowser(targetId); return false; }
  const rect = element.getBoundingClientRect();
  // 面板被藏起来（keep-alive 分页 display:none）时按【自己的 target】让位——
  // 千万别全局 unmount：那会把另一个前台面板（如 dimensio）正在展示的视图一并藏掉。
  if (rect.width < 2 || rect.height < 2) { unmountNativeBrowser(targetId); return false; }
  const vp = viewport && viewport.width > 0 && viewport.height > 0 ? { width: viewport.width, height: viewport.height } : undefined;
  // 分页休眠（.keep.dormant）矩形照旧、尺寸监听不触发：这时别挂，但照样跟着——
  // 回到分页那一帧由 trackTick 挂回来（在主页时 agent 操作浏览器推来的事件也走到这里）。
  if (!panelShown(element)) {
    unmountNativeBrowser(targetId);
    window.__bridgeNativeMount = targetId;
    trackPanel(targetId, element, vp, rect, true);
    return false;
  }
  window.__bridgeNativeMount = targetId;
  trackPanel(targetId, element, vp, rect, false);
  const result = await D.browser.mount(targetId, {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }, vp);
  return Boolean(result?.ok);
}

// —— 面板位置跟随 ——
// 原生视图是窗口里按绝对坐标摆的 OS 级控件，面板动了它不会自己跟。面板组件只在【尺寸】变化时
// 收到 ResizeObserver；拉窗口宽度（dock 贴右、整块平移）、侧栏收起、卡片换位这类「尺寸没变、
// 位置变了」的情形视图就留在原地，糊在聊天上（09-28 维护者截图）。挂着期间每帧比一次面板矩形，
// 变了就把新位置送给壳；卸载 / 换挂别的标签即停。只跟「当前挂着的」那个——同页的 dimensio
// 挂了自己的视图（window.__bridgeNativeMount 换人）就不再去抢。
// 分页休眠（keep-alive 的 .keep.dormant = content-visibility/visibility:hidden）也算看不见：
// 那种隐藏矩形不变、ResizeObserver 不触发，只靠尺寸判断会把视图留在主页上（10-20 维护者截图）。
const panelShown = (el) => !el.checkVisibility || el.checkVisibility({ visibilityProperty: true });
let tracked = null;   // { targetId, element, viewport, key, hidden, raf }
const rectKey = (r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
function trackPanel(targetId, element, viewport, rect, hidden) {
  // hidden 时 key 置空：一露面矩形必然「变了」，下一帧就挂上
  const key = hidden ? '' : rectKey(rect);
  if (tracked && tracked.element === element && tracked.targetId === targetId) {
    tracked.viewport = viewport;
    tracked.key = key;
    tracked.hidden = hidden;
    return;
  }
  stopTracking();
  tracked = { targetId, element, viewport, key, hidden, raf: 0 };
  tracked.raf = requestAnimationFrame(trackTick);
}
function stopTracking() {
  if (!tracked) return;
  cancelAnimationFrame(tracked.raf);
  tracked = null;
}
function trackTick() {
  const t = tracked;
  if (!t) return;
  if (!t.element.isConnected || window.__bridgeNativeMount !== t.targetId) { stopTracking(); return; }
  t.raf = requestAnimationFrame(trackTick);
  if (nativeOverlayActive()) return;   // 浮层压着：让位期间不挂，浮层关了面板自己会重挂
  if (!panelShown(t.element)) {
    // 分页休眠：收起视图但继续跟，回到分页时（key 已清空）下面照常挂回
    if (!t.hidden) { t.hidden = true; t.key = ''; Promise.resolve(D.browser.unmount(t.targetId)).catch(() => {}); }
    return;
  }
  t.hidden = false;
  const r = t.element.getBoundingClientRect();
  const k = rectKey(r);
  if (k === t.key) return;
  t.key = k;
  if (r.width < 2 || r.height < 2) return;   // 藏起来了：让位由面板自己的尺寸监听处理
  Promise.resolve(D.browser.mount(t.targetId, { x: r.left, y: r.top, width: r.width, height: r.height }, t.viewport)).catch(() => {});
}

// —— 浮层让位（原生视图恒在 DOM 之上）——
// 计数器挂在 window 上：bridge 与内嵌的 dimensio 是同页两套 bundle，没有 import 边，
// 共用这一个计数与 'bridge:native-overlay' 事件（dimensio 侧同款实现在
// harness/web/src/lib/nativeShell.ts）。
const OVERLAY_EVENT = 'bridge:native-overlay';
function overlayStore() {
  if (!window.__bridgeNativeOverlay) window.__bridgeNativeOverlay = { n: 0 };
  return window.__bridgeNativeOverlay;
}
export const nativeOverlayActive = () => Boolean(D) && overlayStore().n > 0;

// 打开一层浮层；返回收回函数（放进 $effect 的 cleanup，重复调用安全）。
export function pushNativeOverlay() {
  if (!D) return () => {};
  const store = overlayStore();
  store.n++;
  let released = false;
  window.dispatchEvent(new CustomEvent(OVERLAY_EVENT));
  unmountNativeBrowser();
  return () => {
    if (released) return;
    released = true;
    store.n = Math.max(0, store.n - 1);
    window.dispatchEvent(new CustomEvent(OVERLAY_EVENT));
  };
}

export function onNativeOverlayChange(fn) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(OVERLAY_EVENT, fn);
  return () => window.removeEventListener(OVERLAY_EVENT, fn);
}

// targetId 缺省 = 无条件全部隐藏（页面收尾等确知自己是唯一挂载者的场合）；
// 带 targetId = 只有当前挂载的正是它时才隐藏（后台面板的礼貌让位）。
export function unmountNativeBrowser(targetId = '') {
  if (tracked && (!targetId || tracked.targetId === targetId)) stopTracking();
  if (typeof window !== 'undefined' && (!targetId || window.__bridgeNativeMount === targetId)) window.__bridgeNativeMount = '';
  try { return D?.browser?.unmount?.(targetId); } catch { return null; }
}

// 拖出到任意应用（#8，native startDrag）。旧壳无此桥 → false，前端保持 HTML5 拖拽。
// promise resolve＝这场拖拽结束（Windows DoDragDrop 模态）——内部拖拽态清理时点。
export const hasNativeDragOut = () => Boolean(D?.drag?.workspace);
export const nativeDragPaths = (paths) => D.drag.start(paths);
export const nativeDragWorkspace = (rels, locationId = 'primary') => D.drag.workspace(rels, locationId);
// 只有 URL 的东西（Vertex 媒体等）：壳先下到临时目录再拖（新壳才有，老壳 feature-detect 不亮）。
export const hasNativeDragUrl = () => Boolean(D?.drag?.url);
export const nativeDragUrl = (url, name = '', headers = {}) => D.drag.url(url, name, headers);

// 原生「另存为」（去 web 化）：桌面壳把下载入口换成系统保存对话框。
// payload = { url, name, path }：path=产物本机绝对路径（主进程能直拷就不绕 HTTP），
// url=下载链接兜底（主进程 downloadURL + will-download 弹「另存为」）。
export const hasNativeSaveAs = () => Boolean(D?.app?.saveAs);
export const nativeSaveAs = (payload) => D.app.saveAs(payload);
// 外链交系统默认浏览器（比依赖 target=_blank 被壳兜底更显式，语义清楚）。
export const desktopOpenExternal = (url) => D?.app?.openExternal?.(url);

export const desktopUpdates = D?.updates || null;
export const desktopApp = D?.app || null;
// 窗口 chrome（frameless+WCO）：overlay 标记 + 窗控按钮配色同步。旧壳无此桥恒 null。
export const desktopChrome = D?.chrome || null;
