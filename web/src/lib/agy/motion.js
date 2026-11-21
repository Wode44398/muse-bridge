// agy 分页统一动效语言（11-19）：Material 3 的缓动曲线与时长档位 + M3 Expressive 的弹簧档位，
// 吐字、状态换场、logo 接力、仪表变菜单都从这里取参数，节奏才是一套。
//   · 进场 = emphasized decelerate（快出慢收）；退场 = emphasized accelerate（慢起快走、更短）；
//     同一个东西在两个状态间移动 = emphasized（两段曲线：起步稳、中段快、落位很长的减速尾巴）。
//   · 空间类（位置 / 尺寸 / 形状）用欠阻尼弹簧，允许一点点回弹；效果类（透明度 / 颜色）临界阻尼、不回弹。
import { Spring, stepAll } from './springs.js';

export const EASE = {
  std: 'cubic-bezier(0.2, 0, 0, 1)',
  decel: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  accel: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
};

// M3 Expressive 弹簧档位（stiffness, dampingRatio）
export const SPRING = {
  fastSpatial: [800, 0.6],
  spatial: [380, 0.8],
  slowSpatial: [200, 0.8],
  calmSpatial: [420, 0.92],   // 大位移的容器 / 共享元素：几乎不回弹，落位很稳
  fastEffects: [3800, 1],
  effects: [1600, 1],
  slowEffects: [800, 1],
};

export const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
// 把 t 在 [a, b] 之间重新归一（编排用：某段动画只占总进度的一截）
export const span = (t, a, b) => clamp01((t - a) / (b - a));

// —— 三次贝塞尔求值（逐帧驱动用，和 CSS 的 cubic-bezier 同义）——
function cubicSeg(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  const dx = (u) => (3 * ax * u + 2 * bx) * u + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 6; i++) {
      const e = sx(u) - x;
      if (Math.abs(e) < 1e-5) break;
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    if (u < 0 || u > 1) {            // 牛顿法跑偏就二分兜底
      let lo = 0, hi = 1; u = x;
      for (let i = 0; i < 24; i++) { const v = sx(u); if (v < x) lo = u; else hi = u; u = (lo + hi) / 2; }
    }
    return sy(u);
  };
}
export const bezier = cubicSeg;
export const emphDecel = cubicSeg(0.05, 0.7, 0.1, 1);
export const emphAccel = cubicSeg(0.3, 0, 0.8, 0.15);
export const standard = cubicSeg(0.2, 0, 0, 1);

// M3 emphasized：M0,0 C0.05,0 0.133333,0.06 0.166666,0.4 C0.208333,0.82 0.25,1 1,1（两段拼起来）
const EA = cubicSeg(0.05 / 0.166666, 0, 0.133333 / 0.166666, 0.06 / 0.4);
const EB = cubicSeg((0.208333 - 0.166666) / 0.833334, (0.82 - 0.4) / 0.6, (0.25 - 0.166666) / 0.833334, 1);
export function emphasized(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < 0.166666) return 0.4 * EA(t / 0.166666);
  return 0.4 + 0.6 * EB((t - 0.166666) / 0.833334);
}

// —— 弹簧离线采样：给 WAAPI 关键帧 / 一次性动画用（可打断的交互仍走 Spring 逐帧）——
// 返回 { duration(ms), at(t∈[0,1]) → 归一化位置（可 >1 = 回弹）}
const curveCache = new Map();
export function springCurve(stiffness, damping, v0 = 0) {
  const key = stiffness + '|' + damping + '|' + v0;
  const hit = curveCache.get(key);
  if (hit) return hit;
  const s = new Spring(0, stiffness, damping).to(1).kick(v0);
  const dt = 1 / 120;
  const samples = [0];
  for (let i = 0; i < 1200; i++) {
    stepAll([s], dt);
    samples.push(s.x);
    if (s.settled(0.0015)) break;
  }
  samples[samples.length - 1] = 1;
  const n = samples.length - 1;
  const out = {
    duration: Math.round(n * dt * 1000),
    at(t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      const f = t * n, i = Math.floor(f);
      return samples[i] + (samples[i + 1] - samples[i]) * (f - i);
    },
    // CSS linear() 缓动串（Chrome 113+）；不支持时调用方自己退回 cubic-bezier
    css(points = 40) {
      const parts = [];
      for (let i = 0; i <= points; i++) parts.push(out.at(i / points).toFixed(4));
      return 'linear(' + parts.join(', ') + ')';
    },
  };
  curveCache.set(key, out);
  return out;
}

let linearOk = null;
export function supportsLinearEasing() {
  if (linearOk === null) {
    try { linearOk = typeof CSS !== 'undefined' && CSS.supports('animation-timing-function', 'linear(0, 1)'); } catch { linearOk = false; }
  }
  return linearOk;
}
// 弹簧 → WAAPI 的 { duration, easing }（不支持 linear() 时退回 emphasized decelerate）
export function springTiming([k, z]) {
  const c = springCurve(k, z);
  return supportsLinearEasing() ? { duration: c.duration, easing: c.css() } : { duration: Math.min(600, c.duration), easing: EASE.decel };
}
