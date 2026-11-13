// ark 方言（火山方舟）：图像 = Seedream（同步，一次 POST 出图），视频 = Seedance（异步：提交 → 轮询 → 下载）。
//
// 依据的官方文档（2026-11-04 查阅，docs.volcengine.com 的 82379 文档集）。查阅是摘要式读取：字段名和枚举取自摘录，没有逐字核对，也没有真打任何接口（没有 Key）。
//   图片生成 API            https://docs.volcengine.com/docs/82379/1541523?lang=zh
//   创建视频生成任务        https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
//   查询视频生成任务        https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh
//   取消或删除视频生成任务  https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api?lang=zh
//   快速入门（地址、鉴权）  https://docs.volcengine.com/docs/82379/1399008?lang=zh
//   Seedream 5.0 pro/flash 教程  https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh
//   Seedance 2.0 系列教程   https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh
//   模型列表                https://docs.volcengine.com/docs/ark/model-list?lang=zh（只抓到标题，表格没拿到）
//
// 关键事实：
//   · 地址 https://ark.cn-beijing.volces.com/api/v3；鉴权 Authorization: Bearer <ARK_API_KEY>（Key 在控制台「API Key 管理」里建）；
//     model 字段可以填模型 id 或接入点 id；每个模型要先在「开通管理」开通。
//   · 图像 POST /images/generations：model、prompt 必填；image 是 URL 或 data URI，字符串或数组（5.0 pro/flash 最多 10 张）；
//     size 是档位 1K / 1.5K / 2K（5.0 pro/flash，默认 2K）或 'WxH' 像素，二者不可混用，像素要在模型的区间内（5.0 pro/flash：921600–4624220）；
//     output_format png / jpeg（默认 jpeg）；response_format url / b64_json（默认 url）；watermark（默认 true）；
//     optimize_prompt_options: { mode: 'standard' | 'fast' }（fast 仅 5.0 pro）。
//     结果 data[]：url 或 b64_json、size、output_format；没出图时顶层 error: { code, message }。url 24 小时失效。
//     文档里没有 seed、guidance_scale（页面上找不到），这里不映射，走额外参数。
//   · 视频 POST /contents/generations/tasks → { id }（cgt- 开头）；GET /contents/generations/tasks/{id} 查 status：
//     queued / running / succeeded / failed / cancelled / expired。成功取 content.video_url（24 小时有效，拿到就下载）。
//     取消：DELETE /contents/generations/tasks/{id}。只有 queued 能取消（变成 cancelled），running 不许；
//     终态（succeeded / failed / cancelled / expired）时 DELETE 是删任务记录。文档未写明取消后是否计费，这里不作处理。
//     参数走 body 的 JSON 字段（文档说是正式写法、严格校验）；文本命令（--rs 等）文档还保留，这里不用。
//     content 项：text；image_url（role：first_frame / last_frame / reference_image；url 可以是 data URI）。
//     首帧（1 张）、首尾帧（正好 2 张）、参考图（omni，仅 2.5 / 2.0 系列）三种不许混用。
//   · 文档示例里出现过的模型 id：doubao-seedream-5-0-pro-260628、doubao-seedream-5-0-flash-260915（Seedream 5.0 教程）；
//     doubao-seedance-2-5-260628（创建任务页示例）、doubao-seedance-2-0-260128、doubao-seedance-2-0-fast-260128、
//     doubao-seedance-2-0-mini-260615（2.0 教程表格）、doubao-seedance-1-0-pro-250528（创建任务页示例）。
//     Seedream 4.x、5.0 lite 的 id 页面里没有，没建卡（用户手填的走通用卡）；2.5 教程页没抓到正文，只能依据创建任务页的示例。
//   · 没有模型列表的 HTTP 接口说明，也没有免费的余额 / Key 校验接口。test() 用保险丝（见下）。
//   · 没有负面提示词字段，req.negative 不用。

import { http, authHeaders, joinUrl, download, poll, dataUrl, guessMime, AdapterError } from './http.mjs';
import { P, opts } from '../cards/spec.mjs';
import { registerDialectCards } from '../cards/dialects.mjs';

const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const LABEL = '火山方舟';

// 通用卡的比例 → 像素（档位式的 size 不认比例，比例得写进提示词）。
// 取值落在 5.0 pro/flash（921600–4624220）和 5.0 lite / 4.5（3686400–16777216）的交集里，4.0（921600 起）也在区间内。
const PIXEL_SIZE = {
  '1:1': '2048x2048', '16:9': '2688x1512', '9:16': '1512x2688', '4:3': '2304x1728', '3:4': '1728x2304', '3:2': '2496x1664', '2:3': '1664x2496',
};
// 通用卡的 auto（模型自选）→ 文档的 adaptive
const RATIO = { auto: 'adaptive' };

const VIDEO_ASPECTS = [
  { value: 'adaptive', label: '自适应' }, { value: '16:9', label: '16:9 横' }, { value: '9:16', label: '9:16 竖' },
  { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' }, { value: '3:4', label: '3:4' }, { value: '21:9', label: '21:9 超宽' },
];
const resOpts = (list) => opts(list.map((r) => ({ value: r, label: r === '4k' ? '4K' : r })));
const secOpts = (list, auto) => opts([...(auto ? [{ value: -1, label: '自动（模型自选）' }] : []), ...list.map((d) => ({ value: d, label: `${d} 秒` }))]);

// —— 图像：Seedream 5.0 pro / flash（同步）——
// 文档：档位 1K / 1.5K / 2K，默认 2K；比例写进提示词（文档未写明各档位对应的像素，这里不把比例映射成档位）；
// pro 多一个提示词优化档（fast 仅 pro 支持）；最多 10 张参考图
function seedreamCard(label, { pro = false, desc }) {
  const params = [
    P.enum('size', '尺寸', opts([{ value: '1K', label: '1K' }, { value: '1.5K', label: '1.5K' }, { value: '2K', label: '2K' }]), { default: '2K', desc: '档位；比例写进提示词' }),
    P.enum('outputFormat', '输出格式', opts([{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }]), { group: 'advanced', default: 'jpeg' }),
    P.bool('watermark', '水印', { default: true, desc: '官方默认在右下角加「AI 生成」标' }),
  ];
  if (pro) params.push(P.enum('promptMode', '提示词优化', opts([{ value: 'standard', label: '标准（画质高，慢）' }, { value: 'fast', label: '快速' }]), { group: 'advanced', default: 'standard' }));
  params.push(P.json());
  return { kind: 'image', label, desc, async: false, inputs: { text: true, images: { max: 10, roles: ['edit', 'ref'] } }, params };
}

// —— 视频：Seedance 2.5 / 2.0 系列（异步）——
// 文档：比例、时长（-1 = 模型自选）、首帧 / 首尾帧 / 多图参考、生成音频（默认开）；水印默认关
function seedanceCard(label, { resolutions, durations, refs, desc, aspectDesc }) {
  return {
    kind: 'video', label, desc, async: true,
    inputs: { text: true, images: { max: refs, roles: ['first', 'last', 'ref'] } },
    params: [
      P.enum('aspectRatio', '比例', opts(VIDEO_ASPECTS), { default: 'adaptive', ...(aspectDesc ? { desc: aspectDesc } : {}) }),
      P.enum('resolution', '分辨率', resOpts(resolutions), { default: '720p' }),
      P.enum('durationSeconds', '时长', secOpts(durations, true), { default: -1 }),
      P.bool('generateAudio', '生成音频', { group: 'basic', default: true, desc: '同步生成对白和音效' }),
      P.bool('watermark', '水印', { default: false }),
      P.json(),
    ],
  };
}

// —— 视频：Seedance 1.0 pro（异步）——
// 文档：分辨率默认 1080p；比例文生视频默认 16:9、图生视频默认 adaptive，这里统一给 16:9（文档未写明图生视频能否指定 16:9，按允许处理）；
// 时长 2–12 秒，文档未写明默认值，按 5 秒处理；有 seed 和 camera_fixed；没有 generate_audio；能给首帧或首尾帧，没有参考图
function seedance1Card() {
  return {
    kind: 'video', label: 'Seedance 1.0 pro', desc: '1080p 上限，时长 2–12 秒，支持首帧和首尾帧，可固定镜头、指定种子', async: true,
    inputs: { text: true, images: { max: 2, roles: ['first', 'last'] } },
    params: [
      P.enum('aspectRatio', '比例', opts(VIDEO_ASPECTS), { default: '16:9' }),
      P.enum('resolution', '分辨率', resOpts(['480p', '720p', '1080p']), { default: '1080p' }),
      P.enum('durationSeconds', '时长', secOpts([2, 3, 4, 5, 6, 8, 10, 12], false), { default: 5 }),
      P.bool('cameraFixed', '固定镜头', { default: false }),
      P.seed({ min: -1, max: 2147483647, desc: '-1 = 随机' }),
      P.bool('watermark', '水印', { default: false }),
      P.json(),
    ],
  };
}

// 常见卡。文档：2.5 最高 1080p、时长 4–30 秒；2.0 最高 4K、时长 4–15 秒；2.0 Fast / Mini 最高 720p、时长 4–15 秒。
// 2.0 系列的默认时长文档未写明，这里按 -1（模型自选；文档允许 -1）。2.5 的默认 -1 是文档写的。
export const CARDS = {
  'doubao-seedream-5-0-pro-260628': seedreamCard('Seedream 5.0 pro', { pro: true, desc: '5.0 系列的 pro 档：2K 档，可开提示词快速优化，最多 10 张参考图' }),
  'doubao-seedream-5-0-flash-260915': seedreamCard('Seedream 5.0 flash', { desc: '5.0 系列的 flash 档：1K–2K 档，最多 10 张参考图' }),
  'doubao-seedance-2-5-260628': seedanceCard('Seedance 2.5', {
    resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 8, 10, 12, 15, 20, 30], refs: 30,
    desc: '1080p 上限，时长 4–30 秒，首帧 / 首尾帧 / 多图参考', aspectDesc: '首帧任务只认自适应（文档）',
  }),
  'doubao-seedance-2-0-260128': seedanceCard('Seedance 2.0', {
    resolutions: ['480p', '720p', '1080p', '4k'], durations: [4, 5, 6, 8, 10, 12, 15], refs: 9,
    desc: '最高 4K，时长 4–15 秒，首帧 / 首尾帧 / 多图参考',
  }),
  'doubao-seedance-2-0-fast-260128': seedanceCard('Seedance 2.0 Fast', {
    resolutions: ['480p', '720p'], durations: [4, 5, 6, 8, 10, 12, 15], refs: 9, desc: '2.0 的快速档：最高 720p，时长 4–15 秒',
  }),
  'doubao-seedance-2-0-mini-260615': seedanceCard('Seedance 2.0 Mini', {
    resolutions: ['480p', '720p'], durations: [4, 5, 6, 8, 10, 12, 15], refs: 9, desc: '2.0 的省钱档：最高 720p，时长 4–15 秒',
  }),
  'doubao-seedance-1-0-pro-250528': seedance1Card(),
};
registerDialectCards('ark', CARDS);

const keyOf = (ctx) => {
  const key = ctx?.secret?.key;
  if (!key) throw new AdapterError('这个服务还没填 API Key');
  return key;
};
const base = (provider) => provider.baseUrl || BASE;
const timeoutOf = (provider) => (provider.timeoutSec || 600) * 1000;
const mimeOf = (x) => x.mime || guessMime(x.name);
const toDataUri = (x) => dataUrl(x.data, mimeOf(x));
// 传输层的瞬时错（网络抖动、超时、限流、5xx）：轮询时不算失败，下一轮再查
const isTransient = (e) => e instanceof AdapterError && (e.code === 'network' || e.code === 'timeout' || e.status === 429 || e.status >= 500);

// —— 图像（同步）——
async function runImage(req, provider, ctx) {
  const key = keyOf(ctx);
  const p = req.params || {};
  // 参考图：编辑 / 参考素材；没给素材就拿续改链上最后一张（这家没有多轮上下文）
  let refs = (req.inputs || []).filter((x) => x.role === 'edit' || x.role === 'ref');
  if (!refs.length && req.thread?.turns?.length) refs = [req.thread.turns[req.thread.turns.length - 1]];
  // b64_json 省一次下载；url 只保留 24 小时
  const body = { model: req.model, prompt: req.prompt, response_format: 'b64_json' };
  if (refs.length) body.image = refs.length === 1 ? toDataUri(refs[0]) : refs.map(toDataUri);
  // 尺寸：卡上的档位优先；通用卡的比例换成像素
  const size = p.size || (p.aspectRatio && p.aspectRatio !== 'auto' ? PIXEL_SIZE[p.aspectRatio] : undefined);
  if (size) body.size = size;
  if (p.outputFormat) body.output_format = p.outputFormat;
  if (p.watermark !== undefined) body.watermark = p.watermark;
  if (p.promptMode === 'fast') body.optimize_prompt_options = { mode: 'fast' };
  Object.assign(body, provider.params || {}, p.extra || {});

  const j = await http(joinUrl(base(provider), 'images/generations'), {
    method: 'POST', headers: authHeaders(provider, key), body, timeoutMs: timeoutOf(provider), signal: ctx.signal, dispatcher: ctx.dispatcher, label: LABEL,
  });
  const fmt = body.output_format || 'jpeg';
  const assets = [];
  let why = j?.error?.message || '';
  for (const d of Array.isArray(j?.data) ? j.data : []) {
    if (d?.error) { why ||= d.error.message || d.error.code || ''; continue; }   // 组图里单张被拒：跳过，别的照常
    const want = d.output_format || fmt;
    let mime = want === 'png' ? 'image/png' : 'image/jpeg';
    let bytes;
    if (d.b64_json) bytes = Buffer.from(d.b64_json, 'base64');
    else if (d.url) {
      const dl = await download(d.url, { signal: ctx.signal, dispatcher: ctx.dispatcher, timeoutMs: timeoutOf(provider), label: '下载图片' });
      bytes = dl.bytes;
      if (dl.mime?.startsWith('image/')) mime = dl.mime;
    } else continue;
    assets.push({ bytes, mime, meta: { model: j.model, size: d.size } });
  }
  if (!assets.length) throw new AdapterError(`${LABEL}没有返回图片${why ? '：' + why : ''}`, { detail: why });
  return { assets };
}

// —— 视频：素材 → content 里的 image_url 项 ——
// 首帧 / 首尾帧 / 参考图三种不许混用（文档）。这里先挡掉，省得发出去再被服务端拒。
function videoImages(inputs) {
  const of = (role) => inputs.filter((x) => x.role === role);
  const first = of('first');
  const last = of('last');
  const refs = of('ref');
  if (refs.length && (first.length || last.length)) throw new AdapterError('参考图和首帧 / 尾帧不能混用（火山方舟的视频任务只认其中一种）', { status: 400 });
  const item = (x, role) => ({ type: 'image_url', image_url: { url: toDataUri(x) }, role });
  return [...first.map((x) => item(x, 'first_frame')), ...last.map((x) => item(x, 'last_frame')), ...refs.map((x) => item(x, 'reference_image'))];
}

// 尽力取消：DELETE 只对排队中的任务有效（运行中或已结束的服务端会拒，这里忽略）。不带 ctx.signal：那时它已经 abort 了。
async function cancelTask(provider, key, id, dispatcher) {
  await http(joinUrl(base(provider), `contents/generations/tasks/${encodeURIComponent(id)}`), {
    method: 'DELETE', headers: authHeaders(provider, key), timeoutMs: 15_000, dispatcher, label: LABEL + '取消',
  }).catch(() => {});
}

// —— 视频（异步）——
async function runVideo(req, provider, ctx) {
  const key = keyOf(ctx);
  const p = req.params || {};
  const headers = authHeaders(provider, key);
  const timeoutMs = timeoutOf(provider);

  const content = [];
  if (req.prompt) content.push({ type: 'text', text: req.prompt });
  content.push(...videoImages(req.inputs || []));
  // 参数走 JSON 字段：卡上的参数 → provider.params → 逐次额外参数（后者覆盖前者）
  const body = { model: req.model, content };
  if (p.aspectRatio) body.ratio = RATIO[p.aspectRatio] || p.aspectRatio;
  if (p.resolution) body.resolution = p.resolution;
  if (p.durationSeconds !== undefined) body.duration = Math.round(Number(p.durationSeconds));   // -1 = 模型自选
  if (p.generateAudio !== undefined) body.generate_audio = p.generateAudio;
  if (p.watermark !== undefined) body.watermark = p.watermark;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.cameraFixed !== undefined) body.camera_fixed = p.cameraFixed;
  Object.assign(body, provider.params || {}, p.extra || {});

  const created = await http(joinUrl(base(provider), 'contents/generations/tasks'), {
    method: 'POST', headers, body, timeoutMs, signal: ctx.signal, dispatcher: ctx.dispatcher, label: LABEL,
  });
  const id = created?.id;
  if (!id) throw new AdapterError(`${LABEL}没有返回任务 id`, { detail: JSON.stringify(created ?? null).slice(0, 200) });
  ctx.submitted?.();   // 任务已在服务方排上：之后只能尽力取消（排队中才行）

  const taskUrl = joinUrl(base(provider), `contents/generations/tasks/${encodeURIComponent(id)}`);
  let note = '排队中';
  let finished = false;   // 服务方给了终态（成功 / 失败 / 过期 / 取消）：之后不用再取消
  let task;
  try {
    task = await poll(async () => {
      let t;
      try {
        t = await http(taskUrl, { headers, timeoutMs: 60_000, signal: ctx.signal, dispatcher: ctx.dispatcher, label: LABEL + '查询' });
      } catch (e) {
        if (ctx.signal?.aborted || !isTransient(e)) throw e;
        return {};   // 抖动：下一轮再查
      }
      if (t?.status === 'succeeded') {
        finished = true;
        return t.content?.video_url ? { done: true, value: t } : { failed: true, error: '任务成功了，但没有给视频地址' };
      }
      if (t?.status === 'failed' || t?.status === 'expired' || t?.status === 'cancelled') {
        finished = true;
        const why = t.status === 'expired' ? '任务超过提交过期时间，服务端已终止'
          : t.status === 'cancelled' ? '任务已取消' : (t.error?.message || t.error?.code || '');
        return { failed: true, error: why || '服务方没给原因' };
      }
      note = t?.status === 'running' ? '生成中' : '排队中';
      return {};
    }, {
      intervalMs: ctx.pollMs || 5000,   // 文档未写明推荐的轮询间隔，按 5 秒（测试里用 ctx.pollMs 调小）
      timeoutMs: Math.max(900_000, timeoutMs),
      signal: ctx.signal, label: '视频生成',
      onTick: ({ elapsed }) => ctx.progress?.({ elapsed, note }),
    });
  } catch (e) {
    if (!finished) await cancelTask(provider, key, id, ctx.dispatcher);   // 中途取消 / 超时：排队中的任务取消掉，别白烧
    throw e;
  }
  // 视频地址 24 小时失效，拿到就下
  const dl = await download(task.content.video_url, { signal: ctx.signal, dispatcher: ctx.dispatcher, timeoutMs, label: '下载视频' });
  return {
    assets: [{
      bytes: dl.bytes, mime: dl.mime?.startsWith('video/') ? dl.mime : 'video/mp4',
      meta: { model: task.model, duration: task.duration, resolution: task.resolution, ratio: task.ratio, seed: task.seed, generateAudio: task.generate_audio },
    }],
  };
}

export const arkAdapter = {
  dialect: 'ark',
  kinds: ['image', 'video'],

  // 没有只读的探测接口（文档未写明 Key 校验、余额接口），用保险丝：请求不带 model（文档写 model 必填），size 填一个非法值（文档只认档位或 WxH 像素）。
  // 按文档这两条都不合法，应在参数校验阶段报错、不生成内容、不计费；文档未写明缺 model 时的确切状态码。
  // 只有 400 / 422 才算「Key 有效」；401 / 403 是 Key 或权限问题；其余（404 等）不下结论，原样报错。万一被收下（2xx），如实告诉用户可能已计费。
  async test(provider, ctx) {
    const key = keyOf(ctx);
    // 先试只读的「查询视频生成任务列表」（GET contents/generations/tasks，分页取 1 条）：零成本、走同一套鉴权（契约复核 11-04 建议）。
    // 这个接口不存在（404）或被网关挡了时，再退到下面的保险丝。
    try {
      await http(joinUrl(base(provider), 'contents/generations/tasks?page_num=1&page_size=1'), {
        headers: authHeaders(provider, key), timeoutMs: 30_000, signal: ctx.signal, dispatcher: ctx.dispatcher, label: LABEL,
      });
      return { detail: 'Key 有效（查询任务列表通过）' };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new AdapterError(`API Key 无效或没有权限（${LABEL} ${e.status}）`, { status: e.status, detail: e.detail });
      if (e.status !== 404 && e.status !== 405) throw e;
    }
    try {
      await http(joinUrl(base(provider), 'images/generations'), {
        method: 'POST', headers: authHeaders(provider, key), body: { prompt: '连通性测试', size: 'ZZZ' },
        timeoutMs: 30_000, signal: ctx.signal, dispatcher: ctx.dispatcher, label: LABEL,
      });
    } catch (e) {
      if (e.status === 400 || e.status === 422) return { detail: 'Key 有效（服务端在参数校验阶段就拒了探测请求，没有生成内容）' };
      if (e.status === 401 || e.status === 403) throw new AdapterError(`API Key 无效或没有权限（${LABEL} ${e.status}）`, { status: e.status, detail: e.detail });
      throw e;
    }
    // 走到这里说明保险丝没拦住，服务方收下了请求（这次可能已计费）
    return { detail: 'Key 有效（注意：探测请求被服务方收下了，这次可能已计费一次）' };
  },

  // 文档未写明模型列表的 HTTP 接口，按没有处理，返回 []；设置页把 CARDS 当内置清单用
  async listModels() { return []; },

  async run(req, provider, ctx) {
    return req.kind === 'video' ? runVideo(req, provider, ctx) : runImage(req, provider, ctx);
  },
};
