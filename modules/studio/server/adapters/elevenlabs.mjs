// elevenlabs 方言：配音（speech）与音乐（music）。整个文件替换自占位 stub。
//
// 依据 ElevenLabs 官方文档，2026-11-04 查阅（没有 Key，全部未真打；测试全程 mock fetch）：
//   · 鉴权：请求头 xi-api-key（https://elevenlabs.io/docs/api-reference/authentication）。Key 可设「接口范围限制」，
//     受限 Key 调不到的接口会被拒；文档没列权限名，也没写对应的报错码。
//   · 配音：POST {base}/text-to-speech/{voice_id}?output_format=…（https://elevenlabs.io/docs/api-reference/text-to-speech/convert）。
//     body：text（必填）、model_id（默认 eleven_multilingual_v2）、voice_settings（覆盖音色自己存的设置，只对本次生效）、
//     language_code、seed、apply_text_normalization（auto / on / off）。output_format 是 query 参数，默认 mp3_44100_128；
//     mp3_44100_192 要 Creator 及以上，pcm_44100 / wav_44100 要 Pro 及以上。
//     结果：200 直接回音频二进制（文档只写「File download」，没写 Content-Type，mime 按 output_format 定）。同步：没有任务 id，没有取消接口。
//   · 音乐：POST {base}/music?output_format=…（https://elevenlabs.io/docs/api-reference/music/compose；
//     概览 https://elevenlabs.io/docs/overview/capabilities/music）。body：prompt 与 composition_plan 二选一；
//     music_length_ms 3000–600000，只和 prompt 同用；model_id（music_v1 / music_v2 / music_v2_5），省略时默认 music_v1（已弃用），所以总是显式带；
//     force_instrumental 默认 false；seed 不能和 prompt 同用，这里不用。结果：200 直接回整首音频（同步，没有轮询）。
//     song id 在响应头里，头名文档没写，这里不读。概览页写最长 5 分钟，API 字段写 600000 毫秒，卡上按 5 分钟给上限。
//   · 音色：GET {根}/v2/voices（https://elevenlabs.io/docs/api-reference/voices/search）。query：voice_type（default＝官方预置，
//     non-community＝账号自己的 personal + workspace）、page_size（≤100）、next_page_token；返回 voices / has_more / next_page_token。
//     「{根}」＝baseUrl 去掉末尾的 /v1（v2 与 v1 同主机同前缀）。v1 的 voices/get-all 页抓到的也是 v2 内容，没有 v1 说明，所以只用 v2。
//   · 模型：GET {base}/models（https://elevenlabs.io/docs/api-reference/models/list）：顶层是数组，can_do_text_to_speech 标明是不是 TTS。
//     列表里没有音乐能力字段，音乐模型按卡补。
//   · 模型状态（https://elevenlabs.io/docs/overview/models，音乐见上面的概览页）：eleven_v4 / eleven_v4_turbo 为当前型号；eleven_flash_v2_5 为旗舰；
//     eleven_multilingual_v2 是 API 默认（页面标为上一代，仍推荐用于质量）；eleven_v3 为上一代；eleven_turbo_v2_5 / eleven_turbo_v2 已弃用。
//     music_v2_5 / music_v2 为当前型号；music_v1 已弃用（2027-01-31 下线），不进卡表。
//   · 账户：GET {base}/user/subscription（https://elevenlabs.io/docs/api-reference/user/subscription/get）：tier / character_count / character_limit。
//     文档没写是否计费，这里按只读账户接口处理（不生成音频、不扣字符）。
//   · 错误（https://elevenlabs.io/docs/eleven-api/resources/errors）：{ detail: { type, code, message, status(已弃用), request_id, param } }。
//     401 invalid_api_key / missing_api_key；402 insufficient_credits；403 insufficient_permissions；400 validation_error / text_too_long；429 rate_limit_error。
//
// 取舍（文档没写或与卡片默认不同的地方）：
//   · 配音和音乐都是同步接口：没有轮询，取消就是断开连接。配音是秒级短请求，不标「发出去收不回」——限流 429 / 5xx 时任务执行器还能重试；
//     音乐一首要几十秒到几分钟、上游断开后是否仍计费文档没写，发请求前调一次 ctx.submitted()（取消后显示「已放弃（仍可能计费）」，也不自动重发免得重复计费）。
//   · 音乐卡标 async=true，和 google 的音乐卡一致（目录里的 async 字段）：一首要几十秒到几分钟；接口本身仍是同步的。
//   · voice_settings 只带用户明确设了的字段。文档说它会覆盖音色自己存的设置，所以卡上不给默认值，免得每次都把音色设置盖掉。
//   · apply_text_normalization 卡上不给默认值：文档写默认 auto，但概览页把这个开关标为企业版功能（v2.5 系列），默认带上可能被拒；不给就是服务端默认值。
//   · 默认音色：文档没指定默认音色，示例里都用 JBFqnCBsd6RMkjVDRZzb，按它处理。
//   · 取值范围：文档没写 stability / similarity_boost / style / speed 的范围。前三个按 0–1 夹紧；speed 不夹紧，超范围由服务端 422 原话透出。
//   · test() 只调 GET /user/subscription（只读），不发任何生成请求。

import { http, authHeaders, joinUrl, AdapterError } from './http.mjs';
import { P } from '../cards/spec.mjs';
import { registerDialectCards } from '../cards/dialects.mjs';

const BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_TTS_FORMAT = 'mp3_44100_128';
const MUSIC_MIN_MS = 3000, MUSIC_MAX_MS = 600000;

const base = (provider) => String(provider.baseUrl || BASE_URL).replace(/\/+$/, '');
// v2 接口（音色搜索）与 v1 同主机同前缀：把末尾的 /v1 去掉再拼 /v2/…；地址里本来没有版本段的也照拼
const v2Url = (provider, path) => joinUrl(base(provider).replace(/\/v\d+$/, ''), 'v2/' + path);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clampMusicMs = (sec) => Math.min(MUSIC_MAX_MS, Math.max(MUSIC_MIN_MS, Math.round(Number(sec) * 1000)));
// 请求体合并顺序（简报）：卡上参数映射后的字段 → 服务级 params → 逐次 extra
const mergeBody = (mapped, provider, p) => ({ ...mapped, ...(provider.params || {}), ...(p.extra || {}) });

// 结果的 mime 按请求的输出格式定（文档：auto 对应 MP3）；认不出的格式才用服务回的 Content-Type
function mimeOf(format, contentType) {
  const f = String(format || '');
  if (f === 'auto' || f.startsWith('mp3_')) return 'audio/mpeg';
  if (f.startsWith('wav_')) return 'audio/wav';
  const pcm = /^pcm_(\d+)$/.exec(f);
  if (pcm) return `audio/L16;rate=${pcm[1]}`;   // 裸 PCM 带采样率：jobs 的 normalizeOutput 据此包成 WAV
  return String(contentType || '').split(';')[0].trim() || 'application/octet-stream';
}

// —— 模型卡 ——
const TTS_FORMATS = [
  { value: 'mp3_44100_128', label: 'MP3 44.1kHz 128kbps' },
  { value: 'mp3_44100_192', label: 'MP3 44.1kHz 192kbps', note: '需要 Creator 及以上套餐' },
  { value: 'mp3_22050_32', label: 'MP3 22kHz 32kbps（小文件）' },
  { value: 'wav_24000', label: 'WAV 24kHz' },
];
const MUSIC_FORMATS = [
  { value: 'auto', label: '自动（按模型，MP3）' },
  { value: 'mp3_44100_128', label: 'MP3 44.1kHz 128kbps' },
  { value: 'mp3_44100_192', label: 'MP3 44.1kHz 192kbps' },
  { value: 'mp3_48000_192', label: 'MP3 48kHz 192kbps' },
];
const NORMALIZE = [
  { value: 'auto', label: '自动（数字、缩写读成词）' },
  { value: 'on', label: '总是做' },
  { value: 'off', label: '不做' },
];

function speechCard(label, desc) {
  return {
    kind: 'speech', async: false, label, desc, priceHint: '按字符计费',
    inputs: { text: true },
    params: [
      P.voice('voice', '音色', { default: DEFAULT_VOICE, desc: '音色 id；下拉来自账号自己的音色和官方预置音色' }),
      P.enum('outputFormat', '输出格式', TTS_FORMATS, { group: 'advanced', default: DEFAULT_TTS_FORMAT }),
      P.num('stability', '稳定度', 0, 1, { step: 0.05, desc: '低＝情绪起伏大，高＝更平稳（文档没写范围，按 0–1 夹紧）' }),
      P.num('similarityBoost', '相似度', 0, 1, { step: 0.05, desc: '贴近原声的程度（文档没写范围，按 0–1 夹紧）' }),
      P.num('style', '风格强度', 0, 1, { step: 0.05, desc: '放大原声的风格，非 0 会增加耗时（文档没写范围，按 0–1 夹紧）' }),
      P.num('speed', '语速', 0.7, 1.2, { step: 0.05, desc: '1 为正常速度（0.7–1.2）' }),
      P.bool('useSpeakerBoost', '说话人增强', { desc: '提高与原声的相似度，代价是耗时' }),
      P.text('languageCode', '语言代码', { max: 8, desc: 'ISO 639-1，如 zh、en；模型不支持时服务端会忽略' }),
      P.enum('applyTextNormalization', '数字与缩写', NORMALIZE, { group: 'advanced', desc: '不选＝服务端默认（auto）；v2.5 系列文档标为企业版功能' }),
      P.seed({ desc: '不给＝随机；同一个种子尽量出同样的结果（不保证）' }),
      P.json(),
    ],
  };
}

function musicCard(label, desc) {
  return {
    kind: 'music', async: true, label, desc,
    inputs: { text: true },
    params: [
      P.num('durationSeconds', '时长（秒）', 3, 300, { group: 'basic', step: 1, integer: true, desc: '不给＝由模型决定长度（产品页写最长 5 分钟）' }),
      P.bool('forceInstrumental', '纯音乐（无人声）', { default: false }),
      P.enum('outputFormat', '输出格式', MUSIC_FORMATS, { group: 'advanced', default: 'auto' }),
      P.json(),
    ],
  };
}

// 内置常见模型：设置页「添加常见模型」和拉不到列表时的兜底；卡的 kind 就是它的种类
export const CARDS = {
  eleven_v4: speechCard('Eleven v4', '当前质量最好的型号（文档标为推荐用于质量），单次约 1 万字符，90 多种语言'),
  eleven_v4_turbo: speechCard('Eleven v4 Turbo', '当前的低延迟型号（中位延迟约 100 毫秒），适合实时场景，90 多种语言'),
  eleven_flash_v2_5: speechCard('Eleven Flash v2.5', '旗舰快速型号，单次约 4 万字符，32 种语言'),
  eleven_multilingual_v2: speechCard('Eleven Multilingual v2', 'API 默认型号，多语种、长文本稳定（文档标为上一代，但仍推荐用于质量）'),
  music_v2_5: musicCard('Eleven Music v2.5', '最先进的音乐模型，音质和提示词遵循都比 v2 好'),
  music_v2: musicCard('Eleven Music v2', '现行音乐模型（界面默认），可以出人声，也可以出纯音乐'),
};
registerDialectCards('elevenlabs', CARDS);

// —— 音色 ——
const GENDER_ZH = { male: '男声', female: '女声', neutral: '中性' };
const voiceNote = (v) => {
  const l = v.labels || {};
  return [l.accent, GENDER_ZH[l.gender] || l.gender, l.use_case].filter(Boolean).join(' · ');
};

// 按页拉某一类音色：最多 3 页（共 300 个）。文档没写上限，这里自己封顶，免得音色库太大拖慢下拉。
async function pageVoices(provider, key, voiceType, { dispatcher, signal }) {
  const out = [];
  let token = '';
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ voice_type: voiceType, page_size: '100' });
    if (token) q.set('next_page_token', token);
    const j = await http(`${v2Url(provider, 'voices')}?${q}`, { headers: authHeaders(provider, key), timeoutMs: 30_000, dispatcher, signal, label: 'ElevenLabs' });
    out.push(...(Array.isArray(j?.voices) ? j.voices : []));
    if (!j?.has_more || !j?.next_page_token) break;
    token = j.next_page_token;
  }
  return out;
}

// —— 生成：配音与音乐都是同步请求，回的就是音频二进制 ——
async function runSpeech(req, provider, ctx, common) {
  const p = req.params || {};
  if (!String(req.prompt || '').trim()) throw new AdapterError('要配音的文字是空的');
  // 音色设置只带用户明确设了的字段（文档：voice_settings 会覆盖音色自己存的设置）
  const vs = {};
  if (p.stability !== undefined) vs.stability = p.stability;
  if (p.similarityBoost !== undefined) vs.similarity_boost = p.similarityBoost;
  if (p.style !== undefined) vs.style = p.style;
  if (p.speed !== undefined) vs.speed = p.speed;
  if (p.useSpeakerBoost !== undefined) vs.use_speaker_boost = p.useSpeakerBoost;
  const body = mergeBody({
    text: req.prompt,
    model_id: req.model,
    ...(Object.keys(vs).length ? { voice_settings: vs } : {}),
    ...(p.languageCode ? { language_code: p.languageCode } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.applyTextNormalization ? { apply_text_normalization: p.applyTextNormalization } : {}),
  }, provider, p);
  const voice = String(p.voice || DEFAULT_VOICE);
  // output_format 是 query 参数：误写进请求体的（服务级 params / 逐次 extra）挪到 query，且逐次 extra 优先
  const format = String(body.output_format || p.outputFormat || DEFAULT_TTS_FORMAT);
  delete body.output_format;
  const url = `${base(provider)}/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(format)}`;
  const res = await http(url, { ...common, method: 'POST', body, raw: true, label: 'ElevenLabs 配音' });
  return { assets: [{ bytes: Buffer.from(await res.arrayBuffer()), mime: mimeOf(format, res.headers.get('content-type')), meta: { voice, characters: String(req.prompt).length } }] };
}

async function runMusic(req, provider, ctx, common) {
  const p = req.params || {};
  const body = mergeBody({
    ...(String(req.prompt || '').trim() ? { prompt: req.prompt } : {}),
    ...(p.durationSeconds !== undefined ? { music_length_ms: clampMusicMs(p.durationSeconds) } : {}),
    ...(p.forceInstrumental !== undefined ? { force_instrumental: p.forceInstrumental } : {}),
    model_id: req.model,   // 总是显式带：省略时 API 默认 music_v1（已弃用）
  }, provider, p);
  // composition_plan 与 prompt 不能同用（文档）：给了分段计划，就去掉 prompt 以及只跟 prompt 有关的字段
  if (body.composition_plan) { delete body.prompt; delete body.music_length_ms; delete body.force_instrumental; }
  if (!body.prompt && !body.composition_plan) throw new AdapterError('音乐要写一段描述（提示词）');
  const format = String(body.output_format || p.outputFormat || 'auto');
  delete body.output_format;
  const url = `${base(provider)}/music?output_format=${encodeURIComponent(format)}`;
  ctx.submitted?.();
  const res = await http(url, { ...common, method: 'POST', body, raw: true, label: 'ElevenLabs 音乐' });
  return { assets: [{ bytes: Buffer.from(await res.arrayBuffer()), mime: mimeOf(format, res.headers.get('content-type')) }] };
}

export const elevenlabsAdapter = {
  dialect: 'elevenlabs',
  kinds: ['speech', 'music'],

  // GET /user/subscription：账户与字符额度（只读）。401 / 403 → 「API Key 无效」
  async test(provider, { secret, dispatcher, signal }) {
    if (!secret?.key) throw new AdapterError('还没填 API Key');
    let j;
    try {
      j = await http(joinUrl(base(provider), 'user/subscription'), { headers: authHeaders(provider, secret.key), timeoutMs: 30_000, dispatcher, signal, label: 'ElevenLabs' });
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new AdapterError('API Key 无效或没有权限（Key 设了接口范围限制的话，要允许读取账户信息）', { status: e.status, detail: e.detail });
      throw e;
    }
    const tier = j?.tier || '未知';
    const limit = num(j?.character_limit), used = num(j?.character_count);
    if (limit == null || used == null) return { detail: `Key 有效（套餐 ${tier}）` };
    return { detail: `剩余 ${Math.max(0, limit - used)} 字符（套餐 ${tier}，本周期已用 ${used} / 上限 ${limit}）` };
  },

  // GET /models：只列能配音的 TTS 模型（kind speech）；音乐模型按卡补。没填 Key 就不问，只给内置清单。
  async listModels(provider, { secret, dispatcher, signal }) {
    if (!secret?.key) return [];
    const j = await http(joinUrl(base(provider), 'models'), { headers: authHeaders(provider, secret.key), timeoutMs: 30_000, dispatcher, signal, label: 'ElevenLabs' });
    const speech = (Array.isArray(j) ? j : [])
      .filter((m) => m && m.model_id && m.can_do_text_to_speech === true)
      .map((m) => ({ id: m.model_id, label: m.name || m.model_id, kind: 'speech' }));
    const musicList = Object.entries(CARDS).filter(([, c]) => c.kind === 'music').map(([id, c]) => ({ id, label: c.label, kind: 'music' }));
    return [...speech, ...musicList];
  },

  // 音色：账号自己的（non-community）在前，官方预置（default）在后；音色库（community）太大，不全拉
  async voices(provider, { secret, dispatcher, signal }) {
    if (!secret?.key) throw new AdapterError('这个服务还没填 API Key');
    const own = await pageVoices(provider, secret.key, 'non-community', { dispatcher, signal });
    const premade = await pageVoices(provider, secret.key, 'default', { dispatcher, signal });
    const seen = new Set();
    return [...own, ...premade]
      .filter((v) => v && v.voice_id && !seen.has(v.voice_id) && seen.add(v.voice_id))
      .map((v) => ({ id: v.voice_id, label: v.name || v.voice_id, ...(voiceNote(v) ? { note: voiceNote(v) } : {}) }));
  },

  async run(req, provider, ctx) {
    const key = ctx.secret?.key;
    if (!key) throw new AdapterError('这个服务还没填 API Key');
    const common = { headers: authHeaders(provider, key), timeoutMs: (provider.timeoutSec || 600) * 1000, signal: ctx.signal, dispatcher: ctx.dispatcher };
    if (req.kind === 'speech') return runSpeech(req, provider, ctx, common);
    if (req.kind === 'music') return runMusic(req, provider, ctx, common);
    throw new AdapterError(`ElevenLabs 只做配音和音乐，做不了「${req.kind}」`);
  },
};
