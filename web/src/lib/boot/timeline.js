// 「穿月」的时间轴：每一帧的样子只由 t（毫秒）算出来，所以能快进、能停在等待态、能从任意一刻接着走。
//
//   成真  倒影长满缺口、加粗变实，拱同时变细——上下一样实，圆成了一扇门
//   收线  水线从两端收进门心，成一点光
//   等待  （资源没到齐才有）光点轻呼吸，就绪后立刻开门
//   开门  光点张开成门洞，洞里是失焦、过曝、偏暖的彼岸
//   穿门  门刚张开镜头就顺势推进（不悬停、不回退）：门按 1/(1 − e/EP) 放大、失焦、冲出画面；洞里的景按景深推近、拉焦
//
// 整段是一台相机。洞里的景用自己的进度（sceneAt），在门出画的那一刻正好停稳——这时浮层的画面就是主页的
// 壁纸本身，浮层撤掉不会跳；之后主页上的东西按同一台相机落位（lib/boot/landing.js）。
import { bezier } from '../motion.js';

export const C = {
  real: bezier(.4, 0, .2, 1),        // 成真：重量从拱流到倒影
  lineIn: bezier(.55, 0, .35, 1),    // 收线：先慢后快再收住
  iris: bezier(.22, .9, .3, 1),      // 开门：一下张开，长尾贴到门的内沿
  push: bezier(.36, 0, .14, 1),      // 推镜：立刻起势、顺滑加速过门、干脆落定
};

export const EP = 0.93;       // 镜头推进到 e = EP 时正好穿过门
export const ZCAM = 0.42;     // 推进距离（以终点到最近处的距离为 1）
export const DN = 1.0, DF = 3.0;
export const BREATH = 700;    // 等待态光点的呼吸周期

const R0 = 0, R1 = 140, A0 = 15, A1 = 150, L0 = 15, L1 = 145, W0 = 150;
// 「还没定」用一个很远的有限时刻，不用 Infinity：Infinity − Infinity 是 NaN，会一路传进着色器的 uniform
const NEVER = 1e9;
export const planned = (T) => T.i0 < NEVER;

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };

/** 就绪之前的时间轴：开门时刻未定，停在光点上 */
export function idlePlan() {
  return { w0: W0, i0: NEVER, i1: NEVER, p0: NEVER, p1: NEVER, exit: NEVER };
}

/**
 * 在 readyAt 就绪时定下后半段：不硬等下一个呼吸峰，资源一到立刻衔接开门（没等就是 W0）。
 * geo = { W, H, cx, cy, u }：门洞要盖住离门心最远的屏幕角，门才算出画（exit）。
 */
export function plan(readyAt, geo) {
  const i0 = Math.max(W0, readyAt);
  const T = { w0: W0, i0, i1: i0 + 160, p0: i0 + 35 };
  T.p1 = T.p0 + 440;
  const { W, H, cx, cy } = geo;
  const far = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy));
  T.exit = T.p1;
  for (let t = T.p0; t <= T.p1; t += 1) if (holeAt(t, T, geo.u) >= far + 6) { T.exit = t; break; }
  return T;
}

/** 门这台相机的进度 */
export const camAt = (t, T) => C.push(seg(t, T.p0, T.p1));
/** 洞里那片景的进度：门出画时正好停稳 */
export const sceneAt = (t, T) => C.push(seg(t, T.p0, T.exit));
/** 门的放大倍数；穿过之后是 Infinity */
export const ringScale = (e) => (e >= EP * 0.9995 ? Infinity : 1 / (1 - e / EP));
export function holeAt(t, T, u) {
  if (t < T.i0) return 0;
  const s = ringScale(camAt(t, T));
  if (!isFinite(s)) return 1e6;
  return lerp(1.1 * u, 16.5 * u, C.iris(seg(t, T.i0, T.i1))) * s;
}

/**
 * 第 t 毫秒的画面参数（喂给 gate.draw）+ 洞里那片景的相机（流光 iframe 用）。
 * o = { cx, cy, u, dark, overscan, waiting }
 */
export function frameAt(t, T, o) {
  const { u } = o;
  const e = camAt(t, T), es = sceneAt(t, T);
  const Sg = ringScale(e), gone = !isFinite(Sg);
  const kr = C.real(seg(t, R0, R1)), ka = C.real(seg(t, A0, A1));
  const g = {
    cx: o.cx, cy: o.cy,
    R: gone ? 0 : 19 * u * Sg,
    wa: gone ? 0 : lerp(7.4, 5, ka) * u * Sg,
    wr: gone ? 0 : lerp(2.8, 5, kr) * u * Sg,
    gap: lerp(11, 0, kr) * Math.PI / 180,
    solid: kr, full: kr >= 1 && ka >= 1 ? 1 : 0,
    // 门离镜头越近越虚：失焦宽度按放大的 1.5 次方长；穿过之后归零（放大是无穷，照公式算会溢出成盖住整屏的半透明墨）
    blur: gone ? 0 : Sg > 1 ? 1.6 * u * Math.pow(Sg - 1, 1.5) : 0,
    // 门靠近时先靠失焦散开，快出画才淡（象牙色半透明盖在墨上会发灰）；暗色里亮环太抢，早一点淡
    ringA: gone ? 0 : 1 - (o.dark ? smooth(3, 9, Sg) : smooth(5, 12, Sg)),
    half: lerp(31 * u, 0, C.lineIn(seg(t, L0, L1))), lw: 2.2 * u, lineA: 1 - smooth(T.i0 - 10, T.i0 + 40, t),
    dotR: 1.1 * u, dotHalo: 7 * u,
    dotA: smooth(L1 - 45, L1 + 5, t) * (1 - smooth(T.i0, T.i0 + 85, t)),
    hole: holeAt(t, T, u),
    e: clamp(es, -0.2, 1), Z: ZCAM, Dn: DN, Df: DF,
    lod: 2.6 * (1 - smooth(0.35, 0.97, es)),
    expo: 1 + 0.3 * (1 - smooth(0.15, 0.95, es)),
    warm: 0.12 * (1 - smooth(0.1, 0.85, es)),
    ao: gone ? 0 : 0.32 * (1 - smooth(5, 12, Sg)),
    overscan: o.overscan || 1,
  };
  // 等待：资源晚于 W0 到达时，光点以 BREATH 轻呼吸；就绪开门瞬间在 50ms 内平滑归 1，不断层
  if (t > T.w0 && T.i0 > T.w0) {
    const bt = Math.min(t, T.i0);
    const b = 0.5 + 0.5 * Math.cos(2 * Math.PI * (bt - T.w0) / BREATH);
    const w = smooth(T.i0, T.i0 + 50, t);
    g.dotA *= lerp(0.72 + 0.28 * b, 1, w);
    g.dotHalo *= lerp(0.88 + 0.12 * b, 1, w);
  }
  return { g, e, es, Sg, cam: { cx: o.cx, cy: o.cy, e: g.e, Z: ZCAM, soft: 2.2 * (1 - smooth(0.35, 0.97, es)) } };
}
