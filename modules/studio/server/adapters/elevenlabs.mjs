// elevenlabs 方言：配音（speech）与音乐（music）。整个文件替换自占位 stub。
//
// 依据 ElevenLabs 官方文档（没有 Key，全部未真打；测试全程 mock fetch）。2026-11-04 首查，2026-11-15 按 openapi 复核参数：
//   · 参数总表：https://api.elevenlabs.io/openapi.json（/v1/text-to-speech/{voice_id}、/v1/music 的请求体与 query；下面的取值都照它）。
//   · 鉴权：请求头 xi-api-key（https://elevenlabs.io/docs/api-reference/authentication）。Key 可设「接口范围限制」，
//     受限 Key 调不到的接口会被拒；文档没列权限名，也没写对应的报错码。
//   · 配音：POST {base}/text-to-speech/{voice_id}?output_format=…（https://elevenlabs.io/docs/api-reference/text-to-speech/convert）。
//     body：text（必填）、model_id（默认 eleven_multilingual_v2）、voice_settings（覆盖音色自己存的设置，只对本次生效：
//     stability / similarity_boost / clone_strength 0–1，style 无上下限默认 0，speed 默认 1，use_speaker_boost 默认 true）、
//     language_code（openapi：multilingual_v2 不支持）、seed（0–4294967295）、apply_text_normalization（auto / on / off，默认 auto；
//     模型页：Flash v2.5 默认不做，要做传 on。旧文档说 v2.5 系列这个开关是企业版功能，模型页现在没有这句）、previous_text / next_text、
//     previous_request_ids / next_request_ids（各 ≤3）、pronunciation_dictionary_locators（≤3 个 { pronunciation_dictionary_id, version_id? }）、
//     use_pvc_as_ivc、audio_effects（filter_preset_id / distance 0–1 / environment_id / background_noise_id / send_level 0–1 / pan −1~1；
//     有混响或 pan≠0 时出立体声，pcm / ulaw / alaw 会被 400 拒；可选 id 见 GET /v1/audio-effects/catalog）。
//     output_format 是 query 参数，28 档，默认 mp3_44100_128；mp3_44100_192 要 Creator 及以上，pcm / wav 的 44.1kHz 要 Pro 及以上。
//     各型号能调的音色设置（产品指南 https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech）：
//       v4 / v4 Turbo 只有 Stability 与 Similarity（专业克隆音色另有 Clone Strength），没有 Style、Speed；
//       v3 没有 Speed、Similarity、Speaker Boost；语速 0.7–1.2（同页）。
//     结果：200 直接回音频二进制（文档只写「File download」，没写 Content-Type，mime 按 output_format 定）。同步：没有任务 id，没有取消接口。
//   · 音乐：POST {base}/music?output_format=…（https://elevenlabs.io/docs/api-reference/music/compose；
//     概览 https://elevenlabs.io/docs/overview/capabilities/music）。body：prompt（≤4100 字）与 composition_plan 二选一；
//     music_length_ms 3000–600000，只和 prompt 同用；model_id（music_v1 / music_v2 / music_v2_5），省略时默认 music_v1（已弃用），所以总是显式带；
//     force_instrumental 默认 false，只和 prompt 同用；seed（0–2147483647）不能和 prompt 同用（只配 composition_plan）；
//     composition_plan：v2 / v2.5 是 { chunks: [...] }（≤30 段），v1 是 { positive/negative_global_styles, sections }；
//     finetune_id（≤100 字）、store_for_inpainting、sign_with_c2pa（只对 mp3）。output_format 26 档，默认 auto。
//     结果：200 直接回整首音频（同步，没有轮询）。song id 在响应头里，头名文档没写，这里不读。
//     时长上限文档冲突：API 字段写 600000 毫秒（10 分钟），概览页写最长 5 分钟。卡上按 5 分钟给（300 秒），run 只夹到 API 的范围。
//   · 音色：GET {根}/v2/voices（https://elevenlabs.io/docs/api-reference/voices/search）。query：voice_type（default＝官方预置，
//     non-community＝账号自己的 personal + workspace）、page_size（≤100）、next_page_token；返回 voices / has_more / next_page_token。
//     「{根}」＝baseUrl 去掉末尾的 /v1（v2 与 v1 同主机同前缀）。v1 的 voices/get-all 页抓到的也是 v2 内容，没有 v1 说明，所以只用 v2。
//   · 模型：GET {base}/models（https://elevenlabs.io/docs/api-reference/models/list）：顶层是数组，can_do_text_to_speech 标明是不是 TTS。
//     列表里没有音乐能力字段，音乐模型按卡补。
//   · 模型状态（https://elevenlabs.io/docs/overview/models）：eleven_v4 为旗舰，eleven_v4_turbo、eleven_flash_v2_5 为当前型号；
//     eleven_v3、eleven_multilingual_v2 为上一代（API 默认仍是 multilingual_v2）；eleven_turbo_v2_5 / eleven_turbo_v2 已弃用。
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
//   · voice_settings 会覆盖音色自己存的设置：卡上多一个「音色设置」开关（默认＝用音色自带，什么都不发），选「自定义」才出现并发送各项
//     （默认值＝文档默认）。界面对没有默认值的数字会发下限，所以不能靠「不给默认值」来表达不传。
//   · 音乐时长同理：多一个「模型定时长」开关（默认开＝不发 music_length_ms）；关掉才出现时长（默认 30 秒）。
//     只给了时长、没提这个开关的调用（旧接口、Claude 媒体工具）按给的时长出。
//   · 界面的种子「随机」发 -1：这家种子下限是 0，-1 当没给（不然会被夹成 0、每次都出同一条）。
//   · 音效（audio_effects）平铺成几项：距离 / 混响强度 / 声像带文档默认值，等于默认且没填 id 时整组不发；输出 PCM 时整组隐藏（立体声会被拒）。
//   · ulaw / alaw 输出不放进卡（8kHz 电话音质，播放器多数不认），要用就写额外参数。
//   · 默认音色：文档没指定默认音色，示例里都用 JBFqnCBsd6RMkjVDRZzb，按它处理。
//   · test() 只调 GET /user/subscription（只读），不发任何生成请求。
// 没做（另立）：音效 POST /v1/sound-generation、对白 POST /v1/text-to-dialogue。

import { http, authHeaders, joinUrl, AdapterError } from './http.mjs';
import { P, applySpecs, whenOk, inputFlags } from '../cards/spec.mjs';
import { registerDialectCards } from '../cards/dialects.mjs';

const BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_TTS_FORMAT = 'mp3_44100_128';
const MUSIC_MIN_MS = 3000, MUSIC_MAX_MS = 600000;
const MAX_ARRAY_JSON = 8000;

const base = (provider) => String(provider.baseUrl || BASE_URL).replace(/\/+$/, '');
// v2 接口（音色搜索）与 v1 同主机同前缀：把末尾的 /v1 去掉再拼 /v2/…；地址里本来没有版本段的也照拼
const v2Url = (provider, path) => joinUrl(base(provider).replace(/\/v\d+$/, ''), 'v2/' + path);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clampMusicMs = (sec) => Math.min(MUSIC_MAX_MS, Math.max(MUSIC_MIN_MS, Math.round(Number(sec) * 1000)));
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const bad = (msg) => new AdapterError(msg, { status: 400 });
// 请求体合并顺序（简报）：卡上参数映射后的字段 → 服务级 params → 逐次 extra
const mergeBody = (mapped, provider, p) => ({ ...mapped, ...(provider.params || {}), ...(p.extra || {}) });

// 结果的 mime 按请求的输出格式定（文档：auto 对应 MP3）；认不出的格式才用服务回的 Content-Type
function mimeOf(format, contentType) {
  const f = String(format || '');
  if (f === 'auto' || f.startsWith('mp3_')) return 'audio/mpeg';
  if (f.startsWith('wav_')) return 'audio/wav';
  if (f.startsWith('opus_')) return 'audio/ogg';   // Ogg 封装的 Opus
  const pcm = /^pcm_(\d+)$/.exec(f);
  if (pcm) return `audio/L16;rate=${pcm[1]}`;   // 裸 PCM 带采样率：jobs 的 normalizeOutput 据此包成 WAV
  return String(contentType || '').split(';')[0].trim() || 'application/octet-stream';
}

// —— 模型卡 ——
// 输出格式：codec_采样率_码率。标签「MP3 44.1k · 128k」，套餐限制写在 hint（文档：MP3 192k 要 Creator，PCM / WAV 的 44.1k 要 Pro）
const CODEC = { mp3: 'MP3', opus: 'Opus', wav: 'WAV', pcm: 'PCM' };
const khz = (sr) => `${Number(sr) / 1000}k`;
function fmtOpt(v, hints = {}) {
  const [c, sr, br] = v.split('_');
  return { value: v, label: `${CODEC[c] || c.toUpperCase()} ${khz(sr)}${br ? ` · ${br}k` : ''}`, ...(hints[v] ? { hint: hints[v] } : {}) };
}
const TTS_HINTS = { mp3_44100_192: 'Creator', pcm_44100: 'Pro', wav_44100: 'Pro' };
const TTS_FORMAT_IDS = [
  'mp3_44100_128', 'mp3_44100_192', 'mp3_44100_96', 'mp3_44100_64', 'mp3_44100_32', 'mp3_24000_48', 'mp3_22050_32',
  'opus_48000_192', 'opus_48000_128', 'opus_48000_96', 'opus_48000_64', 'opus_48000_32',
  'wav_48000', 'wav_44100', 'wav_32000', 'wav_24000', 'wav_22050', 'wav_16000', 'wav_8000',
  'pcm_48000', 'pcm_44100', 'pcm_32000', 'pcm_24000', 'pcm_22050', 'pcm_16000', 'pcm_8000',
];
const TTS_FORMATS = TTS_FORMAT_IDS.map((v) => fmtOpt(v, TTS_HINTS));
const STEREO_OK = TTS_FORMAT_IDS.filter((v) => !v.startsWith('pcm_'));   // 音效可能出立体声：PCM 会被拒
const MUSIC_FORMAT_IDS = [
  'mp3_48000_320', 'mp3_48000_240', 'mp3_48000_192', 'mp3_48000_128', 'mp3_44100_192', 'mp3_44100_128', 'mp3_44100_96', 'mp3_44100_64',
  'mp3_44100_32', 'mp3_24000_48', 'mp3_22050_32',
  'opus_48000_192', 'opus_48000_128', 'opus_48000_96', 'opus_48000_64', 'opus_48000_32',
  'pcm_48000', 'pcm_44100', 'pcm_32000', 'pcm_24000', 'pcm_22050', 'pcm_16000', 'pcm_8000',
];
const MUSIC_FORMATS = [{ value: 'auto', label: '自动' }, ...MUSIC_FORMAT_IDS.map((v) => fmtOpt(v))];
const MP3_OUT = ['auto', ...MUSIC_FORMAT_IDS.filter((v) => v.startsWith('mp3_'))];
const NORMALIZE = [
  { value: 'auto', label: '自动' },
  { value: 'on', label: '总是做' },
  { value: 'off', label: '不做' },
];

// 音色设置（voice_settings 的各项）：按型号挑。默认值＝文档默认，只在「音色设置＝自定义」时出现并发送
const CUSTOM = { voiceSettings: 'custom' };
const VS = {
  stability: () => P.num('stability', '稳定度', 0, 1, { step: 0.05, default: 0.5, when: CUSTOM }),
  similarityBoost: () => P.num('similarityBoost', '相似度', 0, 1, { step: 0.05, default: 0.75, when: CUSTOM }),
  style: () => P.num('style', '风格强度', 0, 1, { step: 0.05, default: 0, when: CUSTOM, desc: '非 0 会变慢' }),
  speed: () => P.num('speed', '语速', 0.7, 1.2, { step: 0.05, default: 1, when: CUSTOM }),
  useSpeakerBoost: () => P.bool('useSpeakerBoost', '说话人增强', { default: true, when: CUSTOM }),
  cloneStrength: () => P.num('cloneStrength', '克隆强度', 0, 1, { step: 0.05, default: 0, when: CUSTOM, desc: '只对按 v4 精调的专业克隆音色生效' }),
};
const VS_FIELD = { stability: 'stability', similarityBoost: 'similarity_boost', style: 'style', speed: 'speed', useSpeakerBoost: 'use_speaker_boost', cloneStrength: 'clone_strength' };
// 音效（audio_effects）：平铺成六项，默认值＝文档默认；PCM 输出时隐藏
const FX = { when: { outputFormat: STEREO_OK } };
const FX_DEFAULT = { effectDistance: 0, effectSendLevel: 1, effectPan: 0 };
const FX_FIELD = { effectFilter: 'filter_preset_id', effectDistance: 'distance', effectEnvironment: 'environment_id', effectSendLevel: 'send_level', effectNoise: 'background_noise_id', effectPan: 'pan' };

/**
 * 配音卡。vs：这个型号能调的音色设置；lang：认不认 language_code。
 */
function speechCard(label, desc, { vs, lang = true }) {
  const params = [
    P.voice('voice', '音色', { default: DEFAULT_VOICE, desc: '下拉来自账号自己的音色和官方预置音色' }),
    ...(lang ? [P.text('languageCode', '语言代码', { max: 8, desc: 'ISO 639-1，如 zh、en' })] : []),
    P.enum('voiceSettings', '音色设置', [{ value: '', label: '用音色自带' }, { value: 'custom', label: '自定义' }], { group: 'advanced', default: '' }),
    ...vs.map((k) => VS[k]()),
    P.enum('outputFormat', '输出格式', TTS_FORMATS, { group: 'advanced', default: DEFAULT_TTS_FORMAT }),
    P.enum('applyTextNormalization', '数字与缩写', [{ value: '', label: '服务端默认' }, ...NORMALIZE], { group: 'advanced', default: '', desc: 'Flash v2.5 默认不做' }),
    P.seed({ desc: '尽量复现，不保证' }),
    P.text('previousText', '前文', { max: 2000, multiline: true, desc: '拼接多段时保持语气连贯' }),
    P.text('nextText', '后文', { max: 2000, multiline: true }),
    P.json('pronunciationDictionaryLocators', '发音词典', { array: true, desc: '[{ "pronunciation_dictionary_id": "…", "version_id": "…" }]，最多 3 个' }),
    P.bool('usePvcAsIvc', '专业克隆走快速版', { desc: '用专业克隆音色的快速克隆版本' }),
    P.text('effectFilter', '音效滤镜', { max: 64, ...FX, desc: '如 phone、old_radio' }),
    P.num('effectDistance', '距离', 0, 1, { step: 0.05, default: 0, ...FX }),
    P.text('effectEnvironment', '混响空间', { max: 64, ...FX, desc: '如 small_room、hall' }),
    P.num('effectSendLevel', '混响量', 0, 1, { step: 0.05, default: 1, ...FX }),
    P.text('effectNoise', '背景声', { max: 64, ...FX, desc: '如 cafe、keyboard' }),
    P.num('effectPan', '声像', -1, 1, { step: 0.05, default: 0, ...FX, desc: '-1 左，1 右' }),
    P.json(),
  ];
  return { kind: 'speech', async: false, label, desc, priceHint: '按字符计费', inputs: { text: true }, params, normalize: speechNormalize(params) };
}

// 发音词典：[{ pronunciation_dictionary_id, version_id? }]，最多 3 个（文档）
function parseLocators(v) {
  if (v === undefined || v === null || v === '') return undefined;
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { throw bad('发音词典不是合法 JSON'); } }
  if (!Array.isArray(a)) throw bad('发音词典要写成列表：[ … ]');
  if (JSON.stringify(a).length > MAX_ARRAY_JSON) throw bad('发音词典太长');
  if (!a.length) return undefined;
  if (a.length > 3) throw bad('发音词典最多 3 个');
  return a.map((x) => {
    if (!isObj(x) || typeof x.pronunciation_dictionary_id !== 'string' || !x.pronunciation_dictionary_id.trim()) throw bad('发音词典的每一项要有 pronunciation_dictionary_id');
    if (x.version_id != null && typeof x.version_id !== 'string') throw bad('发音词典的 version_id 要是字符串');
    return { pronunciation_dictionary_id: x.pronunciation_dictionary_id, ...(x.version_id ? { version_id: x.version_id } : {}) };
  });
}

/**
 * 配音卡的规范化：数组型 JSON（发音词典）自己解析（通用规范化只认对象）；种子 -1（界面的「随机」）当没给；
 * 旧接口 / Claude 媒体工具直接给了音色设置的数值、又没说「音色设置」的，当成自定义。其余照 ParamSpec。
 */
function speechNormalize(params) {
  return (raw = {}, ctx = {}) => {
    const r = { ...(raw && typeof raw === 'object' ? raw : {}) };
    const locators = r.pronunciationDictionaryLocators;
    delete r.pronunciationDictionaryLocators;
    if (r.seed === -1 || r.seed === '-1') delete r.seed;
    if (r.voiceSettings === undefined && Object.keys(VS_FIELD).some((k) => typeof r[k] === 'number' || typeof r[k] === 'boolean')) r.voiceSettings = 'custom';
    const out = applySpecs(params, r, ctx);
    const spec = params.find((s) => s.key === 'pronunciationDictionaryLocators');
    const list = spec ? parseLocators(locators) : undefined;
    if (list && whenOk(spec, { ...inputFlags(ctx), ...out })) out.pronunciationDictionaryLocators = list;
    return out;
  };
}

function musicCard(label, desc) {
  const params = [
    // 界面对数字总会发一个值（没有默认就发下限）：「模型定时长」开着时不发时长（＝文档的「不给就由模型决定」）
    P.bool('autoDuration', '模型定时长', { group: 'basic', default: true }),
    P.num('durationSeconds', '时长', 3, 300, { group: 'basic', step: 1, integer: true, default: 30, format: 'duration', unit: 's', when: { autoDuration: false }, desc: '用分段计划时不生效' }),
    P.bool('forceInstrumental', '纯音乐', { group: 'basic', default: false, desc: '用分段计划时不生效' }),
    P.enum('outputFormat', '输出格式', MUSIC_FORMATS, { group: 'advanced', default: 'auto' }),
    P.json('compositionPlan', '分段计划', { desc: '{ "chunks": [{ "text", "duration_ms", "positive_styles" }] }；给了就不发提示词、时长、纯音乐' }),
    P.seed({ max: 2147483647, desc: '只配分段计划' }),
    P.bool('signWithC2pa', 'C2PA 签名', { when: { outputFormat: MP3_OUT } }),
    P.bool('storeForInpainting', '留作局部重写'),
    P.text('finetuneId', '精调模型', { max: 100 }),
    P.json(),
  ];
  return {
    kind: 'music', async: true, label, desc, inputs: { text: true }, params,
    normalize(raw = {}, ctx = {}) {
      const r = { ...(raw && typeof raw === 'object' ? raw : {}) };
      if (r.seed === -1 || r.seed === '-1') delete r.seed;
      // 旧接口 / Claude 媒体工具只给时长、没说「模型定时长」：按给的时长出
      if (r.autoDuration === undefined && r.durationSeconds !== undefined && r.durationSeconds !== null && r.durationSeconds !== '') r.autoDuration = false;
      return applySpecs(params, r, ctx);
    },
  };
}

const V4 = ['stability', 'similarityBoost', 'cloneStrength'];
const V3 = ['stability', 'style'];
const V2 = ['stability', 'similarityBoost', 'style', 'speed', 'useSpeakerBoost'];
// 内置常见模型：设置页「添加常见模型」和拉不到列表时的兜底；卡的 kind 就是它的种类
export const CARDS = {
  eleven_v4: speechCard('Eleven v4', '旗舰，单次约 1 万字符，90 多种语言', { vs: V4 }),
  eleven_v4_turbo: speechCard('Eleven v4 Turbo', '低延迟（约 100 毫秒），支持语气标签，90 多种语言', { vs: V4 }),
  eleven_flash_v2_5: speechCard('Eleven Flash v2.5', '快速、单价低，单次约 4 万字符，32 种语言', { vs: V2 }),
  eleven_v3: speechCard('Eleven v3', '上一代表现力型号，单次约 5000 字符，70 多种语言', { vs: V3 }),
  eleven_multilingual_v2: speechCard('Eleven Multilingual v2', 'API 默认型号，长文本最稳，29 种语言', { vs: V2, lang: false }),
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

// 音色设置：只在「自定义」时带（通用卡没有这个开关：给了哪项带哪项）
function voiceSettingsOf(p) {
  const vs = {};
  for (const [k, field] of Object.entries(VS_FIELD)) if (p[k] !== undefined) vs[field] = p[k];
  return vs;
}
// 音效：等于文档默认、又没填任何 id 时整组不发
function audioEffectsOf(p) {
  const fx = {};
  let any = false;
  for (const [k, field] of Object.entries(FX_FIELD)) {
    const v = p[k];
    if (v === undefined || v === null || v === '') continue;
    fx[field] = v;
    if (!(k in FX_DEFAULT) || v !== FX_DEFAULT[k]) any = true;
  }
  return any ? fx : null;
}

// —— 生成：配音与音乐都是同步请求，回的就是音频二进制 ——
async function runSpeech(req, provider, ctx, common) {
  const p = req.params || {};
  if (!String(req.prompt || '').trim()) throw new AdapterError('要配音的文字是空的');
  const vs = voiceSettingsOf(p);
  const fx = audioEffectsOf(p);
  const body = mergeBody({
    text: req.prompt,
    model_id: req.model,
    ...(Object.keys(vs).length ? { voice_settings: vs } : {}),
    ...(p.languageCode ? { language_code: p.languageCode } : {}),
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(p.applyTextNormalization ? { apply_text_normalization: p.applyTextNormalization } : {}),
    ...(p.previousText ? { previous_text: p.previousText } : {}),
    ...(p.nextText ? { next_text: p.nextText } : {}),
    ...(Array.isArray(p.pronunciationDictionaryLocators) && p.pronunciationDictionaryLocators.length ? { pronunciation_dictionary_locators: p.pronunciationDictionaryLocators } : {}),
    ...(p.usePvcAsIvc === true ? { use_pvc_as_ivc: true } : {}),
    ...(fx ? { audio_effects: fx } : {}),
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
  const plan = isObj(p.compositionPlan) ? p.compositionPlan : undefined;
  const body = mergeBody({
    ...(String(req.prompt || '').trim() ? { prompt: req.prompt } : {}),
    ...(p.durationSeconds !== undefined ? { music_length_ms: clampMusicMs(p.durationSeconds) } : {}),
    ...(p.forceInstrumental !== undefined ? { force_instrumental: p.forceInstrumental } : {}),
    model_id: req.model,   // 总是显式带：省略时 API 默认 music_v1（已弃用）
    ...(plan ? { composition_plan: plan } : {}),
    ...(p.signWithC2pa === true ? { sign_with_c2pa: true } : {}),
    ...(p.storeForInpainting === true ? { store_for_inpainting: true } : {}),
    ...(p.finetuneId ? { finetune_id: p.finetuneId } : {}),
  }, provider, p);
  // composition_plan 与 prompt 不能同用（文档）：给了分段计划，就去掉 prompt 以及只跟 prompt 有关的字段；种子只配分段计划
  if (body.composition_plan) {
    delete body.prompt; delete body.music_length_ms; delete body.force_instrumental;
    if (p.seed !== undefined && body.seed === undefined) body.seed = p.seed;
  }
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
