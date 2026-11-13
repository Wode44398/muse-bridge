// 月桥标志的动效：出场（intro）与「正在发生」（live）。组件见 components/brand/Mark.svelte。
//
// 为什么逐帧算、不写 CSS 关键帧：要的「润」来自彼此牵动的量——弹簧的过冲与回摆、转动时水面线两头被惯性甩成的浅 S、
// 倒影比拱慢半拍、线从圆心射出穿过圆环时把圆环顶得一颤。关键帧写不出这种因果（加速度驱动弯曲、线长越过半径触发形变）。
// 这里把整段动作按 1ms 步长模拟一遍存成表（弹簧都在模拟里），逐帧只查表、写 SVG 属性；所有在动的标志共用一个 rAF。
//
// intro（出场，约 1.85s）：整枚竖着（水面竖直、拱在左）从小旋入，同时一笔绕出整圆（笔头是圆的，先快后慢）；
//   笔快收尾时线从圆心往两头射出——跑得快时细、停下来变粗，冲过头再弹回，穿过圆环时圆环沿线被顶得一颤；
//   往回蓄一下，三笔一起顺时针转过 90° 落成月桥：转起来整枚微微收紧，线两头被甩成浅 S、倒影慢半拍，落定带一点回摆。
// live（正在发生，一周 2.2s）：月桥沉进水面（拱与倒影一起压扁进那根线，线吃进了墨、变长变粗）→ 水面线独自顺时针转半圈
//   （两头甩成 S）→ 月桥从水面重新升起（拱先、倒影慢半拍，冲过头再回落）→ 静一拍。线中心对称，转半圈与原样重合，
//   所以每一周升起的都是正着的月桥。所有 live 标志按全局时钟同相——一屏几处同时在跑也是同一口气；
//   中途开始的先就地走一遍，再在下一周期起点并进全局节拍；停下时从当前姿态用弹簧收回静止的月桥，不瞬断。
// flip（点标志切明暗，约 1.35s）：live 的手势演一次、更利落，压平那一刻回调去换明暗（见 simFlip）。
// 跟手（hover / press）：实时弹簧叠在以上任何姿态之上——悬停浮起并朝指针倾、按下收紧（见 Touch）。

// ── 姿态通道 ─────────────────────────────────────────────────────────────────────────
const OP = 0; // 整枚不透明度
const ROT = 1; // 整枚转角（度，顺时针为正）
const S = 2; // 整枚缩放
const WX = 3; // 圆环沿水面方向的形变
const WY = 4; // 圆环垂直水面方向的形变
const ARCH_Y = 5; // 拱以水面为轴的纵向缩放（0 = 沉进水面）
const REFL_Y = 6; // 倒影以水面为轴的纵向缩放
const LAG = 7; // 倒影相对整枚的滞后角（度）
const DRAW_A = 8; // 一笔绕圆：拱描到哪（0..1）
const DRAW_R = 9; // 一笔绕圆：倒影描到哪
const LEN = 10; // 水面线长度（1 = 原长）
const THICK = 11; // 水面线粗细
const BEND = 12; // 水面线 S 形弯：右端相对中线往上偏多少（网格单位）
const NCH = 13;
const REST = [1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0];

type Track = { n: number; data: Float32Array }; // data[t * NCH + 通道]，t 以毫秒计

// ── 物理 ─────────────────────────────────────────────────────────────────────────────
const DT = 0.001;
const hz = (f: number) => Math.PI * 2 * f;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

// CSS cubic-bezier 同款缓动（二分求 x，稳）
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

// 阻尼弹簧（半隐式欧拉，1ms 步长下对这里用到的频率都稳）；force 是外力（加速度项）
class Spring {
  x: number;
  to: number;
  v = 0;
  w: number;
  z: number;
  constructor(x: number, to = x, f = 2, z = 1) {
    this.x = x;
    this.to = to;
    this.w = hz(f);
    this.z = z;
  }
  aim(to: number, f?: number, z?: number) {
    this.to = to;
    if (f !== undefined) this.w = hz(f);
    if (z !== undefined) this.z = z;
  }
  step(force = 0) {
    this.v += (this.w * this.w * (this.to - this.x) - 2 * this.z * this.w * this.v + force) * DT;
    this.x += this.v * DT;
  }
}

// 惯性：整枚的角加速度把线两头甩弯（快、弹），也让倒影慢半拍（慢、软——水）
const K_BEND = 0.2;
const K_LAG = 0.17;
function inertia() {
  const bend = new Spring(0, 0, 4.5, 0.3);
  const lag = new Spring(0, 0, 3, 0.38);
  let pv = 0;
  return {
    bend,
    lag,
    step(rot: Spring) {
      const acc = (rot.v - pv) / DT;
      pv = rot.v;
      bend.step(K_BEND * acc);
      lag.step(K_LAG * acc);
    },
  };
}

function track(n: number): Track {
  return { n, data: new Float32Array((n + 1) * NCH) };
}

// ── 出场 ─────────────────────────────────────────────────────────────────────────────
const INTRO_MS = 1850;
function simIntro(): Track {
  const tr = track(INTRO_MS);
  const d = tr.data;
  const rot = new Spring(-132, -90, 1, 1); // 旋入：临界阻尼，缓缓停在竖直
  const sc = new Spring(0.84, 1, 1.4, 0.8); // 由小长大
  const len = new Spring(0, 0, 3.4, 0.62); // 线：冲过头约 8% 再弹回
  const wob = new Spring(0, 0, 4.2, 0.32); // 圆环被线顶的一颤
  const inr = inertia();
  const draw = bezier(0.42, 0, 0.28, 1);
  const vLen = new Float32Array(INTRO_MS + 1);
  const vRot = new Float32Array(INTRO_MS + 1);
  let pierced = false;
  for (let t = 0; t <= INTRO_MS; t++) {
    if (t === 660) len.aim(1); // 笔快收尾时线就出发——动作交叠，不排队
    if (t === 1000) rot.aim(-98, 3.5, 0.9); // 往回蓄一下
    if (t === 1090) rot.aim(0, 2, 0.66); // 转过 90°，过冲约 6° 回摆
    if (t > 0) {
      rot.step();
      sc.step();
      len.step();
      inr.step(rot);
      wob.step();
    }
    if (!pierced && len.x >= 0.6) {
      pierced = true;
      wob.v += 1.5;
    }
    // 一笔绕圆：拱 180°（左脚 → 顶 → 右脚），隔 6° 接倒影 168°（右 → 水下 → 左），共 354° 一个缓动
    const sweep = draw((t - 40) / 720) * 354;
    const o = t * NCH;
    d[o + OP] = smooth01(t / 180);
    d[o + ROT] = rot.x;
    d[o + S] = sc.x;
    d[o + WX] = 1 + wob.x;
    d[o + WY] = 1 - 0.8 * wob.x;
    d[o + ARCH_Y] = 1;
    d[o + REFL_Y] = 1;
    d[o + LAG] = inr.lag.x;
    d[o + DRAW_A] = clamp01(sweep / 180);
    d[o + DRAW_R] = clamp01((sweep - 186) / 168);
    d[o + LEN] = Math.max(0, len.x);
    d[o + BEND] = inr.bend.x;
    vLen[t] = len.v;
    vRot[t] = rot.v;
  }
  // 挤压与拉伸：线跑得越快越细；整枚转得越快收得越紧
  let mLen = 1e-6;
  let mRot = 1e-6;
  for (let t = 0; t <= INTRO_MS; t++) {
    mLen = Math.max(mLen, Math.abs(vLen[t]));
    mRot = Math.max(mRot, Math.abs(vRot[t]));
  }
  for (let t = 0; t <= INTRO_MS; t++) {
    const o = t * NCH;
    d[o + THICK] = 1 - 0.5 * (Math.abs(vLen[t]) / mLen) ** 0.7;
    d[o + S] *= 1 - 0.035 * (Math.abs(vRot[t]) / mRot);
  }
  d.set(REST, INTRO_MS * NCH);
  return tr;
}

// ── 正在发生 ──────────────────────────────────────────────────────────────────────────
export const LIVE_MS = 2200;
const LIVE_STILL = 1600; // 此后到周期末是静止的月桥：从这里进出都无缝
function simLive(): Track {
  // 连模两周、取第二周：弹簧在周期接缝处的状态是真实延续下来的
  const tr = track(LIVE_MS);
  const d = tr.data;
  const rot = new Spring(0, 0, 1.5, 0.7);
  const archY = new Spring(1, 1, 2.4, 0.6);
  const reflY = new Spring(1, 1, 2.4, 0.6);
  const len = new Spring(1, 1, 3, 0.55);
  const inr = inertia();
  const sink = bezier(0.55, 0, 0.85, 0.5); // 沉：越沉越快，砸进水面
  for (let t = 0; t < 2 * LIVE_MS; t++) {
    const c = t % LIVE_MS;
    if (c === 280) len.aim(1.12, 3, 0.55); // 圆环的墨流进线里：线变长
    if (c === 330) rot.aim(rot.to + 180, 1.5, 0.7); // 水面线独自转半圈
    if (c === 650) {
      // 线中心对称，转过 180° 与原样重合：趁圆环还压扁着把角度折回，升起来的就是正着的月桥
      rot.x -= 180;
      rot.to -= 180;
    }
    if (c === 800) {
      archY.aim(1);
      len.aim(1, 2.4, 0.7);
    }
    if (c === 870) reflY.aim(1); // 倒影慢半拍
    rot.step();
    inr.step(rot);
    len.step();
    archY.step();
    reflY.step();
    // 沉与压扁着的那段是定好的轨迹，不归弹簧管
    const held = (s: Spring, until: number) => {
      if (c >= until) return;
      s.x = c < 300 ? 1 - sink(c / 300) : 0;
      s.v = 0;
    };
    held(archY, 800);
    held(reflY, 870);
    if (t < LIVE_MS) continue;
    const o = c * NCH;
    d.set(REST, o);
    d[o + ROT] = rot.x;
    d[o + ARCH_Y] = archY.x;
    d[o + REFL_Y] = reflY.x;
    d[o + LAG] = inr.lag.x;
    d[o + LEN] = len.x;
    d[o + THICK] = 1 + 0.2 * (1 - Math.min(1, archY.x)); // 吃进了墨：变粗
    d[o + BEND] = inr.bend.x;
  }
  d.set(d.subarray(0, NCH), LIVE_MS * NCH); // 末帧 = 首帧，插值闭环
  return tr;
}

// ── 收势：live 停下时从当前姿态（带速度）用弹簧回到静止 ─────────────────────────────────
const SETTLE_MS = 700;
function simSettle(x0: Float32Array, v0: Float32Array): Track {
  const tr = track(SETTLE_MS);
  const d = tr.data;
  const sp = Array.from({ length: NCH }, (_, c) => {
    const s = new Spring(x0[c], REST[c], 2.4, c === ARCH_Y || c === REFL_Y ? 0.6 : 0.75);
    s.v = v0[c];
    return s;
  });
  // 圆环压扁着时整枚的角度可以按 180° 折：继续顺时针转到下一个正位，不倒着拧回去
  if (x0[ARCH_Y] < 0.05 && x0[ROT] > 0.5) sp[ROT].x -= 180 * Math.ceil(x0[ROT] / 180);
  const inr = inertia();
  inr.bend.x = x0[BEND];
  inr.bend.v = v0[BEND];
  inr.lag.x = x0[LAG];
  inr.lag.v = v0[LAG];
  for (let t = 0; t <= SETTLE_MS; t++) {
    if (t > 0) {
      for (const s of sp) s.step();
      inr.step(sp[ROT]);
    }
    const o = t * NCH;
    for (let c = 0; c < NCH; c++) d[o + c] = sp[c].x;
    d[o + BEND] = inr.bend.x;
    d[o + LAG] = inr.lag.x;
  }
  d.set(REST, SETTLE_MS * NCH);
  return tr;
}

// ── 翻面：点一下切明暗（与 live 同一个手势，一次、更利落）──────────────────────────────────
// 月桥沉进水面（墨全流进线里）→ 线独自翻过半圈 → 月桥在新的明暗里重新升起。明暗就在压平的那一刻换：
// 换的是整张纸的颜色，标志此刻只剩一根线，最不显眼；升起来的已经是新墨色。
// 可以从任意姿态起（连点时从当前带速度的姿态接着沉，不回跳）。
const FLIP_SWITCH_MS = 190; // 压平、换明暗的时刻
const FLIP_MS = 1350;
function simFlip(x0: Float32Array = new Float32Array(REST), v0: Float32Array = new Float32Array(NCH)): Track {
  const tr = track(FLIP_MS);
  const d = tr.data;
  const r0 = x0[ROT] - 180 * Math.round(x0[ROT] / 180); // 线中心对称：角度按 180° 折到正位附近
  const rot = new Spring(r0, 0, 1.8, 0.62);
  rot.v = v0[ROT];
  const archY = new Spring(x0[ARCH_Y], 0, 2.6, 0.55);
  const reflY = new Spring(x0[REFL_Y], 0, 2.6, 0.55);
  const len = new Spring(x0[LEN], 1, 3, 0.6);
  len.v = v0[LEN];
  const inr = inertia();
  inr.bend.x = x0[BEND];
  inr.bend.v = v0[BEND];
  inr.lag.x = x0[LAG];
  inr.lag.v = v0[LAG];
  const sink = bezier(0.5, 0, 0.9, 0.45); // 越沉越快，砸进水面
  const SINK = 180;
  const a0 = Math.max(0, x0[ARCH_Y]);
  const f0 = Math.max(0, x0[REFL_Y]);
  for (let t = 0; t <= FLIP_MS; t++) {
    if (t === 110) len.aim(1.16, 3.2, 0.5); // 墨流进线里：线变长
    if (t === 170) rot.aim(180, 1.8, 0.74); // 线独自翻过半圈，过冲收在 5° 内（再大月桥就是歪着升起来的）
    if (t === 480) {
      rot.x -= 180; // 趁月桥还压平着把角度折回，升起来的是正的
      rot.to -= 180;
    }
    if (t === 520) {
      archY.aim(1);
      len.aim(1, 2.4, 0.65);
    }
    if (t === 585) reflY.aim(1); // 倒影慢半拍
    if (t > 0) {
      rot.step();
      inr.step(rot);
      len.step();
      archY.step();
      reflY.step();
    }
    const held = (s: Spring, from: number, until: number) => {
      if (t >= until) return;
      s.x = t < SINK ? from * (1 - sink(t / SINK)) : 0;
      s.v = 0;
    };
    held(archY, a0, 520);
    held(reflY, f0, 585);
    const o = t * NCH;
    d.set(REST, o);
    d[o + ROT] = rot.x;
    d[o + ARCH_Y] = archY.x;
    d[o + REFL_Y] = reflY.x;
    d[o + LAG] = inr.lag.x;
    d[o + LEN] = len.x;
    d[o + THICK] = 1 + 0.22 * (1 - Math.min(1, Math.max(0, archY.x))); // 吃进了墨：变粗
    d[o + BEND] = inr.bend.x;
  }
  d.set(REST, FLIP_MS * NCH);
  return tr;
}

// ── 跟手：悬停与按下（实时弹簧，叠在当前姿态之上）────────────────────────────────────────
// 悬停：月桥微微浮起（拱高一点、倒影短一点）、水面线舒展；整枚朝指针那侧倾几度——像指针有分量，
//   压在哪头哪头就沉；倾角的角加速度照样经 inertia 把线甩成浅 S、让倒影慢半拍。
// 按下：整枚收紧、墨挤进线里（线短而粗）；松开带回弹。
const LEAN = 7; // 指针在边缘时的最大倾角（度）
class Touch {
  rot = new Spring(0, 0, 2.2, 0.5);
  sc = new Spring(1, 1, 3.2, 0.5);
  len = new Spring(1, 1, 2.6, 0.5);
  thick = new Spring(1, 1, 3.2, 0.55);
  arch = new Spring(1, 1, 2.6, 0.5);
  refl = new Spring(1, 1, 2.2, 0.55);
  inr = inertia();
  over = false;
  down = false;
  lean = 0;
  last = 0;
  aim() {
    const h = this.over;
    const p = this.down;
    this.rot.aim(h && !p ? this.lean * LEAN : 0);
    this.sc.aim(p ? 0.9 : h ? 1.05 : 1, p ? 5 : 3.2, p ? 0.75 : 0.45);
    this.len.aim(p ? 0.9 : h ? 1.1 : 1);
    this.thick.aim(p ? 1.25 : 1);
    this.arch.aim(p ? 0.82 : h ? 1.07 : 1);
    this.refl.aim(p ? 0.7 : h ? 0.9 : 1);
  }
  // 推进到 now；返回 false = 已静止回原样（不用再叠）
  step(now: number): boolean {
    const n = Math.min(48, Math.max(0, Math.round(now - this.last)));
    this.last += n;
    if (now - this.last > 48) this.last = now; // 后台标签页回来：别补跑几秒的物理
    const sp = [this.rot, this.sc, this.len, this.thick, this.arch, this.refl];
    for (let i = 0; i < n; i++) {
      for (const s of sp) s.step();
      this.inr.step(this.rot);
    }
    if (this.over || this.down) return true;
    const calm = (s: Spring) => Math.abs(s.x - s.to) < 2e-4 && Math.abs(s.v) < 4e-3;
    return !(sp.every(calm) && Math.abs(this.inr.bend.x) < 2e-4 && Math.abs(this.inr.bend.v) < 4e-3 && Math.abs(this.inr.lag.x) < 2e-3);
  }
  apply(p: Float32Array) {
    p[ROT] += this.rot.x;
    p[S] *= this.sc.x;
    p[LEN] *= this.len.x;
    p[THICK] *= this.thick.x;
    p[ARCH_Y] *= this.arch.x;
    p[REFL_Y] *= this.refl.x;
    p[BEND] += this.inr.bend.x;
    p[LAG] += this.inr.lag.x;
  }
}

let INTRO: Track | null = null;
let LIVE: Track | null = null;
let FLIP: Track | null = null;

// 线性插值取第 ms 毫秒的姿态
function sample(tr: Track, ms: number, out: Float32Array) {
  const t = Math.min(Math.max(ms, 0), tr.n);
  const i = Math.min(Math.floor(t), tr.n - 1);
  const f = t - i;
  const a = i * NCH;
  const b = a + NCH;
  for (let c = 0; c < NCH; c++) out[c] = tr.data[a + c] + (tr.data[b + c] - tr.data[a + c]) * f;
}

// ── 共用的逐帧驱动 ───────────────────────────────────────────────────────────────────
type Job = (now: number) => boolean; // 返回 false = 这一段做完了
const jobs = new Set<Job>();
let raf = 0;
function run(now: number) {
  raf = 0;
  for (const j of jobs) if (!j(now)) jobs.delete(j);
  if (jobs.size) raf = requestAnimationFrame(run);
}
function schedule(j: Job) {
  jobs.add(j);
  if (!raf) raf = requestAnimationFrame(run);
}

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── 画：姿态 → SVG 属性 ──────────────────────────────────────────────────────────────
export type MarkEls = {
  body: SVGGElement; // 整枚（转、缩、淡入）
  ring: SVGGElement; // 圆环（被线顶的形变）
  arch: SVGGElement; // 拱（沉浮）
  refl: SVGGElement; // 倒影（沉浮、滞后）
  line: SVGPathElement; // 水面线（伸缩、粗细、S 弯——现算轮廓）
  drawA?: SVGPathElement | null; // 出场「一笔绕圆」的遮罩描边
  drawR?: SVGPathElement | null;
};
export type MarkGeo = {
  cx: number;
  cy: number;
  fine: boolean; // 精绘版：线是填充的收势轮廓；否则是等宽描边
  half: number; // 水面半长
  lineW: number; // 描边版的线宽（已按像素下限加粗）
  lineD: string; // 静止时的线（brand.ts 原样）
  taper?: { mid: number; end: number; p: number }; // 精绘版的收势
};

const n2 = (x: number) => String(Math.round(x * 100) / 100);
const P = (p: number[]) => `${n2(p[0])} ${n2(p[1])}`;

// 过给定点列的平滑曲线（Catmull-Rom → 三次贝塞尔），与 brand/geometry.mjs 的 smooth 同一算法，静止时轮廓与 brand.ts 重合
function smooth(pts: number[][]) {
  const k = pts.length;
  const at = (i: number) =>
    i < 0
      ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]]
      : i >= k
        ? [2 * pts[k - 1][0] - pts[k - 2][0], 2 * pts[k - 1][1] - pts[k - 2][1]]
        : pts[i];
  let d = "";
  for (let i = 0; i < k - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    d += `C${n2(p1[0] + (p2[0] - p0[0]) / 6)} ${n2(p1[1] + (p2[1] - p0[1]) / 6)} ${n2(p2[0] - (p3[0] - p1[0]) / 6)} ${n2(p2[1] - (p3[1] - p1[1]) / 6)} ${P(p2)}`;
  }
  return d;
}

// 水面线：中线 y = -bend·s|s|（s ∈ [-1,1]，圆心处切线仍水平、越往两头偏得越多——被甩的 S），精绘版沿中线按收势加宽成轮廓
function linePath(g: MarkGeo, len: number, thick: number, bend: number): string {
  if (len < 0.004) return "";
  const H = g.half * len;
  const B = bend * len;
  if (!g.fine || !g.taper) {
    let d = "";
    for (let i = 0; i <= 12; i++) {
      const s = i / 6 - 1;
      d += `${i ? "L" : "M"}${n2(g.cx + s * H)} ${n2(g.cy - B * s * Math.abs(s))}`;
    }
    return d;
  }
  const tp = g.taper;
  const top: number[][] = [];
  const bot: number[][] = [];
  for (let i = 0; i <= 30; i++) {
    const s = i / 15 - 1;
    const a = Math.abs(s);
    const px = g.cx + s * H;
    const py = g.cy - B * s * a;
    const ty = -2 * B * a;
    const L = Math.hypot(H, ty);
    const nx = ty / L; // 朝上的法线
    const ny = -H / L;
    const w = (thick * (tp.end + (tp.mid - tp.end) * (1 - a ** tp.p))) / 2;
    top.push([px + nx * w, py + ny * w]);
    bot.push([px - nx * w, py - ny * w]);
  }
  bot.reverse();
  const r = n2((thick * tp.end) / 2);
  return `M${P(top[0])}${smooth(top)}A${r} ${r} 0 0 1 ${P(bot[0])}${smooth(bot)}A${r} ${r} 0 0 1 ${P(top[0])}Z`;
}

// 同值不重写：静止段每帧零 DOM 写入
function set(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function drawMask(el: SVGPathElement | null | undefined, p: number) {
  if (!el) return;
  set(el, "stroke-dashoffset", n2(100 * (1 - p)));
  set(el, "visibility", p > 0.001 ? "visible" : "hidden"); // 圆笔头在零长度时也会画出一个点
}

// ── 每个 Mark 一个控制器 ──────────────────────────────────────────────────────────────
export class MarkMotion {
  private els: MarkEls | null = null;
  private geo: MarkGeo | null = null;
  private cur = new Float32Array(REST);
  private posed = false; // 属性上是不是写着动效姿态（false = 静止原样）
  private once: Track | null = null; // 正在播的一次性动作：出场 / 收势
  private onceAt = 0;
  private live = false; // live 循环在跑
  private want = false; // 外面要不要 live
  private localAt = 0; // 中途开始时就地走的起点
  private syncAt = 0; // 从这一刻起并进全局节拍
  private ticking = false;
  private touch: Touch | null = null; // 跟手层（悬停 / 按下）；没交互过就是 null
  private touching = false; // 跟手层还没静下来
  private flipping = false; // 正在播的一次性动作是翻面
  private onSwitch: (() => void) | null = null; // 翻面压平那一刻要做的事（切明暗）

  private job: Job = (now) => this.frame(now);

  attach(els: MarkEls, geo: MarkGeo) {
    this.els = els;
    this.geo = geo;
    if (this.posed) this.paint(this.cur);
  }

  intro() {
    if (reducedMotion()) return;
    INTRO ??= simIntro();
    this.fireSwitch();
    this.flipping = false;
    this.once = INTRO;
    this.onceAt = performance.now();
    sample(INTRO, 0, this.cur);
    this.paint(this.cur); // 挂载的同一帧就写上起始姿态：不先闪一下完整的标志
    this.tick();
  }

  setLive(on: boolean) {
    this.want = on;
    if (reducedMotion()) return;
    if (on) {
      if (!this.live && !this.once) this.join(performance.now());
    } else if (this.live) {
      this.live = false;
      const now = performance.now();
      const ms = this.livePhase(now);
      if (ms <= 0 || ms >= LIVE_STILL) this.rest();
      else {
        // 从当前姿态（带速度）收回
        const x0 = new Float32Array(NCH);
        const x1 = new Float32Array(NCH);
        const x2 = new Float32Array(NCH);
        sample(LIVE!, ms, x0);
        sample(LIVE!, ms - 1, x1);
        sample(LIVE!, ms + 1, x2);
        const v0 = x2.map((b, c) => (b - x1[c]) * 500); // 每毫秒的差 → 每秒
        this.once = simSettle(x0, v0);
        this.onceAt = now;
        this.tick();
      }
    }
  }

  // 悬停：on = 指针在上面；x = 指针相对标志中心的横向位置（-1 左缘 … 1 右缘）
  hover(on: boolean, x = 0) {
    if (reducedMotion()) return;
    const tc = this.wake();
    tc.over = on;
    tc.lean = on ? Math.max(-1, Math.min(1, x)) : 0;
    tc.aim();
  }

  press(on: boolean) {
    if (reducedMotion()) return;
    const tc = this.wake();
    tc.down = on;
    tc.aim();
  }

  // 翻面：沉下 → 线翻半圈 → 升起；压平那一刻调 onSwitch。出场还在播 / 减弱动效时不演，onSwitch 立即调。
  flip(onSwitch: () => void) {
    if (reducedMotion() || !this.els || (this.once && !this.flipping)) {
      onSwitch();
      return;
    }
    this.fireSwitch(); // 上一次还没到压平就又点了：先把它欠的那次切换补上
    const now = performance.now();
    if (this.flipping && this.once) {
      // 连点：从当前姿态（带速度）接着沉，不回跳
      const t = now - this.onceAt;
      const x0 = new Float32Array(NCH);
      const x1 = new Float32Array(NCH);
      const x2 = new Float32Array(NCH);
      sample(this.once, t, x0);
      sample(this.once, t - 1, x1);
      sample(this.once, t + 1, x2);
      this.once = simFlip(x0, x2.map((b, c) => (b - x1[c]) * 500));
    } else {
      FLIP ??= simFlip();
      this.once = FLIP;
    }
    this.live = false;
    this.flipping = true;
    this.onSwitch = onSwitch;
    this.onceAt = now;
    this.tick();
  }

  destroy() {
    jobs.delete(this.job);
    this.ticking = false;
    this.els = null;
    this.fireSwitch(); // 翻到一半被卸载：切换照样完成
  }

  private fireSwitch() {
    const f = this.onSwitch;
    this.onSwitch = null;
    f?.();
  }

  private wake(): Touch {
    const tc = (this.touch ??= new Touch());
    if (!this.touching) tc.last = performance.now();
    this.touching = true;
    this.tick();
    return tc;
  }

  private join(now: number) {
    LIVE ??= simLive();
    this.live = true;
    const g = now % LIVE_MS;
    if (g >= LIVE_MS - 400) {
      this.syncAt = now; // 全局节拍马上要起：等它，一起走
    } else {
      // 就地先走一遍，走完静着等下一个周期起点并进去
      this.localAt = now;
      const done = now + LIVE_STILL;
      this.syncAt = done + ((LIVE_MS - (done % LIVE_MS)) % LIVE_MS);
    }
    this.tick();
  }

  // live 此刻在周期里的哪一毫秒
  private livePhase(now: number) {
    return now < this.syncAt ? Math.min(now - this.localAt, LIVE_STILL) : now % LIVE_MS;
  }

  private tick() {
    if (this.ticking) return;
    this.ticking = true;
    schedule(this.job);
  }

  // 每帧：底层姿态（一次性动作 / live / 静止）+ 跟手层叠上去；都没有了就回到逐数原样
  private frame(now: number): boolean {
    if (!this.els) return (this.ticking = false);
    let base = false;
    if (this.once) {
      const t = now - this.onceAt;
      if (this.flipping && this.onSwitch && t >= FLIP_SWITCH_MS) this.fireSwitch();
      if (t >= this.once.n) {
        this.once = null;
        this.flipping = false;
        if (this.want && !this.live && !reducedMotion()) this.join(now);
      } else {
        sample(this.once, t, this.cur);
        base = true;
      }
    }
    if (!base && this.live) {
      sample(LIVE!, this.livePhase(now), this.cur);
      base = true;
    }
    if (this.touching && this.touch && !this.touch.step(now)) this.touching = false;
    if (!base && !this.touching) {
      if (this.posed) this.rest();
      return (this.ticking = false);
    }
    if (!base) this.cur.set(REST);
    if (this.touching) this.touch!.apply(this.cur);
    this.paint(this.cur);
    return true;
  }

  private paint(p: Float32Array) {
    const e = this.els;
    const g = this.geo;
    if (!e || !g) return;
    this.posed = true;
    const c = `${g.cx} ${g.cy}`;
    const back = `translate(${-g.cx} ${-g.cy})`;
    set(e.body, "transform", `translate(${c})rotate(${n2(p[ROT])})scale(${n2p(p[S])})${back}`);
    set(e.body, "opacity", n2(p[OP]));
    set(e.ring, "transform", `translate(${c})scale(${n2p(p[WX])} ${n2p(p[WY])})${back}`);
    // 纵向缩放到 0 时矩阵奇异：留一个看不见的下限
    set(e.arch, "transform", `translate(0 ${g.cy})scale(1 ${n2p(Math.max(p[ARCH_Y], 1e-3))})translate(0 ${-g.cy})`);
    set(e.refl, "transform", `translate(${c})rotate(${n2(-p[LAG])})scale(1 ${n2p(Math.max(p[REFL_Y], 1e-3))})${back}`);
    drawMask(e.drawA, p[DRAW_A]);
    drawMask(e.drawR, p[DRAW_R]);
    const d = linePath(g, p[LEN], p[THICK], p[BEND]);
    set(e.line, "d", d || "M0 0");
    set(e.line, "visibility", d ? "visible" : "hidden");
    if (!g.fine) set(e.line, "stroke-width", n2p(g.lineW * p[THICK]));
  }

  // 回到静止原样：去掉全部动效属性，线换回 brand.ts 的原样
  private rest() {
    this.cur.set(REST);
    const e = this.els;
    const g = this.geo;
    this.posed = false;
    if (!e || !g) return;
    for (const el of [e.body, e.ring, e.arch, e.refl]) el.removeAttribute("transform");
    e.body.removeAttribute("opacity");
    drawMask(e.drawA, 1);
    drawMask(e.drawR, 1);
    set(e.line, "d", g.lineD);
    e.line.removeAttribute("visibility");
    if (!g.fine) set(e.line, "stroke-width", String(g.lineW));
  }
}

// 缩放类的量要多一位精度（小尺寸下 0.01 的缩放差也看得出抖）
const n2p = (x: number) => String(Math.round(x * 1000) / 1000);
