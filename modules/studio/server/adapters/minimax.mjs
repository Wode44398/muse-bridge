// minimax 方言：视频（Hailuo 图生 / 文生）、配音（T2A 同步）、音乐（同步）。2026-11-04 按官方文档实现，未真打（没有 Key，测试全部 mock fetch）。
// 查过的页面（国内站 platform.minimax.cn 的下列接口页逐页核对；海外站 platform.minimax.io 只核对了索引、图生视频与 T2A 两页，参数与域名一致）：
//   视频 图生  …/docs/api-reference/video-generation-i2v.md    文生 …/video-generation-t2v.md    查询 …/video-generation-query.md
//   文件检索  …/file-management-retrieve.md    文件下载 …/file-management-retrieve-content.md
//   同步语音  …/speech-t2a-http.md    音色查询 …/voice-management-get.md    系统音色 …/faq/system-voice-id.md    音乐 …/music-generation.md
//   （H3 系列是另一套接口 POST /v2/video_generation，见 …/video-generation-v2-create.md，本次未接）
//   2026-11-15 复核参数：海外站的 openapi JSON（只读）——视频 …/video/generation/api/{text-to-video,image-to-video,start-end-to-video}.json、
//   语音 …/speech/t2a/api/openapi.json、音乐 …/music/api/openapi.json（前缀 https://platform.minimax.io/docs/api-reference）。
// 关键事实：
//   · 基址：文档示例是 https://api.minimax.cn/v1（国内），海外 https://api.minimax.io/v1。默认值与预设用 https://api.minimaxi.com/v1
//     （brief 指定）；文档没说它和 api.minimax.cn 等价，待主会话核对 presets.mjs。
//   · 鉴权：Authorization: Bearer <key>。业务错误多在 HTTP 200 里用 base_resp.status_code / status_msg 表示，码表见 CODE_MSG。
//   · 视频：POST video_generation 得 task_id；提交后不可取消（文档没有取消接口）。
//     GET query/video_generation?task_id= 轮询，status = Preparing / Queueing / Processing / Success / Fail，成功给 file_id、video_width、video_height。
//     成片：GET files/retrieve?file_id= 的 schema 没有下载地址，示例里有 file.download_url；GET files/retrieve_content?file_id= 写的是
//     「下载模型生成的文件」，但 Content-Type 文档自相矛盾（binary 与 application/json），两种都认（见 videoFile）。
//     首帧 first_frame_image（公网 URL 或 data URL；JPG / PNG / WebP；< 20 MB；短边 > 300px；宽高比 2:5–5:2）。
//     尾帧 last_frame_image 只在首尾帧接口（start-end-to-video）：模型只有 MiniMax-Hailuo-02，分辨率只有 768P / 1080P（10 秒只 768P），
//     页面没有 fast_pretreatment。图生视频 02 多一档 512P；文生视频只有 768P / 1080P。2.3-Fast 只在图生视频的模型表里（必须给首帧）。
//   · 配音：POST t2a_v2 同步返回 data.audio（hex），output_format 用默认 hex；text 文档写「小于 10000 字符」；audio_setting.format 默认 mp3。
//     voice_setting：speed 0.5–2、vol (0,10]、pitch −12~12、emotion（fluent / whisper 只 2.6）、latex_read（只中文）；
//     audio_setting：sample_rate / bitrate（只 mp3）/ format（mp3 pcm flac wav opus pcmu_*）/ channel 1|2；
//     text_normalization_mode basic|quality（quality 只 2.8 / 2.6 非流式）；pronunciation_dict.tone[「原文/替换」]；timbre_weights（≤4，weight 1–100，
//     这时 voice_id 留空）；voice_modify（pitch / intensity / timbre −100~100、sound_effects 四选一，只认 mp3 / wav / flac）；language_boost 41 个值。
//   · 音乐：POST music_generation 同步返回 data.audio（hex）。文档没写明异步流程，按同步处理（一次请求拿到音频）。
//     页首提示：2026-08-20 起新用户不再开放付费音乐 / 歌词接口，老付费用户可继续；免费档已下线。
//     纯音乐（is_instrumental）时 prompt 必填；lyrics_optimizer 开着且歌词为空时按提示词写词；audio_setting.format mp3 / wav / pcm。
//   · 音色：POST get_voice，voice_type = system / voice_cloning / voice_generation / all，纯查询。
// test() 只调音色查询（只读、不生成）。文档没写它计不计费，按「只查询」视为零成本。
// 没接：H3 系列；图像（image-01 / H3-Image）；主体参考视频（S2V-01）；参考音频翻唱（music-cover，文档未写 audio_base64 是否带 data URL 前缀）；
//      字幕（subtitle_enable：结果是另一个文件）；负面提示词与续改线程（这几个接口没有对应字段，req.negative / req.thread 忽略）。
// 界面对数字总会发一个值：新加的数字参数默认值都是文档默认，等于默认时不发（声音效果三项全 0 且没选音效时 voice_modify 整组不发）。

import { http, authHeaders, joinUrl, download, poll, dataUrl, AdapterError } from './http.mjs';
import { P, opts, applySpecs } from '../cards/spec.mjs';
import { registerDialectCards } from '../cards/dialects.mjs';

const DEFAULT_BASE = 'https://api.minimaxi.com/v1';
const DEFAULT_VOICE = 'male-qn-qingse';          // 文档示例用的音色，系统音色表里有
const FIRST_FRAME_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const FIRST_FRAME_MAX = 20 * 1024 * 1024;        // 文档：首帧图小于 20 MB
const T2A_MAX_CHARS = 10000;                     // 文档：text 小于 10000 字符
const LYRICS_MAX = 3500;                         // 文档：lyrics 1–3500 字符
const VIDEO_TIMEOUT_MS = 30 * 60_000;            // 文档没写排队 / 生成时长上限，给 30 分钟
const POLL_MS = 5000;
const STATUS_NOTE = { Preparing: '准备中', Queueing: '排队中', Processing: '生成中' };

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const secs = (ms) => Math.round(Number(ms) / 100) / 10;   // 毫秒 → 秒（一位小数）
const baseOf = (provider) => String(provider.baseUrl || '').trim() || DEFAULT_BASE;

// base_resp.status_code → [HTTP 状态（决定会不会重试：提交前的 429 / 5xx 可重试）, 人话]。
// 码表以官方页为准（视频、T2A、音乐、文件页合并）；没列的码按「服务方拒绝了这次请求」透出原话。
const CODE_MSG = {
  1000: [500, '服务方出错了，稍后再试'],
  1001: [504, '服务方处理超时，稍后再试'],
  1002: [429, '被限流了（每分钟请求数），稍后再试'],
  1004: [401, 'API Key 无效或没权限'],
  2049: [401, 'API Key 无效或没权限'],
  1008: [402, '余额不足'],
  1013: [500, '服务方内部出错了，稍后再试'],
  1026: [422, '内容含敏感信息，请修改后再试'],
  1027: [422, '生成的内容被判为敏感，没有出结果'],
  1039: [429, '被限流了（每分钟 token 数），稍后再试'],
  1042: [422, '文字里非法或不可见字符超过 10%'],
  2013: [400, '参数不对'],
};

/** HTTP 200 里 base_resp.status_code ≠ 0 一律抛错（带映射后的状态；服务方原话留在括号里）。 */
function checkBase(j, label) {
  const br = isObj(j) ? j.base_resp : null;
  const code = Number(br?.status_code || 0);
  if (!code) return j;
  const [status, msg] = CODE_MSG[code] || [400, '服务方拒绝了这次请求'];
  const raw = String(br.status_msg || '').trim();
  throw new AdapterError(`${label}：${msg}（码 ${code}${raw ? '：' + raw : ''}）`, { status, code: String(code), detail: raw });
}

/** 任务失败的原因：先看业务码，再看服务方原话，都没有就说没给。 */
function failText(r) {
  const code = Number(r?.base_resp?.status_code || 0);
  if (code && CODE_MSG[code]) return CODE_MSG[code][1];
  return String(r?.base_resp?.status_msg || '').trim() || '服务方没给原因';
}

const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg', pcmu_wav: 'audio/wav' };
function audioMime(format = 'mp3', rate) {
  // PCM 位深文档未写：给 L16 + rate，由 jobs 按 16 位单声道封成 WAV（同 Google 的 L16 处理）
  if (format === 'pcm') return `audio/L16;rate=${rate || 32000}`;
  return AUDIO_MIME[format] || 'application/octet-stream';
}

/** data.audio → Buffer。文档是 hex；万一给的是地址就下载（地址自带签名，不带 Key）。 */
async function audioBytes(audio, c, label) {
  if (isHttp(audio)) return (await download(audio, { signal: c.signal, dispatcher: c.dispatcher, timeoutMs: c.timeoutMs, label })).bytes;
  if (typeof audio !== 'string' || !/^([0-9a-f]{2})+$/i.test(audio)) throw new AdapterError(`${label}没返回音频（或音频不是 hex）`);
  return Buffer.from(audio, 'hex');
}

function clientOf(provider, key, ctx) {
  const c = {
    base: baseOf(provider), headers: authHeaders(provider, key), signal: ctx.signal, dispatcher: ctx.dispatcher,
    timeoutMs: (provider.timeoutSec || 600) * 1000,
  };
  c.call = (path, { method = 'GET', body, label = 'MiniMax', raw = false } = {}) => http(joinUrl(c.base, path), {
    method, headers: c.headers, body, raw, label, timeoutMs: c.timeoutMs, signal: c.signal, dispatcher: c.dispatcher,
  });
  return c;
}

/** 合并请求体：后面的层覆盖前面的；两边都是对象的键（voice_setting / audio_setting 这类）逐层合并，免得额外参数把 voice_id 冲掉。 */
function mergeBody(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!isObj(layer)) continue;
    for (const [k, v] of Object.entries(layer)) out[k] = isObj(out[k]) && isObj(v) ? { ...out[k], ...v } : v;
  }
  return out;
}

/**
 * 成片下载。文档：retrieve 的 schema 没列 download_url、示例里有，先试它；没有就走 retrieve_content（文档写的是「下载模型生成的文件」，
 * Content-Type 自相矛盾）：二进制直接用，JSON 就从里面找地址。
 */
async function videoFile(c, fileId, label) {
  const q = `file_id=${encodeURIComponent(fileId)}`;
  const meta = checkBase(await c.call(`files/retrieve?${q}`, { label }), label);
  const u1 = meta?.file?.download_url;
  if (isHttp(u1)) return download(u1, { signal: c.signal, dispatcher: c.dispatcher, timeoutMs: c.timeoutMs, label });
  const res = await c.call(`files/retrieve_content?${q}`, { label, raw: true });
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) throw new AdapterError(`${label}：文件接口返回的不是视频`);
  if (!type.includes('json')) return { bytes: Buffer.from(await res.arrayBuffer()), mime: type };
  let j = null;
  try { j = JSON.parse(await res.text()); } catch {}
  checkBase(j, label);
  const u2 = j?.file?.download_url || j?.download_url || j?.url;
  if (isHttp(u2)) return download(u2, { signal: c.signal, dispatcher: c.dispatcher, timeoutMs: c.timeoutMs, label });
  throw new AdapterError(`${label}：文件接口没给下载地址`);
}

// 首帧 / 尾帧图 → data URL（文档：公网 URL 或 data URL 都行；这里用 data URL，不依赖上传）。格式与大小两张图同一套要求
function frameUrl(frame, name) {
  const mime = String(frame.mime || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!FIRST_FRAME_MIME.includes(mime)) throw new AdapterError(`${name}只认 JPG / PNG / WebP`, { status: 400 });
  if (frame.data.length > FIRST_FRAME_MAX) throw new AdapterError(`${name}不能超过 20 MB`, { status: 400 });
  return dataUrl(frame.data, mime);
}

// 收不收尾帧、必须有首帧：先看卡（素材角色 / required），卡是同族继承或通用卡时再按模型 id 认
const takesLast = (req) => (req.card?.inputs?.images?.roles || []).includes('last') || /^MiniMax-Hailuo-02$/i.test(String(req.model || ''));
const needsFirst = (req) => (req.card?.inputs?.images?.required || []).includes('first') || /^MiniMax-Hailuo-2\.3-Fast$/i.test(String(req.model || ''));

async function runVideo(req, provider, ctx, c) {
  const p = req.params || {};
  const inputs = Array.isArray(req.inputs) ? req.inputs : [];
  const firsts = inputs.filter((x) => x.role === 'first'), lasts = inputs.filter((x) => x.role === 'last');
  if (inputs.some((x) => x.role !== 'first' && x.role !== 'last')) throw new AdapterError('MiniMax 视频只认首帧图和尾帧图（不接参考图）', { status: 400 });
  if (firsts.length > 1 || lasts.length > 1) throw new AdapterError('首帧、尾帧各只能给一张', { status: 400 });
  if (lasts.length && !takesLast(req)) throw new AdapterError('这个模型不接尾帧（首尾帧只有 Hailuo 02 支持）', { status: 400 });
  if (!firsts.length && needsFirst(req)) throw new AdapterError('Hailuo 2.3 Fast 只做图生视频：要先给一张首帧图', { status: 400 });
  const firstFrame = firsts[0] ? frameUrl(firsts[0], '首帧图') : undefined;
  const lastFrame = lasts[0] ? frameUrl(lasts[0], '尾帧图') : undefined;
  // 经典接口没有比例参数（画幅由首帧图或模型决定），通用卡的 aspectRatio 在这里忽略。负面提示词、续改线程这几个接口没有对应字段。
  const body = mergeBody({
    model: req.model,
    ...(req.prompt ? { prompt: req.prompt } : {}),
    ...(firstFrame ? { first_frame_image: firstFrame } : {}),
    ...(lastFrame ? { last_frame_image: lastFrame } : {}),
    ...(p.durationSeconds != null ? { duration: p.durationSeconds } : {}),
    ...(p.resolution ? { resolution: p.resolution } : {}),
    ...(typeof p.promptOptimizer === 'boolean' ? { prompt_optimizer: p.promptOptimizer } : {}),
    ...(typeof p.fastPretreatment === 'boolean' ? { fast_pretreatment: p.fastPretreatment } : {}),
  }, provider.params, p.extra);
  // 首尾帧接口只有 768P / 1080P（文档）：额外参数之类写成 512P 的先挡下
  if (lastFrame && String(body.resolution || '').toUpperCase() === '512P') throw new AdapterError('首尾帧不支持 512P，换 768P 或 1080P', { status: 400 });
  const label = 'MiniMax 视频';
  const created = checkBase(await c.call('video_generation', { method: 'POST', body, label }), label);
  const taskId = created?.task_id;
  if (!taskId) throw new AdapterError(`${label}没返回任务号（task_id）`);
  ctx.submitted?.();   // 提交即收不回：文档没有取消接口

  const q = `query/video_generation?task_id=${encodeURIComponent(taskId)}`;
  let note = '排队中';
  const fin = await poll(async () => {
    let r;
    try {
      r = checkBase(await c.call(q, { label: `${label}查询` }), label);
    } catch (e) {
      // 查询瞬时失败（限流 / 超时 / 网络 / 服务端）不让长任务整个判死，下一轮再查
      if (e.status === 429 || e.status >= 500 || e.code === 'network' || e.code === 'timeout') { note = '查询暂时失败，重试中'; return {}; }
      throw e;
    }
    if (!isObj(r)) throw new AdapterError(`${label}查询：返回的不是 JSON`);
    if (r.status === 'Success') return r.file_id ? { done: true, value: r } : { failed: true, error: '任务成功了，却没给文件号' };
    if (r.status === 'Fail') return { failed: true, error: failText(r) };
    note = STATUS_NOTE[r.status] || '生成中';
    return {};
  }, { intervalMs: ctx.pollMs || POLL_MS, timeoutMs: VIDEO_TIMEOUT_MS, signal: c.signal, label: 'MiniMax 视频生成', onTick: () => ctx.progress?.({ note }) });

  const f = await videoFile(c, String(fin.file_id), `${label}下载`);
  const meta = {
    ...(fin.video_width ? { width: fin.video_width } : {}),
    ...(fin.video_height ? { height: fin.video_height } : {}),
    ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
  };
  return { assets: [{ bytes: f.bytes, mime: /^video\//.test(f.mime) ? f.mime : 'video/mp4', meta }] };
}

async function runSpeech(req, provider, c) {
  const p = req.params || {};
  const text = String(req.prompt || '');
  if (!text.trim()) throw new AdapterError('要朗读的文字是空的', { status: 400 });
  if (text.length >= T2A_MAX_CHARS) throw new AdapterError('文字太长（文档上限 1 万字符）', { status: 400 });
  const format = p.format || 'mp3';
  const weights = Array.isArray(p.timbreWeights) && p.timbreWeights.length ? p.timbreWeights : null;
  const tone = String(p.pronunciation || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, PRON_MAX_LINES);
  // 声音效果：三个滑块都是 0（文档：不调）、也没选音效时整组不发
  const vm = {
    ...(p.vmPitch ? { pitch: p.vmPitch } : {}),
    ...(p.vmIntensity ? { intensity: p.vmIntensity } : {}),
    ...(p.vmTimbre ? { timbre: p.vmTimbre } : {}),
    ...(p.soundEffects ? { sound_effects: p.soundEffects } : {}),
  };
  const body = mergeBody({
    model: req.model,
    text,
    stream: false,
    output_format: 'hex',
    voice_setting: {
      // 文档：voice_setting 出现时 voice_id 必填；混音（timbre_weights）时留空
      voice_id: weights ? '' : (p.voice || DEFAULT_VOICE),
      ...(p.speed != null ? { speed: p.speed } : {}),
      ...(p.vol != null ? { vol: p.vol } : {}),
      ...(p.pitch != null ? { pitch: p.pitch } : {}),
      ...(p.emotion ? { emotion: p.emotion } : {}),
      ...(p.latexRead === true ? { latex_read: true } : {}),
    },
    audio_setting: {
      format,
      ...(p.sampleRate ? { sample_rate: p.sampleRate } : {}),
      ...(format === 'mp3' && p.bitrate ? { bitrate: p.bitrate } : {}),   // 文档：比特率只对 mp3 生效
      channel: p.channel === 2 ? 2 : 1,
    },
    ...(p.languageBoost ? { language_boost: p.languageBoost } : {}),
    ...(p.textNormalizationMode ? { text_normalization_mode: p.textNormalizationMode } : {}),
    ...(tone.length ? { pronunciation_dict: { tone } } : {}),
    ...(weights ? { timbre_weights: weights } : {}),
    ...(Object.keys(vm).length ? { voice_modify: vm } : {}),
  }, provider.params, p.extra);
  const label = 'MiniMax 配音';
  const j = checkBase(await c.call('t2a_v2', { method: 'POST', body, label }), label);
  const bytes = await audioBytes(j?.data?.audio, c, label);
  const ex = j?.extra_info || {};
  const meta = {
    ...(ex.audio_length ? { duration: secs(ex.audio_length) } : {}),   // audio_length 文档写毫秒
    ...(ex.usage_characters ? { characters: ex.usage_characters } : {}),
  };
  return { assets: [{ bytes, mime: audioMime(body.audio_setting?.format, body.audio_setting?.sample_rate), meta }] };
}

async function runMusic(req, provider, c, ctx = {}) {
  const p = req.params || {};
  const format = p.format || 'mp3';
  // 文档：纯音乐时提示词必填（1–2000 字）
  if (p.instrumental === true && !String(req.prompt || '').trim()) throw new AdapterError('纯音乐要写一段描述（曲风、情绪、场景）', { status: 400 });
  // 「自动写词」只在歌词留空时有意义（文档：开着且歌词为空时按提示词写词）；关掉又没写歌词就是必报的参数错，先挡下
  const noLyrics = !String(p.lyrics || '').trim();
  if (p.instrumental !== true && noLyrics && p.lyricsOptimizer === false) throw new AdapterError('没写歌词：写上歌词，或打开「自动写词」，或选纯音乐', { status: 400 });
  const body = mergeBody({
    model: req.model,
    ...(req.prompt ? { prompt: req.prompt } : {}),
    ...(p.lyrics ? { lyrics: p.lyrics } : {}),
    ...(typeof p.instrumental === 'boolean' ? { is_instrumental: p.instrumental } : {}),
    ...(p.instrumental !== true && noLyrics && p.lyricsOptimizer === true ? { lyrics_optimizer: true } : {}),
    stream: false,
    output_format: 'hex',
    audio_setting: {
      format,
      ...(p.sampleRate ? { sample_rate: p.sampleRate } : {}),
      ...(format === 'mp3' && p.bitrate ? { bitrate: p.bitrate } : {}),
    },
  }, provider.params, p.extra);
  // 文档：非纯音乐要歌词；lyrics_optimizer 开着时歌词留空就按提示词写词。没给歌词又不开，就是必报参数错，这里替它开上
  if (!body.is_instrumental && !String(body.lyrics || '').trim() && body.lyrics_optimizer === undefined) body.lyrics_optimizer = true;
  const label = 'MiniMax 音乐';
  ctx.submitted?.();   // 同步长请求（几十秒到几分钟）：发出去就收不回，断线 / 5xx 不重发（防重复计费，契约复核 11-04）
  const j = checkBase(await c.call('music_generation', { method: 'POST', body, label }), label);
  const bytes = await audioBytes(j?.data?.audio, c, label);
  // 文档没写 extra_info.music_duration 的单位：示例里 music_size 813651 字节、256 kbps（32000 字节/秒）≈ 25.4 秒，对得上 25364，按毫秒
  const ms = j?.extra_info?.music_duration;
  return { assets: [{ bytes, mime: audioMime(body.audio_setting?.format, body.audio_setting?.sample_rate), meta: ms ? { duration: secs(ms) } : {} }] };
}

// —— 内置音色：系统音色表（全表 327 个，文档 faq/system-voice-id）里挑的代表；voices() 拉得到就用拉到的 ——
const VOICE_TABLE = [
  ['male-qn-qingse', '青涩青年音色'], ['male-qn-jingying', '精英青年音色'], ['male-qn-badao', '霸道青年音色'], ['male-qn-daxuesheng', '青年大学生音色'],
  ['female-shaonv', '少女音色'], ['female-yujie', '御姐音色'], ['female-chengshu', '成熟女性音色'], ['female-tianmei', '甜美女性音色'],
  ['clever_boy', '聪明男童'], ['lovely_girl', '萌萌女童'],
  ['Chinese (Mandarin)_Gentleman', '温润男声'], ['Chinese (Mandarin)_Warm_Girl', '温暖少女'], ['Chinese (Mandarin)_Sweet_Lady', '甜美女声'],
  ['Chinese (Mandarin)_News_Anchor', '新闻女声'], ['Chinese (Mandarin)_Radio_Host', '电台男主播'], ['Cantonese_GentleLady', '温柔女声'],
  ['English_Graceful_Lady', 'Graceful Lady'], ['English_Trustworth_Man', 'Trustworthy Man'], ['Japanese_KindLady', 'Kind Lady'], ['Korean_SweetGirl', 'Sweet Girl'],
];
const VOICE_OPTS = VOICE_TABLE.map(([value, label]) => ({ value, label }));   // 卡上的 options
const VOICE_LIST = VOICE_TABLE.map(([id, label]) => ({ id, label }));         // voices() 的回退

export const minimaxAdapter = {
  dialect: 'minimax',
  kinds: ['video', 'speech', 'music'],

  // 音色查询（只读、不生成）：没 Key / 401 / 403 / 业务码 1004、2049 都是「Key 无效」
  async test(provider, ctx) {
    const key = ctx.secret?.key;
    if (!key) throw new AdapterError('还没填 API Key');
    let j;
    try {
      j = await http(joinUrl(baseOf(provider), 'get_voice'), { method: 'POST', headers: authHeaders(provider, key), body: { voice_type: 'system' }, timeoutMs: 30_000, signal: ctx.signal, dispatcher: ctx.dispatcher, label: 'MiniMax' });
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new AdapterError('API Key 无效或没权限', { status: e.status });
      throw e;
    }
    checkBase(j, 'MiniMax');
    const n = Array.isArray(j?.system_voice) ? j.system_voice.length : 0;
    return { detail: `Key 有效（系统音色 ${n} 个）` };
  },

  // 文档没有模型列表接口：视频 / 配音 / 音乐的 model 枚举都写在各接口页，已登记成 CARDS
  async listModels() { return []; },

  // 音色：拉得到 → 系统音色（全表）+ 账号自己的克隆 / 文生音色（文档：只有成功用于合成后才查得到）；拉不到（没 Key、网络、报错）→ 内置表
  async voices(provider, ctx) {
    const key = ctx.secret?.key;
    if (!key) return VOICE_LIST;
    let j;
    try {
      j = checkBase(await http(joinUrl(baseOf(provider), 'get_voice'), { method: 'POST', headers: authHeaders(provider, key), body: { voice_type: 'all' }, timeoutMs: 30_000, signal: ctx.signal, dispatcher: ctx.dispatcher, label: 'MiniMax' }), 'MiniMax 音色');
    } catch {
      return VOICE_LIST;
    }
    const sys = (Array.isArray(j?.system_voice) ? j.system_voice : []).filter((v) => v?.voice_id).map((v) => ({ id: v.voice_id, label: v.voice_name || v.voice_id }));
    const mine = [
      ...(Array.isArray(j?.voice_cloning) ? j.voice_cloning : []).filter((v) => v?.voice_id).map((v) => ({ id: v.voice_id, label: v.voice_id, note: '克隆音色' })),
      ...(Array.isArray(j?.voice_generation) ? j.voice_generation : []).filter((v) => v?.voice_id).map((v) => ({ id: v.voice_id, label: v.voice_id, note: '文生音色' })),
    ];
    return [...(sys.length ? sys : VOICE_LIST), ...mine];
  },

  async run(req, provider, ctx) {
    const key = ctx.secret?.key;
    if (!key) throw new AdapterError('这个服务还没填 API Key');
    const c = clientOf(provider, key, ctx);
    if (req.kind === 'video') return runVideo(req, provider, ctx, c);
    if (req.kind === 'speech') return runSpeech(req, provider, c);
    if (req.kind === 'music') return runMusic(req, provider, c, ctx);
    throw new AdapterError('MiniMax 没有这种媒体：' + req.kind, { status: 400 });
  },
};

// —— 模型卡（参数的组与默认值按文档；enum 的值是官方接受的值）——
// 基本参数（输入框底栏的芯片）每张卡 4 个左右，其余放高级；高级里成对的挨着排。
const hz = (list) => list.map((v) => ({ value: v, label: `${v} Hz` }));
const kbps = (list) => list.map((v) => ({ value: v, label: `${v / 1000} kbps` }));
const RES_23 = opts([{ value: '768P', label: '768P' }, { value: '1080P', label: '1080P', note: '只出 6 秒' }]);
// 02：512P 只在图生视频（有首帧、没尾帧）时有——文生视频只有 768P / 1080P，首尾帧也不支持 512P（文档三个接口页）
const RES_02 = opts([{ value: '512P', label: '512P', only: { $first: true, $last: false } }, { value: '768P', label: '768P' }, { value: '1080P', label: '1080P', note: '只出 6 秒' }]);
const EMOTION_LABEL = { happy: '开心', sad: '悲伤', angry: '生气', fearful: '害怕', disgusted: '厌恶', surprised: '惊讶', calm: '平静', fluent: '活泼', whisper: '耳语' };
const EMO_28 = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];   // 文档：2.8 系列不支持 fluent / whisper
const EMO_26 = [...EMO_28, 'fluent', 'whisper'];                                       // 文档：fluent / whisper 只 2.6 系列
// 语种增强：文档的 41 个取值（值照原样发，标签用中文语言名）
const LANG_NAMES = [
  ['auto', '自动识别'], ['Chinese', '中文'], ['Chinese,Yue', '粤语'], ['English', '英语'], ['Japanese', '日语'], ['Korean', '韩语'],
  ['Arabic', '阿拉伯语'], ['Russian', '俄语'], ['Spanish', '西班牙语'], ['French', '法语'], ['Portuguese', '葡萄牙语'], ['German', '德语'],
  ['Turkish', '土耳其语'], ['Dutch', '荷兰语'], ['Ukrainian', '乌克兰语'], ['Vietnamese', '越南语'], ['Indonesian', '印尼语'], ['Italian', '意大利语'],
  ['Thai', '泰语'], ['Polish', '波兰语'], ['Romanian', '罗马尼亚语'], ['Greek', '希腊语'], ['Czech', '捷克语'], ['Finnish', '芬兰语'],
  ['Hindi', '印地语'], ['Bulgarian', '保加利亚语'], ['Danish', '丹麦语'], ['Hebrew', '希伯来语'], ['Malay', '马来语'], ['Persian', '波斯语'],
  ['Slovak', '斯洛伐克语'], ['Swedish', '瑞典语'], ['Croatian', '克罗地亚语'], ['Filipino', '菲律宾语'], ['Hungarian', '匈牙利语'], ['Norwegian', '挪威语'],
  ['Slovenian', '斯洛文尼亚语'], ['Catalan', '加泰罗尼亚语'], ['Nynorsk', '新挪威语'], ['Tamil', '泰米尔语'], ['Afrikaans', '南非荷兰语'],
];
const LANG_BOOST = [{ value: '', label: '不指定' }, ...LANG_NAMES.map(([value, label]) => ({ value, label }))];
const SPEECH_FORMATS = ['mp3', 'wav', 'flac', 'opus', 'pcm'];
const MODIFY_FORMATS = ['mp3', 'wav', 'flac'];                 // 文档：声音效果（voice_modify）非流式只认这三种
const STEREO_FORMATS = SPEECH_FORMATS.filter((f) => f !== 'pcm');   // 裸 PCM 按单声道封 WAV，立体声会错乱：PCM 时不给声道
const SOUND_EFFECTS = [
  { value: '', label: '无' }, { value: 'spacious_echo', label: '空旷回声' }, { value: 'auditorium_echo', label: '礼堂回声' },
  { value: 'lofi_telephone', label: '电话音' }, { value: 'robotic', label: '机器人' },
];
const PRON_MAX_LINES = 200;
const WEIGHTS_MAX = 4;   // 文档：最多 4 个音色混合

// 视频：首帧图可选（不给就是文生视频）；分辨率与时长的组合按文档矩阵（1080P 只 6 秒）。
// o.last：收尾帧（只 02，走首尾帧接口）；o.needFirst：必须有首帧（2.3 Fast 只做图生视频）
function videoCard(model, { label, desc, resolutions, defaultRes, last = false, needFirst = false }) {
  return {
    id: `minimax:${model}`, kind: 'video', async: true, label, desc,
    inputs: { text: true, images: { max: last ? 2 : 1, roles: last ? ['first', 'last'] : ['first'], ...(needFirst ? { required: ['first'] } : {}) } },
    params: [
      P.enum('resolution', '分辨率', resolutions, { default: defaultRes }),
      // 1080P 只出 6 秒（文档）：10 秒只在 512P / 768P 时成立
      P.enum('durationSeconds', '时长', opts([{ value: 6, label: '6 秒' }, { value: 10, label: '10 秒', note: '1080P 不支持 10 秒', only: { resolution: ['512P', '768P'] } }]), { default: 6 }),
      P.bool('promptOptimizer', '提示词优化', { default: true, desc: '关掉后提示词原样使用' }),
      // 首尾帧接口页没有这个字段：有尾帧时不发
      P.bool('fastPretreatment', '快速预处理', { default: false, desc: '缩短提示词优化的耗时', ...(last ? { when: { $last: false } } : {}) }),
      P.json(),
    ],
  };
}

// 混音（timbre_weights）：[{ voice_id, weight 1–100 }]，最多 4 个（文档）
function parseWeights(v) {
  if (v === undefined || v === null || v === '') return undefined;
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { throw new AdapterError('混音不是合法 JSON', { status: 400 }); } }
  if (!Array.isArray(a)) throw new AdapterError('混音要写成列表：[ … ]', { status: 400 });
  if (!a.length) return undefined;
  if (a.length > WEIGHTS_MAX) throw new AdapterError(`混音最多 ${WEIGHTS_MAX} 个音色`, { status: 400 });
  return a.map((x) => {
    const w = Number(x?.weight);
    if (!isObj(x) || typeof x.voice_id !== 'string' || !x.voice_id.trim()) throw new AdapterError('混音的每一项要有 voice_id', { status: 400 });
    if (!Number.isInteger(w) || w < 1 || w > 100) throw new AdapterError('混音的 weight 要是 1–100 的整数', { status: 400 });
    return { voice_id: x.voice_id, weight: w };
  });
}

// 配音：音色 / 情绪 / 语速音量音调 / 格式采样率比特率声道 / 文本规范化 / 读公式 / 读音 / 声音效果 / 混音；停顿、语气词标签写在正文里，原样发
function speechCard(model, { label, desc, emotions }) {
  const MOD = { when: { format: MODIFY_FORMATS } };
  const params = [
    P.voice('voice', '音色', { default: DEFAULT_VOICE, options: VOICE_OPTS }),
    P.enum('emotion', '情绪', [{ value: '', label: '自动' }, ...emotions.map((v) => ({ value: v, label: EMOTION_LABEL[v] }))], { default: '' }),
    P.num('speed', '语速', 0.5, 2, { group: 'basic', step: 0.05, default: 1 }),
    P.enum('languageBoost', '语种增强', LANG_BOOST, { default: '' }),
    P.num('vol', '音量', 0.01, 10, { step: 0.1, default: 1 }),
    P.num('pitch', '音调', -12, 12, { step: 1, integer: true, default: 0, unit: '半音' }),
    P.enum('format', '格式', opts(SPEECH_FORMATS.map((v) => ({ value: v, label: v.toUpperCase() }))), { group: 'advanced', default: 'mp3' }),
    P.enum('sampleRate', '采样率', hz([8000, 16000, 22050, 24000, 32000, 44100]), { group: 'advanced', default: 32000 }),
    P.enum('bitrate', '比特率', kbps([32000, 64000, 128000, 256000]), { group: 'advanced', default: 128000, when: { format: 'mp3' } }),
    P.enum('channel', '声道', [{ value: 1, label: '单声道' }, { value: 2, label: '立体声' }], { group: 'advanced', default: 1, when: { format: STEREO_FORMATS } }),
    P.enum('textNormalizationMode', '数字与符号', [{ value: '', label: '不处理' }, { value: 'basic', label: '规则' }, { value: 'quality', label: '精细' }], { group: 'advanced', default: '', desc: '精细档更准、稍慢' }),
    P.bool('latexRead', '朗读公式', { desc: '只支持中文；公式用 $$ 包起来' }),
    P.text('pronunciation', '读音', { max: 4000, multiline: true, desc: '一行一条：原文/替换，如 处理/(chu3)(li3)' }),
    P.num('vmPitch', '低沉 ↔ 明亮', -100, 100, { step: 1, integer: true, default: 0, ...MOD }),
    P.num('vmIntensity', '有力 ↔ 柔和', -100, 100, { step: 1, integer: true, default: 0, ...MOD }),
    P.num('vmTimbre', '浑厚 ↔ 清脆', -100, 100, { step: 1, integer: true, default: 0, ...MOD }),
    P.enum('soundEffects', '音效', SOUND_EFFECTS, { group: 'advanced', default: '', ...MOD }),
    P.json('timbreWeights', '混音', { array: true, desc: '[{ "voice_id": "…", "weight": 1–100 }]，最多 4 个；给了就不用上面的音色' }),
    P.json(),
  ];
  return {
    id: `minimax:${model}`, kind: 'speech', async: false, label, desc,
    inputs: { text: true },
    params,
    // 数组型 JSON（混音）自己解析：通用规范化只认对象
    normalize(raw = {}, ctx = {}) {
      const r = { ...(raw && typeof raw === 'object' ? raw : {}) };
      const w = r.timbreWeights;
      delete r.timbreWeights;
      const out = applySpecs(params, r, ctx);
      const list = parseWeights(w);
      if (list) out.timbreWeights = list;
      return out;
    },
  };
}

// 音乐：纯音乐 / 歌词 / 自动写词（歌词留空时）/ 格式采样率比特率；文档没有时长参数
function musicCard(model, { label, desc }) {
  return {
    id: `minimax:${model}`, kind: 'music', async: false, label, desc,
    inputs: { text: true },
    params: [
      P.bool('instrumental', '纯音乐', { group: 'basic', default: false }),
      P.text('lyrics', '歌词', { group: 'basic', max: LYRICS_MAX, multiline: true, when: { instrumental: false }, desc: '用 [Verse]、[Chorus] 等段落标签分段' }),
      P.bool('lyricsOptimizer', '自动写词', { group: 'basic', default: true, when: { instrumental: false }, desc: '歌词留空时按提示词写词' }),
      P.enum('format', '格式', opts(['mp3', 'wav', 'pcm'].map((v) => ({ value: v, label: v.toUpperCase() }))), { group: 'advanced', default: 'mp3' }),
      P.enum('sampleRate', '采样率', hz([16000, 24000, 32000, 44100]), { group: 'advanced', default: 44100 }),
      P.enum('bitrate', '比特率', kbps([32000, 64000, 128000, 256000]), { group: 'advanced', default: 256000, when: { format: 'mp3' } }),
      P.json(),
    ],
  };
}

export const CARDS = {
  'MiniMax-Hailuo-2.3': videoCard('MiniMax-Hailuo-2.3', { label: 'Hailuo 2.3', desc: '首帧图生视频，也能文生视频；1080P 只出 6 秒', resolutions: RES_23, defaultRes: '768P' }),
  'MiniMax-Hailuo-2.3-Fast': videoCard('MiniMax-Hailuo-2.3-Fast', { label: 'Hailuo 2.3 Fast', desc: '2.3 的快速版，只做图生视频（要首帧）', resolutions: RES_23, defaultRes: '768P', needFirst: true }),
  'MiniMax-Hailuo-02': videoCard('MiniMax-Hailuo-02', { label: 'Hailuo 02', desc: '首帧、首尾帧或文生视频；512P 只在图生视频', resolutions: RES_02, defaultRes: '768P', last: true }),
  'speech-2.8-hd': speechCard('speech-2.8-hd', { label: 'Speech 2.8 HD', desc: '支持语气词标签，如 (laughs)、(sighs)', emotions: EMO_28 }),
  'speech-2.8-turbo': speechCard('speech-2.8-turbo', { label: 'Speech 2.8 Turbo', desc: '同 2.8 HD 的功能', emotions: EMO_28 }),
  'speech-2.6-hd': speechCard('speech-2.6-hd', { label: 'Speech 2.6 HD', desc: '支持耳语、活泼情绪，不支持语气词标签', emotions: EMO_26 }),
  'speech-2.6-turbo': speechCard('speech-2.6-turbo', { label: 'Speech 2.6 Turbo', desc: '同 2.6 HD 的功能', emotions: EMO_26 }),
  'music-3.0': musicCard('music-3.0', { label: 'Music 3.0', desc: '文字生成音乐，推荐；2026-08-20 起新用户不再开放付费音乐接口，老付费用户可继续' }),
  'music-2.6': musicCard('music-2.6', { label: 'Music 2.6', desc: '上一代文字生成音乐；付费接口的新用户限制同 3.0' }),
};
registerDialectCards('minimax', CARDS);
