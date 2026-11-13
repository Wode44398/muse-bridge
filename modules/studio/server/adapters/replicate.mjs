// replicate 方言（方案 §4）：Replicate 的 predictions API。提交后轮询到完成，再把结果下载回来。
//
// 查证（2026-11-04，未真打——没有 Key；接口形状来自官方文档与模型页内嵌的 schema）：
//   HTTP 参考：https://replicate.com/docs/reference/http
//   预测：https://replicate.com/docs/topics/predictions/{create-a-prediction,lifecycle,output-files,input-files}
//   官方集合：https://replicate.com/collections/{text-to-image,text-to-video,text-to-speech,ai-music-generation}
//   模型卡字段：https://replicate.com/<owner>/<name>/api 页面内嵌的 version JSON（_extras.dereferenced_openapi_schema），
//     卡上每个字段的名字、枚举、默认值、范围都照它写。
// 关键事实：
//   · 基址 https://api.replicate.com/v1；鉴权 `Authorization: Bearer <token>`（个别示例写 Token，按 Bearer）。
//   · 官方模型：POST /models/{owner}/{name}/predictions，body { input }。
//     带版本：POST /predictions，body { version, input }；version 写 owner/name:版本号，或 64 位裸版本号。
//     文档：owner/name 直连只给官方模型，社区模型要带版本。
//   · Prefer: wait=N（文档 1–60 秒）：这里不用——挂着等的那段时间里预测已经在跑，取消 / 断线会被误当成「没发出去」。
//   · Cancel-After：5 秒到 24 小时（整数秒，或 s / m / h 后缀），到点服务端自动取消。这里设成服务超时，
//     兜底「我们这边断了、服务方还在跑」的计费。
//   · 预测对象：{ id, status, output, error, logs, metrics: { predict_time }, urls: { get, cancel } }。
//     status：starting / processing（进行中）；succeeded / failed / canceled / aborted（终态；aborted = 没开始就过了截止时间）。
//   · 取消：POST /predictions/{id}/cancel（即 urls.cancel）。
//   · 输出：形状因模型而异。模型页 schema 里既有单个字符串（如 flux-2-pro、veo-3.1），也有 URL 数组（如 flux-schnell）；
//     这里都抹平（递归收集 URL）。文件在 replicate.delivery，下载要带 Authorization（HTTP 参考页）；
//     API 创建的预测，输出文件 1 小时后删除，所以成功后立刻下载。
//   · 素材：data URI（输入文件页：建议小于 1MB，非硬上限）或 HTTP URL。
//   · 限速：创建预测 600 次/分钟，其它接口 3000 次/分钟，超了返回 429。
//   · 账户 GET /account（零成本，test 只调它）；模型 GET /models/{owner}/{name}（HTTP 参考页：schema 在
//     latest_version.openapi_schema 里）；集合 GET /collections/{slug}（models 数组）。
// 文档未写明、这里的处理：
//   · latest_version.id：HTTP 参考页只写了 latest_version 这个字段，id 取自网页版本对象（version.id）。
//   · 社区模型用 owner/name 直连时的报错码：按 404 / 422 兜底，改查 latest_version.id，再用 version 提交。
//   · 日志格式：取日志里最后一个「NN%」当进度；解析不出就只报经过时间。
//   · 集合里 models 数组的对象字段：兼容 owner + name、网页地址、id 三种写法。
//   · 账户接口 type 字段的取值：只展示 username。
//   · 取消接口的响应体：忽略。
//   · 素材的 MIME：用素材自带的 mime；文件上传接口：文档未写，只发 data URI。
//   · 输出文件的鉴权：只把鉴权头发给 replicate.delivery 与服务自己的域名，模型返回的外链拿不到 Key。

import { http, authHeaders, joinUrl, download, guessMime, dataUrl, poll, AdapterError } from './http.mjs';
import { P, opts, genericCard } from '../cards/spec.mjs';
import { registerDialectCards, dialectCards } from '../cards/dialects.mjs';

const DEFAULT_TIMEOUT_SEC = 600;
const POLL_MS = 4000;
const FAILED = new Set(['failed', 'canceled', 'aborted']);
const ID_RE = /^[A-Za-z0-9][\w.-]*$/;    // owner / name / 版本号 / 预测 id：挡掉 .. 和斜杠这类路径字符
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|opus|m4a|aac|pcm)(\?|$)/i;
const MEDIA_EXT = { image: /\.(png|jpe?g|webp|gif|avif)(\?|$)/i, video: /\.(mp4|webm|mov)(\?|$)/i, speech: AUDIO_EXT, music: AUDIO_EXT };
// 官方集合的 slug → 种类（https://replicate.com/collections 上核对过）
const COLLECTIONS = [['text-to-image', 'image'], ['text-to-video', 'video'], ['text-to-speech', 'speech'], ['ai-music-generation', 'music']];
const ROLE_NAME = { edit: '改图', ref: '参考图', first: '首帧', last: '尾帧', video: '参考视频', audio: '参考音频' };
const GEMINI_VOICES = ['Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina',
  'Enceladus', 'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Pulcherrima', 'Puck', 'Rasalgethi',
  'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'];

const baseOf = (provider) => {
  if (!provider.baseUrl) throw new AdapterError('还没填接口地址');
  return provider.baseUrl;
};

// 模型 id：owner/name（官方模型直连）、owner/name:版本号、或 64 位裸版本号
function parseModel(id) {
  const s = String(id || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return { base: '', version: s };
  const colon = s.indexOf(':');
  const base = colon >= 0 ? s.slice(0, colon) : s;
  const ver = colon >= 0 ? s.slice(colon + 1) : '';
  const parts = base.split('/');
  const ok = parts.length === 2 && ID_RE.test(parts[0]) && ID_RE.test(parts[1]) && (colon < 0 || ID_RE.test(ver));
  if (!ok) throw new AdapterError(`模型 id 不对：「${s}」（要写成 owner/name，或 owner/name:版本号）`, { status: 400 });
  return { owner: parts[0], name: parts[1], base, version: colon >= 0 ? s : '' };
}

function sameOrigin(u, base) {
  try { return new URL(u).origin === new URL(base).origin; } catch { return false; }
}
// 服务方给的 urls.get / urls.cancel 只认和接口地址同源的，外来地址不许拿到鉴权头
const ownUrl = (u, base) => (typeof u === 'string' && sameOrigin(u, base) ? u : '');
// 输出文件：replicate.delivery 与服务自己的域名才带鉴权头（HTTP 参考页：下载输出要 Authorization）
const isOwnFile = (u, base) => /^https:\/\/([\w-]+\.)*replicate\.delivery\//i.test(u) || sameOrigin(u, base);

// 集合里的模型对象：文档没列字段，兼容 owner + name、网页地址、id 三种写法
function modelIdOf(m) {
  if (!m || typeof m !== 'object') return '';
  let id = '';
  if (m.owner && m.name) id = `${m.owner}/${m.name}`;
  else if (typeof m.url === 'string' && /^https?:\/\/replicate\.com\/[^/]+\/[^/]+\/?$/.test(m.url)) {
    id = new URL(m.url).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  } else if (typeof m.id === 'string' && m.id.includes('/')) id = m.id.split(':')[0];
  try { return parseModel(id).base || ''; } catch { return ''; }
}

// 模型 schema 里的 $ref / 单元素 allOf 展开（只为拿到枚举）
function deref(node, cs, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return node || {};
  if (typeof node.$ref === 'string') return deref(cs[node.$ref.split('/').pop()], cs, depth + 1);
  if (Array.isArray(node.allOf) && node.allOf.length === 1) {
    const { allOf, ...rest } = node;
    return deref({ ...deref(allOf[0], cs, depth + 1), ...rest }, cs, depth + 1);
  }
  return node;
}

// 输出可能是字符串、URL 数组或对象：递归收集所有 http(s) 与 data: 地址
function collectUrls(v, out = [], depth = 0) {
  if (depth > 6 || v == null) return out;
  if (typeof v === 'string') { if (/^(https?:\/\/|data:)/.test(v)) out.push(v); }
  else if (Array.isArray(v)) for (const x of v) collectUrls(x, out, depth + 1);
  else if (typeof v === 'object') for (const x of Object.values(v)) collectUrls(x, out, depth + 1);
  return out;
}

// 按种类挑媒体地址：有对应后缀的优先（对象里同时有音频和字幕文件时只要音频），没有后缀就全要
function mediaUrls(output, kind) {
  const all = collectUrls(output);
  const re = MEDIA_EXT[kind];
  const typed = all.filter((u) => u.startsWith('data:') || (re && re.test(u)));
  return typed.length ? typed : all;
}

// 日志里最后一个「NN%」当进度（tqdm 之类的进度条）；文档未写日志格式，解析不出就返回 undefined
function logProgress(logs) {
  const m = [...String(logs || '').matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)];
  if (!m.length) return undefined;
  const v = Number(m[m.length - 1][1]);
  return v >= 0 && v <= 100 ? v / 100 : undefined;
}

function failText(p) {
  if (p.status === 'canceled') return '服务方取消了这个任务（可能超过了截止时间）';
  if (p.status === 'aborted') return '超过截止时间，任务还没开始就被放弃了';
  const e = p.error;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') return JSON.stringify(e).slice(0, 300);
  return '服务方没给原因';
}

// 请求体的 input：卡上的参数、正文、素材（provider.params 与逐次 extra 在 run 里再合并）
function buildInput(req, card) {
  const generic = !!card.generic;
  const wire = card.wire || {};
  const body = {};
  for (const [k, v] of Object.entries(req.params || {})) {
    if (k === 'extra' || v === undefined || v === null) continue;
    if (!generic) body[k] = v;
    else if (k === 'aspectRatio') { if (v !== 'auto') body.aspect_ratio = v; }   // 通用卡的「自动」不是 Replicate 的值，不传
    else if (k === 'durationSeconds') body.duration = v;
    else body[k] = v;
  }
  // 正文：卡上指定的字段（语音 text、MiniMax 音乐 lyrics）；没指定就是 prompt
  const textField = generic ? (req.kind === 'speech' ? 'text' : 'prompt') : (wire.text || 'prompt');
  if (req.prompt) body[textField] = req.prompt;
  // 负面提示词：卡上 inputs.negative 为真才有
  if (req.negative && card.inputs?.negative) body[wire.negative || 'negative_prompt'] = req.negative;
  // 素材：角色 → 字段（卡上写死）。没给素材、续改链上有一张图的，拿这张当改图参考（只给能改图的卡）
  let inputs = Array.isArray(req.inputs) ? req.inputs : [];
  const turns = req.thread?.turns || [];
  const last = turns[turns.length - 1];
  if (!inputs.length && req.kind === 'image' && last?.data && (generic || wire.images?.edit)) {
    inputs = [{ role: 'edit', data: last.data, mime: last.mime }];
  }
  for (const x of inputs) {
    const uri = dataUrl(x.data, x.mime);
    if (generic) {
      // 未知模型：第一张放 image（首帧 / 改图），其余放 images 数组（猜的，不对就用 extra 改）
      if (body.image === undefined) body.image = uri;
      else (body.images ||= []).push(uri);
      continue;
    }
    // 参考视频 / 音频（schema 卡，§9.3 inputs.video / audio）走 wire.video / wire.audio
    const spec = x.role === 'video' ? wire.video : x.role === 'audio' ? wire.audio : wire.images?.[x.role];
    if (!spec) throw new AdapterError(`这个模型不收「${ROLE_NAME[x.role] || x.role}」素材`, { status: 400 });
    if (spec.list) (body[spec.field] ||= []).push(uri);
    else body[spec.field] = uri;
  }
  return body;
}

export const replicateAdapter = {
  dialect: 'replicate',
  kinds: ['image', 'video', 'speech', 'music'],

  // GET /account：账户信息，零成本，不生成任何东西。401 / 403 → Key 无效
  async test(provider, { secret, dispatcher }) {
    if (!secret?.key) throw new AdapterError('还没填 API Key');
    let j;
    try {
      j = await http(joinUrl(baseOf(provider), 'account'), { headers: authHeaders(provider, secret.key), timeoutMs: 30_000, dispatcher, label: 'Replicate' });
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new AdapterError('API Key 无效或没权限（Replicate 拒绝了这个 Key）', { status: e.status, detail: e.detail });
      throw e;
    }
    return { detail: `已连上 Replicate，账号 ${j?.username || '（没返回用户名）'}` };
  },

  // 官方集合（图像 / 视频 / 配音 / 音乐）→ 模型列表，kind 按集合定，同一个模型只列一次
  async listModels(provider, { secret, dispatcher }) {
    const headers = authHeaders(provider, secret?.key);
    const seen = new Map();
    let ok = 0;
    let firstErr = null;
    for (const [slug, kind] of COLLECTIONS) {
      // 单个集合拉不到不影响其余：全部失败才把错误抛出去
      try {
        const j = await http(joinUrl(baseOf(provider), `collections/${slug}`), { headers, timeoutMs: 30_000, dispatcher, label: 'Replicate' });
        ok++;
        for (const m of j?.models || []) {
          const id = modelIdOf(m);
          if (id && !seen.has(id)) seen.set(id, { id, label: id, kind });
        }
      } catch (e) { firstErr ||= e; }
    }
    if (!ok && firstErr) throw firstErr;
    return [...seen.values()];
  },

  // 配音音色：模型 schema 里有 voice 相关的枚举就用它（能拉就拉）；拉不到就用卡上的内置表
  async voices(provider, { secret, dispatcher }, modelId) {
    const m = parseModel(modelId);
    let list = [];
    if (m.owner) {
      try {
        const j = await http(joinUrl(baseOf(provider), `models/${m.owner}/${m.name}`), { headers: authHeaders(provider, secret?.key), timeoutMs: 30_000, dispatcher, label: 'Replicate' });
        const cs = j?.latest_version?.openapi_schema?.components?.schemas || {};
        const props = deref(cs.Input, cs).properties || {};
        for (const [k, raw] of Object.entries(props)) {
          const v = deref(raw, cs);
          if (/voice/i.test(k) && Array.isArray(v.enum) && v.enum.length) {
            list = v.enum.map((x) => ({ id: String(x), label: String(x) }));
            break;
          }
        }
      } catch { /* 拉不到就用卡上的内置表 */ }
    }
    if (!list.length) {
      const card = dialectCards('replicate', m.base || modelId);
      const vp = (card?.params || []).find((s) => s.type === 'voice');
      list = (vp?.options || []).map((o) => ({ id: o.value, label: o.label, ...(o.note ? { note: o.note } : {}) }));
    }
    return list;
  },

  async run(req, provider, ctx) {
    const key = ctx.secret?.key;
    if (!key) throw new AdapterError('这个服务还没填 API Key');
    const base = baseOf(provider);
    const m = parseModel(req.model);
    const card = req.card || dialectCards('replicate', m.base) || genericCard('replicate', req.kind);
    const timeoutSec = Number(provider.timeoutSec) || DEFAULT_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;   // 单个请求的超时
    // 整个任务的等待上限：视频 / 音乐排队加生成常超过 10 分钟，至少给 30 分钟（契约复核 11-04）；Cancel-After 同口径
    const jobSec = req.kind === 'video' || req.kind === 'music' ? Math.max(1800, timeoutSec) : timeoutSec;
    const { signal, dispatcher } = ctx;
    const headers = authHeaders(provider, key);
    const api = (url, o = {}) => http(url, { headers, timeoutMs, signal, dispatcher, label: 'Replicate', ...o });

    // 请求体合并顺序：卡上参数 → provider.params（服务级额外请求体）→ 逐次 extra
    const body = { ...buildInput(req, card), ...(provider.params || {}), ...(req.params?.extra || {}) };
    // 不带 Prefer: wait——连接挂着等的那几十秒里预测已经在跑，那时取消 / 断线会被当成「没发出去」（取消不调接口、
    // 断线还可能重发 = 扣两次钱）。立即拿到 id、标 submitted，再轮询（契约复核 11-04）。
    const submitHeaders = {
      ...headers,
      // 服务方到点自动取消：就算我们这边断了（进程重启、连接丢了）它也不会一直跑下去
      'Cancel-After': `${Math.min(86400, Math.max(5, Math.round(jobSec)))}s`,
    };

    // 1. 提交：带版本（owner/name:版本号 或裸版本号）走 /predictions；只有 owner/name 走官方模型直连路径
    const submit = (url, payload) => api(url, { method: 'POST', body: payload, headers: submitHeaders });
    let pred;
    if (m.version) {
      pred = await submit(joinUrl(base, 'predictions'), { version: m.version, input: body });
    } else {
      try {
        pred = await submit(joinUrl(base, `models/${m.owner}/${m.name}/predictions`), { input: body });
      } catch (e) {
        // 社区模型不能用 owner/name 直连（文档：只有官方模型可以，报错码文档未写）：404 时查最新版本号，再用 version 提交
        //（422 是参数校验错，照原话报，不白白重发）
        if (signal?.aborted || e.status !== 404) throw e;
        const latest = await api(joinUrl(base, `models/${m.owner}/${m.name}`)).catch(() => null);
        const ver = latest?.latest_version?.id;
        if (!ver) throw e;
        pred = await submit(joinUrl(base, 'predictions'), { version: ver, input: body });
      }
    }
    if (!pred || typeof pred !== 'object' || !ID_RE.test(String(pred.id || ''))) throw new AdapterError('服务方没有返回任务 id');
    ctx.submitted?.();   // 已经发出去了，收不回来了
    const pollUrl = ownUrl(pred.urls?.get, base) || joinUrl(base, `predictions/${pred.id}`);
    const cancelUrl = ownUrl(pred.urls?.cancel, base) || joinUrl(base, `predictions/${pred.id}/cancel`);

    // 2. 轮询到终态。第一次查询直接用提交时的返回（极快的模型提交时可能就已经完成了）
    let first = pred;
    let fails = 0;
    let note = pred.status === 'starting' ? '排队 / 启动中' : undefined;
    const check = async () => {
      let cur = first;
      first = null;
      if (!cur) {
        try {
          cur = await api(pollUrl);
          fails = 0;
        } catch (e) {
          // 偶发的网络错误 / 5xx / 429：不立刻判失败，连续 5 次才放弃
          const transient = !e.status || e.status >= 500 || e.status === 429;
          if (signal?.aborted || !transient || ++fails > 5) throw e;
          note = '网络不稳，重试中';
          return { done: false };
        }
      }
      if (cur?.status === 'succeeded') return { done: true, value: cur };
      if (FAILED.has(cur?.status)) return { failed: true, error: failText(cur), value: cur };
      note = cur?.status === 'starting' ? '排队 / 启动中' : undefined;
      return { done: false, progress: logProgress(cur?.logs) };
    };
    let done;
    try {
      done = await poll(check, {
        intervalMs: Number(ctx.pollMs) > 0 ? Number(ctx.pollMs) : POLL_MS,
        timeoutMs: jobSec * 1000,
        signal,
        label: '生成',
        onTick: ({ elapsed, progress }) => ctx.progress?.({
          elapsed,
          ...(progress !== undefined ? { progress } : {}),
          ...(note ? { note } : {}),
        }),
      });
    } catch (e) {
      // 用户取消 / 等超时：尽力通知服务方停掉，免得继续计费（取消失败忽略，Cancel-After 兜底）。
      // 这里不带 signal——它已经 abort 了，带上只会让取消请求也立刻失败
      if (signal?.aborted || e?.code === 'timeout') {
        await api(cancelUrl, { method: 'POST', signal: undefined, timeoutMs: 15_000 }).catch(() => {});
      }
      throw e;
    }

    // 3. 下载结果：输出文件 1 小时后删除，所以马上取
    const urls = mediaUrls(done.output, req.kind);
    if (!urls.length) throw new AdapterError('服务方返回的结果里没有媒体地址');
    const meta = {
      predictionId: pred.id,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(done.metrics?.predict_time != null ? { predictSeconds: done.metrics.predict_time } : {}),
    };
    const assets = [];
    for (const u of urls) {
      const r = await download(u, { headers: isOwnFile(u, base) ? headers : {}, timeoutMs, signal, dispatcher, label: '下载结果' });
      const mime = r.mime && r.mime !== 'application/octet-stream' ? r.mime : guessMime(u);
      assets.push({ bytes: r.bytes, mime, meta: { ...meta } });
    }
    return { assets };
  },
};

// —— 模型卡 ——
// 卡上的字段名就是 Replicate 的 input 字段名（参数直接进请求体）。wire 只写「正文 / 负面提示词 / 素材」去哪个字段：
//   wire.text      正文字段（默认 prompt；语音是 text，MiniMax 音乐是 lyrics）
//   wire.negative  负面提示词字段（默认 negative_prompt；卡上 inputs.negative 为真才用）
//   wire.images    素材角色 → { field, list? }：list 为真时字段是数组（多张），否则是单个 data URI
// 每张卡都是官方模型（页面标 Official，可以用 owner/name 直连），2026-11-04 核过 input schema；字段名、枚举、默认值照 schema 写。
// 价格没有核（文档与页面的计价口径不统一），所以卡上不写 priceHint。

// MiniMax 语音：voice_id 是自由字符串（schema 没有枚举，文档只给了两个示例音色）
function minimaxSpeechParams() {
  return [
    P.voice('voice_id', '音色', {
      default: 'English_Wiselady',
      options: [
        { value: 'English_Wiselady', label: 'English_Wiselady', note: '文档示例' },
        { value: 'English_Deep-VoicedGentleman', label: 'English_Deep-VoicedGentleman', note: '文档示例' },
      ],
    }),
    P.enum('emotion', '情绪', opts(['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'neutral']), { group: 'basic', default: 'auto' }),
    P.num('speed', '语速', 0.5, 2, { group: 'basic', step: 0.05, default: 1 }),
    P.num('pitch', '音调（半音）', -12, 12, { step: 1, integer: true, default: 0 }),
    P.num('volume', '音量', 0, 10, { step: 0.1, default: 1 }),
    P.enum('audio_format', '格式', opts(['mp3', 'wav', 'flac']), { default: 'mp3' }),   // pcm 不给：裸 PCM 没有采样率信息，包 WAV 会变调
    P.enum('sample_rate', '采样率', opts([8000, 16000, 22050, 24000, 32000, 44100]), { default: 32000 }),
    P.enum('bitrate', '码率（仅 mp3）', opts([32000, 64000, 128000, 256000]), { default: 128000 }),
    P.text('language_boost', '语种提示', { default: 'None', desc: 'None / Automatic / Chinese / English 等' }),
    P.bool('english_normalization', '英文数字朗读优化', { default: false }),
    P.json(),
  ];
}

export const CARDS = {
  // —— 图像 ——
  'black-forest-labs/flux-schnell': {
    kind: 'image', label: 'FLUX.1 [schnell]', desc: '最快的 FLUX，适合试错和出草图；一次可出 1–4 张', async: true,
    inputs: { text: true },
    params: [
      P.enum('aspect_ratio', '比例', opts(['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']), { group: 'basic', default: '1:1' }),
      P.num('num_outputs', '张数', 1, 4, { group: 'basic', step: 1, integer: true, default: 1 }),
      P.enum('megapixels', '像素（百万）', opts(['1', '0.25']), { default: '1' }),
      P.num('num_inference_steps', '采样步数', 1, 4, { step: 1, integer: true, default: 4, desc: '官方推荐 4' }),
      P.bool('go_fast', '加速档', { default: true }),
      P.enum('output_format', '格式', opts(['webp', 'jpg', 'png']), { default: 'webp' }),
      P.num('output_quality', '质量', 0, 100, { step: 1, integer: true, default: 80 }),
      P.seed(),
      P.bool('disable_safety_checker', '关闭安全检查', { default: false }),
      P.json(),
    ],
  },
  'black-forest-labs/flux-2-pro': {
    kind: 'image', label: 'FLUX.2 [pro]', desc: '高质量文生图与改图，最多 8 张参考图（jpeg / png / gif / webp）', async: true,
    inputs: { text: true, images: { max: 8, roles: ['edit', 'ref'] }, multiTurn: false },
    wire: { images: { edit: { field: 'input_images', list: true }, ref: { field: 'input_images', list: true } } },
    params: [
      P.enum('aspect_ratio', '比例', opts(['1:1', '16:9', '3:2', '2:3', '4:5', '5:4', '9:16', '3:4', '4:3', 'match_input_image', 'custom']), { group: 'basic', default: '1:1', desc: 'match_input_image 跟随第一张参考图' }),
      P.num('width', '宽', 256, 2048, { step: 16, integer: true, when: { aspect_ratio: 'custom' }, desc: '16 的倍数（不是会自动取整）' }),
      P.num('height', '高', 256, 2048, { step: 16, integer: true, when: { aspect_ratio: 'custom' }, desc: '16 的倍数（不是会自动取整）' }),
      P.enum('resolution', '分辨率（百万像素）', opts(['match_input_image', '0.5 MP', '1 MP', '2 MP', '4 MP']), { group: 'basic', default: '1 MP', desc: '2 MP 以内推荐；custom 比例下不生效' }),
      P.enum('output_format', '格式', opts(['webp', 'jpg', 'png']), { default: 'webp' }),
      P.num('output_quality', '质量', 0, 100, { step: 1, integer: true, default: 80 }),
      P.num('safety_tolerance', '安全容忍度', 1, 5, { step: 1, integer: true, default: 2, desc: '1 最严，5 最宽' }),
      P.seed(),
      P.json(),
    ],
  },
  'google/imagen-4': {
    kind: 'image', label: 'Imagen 4', desc: 'Google 旗舰文生图', async: true,
    inputs: { text: true },
    params: [
      P.enum('aspect_ratio', '比例', opts(['1:1', '9:16', '16:9', '3:4', '4:3']), { group: 'basic', default: '1:1' }),
      P.enum('image_size', '尺寸', opts(['1K', '2K']), { group: 'basic', default: '1K' }),
      P.enum('output_format', '格式', opts(['jpg', 'png']), { default: 'jpg' }),
      P.enum('safety_filter_level', '安全过滤', [
        { value: 'block_low_and_above', label: '最严' },
        { value: 'block_medium_and_above', label: '中等' },
        { value: 'block_only_high', label: '只拦高风险' },
      ], { default: 'block_only_high' }),
      P.json(),
    ],
  },
  'google/nano-banana-2': {
    kind: 'image', label: 'Nano Banana 2', desc: 'Google 快速生图 + 对话式改图，多图融合，最多 14 张参考图', async: true,
    inputs: { text: true, images: { max: 14, roles: ['edit', 'ref'] }, multiTurn: false },
    wire: { images: { edit: { field: 'image_input', list: true }, ref: { field: 'image_input', list: true } } },
    params: [
      P.enum('aspect_ratio', '比例', opts(['match_input_image', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']), { group: 'basic', default: 'match_input_image' }),
      P.enum('resolution', '分辨率', opts(['1K', '2K', '4K']), { group: 'basic', default: '1K', desc: '分辨率越高越慢' }),
      P.enum('output_format', '格式', opts(['jpg', 'png']), { default: 'jpg' }),
      P.bool('google_search', '联网搜索', { default: false, desc: '用实时信息生图（天气、比分、近期事件）' }),
      P.bool('image_search', '图片搜索', { default: false, desc: '先搜网页图片当视觉参考（含联网搜索）' }),
      P.json(),
    ],
  },

  // —— 视频 ——
  'google/veo-3.1': {
    kind: 'video', label: 'Veo 3.1', desc: '原生音轨与对白。参考图模式只认 16:9 + 8 秒，且忽略尾帧', async: true,
    inputs: { text: true, images: { max: 3, roles: ['first', 'last', 'ref'] }, negative: true },
    wire: { images: { first: { field: 'image' }, last: { field: 'last_frame' }, ref: { field: 'reference_images', list: true } } },
    params: [
      P.enum('aspect_ratio', '比例', opts(['16:9', '9:16']), { group: 'basic', default: '16:9' }),
      P.enum('duration', '时长', [{ value: 4, label: '4 秒' }, { value: 6, label: '6 秒' }, { value: 8, label: '8 秒' }], { group: 'basic', default: 8 }),
      P.enum('resolution', '分辨率', opts(['720p', '1080p']), { default: '1080p' }),
      P.bool('generate_audio', '生成音频', { group: 'basic', default: true }),
      P.seed(),
      P.json(),
    ],
  },
  // 首帧 / 尾帧：schema 写明 jpg / png、最大 10MB、最小 300px（素材不做预检，超了由服务方原话报错）
  'kwaivgi/kling-v3-video': {
    kind: 'video', label: 'Kling V3', desc: '首帧 / 尾帧生视频，可带原生音频；画质档 standard / pro / 4k', async: true,
    inputs: { text: true, images: { max: 2, roles: ['first', 'last'] }, negative: true },
    wire: { images: { first: { field: 'start_image' }, last: { field: 'end_image' } } },   // 尾帧必须和首帧一起给（文档）
    params: [
      P.enum('aspect_ratio', '比例', opts(['16:9', '9:16', '1:1']), { group: 'basic', default: '16:9', desc: '带首帧图时忽略，跟随首帧' }),
      P.num('duration', '时长（秒）', 3, 15, { group: 'basic', step: 1, integer: true, default: 5 }),
      P.enum('mode', '画质档', [{ value: 'standard', label: '标准 720p' }, { value: 'pro', label: '专业 1080p' }, { value: '4k', label: '4K' }], { default: 'pro' }),
      P.bool('generate_audio', '生成音频', { group: 'basic', default: false }),
      P.json(),
    ],
  },
  'minimax/hailuo-2.3': {
    kind: 'video', label: 'Hailuo 2.3', desc: '首帧图生视频（比例跟首帧图走）；1080p 只出 6 秒', async: true,
    inputs: { text: true, images: { max: 1, roles: ['first'] } },
    wire: { images: { first: { field: 'first_frame_image' } } },
    params: [
      P.enum('resolution', '分辨率', opts(['768p', '1080p']), { group: 'basic', default: '768p' }),
      P.enum('duration', '时长', [{ value: 6, label: '6 秒' }, { value: 10, label: '10 秒（仅 768p）' }], { group: 'basic', default: 6 }),
      P.bool('prompt_optimizer', '提示词优化', { default: true }),
      P.json(),
    ],
  },
  'bytedance/seedance-2.0': {
    kind: 'video', label: 'Seedance 2.0', desc: '首尾帧，或最多 9 张参考图（参考图与首尾帧不能同用）；可带音频', async: true,
    inputs: { text: true, images: { max: 9, roles: ['first', 'last', 'ref'] } },
    wire: { images: { first: { field: 'image' }, last: { field: 'last_frame_image' }, ref: { field: 'reference_images', list: true } } },
    params: [
      P.enum('aspect_ratio', '比例', opts(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', '9:21', 'adaptive']), { group: 'basic', default: '16:9', desc: 'adaptive 由模型按素材选' }),
      P.num('duration', '时长（秒）', -1, 15, { group: 'basic', step: 1, integer: true, default: 5, desc: '-1 = 模型自己定时长' }),
      P.enum('resolution', '分辨率', opts(['480p', '720p', '1080p', '4k']), { default: '720p' }),
      P.bool('generate_audio', '生成音频', { group: 'basic', default: true }),
      P.seed(),
      P.json(),
    ],
  },

  // —— 配音 ——
  'minimax/speech-2.8-hd': {
    kind: 'speech', label: 'MiniMax Speech 2.8 HD', desc: '高保真配音，情绪可调，多语种，可克隆音色', async: true,
    inputs: { text: true }, wire: { text: 'text' },
    params: minimaxSpeechParams(),
  },
  'minimax/speech-2.8-turbo': {
    kind: 'speech', label: 'MiniMax Speech 2.8 Turbo', desc: '同款参数的 Turbo 版', async: true,
    inputs: { text: true }, wire: { text: 'text' },
    params: minimaxSpeechParams(),
  },
  'google/gemini-3.1-flash-tts': {
    kind: 'speech', label: 'Gemini 3.1 Flash TTS', desc: 'Google 富表现力配音：30 个音色，风格说明用自然语言写', async: true,
    inputs: { text: true }, wire: { text: 'text' },
    params: [
      P.voice('voice', '音色', { default: 'Kore', options: GEMINI_VOICES.map((v) => ({ value: v, label: v })) }),
      P.text('prompt', '风格说明', { group: 'basic', default: 'Say the following.', max: 1000, desc: '怎么念（语气、语速、情绪），用自然语言写' }),
      P.text('language_code', '语言代码', { default: 'en-US', desc: 'BCP-47，如 cmn-CN、ja-JP、en-US' }),
      P.json(),
    ],
  },

  // —— 音乐 ——
  'minimax/music-2.5': {
    // 正文 = 风格描述（与别家音乐模型、Claude 的 generate_music 同口径）；歌词另填，不填就是纯音乐 / 模型自拟（契约复核 11-04）
    kind: 'music', label: 'MiniMax Music 2.5', desc: '整首歌（可带人声）。正文写曲风、情绪、场景；要唱的词填「歌词」（用 [Verse] [Chorus] 等标签分段）', async: true,
    inputs: { text: true }, wire: { text: 'prompt' },
    params: [
      P.text('lyrics', '歌词', { group: 'basic', max: 3000, desc: '用 [Verse] [Chorus] 等标签分段' }),
      P.enum('audio_format', '格式', opts(['mp3', 'wav']), { default: 'mp3' }),
      P.enum('bitrate', '码率', opts([32000, 64000, 128000, 256000]), { default: 256000 }),
      P.enum('sample_rate', '采样率', opts([16000, 24000, 32000, 44100]), { default: 44100 }),
      P.json(),
    ],
  },
  'google/lyria-2': {
    kind: 'music', label: 'Lyria 2', desc: 'Google 文本生成音乐，48kHz 立体声（不能指定时长）', async: true,
    inputs: { text: true, negative: true, promptLang: 'en' },   // 同一个模型（Lyria 2）只认英文提示词（Vertex 上 11-04 真打；replicate 上未真打）
    params: [P.seed(), P.json()],
  },
};

registerDialectCards('replicate', CARDS);
