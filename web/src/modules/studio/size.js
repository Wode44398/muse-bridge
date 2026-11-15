// 尺寸参数（ParamSpec type:'size'，方案 §10）的纯逻辑——与服务端 modules/studio/server/cards/size.mjs 同一套语义
// （扩展边界：前端不 import 服务端代码，这里是同规则的前端版，单测对拍同样的用例）。
//   值：字符串档（options 里的：''=不传、'auto'、'original'、'1K'、'1024x1024'…）或自由宽高 { width, height }。
//   spec.custom：{ width: { min, max, multipleOf }, height: {…}, aspect: { min, max }（宽 / 高）, pixels: { min, max }, exact }
//   exact:false = 上游会就近取整，不查倍数。

const SEP = /^\s*(\d{1,5})\s*[x×*X]\s*(\d{1,5})\s*$/;

/** {width,height} / 'WxH' / 'W*H' / 'W×H' → { width, height }；别的回 null */
export function parseSize(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const w = Number(v.width), h = Number(v.height);
    return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (typeof v === 'string') {
    const m = SEP.exec(v);
    if (m) { const w = Number(m[1]), h = Number(m[2]); if (w > 0 && h > 0) return { width: w, height: h }; }
  }
  return null;
}

/** 违反了规则的哪几条：[{ code: min|max|multiple|aspect|pixels, side?, n?, min?, max? }]，空 = 合法 */
export function sizeProblems(rule, s) {
  const out = [];
  if (!rule || !s) return out;
  for (const side of ['width', 'height']) {
    const r = rule[side] || {};
    const v = s[side];
    if (r.min != null && v < r.min) out.push({ code: 'min', side, n: r.min });
    if (r.max != null && v > r.max) out.push({ code: 'max', side, n: r.max });
    if (rule.exact !== false && r.multipleOf > 1 && v % r.multipleOf) out.push({ code: 'multiple', side, n: r.multipleOf });
  }
  const ratio = s.width / s.height;
  const a = rule.aspect;
  if (a && ((a.min != null && ratio < a.min - 1e-9) || (a.max != null && ratio > a.max + 1e-9))) out.push({ code: 'aspect', min: a.min, max: a.max });
  const px = s.width * s.height;
  const p = rule.pixels;
  if (p && ((p.min != null && px < p.min) || (p.max != null && px > p.max))) out.push({ code: 'pixels', min: p.min, max: p.max });
  return out;
}

/** 这个值是不是自由宽高（而不是某个档位字符串） */
export const isCustomSize = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 一个 size 值的问题：档位 / 不传 → []；自由宽高 → 规则问题；没有 custom 却给了宽高 → [{ code: 'custom' }] */
export function sizeIssues(spec, v) {
  if (!isCustomSize(v)) return [];
  const s = parseSize(v);
  if (!s) return [{ code: 'invalid' }];
  if (!spec?.custom) return [{ code: 'custom' }];
  return sizeProblems(spec.custom, s);
}

/** 进自定义时的起始宽高：当前值能读成宽高就用它，否则用卡上的对象默认值，再否则按规则挑一个合法的 1024 级尺寸 */
export function customStart(spec, v) {
  const cur = parseSize(v);
  if (cur) return cur;
  const d = parseSize(spec?.default);
  if (d) return d;
  const r = spec?.custom || {};
  const m = Math.max(r.width?.multipleOf || 1, r.height?.multipleOf || 1);
  let side = Math.round(Math.sqrt(Math.max(1024 * 1024, r.pixels?.min || 0)) / m) * m;
  for (const k of ['width', 'height']) {
    if (r[k]?.max != null) side = Math.min(side, r[k].max);
    if (r[k]?.min != null) side = Math.max(side, r[k].min);
  }
  return { width: side, height: side };
}

/**
 * 把一个尺寸（原图）挪进规则里——与服务端 cards/size.mjs 的 fitSize 同一算法（单测对拍）：先夹宽高比、再夹总像素、再夹边长，
 * 最后落到倍数上（几种取整里挑合法且比例 / 面积最接近的）。回 { width, height, adapted }
 */
export function fitSize(rule, s) {
  if (!rule) return { ...s, adapted: false };
  if (!sizeProblems(rule, s).length) return { width: s.width, height: s.height, adapted: false };
  let r = s.width / s.height;
  if (rule.aspect?.min != null) r = Math.max(r, rule.aspect.min);
  if (rule.aspect?.max != null) r = Math.min(r, rule.aspect.max);
  let px = s.width * s.height;
  if (rule.pixels?.min != null) px = Math.max(px, rule.pixels.min);
  if (rule.pixels?.max != null) px = Math.min(px, rule.pixels.max);
  let w = Math.sqrt(px * r), h = Math.sqrt(px / r);
  const k = Math.min(1, rule.width?.max ? rule.width.max / w : 1, rule.height?.max ? rule.height.max / h : 1);
  w *= k; h *= k;
  const up = Math.max(1, rule.width?.min ? rule.width.min / w : 1, rule.height?.min ? rule.height.min / h : 1);
  w *= up; h *= up;
  const mw = rule.exact !== false && rule.width?.multipleOf > 1 ? rule.width.multipleOf : 1;
  const mh = rule.exact !== false && rule.height?.multipleOf > 1 ? rule.height.multipleOf : 1;
  const cands = [];
  for (const fw of [Math.floor, Math.ceil, Math.round]) for (const fh of [Math.floor, Math.ceil, Math.round]) cands.push({ width: Math.max(mw, fw(w / mw) * mw), height: Math.max(mh, fh(h / mh) * mh) });
  const score = (c) => Math.abs(Math.log((c.width / c.height) / (s.width / s.height))) * 4 + Math.abs(Math.log((c.width * c.height) / px));
  const ok = cands.filter((c) => !sizeProblems(rule, c).length).sort((a, b) => score(a) - score(b));
  const best = ok[0] || cands.sort((a, b) => sizeProblems(rule, a).length - sizeProblems(rule, b).length || score(a) - score(b))[0];
  return { width: best.width, height: best.height, adapted: true };
}

/** 问题落在哪条边：有 side 的就是那条，宽高比 / 总像素 / 结构问题两条都算（界面只给出错的框描红） */
export function badSides(issues) {
  const out = new Set();
  for (const p of issues || []) { if (p.side) out.add(p.side); else { out.add('width'); out.add('height'); } }
  return out;
}

// —— 比例 × 档位（方案 §11）——
// 自由宽高的模型不让人自己算 16 的倍数：界面给一排比例形状 + 1K / 2K / 4K，点了就换算成合规的宽高写进同一个尺寸值
// （仍然只有「尺寸」一个参数，没有单独的「比例」；宽 × 高两个框一直在，想要别的数直接改）。
export const SIZE_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];
export const SIZE_TIERS = [{ id: '1K', edge: 1024 }, { id: '2K', edge: 2048 }, { id: '4K', edge: 4096 }];
const ratioNum = (r) => { if (typeof r === 'number') return r; const [a, b] = String(r).split(':').map(Number); return a > 0 && b > 0 ? a / b : 0; };
const sameSize = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height;

/** 比例 + 长边 → 挪进规则后的宽高（比例不在规则允许范围内回 null） */
export function sizeFromRatio(rule, ratio, edge) {
  const r = ratioNum(ratio);
  if (!(r > 0) || !(edge > 0)) return null;
  const a = rule?.aspect;
  if (a && ((a.min != null && r < a.min - 1e-9) || (a.max != null && r > a.max + 1e-9))) return null;
  const f = fitSize(rule, { width: Math.round(r >= 1 ? edge : edge * r), height: Math.round(r >= 1 ? edge / r : edge) });
  return { width: f.width, height: f.height };
}

/**
 * 这个尺寸参数能不能摆「比例 × 档位」：要有自由宽高规则，而且档位里没有成套的命名预设（fal 的 square_hd / landscape_16_9 这类自己就是一套选法）。
 * 回 { ratios: ['1:1'…], tiers: [{ id, edge }] }（档位按方图换算结果去重：上限只到 1440 的模型 2K / 4K 是同一个，只留一档）或 null。
 */
export function sizeGrid(spec) {
  const rule = spec?.custom;
  if (!rule) return null;
  const named = (spec.options || []).filter((o) => typeof o.value === 'string' && o.value !== '' && o.value !== 'auto' && o.value !== 'original' && !parseSize(o.value));
  if (named.length) return null;
  const ratios = (Array.isArray(spec.ratios) && spec.ratios.length ? spec.ratios : SIZE_RATIOS).filter((r) => sizeFromRatio(rule, r, 1024));
  const tiers = [];
  const seen = new Set();
  for (const t of SIZE_TIERS) {
    const s = sizeFromRatio(rule, 1, t.edge);
    if (!s) continue;
    const k = s.width + 'x' + s.height;
    if (seen.has(k)) continue;
    // 档位比换算结果大出一截的不算数（上限 1440 的模型没有「2K」）
    if (tiers.length && Math.max(s.width, s.height) < t.edge * 0.62) continue;
    seen.add(k); tiers.push(t);
  }
  return ratios.length ? { ratios, tiers } : null;
}

/** 当前值落在格子的哪一格：{ ratio, tier }（对不上的那一维是 null）；值不是宽高（自动 / 原图）回 { ratio: null, tier: null } */
export function gridMatch(spec, v, grid = sizeGrid(spec)) {
  const s = parseSize(v);
  if (!s || !grid) return { ratio: null, tier: null };
  for (const t of grid.tiers) for (const r of grid.ratios) if (sameSize(sizeFromRatio(spec.custom, r, t.edge), s)) return { ratio: r, tier: t.id };
  return { ratio: null, tier: null };
}

/** 离这个尺寸最近的档位（按长边，对数距离）；没有尺寸回第一档 */
export function nearestTier(grid, s) {
  const tiers = grid?.tiers || [];
  if (!tiers.length) return null;
  if (!s) return tiers[0];
  const long = Math.max(s.width, s.height);
  return tiers.reduce((b, t) => (Math.abs(Math.log(t.edge / long)) < Math.abs(Math.log(b.edge / long)) ? t : b), tiers[0]);
}

/** 点一格比例：档位沿用当前的（当前是自动 / 原图就用第一档） */
export function pickRatio(spec, v, ratio, grid = sizeGrid(spec)) {
  const cur = parseSize(v);
  const m = gridMatch(spec, v, grid);
  const tier = grid.tiers.find((t) => t.id === m.tier) || nearestTier(grid, cur);
  return sizeFromRatio(spec.custom, ratio, tier ? tier.edge : 1024);
}

/** 点一档：比例沿用当前的（格子里的那一格，否则当前宽高的实际比例，自动 / 原图就用方图） */
export function pickTier(spec, v, tierId, grid = sizeGrid(spec)) {
  const cur = parseSize(v);
  const m = gridMatch(spec, v, grid);
  const tier = grid.tiers.find((t) => t.id === tierId) || grid.tiers[0];
  return sizeFromRatio(spec.custom, m.ratio || (cur ? cur.width / cur.height : 1), tier.edge) || sizeFromRatio(spec.custom, 1, tier.edge);
}

/** 显示：「2048×1152」 */
export const sizeText = (s) => (s ? `${s.width}×${s.height}` : '');

/** 宽高比的读法（1:3 / 3:1 / 16:1） */
export const ratioText = (x) => (x >= 1 ? `${+x.toFixed(2)}:1` : `1:${+(1 / x).toFixed(2)}`);
