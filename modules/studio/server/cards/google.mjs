// Google 系模型卡（vertex / gemini 两个方言共用）：参数矩阵从 src/config/capabilities.mjs 转写，
// 服务端规范化照抄旧 /api/vertex/{image,image-chat,video,tts,music} 路由的夹紧逻辑——行为逐项一致：
//   图像：比例按模型放行（imgAspectFor，超宽比例只 2.1 认）、尺寸按模型夹紧（lite 只 1K，不认的落到最大档）、
//         思考 / 联网 / 图片搜索按模型门控、人物生成只 Nano Banana（dev API 通道不认，大尺寸下丢掉）、temperature / topP 夹紧；
//   视频：比例只 auto / 16:9 / 9:16、分辨率按模型夹紧（不认的落到 720p 或最高档）、时长取最近的合法档、
//         Veo 专属三件（负面提示词 / 提示词增强 / 画质）Omni 一律不传、任务类型按给的素材定；
//   配音：音色白名单（30 个）、风格前缀 ≤120 字、多人对白最多 2 人；
//   音乐：负面提示词只 lyria-002 吃。
// 前端拿到的 ParamSpec 默认值同旧面板（图像比例 auto、尺寸不传、温度 1、top_p 0.95；视频 720p / 8 秒 / 无音频）。

import {
  CAPABILITIES, IMAGE_SIZES, imgAspectFor, imgSizeClamp, IMG_THINK_SUPPORT, IMG_THINK_LEVELS, IMG_SEARCH_SUPPORT, IMG_IMGSEARCH_SUPPORT,
  IMG_PERSON_GEN, VEO_ASPECTS, VEO_RESOLUTIONS, veoResSupport, veoDurClamp, veoDurSupport, veoOnlyParams, VEO_QUALITIES,
  TTS_VOICES, TTS_VOICE_DEFAULT, TTS_MAX_SPEAKERS, musicNegSupport,
} from '@bridge/core/config/capabilities.mjs';
import { P, opts } from './spec.mjs';

const C = CAPABILITIES;
const nameOf = (list, id) => (list.find((m) => m.id === id) || {}).name || id;
const DEV_BIG = new Set(C.image.devBig || []);
const AUDIO_FIXED = new Set(C.veo.audioFixed || []);
const clampNum = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;

// 各方言能跑的 Google 模型（gemini 方言 = Gemini Developer API Key：2.1 的真 2K/4K、Omni、lyria-3 系列）
export const GOOGLE_MODELS = Object.freeze({
  vertex: {
    image: ['gemini-3-pro-image', 'gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'],
    video: ['veo-3.1-fast-generate-001', 'veo-3.1-generate-001', 'veo-3.1-lite-generate-001'],
    speech: C.tts.models.map((m) => m.id),
    music: ['lyria-002'],
  },
  gemini: {
    image: ['gemini-nano-banana-2.1'],
    video: ['gemini-omni-1.1-flash'],
    speech: [],
    music: ['lyria-3.5', 'lyria-3-clip-preview', 'lyria-3-pro-preview'],
  },
});
// 裸模型 id 默认归哪个方言（Claude 工具 / 旧接口传裸 id 时据此找服务）
export function googleDialectOf(id) {
  if (/^gemini-omni/.test(id) || /^lyria-3/.test(id)) return 'gemini';
  return 'vertex';
}

const VIDEO_LABEL = (id) => (/^veo/.test(id) ? 'Veo ' : 'Gemini ') + nameOf(C.veo.models, id);
const TTS_LABEL = (id) => ({ 'gemini-2.5-flash-tts': 'Gemini 2.5 Flash TTS', 'gemini-3.1-flash-tts-preview': 'Gemini 3.1 Flash TTS', 'gemini-2.5-pro-tts': 'Gemini 2.5 Pro TTS' })[id] || nameOf(C.tts.models, id);

// —— 图像 ——
function imageCard(model, dialect) {
  const sizes = (C.image.sizeSupport[model] || ['1K', '2K', '4K']).filter((s) => s !== 'custom');
  const aspects = C.image.aspects.filter((a) => !a.only || a.only.includes(model));
  // dev API 不认 personGeneration：gemini 方言整个不给；vertex 方言上 2.1 的 2K / 4K 走 dev API，那时也不给
  const personOk = dialect !== 'gemini';
  const params = [
    P.enum('aspectRatio', '比例', aspects.map((a) => ({ value: a.id, label: a.name })), { default: 'auto' }),
    P.enum('imageSize', '尺寸', [{ value: '', label: '默认' }, ...sizes.map((s) => ({ value: s, label: s, ...(DEV_BIG.has(model) && dialect === 'vertex' && s !== '1K' ? { note: '走 Gemini API 预付费额度，出 JPEG' } : {}) }))], { default: '' }),
  ];
  if (IMG_THINK_SUPPORT.has(model)) params.push(P.enum('thinkingLevel', '思考', [{ value: '', label: '默认' }, ...C.image.thinkLevels.map((x) => ({ value: x.id, label: x.name }))], { group: 'advanced', default: '' }));
  if (IMG_SEARCH_SUPPORT.has(model)) params.push(P.bool('useSearch', '联网搜索', { default: false, desc: '真实世界的人物、地标、品牌、新事物更准' }));
  if (IMG_IMGSEARCH_SUPPORT.has(model)) params.push(P.bool('useImageSearch', '图片搜索', { default: false, desc: '含联网搜索' }));
  if (personOk) params.push(P.enum('personGeneration', '人物生成', C.image.personGen.map((x) => ({ value: x.id, label: x.name })), { group: 'advanced', default: '', ...(DEV_BIG.has(model) ? { when: { imageSize: ['', '1K'] } } : {}) }));
  params.push(
    P.enum('outputFormat', '输出', [{ value: 'both', label: '图文' }, { value: 'image', label: '仅图' }], { group: 'advanced', default: 'both' }),
    P.num('temperature', '温度', 0, 2, { step: 0.05, default: 1 }),
    P.num('topP', 'Top P', 0, 1, { step: 0.01, default: 0.95 }),
  );
  return {
    id: `google:${model}`, kind: 'image', async: false,
    label: nameOf(C.image.models, model),
    desc: DEV_BIG.has(model) ? '画质与文字渲染更好，独有超宽比例 4:1 / 1:4 / 8:1 / 1:8' : undefined,
    inputs: { text: true, images: { max: 3, roles: ['edit', 'ref'] }, multiTurn: true },
    params,
    normalize(raw = {}) {
      const isNano = !/^imagen/.test(model);
      const imageSize = imgSizeClamp(model, IMAGE_SIZES.has(raw.imageSize) ? raw.imageSize : undefined);
      const useImageSearch = IMG_IMGSEARCH_SUPPORT.has(model) && raw.useImageSearch === true;
      const out = {
        aspectRatio: imgAspectFor(model, raw.aspectRatio),
        imageSize,
        thinkingLevel: (IMG_THINK_SUPPORT.has(model) && IMG_THINK_LEVELS.has(raw.thinkingLevel)) ? raw.thinkingLevel : undefined,
        useImageSearch,
        useSearch: useImageSearch || (IMG_SEARCH_SUPPORT.has(model) && raw.useSearch === true),
        personGeneration: personOk && isNano && IMG_PERSON_GEN.has(raw.personGeneration) ? raw.personGeneration : undefined,
        temperature: isNano ? clampNum(raw.temperature, 0, 2) : undefined,
        topP: isNano ? clampNum(raw.topP, 0, 1) : undefined,
        outputFormat: raw.outputFormat === 'image' ? 'image' : 'both',
      };
      return strip(out);
    },
  };
}

// —— 视频 ——
function videoCard(model) {
  const veoOnly = veoOnlyParams(model);
  const caps = C.veo.imgCaps[model] || { last: false, ref: 0 };
  const res = veoResSupport(model);
  const params = [
    P.enum('aspectRatio', '比例', C.veo.aspects.map((a) => ({ value: a.id, label: a.name })), { default: 'auto' }),
    P.enum('resolution', '分辨率', res.map((r) => ({ value: r, label: r === '4k' ? '4K' : r })), { default: res.includes('720p') ? '720p' : res[res.length - 1] }),
    P.enum('durationSeconds', '时长', veoDurSupport(model).map((d) => ({ value: d, label: d + ' 秒' })), { default: veoDurClamp(model, C.veo.defaults.duration) }),
  ];
  if (!AUDIO_FIXED.has(model)) params.push(P.bool('generateAudio', '生成音频', { group: 'basic', default: false }));
  if (veoOnly) {
    params.push(
      P.bool('enhancePrompt', '提示词增强', { default: true }),
      P.enum('compressionQuality', '画质', C.veo.qualities.map((q) => ({ value: q.id, label: q.name })), { group: 'advanced', default: '' }),
    );
  }
  const roles = ['first', ...(caps.last ? ['last'] : []), ...(caps.ref ? ['ref'] : [])];
  return {
    id: `google:${model}`, kind: 'video', async: true, label: VIDEO_LABEL(model),
    desc: AUDIO_FIXED.has(model) ? '原生音轨与对白，360p 低价预览档，时长 3–10 秒' : undefined,
    inputs: { text: true, images: { max: Math.max(1, caps.ref || 0), roles }, negative: veoOnly },
    params,
    // 任务类型不是 API 字段，按给的素材定（适配器里）；这里只夹参数
    normalize(raw = {}) {
      let resolution = VEO_RESOLUTIONS.has(raw.resolution) ? raw.resolution : '720p';
      const allowed = veoResSupport(model);
      if (!allowed.includes(resolution)) resolution = allowed.includes('720p') ? '720p' : allowed[allowed.length - 1];
      return strip({
        aspectRatio: VEO_ASPECTS.has(raw.aspectRatio) ? raw.aspectRatio : 'auto',
        resolution,
        durationSeconds: veoDurClamp(model, raw.durationSeconds),
        generateAudio: raw.generateAudio === true,
        enhancePrompt: veoOnly && raw.enhancePrompt === false ? false : undefined,
        compressionQuality: (veoOnly && VEO_QUALITIES.has(raw.compressionQuality) && raw.compressionQuality) || undefined,
      });
    },
    // 负面提示词：Veo 专属，≤500 字（Omni 传过去会 400）
    negative: (s) => (veoOnly && typeof s === 'string' ? s.trim().slice(0, 500) : ''),
  };
}

// —— 配音 ——
const VOICES = C.tts.voices.map((v) => ({ value: v.id, label: v.name }));
export const GOOGLE_VOICES = VOICES;
function speechCard(model) {
  return {
    id: `google:${model}`, kind: 'speech', async: false, label: TTS_LABEL(model),
    inputs: { text: true },
    params: [
      P.voice('voice', '音色', { default: TTS_VOICE_DEFAULT, options: VOICES }),
      P.text('style', '风格', { group: 'basic', max: 120, default: '', options: C.tts.styles.map((s) => ({ value: s.id, label: s.name })), desc: '自然语言的语气说明，拼在正文前面' }),
      P.text('speakerA', '说话人 A', { max: 24, desc: '多人对白：正文里写「名字：台词」，名字和这里对上' }),
      P.voice('voiceA', 'A 的音色', { group: 'advanced', options: VOICES, when: undefined }),
      P.text('speakerB', '说话人 B', { max: 24 }),
      P.voice('voiceB', 'B 的音色', { group: 'advanced', options: VOICES }),
    ],
    normalize(raw = {}) {
      // 多人对白：两种写法都收——speakers:[{speaker,voice}]（旧接口）或 speakerA/voiceA/speakerB/voiceB（创作页）
      const list = Array.isArray(raw.speakers) ? raw.speakers : [{ speaker: raw.speakerA, voice: raw.voiceA }, { speaker: raw.speakerB, voice: raw.voiceB }];
      const speakers = list
        .map((sp) => ({ speaker: String(sp?.speaker ?? '').trim().slice(0, 24), voice: TTS_VOICES.has(sp?.voice) ? sp.voice : '' }))
        .filter((sp) => sp.speaker && sp.voice)
        .slice(0, TTS_MAX_SPEAKERS);
      return strip({
        voice: TTS_VOICES.has(raw.voice) ? raw.voice : TTS_VOICE_DEFAULT,
        style: String(raw.style ?? '').trim().slice(0, 120),
        speakers: speakers.length >= 2 ? speakers : undefined,
      });
    },
  };
}

// —— 音乐 ——
function musicCard(model) {
  const neg = musicNegSupport(model);
  const m = C.music.models.find((x) => x.id === model) || {};
  return {
    id: `google:${model}`, kind: 'music', async: true, label: m.name || model, desc: m.desc,
    inputs: { text: true, negative: neg, ...(C.music.promptLang?.[model] ? { promptLang: C.music.promptLang[model] } : {}) },
    params: [],
    normalize: () => ({}),
    negative: (s) => (neg && s ? String(s).trim() : ''),
  };
}

// gemini 方言（dev API Key）也认 Vertex 清单里的 Nano Banana 与 TTS（同一个模型、同一套参数矩阵；dev API 不认人物生成，
// imageCard 按方言已经去掉了）。2026-11-06 自动识别：Gemini API 的 models.list 列着它们，卡按这里出（参数来源算「内置卡」）。
const GEMINI_ALSO = { image: GOOGLE_MODELS.vertex.image, speech: GOOGLE_MODELS.vertex.speech };

/** 按种类、以 matrix 这个已知模型的参数矩阵出一张卡（matrix 必须是 capabilities 里认得的 Google 模型）。 */
export function googleBuild(dialect, kind, matrix) {
  if (kind === 'image') return imageCard(matrix, dialect);
  if (kind === 'video') return videoCard(matrix);
  if (kind === 'speech') return speechCard(matrix);
  if (kind === 'music') return musicCard(matrix);
  return null;
}
/** 同族继承的候选：两个 Google 方言里这种的全部内置模型 [{ id, dialect }]。 */
export function googleCandidates(kind) {
  const out = [];
  for (const d of ['gemini', 'vertex']) for (const id of GOOGLE_MODELS[d][kind] || []) if (!out.some((x) => x.id === id)) out.push({ id, dialect: d });
  return out;
}

const cache = new Map();
/** Google 模型卡：dialect = vertex | gemini；不是这个方言能跑的 Google 模型回 null。 */
export function googleCard(dialect, model) {
  const k = dialect + ':' + model;
  if (cache.has(k)) return cache.get(k);
  const lists = GOOGLE_MODELS[dialect];
  let card = null;
  if (lists) {
    if (lists.image.includes(model)) card = imageCard(model, dialect);
    else if (lists.video.includes(model)) card = videoCard(model);
    else if (lists.speech.includes(model)) card = speechCard(model);
    else if (lists.music.includes(model)) card = musicCard(model);
    else if (dialect === 'gemini' && GEMINI_ALSO.image.includes(model)) card = imageCard(model, dialect);
    else if (dialect === 'gemini' && GEMINI_ALSO.speech.includes(model)) card = speechCard(model);
  }
  cache.set(k, card);
  return card;
}

// 去掉 undefined 值（驱动用「没给」判断要不要传这个键）
function strip(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }
