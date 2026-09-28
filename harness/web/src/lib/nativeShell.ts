// bridge-client / 主机台 Electron 壳的原生浏览器桥（feature-detect）。
// dimensio 前端是【原生嵌入】进 bridge 页面的（@hx 别名同窗同页），壳在场时
// window.BridgeDesktop 直接可用；独立 8799 / 手机 / 网页部署没有该对象，
// 一切保持 screencast 原路径，不引入任何桌面分支副作用。

type ShellBrowserApi = {
  browser?: {
    mount: (
      targetId: string,
      bounds: { x: number; y: number; width: number; height: number },
      viewport?: { width: number; height: number },
    ) => Promise<{ ok?: boolean } | undefined>;
    unmount: (targetId?: string) => Promise<unknown>;
  };
};

const D: ShellBrowserApi | null =
  typeof window !== "undefined" ? (((window as unknown as Record<string, unknown>).BridgeDesktop as ShellBrowserApi) ?? null) : null;

export const nativeShellBrowser = Boolean(D?.browser?.mount);

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
  trackPanel(targetId, el, vp, r);
  const res = await D.browser.mount(targetId, { x: r.left, y: r.top, width: r.width, height: r.height }, vp);
  return Boolean(res?.ok);
}

// ── 面板位置跟随（bridge 侧 web/src/lib/nativeDesktop.js 同款）──────────────────────
// 原生视图按窗口绝对坐标摆放，面板只在【尺寸】变化时收到 ResizeObserver；拉窗口宽度、侧栏收起、
// 分屏挪位这类「尺寸没变、位置变了」视图就留在原地。挂着期间每帧比一次面板矩形，变了就送新位置；
// 只跟当前挂着的那个（window.__bridgeNativeMount 被同页 bridge 面板换人即停，不去抢）。
type Tracked = { targetId: string; el: Element; viewport?: { width: number; height: number }; key: string; raf: number };
let tracked: Tracked | null = null;
const rectKey = (r: DOMRect): string => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
const win = (): Record<string, unknown> => window as unknown as Record<string, unknown>;
function mountMark(targetId: string): void {
  win().__bridgeNativeMount = targetId;
}
function trackPanel(targetId: string, el: Element, viewport: Tracked["viewport"], r: DOMRect): void {
  if (tracked && tracked.el === el && tracked.targetId === targetId) {
    tracked.viewport = viewport;
    tracked.key = rectKey(r);
    return;
  }
  stopTracking();
  tracked = { targetId, el, viewport, key: rectKey(r), raf: 0 };
  tracked.raf = requestAnimationFrame(trackTick);
}
function stopTracking(): void {
  if (!tracked) return;
  cancelAnimationFrame(tracked.raf);
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
  const k = rectKey(r);
  if (k === t.key) return;
  t.key = k;
  if (r.width < 2 || r.height < 2) return; // 藏起来了：让位由面板自己的尺寸监听处理
  Promise.resolve(D.browser.mount(t.targetId, { x: r.left, y: r.top, width: r.width, height: r.height }, t.viewport)).catch(() => {});
}

// targetId 缺省 = 无条件全部隐藏；带 targetId = 只有当前挂载的正是它时才隐藏。
export function unmountShellBrowser(targetId = ""): void {
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
  if (typeof window === "undefined" || !nativeShellBrowser) return () => {};
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

export const nativeOverlayActive = (): boolean => overlayDepth > 0;
