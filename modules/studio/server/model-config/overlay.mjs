// 参数覆盖：在模型卡上叠一层，不改卡本身（内置卡、上游 schema、托管服务都改不了，叠加总可以）。
//   over = {
//     options?:  { <参数键>: [要补的取值…] }   给 enum 参数补选项（例：gpt-image-2.6 补 outputFormat: ["svg"]）
//     defaults?: { <参数键>: 值 }              改这个参数的默认值（按卡规范化时用）
//     extra?:    { … }                        垫在额外参数 extra 底下的一层请求体（调用方的 extra 同名键压过它）；卡上没有 extra 的模型不收
//   }
// 优先级（低 → 高）：卡上的默认 < over.defaults < 模型条目的 defaults < 这次调用给的参数。

import { parseJsonParam } from '../cards/spec.mjs';
import { normalizeWithReport } from '../cards/report.mjs';

const bad = (msg) => Object.assign(new Error('参数覆盖：' + msg), { status: 400 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v) => ['string', 'number', 'boolean'].includes(typeof v);

/** 校验覆盖（对照这张卡：键得是卡上的参数）。空的回 null。 */
export function cleanOver(o, card) {
  if (o === null || o === undefined) return null;
  if (!isObj(o)) throw bad('要是对象');
  for (const k of Object.keys(o)) if (!['options', 'defaults', 'extra'].includes(k)) throw bad(`不认识「${k}」（只有 options / defaults / extra）`);
  const specs = new Map((card?.params || []).map((s) => [s.key, s]));
  const out = {};
  if (o.options !== undefined) {
    if (!isObj(o.options)) throw bad('options 要是 { 参数键: [取值…] }');
    const opts = {};
    for (const [k, list] of Object.entries(o.options)) {
      const s = specs.get(k);
      if (!s) throw bad(`这个模型没有参数「${k}」`);
      if (s.type !== 'enum') throw bad(`「${k}」不是选项型参数，补不了选项`);
      const vals = (Array.isArray(list) ? list : [list]);
      if (!vals.length || vals.length > 30 || !vals.every(scalar)) throw bad(`「${k}」要补的取值要是 1–30 个字符串 / 数字`);
      opts[k] = [...new Set(vals)];
    }
    if (Object.keys(opts).length) out.options = opts;
  }
  if (o.defaults !== undefined) {
    if (!isObj(o.defaults)) throw bad('defaults 要是 { 参数键: 值 }');
    const defs = {};
    for (const [k, v] of Object.entries(o.defaults)) {
      const s = specs.get(k);
      if (!s) throw bad(`这个模型没有参数「${k}」`);
      if (v === null || v === undefined || v === '') continue;
      if (s.type === 'json') defs[k] = parseJsonParam(v, k, { array: !!s.array });
      else if (s.type === 'size' && isObj(v)) defs[k] = { width: Number(v.width) || 0, height: Number(v.height) || 0 };
      else if (scalar(v)) defs[k] = v;
      else throw bad(`「${k}」的默认值要是字符串 / 数字 / 布尔`);
    }
    if (Object.keys(defs).length) out.defaults = defs;
  }
  if (o.extra !== undefined && o.extra !== null && !(isObj(o.extra) && !Object.keys(o.extra).length)) {
    if (!specs.has('extra')) throw bad('这个模型不收额外请求体（卡上没有「额外参数」）');
    out.extra = parseJsonParam(o.extra, '额外请求体');
  }
  return Object.keys(out).length ? out : null;
}

/** 把覆盖叠到卡上 → 新卡（不改原卡；原卡可能是缓存里共用的）。 */
export function applyOver(card, over) {
  if (!over) return card;
  const params = card.params.map((s) => {
    let x = s;
    const add = over.options?.[s.key];
    if (add && s.type === 'enum') {
      const have = new Set((s.options || []).map((o) => o.value));
      const more = add.filter((v) => !have.has(v)).map((v) => ({ value: v, label: String(v), custom: true }));
      if (more.length) x = { ...x, options: [...(s.options || []), ...more] };
    }
    if (over.defaults && s.key in over.defaults) x = { ...x, default: over.defaults[s.key] };
    return x;
  });
  return { ...card, params, overlay: over, ...(over.extra ? { extraBase: over.extra } : {}) };
}

/**
 * 按卡规范化，再把覆盖层的意思补足（jobs 与试跑都用它，代替直接调 normalizeWithReport）：
 *   · over.defaults 垫在最底下（自带 normalize 的卡——Google 系、GPT Image——不看 ParamSpec 的 default，要在原始参数里垫）；
 *   · 补的选项：自带 normalize 的卡有自己的白名单，补进去的值会被回落；调用方选了补的值就照原样发，报告里也不再说它被改了；
 *   · extra 叠上 extraBase。
 * raw 是「模型条目默认值 + 这次的参数」，回 { params, warnings } 同 normalizeWithReport。
 */
export function normalizeWithOver(card, raw, flags, opts) {
  const over = card.overlay && typeof card.overlay === 'object' ? card.overlay : null;
  const base = over?.defaults ? { ...over.defaults, ...raw } : raw;
  const r = normalizeWithReport(card, base, flags, opts);
  if (!over) return { params: withExtraBase(card, r.params), warnings: r.warnings };
  const params = { ...r.params };
  const forced = new Set();
  for (const [k, vals] of Object.entries(over.options || {})) {
    const v = base[k];
    if (v === undefined || v === null || v === '') continue;
    const hit = vals.find((x) => x === v || String(x) === String(v));
    if (hit !== undefined && params[k] !== hit) { params[k] = hit; forced.add(k); }
  }
  let warnings = r.warnings;
  if (warnings && forced.size) {
    const changed = (warnings.changed || []).filter((c) => !forced.has(c.key));
    warnings = changed.length || warnings.ignored?.length ? { ...warnings, changed } : null;
  }
  return { params: withExtraBase(card, params), warnings };
}

/** 规范化后的参数叠上 extraBase：调用方给的 extra 同名键优先。 */
export function withExtraBase(card, params) {
  if (!card?.extraBase) return params;
  const mine = params.extra && typeof params.extra === 'object' && !Array.isArray(params.extra) ? params.extra : {};
  return { ...params, extra: { ...card.extraBase, ...mine } };
}
