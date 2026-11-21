// bridge-client / 主机台 Electron 壳的原生浏览器桥（feature-detect）。
// dimensio 前端是【原生嵌入】进 bridge 页面的（@hx 别名同窗同页），壳在场时
// window.BridgeDesktop 直接可用；独立 8799 / 手机 / 网页部署没有该对象，
// 一切保持 screencast 原路径，不引入任何桌面分支副作用。

type ShellBrowserApi = {
  browser?: {
    mount: (
      targetId: string,
      bounds: { x: number; y: number; width: number; height: number; radius?: number },
      viewport?: { width: number; height: number },
    ) => Promise<{ ok?: boolean } | undefined>;
    unmount: (targetId?: string) => Promise<unknown>;
    // 新壳才有：主进程 capturePage 抓一张视图当前画面（data: URL），被 DOM 压住时定格用
    capture?: (targetId: string) => Promise<{ ok?: boolean; url?: string } | undefined>;
    // 同层壳才有：网页画进打了 data-bridge-browser 的元素里的画布（见 bridge 侧 nativeDesktop.js）
    layered?: boolean;
    attach?: (targetId: string, viewport?: { width: number; height: number }) => Promise<{ ok?: boolean } | undefined>;
    detach?: (targetId?: string) => Promise<unknown>;
  };
};

const D: ShellBrowserApi | null =
  typeof window !== "undefined" ? (((window as unknown as Record<string, unknown>).BridgeDesktop as ShellBrowserApi) ?? null) : null;

export const nativeShellBrowser = Boolean(D?.browser?.mount);
// 同层壳：网页是面板里的一块画布（DOM 元素），层级 / 裁切 / 休眠全听 CSS，下面的跟踪、让位、定格都只给老壳用
const layered = Boolean(D?.browser?.layered && D?.browser?.attach);

// 把真 WebContentsView 精确盖到 el 的位置上。el 被藏起来（分页切走）时按
// 【自己的 target】让位——不全局 unmount，免得把别的面板正在展示的视图藏掉。
// viewport = 期望的逻辑视口（CSS 像素，与 /api/browser 的 viewport 同源）：壳会把
// 视图按 contain 缩放居中摆进 el，页面照 1280×900 这类完整视口排版后整体缩小，
// 而不是被面板宽度裁掉（旧行为：帧被钉在左上角、右侧留黑、横向滚动条）。
export async function mountShellBrowser(
  targetId: string,
  el: Element,
  viewport?: { width: number; height: number },
): Promise<boolean> {
  if (!D?.browser?.mount || !targetId || !el) return false;
  if (layered) {
    const vp = viewport && viewport.width > 0 && viewport.height > 0 ? { width: viewport.width, height: viewport.height } : undefined;
    if (el.getAttribute("data-bridge-browser") !== targetId) el.setAttribute("data-bridge-browser", targetId);
    mountMark(targetId);
    try {
      return Boolean((await D.browser.attach!(targetId, vp))?.ok);
    } catch {
      return false;
    }
  }
  if (overlayDepth > 0) {
    // 有全屏浮层压在上面：原生视图是 OS 级控件，永远盖在 DOM 之上，此刻挂上去
    // 就会把预览/弹层糊住（旧行为）。让位，等浮层关掉再由订阅者重挂。
    unmountShellBrowser(targetId);
    return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) {
    unmountShellBrowser(targetId);
    return false;
  }
  const vp = viewport && viewport.width > 0 && viewport.height > 0 ? { width: viewport.width, height: viewport.height } : undefined;
  mountMark(targetId);
  const t = trackPanel(targetId, el, vp, r);
  // 面板此刻被别的层压着（设置页、菜单、弹窗……）：不挂，定格成截图，让开了由 trackTick 挂回
  if (coveredBy(el, r)) {
    freeze(t);
    return true;
  }
  if (t.frozen) {
    t.frozen = false;
    t.gen++;
  }
  const res = await place(t, r);
  return Boolean(res?.ok);
}

// ── 面板位置跟随（bridge 侧 web/src/lib/nativeDesktop.js 同款）──────────────────────
// 原生视图按窗口绝对坐标摆放，面板只在【尺寸】变化时收到 ResizeObserver；拉窗口宽度、侧栏收起、
// 分屏挪位这类「尺寸没变、位置变了」视图就留在原地。挂着期间每帧比一次面板矩形，变了就送新位置；
// 只跟当前挂着的那个（window.__bridgeNativeMount 被同页 bridge 面板换人即停，不去抢）。
type Tracked = {
  targetId: string;
  el: Element;
  viewport?: { width: number; height: number };
  key: string;
  frozen: boolean;
  gen: number;
  n: number;
  img: HTMLImageElement | null;
  raf: number;
};
let tracked: Tracked | null = null;
const rectKey = (r: DOMRect): string => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
const win = (): Record<string, unknown> => window as unknown as Record<string, unknown>;
function mountMark(targetId: string): void {
  win().__bridgeNativeMount = targetId;
}
function trackPanel(targetId: string, el: Element, viewport: Tracked["viewport"], r: DOMRect): Tracked {
  if (tracked && tracked.el === el && tracked.targetId === targetId) {
    tracked.viewport = viewport;
    tracked.key = rectKey(r);
    return tracked;
  }
  stopTracking();
  tracked = { targetId, el, viewport, key: rectKey(r), frozen: false, gen: 0, n: 0, img: null, raf: 0 };
  tracked.raf = requestAnimationFrame(trackTick);
  return tracked;
}
function stopTracking(): void {
  if (!tracked) return;
  cancelAnimationFrame(tracked.raf);
  clearFreeze(tracked);
  tracked = null;
}
function trackTick(): void {
  const t = tracked;
  if (!t || !D?.browser) return;
  if (!t.el.isConnected || win().__bridgeNativeMount !== t.targetId) {
    stopTracking();
    return;
  }
  t.raf = requestAnimationFrame(trackTick);
  if (overlayDepth > 0) return; // 浮层压着：让位期间不挂，浮层关了面板自己会重挂
  const r = t.el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return; // 藏起来了：让位由面板自己的尺寸监听处理
  const k = rectKey(r);
  const moved = k !== t.key;
  // 遮挡隔帧查一次；要挂到新位置之前必查
  if (++t.n & 1 || (moved && !t.frozen)) {
    const covered = coveredBy(t.el, r);
    if (covered && !t.frozen) {
      freeze(t);
      return;
    }
    if (!covered && t.frozen) {
      t.frozen = false; // 让开了：key 在定格时已清空，下面就挂回
      t.gen++;
    }
  }
  if (t.frozen || !moved) return;
  t.key = k;
  void place(t, r);
}

// 挂到面板矩形上；圆角跟面板走（新壳按它裁视图四角），挂好后撤掉定格截图
function place(t: Tracked, r: DOMRect): Promise<{ ok?: boolean } | undefined | null> {
  if (!D?.browser) return Promise.resolve(null);
  const radius = parseFloat(getComputedStyle(t.el).borderTopLeftRadius) || 0;
  return Promise.resolve(D.browser.mount(t.targetId, { x: r.left, y: r.top, width: r.width, height: r.height, radius }, t.viewport))
    .catch(() => null)
    .then((res) => {
      if (t.img)
        requestAnimationFrame(() => {
          if (!t.frozen) clearFreeze(t);
        });
      return res;
    });
}

// ── 同层：被 DOM 压住就定格成截图（bridge 侧 nativeDesktop.js 同款）──────────────────
// 原生视图恒在整页 DOM 之上：设置页、菜单、弹窗盖过来时网页还顶在最上面。面板上撒点阵做命中测试，
// 最上层不是面板自己（或祖先）就算被压住——先抓一张当前画面摆进面板，再收走原生视图；让开了再挂回。
// 常驻浮在面板上、又不该让网页定格的小东西标 data-native-float。
function coveredBy(el: Element, r: DOMRect): boolean {
  const cols = Math.min(8, Math.max(3, Math.ceil(r.width / 140)));
  const rows = Math.min(8, Math.max(3, Math.ceil(r.height / 140)));
  const inset = 6;
  const dx = (r.width - inset * 2) / (cols - 1);
  const dy = (r.height - inset * 2) / (rows - 1);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const hit = document.elementFromPoint(r.left + inset + dx * j, r.top + inset + dy * i);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      if (hit.closest("[data-native-float]")) continue;
      return true;
    }
  }
  return false;
}

function freeze(t: Tracked): void {
  if (t.frozen || !D?.browser) return;
  const browser = D.browser;
  t.frozen = true;
  t.key = "";
  const gen = ++t.gen;
  const live = (): boolean => tracked === t && t.frozen && t.gen === gen;
  // 先抓图再收视图：反过来会先露出一两帧空面板
  grabSnapshot(t.targetId)
    .then((url) => (live() ? showFreeze(t, url) : undefined))
    .catch(() => {})
    .finally(() => {
      if (live()) Promise.resolve(browser.unmount(t.targetId)).catch(() => {});
    });
}

// 只有新壳有本地截图（browser.capture）；老壳抓不到就直接收视图，面板露出自己的底色。最多等 400ms。
function grabSnapshot(targetId: string): Promise<string | null> {
  const capture = D?.browser?.capture;
  if (!capture) return Promise.resolve(null);
  const job = Promise.resolve(capture(targetId))
    .then((r) => (r?.ok && r.url ? r.url : null))
    .catch(() => null);
  return Promise.race([job, new Promise<null>((res) => setTimeout(() => res(null), 400))]);
}

async function showFreeze(t: Tracked, url: string | null): Promise<void> {
  if (!url) return;
  const img = t.img ?? document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.dataset.nativeFreeze = "";
  img.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;border-radius:inherit";
  img.src = url;
  await img.decode().catch(() => {});
  if (tracked !== t || !t.frozen) return;
  const host = t.el as HTMLElement;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  if (!img.isConnected) host.appendChild(img);
  t.img = img;
}

function clearFreeze(t: Tracked): void {
  const img = t.img;
  if (!img) return;
  t.img = null;
  img.remove();
}

// targetId 缺省 = 无条件全部隐藏；带 targetId = 只有当前挂载的正是它时才隐藏。
export function unmountShellBrowser(targetId = ""): void {
  if (layered) {
    for (const el of document.querySelectorAll("[data-bridge-browser]")) {
      if (!targetId || el.getAttribute("data-bridge-browser") === targetId) el.removeAttribute("data-bridge-browser");
    }
    if (!targetId || win().__bridgeNativeMount === targetId) win().__bridgeNativeMount = "";
    void D?.browser?.detach?.(targetId)?.catch?.(() => {});
    return;
  }
  if (tracked && (!targetId || tracked.targetId === targetId)) stopTracking();
  if (typeof window !== "undefined" && (!targetId || win().__bridgeNativeMount === targetId)) win().__bridgeNativeMount = "";
  try {
    void D?.browser?.unmount?.(targetId);
  } catch {
    /* 壳已退出等 */
  }
}

// ── 浮层让位（原生视图恒在 DOM 之上）────────────────────────────────────────
// 文件预览、设置弹层、灯箱……只要盖住画面就得让原生视图先下去。计数器挂在 window
// 上：宿主 bridge 与 dimensio 是同页两套 bundle，没有 import 边，共用这一个计数与
// 'bridge:native-overlay' 事件（bridge 侧同款实现在 web/src/lib/nativeDesktop.js）。
const OVERLAY_EVENT = "bridge:native-overlay";
const store = (): { n: number } => {
  const w = window as unknown as Record<string, unknown>;
  if (!w.__bridgeNativeOverlay) w.__bridgeNativeOverlay = { n: 0 };
  return w.__bridgeNativeOverlay as { n: number };
};
let overlayDepth = typeof window !== "undefined" ? store().n : 0;
if (typeof window !== "undefined") {
  window.addEventListener(OVERLAY_EVENT, () => (overlayDepth = store().n));
}

// 打开一层浮层；返回收回函数（放进 $effect 的 cleanup 即可，重复调用安全）。
export function pushNativeOverlay(): () => void {
  if (typeof window === "undefined" || !nativeShellBrowser || layered) return () => {};
  const s = store();
  s.n++;
  let released = false;
  window.dispatchEvent(new CustomEvent(OVERLAY_EVENT));
  unmountShellBrowser();
  return () => {
    if (released) return;
    released = true;
    s.n = Math.max(0, s.n - 1);
    window.dispatchEvent(new CustomEvent(OVERLAY_EVENT));
  };
}

// 浮层层数变化时回调（面板据此重新挂载/让位）。
export function onNativeOverlayChange(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(OVERLAY_EVENT, fn);
  return () => window.removeEventListener(OVERLAY_EVENT, fn);
}

export const nativeOverlayActive = (): boolean => !layered && overlayDepth > 0;
