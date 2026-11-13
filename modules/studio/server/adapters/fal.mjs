// fal 方言（图像 / 视频 / 配音 / 音乐）：队列 API——提交、轮询状态、取结果；模型 id 任填，常见模型带卡（CARDS，导入时登记）。
//
// 查的文档（2026-11-04，fal.ai/docs 下；docs.fal.ai 会 308 到 fal.ai/docs）：
// · 队列 https://fal.ai/docs/model-apis/model-endpoints/queue
//   提交 POST https://queue.fal.run/{model_id}，body 即模型 input 的 JSON → { request_id, response_url, status_url, cancel_url, queue_position }
//   状态 GET status_url（可加 ?logs=1，日志只给应用所有者）：status 为 IN_QUEUE / IN_PROGRESS / COMPLETED；失败时 COMPLETED 带 error / error_type
//   结果 GET response_url：输出随模型而变（图像 images[].url，视频 video.url，音频 audio.url 或 audio_url）
//   取消 PUT cancel_url：200 {status:"OK"} 还在排队、已撤；202 CANCELLATION_REQUESTED 已在跑、可能仍跑完；400 ALREADY_COMPLETED；404 NOT_FOUND
//   子路径模型（如 …/edit）：状态 / 结果 / 取消路径以提交返回的 URL 为准。队列页说除 owner/app 外的段拼进去会 405，openapi 里写的 …/edit/requests
//   又与之不一致，所以不自己拼；只有返回体缺字段或地址不同源时，才按 owner/app 兜底拼。
//   鉴权：Authorization: Key <key>（fal.ai/docs 首页示例；平台接口鉴权页同）。
//   计费时点：文档未写明（只说「只为用到的算力付费」）。按「提交即可能计费」对待：提交成功后立刻 ctx.submitted()，之后的失败不自动重试。
//   结果保留：文档只写「按媒体过期设置」，没给天数。结果 URL 是 fal CDN（v3b.fal.media），下载时不带 Key。
// · 参数与输出：https://api.fal.ai/v1/models?endpoint_id=<id>&expand=openapi-3.0 的 openapi（卡上的字段名、枚举、默认值、输出字段都照它）。
// · 模型列表：GET https://api.fal.ai/v1/models（category / status / limit；鉴权可选；metadata.kind 为 inference 或 training）→ listModels。
//   文档举例：text-to-image、image-to-video、text-to-video、training；text-to-speech、text-to-audio 是 2026-11-04 查平台列表时见到的值（文档未列全）。
// · test：GET https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/flux/dev。文档写的是：要有效 Key，任何已认证调用方都能用（没指定 preset）；
//   只返回单价，不建任务、不占队列。文档未写明是否免费，按只读元数据查询处理。401 → 「API Key 无效」。
// · 素材：fal CDN 页 https://fal.ai/docs/documentation/model-apis/fal-cdn：部分模型接受 base64 data URI，文档说不建议超过几 KB（内联进请求体，传得慢）；
//   推荐 CDN 上传（SDK fal.storage.upload，REST 上传路径文档未写明）。本适配器按 data URI 直传，没接 CDN 上传；数字上限文档未写明，大图会慢，以上游拒收原话为准。
// · 音色：MiniMax 系统音色表 https://platform.minimax.io/docs/faq/system-voice-id（332 个，按语言分组；文档未写明哪些语音模型通用）。
//   ElevenLabs 音色取 fal 文档示例名（fal 不校验音色名，写错由上游报错）。
// 未真打（没有 Key）：请求体、轮询、取消、结果抹平只在 fal.test.mjs 里用 mock fetch 覆盖。

import { http, authHeaders, joinUrl, download, poll, dataUrl, AdapterError, isTransient, longWaitMs } from './http.mjs';
import { P, genericCard } from '../cards/spec.mjs';
import { registerDialectCards } from '../cards/dialects.mjs';
import { wireBody } from '../discovery/schema.mjs';

const FAL_QUEUE = 'https://queue.fal.run';        // 默认提交地址（预设里也是这个）
const FAL_API = 'https://api.fal.ai/v1';          // 平台接口（模型列表、价格）固定在这里，不随服务地址走
const PRICE_PROBE = 'fal-ai/flux/dev';            // test() 用：查这个模型的单价，顺带验 Key
const POLL_MS = 4000;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;   // 模型 id 只许这些字符，拼进地址前先过滤
const LIST_CATEGORIES = ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video', 'text-to-speech', 'text-to-audio'];
const MEDIA_KEYS = {
  image: ['images', 'image'],
  video: ['video', 'videos'],
  speech: ['audio', 'audio_file', 'audio_url', 'audios'],
  music: ['audio', 'audio_file', 'audio_url', 'audios'],
};
const DEFAULT_MIME = { image: 'image/png', video: 'video/mp4', speech: 'audio/mpeg', music: 'audio/mpeg' };

// —— 小件 ——
const choices = (vals, labels = {}) => vals.map((v) => ({ value: v, label: labels[v] ?? String(v) }));
const secChoices = (list) => list.map((v) => ({ value: v, label: `${v} 秒` }));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));   // 字符串档（fal 的 duration 多是字符串枚举）
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
const need = (ok, msg) => { if (!ok) throw new AdapterError(msg); };
const sameOrigin = (u, base) => { try { return typeof u === 'string' && new URL(u).origin === new URL(base).origin; } catch { return false; } };

// —— 图像卡公共件 ——
const FLUX_SIZES = choices(['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'],
  { square_hd: '方形 · 高清', square: '方形', portrait_4_3: '竖版 4:3', portrait_16_9: '竖版 16:9', landscape_4_3: '横版 4:3', landscape_16_9: '横版 16:9' });
const NB_ASPECTS = ['auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1', '1:8'];
// Nano Banana 2（文生图与改图共用）：参数名照 openapi（nano-banana-2 与 …/edit 两份 schema 一致的字段）
const nanoParams = () => [
  P.enum('aspectRatio', '比例', choices(NB_ASPECTS, { auto: '自动' }), { default: 'auto' }),
  P.enum('resolution', '分辨率', choices(['0.5K', '1K', '2K', '4K']), { default: '1K' }),
  P.num('numImages', '张数', 1, 4, { step: 1, integer: true, default: 1, group: 'basic' }),
  P.enum('outputFormat', '格式', choices(['png', 'jpeg', 'webp']), { group: 'advanced', default: 'png' }),
  P.bool('enableWebSearch', '联网搜索', { default: false, desc: '真实世界的人物、地标、品牌更准' }),
  P.seed(),
  P.json(),
];
const nanoFields = (p) => ({ aspect_ratio: p.aspectRatio, resolution: p.resolution, num_images: p.numImages, output_format: p.outputFormat, enable_web_search: p.enableWebSearch, seed: p.seed });

// 视频卡公共件：时长是字符串枚举（Kling 3–15 秒、Seedance 4–12 秒）
const durParam = (list, def) => P.enum('durationSeconds', '时长', secChoices(list), { default: def });

// —— 模型卡（卡 id = fal 模型 id）：params 给前端渲染；wire(p, r) 把规范化后的参数译成该模型的请求字段
//    r = { prompt, negative, refs（改图参考的 data URI 列表）, first / last（首尾帧 data URI 或 ''） } ——
export const CARDS = {
  // —— 图像 ——
  'fal-ai/flux/dev': {
    kind: 'image', label: 'FLUX.1 [dev]', desc: '文生图，可调步数、引导强度和尺寸', async: false,
    inputs: { text: true, multiTurn: false },
    params: [
      P.enum('imageSize', '尺寸', FLUX_SIZES, { default: 'landscape_4_3' }),
      P.num('numImages', '张数', 1, 4, { step: 1, integer: true, default: 1, group: 'basic' }),
      P.num('steps', '推理步数', 1, 50, { step: 1, integer: true, default: 28 }),
      P.num('guidanceScale', '引导强度', 1, 20, { step: 0.5, default: 3.5 }),
      P.enum('outputFormat', '格式', choices(['jpeg', 'png']), { group: 'advanced', default: 'jpeg' }),
      P.seed(),
      P.json(),
    ],
    wire: (p, r) => clean({ prompt: r.prompt, image_size: p.imageSize, num_images: p.numImages, num_inference_steps: p.steps, guidance_scale: p.guidanceScale, output_format: p.outputFormat, seed: p.seed }),
  },
  'fal-ai/nano-banana-2': {
    kind: 'image', label: 'Nano Banana 2', desc: '文生图，分辨率最高 4K；支持联网搜索', async: false,
    inputs: { text: true, multiTurn: false },
    params: nanoParams(),
    wire: (p, r) => clean({ prompt: r.prompt, ...nanoFields(p) }),
  },
  'fal-ai/nano-banana-2/edit': {
    kind: 'image', label: 'Nano Banana 2 · 改图', desc: '按参考图改；没有素材时用续改链上的上一张', async: false,
    // 文档未写明 image_urls 的张数上限，先按 4 张封顶
    inputs: { text: true, images: { max: 4, roles: ['edit', 'ref'] }, multiTurn: false },
    params: nanoParams(),
    wire: (p, r) => {
      need(r.refs.length, '改图要先给一张参考图（没有素材时，续改链上的上一张也行）');
      return clean({ prompt: r.prompt, image_urls: r.refs, ...nanoFields(p) });
    },
  },

  // —— 视频 ——
  'fal-ai/kling-video/v3/pro/text-to-video': {
    kind: 'video', label: 'Kling v3 Pro · 文生视频', desc: '3–15 秒，可同步生成音频', async: true,
    inputs: { text: true, negative: true },
    params: [
      P.enum('aspectRatio', '比例', choices(['16:9', '9:16', '1:1'], { '16:9': '16:9 横', '9:16': '9:16 竖', '1:1': '1:1' }), { default: '16:9' }),
      durParam(range(3, 15), '5'),
      P.bool('generateAudio', '生成音频', { group: 'basic', default: true }),
      P.num('cfgScale', '提示遵循度', 0, 1, { step: 0.05, default: 0.5 }),
      P.json(),
    ],
    wire: (p, r) => clean({ prompt: r.prompt, aspect_ratio: p.aspectRatio, duration: p.durationSeconds, generate_audio: p.generateAudio, cfg_scale: p.cfgScale, negative_prompt: r.negative }),
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    kind: 'video', label: 'Kling v3 Pro · 图生视频', desc: '首帧必填，可加尾帧；首帧至少 300×300，宽高比 0.4–2.5（文档）', async: true,
    inputs: { text: true, images: { max: 2, roles: ['first', 'last'] }, negative: true },
    params: [
      durParam(range(3, 15), '5'),
      P.bool('generateAudio', '生成音频', { group: 'basic', default: true }),
      P.num('cfgScale', '提示遵循度', 0, 1, { step: 0.05, default: 0.5 }),
      P.json(),
    ],
    // 首帧字段名是 start_image_url（不是 image_url），尾帧 end_image_url
    wire: (p, r) => {
      need(r.first, '图生视频要先给首帧图片');
      return clean({ prompt: r.prompt, start_image_url: r.first, end_image_url: r.last, duration: p.durationSeconds, generate_audio: p.generateAudio, cfg_scale: p.cfgScale, negative_prompt: r.negative });
    },
  },
  'fal-ai/bytedance/seedance/v1.5/pro/text-to-video': {
    kind: 'video', label: 'Seedance 1.5 Pro · 文生视频', desc: '4–12 秒，可选音频与固定镜头', async: true,
    inputs: { text: true },
    params: [
      P.enum('aspectRatio', '比例', choices(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'auto'], { auto: '自动' }), { default: '16:9' }),
      P.enum('resolution', '分辨率', choices(['480p', '720p', '1080p']), { default: '720p' }),
      durParam(range(4, 12), '5'),
      P.bool('generateAudio', '生成音频', { group: 'basic', default: true }),
      P.bool('cameraFixed', '固定镜头', { default: false }),
      P.seed(),
      P.json(),
    ],
    wire: (p, r) => clean({ prompt: r.prompt, aspect_ratio: p.aspectRatio, resolution: p.resolution, duration: p.durationSeconds, camera_fixed: p.cameraFixed, generate_audio: p.generateAudio, seed: p.seed }),
  },

  // —— 配音 ——
  'fal-ai/minimax/speech-2.8-hd': {
    kind: 'speech', label: 'MiniMax Speech 2.8 HD', desc: '按 MiniMax 系统音色朗读；语速、音调、情绪可调', async: false,
    inputs: { text: true },
    params: [
      // 默认音色取官方表里的 Chinese (Mandarin)_Wise_Women（fal schema 的默认 Wise_Woman 不在官方表里）
      P.voice('voice', '音色', { default: 'Chinese (Mandarin)_Wise_Women' }),
      P.num('speed', '语速', 0.5, 2, { step: 0.05, default: 1, group: 'basic' }),
      P.num('vol', '音量', 0.01, 10, { step: 0.1, default: 1 }),
      P.num('pitch', '音调', -12, 12, { step: 1, integer: true, default: 0 }),
      P.enum('emotion', '情绪', [{ value: '', label: '默认' }, ...choices(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral'],
        { happy: '开心', sad: '悲伤', angry: '愤怒', fearful: '害怕', disgusted: '厌恶', surprised: '惊讶', neutral: '平静' })], { group: 'advanced', default: '' }),
      P.enum('audioFormat', '格式', choices(['mp3', 'flac']), { group: 'advanced', default: 'mp3' }),   // pcm 不给：裸 PCM 没有采样率信息，包 WAV 会变调
      P.json(),
    ],
    // 文档：output_format 默认 hex（内联十六进制，体积大），这里固定要 URL，结果走 download
    wire: (p, r) => ({
      prompt: r.prompt,
      output_format: 'url',
      voice_setting: clean({ voice_id: p.voice, speed: p.speed, vol: p.vol, pitch: p.pitch, emotion: p.emotion }),
      audio_setting: clean({ format: p.audioFormat }),
    }),
  },
  'fal-ai/elevenlabs/tts/turbo-v2.5': {
    kind: 'speech', label: 'ElevenLabs TTS Turbo v2.5', desc: '稳定度、相似度、风格可调；音色名按 ElevenLabs 预置音色填', async: false,
    inputs: { text: true },
    params: [
      P.voice('voice', '音色', { default: 'Rachel' }),
      P.num('speed', '语速', 0.7, 1.2, { step: 0.05, default: 1, group: 'basic' }),
      P.num('stability', '稳定度', 0, 1, { step: 0.05, default: 0.5 }),
      P.num('similarityBoost', '相似度', 0, 1, { step: 0.05, default: 0.75 }),
      P.num('style', '风格强度', 0, 1, { step: 0.05, default: 0 }),
      P.enum('applyTextNormalization', '文本规范化', choices(['auto', 'on', 'off'], { auto: '自动', on: '开', off: '关' }), { group: 'advanced', default: 'auto' }),
      P.text('languageCode', '语言代码', { max: 8, desc: 'ISO 639-1，如 zh、en；留空按文本自动判断' }),
      P.json(),
    ],
    // 这个模型的正文字段叫 text（不是 prompt）
    wire: (p, r) => clean({ text: r.prompt, voice: p.voice, speed: p.speed, stability: p.stability, similarity_boost: p.similarityBoost, style: p.style, apply_text_normalization: p.applyTextNormalization, language_code: p.languageCode }),
  },

  // —— 音乐 ——
  'fal-ai/stable-audio-25/text-to-audio': {
    kind: 'music', label: 'Stable Audio 2.5', desc: '文生音乐，最长 190 秒', async: true,
    inputs: { text: true },
    params: [
      P.num('durationSeconds', '时长（秒）', 1, 190, { step: 1, integer: true, default: 190, group: 'basic' }),
      P.num('steps', '推理步数', 4, 8, { step: 1, integer: true, default: 8 }),
      P.num('guidanceScale', '引导强度', 1, 25, { step: 0.5, default: 1 }),
      P.seed(),
      P.json(),
    ],
    wire: (p, r) => clean({ prompt: r.prompt, seconds_total: p.durationSeconds, num_inference_steps: p.steps, guidance_scale: p.guidanceScale, seed: p.seed }),
  },
  'fal-ai/lyria2': {
    kind: 'music', label: 'Lyria 2', desc: '文生音乐；支持负面提示词', async: true,
    inputs: { text: true, negative: true, promptLang: 'en' },   // 同一个模型（Lyria 2）只认英文提示词（Vertex 上 11-04 真打；fal 上未真打）
    params: [P.seed(), P.json()],
    wire: (p, r) => clean({ prompt: r.prompt, negative_prompt: r.negative, seed: p.seed }),
  },
  'fal-ai/minimax-music/v2.6': {
    kind: 'music', label: 'MiniMax Music 2.6', desc: '文生音乐，可写歌词或出纯音乐；提示词至少 10 个字符（文档）', async: true,
    inputs: { text: true },
    params: [
      P.bool('instrumental', '纯音乐（无人声）', { group: 'basic', default: false }),
      P.text('lyrics', '歌词', { max: 3500, group: 'basic', desc: '换行分段，可用 [Verse]、[Chorus] 等段落标签；留空且非纯音乐时自动写词' }),
      P.bool('lyricsOptimizer', '自动写词', { default: false, desc: '歌词留空时按提示词写一版' }),
      P.enum('format', '格式', choices(['mp3', 'wav']), { group: 'advanced', default: 'mp3' }),
      P.json(),
    ],
    wire: (p, r) => {
      const lyrics = p.lyrics || '';
      const auto = !!p.lyricsOptimizer || (!p.instrumental && !lyrics);   // 没歌词又不是纯音乐：让它自己写词
      return clean({ prompt: r.prompt, is_instrumental: p.instrumental, lyrics: lyrics || undefined, lyrics_optimizer: auto ? true : undefined, audio_setting: clean({ format: p.format }) });
    },
  },
};
registerDialectCards('fal', CARDS);

// 未知模型（拉取来的、手填的）用的通用映射：prompt / 比例 / 时长 / 音色 / 参考图 → 最常见的字段名，extra 另外原样合并
function genericWire(kind) {
  return (p, r) => clean({
    prompt: r.prompt,
    ...(kind === 'speech' ? { text: r.prompt } : {}),   // 配音模型正文字段两种叫法都见过，两个都带（多余键多数被忽略）
    ...(p.aspectRatio && p.aspectRatio !== 'auto' ? { aspect_ratio: p.aspectRatio } : {}),
    ...(p.durationSeconds != null ? { duration: String(p.durationSeconds) } : {}),
    ...(p.voice ? { voice: p.voice } : {}),
    ...(r.negative ? { negative_prompt: r.negative } : {}),
    ...(kind === 'image' ? { image_urls: r.refs } : {}),
    ...(kind === 'video' ? { image_url: r.first, end_image_url: r.last } : {}),
  });
}

// 提交返回的地址优先（见文件头）；不同源或缺字段才按 owner/app 兜底拼，Key 永远不发到别的主机
function queueUrls(sub, base, model) {
  const app = model.split('/').slice(0, 2).join('/');
  const rid = encodeURIComponent(String(sub.request_id));
  const fb = (tail) => joinUrl(base, `${app}/requests/${rid}${tail}`);
  return {
    statusUrl: sameOrigin(sub.status_url, base) ? sub.status_url : fb('/status'),
    responseUrl: sameOrigin(sub.response_url, base) ? sub.response_url : fb(''),
    cancelUrl: sameOrigin(sub.cancel_url, base) ? sub.cancel_url : fb('/cancel'),
  };
}

// 结果里找媒体：先按种类看约定的键，找不到就扫所有顶层键里带 url 的对象；MiniMax 式的 hex 字符串也认
function mediaOf(out, kind) {
  const scan = (v) => {
    const list = [];
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === 'string' && /^(https?:\/\/|data:)/i.test(item)) list.push({ url: item });
      else if (item && typeof item === 'object' && typeof item.url === 'string') list.push({ url: item.url, mime: item.content_type || '' });
    }
    return list;
  };
  let found = [];
  for (const k of MEDIA_KEYS[kind] || []) { found = scan(out?.[k]); if (found.length) break; }
  if (!found.length && out && typeof out === 'object') for (const v of Object.values(out)) found.push(...scan(v));
  if (!found.length && /^([0-9a-fA-F]{2})+$/.test(String(out?.audio ?? ''))) found = [{ hex: out.audio }];
  return found;
}

const resultMeta = (out) => ({
  ...(typeof out?.seed === 'number' ? { seed: out.seed } : {}),
  ...(typeof out?.duration_ms === 'number' ? { duration: out.duration_ms / 1000 } : {}),
});

// 平台模型列表的 category → 种类（拿不准给 null）。text-to-audio 混着 TTS、音乐、音效，按名字判。
function kindOfCategory(cat, id, name) {
  if (cat === 'text-to-image' || cat === 'image-to-image') return 'image';
  if (cat === 'text-to-video' || cat === 'image-to-video') return 'video';
  if (cat === 'text-to-speech') return 'speech';
  if (cat !== 'text-to-audio') return null;
  const s = `${id} ${name}`.toLowerCase();
  if (/sound|sfx|effect|mmaudio/.test(s)) return null;                           // 音效不是配音也不是音乐，留给用户自己定
  if (/tts|speech|voice|dialogue|kokoro|chatterbox|dia-tts/.test(s)) return 'speech';
  if (/music|song|lyria|stable-audio|ace-step|udio|suno/.test(s)) return 'music';
  return null;
}

// 音色表：MiniMax 系统音色（官方页，332 个，按语言分组；# 行是语言名，其余 id|显示名）
const MINIMAX_VOICE_TABLE = `
# 英语
English_expressive_narrator|Expressive Narrator
English_radiant_girl|Radiant Girl
English_magnetic_voiced_man|Magnetic-voiced Male
English_compelling_lady1|Compelling Lady
English_Aussie_Bloke|Aussie Bloke
English_captivating_female1|Captivating Female
English_Upbeat_Woman|Upbeat Woman
English_Trustworth_Man|Trustworthy Man
English_CalmWoman|Calm Woman
English_UpsetGirl|Upset Girl
English_Gentle-voiced_man|Gentle-voiced Man
English_Whispering_girl|Whispering girl
English_Diligent_Man|Diligent Man
English_Graceful_Lady|Graceful Lady
English_ReservedYoungMan|Reserved Young Man
English_PlayfulGirl|Playful Girl
English_ManWithDeepVoice|Man With Deep Voice
English_MaturePartner|Mature Partner
English_FriendlyPerson|Friendly Guy
English_MatureBoss|Bossy Lady
English_Debator|Male Debater
English_LovelyGirl|Lovely Girl
English_Steadymentor|Reliable Man
English_Deep-VoicedGentleman|Deep-voiced Gentleman
English_Wiselady|Wise Lady
English_CaptivatingStoryteller|Captivating Storyteller
English_DecentYoungMan|Decent Young Man
English_SentimentalLady|Sentimental Lady
English_ImposingManner|Imposing Queen
English_SadTeen|Teen Boy
English_PassionateWarrior|Passionate Warrior
English_WiseScholar|Wise Scholar
English_Soft-spokenGirl|Soft-Spoken Girl
English_SereneWoman|Serene Woman
English_ConfidentWoman|Confident Woman
English_PatientMan|Patient Man
English_Comedian|Comedian
English_BossyLeader|Bossy Leader
English_Strong-WilledBoy|Strong-Willed Boy
English_StressedLady|Stressed Lady
English_AssertiveQueen|Assertive Queen
English_AnimeCharacter|Female Narrator
English_Jovialman|Jovial Man
English_WhimsicalGirl|Whimsical Girl
English_Kind-heartedGirl|Kind-Hearted Girl
# 中文（普通话）
Chinese (Mandarin)_Reliable_Executive|Reliable Executive
Chinese (Mandarin)_News_Anchor|News Anchor
Chinese (Mandarin)_Unrestrained_Young_Man|Unrestrained Young Man
Chinese (Mandarin)_Mature_Woman|Mature Woman
Arrogant_Miss|Arrogant Miss
Robot_Armor|Robot Armor
Chinese (Mandarin)_Kind-hearted_Antie|Kind-hearted Antie
Chinese (Mandarin)_HK_Flight_Attendant|HK Flight Attendant
Chinese (Mandarin)_Humorous_Elder|Humorous Elder
Chinese (Mandarin)_Gentleman|Gentleman
Chinese (Mandarin)_Warm_Bestie|Warm Bestie
Chinese (Mandarin)_Stubborn_Friend|Stubborn Friend
Chinese (Mandarin)_Sweet_Lady|Sweet Lady
Chinese (Mandarin)_Southern_Young_Man|Southern Young Man
Chinese (Mandarin)_Wise_Women|Wise Women
Chinese (Mandarin)_Gentle_Youth|Gentle Youth
Chinese (Mandarin)_Warm_Girl|Warm Girl
Chinese (Mandarin)_Male_Announcer|Male Announcer
Chinese (Mandarin)_Kind-hearted_Elder|Kind-hearted Elder
Chinese (Mandarin)_Cute_Spirit|Cute Spirit
Chinese (Mandarin)_Radio_Host|Radio Host
Chinese (Mandarin)_Lyrical_Voice|Lyrical Voice
Chinese (Mandarin)_Straightforward_Boy|Straightforward Boy
Chinese (Mandarin)_Sincere_Adult|Sincere Adult
Chinese (Mandarin)_Gentle_Senior|Gentle Senior
Chinese (Mandarin)_Crisp_Girl|Crisp Girl
Chinese (Mandarin)_Pure-hearted_Boy|Pure-hearted Boy
Chinese (Mandarin)_Soft_Girl|Soft Girl
Chinese (Mandarin)_IntellectualGirl|Intellectual Girl
Chinese (Mandarin)_Warm_HeartedGirl|Warm-hearted Girl
Chinese (Mandarin)_Laid_BackGirl|Laid-back Girl
Chinese (Mandarin)_ExplorativeGirl|Explorative Girl
Chinese (Mandarin)_Warm-HeartedAunt|Warm-hearted Aunt
Chinese (Mandarin)_BashfulGirl|Bashful Girl
# 日语
Japanese_IntellectualSenior|Intellectual Senior
Japanese_DecisivePrincess|Decisive Princess
Japanese_LoyalKnight|Loyal Knight
Japanese_DominantMan|Dominant Man
Japanese_SeriousCommander|Serious Commander
Japanese_ColdQueen|Cold Queen
Japanese_DependableWoman|Dependable Woman
Japanese_GentleButler|Gentle Butler
Japanese_KindLady|Kind Lady
Japanese_CalmLady|Calm Lady
Japanese_OptimisticYouth|Optimistic Youth
Japanese_GenerousIzakayaOwner|Generous Izakaya Owner
Japanese_SportyStudent|Sporty Student
Japanese_InnocentBoy|Innocent Boy
Japanese_GracefulMaiden|Graceful Maiden
# 粤语
Cantonese_ProfessionalHost (F)|Professional Female Host
Cantonese_GentleLady|Gentle Lady
Cantonese_ProfessionalHost (M)|Professional Male Host
Cantonese_PlayfulMan|Playful Man
Cantonese_CuteGirl|Cute Girl
Cantonese_KindWoman|Kind Woman
# 韩语
Korean_AirheadedGirl|Airheaded Girl
Korean_AthleticGirl|Athletic Girl
Korean_AthleticStudent|Athletic Student
Korean_BraveAdventurer|Brave Adventurer
Korean_BraveFemaleWarrior|Brave Female Warrior
Korean_BraveYouth|Brave Youth
Korean_CalmGentleman|Calm Gentleman
Korean_CalmLady|Calm Lady
Korean_CaringWoman|Caring Woman
Korean_CharmingElderSister|Charming Elder Sister
Korean_CharmingSister|Charming Sister
Korean_CheerfulBoyfriend|Cheerful Boyfriend
Korean_CheerfulCoolJunior|Cheerful Cool Junior
Korean_CheerfulLittleSister|Cheerful Little Sister
Korean_ChildhoodFriendGirl|Childhood Friend Girl
Korean_CockyGuy|Cocky Guy
Korean_ColdGirl|Cold Girl
Korean_ColdYoungMan|Cold Young Man
Korean_ConfidentBoss|Confident Boss
Korean_ConsiderateSenior|Considerate Senior
Korean_DecisiveQueen|Decisive Queen
Korean_DominantMan|Dominant Man
Korean_ElegantPrincess|Elegant Princess
Korean_EnchantingSister|Enchanting Sister
Korean_EnthusiasticTeen|Enthusiastic Teen
Korean_FriendlyBigSister|Friendly Big Sister
Korean_GentleBoss|Gentle Boss
Korean_GentleWoman|Gentle Woman
Korean_HaughtyLady|Haughty Lady
Korean_InnocentBoy|Innocent Boy
Korean_IntellectualMan|Intellectual Man
Korean_IntellectualSenior|Intellectual Senior
Korean_LonelyWarrior|Lonely Warrior
Korean_MatureLady|Mature Lady
Korean_MysteriousGirl|Mysterious Girl
Korean_OptimisticYouth|Optimistic Youth
Korean_PlayboyCharmer|Playboy Charmer
Korean_PossessiveMan|Possessive Man
Korean_QuirkyGirl|Quirky Girl
Korean_ReliableSister|Reliable Sister
Korean_ReliableYouth|Reliable Youth
Korean_SassyGirl|Sassy Girl
Korean_ShyGirl|Shy Girl
Korean_SoothingLady|Soothing Lady
Korean_StrictBoss|Strict Boss
Korean_SweetGirl|Sweet Girl
Korean_ThoughtfulWoman|Thoughtful Woman
Korean_WiseElf|Wise Elf
Korean_WiseTeacher|Wise Teacher
# 西班牙语
Spanish_SereneWoman|Serene Woman
Spanish_MaturePartner|Mature Partner
Spanish_CaptivatingStoryteller|Captivating Storyteller
Spanish_Narrator|Narrator
Spanish_WiseScholar|Wise Scholar
Spanish_Kind-heartedGirl|Kind-hearted Girl
Spanish_DeterminedManager|Determined Manager
Spanish_BossyLeader|Bossy Leader
Spanish_ReservedYoungMan|Reserved Young Man
Spanish_ConfidentWoman|Confident Woman
Spanish_ThoughtfulMan|Thoughtful Man
Spanish_Strong-WilledBoy|Strong-willed Boy
Spanish_SophisticatedLady|Sophisticated Lady
Spanish_RationalMan|Rational Man
Spanish_AnimeCharacter|Anime Character
Spanish_Deep-tonedMan|Deep-toned Man
Spanish_Fussyhostess|Fussy hostess
Spanish_SincereTeen|Sincere Teen
Spanish_FrankLady|Frank Lady
Spanish_Comedian|Comedian
Spanish_Debator|Debator
Spanish_ToughBoss|Tough Boss
Spanish_Wiselady|Wise Lady
Spanish_Steadymentor|Steady Mentor
Spanish_Jovialman|Jovial Man
Spanish_SantaClaus|Santa Claus
Spanish_Rudolph|Rudolph
Spanish_Intonategirl|Intonate Girl
Spanish_Arnold|Arnold
Spanish_Ghost|Ghost
Spanish_HumorousElder|Humorous Elder
Spanish_EnergeticBoy|Energetic Boy
Spanish_WhimsicalGirl|Whimsical Girl
Spanish_StrictBoss|Strict Boss
Spanish_ReliableMan|Reliable Man
Spanish_SereneElder|Serene Elder
Spanish_AngryMan|Angry Man
Spanish_AssertiveQueen|Assertive Queen
Spanish_CaringGirlfriend|Caring Girlfriend
Spanish_PowerfulSoldier|Powerful Soldier
Spanish_PassionateWarrior|Passionate Warrior
Spanish_ChattyGirl|Chatty Girl
Spanish_RomanticHusband|Romantic Husband
Spanish_CompellingGirl|Compelling Girl
Spanish_PowerfulVeteran|Powerful Veteran
Spanish_SensibleManager|Sensible Manager
Spanish_ThoughtfulLady|Thoughtful Lady
# 葡萄牙语
Portuguese_SentimentalLady|Sentimental Lady
Portuguese_BossyLeader|Bossy Leader
Portuguese_Wiselady|Wise lady
Portuguese_Strong-WilledBoy|Strong-willed Boy
Portuguese_Deep-VoicedGentleman|Deep-voiced Gentleman
Portuguese_UpsetGirl|Upset Girl
Portuguese_PassionateWarrior|Passionate Warrior
Portuguese_AnimeCharacter|Anime Character
Portuguese_ConfidentWoman|Confident Woman
Portuguese_AngryMan|Angry Man
Portuguese_CaptivatingStoryteller|Captivating Storyteller
Portuguese_Godfather|Godfather
Portuguese_ReservedYoungMan|Reserved Young Man
Portuguese_SmartYoungGirl|Smart Young Girl
Portuguese_Kind-heartedGirl|Kind-hearted Girl
Portuguese_Pompouslady|Pompous lady
Portuguese_Grinch|Grinch
Portuguese_Debator|Debator
Portuguese_SweetGirl|Sweet Girl
Portuguese_AttractiveGirl|Attractive Girl
Portuguese_ThoughtfulMan|Thoughtful Man
Portuguese_PlayfulGirl|Playful Girl
Portuguese_GorgeousLady|Gorgeous Lady
Portuguese_LovelyLady|Lovely Lady
Portuguese_SereneWoman|Serene Woman
Portuguese_SadTeen|Sad Teen
Portuguese_MaturePartner|Mature Partner
Portuguese_Comedian|Comedian
Portuguese_NaughtySchoolgirl|Naughty Schoolgirl
Portuguese_Narrator|Narrator
Portuguese_ToughBoss|Tough Boss
Portuguese_Fussyhostess|Fussy hostess
Portuguese_Dramatist|Dramatist
Portuguese_Steadymentor|Steady Mentor
Portuguese_Jovialman|Jovial Man
Portuguese_CharmingQueen|Charming Queen
Portuguese_SantaClaus|Santa Claus
Portuguese_Rudolph|Rudolph
Portuguese_Arnold|Arnold
Portuguese_CharmingSanta|Charming Santa
Portuguese_CharmingLady|Charming Lady
Portuguese_Ghost|Ghost
Portuguese_HumorousElder|Humorous Elder
Portuguese_CalmLeader|Calm Leader
Portuguese_GentleTeacher|Gentle Teacher
Portuguese_EnergeticBoy|Energetic Boy
Portuguese_ReliableMan|Reliable Man
Portuguese_SereneElder|Serene Elder
Portuguese_GrimReaper|Grim Reaper
Portuguese_AssertiveQueen|Assertive Queen
Portuguese_WhimsicalGirl|Whimsical Girl
Portuguese_StressedLady|Stressed Lady
Portuguese_FriendlyNeighbor|Friendly Neighbor
Portuguese_CaringGirlfriend|Caring Girlfriend
Portuguese_PowerfulSoldier|Powerful Soldier
Portuguese_FascinatingBoy|Fascinating Boy
Portuguese_RomanticHusband|Romantic Husband
Portuguese_StrictBoss|Strict Boss
Portuguese_InspiringLady|Inspiring Lady
Portuguese_PlayfulSpirit|Playful Spirit
Portuguese_ElegantGirl|Elegant Girl
Portuguese_CompellingGirl|Compelling Girl
Portuguese_PowerfulVeteran|Powerful Veteran
Portuguese_SensibleManager|Sensible Manager
Portuguese_ThoughtfulLady|Thoughtful Lady
Portuguese_TheatricalActor|Theatrical Actor
Portuguese_FragileBoy|Fragile Boy
Portuguese_ChattyGirl|Chatty Girl
Portuguese_Conscientiousinstructor|Conscientious Instructor
Portuguese_RationalMan|Rational Man
Portuguese_WiseScholar|Wise Scholar
Portuguese_FrankLady|Frank Lady
Portuguese_DeterminedManager|Determined Manager
# 法语
French_Male_Speech_New|Level-Headed Man
French_Female_News Anchor|Patient Female Presenter
French_CasualMan|Casual Man
French_MovieLeadFemale|Movie Lead Female
French_FemaleAnchor|Female Anchor
French_MaleNarrator|Male Narrator
# 印尼语
Indonesian_SweetGirl|Sweet Girl
Indonesian_ReservedYoungMan|Reserved Young Man
Indonesian_CharmingGirl|Charming Girl
Indonesian_CalmWoman|Calm Woman
Indonesian_ConfidentWoman|Confident Woman
Indonesian_CaringMan|Caring Man
Indonesian_BossyLeader|Bossy Leader
Indonesian_DeterminedBoy|Determined Boy
Indonesian_GentleGirl|Gentle Girl
# 德语
German_FriendlyMan|Friendly Man
German_SweetLady|Sweet Lady
German_PlayfulMan|Playful Man
# 俄语
Russian_HandsomeChildhoodFriend|Handsome Childhood Friend
Russian_BrightHeroine|Bright Queen
Russian_AmbitiousWoman|Ambitious Woman
Russian_ReliableMan|Reliable Man
Russian_CrazyQueen|Crazy Girl
Russian_PessimisticGirl|Pessimistic Girl
Russian_AttractiveGuy|Attractive Guy
Russian_Bad-temperedBoy|Bad-tempered Boy
# 意大利语
Italian_BraveHeroine|Brave Heroine
Italian_Narrator|Narrator
Italian_WanderingSorcerer|Wandering Sorcerer
Italian_DiligentLeader|Diligent Leader
# 荷兰语
Dutch_kindhearted_girl|Kind-hearted girl
Dutch_bossy_leader|Bossy leader
# 越南语
Vietnamese_kindhearted_girl|Kind-hearted girl
# 阿拉伯语
Arabic_CalmWoman|Calm Woman
Arabic_FriendlyGuy|Friendly Guy
# 土耳其语
Turkish_CalmWoman|Calm Woman
Turkish_Trustworthyman|Trustworthy man
# 乌克兰语
Ukrainian_CalmWoman|Calm Woman
Ukrainian_WiseScholar|Wise Scholar
# 泰语
Thai_male_1_sample8|Serene Man
Thai_male_2_sample2|Friendly Man
Thai_female_1_sample1|Confident Woman
Thai_female_2_sample2|Energetic Woman
# 波兰语
Polish_male_1_sample4|Male Narrator
Polish_male_2_sample3|Male Anchor
Polish_female_1_sample1|Calm Woman
Polish_female_2_sample3|Casual Woman
# 罗马尼亚语
Romanian_male_1_sample2|Reliable Man
Romanian_male_2_sample1|Energetic Youth
Romanian_female_1_sample4|Optimistic Youth
Romanian_female_2_sample1|Gentle Woman
# 希腊语
greek_male_1a_v1|Thoughtful Mentor
Greek_female_1_sample1|Gentle Lady
Greek_female_2_sample3|Girl Next Door
# 捷克语
czech_male_1_v1|Assured Presenter
czech_female_5_v7|Steadfast Narrator
czech_female_2_v2|Elegant Lady
# 芬兰语
finnish_male_3_v1|Upbeat Man
finnish_male_1_v2|Friendly Boy
finnish_female_4_v1|Assetive Woman
# 印地语
hindi_male_1_v2|Trustworthy Advisor
hindi_female_2_v1|Tranquil Woman
hindi_female_1_v2|News Anchor
`;

function parseVoiceTable(text) {
  const list = [];
  let group = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { group = line.slice(1).trim(); continue; }
    const [id, label] = line.split('|');
    list.push({ id: id.trim(), label: (label || id).trim(), note: group });
  }
  return list;
}
const MINIMAX_VOICES = parseVoiceTable(MINIMAX_VOICE_TABLE);
// ElevenLabs：文档示例名（fal 文档 turbo-v2.5 页）+ schema 默认 Rachel
const ELEVEN_VOICES = ['Rachel', 'Aria', 'Roger', 'Sarah', 'Laura', 'Charlie', 'George', 'Callum', 'River', 'Liam', 'Charlotte', 'Alice', 'Matilda', 'Will', 'Jessica', 'Eric', 'Chris', 'Brian', 'Daniel', 'Lily', 'Bill']
  .map((id) => ({ id, label: id, ...(id === 'Rachel' ? { note: '默认' } : {}) }));

export const falAdapter = {
  dialect: 'fal',
  kinds: ['image', 'video', 'speech', 'music'],

  // GET 平台价格接口（文档：必须有效 Key，只读，不建任务）：拿 Key 验明正身，顺带带回一个单价
  async test(provider, ctx) {
    if (!ctx.secret?.key) throw new AdapterError('还没填 API Key');
    const j = await http(`${FAL_API}/models/pricing?endpoint_id=${PRICE_PROBE}`, { headers: authHeaders(provider, ctx.secret.key), timeoutMs: 30_000, dispatcher: ctx.dispatcher, label: 'fal' });
    const price = Array.isArray(j?.prices) ? j.prices[0] : null;
    return { detail: price ? `Key 有效（${PRICE_PROBE} 单价 $${price.unit_price} / ${price.unit}）` : 'Key 有效' };
  },

  // 平台模型列表（只查六个媒体类目，丢掉 training；鉴权可选，带 Key 限流更宽）。各类目并行，全挂了才报错。
  async listModels(provider, ctx) {
    const headers = authHeaders(provider, ctx.secret?.key);
    const rs = await Promise.allSettled(LIST_CATEGORIES.map((category) => http(`${FAL_API}/models?${new URLSearchParams({ category, status: 'active', limit: '50' })}`, {
      headers, timeoutMs: 30_000, dispatcher: ctx.dispatcher, label: 'fal 模型列表',
    }).then((j) => ({ category, items: Array.isArray(j?.models) ? j.models : [] }))));
    const okRs = rs.filter((x) => x.status === 'fulfilled');
    if (!okRs.length) {
      const err = rs[0].reason;
      throw err instanceof AdapterError ? err : new AdapterError(`拉模型列表失败：${(err && err.message) || err}`);
    }
    const seen = new Set();
    const out = [];
    for (const { value } of okRs) {
      for (const m of value.items) {
        const id = String(m?.endpoint_id || '');
        const md = m?.metadata;
        if (!MODEL_ID_RE.test(id) || seen.has(id) || !md || md.kind === 'training') continue;
        seen.add(id);
        out.push({ id, label: md.display_name || id, kind: kindOfCategory(md.category || value.category, id, md.display_name || '') });
      }
    }
    return out;
  },

  // 配音音色：MiniMax 语音模型给官方系统音色表，ElevenLabs 给文档示例名；其他返回空（页面用卡上的音色字段）
  voices(provider, ctx, modelId) {
    const id = String(modelId || '');
    if (/minimax/.test(id) && /speech/.test(id)) return MINIMAX_VOICES;
    if (/elevenlabs/.test(id) && /tts/.test(id)) return ELEVEN_VOICES;
    return [];
  },

  async run(req, provider, ctx) {
    const key = ctx.secret?.key;
    if (!key) throw new AdapterError('这个服务还没填 API Key');
    const model = String(req.model || '');
    if (!MODEL_ID_RE.test(model)) throw new AdapterError(`fal 模型 id 不对：「${model}」（只能含字母、数字和 . _ - /）`);
    const base = provider.baseUrl || FAL_QUEUE;
    // 同步地址 fal.run 会当场跑完并计费、不回请求编号（我们就拿不到结果）：提交前拦下，要用队列地址（契约复核 11-04）
    try { if (/(^|\.)fal\.run$/i.test(new URL(base).hostname) && !/^queue\./i.test(new URL(base).hostname)) throw new AdapterError('fal 的接口地址要用队列地址 https://queue.fal.run（fal.run 是同步接口，拿不到结果还照样计费）'); }
    catch (e) { if (e instanceof AdapterError) throw e; }
    const headers = authHeaders(provider, key);
    const timeoutMs = (provider.timeoutSec || 600) * 1000;
    const { signal, dispatcher } = ctx;
    const p = req.params || {};
    const card = req.card || genericCard('fal', req.kind);
    const takesImages = !!card.inputs?.images;
    const dataOf = (x) => dataUrl(x.data, x.mime);

    // 素材：改图取 edit / ref；没给素材时拿续改链上一张当参考（只有收图片的卡才用，文生图卡不带参考图）
    let refs = [];
    if (takesImages && req.kind === 'image') {
      refs = (req.inputs || []).filter((x) => x.role === 'edit' || x.role === 'ref').map(dataOf);
      const last = req.thread?.turns?.[req.thread.turns.length - 1];
      if (!refs.length && last) refs = [dataUrl(last.data, last.mime)];
    }
    const pick = (role) => (takesImages ? (req.inputs || []).find((x) => x.role === role) : undefined);
    const first = pick('first');
    const lastFrame = pick('last');
    const r = { prompt: req.prompt || '', negative: req.negative || '', refs, first: first ? dataOf(first) : '', last: lastFrame ? dataOf(lastFrame) : '' };

    // 请求体：卡映射出的字段 → 服务级额外（provider.params）→ 逐次额外（extra，最后合并、压过前面）。
    // schema 卡（§9.3 自动识别）的 wire 是对象：参数键就是 schema 字段名，素材按 wire 塞回原字段（data URI）
    const fields = card.wire && typeof card.wire === 'object'
      ? wireBody(card.wire, p, req, dataOf)
      : (card.wire || genericWire(req.kind))(p, r);
    const body = { ...fields, ...(provider.params || {}), ...(p.extra || {}) };

    const sub = await http(joinUrl(base, model), { method: 'POST', headers, body, timeoutMs, signal, dispatcher, label: 'fal 提交' });
    need(sub && sub.request_id, 'fal 没有返回请求编号');
    ctx.submitted?.();   // 已进队列：之后取消要走取消接口，失败也不再自动重试（见文件头「计费时点」）
    const { statusUrl, responseUrl, cancelUrl } = queueUrls(sub, base, model);

    // 任务在跑时被取消（用户点取消 / 任务超时的 abort）：尽力调一次取消接口，失败忽略
    let canceled = false;
    const cancel = () => {
      if (canceled) return;
      canceled = true;
      http(cancelUrl, { method: 'PUT', headers, timeoutMs: 15_000, dispatcher, label: 'fal 取消' }).catch(() => {});
    };
    signal?.addEventListener?.('abort', cancel, { once: true });
    try {
      const out = await poll(async () => {
        let s;
        // 查状态偶发的网络错误 / 5xx / 429：跳过这一轮再查（已进队列在计费，别因一次抖动丢结果）
        try { s = await http(statusUrl, { headers, timeoutMs, signal, dispatcher, label: 'fal 状态' }); }
        catch (e) { if (signal?.aborted || !isTransient(e)) throw e; return { done: false }; }
        if (s && (s.error || s.error_type)) return { failed: true, error: String(s.error || s.error_type) };
        if (s?.status === 'COMPLETED') return { done: true, value: await http(responseUrl, { headers, timeoutMs, signal, dispatcher, label: 'fal 结果' }) };
        ctx.progress?.({ note: s?.status === 'IN_QUEUE' ? (s.queue_position != null ? `排队中，前面还有 ${s.queue_position} 个` : '排队中') : '生成中' });
        return { done: false };
      }, { intervalMs: ctx.pollMs || POLL_MS, timeoutMs: req.kind === 'video' || req.kind === 'music' ? longWaitMs(provider) : timeoutMs, signal, label: 'fal 任务' });

      const meta = resultMeta(out);
      const assets = [];
      for (const m of mediaOf(out, req.kind)) {
        // 结果下载不带 Key（CDN 地址不需要鉴权，也不把 Key 交给别的主机）
        const f = m.url
          ? await download(m.url, { timeoutMs, signal, dispatcher, label: 'fal 结果下载' })
          : { bytes: Buffer.from(m.hex, 'hex'), mime: '' };
        const got = f.mime === 'application/octet-stream' ? '' : f.mime;   // CDN 回的泛型类型不算数，按种类兜底
        assets.push({ bytes: f.bytes, mime: m.mime || got || DEFAULT_MIME[req.kind], meta });
      }
      if (!assets.length) throw new AdapterError('fal 没有返回可用的结果文件', { detail: JSON.stringify(out ?? null).slice(0, 300) });
      return { assets };
    } catch (e) {
      // 等超时（poll 抛 timeout，不会 abort signal）：同样尽力取消，免得 fal 那边继续跑、继续计费
      if (e && e.code === 'timeout') cancel();
      throw e;
    } finally {
      signal?.removeEventListener?.('abort', cancel);
    }
  },
};
