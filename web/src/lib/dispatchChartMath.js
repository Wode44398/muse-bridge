// 子 agent 调用策略 · 性价比图（components/claude/dispatch/PlanChart.svelte）的纯函数：
// 视野与坐标、刻度、成本格式化、判定线拖动的夹取与吸附、性价比前沿、每档落点（选哪个、画在哪个点上）、手柄 / 标签的避让、提示框定位、厂商配色与形状。
// 不碰 DOM、不读任何状态——组件只管画和手势，算数都在这里，node --test 直接测（dispatchChartMath.test.js）。
//
// 坐标与刻度照「订阅 plan 性价比图」原页的 render()：横轴每任务成本（元，对数），纵轴智力指数。
//   X(v) = l + (log10 v − L0) / (L1 − L0) · w        Y(s) = t + h − (s − Y0) / (Y1 − Y0) · h
//   横轴两端取到四分之一个数量级再各让 0.05；纵轴从 0 到 min(100, ceil((最高分 + 4) / 10) · 10)。

export const TIER_KEYS = ['top', 'hard', 'normal', 'light'];
/** 相邻两条判定线的最小间距（智力分）。 */
export const FLOOR_GAP = 0.5;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// —— 版面 ——
/** 宽 ≥ 720 高 420；窄屏高 340。 */
export const isNarrow = (width) => width > 0 && width < 720;
export const chartHeight = (width) => (isNarrow(width) ? 340 : 420);
/** 图版（画点的那块矩形）：{ l, t, w, h }。gutter = 左边留给纵轴刻度与判定线手柄的宽度（不给就用原页的 50 / 40）。 */
export function plotBox(width, height, narrow, gutter) {
  const l = Math.max(narrow ? 40 : 50, gutter || 0), r = narrow ? 8 : 14, top = 30, b = narrow ? 46 : 52;
  return { l, t: top, w: Math.max(1, width - l - r), h: Math.max(1, height - top - b) };
}

// —— 视野与坐标 ——
/**
 * 一组点 [{ cost, score }] 占的范围 { lo, hi, best }：成本的下限 / 上限与最高分；一个算数的点都没有 → null。
 * 成本不是正数的点在对数轴上没有位置，默认整个不算。free = true 时它们的分数照样算进最高分——候选里没有价格的型号
 * 贴着图版左缘画（见 PlanChart），纵轴得够得着它；这时 lo / hi 可能还是空的（±Infinity）。
 */
export function extentOf(points, { free = false } = {}) {
  let lo = Infinity, hi = -Infinity, best = -Infinity;
  for (const p of points || []) {
    if (!p || !fin(p.score)) continue;
    if (fin(p.cost) && p.cost > 0) {
      if (p.cost < lo) lo = p.cost;
      if (p.cost > hi) hi = p.cost;
    } else if (!free) continue;
    if (p.score > best) best = p.score;
  }
  return fin(best) ? { lo, hi, best } : null;
}
/** 一个有价格的点都没有时横轴画哪一段：¥0.01 – ¥1（每任务成本常见的量级）。 */
const BLANK_COSTS = [0.01, 1];
/**
 * 几份范围（extentOf 的结果，null 的跳过）合成一个视野 { L0, L1, Y0, Y1 }（L = log10 元）；全是 null → null。
 * reach = 纵轴至少要够到的分数：判定线是绝对分、几种口径共用，可能比眼下这批点都高（换了口径、关了全图），
 * 纵轴得把它装进来——否则线只能夹在图顶上画，一碰就被拽回纵轴上限。
 */
export function domainFrom(extents, reach) {
  let lo = Infinity, hi = -Infinity, best = -Infinity;
  for (const e of extents || []) {
    if (!e) continue;
    if (e.lo < lo) lo = e.lo;
    if (e.hi > hi) hi = e.hi;
    if (e.best > best) best = e.best;
  }
  if (!fin(best)) return null;
  if (!fin(lo) || !fin(hi)) [lo, hi] = BLANK_COSTS;
  // 1e-9：成本正好落在四分之一数量级上时，log10 的舍入误差别让它多退一格
  const L0 = Math.floor(Math.log10(lo) * 4 + 1e-9) / 4 - 0.05;
  const L1 = Math.ceil(Math.log10(hi) * 4 - 1e-9) / 4 + 0.05;
  let Y1 = Math.max(10, Math.ceil((best + 4) / 10) * 10);
  if (fin(reach)) Y1 = Math.max(Y1, Math.ceil(reach / 10 - 1e-9) * 10);
  return { L0, L1, Y0: 0, Y1: Math.min(100, Y1) };
}
/** 一组点 [{ cost, score }] → 视野；一个能画的点都没有 → null。free / reach 见 extentOf / domainFrom。 */
export const domainOf = (points, { free = false, reach } = {}) => domainFrom([extentOf(points, { free })], reach);
export const sameDomain = (a, b) => !!a && !!b && a.L0 === b.L0 && a.L1 === b.L1 && a.Y0 === b.Y0 && a.Y1 === b.Y1;
/** 两个视野之间按进度 k（0–1）插值：换数据 / 开关全图时坐标轴滑过去。 */
export function lerpDomain(a, b, k) {
  const mix = (x, y) => x + (y - x) * k;
  return { L0: mix(a.L0, b.L0), L1: mix(a.L1, b.L1), Y0: mix(a.Y0, b.Y0), Y1: mix(a.Y1, b.Y1) };
}
export const xOf = (cost, dom, box) => box.l + ((Math.log10(cost) - dom.L0) / (dom.L1 - dom.L0)) * box.w;
export const yOf = (score, dom, box) => box.t + box.h - ((score - dom.Y0) / (dom.Y1 - dom.Y0)) * box.h;
/** 图上的纵坐标 → 智力分（拖判定线用）。 */
export const scoreAt = (y, dom, box) => dom.Y0 + ((box.t + box.h - y) / box.h) * (dom.Y1 - dom.Y0);
/** 多少像素对应多少分（吸附的像素容差换成分数）。 */
export const scorePerPx = (dom, box) => (dom.Y1 - dom.Y0) / box.h;

// —— 刻度 ——
const Y_STEPS = [10, 5, 2, 1, 0.5, 0.2, 0.1];
/** 纵轴刻度值：步长取「至少分出 4 格」的最大那个。 */
export function yTicks(dom) {
  const step = Y_STEPS.find((s) => (dom.Y1 - dom.Y0) / s >= 4) || 0.1;
  const out = [];
  for (let k = Math.ceil(dom.Y0 / step - 1e-9); k * step <= dom.Y1 + 1e-9; k++) out.push(+(k * step).toFixed(2));
  return out;
}
/**
 * 横轴（对数）刻度：{ major, minor }，都是成本值（元）。
 * 主刻度的密度跟着跨度走（跨得越宽越稀）；次刻度是每个数量级里剩下的 2–9，只在跨度 ≤ 4 个数量级时给。
 */
export function xTicks(dom) {
  const span = dom.L1 - dom.L0;
  const mans = span > 5 ? [1] : span > 1.6 ? [1, 2, 5] : span > 0.6 ? [1, 1.5, 2, 3, 5, 7] : [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9];
  const major = [], minor = [];
  for (let e = Math.floor(dom.L0); e <= Math.ceil(dom.L1); e++) {
    for (const m of mans) {
      const v = m * Math.pow(10, e), lv = Math.log10(v);
      if (lv >= dom.L0 - 1e-9 && lv <= dom.L1 + 1e-9) major.push(v);
    }
    if (span > 4) continue;
    for (let m = 2; m <= 9; m++) {
      if (mans.includes(m)) continue;
      const v = m * Math.pow(10, e), lv = Math.log10(v);
      if (lv >= dom.L0 && lv <= dom.L1) minor.push(v);
    }
  }
  return { major, minor };
}
/** 一排刻度的横坐标（升序）→ 哪些写得下数字：离上一个写了字的不到 minGap 就只留刻度线。 */
export function thinTicks(xs, minGap) {
  let last = -Infinity;
  return xs.map((x) => { if (x - last < minGap) return false; last = x; return true; });
}
/** 刻度上的数：三位有效数字，去掉多余的 0（0.05、1.5、200）。 */
export const fmtTick = (v) => String(+v.toPrecision(3));

// —— 数字 ——
/**
 * 每任务成本：≥10 一位小数，≥0.1 两位小数，更小的两位有效数字（不写成科学计数）。不是数 → '—'。
 * 分界按「四舍五入之后」算，免得 9.996 写成 10.00、0.0996 写成 0.1。
 */
export function fmtCost(v) {
  if (!fin(v) || v < 0) return '—';
  if (v === 0) return '¥0';
  if (v >= 9.995) return '¥' + v.toFixed(1);
  if (v >= 0.0995) return '¥' + v.toFixed(2);
  const digits = Math.min(20, Math.max(0, 1 - Math.floor(Math.log10(v))));   // 两位有效数字要的小数位数
  const r = +v.toFixed(digits);
  if (r >= 0.1) return '¥' + r.toFixed(2);
  return '¥' + r.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1');
}
/** 智力分：一位小数。 */
export const fmtScore = (v) => (fin(v) ? v.toFixed(1) : '—');

// —— 判定线 ——
/** 判定线的值一律一位小数。 */
export const roundFloor = (v) => Math.round(v * 10) / 10 + 0;
// + 0：把 −0 归成 0（Math.ceil(−1e-6) 是 −0，显示与比较都别带着它）
const ceil10 = (v) => Math.ceil(v * 10 - 1e-6) / 10 + 0;
const floor10 = (v) => Math.floor(v * 10 + 1e-6) / 10 + 0;
/**
 * 某一档能拖到的范围 { lo, hi }：不越过相邻两档（top ≥ hard ≥ normal ≥ light，至少隔 gap 分），也不出 [min, max]。
 * floors = { top, hard, normal, light }（现值；没有的档不参与）。挤得一点余地都没有时 lo > hi。
 * from = 这条线动之前的值：它要是本来就在 [min, max] 外面（判定线是绝对分，换个口径纵轴就矮了），范围放宽到够得着它——
 * 图画不下不等于这个值不合法，不能一碰就把它拽回纵轴上限。
 */
export function floorBounds(key, floors, { min = 0, max = 100, gap = FLOOR_GAP, from } = {}) {
  const i = TIER_KEYS.indexOf(key);
  let lo = fin(from) ? Math.min(min, from) : min, hi = fin(from) ? Math.max(max, from) : max;
  for (let j = i - 1; j >= 0; j--) if (fin(floors[TIER_KEYS[j]])) { hi = Math.min(hi, floors[TIER_KEYS[j]] - gap); break; }
  for (let j = i + 1; j < TIER_KEYS.length; j++) if (fin(floors[TIER_KEYS[j]])) { lo = Math.max(lo, floors[TIER_KEYS[j]] + gap); break; }
  return { lo: ceil10(lo), hi: floor10(hi) };
}
/** 把一个想要的值夹进这一档能去的范围并取一位小数；没有余地（lo > hi）→ 原地不动。 */
export function clampFloor(key, value, floors, opts) {
  const { lo, hi } = floorBounds(key, floors, opts);
  if (lo > hi) return fin(floors[key]) ? roundFloor(floors[key]) : roundFloor(clamp(value, hi, lo));
  return roundFloor(clamp(roundFloor(value), lo, hi));
}
/** 吸附：离某个目标值不到 tol 分就贴上去（拖回默认线附近时落准），否则原样。 */
export function snapFloor(value, targets, tol) {
  let best = value, bd = tol;
  for (const x of targets || []) {
    if (!fin(x)) continue;
    const d = Math.abs(x - value);
    if (d <= bd) { bd = d; best = x; }
  }
  return best;
}
/**
 * 键盘一步：dir = +1 / −1，big = 按着 Shift（2 分，否则 0.5 分）；结果同样夹在相邻两档之间。
 * 现值已经在 [min, max] 外面时从现值起步：往里走一步是一步，往外走不动（见 floorBounds 的 from）。
 */
export function stepFloor(key, dir, floors, { big = false, ...opts } = {}) {
  const cur = fin(floors[key]) ? floors[key] : 0;
  return clampFloor(key, cur + dir * (big ? 2 : 0.5), floors, { ...opts, from: cur });
}
/** 四条线是否守序（top ≥ hard ≥ normal ≥ light；缺的档跳过）。 */
export function floorsOrdered(floors) {
  let prev = Infinity;
  for (const k of TIER_KEYS) {
    if (!fin(floors[k])) continue;
    if (floors[k] > prev) return false;
    prev = floors[k];
  }
  return true;
}

// —— 落点与前沿 ——
/**
 * 一条判定线选中哪个候选（和服务端 ladderOf 同一条规则）：智力分 ≥ floor 的里面成本最低的，成本相同取更贴近这条线
 *（智力分更低）的；一个都够不着 → 取智力分最高的（并列取便宜的），short = true。
 * list = [{ ii, cost }]；返回 { index, short }，没有能用的候选 → null。
 */
export function pickForFloor(list, floor) {
  let best = -1, top = -1;
  for (let i = 0; i < (list || []).length; i++) {
    const c = list[i];
    if (!c || !fin(c.ii) || !fin(c.cost)) continue;
    if (top < 0 || c.ii > list[top].ii || (c.ii === list[top].ii && c.cost < list[top].cost)) top = i;
    if (c.ii < floor) continue;
    if (best < 0 || c.cost < list[best].cost || (c.cost === list[best].cost && c.ii < list[best].ii)) best = i;
  }
  if (best >= 0) return { index: best, short: false };
  return top >= 0 ? { index: top, short: true } : null;
}
/**
 * 各档的落点画在图上的哪个点。cands = 图上的候选点 [{ model, effort, ii, cost }]，picks = 各档的落点 [{ model, effort, ii?, cost? } | null]。
 * 返回 { spots, ghosts }：spots 与 picks 同序，每项 { at, ghost, lent }——
 *   候选里有这一格（模型 + 推理强度都对上）→ at = 它的下标；
 *   没有这一格（档位自定义落在没评分的推理强度上，服务端借了同模型相近一档的分数与成本）→
 *     同模型里分数、成本都和它一样的那个点就是被借的那一格：at = 那个点、lent = true（环套在它上面，和别的档叠着画）；
 *     找不到这样的点、但落点自己带着分数 → ghost = ghosts 里的下标（调用方在那个位置补一个虚点）；
 *     连分数都没带（调用方只给了 model / effort）→ at、ghost 都是 −1，这一档不画环。
 * ghosts = 要补的虚点（原样的 pick，同一格只补一个）。成本不是正数的一律当「没有价格」，彼此算相同。
 */
export function locatePicks(cands, picks) {
  const list = cands || [];
  const str = (v) => String(v == null ? '' : v);
  const price = (v) => (fin(v) && v > 0 ? v : 0);
  const spots = [], ghosts = [], seen = new Map();
  for (const p of picks || []) {
    const spot = { at: -1, ghost: -1, lent: false };
    spots.push(spot);
    if (!p) continue;
    const model = str(p.model), effort = str(p.effort);
    for (let i = list.length - 1; i >= 0; i--) if (list[i] && str(list[i].model) === model && str(list[i].effort) === effort) { spot.at = i; break; }
    if (spot.at >= 0 || !fin(p.ii)) continue;
    const cost = price(p.cost);
    spot.at = list.findIndex((c) => c && str(c.model) === model && c.ii === p.ii && price(c.cost) === cost);
    if (spot.at >= 0) { spot.lent = true; continue; }
    const id = model + '\n' + effort;
    if (!seen.has(id)) { seen.set(id, ghosts.length); ghosts.push(p); }
    spot.ghost = seen.get(id);
  }
  return { spots, ghosts };
}
/**
 * 性价比前沿：按成本升序走一遍，智力分创新高的留下。list = [{ cost, ii }]，返回留下的下标（成本升序）。
 * 同价的先看分高的，所以同价里只有最高分那个可能上榜。
 */
export function frontier(list) {
  const idx = [];
  for (let i = 0; i < (list || []).length; i++) if (list[i] && fin(list[i].cost) && list[i].cost > 0 && fin(list[i].ii)) idx.push(i);
  idx.sort((a, b) => list[a].cost - list[b].cost || list[b].ii - list[a].ii);
  const out = [];
  let best = -Infinity;
  for (const i of idx) if (list[i].ii > best) { out.push(i); best = list[i].ii; }
  return out;
}
/**
 * 前沿画成阶梯：在遇到下一个更贵的点之前，花这些钱能买到的最高分就是当前这个点。
 * pts = 前沿各点的图上坐标 [[x, y], …]（成本升序），xEnd = 图版右缘；返回折线顶点。
 */
export function stairPath(pts, xEnd) {
  const out = [];
  pts.forEach(([x, y], i) => { if (i) out.push([x, pts[i - 1][1]]); out.push([x, y]); });
  if (pts.length) out.push([xEnd, pts[pts.length - 1][1]]);
  return out;
}

// —— 命中 ——
/** 离 (mx, my) 最近、且不超过 maxDist 的点的下标；pts = [{ x, y }]。没有 → −1。 */
export function nearestIndex(pts, mx, my, maxDist) {
  let best = -1, bd = maxDist;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - mx, pts[i].y - my);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// —— 避让 ——
/**
 * 一列沿纵向排的标签（判定线手柄）：各自想待在 anchors[i]，但两两至少隔 gap、整体不出 [lo, hi]。
 * 挤在一起的几个以它们的重心为中线均匀散开；pin = 某个下标时那一个钉在自己的锚点上（正在拖的那条线），其余给它让路。
 * 返回与 anchors 同序的位置。
 */
export function spreadLabels(anchors, gap, lo, hi, pin = -1) {
  const n = anchors.length;
  if (!n) return [];
  const order = anchors.map((_, i) => i).sort((a, b) => anchors[a] - anchors[b] || a - b);
  // 相邻的块只要互相压着就并成一块，块的起点 = 成员「锚点 − 在块里的序号 × gap」的平均
  const blocks = [];
  for (const i of order) {
    blocks.push({ sum: anchors[i], n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.n + a.n * gap <= b.sum / b.n + 1e-9) break;
      blocks.pop();
      blocks[blocks.length - 1] = { sum: a.sum + b.sum - a.n * gap * b.n, n: a.n + b.n };
    }
  }
  const pos = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) pos.push(b.sum / b.n + k * gap);
  if (pin >= 0 && pin < n) {
    // 钉住的那个回到自己的锚点，两边的从它起按间距排开
    const at = order.indexOf(pin);
    pos[at] = anchors[pin];
    for (let k = at - 1; k >= 0; k--) pos[k] = Math.min(pos[k], pos[k + 1] - gap);
    for (let k = at + 1; k < n; k++) pos[k] = Math.max(pos[k], pos[k - 1] + gap);
  } else {
    for (let k = n - 1; k >= 0; k--) pos[k] = Math.min(pos[k], hi - (n - 1 - k) * gap);
    for (let k = 0; k < n; k++) pos[k] = Math.max(pos[k], lo + k * gap);
  }
  const out = new Array(n);
  order.forEach((i, k) => { out[i] = pos[k]; });
  return out;
}

const overlap = (a, b) => !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
// 线段 (ax, ay)–(bx, by) 有没有穿过矩形 o（Liang–Barsky 裁剪）
function segHits(ax, ay, bx, by, o) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - o.x0], [dx, o.x1 - ax], [-dy, ay - o.y0], [dy, o.y1 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
/**
 * 点旁标注的贪心避让（照原页）：每个标注依次试「右、左、右上 / 左上、右下 / 左下、正上、正下」，越试越远，
 * 第一个落在 bounds 里又不压着已有东西的位置就用。
 *   items      [{ x, y, r, w, h, must, id? }]：点的位置与半径、标注的宽高；must = 实在没地方也要放（落点的档名签）——
 *              它多试两圈更远的位置，还是没有空位就挑「压着别的东西最少」的那个；id = 这个标注是谁（不给就用序号）
 *   bounds     { x0, x1, y0, y1 }
 *   obstacles  [{ x0, x1, y0, y1, of?, pad? }]：点、线这些不能压的。pad = 别的标注要离它多远（of = 它是哪个标注自己的点，
 *              那个标注不受 pad 管——签本来就该贴着自己的点）
 *   gap        标注离自己的点多远（默认 4）
 *   clear      必放的标注之间至少隔多远（默认 0 = 不压着就行）。给了它（> 0）就是「贴身」排法——窄屏上档名签只剩一个字、
 *              旁边没有模型名，两个签挨在两个点中间就分不清各指哪个：
 *                · 贴着点的位置除了左右上下再试四个斜角，尽量让签挨着自己的点；
 *                · 签与签、签与别的落点（带 pad 的障碍）之间隔开，离自己的点总比离别人的近；
 *                · 只能放远处（要画引线）时，引线不许从别的落点 / 别的签身上穿过去。
 * 返回与 items 同序的 { x, y, far } | null（x, y = 标注左上角；far = 离点远、该画一根引线；放不下的非 must 项是 null）。
 */
export function placeLabels(items, { bounds, obstacles = [], gap = 4, clear = 0 } = {}) {
  const placed = obstacles.slice();
  const inside = (b) => b.x0 >= bounds.x0 && b.x1 <= bounds.x1 && b.y0 >= bounds.y0 && b.y1 <= bounds.y1;
  return items.map((it, i) => {
    const { x, y, w, h } = it, r = it.r || 0, me = it.id ?? i, snug = clear > 0 && !!it.must;
    const others = (o) => !!o.pad && o.of !== me;
    // 别人的落点 / 档名签：按 pad 放大了再比
    const grown = (o) => (others(o) ? { x0: o.x0 - o.pad, x1: o.x1 + o.pad, y0: o.y0 - o.pad, y1: o.y1 + o.pad } : o);
    const slots = [];
    for (const d of it.must ? [0, 14, 28, 44, 60] : [0, 14, 28]) {
      slots.push([x + r + gap + d, y - h / 2 - d * 0.6], [x - r - gap - d - w, y - h / 2 - d * 0.6],
        [x + r + gap + d, y - h / 2 + d * 0.6], [x - r - gap - d - w, y - h / 2 + d * 0.6],
        [x - w / 2, y - r - gap - 1 - h - d], [x - w / 2, y + r + gap + 1 + d]);
      if (snug && d === 0) {
        const k = (r + gap) * Math.SQRT1_2;   // 斜角：签的一个角抵在离点心 r + gap 的地方
        slots.push([x + k, y - k - h], [x - k - w, y - k - h], [x + k, y + k], [x - k - w, y + k]);
      }
    }
    const boxOf = ([bx, by]) => ({ x0: bx - 1, x1: bx + w + 1, y0: by, y1: by + h });
    const reach = ([bx, by]) => { const cx = clamp(x, bx, bx + w), cy = clamp(y, by, by + h); return { cx, cy, far: Math.hypot(cx - x, cy - y) > r + 8 }; };
    const free = (s, b) => {
      // 自己的点不算障碍：各个位置本来就是绕着它摆的（斜角那四个会蹭到它的外接方框）
      if (!inside(b) || placed.some((o) => !(snug && o.of === me) && overlap(b, grown(o)))) return false;
      if (!snug) return true;
      const { cx, cy, far } = reach(s);
      return !far || !placed.some((o) => others(o) && segHits(x, y, cx, cy, o));
    };
    const done = (s, b) => {
      placed.push(snug ? { ...b, of: me, pad: clear } : b);
      return { x: s[0], y: s[1], far: reach(s).far };
    };
    for (const s of slots) {
      const b = boxOf(s);
      if (free(s, b)) return done(s, b);
    }
    if (!it.must) return null;
    // 非放不可：界内的位置里挑压得最少的（一样少取更近的）；都出界就把右侧那个推回界内
    let best = null, least = Infinity;
    for (const s of slots) {
      const b = boxOf(s);
      if (!inside(b)) continue;
      let cost = 0;
      for (const o of placed) cost += overlapArea(b, grown(o));
      if (cost < least) { least = cost; best = s; }
    }
    if (best) return done(best, boxOf(best));
    const s = [clamp(slots[0][0], bounds.x0 + 1, Math.max(bounds.x0 + 1, bounds.x1 - w - 1)), clamp(slots[0][1], bounds.y0, Math.max(bounds.y0, bounds.y1 - h))];
    return done(s, boxOf(s));
  });
}

/**
 * 提示框放哪（照原页）：先放点的右边、竖向居中；右边放不下放左边；左右都放不下（手机竖屏）就横向夹在图内、
 * 放到点的下方，下方不够放上方。(px, py) = 点在容器里的位置，tw × th = 提示框大小，W × H = 容器大小。→ { x, y }
 */
export function placeTip(px, py, tw, th, W, H, off = 14) {
  let x = px + off, y = py - th / 2;
  if (x + tw > W) x = px - tw - off;
  if (x < 0) {
    x = clamp(px - tw / 2, 0, Math.max(0, W - tw));
    y = py + 18 + th <= H || py - 18 - th < 0 ? py + 18 : py - 18 - th;
  } else y = clamp(y, 0, Math.max(0, H - th));
  return { x, y };
}

// —— 厂商：配色槽位与形状（照原页：颜色按固定槽位，形状区分海外 / 国内 / 第三方平台）——
export const VCOLOR = {
  openai: 's1', anthropic: 's2', gemini: 's6', muse: 's7', grok: 's8',
  zhipu: 's1', mimo: 's2', hunyuan: 's3', qwen: 's4', stepfun: 's5', kimi: 's7', minimax: 's8',
  deepseek: 's6', nvidia: 's3', mistral: 's4', tm: 's5', other: 'muted', other_cn: 'muted',
  tp_copilot: 's1', tp_jetbrains: 's5', tp_kilo: 's3', tp_openclaw_hermes: 's4', tp_ollama_cloud: 's8',
  tp_open_model_subs: 's6', tp_poe_clients: 's7', tp_volcengine: 's2', tp_qiniu_aiping: 's4', tp_codebuddy_workbuddy: 's3',
  tp_cursor: 's2', tp_windsurf_devin: 's6', tp_trae: 's1', tp_comate: 's5', tp_ppio: 's7', tp_jdcloud: 's8',
  tp_cline_roo_continue: 's5', tp_opencode: 's8', tp_warp: 's7', tp_synthetic: 's3', tp_nanogpt: 's1', tp_command_code: 's4',
  tp_scnet: 's4', tp_huawei_maas: 's6', tp_vercel_tokenpass: 's2', tp_charm_hyper: 's5',
};
/** 八个槽位的色值，浅 / 深各一套（原页 .viz-root 的 --s1…--s8）。 */
export const VENDOR_SLOTS = {
  light: { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', s5: '#e87ba4', s6: '#008300', s7: '#4a3aa7', s8: '#e34948' },
  dark: { s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500', s5: '#d55181', s6: '#008300', s7: '#9085e9', s8: '#e66767' },
};
/** 厂商键 → 槽位（'s1'…'s8'；不认识的 / 「其他」→ 'muted'，用次要文字色画）。 */
export const vendorSlot = (vkey) => VCOLOR[vkey] || 'muted';

// 评分快照里的 creator（Artificial Analysis 的厂商名）→ 图上的厂商键
const MAKERS = {
  anthropic: 'anthropic', openai: 'openai', google: 'gemini', meta: 'muse', xai: 'grok', spacexai: 'grok',
  zai: 'zhipu', zhipu: 'zhipu', zhipuai: 'zhipu', xiaomi: 'mimo', tencent: 'hunyuan', alibaba: 'qwen', stepfun: 'stepfun',
  kimi: 'kimi', moonshot: 'kimi', moonshotai: 'kimi', minimax: 'minimax', deepseek: 'deepseek', nvidia: 'nvidia',
  mistral: 'mistral', mistralai: 'mistral', thinkingmachines: 'tm',
};
const CN_OTHER = new Set(['longcat', 'inclusionai', 'baidu', 'bytedance', 'iflytek', 'sensetime', '01ai', 'baichuan']);
const CN_KEYS = new Set(['zhipu', 'deepseek', 'minimax', 'qwen', 'mimo', 'kimi', 'stepfun', 'hunyuan', 'other_cn']);
/** creator 名字 → 厂商键；不认识的归「其他」（国内的几家归 other_cn，形状跟着走）。 */
export function makerKey(creator) {
  const k = String(creator || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!k) return 'other';
  return MAKERS[k] || (CN_OTHER.has(k) ? 'other_cn' : 'other');
}
/**
 * 一个候选点按谁的颜色画：订阅 → Anthropic；按 plan 计价的 → 那个 plan 的提供商（服务端给的 vkey）；按 API 价的 → 模型厂商。
 * 和原页一致：plan 点跟着卖 plan 的那家走，API 点跟着模型厂商走。
 */
export function vendorKeyOf(c) {
  if (!c) return 'other';
  if (c.basis === 'sub') return 'anthropic';
  if (c.basis === 'plan' && c.vkey) return c.vkey;
  return makerKey(c.creator);
}
/** 形状：海外 = 圆，国内 = 菱形，第三方平台 = 方。meta = 图谱里那家的 { cn, tp }（没有就按键名猜）。 */
export function shapeKind(vkey, meta) {
  if (meta ? meta.tp : /^tp_/.test(vkey || '')) return 'square';
  if (meta ? meta.cn : CN_KEYS.has(vkey)) return 'diamond';
  return 'circle';
}
/** 以 (cx, cy) 为心、半径 r 的一个形状的路径段（可以多段拼成一条 path，全图的点就是这么画的）。 */
export function shapePath(kind, r, cx = 0, cy = 0) {
  const f = (v) => +v.toFixed(2);
  if (kind === 'square') { const d = r * 0.9; return `M${f(cx - d)} ${f(cy - d)}h${f(2 * d)}v${f(2 * d)}h${f(-2 * d)}Z`; }
  if (kind === 'diamond') { const d = r * 1.25; return `M${f(cx)} ${f(cy - d)}L${f(cx + d)} ${f(cy)}L${f(cx)} ${f(cy + d)}L${f(cx - d)} ${f(cy)}Z`; }
  return `M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0`;
}

// —— 全图的点 ——
/** 图谱点表的一行 [vkey, plan, slug, family, effort, score, cost, src] → 对象。 */
export function decodePoint(row) {
  const [vkey, plan, slug, family, effort, score, cost, src] = row || [];
  return { vkey, plan, slug, family, effort, score, cost, src };
}
