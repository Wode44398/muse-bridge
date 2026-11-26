// 强度滑杆的纯数学：几何（照官方 28px 滑块、内缩 1px）、橡皮筋、带速度投射的吸附、弹簧积分、松手速度。
// 组件（components/codex/EffortSlider.svelte）只管指针与绘制，这里没有 DOM，单测见同目录 slider-math.test.js。

export const THUMB = 28;
// 滑块中心离轨道两端的距离：官方 Gm/2 - Km（28/2 - 1），滑块贴着轨道内沿走、不出界
export const HALF = THUMB / 2 - 1;

/** 0..1 的位置 → 滑块中心的 x（相对轨道左沿，px）。 */
export const xOf = (p, w) => HALF + p * Math.max(0, w - 2 * HALF);
/** 反过来：x → 0..1（不夹，橡皮筋区会超出）。 */
export const pOf = (x, w) => (x - HALF) / Math.max(1, w - 2 * HALF);

/** n 档在宽 w 的轨道上各自的中心 x。 */
export function stopXs(n, w) {
  if (n <= 1) return [xOf(0, w)];
  return Array.from({ length: n }, (_, i) => xOf(i / (n - 1), w));
}

/**
 * 填充条右沿（px）。照官方 Nm/Pm：最低档时填充整条藏起来，往右走填充右沿逐渐追到滑块中心，
 * 到最高档时铺满——这样最低档不会在滑块左边露出一截黑头。
 */
export function fillRight(p, n, w) {
  if (!(w > 0) || p <= 0) return 0;
  if (p >= 1) return w;
  const s = n > 1 ? 1 / (n - 1) : 1;
  const pm = HALF * (1 - 2 * p);
  return p * w + pm * Math.min(p / s, (1 - p) / s, 1);
}

/**
 * 橡皮筋：越拉越紧，永远到不了 dim（iOS 的 (1 - 1/(x·c/d + 1))·d）。
 * over 是手指越界的距离，返回滑块实际越界的距离。
 */
export function rubber(over, dim = 18, c = 0.55) {
  if (!(over > 0)) return 0;
  return (1 - 1 / ((over * c) / dim + 1)) * dim;
}

/** 手指的 x 夹进 [lo, hi]，越界部分换成橡皮筋。 */
export function clampRubber(x, lo, hi, dim = 18) {
  if (x < lo) return lo - rubber(lo - x, dim);
  if (x > hi) return hi + rubber(x - hi, dim);
  return x;
}

/**
 * 松手落到哪一档：把当前位置按松手速度往前投射 tau 秒，取离投射点最近的一档。
 * 轻轻一甩能跨到下一档，慢慢放就落最近的。
 */
export function nearestStop(x, v, stops, tau = 0.1) {
  if (!stops.length) return -1;
  const aim = x + (Number.isFinite(v) ? v : 0) * tau;
  let best = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - aim) < Math.abs(stops[best] - aim)) best = i;
  return best;
}

/**
 * 拖动中「现在算哪一档」（标签、触觉跟它走）：最近的那档，但要越过两档中点再多 hyst 个档距才换，
 * 手指停在中点附近抖时标签不会来回跳。
 */
export function liveIndex(x, stops, prev = -1, hyst = 0.12) {
  if (!stops.length) return -1;
  const near = nearestStop(x, 0, stops, 0);
  if (prev < 0 || prev >= stops.length || near === prev) return near;
  const gap = stops.length > 1 ? Math.abs(stops[1] - stops[0]) : 0;
  const mid = (stops[prev] + stops[near]) / 2;
  const dir = Math.sign(stops[near] - stops[prev]);
  return (x - mid) * dir > hyst * gap ? near : prev;
}

/**
 * 弹簧积分一步（半隐式欧拉，按 1/240 秒细分，掉帧时也稳）。单位随调用方（这里是 px 与 px/s）。
 * k 刚度、c 阻尼、m 质量；阻尼比 ζ = c / (2√(k·m))，ζ < 1 有回弹。
 */
export function springStep(s, target, { k = 560, c = 38, m = 1 } = {}, dt = 1 / 60) {
  let { x, v } = s;
  let rem = Math.min(Math.max(dt, 0), 0.064);
  while (rem > 1e-9) {
    const h = Math.min(rem, 1 / 240);
    const a = (-k * (x - target) - c * v) / m;
    v += a * h;
    x += v * h;
    rem -= h;
  }
  return { x, v };
}

/** 停稳了没有（离目标不到 eps px、速度不到 veps px/s）。 */
export const settled = (s, target, eps = 0.25, veps = 8) => Math.abs(s.x - target) < eps && Math.abs(s.v) < veps;

/**
 * 松手速度（px/s）：取最近 win 毫秒里的采样首尾差。手指松开前停住超过 stale 毫秒 = 0，
 * 免得「拖到位、停一下、再松手」被当成甩出去。samples: [{ t(ms), x }]，按时间排好。
 */
export function velocity(samples, now, win = 80, stale = 60) {
  if (!samples?.length) return 0;
  const last = samples[samples.length - 1];
  if (now - last.t > stale) return 0;
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > win) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt < 8) return 0;
  return ((last.x - first.x) / dt) * 1000;
}

/** 档点离滑块中心 d px 时的放大倍数：滑块挨近时轻轻鼓起，像被吸过去，离远了回 1。 */
export function dotSwell(d, reach = 26, inner = 12, amp = 0.6) {
  const k = Math.min(1, Math.max(0, 1 - (Math.abs(d) - inner) / reach));
  return 1 + amp * k;
}
