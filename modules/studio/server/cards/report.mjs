// 按卡规范化 + 「哪些参数没照原样生效」的报告（生成工具回给 agent 看；不改变规范化结果，也不报错）。
//
// 忽略的键按整张卡判，不信 applySpecs 自己报的：有的卡只拿一部分 ParamSpec 调 applySpecs（GPT Image 旧写法、参照库精修），
// 有的卡（Google 系）根本不走 applySpecs，只有整张卡的参数表 + 最终结果才说得准。
// 回落 / 夹紧：applySpecs 报的为主；不走 applySpecs 的卡再按「给的 enum 值不在选项里、数字越界」补。

import { applySpecs, aliasConsumed } from './spec.mjs';

const given = (v) => v !== undefined && v !== null && v !== '';
const squash = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
// 各家张数的写法（同 media-phone COUNT_KEY）：卡上叫 count 时点出来
const COUNT_NAMES = new Set(['n', 'numimages', 'numberofimages', 'numoutputs', 'samplecount', 'batchsize', 'numvideos']);

/** 写错的键 → 卡上对应的键（蛇形 / 大小写 / 连字符不同，或常见的张数写法）；对不上回 undefined。 */
export function suggestKey(key, keys) {
  const k = squash(key);
  const hit = keys.find((x) => squash(x) === k);
  if (hit) return hit;
  if (COUNT_NAMES.has(k) && keys.includes('count')) return 'count';
  return undefined;
}

/**
 * 回 { params, warnings }。warnings = null（全都生效）或
 * { ignored: [{ key, suggest? }], changed: [{ key, as?, from, to?, options?, min?, max?, when? }], keys: [卡上的键], extra: 卡收不收 extra }。
 * only：只报这些键（调用方这次显式给的；模型条目的默认值、工具自己补的字段不报）。
 */
export function normalizeWithReport(card, raw = {}, flags = {}, { only } = {}) {
  const report = { ignored: [], changed: [] };
  const ctx = { ...flags, report };
  const params = card.normalize ? card.normalize(raw, ctx) : applySpecs(card.params, raw, ctx);
  return { params, warnings: buildWarnings(card, raw, params, report, only) };
}

function buildWarnings(card, raw, params, report, only) {
  const specs = card.params || [];
  const keys = specs.map((s) => s.key);
  const known = new Set([...keys, ...(card.legacyKeys || [])]);
  const want = only ? new Set(only) : null;
  const asked = (k) => !want || want.has(k);
  // 别名能搬到卡上某个键的不算忽略（aspectRatio → aspect_ratio 等）
  const aliasFrom = new Set(aliasConsumed(new Set(keys), raw).values());

  const ignored = [];
  for (const k of Object.keys(raw)) {
    if (!given(raw[k]) || known.has(k) || k in params || !asked(k) || aliasFrom.has(k)) continue;
    const suggest = suggestKey(k, keys);
    ignored.push({ key: k, ...(suggest ? { suggest } : {}) });
  }

  const byKey = new Map();
  for (const c of report.changed || []) {
    if (!known.has(c.key) || !asked(c.as || c.key)) continue;
    // 后面又被覆盖回调用方给的值（参照库精修）：不算
    if (c.key in params && String(params[c.key]) === String(c.from)) { byKey.delete(c.key); continue; }
    byKey.set(c.key, c);
  }
  for (const s of specs) {
    const g = raw[s.key];
    if (byKey.has(s.key) || !given(g) || !asked(s.key) || !(s.key in params)) continue;
    const v = params[s.key];
    if (s.type === 'enum' && Array.isArray(s.options) && s.options.length && !s.options.some((o) => String(o.value) === String(g)) && String(v) !== String(g)) {
      byKey.set(s.key, { key: s.key, from: g, to: v, options: s.options.map((o) => o.value).filter((x) => x !== '') });
    } else if ((s.type === 'number' || s.type === 'seed') && Number.isFinite(Number(g)) && ((s.min != null && Number(g) < s.min) || (s.max != null && Number(g) > s.max)) && Number(v) !== Number(g)) {
      byKey.set(s.key, { key: s.key, from: g, to: v, min: s.min, max: s.max });
    }
  }
  const changed = [...byKey.values()];
  if (!ignored.length && !changed.length) return null;
  return { ignored, changed, keys, extra: specs.some((s) => s.key === 'extra' && s.type === 'json') };
}

/** 只留调用方显式给的键（工具字段规范化补上的、模型条目默认值不报）。 */
export function onlyKeys(warnings, keys) {
  if (!warnings) return null;
  const set = new Set(keys || []);
  const ignored = warnings.ignored.filter((x) => set.has(x.key));
  const changed = warnings.changed.filter((x) => set.has(x.as || x.key));
  return ignored.length || changed.length ? { ...warnings, ignored, changed } : null;
}
