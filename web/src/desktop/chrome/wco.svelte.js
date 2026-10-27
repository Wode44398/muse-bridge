// 窗口 chrome（frameless + WCO）前端侧工具（响应式）。全部 feature-detect：
// 旧壳 / 网页 / Android 没有 BridgeDesktop.chrome.overlay 标记时一切回 0/false，
// 调用方不需要自己判断环境。
// WCO 几何在文档解析早期常为 visible=false / rect=0——模块级监听 geometrychange，
// 用 $state tick 让所有读几何的 derived（如登录 pill 避让）自动重算。
import { desktopChrome } from '../../lib/nativeDesktop.js';

let tick = $state(0);
// 几何 → 全局 CSS 变量（app.css 的各分页右上避让规则统一消费）：
// --wco-h=标题栏带高、--wco-right=右上被系统窗控按钮占掉的宽度。
function syncVars() {
  try {
    const r = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    const right = r?.width ? Math.max(0, Math.round(window.innerWidth - (r.x + r.width))) : 0;
    document.documentElement.style.setProperty('--wco-h', (r?.height ? Math.round(r.height) : 40) + 'px');
    document.documentElement.style.setProperty('--wco-right', right + 'px');
  } catch {}
}
// 坑（Electron 42 实测）：窗口改宽时 geometrychange 先到、innerWidth 还是旧值——变宽（最大化/拖宽/贴边）
// 算出负数被夹成 0，工具组整组压到系统窗控底下；变窄则多让出一大截。随后的 resize 才拿到新视口，
// 所以两个事件都要听，以 resize 那次为准。
if (typeof navigator !== 'undefined' && desktopChrome?.overlay && navigator.windowControlsOverlay) {
  const onGeom = () => { tick++; syncVars(); };
  navigator.windowControlsOverlay.addEventListener('geometrychange', onGeom);
  window.addEventListener('resize', onGeom);
  syncVars();
}

export const wcoActive = () => Boolean(desktopChrome?.overlay);

// 标题栏带高（与壳 main.cjs 的 WCO_HEIGHT 一致；titlebarAreaRect 拿得到就用真值）。
export function wcoHeight() {
  if (!wcoActive()) return 0;
  void tick;
  try {
    const r = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    if (r?.height) return Math.round(r.height);
  } catch {}
  return 40;
}

// 右上被系统窗控按钮占掉的宽度（px）。titlebarAreaRect 是「可自绘区域」，
// 它的右边界到窗口右缘之间就是最小化/最大化/关闭三颗原生按钮。
export function wcoRightInset() {
  if (!wcoActive()) return 0;
  void tick;
  try {
    const r = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
    if (!r || !r.width) return 0;
    return Math.max(0, Math.round(window.innerWidth - (r.x + r.width)));
  } catch { return 0; }
}

// 同步窗控按钮配色（glyph 色 + 按钮条底色，底色带 alpha=透明悬浮）。
export function setOverlayColors(opts) {
  try { desktopChrome?.setOverlay?.(opts); } catch {}
}
