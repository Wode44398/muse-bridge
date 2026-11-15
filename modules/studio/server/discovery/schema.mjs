// 上游参数描述 → 模型卡（方案 §9.3「schema 卡」）。三种来源：
//   · JSON Schema（Replicate 的 openapi_schema Input、fal 队列 openapi 的输入 schema）→ fromJsonSchema
//   · OpenRouter 图像目录的 supported_parameters（{ key: { type: enum|range|boolean, values|min|max } }）→ fromOpenRouterImage
//   · OpenRouter 视频目录的 supported_*（分辨率 / 比例 / 尺寸 / 时长 / 首尾帧 / 音频 / 种子）→ fromOpenRouterVideo
//
// 转换规则：enum → enum；有上下限的数 → number（带 step / integer）；boolean → bool；string → text（长文本 multiline）；
// seed → seed；图片 / 视频 / 音频 URL 字段不进参数，映射成 inputs 的角色与数量上限，请求时按 wire 塞回原字段；
// prompt / negative_prompt 归到提示词与 inputs.negative。分组：比例 / 分辨率 / 尺寸 / 画质 / 时长 / 张数 / 音色进 basic（最多 4 个），其余 advanced。
// 卡上的参数键就是上游的字段名（schema 卡原样透传，不改名）；最后总有一个 extra（原始参数）兜底。
// 2026-11-15 参数补全：只含基本类型的一层嵌套对象（voice_setting、audio_setting…）拍平成点路径键（voice_setting.voice_id），
// 请求时按点路径装回嵌套对象（wireBody / expandDotted）；对象数组、基本类型数组、拍不平的对象做成 json 参数（数组带 array:true）；
// 负面提示词的 schema 默认值带进 inputs.negativeDefault（前端当占位显示）。
//
// wire（请求时怎么把素材和正文塞回去）：{ text: 'prompt', negative?: 'negative_prompt',
//   images?: { <角色>: { field, list } }, video?: { field, list }, audio?: { field, list } }——和 replicate 卡的 wire 同形。

import { P } from '../cards/spec.mjs';
import { encodeSizeParams } from '../cards/size.mjs';
import { labelFor, valueLabel, formatFor, unitFor, normKey, keyValueLabels } from './labels.mjs';

const MAX_PARAMS = 60;
const NEST_MAX = 12;   // 拍平的嵌套对象最多几个子字段（再多就整个当 json 参数）
const BASIC_FORMATS = ['aspect', 'resolution', 'size', 'duration', 'count'];
const BASIC_KEYS = /^(quality|voice|voice_id)$/;

// 不进参数的键：回调、同步模式、计费 / 观测字段
const SKIP_KEYS = /^(sync_mode|enable_sync_mode|webhook(_url|_events_filter)?|callback_url|end_user_id|user|session_id|trace|stream|return_[a-z_]+|output_uri|request_id)$/;

// —— 素材字段识别（键名统一成小写下划线后匹配）——
const VIDEO_FIELD = /^(video|videos|video_url|video_urls|input_video|input_videos|reference_video|reference_videos|ref_video|source_video)$/;
const AUDIO_FIELD = /^(audio|audios|audio_url|audio_urls|input_audio|reference_audio|reference_audios|ref_audio|voice_sample|speaker_audio|audio_file)$/;
const FIRST_FIELD = /^(start_image|start_image_url|first_frame|first_frame_image|first_frame_url|first_frame_image_url|init_image|start_frame)$/;
const LAST_FIELD = /^(end_image|end_image_url|last_frame|last_frame_image|last_frame_url|last_frame_image_url|tail_image|tail_image_url|end_frame)$/;
const REF_FIELD = /^(reference_images?|reference_image_urls?|ref_images?|ref_image_urls?|style_image|style_image_url|subject_image|subject_image_url)$/;
const MAIN_IMAGE_FIELD = /^(image|images|image_url|image_urls|input_image|input_images|input_image_url|source_image|input_references)$/;
const MASK_FIELD = /^(mask|mask_url|mask_image|mask_image_url)$/;
const TEXT_FIELDS = { speech: ['text', 'input', 'prompt'], music: ['prompt', 'lyrics', 'text'], image: ['prompt', 'text'], video: ['prompt', 'text'] };

// $ref / 单元素 allOf / anyOf[…, null] 展开；anyOf 里有 enum 的优先取它（fal 的 image_size = ImageSize 对象 | 预设枚举）
export function deref(node, defs = {}, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return node || {};
  if (typeof node.$ref === 'string') {
    const { $ref, ...rest } = node;
    return deref({ ...deref(defs[$ref.split('/').pop()], defs, depth + 1), ...rest }, defs, depth + 1);
  }
  const alt = node.anyOf || node.oneOf;
  if (Array.isArray(alt)) {
    const { anyOf, oneOf, ...rest } = node;
    const opts = alt.map((x) => deref(x, defs, depth + 1)).filter((x) => x && x.type !== 'null');
    const pick = opts.find((x) => Array.isArray(x.enum)) || opts.find((x) => x.type && x.type !== 'object') || opts[0] || {};
    return { ...pick, ...rest };
  }
  if (Array.isArray(node.allOf) && node.allOf.length === 1) {
    const { allOf, ...rest } = node;
    return deref({ ...deref(allOf[0], defs, depth + 1), ...rest }, defs, depth + 1);
  }
  return node;
}

const typeOf = (v) => (Array.isArray(v.type) ? v.type.find((t) => t !== 'null') : v.type);
const isUiMedia = (v, kind) => v && (v['x-fal']?.ui_field === kind || v.ui?.field === kind || v._fal_ui_field === kind || v.items?._fal_ui_field === kind || v.items?.ui?.field === kind);

// 描述里的数量上限：「Up to 30 images」「maximum 9」「at most 3」「最多 9 张」；后面跟单位的（Max 30 MB、max 15s）不算
const COUNT_RE = /(?:up to|maximum of|maximum|max\.?|at most|no more than|最多|至多)\s*(\d{1,3})/gi;
const UNIT_AFTER = /^\s*(?:%|(?:mb|kb|gb|mib|kib|bytes?|s|secs?|seconds?|ms|minutes?|mins?|px|pixels?|characters?|chars?|tokens?|words?|fps|hz|khz|秒|分钟|字|像素)(?![a-z]))/i;
/** 描述文字里解析出的数量上限（1–100），解析不到回 undefined。 */
export function maxFromDescription(desc) {
  const s = String(desc || '');
  for (const m of s.matchAll(COUNT_RE)) {
    if (UNIT_AFTER.test(s.slice(m.index + m[0].length))) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= 100) return n;
  }
  return undefined;
}

/**
 * 一个字段是不是素材：回 { role: 'first'|'last'|'ref'|'edit'|'video'|'audio'|'mask', roles?, list, max } 或 null。
 * roles：同一个字段身兼几个角色（图像模型的列表型主图 image_urls：既是改图对象 edit，又收参考图 ref）。
 * 列表没写 maxItems 时从描述里解析「up to N」，解析不到按 10。
 */
export function mediaRole(key, v, kind) {
  const k = normKey(key);
  const list = typeOf(v) === 'array';
  const max = list ? (Number.isFinite(v.maxItems) ? v.maxItems : (maxFromDescription(v.description) ?? 10)) : 1;
  const fmtUri = v.format === 'uri' || v.items?.format === 'uri';
  if (VIDEO_FIELD.test(k) || isUiMedia(v, 'video')) return { role: 'video', list, max };
  if (AUDIO_FIELD.test(k) || isUiMedia(v, 'audio')) return { role: 'audio', list, max };
  if (MASK_FIELD.test(k)) return { role: 'mask', list, max };
  if (FIRST_FIELD.test(k)) return { role: 'first', list, max: 1 };
  if (LAST_FIELD.test(k)) return { role: 'last', list, max: 1 };
  if (REF_FIELD.test(k)) return { role: 'ref', list, max };
  if (MAIN_IMAGE_FIELD.test(k) || isUiMedia(v, 'image') || (fmtUri && /image/.test(k))) {
    // 视频模型的主图就是首帧（多张的当参考）；图像模型的主图是改图对象——列表型的同时收参考图（续改链上一张也走它）
    if (kind === 'video') return list ? { role: 'ref', list, max } : { role: 'first', list, max: 1 };
    return list ? { role: 'edit', roles: ['edit', 'ref'], list, max } : { role: 'edit', list, max };
  }
  return null;
}

const enumOptions = (values, format, labels) => values.map((x) => ({ value: x, label: labels?.[x] ?? valueLabel(x, format) }));
const niceStep = (min, max, integer) => {
  if (integer) return 1;
  const span = Math.abs(max - min);
  if (!(span > 0)) return 0.01;
  const raw = span / 100;
  const p = 10 ** Math.floor(Math.log10(raw));
  return Number((Math.round(raw / p) * p).toPrecision(2));
};

// —— 尺寸（方案 §10）——
// 数值字段的范围 → 尺寸规则的一边（exclusiveMinimum 0 = 至少 1）
function sideRule(v) {
  const r = {};
  if (Number.isFinite(v?.minimum)) r.min = v.minimum;
  else if (Number.isFinite(v?.exclusiveMinimum)) r.min = Math.floor(v.exclusiveMinimum) + 1;
  if (Number.isFinite(v?.maximum)) r.max = v.maximum;
  else if (Number.isFinite(v?.exclusiveMaximum)) r.max = Math.ceil(v.exclusiveMaximum) - 1;
  if (Number.isFinite(v?.multipleOf) && v.multipleOf > 1) r.multipleOf = v.multipleOf;
  return r;
}
const isNum = (v) => v && (typeOf(v) === 'integer' || typeOf(v) === 'number');

/**
 * 「预设枚举 | { width, height } 对象」的联合类型（fal 的 image_size）→ 尺寸参数：预设照列、对象分支变成自定义宽高（原样发对象）。
 * 认不出联合（没有带 width / height 的对象分支）回 null。
 */
export function sizeUnionSpec(key, node, defs, { required = false } = {}) {
  const alt = node?.anyOf || node?.oneOf;
  if (!Array.isArray(alt)) return null;
  const branches = alt.map((x) => deref(x, defs));
  const obj = branches.find((b) => b && b.properties && isNum(deref(b.properties.width, defs)) && isNum(deref(b.properties.height, defs)));
  if (!obj) return null;
  const en = branches.find((b) => Array.isArray(b?.enum));
  const vals = (en?.enum || []).filter((x) => typeof x === 'string');
  const options = vals.map((x) => ({ value: x, label: valueLabel(x, 'resolution') }));
  const dflt = typeof node.default === 'string' && vals.includes(node.default) ? node.default : (typeof en?.default === 'string' && vals.includes(en.default) ? en.default : undefined);
  if (dflt === undefined && !required) options.unshift({ value: '', label: '默认' });
  const ow = deref(obj.properties.width, defs), oh = deref(obj.properties.height, defs);
  const desc = typeof node.description === 'string' ? node.description.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
  return P.size(key, labelFor(key, node.title), options, {
    group: 'advanced', ...(desc ? { desc } : {}),
    custom: { width: sideRule(ow), height: sideRule(oh), exact: true }, encode: 'object',
    default: dflt ?? (options[0]?.value ?? { width: Number(ow.default) || 1024, height: Number(oh.default) || 1024 }),
  });
}

/**
 * 顶层独立的 width / height 两个数（Replicate 常见）→ 一个尺寸参数（键 width_height，请求时拆回两个字段）。
 * 有 aspect_ratio 枚举且含 'custom' 时，只在选了 custom 时出现（Replicate FLUX 的写法）；否则多一档「默认」（不传）。
 */
export function splitSizeSpec(props, defs, required) {
  const w = deref(props.width, defs), h = deref(props.height, defs);
  if (!isNum(w) || !isNum(h)) return null;
  const ar = deref(props.aspect_ratio || props.aspectRatio, defs);
  const arKey = props.aspect_ratio ? 'aspect_ratio' : props.aspectRatio ? 'aspectRatio' : null;
  const gated = arKey && Array.isArray(ar?.enum) && ar.enum.includes('custom');
  const need = required.has('width') || required.has('height');
  const obj = { width: Number.isFinite(w.default) ? w.default : 1024, height: Number.isFinite(h.default) ? h.default : 1024 };
  const options = gated || need ? [] : [{ value: '', label: '默认' }];
  return P.size('width_height', '尺寸', options, {
    group: 'advanced', custom: { width: sideRule(w), height: sideRule(h), exact: true },
    encode: 'split', fields: { width: 'width', height: 'height' },
    default: options.length ? '' : obj, ...(gated ? { when: { [arKey]: 'custom' } } : {}),
  });
}

/**
 * 一个 JSON Schema 属性 → ParamSpec（不是参数的回 null）。
 * o：{ kind, required:bool }
 */
export function specFromProperty(key, v, { kind, required = false } = {}) {
  const t = typeOf(v);
  const format = formatFor(key);
  const label = labelFor(key, v.title);
  const desc = typeof v.description === 'string' ? v.description.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
  const base = { ...(desc ? { desc } : {}), ...(format ? { format } : {}) };
  const k = normKey(key);
  if (k === 'seed') {
    return P.seed({ min: Number.isFinite(v.minimum) ? v.minimum : 0, max: Number.isFinite(v.maximum) ? v.maximum : 4294967295, ...(Number.isFinite(v.default) ? { default: v.default } : {}), ...(desc ? { desc } : {}) });
  }
  if (Array.isArray(v.enum) && v.enum.length) {
    const vals = v.enum.filter((x) => x !== null && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'));
    if (!vals.length) return null;
    if (vals.length === 2 && vals.every((x) => typeof x === 'boolean')) return P.bool(key, label, { ...base, ...(typeof v.default === 'boolean' ? { default: v.default } : {}) });
    const options = enumOptions(vals, format, keyValueLabels(key));
    const hasDefault = v.default !== undefined && vals.some((x) => x === v.default);
    // 没给默认值、又不是必填：加一档「默认」（不传，走模型自己的默认）
    if (!hasDefault && !required) options.unshift({ value: '', label: '默认' });
    return P.enum(key, label, options, { group: 'advanced', ...base, default: hasDefault ? v.default : (required ? vals[0] : '') });
  }
  if (t === 'boolean') return P.bool(key, label, { ...base, ...(typeof v.default === 'boolean' ? { default: v.default } : {}) });
  if (t === 'integer' || t === 'number') {
    const min = Number.isFinite(v.minimum) ? v.minimum : (Number.isFinite(v.exclusiveMinimum) ? v.exclusiveMinimum : undefined);
    const max = Number.isFinite(v.maximum) ? v.maximum : (Number.isFinite(v.exclusiveMaximum) ? v.exclusiveMaximum : undefined);
    const integer = t === 'integer';
    const unit = unitFor(key, { min, max });
    return P.num(key, label, min, max, {
      ...base, integer, ...(min !== undefined && max !== undefined ? { step: niceStep(min, max, integer) } : integer ? { step: 1 } : {}),
      ...(unit ? { unit } : {}), ...(Number.isFinite(v.default) ? { default: v.default } : {}),
    });
  }
  if (t === 'string') {
    const examples = Array.isArray(v.examples) ? v.examples.filter((x) => typeof x === 'string' && x.length <= 80) : [];
    // 配音模型的音色：给示例当候选（音色表能拉到的方言另走 /voices）
    if (kind === 'speech' && /^(voice|voice_id|speaker|speaker_id)$/.test(k)) {
      const opts = [...new Set([...(typeof v.default === 'string' ? [v.default] : []), ...examples])].map((x) => ({ value: x, label: x }));
      return P.voice(key, label, { ...base, ...(opts.length ? { options: opts } : {}), ...(typeof v.default === 'string' ? { default: v.default } : {}) });
    }
    const maxLen = Number.isFinite(v.maxLength) ? v.maxLength : undefined;
    // 地址类文本（pdf_url 这种非媒体 URL）永远单行
    const urlish = /(^|_)(url|urls|uri)$/.test(k);
    const multiline = !urlish && ((maxLen ?? 0) > 200 || /(prompt|text|lyrics|description|instructions|caption)/.test(k));
    return P.text(key, label, { ...base, ...(maxLen ? { max: Math.min(maxLen, 8000) } : {}), ...(multiline ? { multiline: true } : {}), ...(typeof v.default === 'string' ? { default: v.default } : {}) });
  }
  return null;   // object / array / 没类型：fromJsonSchema 另走 nestedSpecs / jsonSpec
}

// —— 嵌套对象与数组（2026-11-15）——
const isPrimitive = (s) => !!s && ((Array.isArray(s.enum) && s.enum.length > 0) || ['string', 'number', 'integer', 'boolean'].includes(typeOf(s)));
const TRI_BOOL = [{ value: '', label: '默认' }, { value: true, label: '开' }, { value: false, label: '关' }];
const orderedProps = (v) => {
  const props = v.properties || {};
  const order = Array.isArray(v['x-fal-order-properties']) ? v['x-fal-order-properties'] : null;
  const ks = Object.keys(props);
  return order ? [...order.filter((k) => k in props), ...ks.filter((k) => !order.includes(k))] : ks;
};

/**
 * 只含基本类型的一层嵌套对象（voice_setting / audio_setting / voice_modify / camera_control…）→ 点路径键的参数（voice_setting.voice_id）。
 * 子字段的默认值：对象本身有默认对象就用它的、对象必填就用子字段的；都不是（可选的整组设置）就不带默认——不碰就整组不发，
 * 免得把「不发这一组」变成「按默认值发这一组」（例如响度均衡默认 enabled:true，不发时上游可能根本不做）。
 * 拍不平（子字段里有对象 / 数组、字段太多、没有 properties）回 null。
 */
export function nestedSpecs(key, v, defs = {}, { kind, required = false } = {}) {
  if (!v || typeof v.properties !== 'object' || !v.properties) return null;
  const names = orderedProps(v);
  if (!names.length || names.length > NEST_MAX) return null;
  const subs = names.map((n) => [n, deref(v.properties[n], defs)]);
  if (!subs.every(([, s]) => isPrimitive(s))) return null;
  const req2 = new Set(Array.isArray(v.required) ? v.required : []);
  const pdef = v.default && typeof v.default === 'object' && !Array.isArray(v.default) ? v.default : null;
  const keep = required || !!pdef;
  const out = [];
  for (const [n, s] of subs) {
    if (SKIP_KEYS.test(normKey(n))) continue;
    const d = pdef && pdef[n] !== undefined ? pdef[n] : (keep ? s.default : undefined);
    const node = { ...s };
    if (d === undefined) delete node.default; else node.default = d;
    const full = `${key}.${n}`;
    let spec;
    // 可选整组里的开关没有默认值：给三档（默认 / 开 / 关），「默认」= 不发
    if (d === undefined && (typeOf(s) === 'boolean' || (Array.isArray(s.enum) && s.enum.length === 2 && s.enum.every((x) => typeof x === 'boolean')))) {
      const desc = typeof s.description === 'string' ? s.description.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
      spec = P.enum(full, labelFor(full, s.title), TRI_BOOL.map((o) => ({ ...o })), { group: 'advanced', default: '', ...(desc ? { desc } : {}) });
    } else {
      spec = specFromProperty(n, node, { kind, required: required && req2.has(n) });
      if (!spec) continue;
      spec = { ...spec, key: full, label: labelFor(full, s.title) };
    }
    out.push(spec);
  }
  return out.length ? out : null;
}

// 示例骨架：从 schema 生成最短的样子（键名照 properties，值取默认 / 第一个枚举 / 空值）
function skeleton(node, defs, depth = 0) {
  const v = deref(node, defs);
  if (depth > 3 || !v || typeof v !== 'object') return null;
  if (Array.isArray(v.enum) && v.enum.length) return v.default !== undefined && v.enum.includes(v.default) ? v.default : v.enum.find((x) => x !== null) ?? null;
  const t = typeOf(v);
  if (t === 'array') return [v.items ? skeleton(v.items, defs, depth + 1) ?? '' : ''];
  if (t === 'object' || v.properties) {
    const o = {};
    for (const n of orderedProps(v).slice(0, 8)) o[n] = skeleton(v.properties[n], defs, depth + 1);
    return o;
  }
  if (v.default !== undefined && (v.default === null || typeof v.default !== 'object')) return v.default;
  if (t === 'string') return '';
  if (t === 'integer' || t === 'number') return Number.isFinite(v.minimum) ? v.minimum : 0;
  if (t === 'boolean') return false;
  return null;
}
const showJson = (x) => {
  if (Array.isArray(x)) return `[${x.map(showJson).join(', ')}]`;
  if (x && typeof x === 'object') { const e = Object.entries(x); return e.length ? `{ ${e.map(([k, v]) => `${JSON.stringify(k)}: ${showJson(v)}`).join(', ')} }` : '{}'; }
  return JSON.stringify(x);
};

/**
 * 对象数组（multi_prompt、elements、loras）、基本类型数组、拍不平的对象（pronunciation_dict）→ json 参数（键即字段名，原样发）。
 * 数组带 array:true（前端按数组校验、给数组占位；服务端 parseJsonParam 收数组）；desc 里放一个最短的示例骨架。
 */
export function jsonSpec(key, v, defs = {}) {
  if (!v || typeof v !== 'object') return null;
  const isArr = typeOf(v) === 'array';
  if (!isArr && typeOf(v) !== 'object' && !v.properties) return null;
  const skel = showJson(skeleton(v, defs) ?? (isArr ? [] : {}));
  const max = isArr ? (Number.isFinite(v.maxItems) ? v.maxItems : maxFromDescription(v.description)) : undefined;
  const raw = typeof v.description === 'string' ? v.description.replace(/\s+/g, ' ').trim() : '';
  const desc = [`${isArr ? 'JSON 数组' : 'JSON 对象'}，如 ${skel}`, max ? `最多 ${max} 项` : '', raw].filter(Boolean).join('；').slice(0, 300);
  return P.json(key, labelFor(key, v.title), { ...(isArr ? { array: true } : {}), desc });
}

// 分组：basic 最多 4 个（按 format 优先级，其次画质 / 音色），其余 advanced；种子、json 永远 advanced
function assignGroups(params) {
  const rank = (s) => {
    if (s.type === 'seed' || s.type === 'json') return 99;
    const f = s.format ? BASIC_FORMATS.indexOf(s.format) : -1;
    if (f >= 0) return f;
    if (s.type === 'voice' || BASIC_KEYS.test(normKey(s.key))) return 10;
    return 99;
  };
  const pick = params.map((s, i) => ({ s, i, r: rank(s) })).filter((x) => x.r < 99).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 4);
  const basic = new Set(pick.map((x) => x.s.key));
  return params.map((s) => ({ ...s, group: basic.has(s.key) ? 'basic' : 'advanced' }));
}

const finishParams = (params, skipped) => {
  // 超过上限的参数不渲染，名字照样列进「原始参数」的说明（可以写进 JSON 里发）
  if (params.length > MAX_PARAMS) skipped = [...skipped, ...params.slice(MAX_PARAMS).map((s) => s.key)];
  const out = assignGroups(params.slice(0, MAX_PARAMS));
  const extraDesc = skipped.length ? `JSON 对象，原样合并进请求体；可填：${skipped.slice(0, 12).join('、')}` : undefined;
  out.push(P.json('extra', '原始参数', extraDesc ? { desc: extraDesc } : {}));
  return out;
};

/**
 * JSON Schema（Input 对象）→ 模型卡的主体 { params, inputs, wire }。
 * schema：{ properties, required, 'x-order' / 'x-fal-order-properties' }；defs：$ref 用的 components.schemas。
 */
export function fromJsonSchema(kind, schema, defs = {}) {
  const root = deref(schema || {}, defs);
  const props = root.properties || {};
  const required = new Set(Array.isArray(root.required) ? root.required : []);
  // 顺序：fal 的 x-fal-order-properties > 每个属性的 x-order（Replicate）> 原顺序
  const order = Array.isArray(root['x-fal-order-properties']) ? root['x-fal-order-properties'] : null;
  let keys = Object.keys(props);
  if (order) keys = [...order.filter((k) => k in props), ...keys.filter((k) => !order.includes(k))];
  else keys = keys.map((k, i) => ({ k, o: Number.isFinite(props[k]?.['x-order']) ? props[k]['x-order'] : 1000 + i })).sort((a, b) => a.o - b.o).map((x) => x.k);

  const wire = { text: '' };
  const inputs = { text: true };
  const params = [];
  const skipped = [];
  const textKey = (TEXT_FIELDS[kind] || ['prompt']).find((k) => k in props);
  if (textKey) wire.text = textKey;
  // 尺寸：独立的 width / height 合成一个尺寸参数（排在 width 原来的位置）
  const split = kind === 'image' || kind === 'video' ? splitSizeSpec(props, defs, required) : null;
  for (const key of keys) {
    if (key === textKey) continue;
    if (split && (key === 'width' || key === 'height')) { if (key === 'width' || !keys.includes('width')) params.push(split); continue; }
    const union = sizeUnionSpec(key, props[key], defs, { required: required.has(key) });
    if (union) { params.push(union); continue; }
    const v = deref(props[key], defs);
    const k = normKey(key);
    if (SKIP_KEYS.test(k)) continue;
    if (k === 'negative_prompt' || k === 'negative') {
      inputs.negative = true; wire.negative = key;
      // schema 的默认负面词（Kling「blur, distort, and low quality」）带出来，前端当占位显示
      if (typeof v.default === 'string' && v.default.trim()) inputs.negativeDefault = v.default;
      continue;
    }
    const m = mediaRole(key, v, kind);
    if (m) {
      if (m.role === 'mask') { if (required.has(key)) skipped.push(key); continue; }
      if (m.role === 'video' || m.role === 'audio') {
        if (!wire[m.role]) { wire[m.role] = { field: key, list: m.list }; inputs[m.role] = { max: m.max }; }
        continue;
      }
      wire.images ||= {};
      for (const role of m.roles || [m.role]) {
        if (wire.images[role]) continue;
        wire.images[role] = { field: key, list: m.list };
        inputs.images ||= { max: 0, roles: [] };
        inputs.images.roles.push(role);
        if (role === 'edit' || role === 'ref') inputs.images.max = Math.max(inputs.images.max, m.max);
        else inputs.images.max = Math.max(inputs.images.max, 1);
      }
      continue;
    }
    const t = typeOf(v);
    if (t === 'object' || t === 'array' || (!t && v.properties)) {
      // 嵌套对象：能拍平就拍成点路径键；拍不平的对象和数组做成 json 参数
      const flat = t === 'array' ? null : nestedSpecs(key, v, defs, { kind, required: required.has(key) });
      if (flat) { params.push(...flat); continue; }
      const js = jsonSpec(key, v, defs);
      if (js) params.push(js); else skipped.push(key);
      continue;
    }
    const spec = specFromProperty(key, v, { kind, required: required.has(key) });
    if (spec) params.push(spec); else skipped.push(key);
  }
  // 改图模型同一个字段既当改图对象又当参考（续改链上一张也走它）
  if (inputs.images?.roles.includes('edit') && !inputs.images.roles.includes('ref')) { inputs.images.roles.push('ref'); wire.images.ref = wire.images.edit; }
  // 拍平后撞名的标签（音频设置里的 format 和顶层 output_format 都叫「格式」）：点路径的那个前面加上父对象的名字
  const n = new Map();
  for (const s of params) n.set(s.label, (n.get(s.label) || 0) + 1);
  for (const s of params) if (n.get(s.label) > 1 && s.key.includes('.')) s.label = `${labelFor(s.key.split('.')[0])} · ${s.label}`;
  return { params: finishParams(params, skipped), inputs, wire };
}

// —— OpenRouter ——
// 图像：supported_parameters 的描述符 → ParamSpec；键就是 /api/v1/images 请求体里的字段名
// 格式排在背景前面：背景的「透明」选项按格式收窄（applySpecs 按顺序结算 only 条件，前面的先定）；gif 的帧数 / 每帧时长紧跟压缩率
const OR_IMAGE_ORDER = ['aspect_ratio', 'resolution', 'size', 'quality', 'n', 'output_format', 'output_compression', 'background', 'seed'];
// 2026-11-15 查证：output_compression 只对 jpeg / webp（其它格式 OpenAI 会拒）；透明背景只认 png / webp；
// gif 另有 frame_count 2–16（默认 9）/ frame_duration_ms 20–2000（默认 200）——目录不列这两个，格式里有 gif 就补上。
const LOSSY = ['jpeg', 'webp'];
const ALPHA = ['png', 'webp'];
// 服务商透传参数（provider.options.<slug>.*）：目录不给取值域，已知的给枚举，未知的给文本
const PASS_KNOWN = {
  moderation: () => P.enum('moderation', '审核', [{ value: 'auto', label: '自动' }, { value: 'low', label: '宽松' }], { group: 'advanced', default: 'auto', desc: '宽松 = 放宽内容过滤' }),
  complexity: () => P.enum('complexity', '规划强度', [{ value: '', label: '默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }], { group: 'advanced', default: '', desc: '复杂画面先规划构图' }),
};
const PASS_KEY_RE = /^[A-Za-z][\w]{0,40}$/;
const PASS_RESERVED = new Set(['prompt', 'model', 'extra', 'provider', 'input_references', 'frame_images', 'negative_prompt']);
const gifSpecs = (when) => [
  P.num('frame_count', '帧数', 2, 16, { integer: true, step: 1, default: 9, ...(when ? { when } : {}) }),
  P.num('frame_duration_ms', '每帧时长', 20, 2000, { integer: true, step: 10, unit: 'ms', default: 200, ...(when ? { when } : {}) }),
];

/**
 * 图像端点信息（GET /images/models/{id}/endpoints 的 endpoints 数组）→ { n, slug?, passthrough }：
 * 只有一个服务商端点时才有 slug（透传参数要写在 provider.options.<slug> 下，多服务商时不确定写给谁）；passthrough 是全部端点的并集。
 */
export function imageEndpointInfo(endpoints) {
  const list = Array.isArray(endpoints) ? endpoints.filter((e) => e && typeof e === 'object') : [];
  const pass = new Set();
  for (const e of list) for (const k of Array.isArray(e.allowed_passthrough_parameters) ? e.allowed_passthrough_parameters : []) if (typeof k === 'string' && PASS_KEY_RE.test(k)) pass.add(k);
  const slug = list.length === 1 && typeof list[0].provider_slug === 'string' && /^[\w.-]{1,60}$/.test(list[0].provider_slug) ? list[0].provider_slug : undefined;
  return { n: list.length, ...(slug ? { slug } : {}), passthrough: [...pass].slice(0, 20) };
}

/** opts.endpoints：巡检缓存的端点信息（imageEndpointInfo），有单一服务商时把透传键做成参数（spec 上 passthrough: <slug>，wire.passthrough 记去向）。 */
export function fromOpenRouterImage(m, { endpoints } = {}) {
  const sp = m?.supported_parameters || {};
  const params = [];
  const fixed = {};
  const keys = [...OR_IMAGE_ORDER.filter((k) => k in sp), ...Object.keys(sp).filter((k) => !OR_IMAGE_ORDER.includes(k))];
  // 格式：只有一个值的（Recraft vector 只有 svg）没得选，不出参数，但请求里照带（wire.fixed）
  const fmtVals = sp.output_format?.type === 'enum' && Array.isArray(sp.output_format.values) ? sp.output_format.values.filter((v) => typeof v === 'string' && v) : [];
  const fmtParam = fmtVals.length > 1;
  if (fmtVals.length === 1) fixed.output_format = fmtVals[0];
  const lossy = fmtVals.filter((v) => LOSSY.includes(v));
  const alpha = fmtVals.filter((v) => ALPHA.includes(v));
  for (const key of keys) {
    const d = sp[key] || {};
    if (key === 'input_references') continue;
    if (key === 'seed') { params.push(P.seed()); continue; }
    if (key === 'output_format' && !fmtParam) continue;
    if (key === 'output_compression' && fmtVals.length && !lossy.length) continue;   // 格式里没有 jpeg / webp：压缩率没意义
    if (key === 'background' && d.type === 'enum' && Array.isArray(d.values) && d.values.includes('transparent') && fmtParam && alpha.length) {
      // 透明只认 png / webp；'' = 不传格式（上游默认 png）也算
      const options = enumOptions(d.values, undefined).map((o) => (o.value === 'transparent' ? { ...o, only: { output_format: ['', ...alpha] } } : o));
      if (!d.values.includes('auto')) options.unshift({ value: '', label: '默认' });
      params.push(P.enum(key, labelFor(key), options, { group: 'advanced', default: d.values.includes('auto') ? 'auto' : '' }));
      continue;
    }
    if (key === 'size' && d.type === 'boolean') {
      // 目录的 boolean 只说明「可能收这个字段」（端点并集），不给像素约束：给自定义宽高、不设上限，交给上游校验；
      // 填了自定义就不再发比例 / 分辨率（同 GPT Image 驱动：显式 size 和 aspect_ratio 会冲突）
      params.push(P.size('size', '尺寸', [{ value: '', label: '默认' }], { group: 'advanced', default: '', custom: { width: { min: 16 }, height: { min: 16 }, exact: false }, encode: 'x' }));
      continue;
    }
    if (d.type === 'enum' && Array.isArray(d.values) && d.values.length) {
      const format = formatFor(key);
      const vals = d.values;
      const options = enumOptions(vals, format);
      const dflt = vals.includes('auto') ? 'auto' : '';
      if (!vals.includes('auto')) options.unshift({ value: '', label: '默认' });
      params.push(P.enum(key, labelFor(key), options, { group: 'advanced', ...(format ? { format } : {}), default: dflt }));
      continue;
    }
    if (d.type === 'range' && Number.isFinite(d.min) && Number.isFinite(d.max)) {
      if (key === 'n' && d.max <= 1) continue;   // 只出一张：不给张数
      const unit = unitFor(key, d);
      params.push(P.num(key, labelFor(key), d.min, d.max, {
        integer: true, step: 1, ...(formatFor(key) ? { format: formatFor(key) } : {}), ...(unit ? { unit } : {}), ...(key === 'n' ? { default: 1 } : {}),
        ...(key === 'output_compression' && fmtParam ? { when: { output_format: lossy } } : {}),
      }));
      continue;
    }
    if (d.type === 'boolean') params.push(P.bool(key, labelFor(key)));
  }
  if (params.some((s) => s.type === 'size' && s.key === 'size')) {
    for (const s of params) if (s.key === 'aspect_ratio' || s.key === 'resolution') s.when = { ...(s.when || {}), size: '' };
  }
  // gif：补帧数 / 每帧时长（只在选了 gif 时出现；格式固定是 gif 的就一直在），排在压缩率 / 格式后面
  if (fmtVals.includes('gif')) {
    const at = Math.max(params.findIndex((s) => s.key === 'output_compression'), params.findIndex((s) => s.key === 'output_format'));
    const add = gifSpecs(fmtParam ? { output_format: 'gif' } : null).filter((g) => !(g.key in sp));
    params.splice(at >= 0 ? at + 1 : params.length, 0, ...add);
  }
  // 服务商透传：只有一个服务商端点（slug 确定）时做成参数；多服务商的列进「原始参数」的说明
  const passthrough = {};
  const skipped = [];
  const ep = endpoints && typeof endpoints === 'object' ? endpoints : null;
  for (const k of Array.isArray(ep?.passthrough) ? ep.passthrough : []) {
    if (!PASS_KEY_RE.test(k) || PASS_RESERVED.has(k) || k in sp || params.some((s) => s.key === k)) continue;
    if (!ep.slug) { skipped.push(`provider.options.<服务商>.${k}`); continue; }
    params.push({ ...(PASS_KNOWN[k] ? PASS_KNOWN[k]() : P.text(k, labelFor(k))), passthrough: ep.slug });
    passthrough[k] = { slug: ep.slug };
  }
  const refMax = sp.input_references?.type === 'range' ? Number(sp.input_references.max) || 0 : ((m?.architecture?.input_modalities || []).includes('image') ? 1 : 0);
  const inputs = { text: true, ...(refMax > 0 ? { images: { max: refMax, roles: ['edit', 'ref'] } } : {}), multiTurn: false };
  const wire = {
    text: 'prompt', ...(refMax > 0 ? { images: { edit: { field: 'input_references', list: true }, ref: { field: 'input_references', list: true } } } : {}),
    ...(Object.keys(fixed).length ? { fixed } : {}), ...(Object.keys(passthrough).length ? { passthrough } : {}),
  };
  return { params: finishParams(params, skipped), inputs, wire };
}

/**
 * 把卡上标了透传的参数从请求体顶层挪进 provider.options.<slug>（[.<nest>]）.<键>；wire.negativePass 把负面提示词也放进去。
 * 已经有值的（「原始参数」里手写的 provider.options…）不覆盖。wire.fixed 里的固定字段（没得选的格式）补进请求体。就地改 body，回 body。
 */
export function applyPassthrough(body, wire, req = {}) {
  if (!wire || !body) return body;
  for (const [k, v] of Object.entries(wire.fixed || {})) if (body[k] === undefined) body[k] = v;
  const put = (t, key, v) => {
    if (v === undefined || v === null || v === '') return;
    const pv = body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider) ? body.provider : (body.provider = {});
    const po = pv.options && typeof pv.options === 'object' && !Array.isArray(pv.options) ? pv.options : (pv.options = {});
    let o = po[t.slug] && typeof po[t.slug] === 'object' ? po[t.slug] : (po[t.slug] = {});
    if (t.nest) o = o[t.nest] && typeof o[t.nest] === 'object' ? o[t.nest] : (o[t.nest] = {});
    if (o[key] === undefined) o[key] = v;
  };
  for (const [k, t] of Object.entries(wire.passthrough || {})) {
    if (!(k in body)) continue;
    const v = body[k];
    delete body[k];
    put(t, t.key || k, v);
  }
  if (wire.negativePass && typeof req.negative === 'string' && req.negative.trim()) put(wire.negativePass, wire.negativePass.key, req.negative.trim());
  return body;
}

/**
 * 价目里带不带音频是不是两个价（带音频更贵）：按「去掉 with_audio / without_audio 字样后的同一档」比价。
 * Veo（with 0.12 / without 0.10）、Kling（duration_seconds 0.112 / with_audio 0.168）→ true；Seedance（video_tokens = without_audio）、
 * 价目不分音频的（Wan、海螺）→ false。
 */
export function audioCostsMore(skus) {
  const groups = new Map();
  for (const [k, raw] of Object.entries(skus || {})) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const tag = /without_audio/.test(k) ? 'without' : /with_audio/.test(k) ? 'with' : 'plain';
    const base = k.replace(/_?with(out)?_audio_?/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const g = groups.get(base) || { with: [], without: [], plain: [] };
    g[tag].push(v);
    groups.set(base, g);
  }
  for (const g of groups.values()) {
    if (g.with.length && (g.without.length || g.plain.length) && Math.max(...g.with) > Math.min(...g.without, ...g.plain)) return true;
    if (!g.with.length && g.without.length && g.plain.length && Math.max(...g.plain) > Math.min(...g.without)) return true;
  }
  return false;
}

// 视频服务商透传（2026-11-15 查证的两家；其余厂商 slug 未证实，维持原样只列进「原始参数」的说明）：
//   Veo：provider.options["google-vertex"].parameters.{ personGeneration, negativePrompt, enhancePrompt, conditioningScale }（唯一多嵌一层 parameters）
//   Seedance：provider.options.seed.{ watermark }
const TRI = (on, off) => [{ value: '', label: '默认' }, { value: true, label: on }, { value: false, label: off }];
const VIDEO_PASS = [
  { re: /^google\/veo-/, slug: 'google-vertex', nest: 'parameters', negative: 'negativePrompt', keys: {
    personGeneration: () => P.enum('personGeneration', '人物生成', [{ value: '', label: '默认' }, { value: 'allow_adult', label: '仅成人' }, { value: 'allow_all', label: '允许（含儿童）' }, { value: 'dont_allow', label: '不生成人物' }], { group: 'advanced', default: '' }),
    enhancePrompt: () => P.enum('enhancePrompt', '提示词增强', TRI('开', '关'), { group: 'advanced', default: '' }),
    conditioningScale: () => P.num('conditioningScale', '参考约束强度', undefined, undefined, { step: 0.05, desc: '参考图对画面的约束强度' }),
  } },
  { re: /^bytedance\/seedance-/, slug: 'seed', keys: {
    watermark: () => P.enum('watermark', '水印', TRI('加', '不加'), { group: 'advanced', default: '' }),
  } },
];

// 视频：分辨率 / 比例 / 时长 / 尺寸 / 音频 / 种子 / 放大倍数 / 创意度；首尾帧 → inputs
export function fromOpenRouterVideo(m) {
  const params = [];
  const res = Array.isArray(m?.supported_resolutions) ? m.supported_resolutions : [];
  const asp = Array.isArray(m?.supported_aspect_ratios) ? m.supported_aspect_ratios : [];
  const dur = Array.isArray(m?.supported_durations) ? [...m.supported_durations].map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const sizes = Array.isArray(m?.supported_sizes) ? m.supported_sizes.filter((s) => typeof s === 'string' && s) : [];
  // 有分辨率时也给「精确尺寸」（size 与 分辨率 + 比例 二选一：选了精确尺寸就不发比例 / 分辨率）
  const exact = res.length > 0 && sizes.length > 0;
  if (asp.length) params.push(P.enum('aspect_ratio', '比例', [{ value: '', label: '默认' }, ...enumOptions(asp, 'aspect')], { format: 'aspect', default: '', ...(exact ? { when: { size: '' } } : {}) }));
  if (res.length) {
    const order = ['360p', '480p', '540p', '720p', '768p', '1080p', '1k', '2k', '4k'];
    const sorted = [...res].sort((a, b) => order.indexOf(String(a).toLowerCase()) - order.indexOf(String(b).toLowerCase()));
    params.push(P.enum('resolution', '分辨率', enumOptions(sorted, 'resolution'), { format: 'resolution', default: sorted.includes('720p') ? '720p' : sorted[0], ...(exact ? { when: { size: '' } } : {}) }));
  }
  if (dur.length) params.push(P.enum('duration', '时长', dur.map((d) => ({ value: d, label: `${d} 秒` })), { format: 'duration', default: dur.includes(5) ? 5 : dur[0] }));
  if (!res.length && sizes.length) params.push(P.enum('size', '尺寸', [{ value: '', label: '默认' }, ...enumOptions(sizes, 'size')], { format: 'size', default: '' }));
  // 精确尺寸放高级组（不给 format，免得挤进基本组）
  if (exact) params.push(P.enum('size', '精确尺寸', [{ value: '', label: '默认' }, ...sizes.map((s) => ({ value: s, label: s.replace(/x/i, '×') }))], { group: 'advanced', default: '', desc: '选了就按这个宽高出片，不再用比例和分辨率' }));
  // 生成音频：价目里只有「带音频」的档 = 音轨恒开，不给开关。
  // 默认值跟上游一致（上游不传时按端点能力，支持音频的默认开）；但带音频更贵的（Veo、Kling…）保持默认关，免得悄悄多花钱
  const skus = Object.keys(m?.pricing_skus || {});
  const audioFixed = skus.length > 0 && skus.every((k) => /with_audio/.test(k) && !/without/.test(k));
  if (m?.generate_audio === true && !audioFixed) params.push(P.bool('generate_audio', '生成音频', { group: 'basic', default: !audioCostsMore(m.pricing_skus), ...(audioCostsMore(m.pricing_skus) ? { desc: '带音频更贵' } : {}) }));
  if (m?.upscale_factor && Number.isFinite(m.upscale_factor.min) && Number.isFinite(m.upscale_factor.max)) {
    params.push(P.num('upscale_factor', '放大倍数', m.upscale_factor.min, m.upscale_factor.max, { step: 0.5, default: m.upscale_factor.min }));
  }
  if (Array.isArray(m?.creativity) && m.creativity.length === 2) params.push(P.num('creativity', '创意度', m.creativity[0], m.creativity[1], { integer: true, step: 1 }));
  if (m?.seed === true) params.push(P.seed());
  const frames = Array.isArray(m?.supported_frame_images) ? m.supported_frame_images : [];
  const roles = [...(frames.includes('first_frame') ? ['first'] : []), ...(frames.includes('last_frame') ? ['last'] : [])];
  const pass = Array.isArray(m?.allowed_passthrough_parameters) ? m.allowed_passthrough_parameters.filter((k) => typeof k === 'string') : [];
  const inputs = { text: true, ...(roles.length ? { images: { max: 1, roles } } : {}) };
  // 没有首尾帧也没有时长的（视频编辑 / 放大）：收一段视频
  if (!roles.length && !dur.length) inputs.video = { max: 1 };
  // 服务商专属参数（负面提示词、水印…）写在 provider.options.<服务商> 下：查证过 slug 的（Veo / Seedance）做成参数，
  // 其余服务商名随路由变、没证实，不做成参数，列进「原始参数」的说明
  const vp = VIDEO_PASS.find((x) => x.re.test(String(m?.id || '')));
  const wire = {};
  const done = new Set();
  if (vp) {
    const t = { slug: vp.slug, ...(vp.nest ? { nest: vp.nest } : {}) };
    for (const k of pass) {
      if (vp.negative && k === vp.negative) { inputs.negative = true; wire.negativePass = { ...t, key: k }; done.add(k); continue; }
      const mk = vp.keys[k];
      if (!mk || params.some((s) => s.key === k)) continue;
      params.push({ ...mk(), passthrough: vp.slug });
      (wire.passthrough ||= {})[k] = t;
      done.add(k);
    }
    if (vp.nest === 'parameters') done.add('aspectRatio');   // Veo 的 aspectRatio 透传与顶层 aspect_ratio 重复：不列
  }
  const out = finishParams(params, pass.filter((k) => !done.has(k)).map((k) => `provider.options.<服务商>.${k}`));
  return { params: out, inputs, audioFixed, ...(Object.keys(wire).length ? { wire } : {}) };
}

// —— 价格提示 ——
const usd = (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${Number(n.toPrecision(2))}`);
/** OpenRouter 视频 pricing_skus → 「$0.023–0.21 / 秒」；按 token 计价的不给。 */
export function videoPriceHint(skus) {
  const per = [];
  for (const [k, raw] of Object.entries(skus || {})) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (/^cents_per_(video_output_)?second/.test(k) && !/continuation|megapixel/.test(k)) per.push(v / 100);
    else if (/^(text_to_video_|image_to_video_)?duration_seconds/.test(k) && !/^long_|^reference_/.test(k)) per.push(v);
  }
  if (!per.length) return undefined;
  const lo = Math.min(...per), hi = Math.max(...per);
  return lo === hi ? `${usd(lo)} / 秒` : `${usd(lo)}–${usd(hi).slice(1)} / 秒`;
}
/** OpenRouter 图像 endpoints 的 pricing（output_image 每张）→ 「$0.018 / 张」。 */
export function imagePriceHint(endpoints) {
  const per = [];
  for (const ep of Array.isArray(endpoints) ? endpoints : []) {
    for (const p of Array.isArray(ep?.pricing) ? ep.pricing : []) {
      if (p && p.billable === 'output_image' && p.unit === 'image' && Number(p.cost_usd) > 0) per.push(Number(p.cost_usd));
    }
  }
  if (!per.length) return undefined;
  const lo = Math.min(...per), hi = Math.max(...per);
  return lo === hi ? `${usd(lo)} / 张` : `${usd(lo)}–${usd(hi).slice(1)} / 张`;
}

// —— 请求体（schema 卡）——
/**
 * 按 wire 把正文、负面提示词、素材塞进请求体：{ ...卡上参数（键即字段名）, [text]: prompt, [negative], 素材字段 }。
 * uri(x) 把素材转成上游收的形式（data URL / 上传后的地址）。extra 不在这里合并（适配器最后合并）。
 */
export function wireBody(wire, params, req, uri) {
  const body = {};
  // 尺寸参数按卡上的 encode 编码（自由宽高 → 'WxH' / 对象 / 拆成 width + height；auto 不传；原图换成适配后的宽高）
  params = encodeSizeParams(req?.card?.params, params || {}, req).params;
  for (const [k, v] of Object.entries(params || {})) {
    if (k === 'extra' || v === undefined || v === null || v === '') continue;
    setPath(body, k, v);   // 点路径键（拍平的嵌套对象）装回嵌套对象
  }
  if (req.prompt && wire?.text) body[wire.text] = req.prompt;
  if (req.negative && wire?.negative) body[wire.negative] = req.negative;
  let inputs = Array.isArray(req.inputs) ? req.inputs : [];
  // 续改链：没给素材、卡收改图的，拿上一张出图当改图对象
  const turns = req.thread?.turns || [];
  const last = turns[turns.length - 1];
  if (!inputs.length && req.kind === 'image' && last?.data && wire?.images?.edit) inputs = [{ role: 'edit', data: last.data, mime: last.mime }];
  for (const x of inputs) {
    const slot = x.role === 'video' ? wire?.video : x.role === 'audio' ? wire?.audio : wire?.images?.[x.role];
    if (!slot) continue;
    const u = uri(x);
    if (slot.list) { if (!Array.isArray(body[slot.field])) body[slot.field] = []; body[slot.field].push(u); }
    else body[slot.field] = u;
  }
  return body;
}

// —— 点路径键（2026-11-15）——
const BAD_KEY = new Set(['__proto__', 'constructor', 'prototype']);
/** body[a.b] = v → body.a.b = v（只展开一层，和拍平规则一致）；不带点的原样。 */
export function setPath(body, k, v) {
  const i = typeof k === 'string' ? k.indexOf('.') : -1;
  if (i <= 0 || i === k.length - 1) { if (!BAD_KEY.has(k)) body[k] = v; return body; }
  const a = k.slice(0, i), b = k.slice(i + 1);
  if (BAD_KEY.has(a) || BAD_KEY.has(b)) return body;
  if (!body[a] || typeof body[a] !== 'object' || Array.isArray(body[a])) body[a] = {};
  body[a][b] = v;
  return body;
}
/** 参数表里的点路径键装回嵌套对象（Replicate buildInput 这类不走 wireBody 的组装用）。 */
export function expandDotted(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) setPath(out, k, v);
  return out;
}
/** 两个请求体合并：同名的普通对象再合一层（内置卡发了 voice_setting，追加的 voice_setting.english_normalization 并进去），其余后者覆盖。 */
export function mergeBodies(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (BAD_KEY.has(k)) continue;
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur, ...v } : v;
  }
  return out;
}

/**
 * 内置卡 + schema 合并卡（cards/merge.mjs）的「追加部分」请求体：内置卡的 wire 是函数（fal）时，它不认追加的参数和素材，
 * 由这里补：extra = { params: [追加的参数键（即上游字段名，可带点路径）], images?: { 角色: { field, list } }, video?, audio?, negative? }。
 * 回 { 字段: 值 }，调用方用 mergeBodies 并进内置卡的请求体。
 */
export function wireExtraBody(extra, params, req, uri) {
  const body = {};
  if (!extra) return body;
  const enc = encodeSizeParams(req?.card?.params, params || {}, req).params;
  const want = new Set(extra.params || []);
  for (const s of req?.card?.params || []) {
    if (!want.has(s.key)) continue;
    // 拆成两个字段的尺寸（split）：编码后键变成 fields.width / fields.height
    const ks = s.type === 'size' && s.encode === 'split' && s.fields ? [s.fields.width, s.fields.height] : [s.key];
    for (const k of ks) { const v = enc[k]; if (v !== undefined && v !== null && v !== '') setPath(body, k, v); }
  }
  if (req?.negative && extra.negative) body[extra.negative] = req.negative;
  for (const x of Array.isArray(req?.inputs) ? req.inputs : []) {
    const slot = x.role === 'video' ? extra.video : x.role === 'audio' ? extra.audio : extra.images?.[x.role];
    if (!slot) continue;
    const u = uri(x);
    if (slot.list) { if (!Array.isArray(body[slot.field])) body[slot.field] = []; body[slot.field].push(u); }
    else body[slot.field] = u;
  }
  return body;
}
