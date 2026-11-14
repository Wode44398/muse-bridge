// 文档查看器的指针手势（PDF / 转 PDF 的 Office 共用）：
//   · 触屏双指捏合：捏的过程只改 CSS transform（以起点中点为锚、两指平移跟手），松手后由调用方按倍率真正重排、重渲，
//     并把同一个内容点放回松手时的中点下——整段手势和收尾是一段连续运动，不白闪、不跳。
//   · 触屏双击：调用方在「适应宽度」与「放大」之间切换（按点击处为锚）。
//   · 触屏横滑：只在 canSwipe() 为真时（幻灯片一页一屏、页面没有横向溢出）识别成翻页。
//   · 电脑 Ctrl + 滚轮 / 触控板捏合（浏览器把它报成 ctrlKey 的 wheel）：以光标为锚缩放。
// 单指滚动仍交给浏览器原生滚动（容器 touch-action: pan-x pan-y），这里只在两指时、以及已认定为翻页横滑时 preventDefault，
// 所以不会和浏览器自己的页面缩放打架（viewport 已 user-scalable=no，容器也不含 pinch-zoom）。

const TAP_MS = 320, TAP_SLOP = 32, MOVE_SLOP = 10;
const SWIPE_MS = 600, SWIPE_MIN = 56;

/**
 * @param {HTMLElement} el 滚动容器
 * @param {{
 *   pinchTarget?: () => HTMLElement | null,           // 捏合时做 CSS 变换的元素（缺省不预览，只在松手时缩放）
 *   onPinchStart?: (p: {cx:number, cy:number}) => void,
 *   onPinchEnd?: (p: {factor:number, x0:number, y0:number, cx:number, cy:number}) => void,
 *   clampFactor?: (f:number) => number,               // 把捏合倍率夹在允许的缩放范围里（按当前比例换算）
 *   onWheelZoom?: (p: {factor:number, cx:number, cy:number}) => void,
 *   onDoubleTap?: (p: {cx:number, cy:number}) => void,
 *   canSwipe?: () => boolean,
 *   onSwipe?: (dir: 1 | -1) => void,
 * }} h
 * @returns {() => void} 卸载
 */
export function attachGestures(el, h = {}) {
  let pinch = null;          // { d0, x0, y0, r0, target, f, cx, cy }
  let one = null;            // 单指：{ x, y, t, moved }
  let lastTap = null;        // { x, y, t }
  const ac = new AbortController();
  const opt = { passive: false, signal: ac.signal };

  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;

  function startPinch(e) {
    const [a, b] = e.touches;
    const m = mid(a, b);
    const target = h.pinchTarget?.() || null;
    pinch = { d0: dist(a, b), x0: m.x, y0: m.y, cx: m.x, cy: m.y, f: 1, target, r0: target?.getBoundingClientRect() || null, ovf: el.style.overflow };
    // 捏合期间锁住原生滚动：否则两指一挪，浏览器把它当拖动滚走，transform 预览和滚动位置对不上
    el.style.overflow = 'hidden';
    if (target) { target.style.transformOrigin = '0 0'; target.style.willChange = 'transform'; }
    one = null; lastTap = null;
    h.onPinchStart?.({ cx: m.x, cy: m.y });
  }

  function movePinch(e) {
    const [a, b] = e.touches;
    const m = mid(a, b);
    let f = dist(a, b) / pinch.d0;
    if (h.clampFactor) f = h.clampFactor(f);
    pinch.f = f; pinch.cx = m.x; pinch.cy = m.y;
    const { target, r0 } = pinch;
    if (!target || !r0) return;
    // 起点中点下的内容点 p（元素局部坐标）在缩放 f 后落到当前中点 m：T = m - r0 - f·(m0 - r0)
    const tx = m.x - r0.left - f * (pinch.x0 - r0.left);
    const ty = m.y - r0.top - f * (pinch.y0 - r0.top);
    target.style.transform = `translate(${tx}px, ${ty}px) scale(${f})`;
  }

  function endPinch() {
    const p = pinch;
    pinch = null;
    el.style.overflow = p.ovf || '';
    // 清变换与真正缩放必须在同一个任务里：中间若让浏览器画一帧，会先跳回原尺寸再跳到新尺寸
    if (p.target) { p.target.style.transform = ''; p.target.style.transformOrigin = ''; p.target.style.willChange = ''; }
    h.onPinchEnd?.({ factor: p.f, x0: p.x0, y0: p.y0, cx: p.cx, cy: p.cy });
  }

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { e.preventDefault(); startPinch(e); return; }
    if (e.touches.length > 2) return;
    const t = e.touches[0];
    one = { x: t.clientX, y: t.clientY, t: e.timeStamp, moved: false };
  }, opt);

  el.addEventListener('touchmove', (e) => {
    if (pinch) {
      if (e.touches.length >= 2) { e.preventDefault(); movePinch(e); }
      return;
    }
    if (one && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - one.x, dy = t.clientY - one.y;
      if (!one.moved && (Math.abs(dx) > MOVE_SLOP || Math.abs(dy) > MOVE_SLOP)) {
        one.moved = true;
        // 出了防抖圈就定轴：横向且此刻能翻页 → 这一下归翻页，拦下浏览器自己的横向平移 / 侧滑历史导航
        // （不拦的话，触屏浏览器把「右滑」当成「后退」，history 哨兵一弹就把整个查看器关了）；竖向照常交给原生滚动
        one.axis = h.onSwipe && Math.abs(dx) > Math.abs(dy) && (h.canSwipe?.() ?? true) ? 'x' : 'y';
      }
      if (one.axis === 'x' && e.cancelable) e.preventDefault();
    }
  }, opt);

  const onEnd = (e) => {
    if (pinch) {
      if (e.touches.length < 2) endPinch();
      return;
    }
    if (!one || e.touches.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - one.x, dy = t.clientY - one.y, dt = e.timeStamp - one.t;
    const s = one;
    one = null;
    if (e.type === 'touchcancel') return;
    // 横滑翻页
    if (h.onSwipe && dt < SWIPE_MS && Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > 1.6 * Math.abs(dy) && (h.canSwipe?.() ?? true)) {
      lastTap = null;
      h.onSwipe(dx < 0 ? 1 : -1);
      return;
    }
    if (s.moved || dt > TAP_MS) { lastTap = null; return; }
    // 点按：和上一次点按足够近 = 双击
    if (lastTap && e.timeStamp - lastTap.t < TAP_MS && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < TAP_SLOP) {
      lastTap = null;
      // 文本层上双击默认会选词；这里吃掉它的补发 click / 选区
      if (e.cancelable) e.preventDefault();
      h.onDoubleTap?.({ cx: t.clientX, cy: t.clientY });
      return;
    }
    lastTap = { x: t.clientX, y: t.clientY, t: e.timeStamp };
  };
  el.addEventListener('touchend', onEnd, opt);
  el.addEventListener('touchcancel', onEnd, opt);

  // Ctrl + 滚轮 / 触控板捏合：一格鼠标滚轮 ≈ ±10%，触控板的小增量按指数连续换算（手感与 Chrome / Acrobat 一致）
  el.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !h.onWheelZoom) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
    if (!dy) return;
    const factor = Math.abs(dy) >= 50 ? (dy < 0 ? 1.1 : 1 / 1.1) : Math.exp(-dy / 100);
    h.onWheelZoom({ factor, cx: e.clientX, cy: e.clientY });
  }, opt);

  return () => {
    if (pinch) { el.style.overflow = pinch.ovf || ''; if (pinch.target) pinch.target.style.transform = ''; }
    ac.abort();
  };
}
