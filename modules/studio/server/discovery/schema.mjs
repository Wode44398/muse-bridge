// 上游参数描述 → 模型卡（方案 §9.3「schema 卡」）。三种来源：
//   · JSON Schema（Replicate 的 openapi_schema Input、fal 队列 openapi 的输入 schema）→ fromJsonSchema
//   · OpenRouter 图像目录的 supported_parameters（{ key: { type: enum|range|boolean, values|min|max } }）→ fromOpenRouterImage
//   · OpenRouter 视频目录的 supported_*（分辨率 / 比例 / 尺寸 / 时长 / 首尾帧 / 音频 / 种子）→ fromOpenRouterVideo
//
// 转换规则：enum → enum；有上下限的数 → number（带 step / integer）；boolean → bool；string → text（长文本 multiline）；
// seed → seed；图片 / 视频 / 音频 URL 字段不进参数，映射成 inputs 的角色与数量上限，请求时按 wire 塞回原字段；
// prompt / negative_prompt 归到提示词与 inputs.negative。分组：比例 / 分辨率 / 尺寸 / 画质 / 时长 / 张数 / 音色进 basic（最多 4 个），其余 advanced。
// 卡上的参数键就是上游的字段名（schema 卡原样透传，不改名）；最后总有一个 extra（原始参数）兜底。
//
// wire（请求时怎么把素材和正文塞回去）：{ text: 'prompt', negative?: 'negative_prompt',
//   images?: { <角色>: { field, list } }, video?: { field, list }, audio?: { field, list } }——和 replicate 卡的 wire 同形。

import { P } from '../cards/spec.mjs';
import { labelFor, valueLabel, formatFor, unitFor, normKey } from './labels.mjs';

const MAX_PARAMS = 40;
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

/** 一个字段是不是素材：回 { role: 'first'|'last'|'ref'|'edit'|'video'|'audio', list, max } 或 null。 */
export function mediaRole(key, v, kind) {
  const k = normKey(key);
  const list = typeOf(v) === 'array';
  const max = list ? (Number.isFinite(v.maxItems) ? v.maxItems : 10) : 1;
  const fmtUri = v.format === 'uri' || v.items?.format === 'uri';
  if (VIDEO_FIELD.test(k) || isUiMedia(v, 'video')) return { role: 'video', list, max };
  if (AUDIO_FIELD.test(k) || isUiMedia(v, 'audio')) return { role: 'audio', list, max };
  if (MASK_FIELD.test(k)) return { role: 'mask', list, max };
  if (FIRST_FIELD.test(k)) return { role: 'first', list, max: 1 };
  if (LAST_FIELD.test(k)) return { role: 'last', list, max: 1 };
  if (REF_FIELD.test(k)) return { role: 'ref', list, max };
  if (MAIN_IMAGE_FIELD.test(k) || isUiMedia(v, 'image') || (fmtUri && /image/.test(k))) {
    // 视频模型的主图就是首帧；图像模型的主图是改图对象，多张的当参考
    if (kind === 'video') return list ? { role: 'ref', list, max } : { role: 'first', list, max: 1 };
    return { role: list ? 'ref' : 'edit', list, max };
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
    const options = enumOptions(vals, format);
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
    const multiline = (maxLen ?? 0) > 200 || /(prompt|text|lyrics|description|instructions|caption)/.test(k);
    return P.text(key, label, { ...base, ...(maxLen ? { max: Math.min(maxLen, 8000) } : {}), ...(multiline ? { multiline: true } : {}), ...(typeof v.default === 'string' ? { default: v.default } : {}) });
  }
  return null;   // object / array / 没类型：收进「原始参数」
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
  for (const key of keys) {
    if (key === textKey) continue;
    const v = deref(props[key], defs);
    const k = normKey(key);
    if (SKIP_KEYS.test(k)) continue;
    if (k === 'negative_prompt' || k === 'negative') { inputs.negative = true; wire.negative = key; continue; }
    const m = mediaRole(key, v, kind);
    if (m) {
      if (m.role === 'mask') { if (required.has(key)) skipped.push(key); continue; }
      if (m.role === 'video' || m.role === 'audio') {
        if (!wire[m.role]) { wire[m.role] = { field: key, list: m.list }; inputs[m.role] = { max: m.max }; }
        continue;
      }
      wire.images ||= {};
      if (!wire.images[m.role]) {
        wire.images[m.role] = { field: key, list: m.list };
        inputs.images ||= { max: 0, roles: [] };
        inputs.images.roles.push(m.role);
        if (m.role === 'edit' || m.role === 'ref') inputs.images.max = Math.max(inputs.images.max, m.max);
        else inputs.images.max = Math.max(inputs.images.max, 1);
      }
      continue;
    }
    const spec = specFromProperty(key, v, { kind, required: required.has(key) });
    if (spec) params.push(spec); else skipped.push(key);
  }
  // 改图模型同一个字段既当改图对象又当参考（续改链上一张也走它）
  if (inputs.images?.roles.includes('edit') && !inputs.images.roles.includes('ref')) { inputs.images.roles.push('ref'); wire.images.ref = wire.images.edit; }
  return { params: finishParams(params, skipped), inputs, wire };
}

// —— OpenRouter ——
// 图像：supported_parameters 的描述符 → ParamSpec；键就是 /api/v1/images 请求体里的字段名
const OR_IMAGE_ORDER = ['aspect_ratio', 'resolution', 'size', 'quality', 'n', 'background', 'output_format', 'output_compression', 'seed'];
export function fromOpenRouterImage(m) {
  const sp = m?.supported_parameters || {};
  const params = [];
  const keys = [...OR_IMAGE_ORDER.filter((k) => k in sp), ...Object.keys(sp).filter((k) => !OR_IMAGE_ORDER.includes(k))];
  for (const key of keys) {
    const d = sp[key] || {};
    if (key === 'input_references') continue;
    if (key === 'seed') { params.push(P.seed()); continue; }
    if (key === 'size' && d.type === 'boolean') {
      params.push(P.text('size', '尺寸', { format: 'size', max: 16, desc: '像素宽×高，如 2048x1152（填了就不按比例与分辨率算）' }));
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
      params.push(P.num(key, labelFor(key), d.min, d.max, { integer: true, step: 1, ...(formatFor(key) ? { format: formatFor(key) } : {}), ...(unit ? { unit } : {}), ...(key === 'n' ? { default: 1 } : {}) }));
      continue;
    }
    if (d.type === 'boolean') params.push(P.bool(key, labelFor(key)));
  }
  const refMax = sp.input_references?.type === 'range' ? Number(sp.input_references.max) || 0 : ((m?.architecture?.input_modalities || []).includes('image') ? 1 : 0);
  const inputs = { text: true, ...(refMax > 0 ? { images: { max: refMax, roles: ['edit', 'ref'] } } : {}), multiTurn: false };
  return { params: finishParams(params, []), inputs, wire: { text: 'prompt', ...(refMax > 0 ? { images: { edit: { field: 'input_references', list: true }, ref: { field: 'input_references', list: true } } } : {}) } };
}

// 视频：分辨率 / 比例 / 时长 / 尺寸 / 音频 / 种子 / 放大倍数 / 创意度；首尾帧 → inputs
export function fromOpenRouterVideo(m) {
  const params = [];
  const res = Array.isArray(m?.supported_resolutions) ? m.supported_resolutions : [];
  const asp = Array.isArray(m?.supported_aspect_ratios) ? m.supported_aspect_ratios : [];
  const dur = Array.isArray(m?.supported_durations) ? [...m.supported_durations].map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const sizes = Array.isArray(m?.supported_sizes) ? m.supported_sizes : [];
  if (asp.length) params.push(P.enum('aspect_ratio', '比例', [{ value: '', label: '默认' }, ...enumOptions(asp, 'aspect')], { format: 'aspect', default: '' }));
  if (res.length) {
    const order = ['360p', '480p', '540p', '720p', '768p', '1080p', '1k', '2k', '4k'];
    const sorted = [...res].sort((a, b) => order.indexOf(String(a).toLowerCase()) - order.indexOf(String(b).toLowerCase()));
    params.push(P.enum('resolution', '分辨率', enumOptions(sorted, 'resolution'), { format: 'resolution', default: sorted.includes('720p') ? '720p' : sorted[0] }));
  }
  if (dur.length) params.push(P.enum('duration', '时长', dur.map((d) => ({ value: d, label: `${d} 秒` })), { format: 'duration', default: dur.includes(5) ? 5 : dur[0] }));
  if (!res.length && sizes.length) params.push(P.enum('size', '尺寸', [{ value: '', label: '默认' }, ...enumOptions(sizes, 'size')], { format: 'size', default: '' }));
  // 生成音频：价目里只有「带音频」的档 = 音轨恒开，不给开关
  const skus = Object.keys(m?.pricing_skus || {});
  const audioFixed = skus.length > 0 && skus.every((k) => /with_audio/.test(k) && !/without/.test(k));
  if (m?.generate_audio === true && !audioFixed) params.push(P.bool('generate_audio', '生成音频', { group: 'basic', default: false }));
  if (m?.upscale_factor && Number.isFinite(m.upscale_factor.min) && Number.isFinite(m.upscale_factor.max)) {
    params.push(P.num('upscale_factor', '放大倍数', m.upscale_factor.min, m.upscale_factor.max, { step: 0.5, default: m.upscale_factor.min }));
  }
  if (Array.isArray(m?.creativity) && m.creativity.length === 2) params.push(P.num('creativity', '创意度', m.creativity[0], m.creativity[1], { integer: true, step: 1 }));
  if (m?.seed === true) params.push(P.seed());
  const frames = Array.isArray(m?.supported_frame_images) ? m.supported_frame_images : [];
  const roles = [...(frames.includes('first_frame') ? ['first'] : []), ...(frames.includes('last_frame') ? ['last'] : [])];
  const pass = Array.isArray(m?.allowed_passthrough_parameters) ? m.allowed_passthrough_parameters : [];
  // 服务商专属参数（负面提示词、水印…）要写在 provider.options.<服务商> 下，服务商名随路由变：不做成参数，列进「原始参数」的说明
  const inputs = { text: true, ...(roles.length ? { images: { max: 1, roles } } : {}) };
  // 没有首尾帧也没有时长的（视频编辑 / 放大）：收一段视频
  if (!roles.length && !dur.length) inputs.video = { max: 1 };
  const out = finishParams(params, pass.map((k) => `provider.options.<服务商>.${k}`));
  return { params: out, inputs, audioFixed };
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
  for (const [k, v] of Object.entries(params || {})) {
    if (k === 'extra' || v === undefined || v === null || v === '') continue;
    body[k] = v;
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
