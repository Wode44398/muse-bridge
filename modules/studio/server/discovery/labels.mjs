// 自动识别出来的参数用的中文标签与渲染提示（方案 §9.3「schema → ParamSpec 转换规则」）。
//
// 标签：先查对照表（常见键 60 个左右，键名大小写、驼峰与下划线都认），再用 schema 的 title，再把键名整理成可读词。
// 渲染提示 format / unit：前端据此选控件（比例格、分辨率档、时长、尺寸、张数），不再靠值的样子猜。
// 内置卡的 ParamSpec 也过一遍 decorateSpec（只加 format / unit，不改取值与默认值）。

// 键（统一成小写下划线后）→ 中文标签
export const LABELS = Object.freeze({
  aspect_ratio: '比例', ratio: '比例', resolution: '分辨率', image_size: '尺寸', size: '尺寸', megapixels: '像素量',
  quality: '画质', output_quality: '输出质量', duration: '时长', duration_seconds: '时长', seconds: '时长', length: '时长',
  n: '张数', num_images: '张数', num_outputs: '张数', number_of_images: '张数', count: '张数', batch_size: '张数', num_videos: '条数',
  num_inference_steps: '采样步数', steps: '采样步数', inference_steps: '采样步数',
  guidance_scale: '引导强度', guidance: '引导强度', cfg_scale: '引导强度', cfg: '引导强度',
  output_format: '格式', format: '格式', background: '背景', output_compression: '压缩率', compression: '压缩率',
  seed: '种子', negative_prompt: '负面提示词', generate_audio: '生成音频', enable_audio: '生成音频', audio: '音频',
  fps: '帧率', frames_per_second: '帧率', num_frames: '帧数', frames: '帧数', width: '宽', height: '高',
  strength: '改动强度', prompt_strength: '改动强度', image_strength: '参考强度',
  style: '风格', style_preset: '风格预设', style_type: '风格',
  voice: '音色', voice_id: '音色', speaker: '说话人', speed: '语速', pitch: '音调', volume: '音量', vol: '音量', emotion: '情绪',
  language: '语言', language_code: '语言', stability: '稳定性', similarity_boost: '相似度', style_exaggeration: '风格夸张度',
  temperature: '温度', top_p: 'Top P', top_k: 'Top K',
  safety_tolerance: '安全容忍度', enable_safety_checker: '安全检查', disable_safety_checker: '关闭安全检查',
  enhance_prompt: '提示词增强', prompt_enhancement: '提示词增强', prompt_optimizer: '提示词优化', prompt_extend: '提示词扩写',
  enable_prompt_expansion: '提示词扩写', expand_prompt: '提示词扩写', prompt_upsampling: '提示词扩写',
  camera_fixed: '固定镜头', camera_motion: '运镜', motion_bucket_id: '运动幅度', motion_strength: '运动幅度', loop: '循环',
  sample_rate: '采样率', bitrate: '码率', bitrate_mode: '码率模式', codec: '编码',
  watermark: '水印', aigc_watermark: '水印', add_watermark: '水印',
  shot_type: '镜头类型', draft: '草稿', go_fast: '快速模式', lora_scale: 'LoRA 强度', raw: '原始模式', mode: '模式', task: '任务',
  apply_text_normalization: '文本规范化', timestamps: '时间戳', upscale_factor: '放大倍数', creativity: '创意度',
  person_generation: '人物生成', thinking_level: '思考', instructions: '说明', lyrics: '歌词', genre: '曲风', bpm: '节拍',
});

// 枚举值 → 中文（只收语义明确的通用值；比例 / 分辨率这类本身就是标签）
const VALUE_LABELS = {
  auto: '自动', none: '无', default: '默认', true: '是', false: '否',
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', standard: '标准', hd: '高清',
  transparent: '透明', opaque: '不透明',
  square_hd: '方形 · 高清', square: '方形', portrait_4_3: '竖版 4:3', portrait_16_9: '竖版 16:9', landscape_4_3: '横版 4:3', landscape_16_9: '横版 16:9',
  intelligent: '智能', customize: '自定义',
};

/** 键名 → 统一形态（驼峰、连字符都折成小写下划线）。 */
export const normKey = (k) => String(k || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();

/** 键名整理成可读词：shot_type → Shot type。 */
export function readableKey(k) {
  const s = normKey(k).replace(/_+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(k || '');
}

/** 参数标签：对照表 → schema title → 可读键名。 */
export function labelFor(key, title) {
  const hit = LABELS[normKey(key)];
  if (hit) return hit;
  const t = String(title || '').trim();
  if (t && t.length <= 40) return t;
  return readableKey(key);
}

export function valueLabel(v, format) {
  const s = String(v);
  if (format === 'duration' && /^\d+(\.\d+)?$/.test(s)) return `${s} 秒`;
  if (format === 'resolution' && /^\d+k$/i.test(s)) return s.toUpperCase();
  return VALUE_LABELS[s.toLowerCase?.() ?? s] ?? s;
}

// —— 渲染提示 ——
const FORMAT_BY_KEY = [
  [/^(aspect_ratio|ratio)$/, 'aspect'],
  [/^(resolution|image_size|megapixels)$/, 'resolution'],
  [/^(size|width_height|dimensions)$/, 'size'],
  [/^(duration|duration_seconds|seconds|length|video_length)$/, 'duration'],
  [/^(n|num_images|num_outputs|number_of_images|count|batch_size|num_videos|sample_count)$/, 'count'],
];
/** 键 → format（'aspect'|'resolution'|'duration'|'size'|'count'），认不出回 undefined。 */
export function formatFor(key) {
  const k = normKey(key);
  for (const [re, f] of FORMAT_BY_KEY) if (re.test(k)) return f;
  return undefined;
}
/** 键 + 上下限 → unit（'s'|'px'|'%'）。 */
export function unitFor(key, { min, max } = {}) {
  const k = normKey(key);
  if (formatFor(k) === 'duration') return 's';
  if (/^(width|height)$/.test(k)) return 'px';
  if (/(compression|percent)/.test(k) && (max === 100 || max === undefined) && (min === 0 || min === undefined)) return '%';
  return undefined;
}

/** 给 ParamSpec 补 format / unit（已有的不动，取值与默认值不碰）。返回新对象。 */
export function decorateSpec(s) {
  if (!s || typeof s !== 'object') return s;
  const format = s.format || (s.type === 'enum' || s.type === 'number' || s.type === 'text' ? formatFor(s.key) : undefined);
  const unit = s.unit || (s.type === 'number' ? unitFor(s.key, s) : undefined) || (format === 'duration' && s.type === 'number' ? 's' : undefined);
  if ((format && format !== s.format) || (unit && unit !== s.unit)) return { ...s, ...(format ? { format } : {}), ...(unit ? { unit } : {}) };
  return s;
}
