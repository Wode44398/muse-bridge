// Media Studio v3 的动效令牌（方案 §9.2「动效」）：照抄 dimensio 的 harness/web/src/lib/motion.ts
// （阻尼谐振子解析解 → CSS linear()，JS 缓动同源；soft / spring / pop / snap 四档 + rise / pop / fade / slide 过渡）。
// Studio 是扩展分块，不许 import @hx（构建 leaks 必须为空），所以数值和算法拷过来，改了那边要同步这边。
//
// 只动 transform / opacity；进场弹簧、退场 120–220ms ease-in；prefers-reduced-motion 只留透明度。
// 另外认 bridge 的「关掉入场动画」偏好（prefs.noEnterAnim）：调用方传 off。

function springAt(zeta, omega, t) {
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-omega * t) * (1 + omega * t);
}
function makeSpring(zeta, settle, samples = 44) {
  const omega = 4 / (zeta * settle);
  const ease = (p) => (p >= 1 ? 1 : p <= 0 ? 0 : springAt(zeta, omega, p * settle));
  const pts = [];
  for (let i = 0; i <= samples; i++) pts.push(String(Math.round((i === samples ? 1 : ease(i / samples)) * 10000) / 10000));
  return { ms: Math.round(settle * 1000), css: `linear(${pts.join(', ')})`, ease };
}

// 柔：几乎不过冲（面板、抽屉、sheet、列表条目）
export const SPRING_SOFT = makeSpring(0.9, 0.42);
// 标准：≈4% 回弹（菜单、卡片、形变）
export const SPRING = makeSpring(0.72, 0.5);
// 弹跳：≈9%（只给小东西：徽标、勾、状态点）
export const SPRING_POP = makeSpring(0.6, 0.56);
// 快：260ms 就停、几乎不过冲（跟手的选中块：分段控件）
export const SPRING_SNAP = makeSpring(0.9, 0.26);

const FALLBACK = { soft: 'cubic-bezier(.2,.9,.25,1)', std: 'cubic-bezier(.3,1.25,.4,1)', pop: 'cubic-bezier(.34,1.5,.5,1)' };
let linearOk = null;
function supportsLinear() {
  if (linearOk === null) {
    try { linearOk = typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)'); } catch { linearOk = false; }
  }
  return linearOk;
}
/** 给 WAAPI 用的缓动串（它不解析 CSS 变量） */
export function springEasing(s = SPRING_SOFT) {
  if (supportsLinear()) return s.css;
  return s === SPRING_POP ? FALLBACK.pop : s === SPRING ? FALLBACK.std : FALLBACK.soft;
}
/** 写到 .studio-root 上的动效令牌（style 属性） */
export function motionStyle() {
  const ok = supportsLinear();
  const v = {
    '--sd-spring': ok ? SPRING.css : FALLBACK.std,
    '--sd-spring-soft': ok ? SPRING_SOFT.css : FALLBACK.soft,
    '--sd-spring-pop': ok ? SPRING_POP.css : FALLBACK.pop,
    '--sd-spring-snap': ok ? SPRING_SNAP.css : FALLBACK.soft,
    '--sd-t-spring': SPRING.ms + 'ms',
    '--sd-t-spring-soft': SPRING_SOFT.ms + 'ms',
    '--sd-t-spring-pop': SPRING_POP.ms + 'ms',
    '--sd-t-spring-snap': SPRING_SNAP.ms + 'ms',
  };
  return Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';');
}

export function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
// 关动画总闸：系统减弱动效 / bridge 偏好「关掉入场动画」（StudioPage 把 .sd-noanim 挂在根上）
const quiet = (node) => reducedMotion() || !!node?.closest?.('.sd-noanim');

const easeIn = (t) => t * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 浮起：透明 + 下沉 y + 轻缩放 → 原位（列表条目、卡片、提示） */
export function rise(node, { y = 8, scale = 1, delay = 0, out = 150 } = {}, opts = {}) {
  const leaving = opts.direction === 'out';
  if (quiet(node)) return { delay, duration: leaving ? 90 : 140, css: (t) => `opacity:${clamp01(t)}` };
  return {
    delay,
    duration: leaving ? out : SPRING_SOFT.ms,
    easing: leaving ? easeIn : SPRING_SOFT.ease,
    css: (t, u) => {
      const sc = scale === 1 ? '' : ` scale(${(1 - (1 - scale) * u).toFixed(4)})`;
      return `opacity:${leaving ? clamp01(t) : Math.min(1, t * 1.6)};transform:translateY(${(u * y).toFixed(2)}px)${sc}`;
    },
  };
}
/** 弹出：从 transform-origin 缩放 + 透明（菜单、浮层、提示）；origin 由调用方 CSS 给 */
export function pop(node, { from = 0.94, out = 130 } = {}, opts = {}) {
  const leaving = opts.direction === 'out';
  if (quiet(node)) return { duration: leaving ? 80 : 120, css: (t) => `opacity:${clamp01(t)}` };
  return {
    duration: leaving ? out : SPRING.ms,
    easing: leaving ? easeIn : SPRING.ease,
    css: (t, u) => `opacity:${clamp01(t * 1.8)};transform:scale(${(1 - (1 - from) * u).toFixed(4)})`,
  };
}
/** 淡：只动透明度 */
export function fade(node, { duration = 180 } = {}, opts = {}) {
  const leaving = opts.direction === 'out';
  return { duration: leaving ? Math.round(duration * 0.7) : duration, easing: leaving ? easeIn : easeOutCubic, css: (t) => `opacity:${t}` };
}
/** 滑入：sheet 从下（柔弹簧进、ease-in 出） */
export function slideUp(node, { out = 200, skip = () => false } = {}, opts = {}) {
  const leaving = opts.direction === 'out';
  if (leaving && skip()) return { duration: 0 };
  if (quiet(node)) return { duration: leaving ? 100 : 160, css: (t) => `opacity:${clamp01(t)}` };
  const d = node.getBoundingClientRect().height + 24;
  return {
    duration: leaving ? out : SPRING_SOFT.ms + 60,
    easing: leaving ? easeIn : SPRING_SOFT.ease,
    css: (_t, u) => `transform:translateY(${(u * d).toFixed(1)}px)`,
  };
}
