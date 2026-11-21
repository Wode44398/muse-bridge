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
// 「这台电脑」：连的是远端服务端时，壳的原生位置照样能列、能读、能预览（本地协议直读，不经服务器），
// 只是服务端不认识它们——工作空间的「本地」分页与侧栏「这台电脑」位置组靠它，同手机 App 的本地 SAF。
// 服务端就在这台电脑上时恒 false：那时原生位置本身就是工作空间。
export const hasPcLocalFs = () => Boolean(D?.workspace?.list && D?.workspace?.locations && D?.workspace?.fileUrl) && !serverOnThisMachine();
// 某个原生位置服务端认不认识：只有「服务端在本机 + primary（＝服务端 vaultPath）」认识；额外授权的位置、
// 以及连远端时的全部位置（这台电脑自己的盘）服务端都不认识——缩略图/转码/转 PDF/站点挂载/双链都没有，只能本地协议读原字节。
export const nativeLocLocalOnly = (locationId) => Boolean(locationId) && (locationId !== 'primary' || !serverOnThisMachine());

// opts.fresh：用户主动刷新（F5 / 右键「刷新」）时跳过主进程的列表缓存；老壳不认第三个参数，照常走缓存
export async function nativeWorkspaceList(rel = '', locationId = 'primary', opts = null) {
  if (!D?.workspace?.list) throw new Error('native workspace unavailable');
  return opts?.fresh ? D.workspace.list(rel, locationId, { fresh: true }) : D.workspace.list(rel, locationId);
}
// 离开某个位置（换位置 / 关掉文件面板）：主进程给它挂的目录监听排到最先淘汰（不当场关，别的视图还在看也无妨）。
// 老壳没有这个方法就什么都不做。
export function nativeWorkspaceRelease(locationId) {
  if (!locationId || typeof D?.workspace?.release !== 'function') return;
  try { Promise.resolve(D.workspace.release(locationId)).catch(() => {}); } catch { /* 老壳半残 */ }
}

// 调用方（cloudFileUrl）自己判断该不该走本地：服务端在本机时任何位置都行，连远端时只给「这台电脑」的位置（nativeLocLocalOnly）。
export function nativeWorkspaceFileUrl(rel = '', locationId = 'primary') {
  return D?.workspace?.fileUrl ? D.workspace.fileUrl(rel, locationId) : '';
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
// 「这台电脑」位置收 OS 拖入：拖进来的是本机文件、导进本机位置，服务端不参与——所以不看服务端在哪。
export const hasPcDropImport = () => Boolean(D?.workspace?.importPaths && D?.workspace?.pathForFile);
export const pcPathForFile = (file) => { try { return D?.workspace?.pathForFile?.(file) || ''; } catch { return ''; } };
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
// opts.snapshot()：壳没有本地截图（browser.capture，老壳）时的定格画面来源，回一个图片 URL（blob: 用完自动回收）。
export async function mountNativeBrowser(targetId, element, viewport, opts = null) {
  if (!D?.browser?.mount || !targetId || !element) return false;
  if (nativeBrowserLayered()) return attachLayered(targetId, element, viewport);
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
    trackPanel(targetId, element, vp, rect, true, opts);
    return false;
  }
  window.__bridgeNativeMount = targetId;
  const t = trackPanel(targetId, element, vp, rect, false, opts);
  // 面板此刻被别的层压着（设置页、菜单、弹窗……）：不挂，定格成截图，让开了由 trackTick 挂回。
  // 返回 true——这块面板仍是这个 target 的主人，面板收尾时照样按它让位。
  if (coveredBy(element, rect)) { freeze(t); return true; }
  if (t.frozen) { t.frozen = false; t.gen++; }
  const result = await place(t, rect);
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
let tracked = null;   // { targetId, element, viewport, opts, key, hidden, frozen, gen, n, img, raf }
const rectKey = (r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
function trackPanel(targetId, element, viewport, rect, hidden, opts) {
  // hidden 时 key 置空：一露面矩形必然「变了」，下一帧就挂上
  const key = hidden ? '' : rectKey(rect);
  if (tracked && tracked.element === element && tracked.targetId === targetId) {
    tracked.viewport = viewport;
    tracked.opts = opts;
    tracked.key = key;
    tracked.hidden = hidden;
    return tracked;
  }
  stopTracking();
  tracked = { targetId, element, viewport, opts, key, hidden, frozen: false, gen: 0, n: 0, img: null, raf: 0 };
  tracked.raf = requestAnimationFrame(trackTick);
  return tracked;
}
function stopTracking() {
  if (!tracked) return;
  cancelAnimationFrame(tracked.raf);
  clearFreeze(tracked);
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
  if (r.width < 2 || r.height < 2) return;   // 藏起来了：让位由面板自己的尺寸监听处理
  const k = rectKey(r);
  const moved = k !== t.key;
  // 遮挡隔帧查一次；要挂到新位置之前必查（别一挂上去就糊住刚弹出来的层）
  if ((++t.n & 1) || (moved && !t.frozen)) {
    const covered = Boolean(coveredBy(t.element, r));
    if (covered && !t.frozen) { freeze(t); return; }
    if (!covered && t.frozen) { t.frozen = false; t.gen++; }   // 让开了：key 在定格时已清空，下面就挂回
  }
  if (t.frozen || !moved) return;
  t.key = k;
  place(t, r);
}

// 挂到面板矩形上。圆角跟面板走（新壳按它裁视图四角，老壳不认这个字段），挂好后撤掉定格截图。
function place(t, r) {
  const radius = parseFloat(getComputedStyle(t.element).borderTopLeftRadius) || 0;
  return Promise.resolve(D.browser.mount(t.targetId, { x: r.left, y: r.top, width: r.width, height: r.height, radius }, t.viewport))
    .catch(() => null)
    .then((res) => {
      // 等一帧再撤：视图先在上面合成出来，截图在底下悄悄退场，没有空档
      if (t.img) requestAnimationFrame(() => { if (!t.frozen) clearFreeze(t); });
      return res;
    });
}

// —— 同层：被 DOM 压住就定格成截图 ——
// 原生视图是 OS 级控件，恒在整页 DOM 之上，和面板卡片根本不在一个图层：设置页、菜单、弹窗盖过来时
// 网页还顶在最上面（10-23 维护者截图：开着浏览器进设置，网页糊在设置页右半边）。
// 让每个浮层都记得 pushNativeOverlay 不现实，所以这里自己看：面板上撒一张点阵做命中测试，最上层
// 不是面板自己（或它的祖先）就算被压住——先抓一张当前画面摆进面板，再把原生视图收走，网页看起来
// 就是卡片里一张会被别的层盖住的普通画面；让开了再挂回来。pointer-events:none 的层（toast 之类）
// 命中不到，照旧被视图盖住；常驻浮在面板上、又不该让网页定格的小东西标 data-native-float。
function coveredBy(el, r) {
  const cols = Math.min(8, Math.max(3, Math.ceil(r.width / 140)));
  const rows = Math.min(8, Math.max(3, Math.ceil(r.height / 140)));
  const inset = 6;
  const dx = (r.width - inset * 2) / (cols - 1);
  const dy = (r.height - inset * 2) / (rows - 1);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const hit = document.elementFromPoint(r.left + inset + dx * j, r.top + inset + dy * i);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      if (hit.closest('[data-native-float]')) continue;
      return hit;
    }
  }
  return null;
}

function freeze(t) {
  if (t.frozen) return;
  t.frozen = true;
  t.key = '';
  const gen = ++t.gen;
  const live = () => tracked === t && t.frozen && t.gen === gen;
  // 先抓图再收视图：收在前面会先露出一两帧空面板；抓图期间视图还盖着刚弹出的层，
  // 而浮层这时多半还在淡入，几乎看不出来
  grabSnapshot(t)
    .then((url) => (live() ? showFreeze(t, url) : dropUrl(url)))
    .catch(() => {})
    .finally(() => { if (live()) Promise.resolve(D.browser.unmount(t.targetId)).catch(() => {}); });
}

// 壳的本地截图优先（主进程 capturePage，几十毫秒）；老壳退到面板给的 snapshot()；最多等 400ms，
// 抓不到就直接收视图（面板露出自己的底色）。超时后才到的图回收掉。
function grabSnapshot(t) {
  let late = false;
  const job = (async () => {
    if (D.browser.capture) {
      const r = await D.browser.capture(t.targetId);
      if (r?.ok && r.url) return r.url;
    }
    return t.opts?.snapshot ? await t.opts.snapshot() : null;
  })().catch(() => null);
  job.then((url) => { if (late) dropUrl(url); });
  return Promise.race([job, new Promise((res) => setTimeout(() => { late = true; res(null); }, 400))]);
}

async function showFreeze(t, url) {
  if (!url) return;
  const img = t.img || document.createElement('img');
  if (img.src) dropUrl(img.src);
  img.alt = '';
  img.draggable = false;
  img.dataset.nativeFreeze = '';
  // 与壳的摆位同一规则：contain 居中贴进面板；圆角随面板。不设 z-index——设了会跳出面板所在的层叠上下文、反压在浮层上面
  img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;border-radius:inherit';
  img.src = url;
  await img.decode().catch(() => {});
  if (tracked !== t || !t.frozen) { dropUrl(url); return; }
  if (getComputedStyle(t.element).position === 'static') t.element.style.position = 'relative';
  if (!img.isConnected) t.element.appendChild(img);
  t.img = img;
}

function clearFreeze(t) {
  const img = t.img;
  if (!img) return;
  t.img = null;
  img.remove();
  dropUrl(img.src);
}

// —— 同层浏览器（新壳，BridgeDesktop.browser.layered）——
// 网页由壳画进面板元素里的一块 <canvas>，就是 DOM 里的普通元素：被谁盖住、跟着卡片挪、圆角、
// 分页休眠全听 CSS。前端只要给面板打上 data-bridge-browser="<targetId>" 再 attach；
// 下面那套位置跟踪、浮层让位、被压定格都只给老壳（WebContentsView 贴在 DOM 之上）用。
export const nativeBrowserLayered = () => Boolean(D?.browser?.layered && D?.browser?.attach);
async function attachLayered(targetId, element, viewport) {
  const vp = viewport && viewport.width > 0 && viewport.height > 0 ? { width: viewport.width, height: viewport.height } : undefined;
  // 同一块面板换了标签：属性改成新 id，壳那边拆旧画布、插新画布
  if (element.getAttribute('data-bridge-browser') !== targetId) element.setAttribute('data-bridge-browser', targetId);
  window.__bridgeNativeMount = targetId;
  try { return Boolean((await D.browser.attach(targetId, vp))?.ok); } catch { return false; }
}
function detachLayered(targetId) {
  for (const el of document.querySelectorAll('[data-bridge-browser]')) {
    if (!targetId || el.getAttribute('data-bridge-browser') === targetId) el.removeAttribute('data-bridge-browser');
  }
  if (!targetId || window.__bridgeNativeMount === targetId) window.__bridgeNativeMount = '';
  try { return D.browser.detach(targetId); } catch { return null; }
}

function dropUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
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
// 同层壳里浮层天然盖在网页上面：不计数、不让位
export const nativeOverlayActive = () => Boolean(D) && !nativeBrowserLayered() && overlayStore().n > 0;

// 打开一层浮层；返回收回函数（放进 $effect 的 cleanup，重复调用安全）。
export function pushNativeOverlay() {
  if (!D || nativeBrowserLayered()) return () => {};
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
  if (nativeBrowserLayered()) return detachLayered(targetId);
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
