// 同族继承 + 参照库精修（方案 §9.3 参数解析链第 ④ 步）。
//
// 没有内置卡、也没有上游 schema 的新模型（Gemini / Vertex 的新版本最常见）：按「去掉版本号的族名」找最近的同族内置卡，
// 复制它的参数与规范化，换 id / label；再拿 OpenRouter 公共目录里同名的 google/<id> 精修取值域（时长 / 分辨率 / 比例 / 首尾帧）。
// 例：gemini-omni-1.2-flash → 沿用 gemini-omni-1.1-flash 的卡，时长按参照库放宽到 3–15 秒（1.1 是 3–10）。
//
// 族名：id 按 - _ / 切开，丢掉版本样的段（3.8、001、v2、preview、latest、日期）；剩下的段集合算相似度（交集 / 并集），
// 族根（第一段）必须相同、相似度 ≥ 0.5；并列时版本号最近的胜，再同方言优先、再新的优先。
// 精修只放宽 / 收窄「取值域」：首尾帧只收窄（驱动没接的角色不能凭参照库加出来）。

import { applySpecs } from '../cards/spec.mjs';

const VERSIONISH = /^(v?\d+(\.\d+)*[a-z]?|\d{4,8}|preview|exp|experimental|latest|beta|alpha|ga|stable|\d{2}-\d{4})$/;

export function familyTokens(id) {
  const s = String(id || '').toLowerCase().replace(/^[^/]+\//, '');
  return s.split(/[-_/:]+/).filter((t) => t && !VERSIONISH.test(t));
}
/** 版本号：第一个数字样的段（gemini-3.8-flash → 3.8、lyria-002 → 2、veo-3.1-…-001 → 3.1）；没有回 null。 */
export function versionOf(id) {
  const s = String(id || '').toLowerCase().replace(/^[^/]+\//, '');
  for (const t of s.split(/[-_/:]+/)) {
    const m = /^v?(\d+(?:\.\d+)?)/.exec(t);
    if (m && !/^\d{5,}$/.test(t)) return Number(m[1]);
  }
  return null;
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

/**
 * 挑最近的同族内置模型。candidates：[{ id, dialect? }]（同种类的内置卡）。回命中的那个候选或 null。
 */
export function pickParent(id, candidates, { dialect } = {}) {
  const toks = familyTokens(id);
  if (!toks.length) return null;
  const ver = versionOf(id);
  let best = null;
  for (const c of candidates || []) {
    if (!c || c.id === id) continue;
    const ct = familyTokens(c.id);
    if (!ct.length || ct[0] !== toks[0]) continue;
    const sim = jaccard(toks, ct);
    if (sim < 0.5) continue;
    const cv = versionOf(c.id);
    const dist = ver != null && cv != null ? Math.abs(ver - cv) : 99;
    const score = [sim, -dist, c.dialect && c.dialect === dialect ? 1 : 0, cv ?? 0];
    if (!best || cmp(score, best.score) > 0) best = { c, score };
  }
  return best ? best.c : null;
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return 0; };

/** 复制父卡：换 id / label，标来源；说明句不继承（它说的是父模型）。 */
export function inheritCard(parent, { cardId, label, parentId }) {
  const { desc, priceHint, ...rest } = parent;
  return { ...rest, id: cardId, ...(label ? { label } : { label: undefined }), paramSource: 'family', inheritsFrom: parentId };
}

// —— 参照库精修（Google 系卡：键名是 Google 卡的 aspectRatio / resolution / durationSeconds / imageSize）——
const RES_ORDER = ['360p', '480p', '540p', '720p', '768p', '1080p', '1k', '2k', '4k'];
const IMAGE_SIZES = new Set(['1K', '2K', '4K']);
const optOf = (spec, v) => (spec.options || []).find((o) => String(o.value).toLowerCase() === String(v).toLowerCase());

function refineEnum(spec, values, { keep = [], label = (v) => String(v), normValue = (v) => v } = {}) {
  if (!spec || !values.length) return null;
  const opts = [];
  for (const k of keep) { const o = optOf(spec, k); if (o) opts.push(o); }
  for (const raw of values) {
    const hit = optOf(spec, raw);
    const v = hit ? hit.value : normValue(raw);
    if (opts.some((o) => String(o.value) === String(v))) continue;
    opts.push(hit || { value: v, label: label(v) });
  }
  if (!opts.length) return null;
  const nums = opts.every((o) => o.value !== '' && Number.isFinite(Number(o.value)));
  let dflt = spec.default;
  if (!opts.some((o) => o.value === dflt)) {
    if (nums && Number.isFinite(Number(dflt))) dflt = opts.filter((o) => o.value !== '').reduce((b, o) => (Math.abs(o.value - dflt) < Math.abs(b.value - dflt) ? o : b)).value;
    else dflt = opts[0].value;
  }
  return { ...spec, options: opts, default: dflt };
}

/**
 * 用参照库里的 OpenRouter 条目精修继承来的 Google 卡。ref = { kind:'image'|'video', model }。
 * 回 { card, refined:bool }。规范化：先走父卡的（夹紧逻辑原样），被精修的键再按新取值域夹一遍、覆盖回去。
 */
export function refineGoogleCard(card, ref) {
  if (!card || !ref || ref.kind !== card.kind) return { card, refined: false };
  const m = ref.model || {};
  const changed = new Map();   // key → 新 spec
  const spec = (k) => card.params.find((s) => s.key === k);
  let inputs = card.inputs;
  if (card.kind === 'video') {
    const dur = Array.isArray(m.supported_durations) ? [...m.supported_durations].map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
    const d = refineEnum(spec('durationSeconds'), dur, { label: (v) => `${v} 秒` });
    if (d) changed.set('durationSeconds', d);
    const res = Array.isArray(m.supported_resolutions) ? [...m.supported_resolutions].sort((a, b) => RES_ORDER.indexOf(String(a).toLowerCase()) - RES_ORDER.indexOf(String(b).toLowerCase())) : [];
    const r = refineEnum(spec('resolution'), res, { normValue: (v) => String(v).toLowerCase(), label: (v) => (/k$/i.test(v) ? String(v).toUpperCase() : String(v)) });
    if (r) changed.set('resolution', r);
    const asp = Array.isArray(m.supported_aspect_ratios) ? m.supported_aspect_ratios : [];
    const a = refineEnum(spec('aspectRatio'), asp, { keep: ['auto'] });
    if (a) changed.set('aspectRatio', a);
    // 首尾帧：只收窄（参照库说不收的去掉；它说收、驱动没接的不加）
    const frames = Array.isArray(m.supported_frame_images) ? m.supported_frame_images : null;
    if (frames && inputs?.images?.roles) {
      const allow = { first: frames.includes('first_frame'), last: frames.includes('last_frame') };
      const roles = inputs.images.roles.filter((r2) => (r2 in allow ? allow[r2] : true));
      if (roles.length !== inputs.images.roles.length) inputs = roles.length ? { ...inputs, images: { ...inputs.images, roles } } : (({ images, ...x }) => x)(inputs);
    }
  } else if (card.kind === 'image') {
    const sp = m.supported_parameters || {};
    const asp = sp.aspect_ratio?.type === 'enum' ? sp.aspect_ratio.values.filter((v) => v !== 'auto') : [];
    const a = refineEnum(spec('aspectRatio'), asp, { keep: ['auto'] });
    if (a) changed.set('aspectRatio', a);
    const res = sp.resolution?.type === 'enum' ? sp.resolution.values.filter((v) => IMAGE_SIZES.has(String(v).toUpperCase())).map((v) => String(v).toUpperCase()) : [];
    const s = refineEnum(spec('imageSize'), res, { keep: [''] });
    if (s) changed.set('imageSize', s);
    const refMax = sp.input_references?.type === 'range' ? Number(sp.input_references.max) : 0;
    if (refMax > 0 && inputs?.images) inputs = { ...inputs, images: { ...inputs.images, max: refMax } };
  }
  if (!changed.size && inputs === card.inputs) return { card, refined: false };
  const params = card.params.map((s) => changed.get(s.key) || s);
  const refinedSpecs = [...changed.values()];
  const baseNormalize = card.normalize;
  return {
    refined: true,
    card: {
      ...card, params, inputs, refinedBy: 'openrouter',
      normalize(raw = {}) {
        const base = baseNormalize ? baseNormalize(raw) : applySpecs(card.params, raw);
        const fix = applySpecs(refinedSpecs, raw);
        for (const s of refinedSpecs) {
          if (s.key in fix) base[s.key] = fix[s.key];
          else if (s.key in base && !s.options.some((o) => o.value === base[s.key])) delete base[s.key];
        }
        return base;
      },
    },
  };
}
