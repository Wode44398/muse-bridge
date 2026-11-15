// Google 系模型卡（vertex / gemini 两个方言共用）：参数矩阵从 src/config/capabilities.mjs 转写，
// 服务端规范化照抄旧 /api/vertex/{image,image-chat,video,tts,music} 路由的夹紧逻辑——旧参数行为逐项一致：
//   图像：比例按模型放行（超宽比例只 2.1 与 3.1 Flash）、尺寸按模型夹紧（lite 只 1K，512 只 3.1 Flash，不认的落到最大档）、
//         思考档按型号（2.1 三档、3.1 Flash / Lite 两档）、联网 / 图片搜索按模型门控、人物生成只 Vertex（2.5 不给；
//         dev API 通道不认，大尺寸下丢掉）、temperature / topP 夹紧；
//         2026-11-15 新增：种子（2.1 不给）、输出格式 + JPEG 质量、名人（后两项只 Vertex 通道）；参考图张数按型号（14 / 2.5 是 3）。
//   视频：比例只 auto / 16:9 / 9:16、分辨率按模型夹紧（不认的落到 720p 或最高档）、时长取最近的合法档、
//         Veo 专属三件（负面提示词 / 提示词增强 / 画质）Omni 一律不传、任务类型按给的素材定；
//         2026-11-15 新增：种子（两家）、Veo 的人物生成 / 首帧适配 / 条数；Omni 首尾帧（两款）与参考图（1.2），首尾帧时长 ≤10 秒。
//   配音：音色白名单（30 个）、风格前缀 ≤120 字、多人对白最多 2 人；2026-11-15 新增：说话人模式（单人 / 双人对白，
//         没给 mode 时行为同以前）、语言；3.8 两款的风格走 speechMetadata（适配器里）。
//   音乐：负面提示词只 lyria-002 吃；2026-11-15 新增：lyria-002 的种子 / 条数、lyria-3.5 的输出格式与参考图。
// 前端拿到的 ParamSpec 默认值同旧面板（图像比例 auto、尺寸不传、温度 1、top_p 0.95；视频 720p / 8 秒 / 无音频）；
// 新参数的默认值一律「不传」（或与上游默认一致），不改变现有默认行为与计费。

import {
  CAPABILITIES, imgCardSizes, imgCardSizeClamp, imgCardAspectFor, imgCardAspectOk, imgThinkLevelsFor, imgRefMax, imgPersonGenOk, imgSeedOk,
  IMG_OUTPUT_MIMES, IMG_PROMINENT, IMG_SEARCH_SUPPORT, IMG_IMGSEARCH_SUPPORT, IMG_PERSON_GEN,
  VEO_ASPECTS, VEO_RESOLUTIONS, veoResSupport, veoDurClamp, veoDurSupport, veoOnlyParams, VEO_QUALITIES, VEO_PERSON_GEN, VEO_RESIZE_MODES, veoInterpMaxDur,
  TTS_VOICES, TTS_VOICE_DEFAULT, TTS_MAX_SPEAKERS, ttsMetaStyle, TTS_LANGUAGES,
  musicNegSupport, musicMaxCount, musicWavOk, musicImageMax,
} from '@bridge/core/config/capabilities.mjs';
import { P } from './spec.mjs';

const C = CAPABILITIES;
const nameOf = (list, id) => (list.find((m) => m.id === id) || {}).name || id;
const DEV_BIG = new Set(C.image.devBig || []);
const AUDIO_FIXED = new Set(C.veo.audioFixed || []);
const clampNum = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;
// 整数参数（种子 / 条数 / 质量）：数字或数字串都收，取整后夹紧；空 / 坏值 = 不传
const clampInt = (v, lo, hi) => {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined;
};
// 种子上限：Gemini 的 generationConfig.seed / Interactions 的 generation_config.seed 是 int32；Veo 的 parameters.seed 文档写 uint32
const INT32 = 2147483647, UINT32 = 4294967295;

// Omni 1.2 不在 capabilities 的 veo.models 里（那张清单是 Claude 媒体工具 / 旧接口的白名单），名字在这里补
const VIDEO_NAMES = { 'gemini-omni-1.2-flash': 'Omni 1.2' };

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
    video: ['gemini-omni-1.1-flash', 'gemini-omni-1.2-flash'],
    speech: [],
    music: ['lyria-3.5', 'lyria-3-clip-preview', 'lyria-3-pro-preview'],
  },
});
// 裸模型 id 默认归哪个方言（Claude 工具 / 旧接口传裸 id 时据此找服务）
export function googleDialectOf(id) {
  if (/^gemini-omni/.test(id) || /^lyria-3/.test(id)) return 'gemini';
  return 'vertex';
}

const VIDEO_LABEL = (id) => (/^veo/.test(id) ? 'Veo ' : 'Gemini ') + (VIDEO_NAMES[id] || nameOf(C.veo.models, id));
const TTS_NAMES = {
  'gemini-2.5-flash-tts': 'Gemini 2.5 Flash TTS', 'gemini-3.1-flash-tts-preview': 'Gemini 3.1 Flash TTS', 'gemini-2.5-pro-tts': 'Gemini 2.5 Pro TTS',
  'gemini-3.8-flash-tts': 'Gemini 3.8 Flash TTS', 'gemini-3.8-flash-lite-tts': 'Gemini 3.8 Flash-Lite TTS',
  'gemini-2.5-flash-preview-tts': 'Gemini 2.5 Flash TTS', 'gemini-2.5-pro-preview-tts': 'Gemini 2.5 Pro TTS',
};
const TTS_LABEL = (id) => TTS_NAMES[id] || nameOf(C.tts.models, id);
const opt = (list) => list.map((x) => ({ value: x.id, label: x.name }));

// —— 图像 ——
function imageCard(model, dialect) {
  const sizes = imgCardSizes(model).filter((s) => s !== 'custom');
  const aspects = C.image.aspects.filter((a) => imgCardAspectOk(model, a.id));
  const thinkLevels = imgThinkLevelsFor(model);
  // dev API 不认 personGeneration / prominentPeople / 输出格式：gemini 方言整个不给；vertex 方言上 2.1 的 2K / 4K 走 dev API，那时也不给
  const vertex = dialect !== 'gemini';
  const personOk = vertex && imgPersonGenOk(model);
  const devBigWhen = DEV_BIG.has(model) ? { imageSize: ['', '1K'] } : null;
  const params = [
    P.enum('aspectRatio', '比例', aspects.map((a) => ({ value: a.id, label: a.name })), { default: 'auto' }),
    P.enum('imageSize', '尺寸', [{ value: '', label: '默认' }, ...sizes.map((s) => ({ value: s, label: s, ...(DEV_BIG.has(model) && vertex && s !== '1K' ? { note: '走 Gemini API 预付费额度，出 JPEG' } : {}) }))], { default: '' }),
  ];
  if (thinkLevels.length) params.push(P.enum('thinkingLevel', '思考', [{ value: '', label: '默认' }, ...thinkLevels.map((x) => ({ value: x, label: C.image.thinkLevelNames[x] || x }))], { group: 'advanced', default: '' }));
  if (IMG_SEARCH_SUPPORT.has(model)) params.push(P.bool('useSearch', '联网搜索', { default: false, desc: '真实世界的人物、地标、品牌、新事物更准' }));
  if (IMG_IMGSEARCH_SUPPORT.has(model)) params.push(P.bool('useImageSearch', '图片搜索', { default: false, desc: '含联网搜索' }));
  if (personOk) {
    params.push(P.enum('personGeneration', '人物生成', opt(C.image.personGen), { group: 'advanced', default: '', ...(devBigWhen ? { when: devBigWhen } : {}) }));
    params.push(P.enum('prominentPeople', '名人', opt(C.image.prominentPeople), { group: 'advanced', default: '', ...(devBigWhen ? { when: devBigWhen } : {}) }));
  }
  params.push(P.enum('outputFormat', '输出', [{ value: 'both', label: '图文' }, { value: 'image', label: '仅图' }], { group: 'advanced', default: 'both' }));
  if (vertex) {
    params.push(
      P.enum('outputMimeType', '格式', opt(C.image.outputMimes), { group: 'advanced', default: '', ...(devBigWhen ? { when: devBigWhen } : {}) }),
      P.num('compressionQuality', 'JPEG 质量', 0, 100, { step: 1, integer: true, when: { outputMimeType: 'image/jpeg', ...(devBigWhen || {}) } }),
    );
  }
  params.push(
    P.num('temperature', '温度', 0, 2, { step: 0.05, default: 1 }),
    P.num('topP', 'Top P', 0, 1, { step: 0.01, default: 0.95 }),
  );
  if (imgSeedOk(model)) params.push(P.seed({ max: INT32, desc: '不填 = 随机' }));
  return {
    id: `google:${model}`, kind: 'image', async: false,
    label: nameOf(C.image.models, model),
    desc: DEV_BIG.has(model) ? '画质与文字渲染更好，独有超宽比例 4:1 / 1:4 / 8:1 / 1:8' : undefined,
    inputs: { text: true, images: { max: imgRefMax(model), roles: ['edit', 'ref'] }, multiTurn: true },
    params,
    normalize(raw = {}) {
      const isNano = !/^imagen/.test(model);
      const imageSize = imgCardSizeClamp(model, raw.imageSize);
      const useImageSearch = IMG_IMGSEARCH_SUPPORT.has(model) && raw.useImageSearch === true;
      // 2.1 的 2K / 4K 走 dev API：Vertex 专属的几项丢掉（适配器那头也会再丢一遍）
      const vertexOnly = vertex && !(DEV_BIG.has(model) && (imageSize === '2K' || imageSize === '4K'));
      const outputMimeType = vertexOnly && IMG_OUTPUT_MIMES.has(raw.outputMimeType) ? raw.outputMimeType : undefined;
      const out = {
        aspectRatio: imgCardAspectFor(model, raw.aspectRatio),
        imageSize,
        thinkingLevel: thinkLevels.includes(raw.thinkingLevel) ? raw.thinkingLevel : undefined,
        useImageSearch,
        useSearch: useImageSearch || (IMG_SEARCH_SUPPORT.has(model) && raw.useSearch === true),
        personGeneration: personOk && isNano && IMG_PERSON_GEN.has(raw.personGeneration) ? raw.personGeneration : undefined,
        temperature: isNano ? clampNum(raw.temperature, 0, 2) : undefined,
        topP: isNano ? clampNum(raw.topP, 0, 1) : undefined,
        outputFormat: raw.outputFormat === 'image' ? 'image' : 'both',
        prominentPeople: personOk && vertexOnly && IMG_PROMINENT.has(raw.prominentPeople) ? raw.prominentPeople : undefined,
        outputMimeType,
        compressionQuality: outputMimeType === 'image/jpeg' ? clampInt(raw.compressionQuality, 0, 100) : undefined,
        seed: imgSeedOk(model) ? clampInt(raw.seed, 0, INT32) : undefined,
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
  const interpMax = veoInterpMaxDur(model);
  // 参考图生成视频只支持 8 秒（Veo 3.1 模型页）：有参考图时其余档不成立。Omni 首尾帧插值只能 ≤10 秒：给了尾帧时更长的档不成立
  const durOnly = (d) => {
    if (veoOnly && caps.ref && d !== 8) return { only: { $ref: false } };
    if (interpMax && d > interpMax) return { only: { $last: false } };
    return {};
  };
  const params = [
    P.enum('aspectRatio', '比例', C.veo.aspects.map((a) => ({ value: a.id, label: a.name })), { default: 'auto' }),
    P.enum('resolution', '分辨率', res.map((r) => ({ value: r, label: r === '4k' ? '4K' : r })), { default: res.includes('720p') ? '720p' : res[res.length - 1] }),
    P.enum('durationSeconds', '时长', veoDurSupport(model).map((d) => ({ value: d, label: d + ' 秒', ...durOnly(d) })), { default: veoDurClamp(model, C.veo.defaults.duration) }),
  ];
  if (!AUDIO_FIXED.has(model)) params.push(P.bool('generateAudio', '生成音频', { group: 'basic', default: false }));
  if (veoOnly) {
    params.push(
      P.num('count', '条数', 1, 4, { step: 1, integer: true, default: 1, group: 'basic', format: 'count' }),
      P.bool('enhancePrompt', '提示词增强', { default: true }),
      P.enum('compressionQuality', '压缩方式', C.veo.qualities.map((q) => ({ value: q.id, label: q.name })), { group: 'advanced', default: '' }),
      P.enum('personGeneration', '人物生成', opt(C.veo.personGen), { group: 'advanced', default: '' }),
      P.enum('resizeMode', '首帧适配', opt(C.veo.resizeModes), { group: 'advanced', default: '', when: { $first: true } }),
    );
  }
  params.push(P.seed({ max: veoOnly ? UINT32 : INT32, desc: '不填 = 随机' }));
  const roles = ['first', ...(caps.last ? ['last'] : []), ...(caps.ref ? ['ref'] : [])];
  return {
    id: `google:${model}`, kind: 'video', async: true, label: VIDEO_LABEL(model),
    desc: AUDIO_FIXED.has(model) ? `原生音轨与对白，360p 低价预览档，时长 3–${veoDurSupport(model).slice(-1)[0]} 秒` : undefined,
    inputs: { text: true, images: { max: Math.max(1, caps.ref || 0), roles }, negative: veoOnly },
    params,
    // 任务类型不是我们让用户选的，按给的素材定（适配器里）；这里只夹参数
    normalize(raw = {}, ctx = {}) {
      let resolution = VEO_RESOLUTIONS.has(raw.resolution) ? raw.resolution : '720p';
      let dur = veoOnly && caps.ref && ctx.$ref ? 8 : veoDurClamp(model, raw.durationSeconds);
      if (interpMax && ctx.$last && dur > interpMax) dur = interpMax;
      const allowed = veoResSupport(model);
      if (!allowed.includes(resolution)) resolution = allowed.includes('720p') ? '720p' : allowed[allowed.length - 1];
      return strip({
        aspectRatio: VEO_ASPECTS.has(raw.aspectRatio) ? raw.aspectRatio : 'auto',
        resolution,
        durationSeconds: dur,
        generateAudio: raw.generateAudio === true,
        enhancePrompt: veoOnly && raw.enhancePrompt === false ? false : undefined,
        compressionQuality: (veoOnly && VEO_QUALITIES.has(raw.compressionQuality) && raw.compressionQuality) || undefined,
        count: veoOnly ? clampInt(raw.count, 1, 4) : undefined,
        personGeneration: veoOnly && VEO_PERSON_GEN.has(raw.personGeneration) ? raw.personGeneration : undefined,
        resizeMode: veoOnly && ctx.$first && VEO_RESIZE_MODES.has(raw.resizeMode) ? raw.resizeMode : undefined,
        seed: clampInt(raw.seed, 0, veoOnly ? UINT32 : INT32),
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
  const meta = ttsMetaStyle(model);
  return {
    id: `google:${model}`, kind: 'speech', async: false, label: TTS_LABEL(model),
    inputs: { text: true },
    params: [
      P.enum('mode', '说话人', [{ value: 'single', label: '单人' }, { value: 'multi', label: '双人对白' }], { default: 'single' }),
      P.voice('voice', '音色', { default: TTS_VOICE_DEFAULT, options: VOICES, when: { mode: 'single' } }),
      P.text('speakerA', '说话人 A', { group: 'basic', max: 24, when: { mode: 'multi' }, desc: '正文里写「名字：台词」，名字和这里对上' }),
      P.voice('voiceA', 'A 的音色', { options: VOICES, when: { mode: 'multi' } }),
      P.text('speakerB', '说话人 B', { group: 'basic', max: 24, when: { mode: 'multi' } }),
      P.voice('voiceB', 'B 的音色', { options: VOICES, when: { mode: 'multi' } }),
      P.text('style', '风格', { group: 'basic', max: 120, default: '', options: C.tts.styles.map((s) => ({ value: s.id, label: s.name })), desc: meta ? '自然语言的语气说明，单独传给模型、不念出来' : '自然语言的语气说明，拼在正文前面' }),
      P.enum('languageCode', '语言', opt(C.tts.languages), { group: 'advanced', default: '' }),
    ],
    normalize(raw = {}) {
      // 说话人模式：没给 mode = 旧写法，行为同以前（speakers:[{speaker,voice}] 或 speakerA/voiceA/speakerB/voiceB 凑够 2 人就是多人）；
      // mode:'single' 忽略说话人字段；mode:'multi' 才组 speakers（凑不够 2 人退回单人）
      const mode = raw.mode === 'single' || raw.mode === 'multi' ? raw.mode : undefined;
      let speakers;
      if (mode !== 'single') {
        const list = Array.isArray(raw.speakers) ? raw.speakers : [{ speaker: raw.speakerA, voice: raw.voiceA }, { speaker: raw.speakerB, voice: raw.voiceB }];
        speakers = list
          .map((sp) => ({ speaker: String(sp?.speaker ?? '').trim().slice(0, 24), voice: TTS_VOICES.has(sp?.voice) ? sp.voice : '' }))
          .filter((sp) => sp.speaker && sp.voice)
          .slice(0, TTS_MAX_SPEAKERS);
      }
      return strip({
        voice: TTS_VOICES.has(raw.voice) ? raw.voice : TTS_VOICE_DEFAULT,
        style: String(raw.style ?? '').trim().slice(0, 120),
        speakers: speakers && speakers.length >= 2 ? speakers : undefined,
        ...(mode ? { mode } : {}),
        languageCode: TTS_LANGUAGES.has(raw.languageCode) ? raw.languageCode : undefined,
      });
    },
  };
}

// —— 音乐 ——
function musicCard(model) {
  const neg = musicNegSupport(model);
  const maxCount = musicMaxCount(model);
  const wav = musicWavOk(model);
  const imgMax = musicImageMax(model);
  const m = C.music.models.find((x) => x.id === model) || {};
  const params = [];
  if (maxCount > 1) {
    params.push(
      P.num('count', '条数', 1, maxCount, { step: 1, integer: true, default: 1, group: 'basic', format: 'count' }),
      P.seed({ max: INT32, desc: '给了种子只出一条（和条数互斥，种子优先）' }),
    );
  }
  if (wav) params.push(P.enum('outputFormat', '格式', [{ value: '', label: 'MP3' }, { value: 'wav', label: 'WAV' }], { group: 'advanced', default: '' }));
  return {
    id: `google:${model}`, kind: 'music', async: true, label: m.name || model, desc: m.desc,
    inputs: {
      text: true, negative: neg,
      ...(imgMax ? { images: { max: imgMax, roles: ['ref'] } } : {}),
      ...(C.music.promptLang?.[model] ? { promptLang: C.music.promptLang[model] } : {}),
    },
    params,
    normalize(raw = {}) {
      const seed = maxCount > 1 ? clampInt(raw.seed, 0, INT32) : undefined;
      return strip({
        seed,
        // 种子和条数上游互斥：给了种子就不发条数
        count: maxCount > 1 && seed === undefined ? clampInt(raw.count, 1, maxCount) : undefined,
        outputFormat: wav && raw.outputFormat === 'wav' ? 'wav' : undefined,
      });
    },
    negative: (s) => (neg && s ? String(s).trim() : ''),
  };
}

// gemini 方言（dev API Key）也认 Vertex 清单里的 Nano Banana 与 TTS（同一个模型、同一套参数矩阵；dev API 不认人物生成等 Vertex 专属项，
// imageCard 按方言已经去掉了）。2026-11-06 自动识别：Gemini API 的 models.list 列着它们，卡按这里出（参数来源算「内置卡」）。
// TTS 在 dev API 上的 id 和 Vertex 不全一样（2.5 两款带 -preview，见 capabilities tts.devIds）：按 dev API 的真实 id 认，矩阵用对应的 Vertex id。
const GEMINI_ALSO = { image: GOOGLE_MODELS.vertex.image, speech: GOOGLE_MODELS.vertex.speech.map((id) => C.tts.devIds[id] || id) };
const devSpeechMatrix = (id) => Object.keys(C.tts.devIds).find((k) => C.tts.devIds[k] === id) || id;

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
    else if (dialect === 'gemini' && GEMINI_ALSO.speech.includes(model)) card = { ...speechCard(devSpeechMatrix(model)), id: `google:${model}`, label: TTS_LABEL(model) };
  }
  cache.set(k, card);
  return card;
}

// 去掉 undefined 值（驱动用「没给」判断要不要传这个键）
function strip(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }
