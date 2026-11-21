// 声明式应用 chart 积木（components/appview/ChartBlock.svelte）的纯函数：数据整理、刻度、坐标、几何、提示框定位、数字与时间格式。
// 不碰 DOM、不读任何状态——组件只管画和手势，算数都在这里，node --test 直接测（appChartMath.test.js）。
//
// 积木形状：{ kind: 'line' | 'bar', series: [{ name, points: [[x, y]] }]（≤ 8 组、每组 ≤ 500 点），
//   x?: { label?, type?: 'category' | 'number' | 'time' }, y?: { label?, unit? }, height?（120～480） }
// 服务端已经截过长度；这里照样防一手（插件数据什么都可能有）：坏点跳过、超量截断，绝不抛。
//
// 横轴三种：
//   category：x 按字符串认，按各组里第一次出现的先后排；折线画在每格中线上，柱状每格一组柱。
//   number  ：x 是数；折线按数值等比例摆；柱状把不同的 x 从小到大当格子排（柱子要等宽，按数值摆会挤在一起）。
//   time    ：x 是毫秒时间戳、秒级时间戳（绝对值 < 1e11 的数当秒）或日期字符串（Date 能解析的）；摆法同 number，刻度对齐到整点 / 整天 / 月初 / 年初。
// 纵轴：「好看的」步长（1 / 2 / 2.5 / 5 × 10^k）；全是整数的数据步长不小于 1；柱状一定含 0（柱子从 0 长出来）。

export const CHART_H_MIN = 120;
export const CHART_H_MAX = 480;
export const CHART_H_DEFAULT = 220;
export const MAX_SERIES = 8;
export const MAX_POINTS = 500;
export const X_TYPES = ['category', 'number', 'time'];

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 积木的高度：夹在 120～480，没给或不是数用 220。 */
export function clampHeight(h) {
  const n = Number(h);
  return fin(n) && n > 0 ? Math.round(clamp(n, CHART_H_MIN, CHART_H_MAX)) : CHART_H_DEFAULT;
}

/** 横轴类型：认不出的当 category。 */
export const xTypeOf = (x) => (x && X_TYPES.includes(x.type) ? x.type : 'category');

/** 时间值 → 毫秒；认不出回 null。数字绝对值 < 1e11 当秒（1e11 秒是 5138 年，毫秒则是 1973 年，两边不会撞）。 */
export function parseTime(v) {
  if (fin(v)) return Math.abs(v) < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseTime(Number(s));
    // 纯日期（2026-11-16 / 2026-11）按本地午夜算：Date.parse 把它当 UTC 午夜，UTC 以西的时区按本地显示就整体早一天。
    // 带时刻的串照 Date.parse（没写时区的按本地、写了的按它写的）
    const dm = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
    if (dm) {
      const y = +dm[1], mo = +dm[2] - 1, d = dm[3] ? +dm[3] : 1;
      const t = new Date(y, mo, d);
      return t.getFullYear() === y && t.getMonth() === mo && t.getDate() === d ? t.getTime() : null;
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 纵轴值：数或数字串；别的（null、空串、NaN）当缺值。 */
export function parseY(v) {
  if (fin(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 横轴值按类型规整：category → 字符串；number → 数；time → 毫秒。认不出回 null（这个点跳过）。 */
export function parseX(v, type) {
  if (type === 'time') return parseTime(v);
  if (type === 'number') {
    if (fin(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    return null;
  }
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (fin(v) || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * 整理数据：→ { xType, kind, series: [{ name, si, points: [{ x, y }] }], keys }
 * keys = 横轴上出现过的全部 x（category 按出现先后，number / time 从小到大、去重）。
 * si 是这一组在原数组里的位置（配色按它取，藏掉别的组时颜色不跟着变）。
 * 折线的 number / time 点按 x 排好序（插件给乱序也画得对）；category 保留原顺序。
 */
export function prepare(block) {
  const kind = block && block.kind === 'bar' ? 'bar' : 'line';
  const xType = xTypeOf(block && block.x);
  const raw = Array.isArray(block && block.series) ? block.series.slice(0, MAX_SERIES) : [];
  const series = [];
  const seen = new Map();
  const keys = [];
  raw.forEach((s, si) => {
    const pts = [];
    const list = Array.isArray(s && s.points) ? s.points.slice(0, MAX_POINTS) : [];
    for (const p of list) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = parseX(p[0], xType);
      if (x == null) continue;
      pts.push({ x, y: parseY(p[1]) });
      const k = xType === 'category' ? x : String(x);
      if (!seen.has(k)) { seen.set(k, x); keys.push(x); }
    }
    if (xType !== 'category') pts.sort((a, b) => a.x - b.x);
    series.push({ name: typeof (s && s.name) === 'string' ? s.name : '', si, points: pts });
  });
  if (xType !== 'category') keys.sort((a, b) => a - b);
  return { kind, xType, series, keys };
}

// —— 刻度 ——
/** 「好看的」步长：span 分成约 count 段，取 1 / 2 / 2.5 / 5 × 10^k 里离得最近又不比它小的。integer = 至少 1。 */
export function niceStep(span, count = 5, { integer = false } = {}) {
  const raw = Math.abs(span) / Math.max(1, count);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const f = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  const step = f * p;
  // 整数数据：步长不能是小数（刻度 0.5 个人没意义）；不到 1 取 1，恰好 2.5 退到 2（3 不「好看」）
  if (integer && !Number.isInteger(step)) return step < 1 ? 1 : step === 2.5 ? 2 : Math.ceil(step);
  return step;
}

// 浮点误差修掉（0.1 + 0.2 这类），按步长的小数位数取整
const decimalsOf = (step) => {
  if (!fin(step) || step <= 0) return 0;
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]) + (s.split('e-')[0].split('.')[1] || '').length;
  return (s.split('.')[1] || '').length;
};
const fix = (v, d) => (d > 0 ? Number(v.toFixed(Math.min(d, 12))) : Math.round(v));

/**
 * 纵轴刻度：{ lo, hi, step, ticks }，lo / hi 是外扩到步长整数倍的范围，ticks 从 lo 到 hi（含两端）。
 * 只有一个值（lo == hi）时上下各让出一点：0 → [0, 1]；别的值按它的量级让。
 */
export function niceTicks(lo, hi, count = 5, { integer = false } = {}) {
  if (!fin(lo) || !fin(hi)) { lo = 0; hi = 1; }
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else {
      const pad = Math.abs(lo) * 0.1 || 1;
      if (lo > 0) { hi = lo + pad; lo = Math.max(0, lo - pad); }
      else { lo -= pad; hi = Math.min(0, hi + pad); }
    }
  }
  const step = niceStep(hi - lo, count, { integer });
  const d = decimalsOf(step);
  const a = fix(Math.floor(lo / step + 1e-9) * step, d);
  const b = fix(Math.ceil(hi / step - 1e-9) * step, d);
  const ticks = [];
  for (let k = 0, v = a; v <= b + step * 1e-6 && k < 50; k++, v = fix(a + k * step, d)) ticks.push(v);
  return { lo: a, hi: ticks[ticks.length - 1] ?? b, step, ticks };
}

/** 纵轴范围：可见的组里所有有值的点。柱状含 0；折线全是非负且最小值不到最大值的 35% 时也从 0 起（看起来不夸大起伏）。 */
export function yDomain(series, kind) {
  let lo = Infinity, hi = -Infinity, integer = true, any = false;
  for (const s of series) for (const p of s.points) {
    if (p.y == null) continue;
    any = true;
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
    if (!Number.isInteger(p.y)) integer = false;
  }
  if (!any) return { lo: 0, hi: 1, integer: true, empty: true };
  if (kind === 'bar') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  else if (lo >= 0 && lo <= hi * 0.35) lo = 0;
  return { lo, hi, integer, empty: false };
}

// 时间刻度的候选步长（毫秒）：秒 / 分 / 时 / 天 / 周；月和年按日历走（长度不固定），单独处理
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const FIXED_STEPS = [
  [SEC, 'second'], [5 * SEC, 'second'], [15 * SEC, 'second'], [30 * SEC, 'second'],
  [MIN, 'minute'], [5 * MIN, 'minute'], [15 * MIN, 'minute'], [30 * MIN, 'minute'],
  [HOUR, 'hour'], [3 * HOUR, 'hour'], [6 * HOUR, 'hour'], [12 * HOUR, 'hour'],
  [DAY, 'day'], [2 * DAY, 'day'], [7 * DAY, 'week'],
];
const MONTH_STEPS = [1, 2, 3, 6];

/**
 * 时间刻度：{ unit: 'second'|'minute'|'hour'|'day'|'week'|'month'|'year', ticks: ms[] }，都落在 [lo, hi] 里。
 * 一天以内的步长按本地时间对齐（整点、整 15 分……）；天 / 周对齐到本地零点（周从周一起）；月对齐到月初、年对齐到年初。
 */
export function timeTicks(lo, hi, count = 5) {
  if (!fin(lo) || !fin(hi)) return { unit: 'day', ticks: [] };
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) return { unit: 'minute', ticks: [lo] };
  const want = (hi - lo) / Math.max(1, count);
  const fixed = FIXED_STEPS.find(([ms]) => ms >= want);
  if (fixed) {
    const [step, unit] = fixed;
    const ticks = [];
    if (step < DAY) {
      // 按本地时间对齐：减去时区偏移再取整（夏令时那一天差一小时，可以接受）
      const off = new Date(lo).getTimezoneOffset() * MIN;
      let v = Math.ceil((lo - off) / step) * step + off;
      for (let k = 0; v <= hi && k < 60; k++, v += step) ticks.push(v);
    } else {
      const d = new Date(lo);
      d.setHours(0, 0, 0, 0);
      if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const n = Math.round(step / DAY);
      while (d.getTime() < lo) d.setDate(d.getDate() + n);
      for (let k = 0; d.getTime() <= hi && k < 60; k++) { ticks.push(d.getTime()); d.setDate(d.getDate() + n); }
    }
    return { unit, ticks };
  }
  const months = want / (30.44 * DAY);
  const mStep = MONTH_STEPS.find((m) => m >= months);
  const d = new Date(lo);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  const ticks = [];
  if (mStep) {
    d.setMonth(Math.floor(d.getMonth() / mStep) * mStep);
    while (d.getTime() < lo) d.setMonth(d.getMonth() + mStep);
    for (let k = 0; d.getTime() <= hi && k < 60; k++) { ticks.push(d.getTime()); d.setMonth(d.getMonth() + mStep); }
    return { unit: 'month', ticks };
  }
  const years = want / (365.25 * DAY);
  const yStep = niceStep(years * count, count, { integer: true });
  d.setMonth(0);
  d.setFullYear(Math.floor(d.getFullYear() / yStep) * yStep);
  while (d.getTime() < lo) d.setFullYear(d.getFullYear() + yStep);
  for (let k = 0; d.getTime() <= hi && k < 60; k++) { ticks.push(d.getTime()); d.setFullYear(d.getFullYear() + yStep); }
  return { unit: 'year', ticks };
}

// —— 格式 ——
const nf = new Map();
function numFmt(locale, opts) {
  const k = locale + '|' + JSON.stringify(opts);
  let f = nf.get(k);
  if (!f) {
    try { f = new Intl.NumberFormat(locale || undefined, opts); } catch { f = new Intl.NumberFormat(undefined, opts); }
    nf.set(k, f);
  }
  return f;
}

/**
 * 数字：步长给了就按步长的小数位（刻度 0.5 / 1.0 / 1.5 别成了 0.5 / 1 / 1.5）；不给按值本身最多 2 位小数。
 * 绝对值 ≥ 10000 用紧凑写法（10K / 1.2M，中文 1万 / 1.2亿）——轴上一个样式，不夹杂。
 */
export function fmtNum(v, { step, locale = 'zh-CN', compact } = {}) {
  if (!fin(v)) return '';
  const big = compact ?? Math.abs(v) >= 10000;
  if (big) return numFmt(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const d = fin(step) && step > 0 ? Math.min(6, decimalsOf(step)) : null;
  const opts = d != null ? { minimumFractionDigits: d, maximumFractionDigits: d } : { maximumFractionDigits: 2 };
  return numFmt(locale, opts).format(v);
}

const dtf = new Map();
function dateFmt(locale, opts) {
  const k = locale + '|' + JSON.stringify(opts);
  let f = dtf.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat(locale || undefined, opts); } catch { f = new Intl.DateTimeFormat(undefined, opts); }
    dtf.set(k, f);
  }
  return f;
}
const TIME_OPTS = {
  second: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
  minute: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  hour: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  day: { month: 'numeric', day: 'numeric' },
  week: { month: 'numeric', day: 'numeric' },
  month: { year: 'numeric', month: 'short' },
  year: { year: 'numeric' },
};
/** 时间刻度标签：按刻度单位取粒度（时分 / 月日 / 年月 / 年）。 */
export function fmtTime(ms, unit = 'day', locale = 'zh-CN') {
  if (!fin(ms)) return '';
  return dateFmt(locale, TIME_OPTS[unit] || TIME_OPTS.day).format(ms);
}
/** 提示框里的完整时间：同一天以内的数据带时分，跨天的带日期。 */
export function fmtTimeFull(ms, spanMs, locale = 'zh-CN') {
  if (!fin(ms)) return '';
  const opts = spanMs < DAY * 2
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : spanMs < DAY * 400 ? { year: 'numeric', month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'short' };
  return dateFmt(locale, opts).format(ms);
}

/** 文字宽度估算（px）：中日韩全角按 1 个字号宽，别的按 0.6 个。SVG 里没有 DOM 也能排版（测试也能跑）。 */
export function textW(s, px = 11) {
  let w = 0;
  for (const ch of String(s ?? '')) w += /[⺀-鿿가-힯＀-￯]/.test(ch) ? px : px * 0.6;
  return w;
}
/** 截到 max 个字，超了带省略号。 */
export function clip(s, max = 14) {
  const a = Array.from(String(s ?? ''));
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : a.join('');
}

/** 隔几个标一个：n 个标签、每个最宽 labelW、可用宽度 avail，相邻至少留 gap → 步长（1 = 全标）。 */
export function labelStride(n, avail, labelW, gap = 10) {
  if (n <= 1 || !(avail > 0)) return 1;
  const per = avail / n;
  return Math.max(1, Math.ceil((labelW + gap) / Math.max(1, per)));
}

// —— 几何 ——
/**
 * 整张图的几何：组件照着画就行。
 *   opts: { width, height, hidden: Set<si>, locale }
 * 回：{
 *   width, height, kind, xType, empty,
 *   box: { l, t, w, h }（图版）,
 *   yTicks: [{ v, y, label }], zeroY（柱子的基线 / 0 刻度线位置）,
 *   xTicks: [{ x, label }],
 *   series: [{ si, name, hidden, path, dots: [{ x, y, v }], bars: [{ x, y, w, h, v, neg }] }],
 *   slots: [{ x, label, items: [{ si, name, v }] }]   // 悬停 / 点按的落点：每个横轴位置一个
 * }
 */
export function buildChart(block, { width = 320, height = CHART_H_DEFAULT, hidden = new Set(), locale = 'zh-CN' } = {}) {
  const data = prepare(block);
  const { kind, xType, keys } = data;
  const vis = data.series.filter((s) => !hidden.has(s.si));
  const dom = yDomain(vis, kind);
  const yt = niceTicks(dom.lo, dom.hi, height < 180 ? 3 : 5, { integer: dom.integer });
  const yLabels = yt.ticks.map((v) => fmtNum(v, { step: yt.step, locale }));

  // 图版：左边按最宽的纵轴标签留，底下留给横轴标签
  const l = Math.max(24, Math.ceil(Math.max(...yLabels.map((s) => textW(s))) + 10));
  const t = 10, r = 12, b = 24;
  const box = { l, t, w: Math.max(1, width - l - r), h: Math.max(1, height - t - b) };
  const Y = (v) => box.t + box.h - ((v - yt.lo) / (yt.hi - yt.lo || 1)) * box.h;
  const yTicks = yt.ticks.map((v, i) => ({ v, y: Y(v), label: yLabels[i] }));
  const zeroY = Y(clamp(0, yt.lo, yt.hi));

  // 横轴：格子（category 与柱状）或连续（折线的 number / time）
  const banded = kind === 'bar' || xType === 'category';
  const n = keys.length;
  const keyIndex = new Map(keys.map((k, i) => [xType === 'category' ? k : String(k), i]));
  const idxOf = (x) => keyIndex.get(xType === 'category' ? x : String(x));
  const band = n ? box.w / n : box.w;
  const xlo = n ? keys[0] : 0, xhi = n ? keys[n - 1] : 1;
  const X = banded
    ? (x) => box.l + (idxOf(x) + 0.5) * band
    : (x) => (xhi === xlo ? box.l + box.w / 2 : box.l + ((x - xlo) / (xhi - xlo)) * box.w);
  const spanMs = xType === 'time' && n ? xhi - xlo : 0;
  const keyLabel = (k, unit) => (xType === 'time' ? (unit ? fmtTime(k, unit, locale) : fmtTimeFull(k, spanMs, locale)) : xType === 'number' ? fmtNum(k, { locale }) : String(k));

  // 横轴刻度
  let xTicks = [];
  if (banded) {
    const unit = xType === 'time' ? timeTicks(xlo, xhi, Math.max(1, n - 1)).unit : null;
    // 柱状的时间格：标签粒度按数据跨度挑（一天内的标时分、跨月的标年月）
    const labels = keys.map((k) => clip(keyLabel(k, unit), 12));
    const stride = labelStride(n, box.w, Math.max(0, ...labels.map((s) => textW(s))));
    xTicks = keys.map((k, i) => ({ x: box.l + (i + 0.5) * band, label: labels[i] })).filter((_, i) => i % stride === 0);
  } else if (xType === 'time') {
    const tt = timeTicks(xlo, xhi, Math.max(2, Math.floor(box.w / 90)));
    xTicks = tt.ticks.map((v) => ({ x: X(v), label: fmtTime(v, tt.unit, locale) }));
  } else if (n) {
    const xt = xhi === xlo ? { ticks: [xlo], step: 1 } : niceTicks(xlo, xhi, Math.max(2, Math.floor(box.w / 80)));
    xTicks = xt.ticks.filter((v) => v >= xlo - 1e-9 && v <= xhi + 1e-9).map((v) => ({ x: X(v), label: fmtNum(v, { step: xt.step, locale }) }));
  }
  // 两端的标签别出图：落到图版外的去掉（连续轴的刻度都在数据范围内，这里只防估算误差）
  xTicks = xTicks.filter((tk) => tk.x >= box.l - 1 && tk.x <= box.l + box.w + 1);

  // 各组
  const nv = vis.length;
  const groupW = Math.min(band * 0.72, nv * 24 + (nv - 1) * 2);
  const barW = nv ? Math.max(1, (groupW - (nv - 1) * 2) / nv) : 0;
  const series = data.series.map((s) => {
    const off = hidden.has(s.si);
    const out = { si: s.si, name: s.name, hidden: off, path: '', dots: [], bars: [] };
    if (off) return out;
    if (kind === 'line') {
      let d = '', pen = false;
      for (const p of s.points) {
        if (p.y == null) { pen = false; continue; }
        const x = X(p.x), y = Y(p.y);
        d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        pen = true;
        out.dots.push({ x, y, v: p.y });
      }
      out.path = d;
    } else {
      const j = vis.indexOf(s);
      for (const p of s.points) {
        if (p.y == null) continue;
        const cx = X(p.x) - groupW / 2 + j * (barW + 2);
        const y = Y(p.y);
        const top = Math.min(y, zeroY), h = Math.abs(zeroY - y);
        out.bars.push({ x: cx, y: top, w: barW, h, v: p.y, neg: p.y < 0 });
      }
    }
    return out;
  });

  // 悬停落点：每个横轴位置列出各可见组在这里的值（没有点的组不列）
  const slots = keys.map((k) => ({ x: X(k), key: k, label: keyLabel(k, null), items: [] }));
  for (const s of vis) for (const p of s.points) {
    if (p.y == null) continue;
    const i = idxOf(p.x);
    if (i == null) continue;
    const it = slots[i].items;
    // 同一组同一个 x 有多个点：留最后一个（和画出来的折线终点一致）
    const at = it.findIndex((q) => q.si === s.si);
    const item = { si: s.si, name: s.name, v: p.y };
    if (at >= 0) it[at] = item; else it.push(item);
  }

  return { width, height, kind, xType, empty: dom.empty, box, yTicks, zeroY, xTicks, series, slots: slots.filter((sl) => sl.items.length), band };
}

/** 离 px 最近的落点下标；没有落点回 -1。 */
export function nearestSlot(slots, px) {
  let best = -1, bd = Infinity;
  (slots || []).forEach((s, i) => { const d = Math.abs(s.x - px); if (d < bd) { bd = d; best = i; } });
  return best;
}

/** 提示框位置：默认在落点右边；右边放不下放左边；两边都放不下就压在图里居中。回左上角 { x, y }。 */
export function placeTip(px, py, tw, th, W, H, off = 12) {
  let x = px + off;
  if (x + tw > W) x = px - tw - off;
  if (x < 0) x = clamp(px - tw / 2, 0, Math.max(0, W - tw));
  const y = clamp(py - th / 2, 0, Math.max(0, H - th));
  return { x, y };
}

/** 第 si 组的颜色变量（ContextBreakdown 那套官方图表类目色 --cx-1…8；配色跟着组的原位置，藏掉别的组不重排）。 */
export const seriesColor = (si) => 'var(--cx-' + ((si % MAX_SERIES) + 1) + ')';
