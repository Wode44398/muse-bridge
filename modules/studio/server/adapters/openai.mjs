// openai 方言：OpenAI 官方接口，以及所有兼容 OpenAI 图像 / 语音 / 视频接口的服务（baseUrl 可改，见 presets.mjs）。
//
// 查证日期 2026-11-04。platform.openai.com 的文档页对抓取返回 403，以下以 developers.openai.com 为准：
//   图像生成  https://developers.openai.com/api/reference/resources/images/methods/generate
//   图像编辑  https://developers.openai.com/api/reference/resources/images/methods/edit
//   图像指南  https://developers.openai.com/api/docs/guides/image-generation
//   配音      https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
//             https://developers.openai.com/api/docs/guides/text-to-speech
//   视频      https://developers.openai.com/api/reference/resources/videos/methods/create（资源总表：…/resources/videos）
//             https://developers.openai.com/api/docs/guides/video-generation
//   弃用表    https://developers.openai.com/api/docs/deprecations ；模型页 https://developers.openai.com/api/docs/models
//
// 关键事实：
//  · 图像：POST {base}/images/generations（JSON）；有参考图（或续改链上一张）时 POST {base}/images/edits（multipart，文档 curl 例子用 image[]）。
//    结果 data[].b64_json。GPT 图像模型只回 b64_json、不认 response_format；dall-e 系列可回 b64_json 或 url（两种都接）。
//    尺寸：GPT 图像模型三档 1024x1024 / 1536x1024 / 1024x1536（另有 auto）。gpt-image-2、gpt-image-2.5-sunburst / -flare（含 2026-09-08 快照）
//    可自定义 WIDTHxHEIGHT：两边都是 16 的倍数，长宽比 1:3–3:1，上限 3840x2160，超过 2560x1440 属实验性。
//    透明背景：background=transparent 只认 png / webp 输出；gpt-image-2 的透明背景是预览功能（文档写明）。
//  · 配音：POST {base}/audio/speech（JSON），响应就是音频字节（文档只写 application/octet-stream，所以 mime 按 response_format 定）。
//    input ≤ 4096 字；voice 必填；instructions 只有 gpt-4o-mini-tts 认（tts-1 / tts-1-hd 不认）；speed 0.25–4.0，默认 1。
//  · 视频（异步）：POST {base}/videos（JSON；首帧 input_reference = { image_url: data URL }）→ GET {base}/videos/{id} 轮询，
//    status：queued / in_progress / completed / failed，progress 为 0–100 → GET {base}/videos/{id}/content 下载 MP4（默认 variant=video）。
//    取消：文档没有取消接口。DELETE /videos/{id} 是删除已存的视频，不是取消，这里不调。POST 成功后即 submitted()（之后只能丢弃结果）。
//    ！官方视频页写明：Sora 2 模型与 Videos API 已于 2026-09-24 下线，「没有一对一的替代接口」。所以视频只给实现了同一接口的兼容服务用，
//      这里不收视频卡（手填 id 走通用卡）；kinds 仍含 video，与 presets.mjs 的 DIALECT_KINDS 一致。
//  · 下线 / 弃用（决定收不收卡）：gpt-image-1 于 2026-10-23 下线，不收；dall-e-2 / dall-e-3 于 2026-05-12 下线，不收
//    （run 里保留它们的尺寸映射，只为兼容服务）；gpt-image-1.5 / gpt-image-1-mini 2026-12-01 下线，不收（手填走通用卡）；
//    tts-1 / tts-1-hd / gpt-4o-mini-tts 2027-01-06 下线，收卡，说明里标弃用。
//  · 文档未写明，这里的处理：
//    - 音频 mime：文档只给格式名。opus 按 Ogg/Opus 处理（audio/ogg）；pcm 按文档说的 24kHz 16 位有符号小端、无文件头处理，meta 带采样率。
//    - 视频 content 的 Content-Type 文档未写，固定按 video/mp4。
//    - 图像 edits 文档里 image[] 与 image 两种写法都出现，统一用 image[]（文档 curl 例子即如此）。
//    - tts-1 / tts-1-hd 文档只说「九个音色」、没列名单：音色不做限制，不认的由服务方 400 原话回报。
//    - chatgpt-image-latest 的尺寸与画质文档未写：按固定三档处理。
//    - gpt-image-2.6-sunburst / -flare：指南与模型页提到（images 端点标 Supported，无弃用标记），但 API 参考的 model 枚举里没有它们，
//      也没写尺寸与画质档位：未收卡，按固定三档处理；要用别的尺寸，用逐次 extra 覆盖。

import { http, authHeaders, joinUrl, download, poll, dataUrl, AdapterError, isTransient, longWaitMs } from './http.mjs';
import { P } from '../cards/spec.mjs';
import { registerDialectCards } from '../cards/dialects.mjs';

const DEFAULT_VOICE = 'alloy';   // 文档：voice 必填、没写默认值，没给就用 alloy
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
  .map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }));
const MAX_DATA_URL = 20_971_520;   // 文档：image_url 的上限（字符数，base64 data URL 也算在内）

// 比例 → 尺寸。固定三档是 GPT 图像模型都认的；gpt-image-2 系列可自定义，下表每个尺寸两边都是 16 的倍数、长宽比在 1:3–3:1 之内
const SIZE_FIXED = { '1:1': '1024x1024', '16:9': '1536x1024', '4:3': '1536x1024', '3:2': '1536x1024', '9:16': '1024x1536', '3:4': '1024x1536', '2:3': '1024x1536' };
const SIZE_FLEX = { '1:1': '1024x1024', '16:9': '1536x864', '4:3': '1280x960', '3:2': '1536x1024', '9:16': '864x1536', '3:4': '960x1280', '2:3': '1024x1536' };
const SIZE_DALLE3 = { '1:1': '1024x1024', '16:9': '1792x1024', '4:3': '1792x1024', '3:2': '1792x1024', '9:16': '1024x1792', '3:4': '1024x1792', '2:3': '1024x1792' };
const FLEX_MODEL = /^gpt-image-2(\.5-(sunburst|flare))?(-\d{4}-\d{2}-\d{2})?$/;   // gpt-image-2 与 2.5 sunburst / flare（含日期快照）
const VIDEO_SIZE = { '16:9': '1280x720', '9:16': '720x1280' };   // 取文档可选值里的这两个；auto / 没给：不传，服务端默认 720x1280
const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const AUDIO_MIME = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16' };

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const needKey = (ctx) => { if (!ctx?.secret?.key) throw new AdapterError('这个服务还没填 API Key'); return ctx.secret.key; };
const needBase = (provider) => { if (!provider.baseUrl) throw new AdapterError('这个服务还没填接口地址'); return provider.baseUrl; };
const who = (provider) => provider.name || 'OpenAI 接口';   // 错误前缀：兼容服务显示它自己的名字
const timeoutOf = (provider) => (provider.timeoutSec || 600) * 1000;
// 请求体合并顺序：卡上映射出来的字段 → 服务级 provider.params → 逐次 extra（后面的覆盖前面的）
const mergeBody = (mapped, provider, p) => ({ ...mapped, ...(provider.params || {}), ...(p.extra || {}) });
const kindOf = (id) => (/^(gpt-image|chatgpt-image|dall-e)/.test(id) ? 'image' : /tts/.test(id) ? 'speech' : /^sora/.test(id) ? 'video' : null);
const isDalle = (model) => /^dall-e/.test(model);
const extOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime] || 'png');
const nearestSecond = (n) => String([4, 8, 12].reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a)));

function sizeFor(model, aspect) {
  if (!aspect || aspect === 'auto') return undefined;   // 不传：服务端默认（GPT 图像模型的默认是 auto）
  if (/^dall-e-2/.test(model)) return '1024x1024';      // dall-e-2 只出方图
  if (isDalle(model)) return SIZE_DALLE3[aspect];
  return (FLEX_MODEL.test(model) ? SIZE_FLEX : SIZE_FIXED)[aspect];
}

// 参考图：role edit / ref；没有就拿续改链上一张（本方言没有多轮上下文，同 openrouter）
function refsOf(req) {
  const refs = (req.inputs || []).filter((x) => x.role === 'edit' || x.role === 'ref');
  if (refs.length) return refs;
  const last = req.thread?.turns?.[req.thread.turns.length - 1];
  return last ? [{ data: last.data, mime: last.mime }] : [];
}

// —— 图像：没有参考图 → /images/generations（JSON）；有参考图（或续改链上一张）→ /images/edits（multipart，image[]）——
async function runImage(req, provider, ctx) {
  const key = needKey(ctx);
  const base = needBase(provider);
  const p = req.params || {};
  const refs = refsOf(req);
  const fields = mergeBody(clean({
    model: req.model,
    prompt: req.prompt,
    n: p.count,
    size: sizeFor(req.model, p.aspectRatio),
    quality: p.quality,
    background: p.background,
    output_format: p.outputFormat,
    output_compression: p.outputCompression,
    response_format: isDalle(req.model) ? 'b64_json' : undefined,   // GPT 图像模型不认这个字段（文档），只回 b64_json
  }), provider, p);
  const common = { headers: authHeaders(provider, key), timeoutMs: timeoutOf(provider), signal: ctx.signal, dispatcher: ctx.dispatcher, label: who(provider) };
  let j;
  if (refs.length) {
    const form = new FormData();
    refs.forEach((r, i) => form.append('image[]', new Blob([r.data], { type: r.mime || 'image/png' }), r.name || `image${i + 1}.${extOf(r.mime)}`));
    for (const [k, v] of Object.entries(fields)) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    j = await http(joinUrl(base, 'images/edits'), { ...common, method: 'POST', body: form });
  } else {
    j = await http(joinUrl(base, 'images/generations'), { ...common, method: 'POST', body: fields });
  }
  // 结果：b64_json 直接解码；url 另外下载（不带 Key：那是服务方给的公网链接，不该把 Key 发出去）
  const fmt = j?.output_format || fields.output_format || 'png';
  const assets = [];
  for (const it of Array.isArray(j?.data) ? j.data : []) {
    const meta = clean({ size: j.size, revisedPrompt: it?.revised_prompt });
    if (it?.b64_json) assets.push({ bytes: Buffer.from(it.b64_json, 'base64'), mime: IMAGE_MIME[fmt] || 'image/png', meta });
    else if (it?.url) {
      const d = await download(it.url, { timeoutMs: timeoutOf(provider), signal: ctx.signal, dispatcher: ctx.dispatcher, label: '下载结果图' });
      assets.push({ bytes: d.bytes, mime: d.mime, meta });
    }
  }
  if (!assets.length) throw new AdapterError('服务方没有返回图片');
  return { assets };
}

// —— 配音：POST /audio/speech，响应就是音频字节 ——
async function runSpeech(req, provider, ctx) {
  const key = needKey(ctx);
  const base = needBase(provider);
  const p = req.params || {};
  const fmt = p.format || 'mp3';
  const body = mergeBody(clean({
    model: req.model,
    input: req.prompt,
    voice: p.voice || DEFAULT_VOICE,
    response_format: fmt,
    speed: p.speed,
    instructions: p.instructions,
  }), provider, p);
  // 文档的 Content-Type 只写 application/octet-stream，所以 mime 按请求的格式定（合并后的：extra / 服务级额外请求体可能改了它）
  const outFmt = String(body.response_format || fmt);
  const res = await http(joinUrl(base, 'audio/speech'), { method: 'POST', headers: authHeaders(provider, key), body, timeoutMs: timeoutOf(provider), signal: ctx.signal, dispatcher: ctx.dispatcher, raw: true, label: who(provider) });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new AdapterError('服务方返回了空音频');
  // pcm：24kHz 16 位单声道（文档），mime 带上 rate，执行器据此包成 WAV
  return { assets: [{ bytes, mime: outFmt === 'pcm' ? 'audio/L16;rate=24000' : (AUDIO_MIME[outFmt] || 'audio/mpeg'), meta: outFmt === 'pcm' ? { sampleRate: 24000, bitDepth: 16 } : {} }] };
}

// —— 视频（异步）：创建 → 轮询 → 下载 MP4。没有取消接口，POST 成功后即 submitted()（发出去就收不回，同 Veo）——
async function runVideo(req, provider, ctx) {
  const key = needKey(ctx);
  const base = needBase(provider);
  const p = req.params || {};
  const inputs = req.inputs || [];
  if (inputs.some((x) => x.role !== 'first')) throw new AdapterError('openai 视频只支持首帧图（first）');
  const first = inputs.find((x) => x.role === 'first');
  let inputRef;
  if (first) {
    const url = dataUrl(first.data, first.mime);
    if (url.length > MAX_DATA_URL) throw new AdapterError('首帧图太大（编码后超过文档上限 20MB）');
    inputRef = { image_url: url };
  }
  const headers = authHeaders(provider, key);
  const timeoutMs = timeoutOf(provider);
  const label = who(provider);
  const body = mergeBody(clean({
    model: req.model,
    prompt: req.prompt,
    seconds: p.durationSeconds != null ? nearestSecond(p.durationSeconds) : undefined,   // 文档只认 '4' / '8' / '12'（默认 '4'）
    size: VIDEO_SIZE[p.aspectRatio],
    input_reference: inputRef,
  }), provider, p);
  const created = await http(joinUrl(base, 'videos'), { method: 'POST', headers, body, timeoutMs, signal: ctx.signal, dispatcher: ctx.dispatcher, label });
  if (!created?.id) throw new AdapterError('服务方没有返回任务 id');
  ctx.submitted?.();   // 任务已在服务方排上：之后取消只能丢弃结果，仍可能计费
  const vid = encodeURIComponent(created.id);
  const video = await poll(async () => {
    let j;
    // 查询偶发的网络错误 / 5xx / 429：跳过这一轮再查（钱已经花了，别因一次抖动丢结果）
    try { j = await http(joinUrl(base, `videos/${vid}`), { headers, timeoutMs, signal: ctx.signal, dispatcher: ctx.dispatcher, label }); }
    catch (e) { if (ctx.signal?.aborted || !isTransient(e)) throw e; return { done: false }; }
    if (j?.status === 'completed') return { done: true, value: j };
    if (j?.status === 'failed') return { failed: true, error: j.error?.message || j.error?.code || '' };
    return { progress: typeof j?.progress === 'number' ? Math.min(0.99, j.progress / 100) : undefined };
  }, { intervalMs: ctx.pollMs ?? 4000, timeoutMs: longWaitMs(provider), signal: ctx.signal, label: '视频生成', onTick: ({ elapsed, progress }) => ctx.progress?.({ elapsed, progress }) });
  // 下载：GET /videos/{id}/content（默认 variant=video，即 MP4）。文档没写 Content-Type，固定按 video/mp4
  const res = await http(joinUrl(base, `videos/${vid}/content`), { headers, timeoutMs, signal: ctx.signal, dispatcher: ctx.dispatcher, raw: true, label });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { assets: [{ bytes, mime: 'video/mp4', meta: clean({ durationSeconds: Number(video?.seconds) || undefined, size: video?.size }) }] };
}

// —— 模型卡：只收官方文档里当前还能用的常见模型（下线的见文件头）；其它 id 手填，走通用卡 ——
const ASPECT_OPTS = [{ value: 'auto', label: '自动' }, ...['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].map((v) => ({ value: v, label: v }))];
const Q_GPT = [{ value: 'auto', label: '自动' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }];
const Q_25 = [...Q_GPT, { value: 'xhigh', label: 'xhigh' }, { value: 'max', label: 'max' }];   // 文档：xhigh / max 只 2.5 sunburst / flare 有
const BG_OPTS = [{ value: 'auto', label: '自动' }, { value: 'opaque', label: '不透明' }, { value: 'transparent', label: '透明' }];
const IMG_FMT_OPTS = [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }];
const AUDIO_FMT_OPTS = [{ value: 'mp3', label: 'MP3' }, { value: 'opus', label: 'Opus' }, { value: 'aac', label: 'AAC' }, { value: 'flac', label: 'FLAC' }, { value: 'wav', label: 'WAV' }, { value: 'pcm', label: 'PCM（裸数据，24kHz）' }];

function imageCard(model, label, desc, quality) {
  return {
    id: `openai:${model}`, kind: 'image', async: false, label, desc,
    inputs: { text: true, images: { max: 16, roles: ['edit', 'ref'] }, multiTurn: false },
    params: [
      P.enum('aspectRatio', '比例', ASPECT_OPTS, { default: 'auto' }),
      P.enum('quality', '画质', quality, { default: 'auto' }),
      P.num('count', '张数', 1, 4, { step: 1, integer: true, default: 1, group: 'basic' }),
      P.enum('background', '背景', BG_OPTS, { group: 'advanced', default: 'auto' }),
      P.enum('outputFormat', '输出格式', IMG_FMT_OPTS, { group: 'advanced', default: 'png' }),
      P.num('outputCompression', '压缩质量', 0, 100, { step: 1, integer: true, default: 100, when: { outputFormat: ['jpeg', 'webp'] } }),
      P.json(),
    ],
  };
}

function speechCard(model, label, desc, { instructions = false } = {}) {
  return {
    id: `openai:${model}`, kind: 'speech', async: false, label, desc,
    inputs: { text: true },
    params: [
      P.voice('voice', '音色', { default: DEFAULT_VOICE, options: VOICES.map((v) => ({ value: v.id, label: v.label })) }),
      ...(instructions ? [P.text('instructions', '语气说明', { group: 'basic', max: 4096, desc: '自然语言描述语气、情绪、语速等（只 gpt-4o-mini-tts 认）' })] : []),
      P.num('speed', '语速', 0.25, 4, { step: 0.05, default: 1 }),
      P.enum('format', '格式', AUDIO_FMT_OPTS, { group: 'advanced', default: 'mp3' }),
      P.json(),
    ],
  };
}

export const CARDS = {
  'gpt-image-2.5-sunburst': imageCard('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '官方定位：图像生成与编辑最强的一档，偏精准编辑。可自定义宽高，画质可到 xhigh / max。', Q_25),
  'gpt-image-2.5-flare': imageCard('gpt-image-2.5-flare', 'GPT Image 2.5 Flare', '官方定位：快速、日常出图，质量稳定。可自定义宽高，画质可到 xhigh / max。', Q_25),
  'gpt-image-2': imageCard('gpt-image-2', 'GPT Image 2', '可自定义宽高；透明背景是预览功能（文档写明）。', Q_GPT),
  'gpt-4o-mini-tts': speechCard('gpt-4o-mini-tts', 'GPT-4o mini TTS', '官方标为弃用，2027-01-06 下线。可用语气说明控制语气。', { instructions: true }),
  'tts-1': speechCard('tts-1', 'TTS-1', '官方标为弃用，2027-01-06 下线。不支持语气说明。'),
  'tts-1-hd': speechCard('tts-1-hd', 'TTS-1 HD', '官方标为弃用，2027-01-06 下线。不支持语气说明。'),
};
registerDialectCards('openai', CARDS);

export const openaiAdapter = {
  dialect: 'openai',
  kinds: ['image', 'video', 'speech'],

  // GET /models：只读、零成本，不发任何生成请求。401 / 403 → Key 无效
  async test(provider, ctx) {
    const key = needKey(ctx);
    const base = needBase(provider);
    let j;
    try {
      j = await http(joinUrl(base, 'models'), { headers: authHeaders(provider, key), timeoutMs: 30_000, dispatcher: ctx.dispatcher, label: who(provider) });
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) throw new AdapterError('API Key 无效', { status: e.status, detail: e.detail });
      throw e;
    }
    const n = Array.isArray(j?.data) ? j.data.length : 0;
    return { detail: n ? `连接正常，接口列出 ${n} 个模型` : '连接正常' };
  },

  // GET /models，按 id 名猜种类；猜不出的不列（要用的话手填 id，走通用卡）
  async listModels(provider, ctx) {
    const key = needKey(ctx);
    const base = needBase(provider);
    const j = await http(joinUrl(base, 'models'), { headers: authHeaders(provider, key), timeoutMs: 30_000, dispatcher: ctx.dispatcher, label: who(provider) });
    return (Array.isArray(j?.data) ? j.data : []).flatMap((m) => {
      const id = String(m?.id || '');
      const kind = kindOf(id);
      return kind ? [{ id, label: id, kind }] : [];
    });
  },

  // 官方内置音色（文档：13 个；没有列音色的接口，所以是静态表）
  voices() { return VOICES.map((v) => ({ ...v })); },

  async run(req, provider, ctx) {
    if (req.kind === 'image') return runImage(req, provider, ctx);
    if (req.kind === 'speech') return runSpeech(req, provider, ctx);
    if (req.kind === 'video') return runVideo(req, provider, ctx);
    throw new AdapterError(`openai 方言不做 ${req.kind}`);
  },
};
