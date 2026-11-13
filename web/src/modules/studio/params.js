// ParamSpec（§3.2）的纯逻辑：显隐、取值、换模型时的清洗、发给后端的参数表。界面只按这里的结果渲染。
//
//   ParamSpec { key, label, type: enum|number|bool|text|voice|seed|json, group: basic|advanced,
//               options?: [{ value, label, only?, note? }], min?, max?, step?, default?, when?: { k: 值或值数组 } }
//
// `only` 在选项上两种写法都认：模型 id 数组（这个选项只对这些模型成立，旧 capabilities 的 aspects.only 转写过来就是这样），
// 或条件表（同 `when`，看别的参数此刻的值）。

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

function match(cond, values) {
  if (!cond || typeof cond !== 'object') return true;
  for (const [k, want] of Object.entries(cond)) {
    const v = values[k];
    if (Array.isArray(want) ? !want.includes(v) : v !== want) return false;
  }
  return true;
}

/** 这一项选项对当前模型 / 当前取值成立吗 */
export function optionOk(opt, modelId, values) {
  const only = opt?.only;
  if (!only) return true;
  if (Array.isArray(only)) return only.includes(modelId);
  return match(only, values);
}

/** 某参数的可选项（过滤掉 only 不成立的） */
export const optionsOf = (spec, modelId, values) => (spec?.options || []).filter((o) => optionOk(o, modelId, values));

/** 参数此刻该不该出现（when 不满足的不显示也不发） */
export const visibleSpec = (spec, values) => match(spec?.when, values);

function defaultOf(spec, modelId, values) {
  if (spec.type === 'enum') {
    const opts = optionsOf(spec, modelId, values);
    if (has(spec, 'default') && opts.some((o) => o.value === spec.default)) return spec.default;
    return opts[0]?.value;
  }
  if (has(spec, 'default')) return spec.default;
  if (spec.type === 'bool') return false;
  if (spec.type === 'seed') return -1;
  if (spec.type === 'number') return spec.min ?? 0;
  if (spec.type === 'json') return '';
  return '';
}

function valid(spec, v, modelId, values) {
  if (v === undefined) return false;
  switch (spec.type) {
    case 'enum': return optionsOf(spec, modelId, values).some((o) => o.value === v);
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (spec.min != null && v < spec.min) return false;
      if (spec.max != null && v > spec.max) return false;
      return true;
    }
    case 'seed': return Number.isInteger(v);
    case 'bool': return typeof v === 'boolean';
    default: return typeof v === 'string';
  }
}

/**
 * 有效取值：草稿里存的值能用就用，否则回默认。按 specs 顺序逐个结算——后面参数的 when / only 看前面已结算的值，
 * 所以「分辨率」能根据「模型 / 尺寸」的当前值收窄。
 * @returns {Record<string, any>} 每个 spec 一项（含不可见的，不可见的取默认，方便切回来时还在）
 */
export function resolveValues(specs, draft = {}, modelId = '') {
  const out = {};
  for (const spec of specs || []) {
    const v = draft[spec.key];
    out[spec.key] = valid(spec, v, modelId, out) ? v : defaultOf(spec, modelId, out);
  }
  return out;
}

/** 发给后端的 params：只含此刻可见的参数；json 类型解析成对象（解析不了的不发，界面会标红） */
export function payloadParams(specs, values) {
  const out = {};
  for (const spec of specs || []) {
    if (!visibleSpec(spec, values)) continue;
    let v = values[spec.key];
    if (spec.type === 'enum' && v === '') continue;   // 后端约定：value '' 的选项＝「默认，不传」
    if (spec.type === 'json') {
      if (typeof v !== 'string' || !v.trim()) continue;
      try { v = JSON.parse(v); } catch { continue; }
    }
    if (spec.type === 'text' && typeof v === 'string' && !v.trim()) continue;
    out[spec.key] = v;
  }
  return out;
}

/** json 参数的校验（界面失焦时调）：'' = 好的 */
export function jsonError(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? '' : 'object'; } catch { return 'syntax'; }
}

/** chips 上显示的值文字 */
export function valueLabel(spec, v, modelId, values) {
  if (spec.type === 'enum') {
    const o = (spec.options || []).find((x) => x.value === v);
    return o ? (o.label ?? String(o.value)) : String(v ?? '');
  }
  if (spec.type === 'bool') return null;   // 开关类 chip 只显示名字 + 点亮态
  if (spec.type === 'seed') return v === -1 || v == null ? null : String(v);
  if (spec.type === 'number') return v == null ? '' : String(v);
  return typeof v === 'string' ? v : '';
}

export const basicSpecs = (specs, values) => (specs || []).filter((s) => s.group !== 'advanced' && visibleSpec(s, values));
export const advancedSpecs = (specs, values) => (specs || []).filter((s) => s.group === 'advanced' && visibleSpec(s, values));

// —— 素材能力（ResolvedModel.inputs）——
/** 这个模型接得了某个角色的素材吗；返回 { ok, reason } 里的 reason 是给界面的原因键（界面再翻译） */
export function roleState(model, role, current = []) {
  const ins = model?.inputs || {};
  // 音频 / 视频参考（§9.3 inputs.audio / inputs.video：Seedance 这类收视频、音频参考）
  if (role === 'audio' || role === 'video') {
    const box = ins[role];
    if (!box) return { ok: false, reason: 'model' };
    const max = box.max ?? 1;
    if (current.filter((x) => x.role === role).length >= max) return { ok: false, reason: 'full', max };
    return { ok: true };
  }
  const im = ins.images;
  if (!im || !(im.roles || []).includes(role)) return { ok: false, reason: 'model' };
  const imgs = current.filter((x) => x.role !== 'audio' && x.role !== 'video');
  // 首尾帧与参考图互斥（Veo 的三种任务）：有其一就不能放另一类
  const frames = imgs.some((x) => x.role === 'first' || x.role === 'last');
  const refs = imgs.some((x) => x.role === 'ref');
  if ((role === 'first' || role === 'last') && refs && (im.roles || []).includes('ref') && im.exclusive !== false) return { ok: false, reason: 'refMix' };
  if (role === 'ref' && frames && (im.roles || []).includes('first') && im.exclusive !== false) return { ok: false, reason: 'frameMix' };
  if (role === 'first' || role === 'last' || role === 'edit') {
    // 单槽：已有就是替换，算可放
    return { ok: true, replace: imgs.some((x) => x.role === role) };
  }
  const max = im.max ?? 1;
  const n = imgs.filter((x) => x.role === role).length;
  if (n >= max) return { ok: false, reason: 'full', max };
  return { ok: true };
}

// —— 提示词语言（模型卡 inputs.promptLang：'en' 或 ['en','ja']；不带＝不限）——
// Lyria 2 只认英文，中文提示词服务端必然 400：前端提前拦下，省一次必然失败的任务。
export function promptLangs(model) {
  const v = model?.inputs?.promptLang;
  if (!v) return null;
  const list = (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase()).filter(Boolean);
  return list.length ? list : null;
}
const SCRIPT = { zh: /[\u3400-\u9fff\uf900-\ufaff]/, ja: /[\u3040-\u30ff\u3400-\u9fff]/, ko: /[\uac00-\ud7af\u1100-\u11ff]/ };
/** 这段文字在只认 langs 的模型上能不能发：拉丁字母语言之外的文字（汉字 / 假名 / 谚文）出现了而模型不认就不行 */
export function textFitsLangs(text, langs) {
  if (!langs || !text) return true;
  for (const [lang, re] of Object.entries(SCRIPT)) {
    if (!re.test(text)) continue;
    // 汉字同时属于 zh 与 ja：认其一即可
    if (lang === 'zh' && (langs.includes('zh') || langs.includes('ja'))) continue;
    if (!langs.includes(lang)) return false;
  }
  return true;
}

/** 图片总数上限（edit 与 ref 共用 max 的方言：Nano Banana 一次最多 N 张） */
export function imageRoles(model) { return model?.inputs?.images?.roles || []; }
/** 这个模型收的全部素材角色（图片角色 + 参考视频 + 参考音频），＋ 菜单与素材条用 */
export function inputRoles(model) {
  return [...imageRoles(model), ...(model?.inputs?.video ? ['video'] : []), ...(model?.inputs?.audio ? ['audio'] : [])];
}
