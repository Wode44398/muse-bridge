// 液态玻璃 · 动画内核（「怎么动」＝ iOS 26 交互复刻）
// 数值全部照搬两个开源项目的源码（移植自样稿 bridge build/bridge前端设计/液态玻璃组件样稿/lg-core.js）：
//   Kyant0/AndroidLiquidGlass  catalog/utils/DampedDragAnimation.kt、InteractiveHighlight.kt、components/*.kt
//   sdegenaar/liquid_glass_widgets 1.17.0  lib/utils/liquid_morph_physics.dart、glass_morph_controller.dart
// 「长什么样」（尺寸、颜色、玻璃材质）不在这里：kit.js（Apple iOS 27 UI Kit 原数据）+ glass.js。
import { reduced } from '../motion.js';

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const reduceMotion = () => reduced();

/* ---------- 弹簧：Compose spring(dampingRatio, stiffness)，质量 1 ---------- */
export class Spring {
  constructor(x, z, k) { this.x = x; this.t = x; this.v = 0; this.z = z; this.k = k; }
  step(dt) {
    const c = 2 * Math.sqrt(this.k) * this.z;
    this.v += (-this.k * (this.x - this.t) - c * this.v) * dt;
    this.x += this.v * dt;
  }
  snap(x) { this.x = this.t = x; this.v = 0; }
  get idle() { return Math.abs(this.x - this.t) < 1e-4 && Math.abs(this.v) < 1e-3; }
}
// Flutter SpringDescription(mass 1, stiffness k, damping c)
export const flutterSpring = (x, k, c) => new Spring(x, c / (2 * Math.sqrt(k)), k);
// Flutter SpringDescription.withDurationAndBounce：k = (2π/d)²，ζ = 1 − bounce（bounce < 0 时 1/(1+bounce)）
export const durSpring = (x, d, bounce) => new Spring(x, bounce > 0 ? 1 - bounce : 1 / (1 + bounce), (2 * Math.PI / d) ** 2);

/* ---------- DampedDragAnimation（Kyant0 原参数） ----------
   value spring(1, 1000)、velocity spring(0.5, 300)、press spring(1, 1000)、scaleX spring(0.6, 250)、scaleY spring(0.7, 250)。
   Kyant 的 pressedScale 是一个数；这里按 kit 的静止 / 按下两个尺寸分别给 X、Y 目标，弹簧参数不变。
   updateValue（拖动）：VelocityTracker 跟踪速度（量程/秒）；animateToValue（点按、键盘）：按下 → 滑过去 → 到位松开，不跟踪速度。
   release：等 value 进到目标 2.5% 以内才收回按下与放大。 */
export class Damped {
  constructor(v, max = 1, pressed = [1.5, 1.5]) {
    this.max = max;
    this.pressedScale = pressed;
    this.value = new Spring(v, 1, 1000);
    this.vel = new Spring(0, .5, 300);
    this.press = new Spring(0, 1, 1000);
    this.sx = new Spring(1, .6, 250);
    this.sy = new Spring(1, .7, 250);
    this.tracking = false;
    this.pendingRelease = false;
    this.samples = [];
    this.clock = 0;
  }
  doPress() { this.pendingRelease = false; this.samples = []; this.press.t = 1; this.sx.t = this.pressedScale[0]; this.sy.t = this.pressedScale[1]; }
  doRelease() { this.pendingRelease = true; }
  updateValue(v) { this.value.t = clamp(v, 0, this.max); this.tracking = true; }
  animateToValue(v) { this.doPress(); this.value.t = clamp(v, 0, this.max); this.tracking = false; this.vel.t = 0; this.doRelease(); }
  snapTo(v) { this.value.snap(clamp(v, 0, this.max)); this.vel.snap(0); this.tracking = false; }
  step(dt) {
    this.clock += dt;
    this.value.step(dt); this.press.step(dt); this.sx.step(dt); this.sy.step(dt);
    const moving = Math.abs(this.value.x - this.value.t) > 1e-4 || Math.abs(this.value.v) > 1e-3;
    if (this.tracking && moving) {
      // Compose VelocityTracker：最近 100ms 的样本做回归（原版二次拟合，这里一次线性回归）
      this.samples.push([this.clock, this.value.x]);
      while (this.samples.length > 2 && this.clock - this.samples[0][0] > .1) this.samples.shift();
      this.vel.t = regressSlope(this.samples) / this.max;
    } else if (this.tracking) {
      // 数值停住后跟踪器只会看到静止的样本，速度归 0（否则拉伸停在最后一个斜率上、控件永不休眠）
      this.vel.t = 0; this.samples = [];
    }
    this.vel.step(dt);
    if (this.pendingRelease && Math.abs(this.value.x - this.value.t) < .025 * this.max) {
      this.pendingRelease = false; this.press.t = 0; this.sx.t = this.sy.t = 1;
    }
  }
  get idle() { return !this.pendingRelease && [this.value, this.vel, this.press, this.sx, this.sy].every((s) => s.idle); }
}
function regressSlope(s) {
  const n = s.length; if (n < 2) return 0;
  let mt = 0, mv = 0; for (const [t, v] of s) { mt += t; mv += v; } mt /= n; mv /= n;
  let num = 0, den = 0; for (const [t, v] of s) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
  return den ? num / den : 0;
}

/* Kyant layerBlock 的速度拉伸：scaleX /= 1 − clamp(v·0.75, ±0.2)；scaleY *= 1 − clamp(v·0.25, ±0.2) */
export const stretch = (sx, sy, v) => [sx / (1 - clamp(v * .75, -.2, .2)), sy * (1 - clamp(v * .25, -.2, .2))];

/* ---------- 曲线 ---------- */
export const cubic = (x1, y1, x2, y2) => (x) => {
  if (x <= 0) return 0; if (x >= 1) return 1;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 26; i++) {
    t = (lo + hi) / 2;
    const bx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    if (bx < x) lo = t; else hi = t;
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
};
export const composeEaseOut = cubic(0, 0, .58, 1);          // Compose EaseOut
export const linearToEaseOut = cubic(.35, .91, .33, .97);    // Flutter Curves.linearToEaseOut
export const easeInExpo = cubic(.95, .05, .795, .035);       // Flutter Curves.easeInExpo
export const flutterEaseOut = cubic(.25, .1, .25, 1);        // Flutter Curves.easeOut
export const easeOutCubic = cubic(.215, .61, .355, 1);       // Flutter Curves.easeOutCubic

/* ---------- 颜色：Compose 的 lerp(Color, Color) 在 Oklab 里插值（含 alpha） ---------- */
const toLin = (c) => (c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4));
const toSrgb = (c) => (c <= .0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - .055);
export const oklab = ([r, g, b, a = 1]) => {
  r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .7936177850 * m - .0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .8086757660 * s, a];
};
export const fromOklab = ([L, A, B, a]) => {
  const l = (L + .3963377774 * A + .2158037573 * B) ** 3;
  const m = (L - .1055613458 * A - .0638541728 * B) ** 3;
  const s = (L - .0894841775 * A - 1.2914855480 * B) ** 3;
  const ch = (v) => Math.round(clamp(toSrgb(clamp(v, 0, 1)), 0, 1) * 255);
  return `rgba(${ch(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s)},${ch(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s)},${ch(-.0041960863 * l - .7034186147 * m + 1.7076147010 * s)},${clamp(a, 0, 1).toFixed(4)})`;
};
export const lerpOklab = (A, B, t) => fromOklab(A.map((v, i) => lerp(v, B[i], t)));
// 任意 CSS 颜色（#hex、rgb()、rgba()、颜色名）→ [r, g, b, a]（0–1）：交给 2D 画布规整成 #rrggbb / rgba(...)
let pc = null;
export function parseColor(str, fallback = [1, 1, 1, 1]) {
  const s = String(str || '').trim();
  if (!s) return fallback;
  if (!pc) pc = document.createElement('canvas').getContext('2d');
  pc.fillStyle = '#010203'; pc.fillStyle = s;
  const v = String(pc.fillStyle);
  if (v === '#010203' && !/^#010203$/i.test(s)) return fallback;   // 不认识的写法
  if (v[0] === '#') return [parseInt(v.slice(1, 3), 16) / 255, parseInt(v.slice(3, 5), 16) / 255, parseInt(v.slice(5, 7), 16) / 255, 1];
  const m = v.match(/[\d.]+/g) || [];
  return [(+m[0] || 0) / 255, (+m[1] || 0) / 255, (+m[2] || 0) / 255, m[3] != null ? +m[3] : 1];
}
// 读元素上的 CSS 自定义属性（已代入 var()）成 [r, g, b, a]
export const cssVarColor = (el, name, fallback) => parseColor(getComputedStyle(el).getPropertyValue(name), fallback);

/* ---------- 帧循环：只在有控件动着时排 rAF，全部停稳就不再跑（被盖住 / 静止的页面零开销） ----------
   控件对象：step(dt)、render()、isIdle()；交互、改尺寸、换主题时 wake(c)。 */
const ctrls = new Set();
let raf = 0, last = 0;
export function register(c) { ctrls.add(c); wake(c); return () => { ctrls.delete(c); }; }
export function wake(c) {
  if (c) c._sleep = false;
  if (!raf && typeof requestAnimationFrame === 'function') { last = performance.now(); raf = requestAnimationFrame(frame); }
}
function frame(now) {
  raf = 0;
  // window.__lqTimeScale：调试用慢放（0.1 = 十倍慢，逐帧看形变）；平时不设
  let dt = Math.min(Math.max(0, now - last) / 1000, 1 / 20) * (globalThis.__lqTimeScale ?? 1);
  last = now;
  const live = [];
  for (const c of ctrls) if (!c._sleep) live.push(c);
  while (dt > 1e-6) { const h = Math.min(1 / 240, dt); for (const c of live) c.step?.(h); dt -= h; }
  let any = false;
  for (const c of live) {
    try { c.render?.(); } catch (e) { console.error(e); }
    c._sleep = !!c.isIdle?.();
    if (!c._sleep) any = true;
  }
  if (any) raf = requestAnimationFrame(frame);
}

/* ---------- 菜单触发按钮登记：玻璃按钮把自己的「渐隐 / 撞一下」接口挂在元素上，液滴菜单展开时取用 ---------- */
export const triggers = new WeakMap();
