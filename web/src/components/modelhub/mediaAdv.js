// 媒体模型「调用配置」弹层（HsMediaAdv.svelte）的纯逻辑：配置视图 ↔ 草稿 ↔ 提交体、草稿的毛病。有单测（mediaAdv.test.js）。
// 配置视图来自 GET /api/studio/model-config（Studio 的 model-config/index.mjs configView）：
//   { base, effective: { params:[{ key, label, type, options?:[{ value, label, custom? }], default?, min?, max? }], hasExtra }, over, recipe, examples }
// 草稿：{ options: { 键: [补的取值] }, defaults: { 键: 文本（'' = 跟卡上）}, extra: JSON 文本, recipeOn, recipe: JSON 文本 }
import { t } from '../../lib/i18n.js';

// 能在界面里改默认值 / 补选项的参数种类；json（额外参数）单独一栏，size（复合尺寸）这里不碰
export const EDITABLE = new Set(['enum', 'number', 'seed', 'bool', 'text', 'voice']);
const pretty = (o) => (o == null ? '' : JSON.stringify(o, null, 2));
const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** 参数表（不含补的取值）：有配方时是配方自己的参数，否则是服务方言的卡。 */
export function baseParams(cfg) {
  const src = cfg?.recipe ? cfg.effective : cfg?.base;
  return (src?.params || []).filter((s) => EDITABLE.has(s.type)).map((s) => ({ ...s, ...(s.options ? { options: s.options.filter((o) => !o.custom) } : {}) }));
}

export function mediaDraft(cfg) {
  const over = cfg?.over || {};
  return {
    options: Object.fromEntries(Object.entries(over.options || {}).map(([k, v]) => [k, (v || []).map(asText)])),
    defaults: Object.fromEntries(Object.entries(over.defaults || {}).map(([k, v]) => [k, asText(v)])),
    extra: over.extra ? pretty(over.extra) : '',
    recipeOn: !!cfg?.recipe,
    recipe: cfg?.recipe ? pretty(cfg.recipe) : '',
  };
}

function parseObj(text) {
  const s = String(text || '').trim();
  if (!s) return { value: null };
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'type' };
    return { value: v };
  } catch (e) { return { error: 'json', message: String(e?.message || e) }; }
}

// 文本 → 按参数种类的值（选项型尽量对上原选项的类型：时长 5 是数字，'5' 也认）
function typed(spec, text, extraOpts = []) {
  const s = String(text ?? '').trim();
  if (!s) return undefined;
  if (spec?.type === 'enum') {
    const hit = [...(spec.options || []).map((o) => o.value), ...extraOpts].find((v) => String(v) === s);
    if (hit !== undefined) return hit;
    return /^-?\d+(\.\d+)?$/.test(s) && (spec.options || []).some((o) => typeof o.value === 'number') ? Number(s) : s;
  }
  if (spec?.type === 'number' || spec?.type === 'seed') return Number(s);
  if (spec?.type === 'bool') return s === 'true';
  return s;
}

/** 草稿 → { over, recipe }（null = 删掉）。params：baseParams(cfg)，用来按种类还原取值。 */
export function mediaPayload(d, params = []) {
  const byKey = new Map(params.map((s) => [s.key, s]));
  const options = {};
  for (const [k, list] of Object.entries(d.options || {})) {
    const spec = byKey.get(k);
    const vals = (list || []).map((x) => String(x).trim()).filter(Boolean)
      .map((x) => (spec && (spec.options || []).some((o) => typeof o.value === 'number') && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
    if (vals.length) options[k] = [...new Set(vals)];
  }
  const defaults = {};
  for (const [k, text] of Object.entries(d.defaults || {})) {
    const v = typed(byKey.get(k), text, options[k] || []);
    if (v !== undefined) defaults[k] = v;
  }
  const ex = parseObj(d.extra);
  const over = {
    ...(Object.keys(options).length ? { options } : {}),
    ...(Object.keys(defaults).length ? { defaults } : {}),
    ...(ex.value && Object.keys(ex.value).length ? { extra: ex.value } : {}),
  };
  const r = d.recipeOn ? parseObj(d.recipe) : { value: null };
  return { over: Object.keys(over).length ? over : null, recipe: r.value || null };
}

/** 草稿的毛病 → 人话；没毛病 ''。 */
export function mediaProblem(d, params = []) {
  const ex = parseObj(d.extra);
  if (ex.error) return ex.error === 'type' ? t('额外请求体要是 JSON 对象（{…}）') : t('额外请求体不是合法的 JSON：{msg}', { msg: ex.message });
  if (d.recipeOn) {
    if (!String(d.recipe || '').trim()) return t('配方是空的：从示例开始，或者关掉「调用配方」');
    const r = parseObj(d.recipe);
    if (r.error) return r.error === 'type' ? t('配方要是 JSON 对象（{…}）') : t('配方不是合法的 JSON：{msg}', { msg: r.message });
  }
  for (const s of params) {
    const v = String(d.defaults?.[s.key] ?? '').trim();
    if (!v) continue;
    if ((s.type === 'number' || s.type === 'seed') && !Number.isFinite(Number(v))) return t('「{name}」的默认值要是数字', { name: s.label || s.key });
    if (s.type === 'number' && ((s.min !== undefined && Number(v) < s.min) || (s.max !== undefined && Number(v) > s.max))) {
      return t('「{name}」的默认值要在 {min}–{max} 之间', { name: s.label || s.key, min: s.min ?? '', max: s.max ?? '' });
    }
  }
  return '';
}

/** 一个模型配没配过（列表上标「已自定义」）。 */
export const mediaCustom = (info) => !!(info && (info.over || info.recipe));
