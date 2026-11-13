// fal 适配器单测：假 fetch（不联网、不需要 Key），覆盖请求构造、队列轮询与进度、取消、错误映射、结果抹平、test()、listModels、通用卡、音色表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { falAdapter, CARDS } from './fal.mjs';
import { applySpecs, genericCard } from '../cards/spec.mjs';
import { dialectBuiltinModels, dialectCards } from '../cards/dialects.mjs';
import { dataUrl, AdapterError } from './http.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const MP4 = Buffer.from('000000186674797069736f6d', 'hex');
const MP3 = Buffer.from('fffb9064000000000000000000000000', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46', 'hex');

const provider = (extra = {}) => ({ id: 'p-test0001', owner: 'admin', dialect: 'fal', baseUrl: 'https://queue.fal.run', authStyle: 'fal-key', headers: {}, params: {}, timeoutSec: 60, models: [], ...extra });

function ctxOf(extra = {}) {
  const log = { submitted: 0, progress: [] };
  const ctx = {
    secret: { key: 'k' }, signal: new AbortController().signal, pollMs: 1,
    progress: (x) => log.progress.push(x), submitted: () => { log.submitted++; }, ...extra,
  };
  return { ctx, log };
}

// 假 fetch：每次调用记下（方法、地址、头、解析后的 body），返回 handler 给的 Response；测完还原
async function withFetch(handler, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const call = { url: String(url), method: String(init.method || 'GET').toUpperCase(), headers: { ...(init.headers || {}) }, body };
    calls.push(call);
    return handler(call);
  };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const bytes = (buf, type) => new Response(buf, { status: 200, headers: { 'content-type': type } });
const sub = (rid = 'rid-1', app = 'fal-ai/flux') => ({
  request_id: rid,
  response_url: `https://queue.fal.run/${app}/requests/${rid}`,
  status_url: `https://queue.fal.run/${app}/requests/${rid}/status`,
  cancel_url: `https://queue.fal.run/${app}/requests/${rid}/cancel`,
  queue_position: 0,
});
// 一条「提交 → 立刻完成 → 取结果 → 下载媒体」的假服务
const queueOk = (result, media, rid = 'rid-1', app = 'fal-ai/flux') => (c) => {
  if (c.method === 'POST') return json(sub(rid, app));
  if (c.url.endsWith('/status')) return json({ status: 'COMPLETED' });
  if (c.url.endsWith(`/requests/${rid}`)) return json(result);
  return bytes(media.buf, media.mime);
};
function mkReq({ kind, model, prompt = 'p', negative = '', raw = {}, inputs = [], thread = null }) {
  const card = CARDS[model] || genericCard('fal', kind);
  return { kind, model, card, prompt, negative, params: applySpecs(card.params, raw), inputs, thread };
}

test('提交：POST 到 queue.fal.run/<模型>，Key 放 Authorization，卡上字段映射正确，provider.params 与 extra 依次覆盖；结果下载不带 Key，meta 带 seed', async () => {
  const { ctx, log } = ctxOf();
  const r = mkReq({ kind: 'image', model: 'fal-ai/flux/dev', prompt: '一只猫', raw: { imageSize: 'square_hd', numImages: 2, steps: 4, extra: { guidance_scale: 9 } } });
  await withFetch((c) => {
    if (c.method === 'POST') return json(sub('rid-1', 'fal-ai/flux/dev'));
    if (c.url.endsWith('/status')) return json({ status: 'COMPLETED' });
    if (c.url.endsWith('/requests/rid-1')) return json({ images: [{ url: 'https://v3b.fal.media/files/a.png', content_type: 'image/png' }], seed: 7 });
    return bytes(PNG, 'image/png');
  }, async (calls) => {
    const out = await falAdapter.run(r, provider({ params: { seed: 3, guidance_scale: 2 } }), ctx);
    const post = calls[0];
    assert.equal(post.method, 'POST');
    assert.equal(post.url, 'https://queue.fal.run/fal-ai/flux/dev');
    assert.equal(post.headers.Authorization, 'Key k');
    assert.equal(post.body.prompt, '一只猫');
    assert.equal(post.body.image_size, 'square_hd');
    assert.equal(post.body.num_images, 2);
    assert.equal(post.body.num_inference_steps, 4);
    assert.equal(post.body.guidance_scale, 9, 'extra 压过 provider.params（2）和卡上的 3.5');
    assert.equal(post.body.seed, 3, '卡上没设种子，provider.params 的进了请求体');
    assert.equal(log.submitted, 1);
    const dl = calls.find((c) => c.url.includes('v3b.fal.media'));
    assert.equal(dl.headers.Authorization, undefined, '结果下载不带 Key');
    assert.equal(out.assets.length, 1);
    assert.deepEqual(out.assets[0].bytes, PNG);
    assert.equal(out.assets[0].mime, 'image/png');
    assert.equal(out.assets[0].meta.seed, 7);
  });
});

test('轮询：排队 → 运行 → 完成；没完成的每次报一次进度；提交后马上 submitted() 一次；没给负面提示词就不传', async () => {
  const seq = [{ status: 'IN_QUEUE', queue_position: 2 }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED' }];
  let n = 0;
  const { ctx, log } = ctxOf();
  await withFetch((c) => {
    if (c.method === 'POST') return json(sub('rid-1', 'fal-ai/kling-video'));
    if (c.url.endsWith('/status')) return json(seq[Math.min(n++, seq.length - 1)]);
    if (c.url.endsWith('/requests/rid-1')) return json({ video: { url: 'https://v3b.fal.media/files/v.mp4', content_type: 'video/mp4' } });
    return bytes(MP4, 'video/mp4');
  }, async (calls) => {
    const out = await falAdapter.run(mkReq({ kind: 'video', model: 'fal-ai/kling-video/v3/pro/text-to-video', prompt: 'x' }), provider(), ctx);
    assert.equal(log.submitted, 1);
    assert.deepEqual(log.progress.map((x) => x.note), ['排队中，前面还有 2 个', '生成中']);
    assert.equal(calls.filter((c) => c.url.endsWith('/status')).length, 3);
    assert.equal(out.assets[0].mime, 'video/mp4');
    assert.deepEqual(out.assets[0].bytes, MP4);
    const b = calls[0].body;
    assert.equal(b.prompt, 'x');
    assert.equal(b.duration, '5');
    assert.equal(b.aspect_ratio, '16:9');
    assert.equal(b.generate_audio, true);
    assert.equal(b.cfg_scale, 0.5);
    assert.equal('negative_prompt' in b, false, '没给负面提示词就不传');
  });
});

test('错误映射：401 → 含「API Key」的人话（没提交，submitted 不计）；422 → 上游原话透出；任务失败 → 带原因报失败，且不去取结果', async () => {
  await withFetch(() => json({ detail: 'Invalid API key' }, 401), async () => {
    const { ctx, log } = ctxOf();
    await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/flux/dev' }), provider(), ctx), (e) => e.status === 401 && /API Key/.test(e.message));
    assert.equal(log.submitted, 0);
  });
  await withFetch(() => json({ detail: [{ msg: 'image_urls: Field required' }] }, 422), async () => {
    await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/flux/dev' }), provider(), ctxOf().ctx), (e) => e.status === 422 && /image_urls: Field required/.test(e.message));
  });
  await withFetch((c) => {
    if (c.method === 'POST') return json(sub());
    if (c.url.endsWith('/status')) return json({ status: 'COMPLETED', error: 'NSFW content detected', error_type: 'content_policy' });
    return json({ images: [] });
  }, async (calls) => {
    await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/flux/dev' }), provider(), ctxOf().ctx), (e) => /失败：NSFW content detected/.test(e.message));
    assert.equal(calls.some((c) => c.url.endsWith('/requests/rid-1')), false, '失败不取结果');
  });
});

test('结果抹平：URL 下载、data URL、audio_url 字符串、MiniMax 式 hex 都变成 Buffer；有 duration_ms 的音频带时长', async () => {
  const cases = [
    { model: 'fal-ai/kling-video/v3/pro/text-to-video', kind: 'video', result: { video: { url: 'https://v3b.fal.media/files/v.mp4', content_type: 'video/mp4' } }, media: { buf: MP4, mime: 'video/mp4' }, want: { bytes: MP4, mime: 'video/mp4' } },
    { model: 'fal-ai/elevenlabs/tts/turbo-v2.5', kind: 'speech', result: { audio: { url: 'https://v3b.fal.media/files/s.mp3', content_type: 'audio/mpeg' }, duration_ms: 1500 }, media: { buf: MP3, mime: 'audio/mpeg' }, want: { bytes: MP3, mime: 'audio/mpeg', duration: 1.5 } },
    { model: 'fal-ai/lyria2', kind: 'music', result: { audio: { url: 'https://v3b.fal.media/files/m.wav' } }, media: { buf: MP3, mime: 'audio/wav' }, want: { bytes: MP3, mime: 'audio/wav' } },
    // CDN 回泛型 octet-stream：按种类兜底成 mp4，不把泛型类型往下传
    { model: 'fal-ai/kling-video/v3/pro/text-to-video', kind: 'video', result: { video: { url: 'https://v3b.fal.media/files/o.bin' } }, media: { buf: MP4, mime: 'application/octet-stream' }, want: { bytes: MP4, mime: 'video/mp4' } },
    { model: 'fal-ai/flux/dev', kind: 'image', result: { images: [{ url: dataUrl(PNG, 'image/png') }] }, media: { buf: PNG, mime: 'image/png' }, want: { bytes: PNG, mime: 'image/png' } },
    { model: 'fal-ai/minimax/speech-2.8-hd', kind: 'speech', result: { audio: MP3.toString('hex'), duration_ms: 800 }, media: { buf: MP3, mime: 'audio/mpeg' }, want: { bytes: MP3, mime: 'audio/mpeg', duration: 0.8 } },
  ];
  for (const c of cases) {
    await withFetch(queueOk(c.result, c.media), async (calls) => {
      const out = await falAdapter.run(mkReq({ kind: c.kind, model: c.model, prompt: 'x' }), provider(), ctxOf().ctx);
      assert.equal(out.assets.length, 1, c.model);
      assert.deepEqual(out.assets[0].bytes, c.want.bytes, c.model);
      assert.equal(out.assets[0].mime, c.want.mime, c.model);
      if (c.want.duration !== undefined) assert.equal(out.assets[0].meta.duration, c.want.duration, c.model);
      assert.ok(calls.every((x) => !x.url.startsWith('data:')), 'data URL 不走网络');
    });
  }
});

test('配音：MiniMax 固定 output_format=url，音色进 voice_setting，语速与格式进对应子对象；ElevenLabs 正文字段叫 text', async () => {
  await withFetch(queueOk({ audio: { url: 'https://v3b.fal.media/files/s.mp3', content_type: 'audio/mpeg' }, duration_ms: 1200 }, { buf: MP3, mime: 'audio/mpeg' }), async (calls) => {
    const out = await falAdapter.run(mkReq({ kind: 'speech', model: 'fal-ai/minimax/speech-2.8-hd', prompt: '你好', raw: { speed: 1.25, voice: 'Chinese (Mandarin)_Warm_Girl' } }), provider(), ctxOf().ctx);
    const b = calls[0].body;
    assert.equal(b.prompt, '你好');
    assert.equal(b.output_format, 'url');
    assert.equal(b.voice_setting.voice_id, 'Chinese (Mandarin)_Warm_Girl');
    assert.equal(b.voice_setting.speed, 1.25);
    assert.equal(b.audio_setting.format, 'mp3');
    assert.equal('emotion' in b.voice_setting, false, '情绪默认不传');
    assert.equal(out.assets[0].meta.duration, 1.2);
  });
  await withFetch(queueOk({ audio: { url: 'https://v3b.fal.media/files/e.mp3' } }, { buf: MP3, mime: 'audio/mpeg' }), async (calls) => {
    await falAdapter.run(mkReq({ kind: 'speech', model: 'fal-ai/elevenlabs/tts/turbo-v2.5', prompt: 'Hello' }), provider(), ctxOf().ctx);
    const b = calls[0].body;
    assert.equal(b.text, 'Hello');
    assert.equal('prompt' in b, false);
    assert.equal(b.voice, 'Rachel');
    assert.equal(b.apply_text_normalization, 'auto');
    assert.equal(b.similarity_boost, 0.75);
    assert.equal(b.speed, 1);
  });
});

test('图生视频：首帧进 start_image_url、尾帧进 end_image_url（都是 data URI）；没有首帧直接拒，不发请求', async () => {
  const LAST = JPG;
  const inputs = [{ role: 'first', data: PNG, mime: 'image/png', name: 'a.png' }, { role: 'last', data: LAST, mime: 'image/jpeg', name: 'b.jpg' }];
  await withFetch(queueOk({ video: { url: 'https://v3b.fal.media/files/v.mp4' } }, { buf: MP4, mime: 'video/mp4' }, 'rid-1', 'fal-ai/kling-video'), async (calls) => {
    await falAdapter.run(mkReq({ kind: 'video', model: 'fal-ai/kling-video/v3/pro/image-to-video', inputs }), provider(), ctxOf().ctx);
    assert.equal(calls[0].body.start_image_url, dataUrl(PNG, 'image/png'));
    assert.equal(calls[0].body.end_image_url, dataUrl(LAST, 'image/jpeg'));
    assert.equal('image_url' in calls[0].body, false, '这个模型的首帧字段不是 image_url');
  });
  await withFetch(() => json({}), async (calls) => {
    await assert.rejects(falAdapter.run(mkReq({ kind: 'video', model: 'fal-ai/kling-video/v3/pro/image-to-video', inputs: [] }), provider(), ctxOf().ctx), /首帧/);
    assert.equal(calls.length, 0);
  });
});

test('改图：没有素材时拿续改链上一张当参考（image_urls）；文生图卡不带参考图；改图卡既没素材也没续改链就拒，不发请求', async () => {
  const turn = { userText: '换个背景', data: PNG, mime: 'image/png', signature: '' };
  await withFetch(queueOk({ images: [{ url: 'https://v3b.fal.media/files/e.png' }] }, { buf: PNG, mime: 'image/png' }), async (calls) => {
    await falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/nano-banana-2/edit', prompt: '换背景', thread: { turns: [turn] } }), provider(), ctxOf().ctx);
    assert.deepEqual(calls[0].body.image_urls, [dataUrl(PNG, 'image/png')]);
  });
  await withFetch(queueOk({ images: [{ url: 'https://v3b.fal.media/files/t.png' }] }, { buf: PNG, mime: 'image/png' }), async (calls) => {
    await falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/nano-banana-2', prompt: '一只狗', thread: { turns: [turn] } }), provider(), ctxOf().ctx);
    assert.equal('image_urls' in calls[0].body, false, '文生图卡不收参考图');
  });
  await withFetch(() => json({}), async (calls) => {
    await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/nano-banana-2/edit', prompt: 'x' }), provider(), ctxOf().ctx), /参考图/);
    assert.equal(calls.length, 0);
  });
});

test('test()：只 GET 价格接口探 Key，不发生成请求；401 → 「API Key 无效」', async () => {
  await withFetch(() => json({ prices: [{ endpoint_id: 'fal-ai/flux/dev', unit_price: 0.025, unit: 'image', currency: 'USD' }], next_cursor: null, has_more: false }), async (calls) => {
    const r = await falAdapter.test(provider(), ctxOf().ctx);
    assert.match(r.detail, /Key 有效/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/flux/dev');
    assert.equal(calls[0].headers.Authorization, 'Key k');
  });
  await withFetch(() => json({ error: { type: 'authorization_error', message: 'Authentication required' } }, 401), async () => {
    await assert.rejects(falAdapter.test(provider(), ctxOf().ctx), (e) => e instanceof AdapterError && e.status === 401 && /API Key/.test(e.message));
  });
});

test('listModels：六个媒体类目各查一次（active、limit=50）；training 不列；文字类按名字分配音 / 音乐，音效和拿不准的给 null', async () => {
  const items = {
    'text-to-image': [
      { endpoint_id: 'fal-ai/flux/dev', metadata: { display_name: 'FLUX.1 [dev]', category: 'text-to-image', kind: 'inference' } },
      { endpoint_id: 'acme/train-me', metadata: { display_name: 'Trainer', category: 'text-to-image', kind: 'training' } },
    ],
    'text-to-audio': [
      { endpoint_id: 'fal-ai/kokoro/american-english', metadata: { display_name: 'Kokoro TTS', category: 'text-to-audio' } },
      { endpoint_id: 'elevenlabs/music/v2.5', metadata: { display_name: 'Elevenlabs Music v2.5', category: 'text-to-audio', kind: 'inference' } },
      { endpoint_id: 'elevenlabs/sound-effects/v3', metadata: { display_name: 'ElevenLabs Sound Effects V3', category: 'text-to-audio', kind: 'inference' } },
      { endpoint_id: 'fal-ai/mmaudio-v2/text-to-audio', metadata: { display_name: 'MMAudio V2 Text to Audio', category: 'text-to-audio' } },
    ],
  };
  await withFetch((c) => json({ models: items[new URL(c.url).searchParams.get('category')] || [], has_more: false, next_cursor: null }), async (calls) => {
    const list = await falAdapter.listModels(provider(), ctxOf().ctx);
    const byId = Object.fromEntries(list.map((m) => [m.id, m]));
    assert.equal(byId['fal-ai/flux/dev'].kind, 'image');
    assert.equal(byId['acme/train-me'], undefined, 'training 不列');
    assert.equal(byId['fal-ai/kokoro/american-english'].kind, 'speech');
    assert.equal(byId['elevenlabs/music/v2.5'].kind, 'music');
    assert.equal(byId['elevenlabs/sound-effects/v3'].kind, null);
    assert.equal(byId['fal-ai/mmaudio-v2/text-to-audio'].kind, null);
    assert.equal(calls.length, 6);
    for (const c of calls) {
      assert.match(c.url, /^https:\/\/api\.fal\.ai\/v1\/models\?/);
      assert.equal(new URL(c.url).searchParams.get('status'), 'active');
      assert.equal(new URL(c.url).searchParams.get('limit'), '50');
    }
    assert.equal(calls[0].headers.Authorization, 'Key k');
  });
  await withFetch(() => json({ detail: 'boom' }, 500), async () => {
    await assert.rejects(falAdapter.listModels(provider(), ctxOf().ctx), (e) => e instanceof AdapterError && /服务方出错了/.test(e.message));
  });
});

test('取消：任务在跑时 ctx.signal abort → 尽力 PUT cancel_url（带 Key），run 以「已取消」结束，之后不再查状态', async () => {
  const ac = new AbortController();
  const { ctx } = ctxOf({ signal: ac.signal, pollMs: 2 });
  let polls = 0;
  await withFetch((c) => {
    if (c.method === 'POST') return json(sub('rid-1', 'fal-ai/flux'));
    if (c.method === 'PUT') return json({ status: 'OK' });
    if (c.url.endsWith('/status')) { if (++polls === 2) ac.abort(); return json({ status: 'IN_QUEUE', queue_position: 1 }); }
    return json({});
  }, async (calls) => {
    await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/flux/dev' }), provider(), ctx), (e) => /已取消/.test(e.message));
    await new Promise((res) => setTimeout(res, 20));
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, '发了取消');
    assert.equal(put.url, 'https://queue.fal.run/fal-ai/flux/requests/rid-1/cancel');
    assert.equal(put.headers.Authorization, 'Key k');
    assert.equal(calls.filter((c) => c.url.endsWith('/status')).length, 2, '取消后不再查状态');
  });
});

test('返回体里的地址不同源时不跟随（Key 不发到别的主机），改按 owner/app 自己拼', async () => {
  await withFetch((c) => {
    if (c.method === 'POST') return json({ request_id: 'rid-9', status_url: 'https://evil.example/s', response_url: 'https://evil.example/r', cancel_url: 'https://evil.example/c' });
    if (c.url.endsWith('/status')) return json({ status: 'COMPLETED' });
    if (c.url.endsWith('/requests/rid-9')) return json({ images: [{ url: 'https://v3b.fal.media/files/a.png' }] });
    return bytes(PNG, 'image/png');
  }, async (calls) => {
    await falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/flux/dev' }), provider(), ctxOf().ctx);
    assert.ok(calls.every((c) => !c.url.includes('evil.example')));
    assert.equal(calls[1].url, 'https://queue.fal.run/fal-ai/flux/requests/rid-9/status');
    assert.equal(calls[2].url, 'https://queue.fal.run/fal-ai/flux/requests/rid-9');
  });
});

test('模型 id 只许字母、数字和 . _ - /；不合法的在发请求前拒掉', async () => {
  for (const bad of ['../secret', 'fal-ai/flux/dev?x=1', 'a b', '/leading']) {
    await withFetch(() => json({}), async (calls) => {
      await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: bad }), provider(), ctxOf().ctx), /模型 id/, bad);
      assert.equal(calls.length, 0, bad);
    });
  }
});

test('未知模型用通用卡也能跑：prompt / 比例 / 时长 / 首帧 / 负面词 / extra 映射到常见字段，extra 原样合并', async () => {
  const r = mkReq({
    kind: 'video', model: 'someone/new-video-model', prompt: 'waves', negative: 'blurry',
    raw: { aspectRatio: '9:16', durationSeconds: 6, extra: { my_flag: true } },
    inputs: [{ role: 'first', data: PNG, mime: 'image/png', name: 'a.png' }],
  });
  await withFetch(queueOk({ video: { url: 'https://v3b.fal.media/files/n.mp4' } }, { buf: MP4, mime: 'video/mp4' }, 'rid-2', 'someone/new-video-model'), async (calls) => {
    const out = await falAdapter.run(r, provider(), ctxOf().ctx);
    const b = calls[0].body;
    assert.equal(calls[0].url, 'https://queue.fal.run/someone/new-video-model');
    assert.equal(b.prompt, 'waves');
    assert.equal(b.aspect_ratio, '9:16');
    assert.equal(b.duration, '6');
    assert.equal(b.image_url, dataUrl(PNG, 'image/png'));
    assert.equal(b.negative_prompt, 'blurry');
    assert.equal(b.my_flag, true);
    assert.equal(out.assets[0].mime, 'video/mp4');
  });
});

test('没填 Key：run 与 test 都在发请求前拒掉', async () => {
  await withFetch(() => json({}), async (calls) => {
    await assert.rejects(falAdapter.run(mkReq({ kind: 'image', model: 'fal-ai/flux/dev' }), provider(), { ...ctxOf().ctx, secret: {} }), /API Key/);
    await assert.rejects(falAdapter.test(provider(), { ...ctxOf().ctx, secret: {} }), /API Key/);
    assert.equal(calls.length, 0);
  });
});

test('卡片自检：每张都有 wire 和规范的 params（键不重、enum 默认在选项里、extra 殿后）；每种种类 2–4 张；已登记进方言', () => {
  for (const [id, card] of Object.entries(CARDS)) {
    assert.ok(['image', 'video', 'speech', 'music'].includes(card.kind), id);
    assert.equal(typeof card.wire, 'function', id);
    const keys = card.params.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, `${id} 键重复`);
    for (const s of card.params) if (s.type === 'enum' && s.default !== undefined) assert.ok(s.options.some((o) => o.value === s.default), `${id} ${s.key} 默认不在选项里`);
    assert.equal(card.params.at(-1).key, 'extra', `${id} 最后一项应是 extra`);
  }
  for (const kind of ['image', 'video', 'speech', 'music']) {
    const n = Object.values(CARDS).filter((c) => c.kind === kind).length;
    assert.ok(n >= 2 && n <= 4, `${kind} 有 ${n} 张`);
  }
  assert.ok(dialectBuiltinModels('fal').some((m) => m.id === 'fal-ai/flux/dev' && m.kind === 'image'));
  assert.ok(dialectCards('fal', 'fal-ai/lyria2'));
});

test('音色表：MiniMax 语音模型给官方 332 个（id 不重，卡的默认音色在表里）；ElevenLabs 给示例名（含默认 Rachel）；其他不给；种类与方言名正确', () => {
  const mm = falAdapter.voices(provider(), {}, 'fal-ai/minimax/speech-2.8-hd');
  assert.equal(mm.length, 332);
  assert.equal(new Set(mm.map((v) => v.id)).size, 332);
  const def = CARDS['fal-ai/minimax/speech-2.8-hd'].params.find((s) => s.key === 'voice').default;
  assert.ok(mm.some((v) => v.id === def), '卡的默认音色在表里');
  assert.ok(mm.some((v) => v.id === 'Chinese (Mandarin)_Wise_Women' && v.note === '中文（普通话）'));
  const el = falAdapter.voices(provider(), {}, 'fal-ai/elevenlabs/tts/turbo-v2.5');
  assert.ok(el.some((v) => v.id === 'Rachel'));
  assert.deepEqual(falAdapter.voices(provider(), {}, 'fal-ai/flux/dev'), []);
  assert.equal(falAdapter.dialect, 'fal');
  assert.deepEqual(falAdapter.kinds, ['image', 'video', 'speech', 'music']);
});

test('其余卡的字段映射：Seedance、Stable Audio（不收负面词）、Lyria 2（收负面词）、MiniMax Music（没歌词自动写词，纯音乐不写词）', async () => {
  const run = async (model, kind, raw, extra = {}) => {
    let body;
    await withFetch(queueOk({ video: { url: 'https://v3b.fal.media/files/x.mp4' }, audio: { url: 'https://v3b.fal.media/files/x.mp3' } }, { buf: MP4, mime: 'video/mp4' }), async (calls) => {
      await falAdapter.run(mkReq({ kind, model, prompt: 'a long prompt for testing', raw, ...extra }), provider(), ctxOf().ctx);
      body = calls[0].body;
    });
    return body;
  };
  const sd = await run('fal-ai/bytedance/seedance/v1.5/pro/text-to-video', 'video', { aspectRatio: '9:16', resolution: '1080p', durationSeconds: '8', cameraFixed: true, seed: 5 }, { negative: 'blurry' });
  assert.deepEqual({ aspect_ratio: sd.aspect_ratio, resolution: sd.resolution, duration: sd.duration, camera_fixed: sd.camera_fixed, generate_audio: sd.generate_audio, seed: sd.seed }, { aspect_ratio: '9:16', resolution: '1080p', duration: '8', camera_fixed: true, generate_audio: true, seed: 5 });
  assert.equal('negative_prompt' in sd, false, 'Seedance 卡不收负面词');

  const sa = await run('fal-ai/stable-audio-25/text-to-audio', 'music', { durationSeconds: 30, steps: 6, guidanceScale: 3 }, { negative: 'noise' });
  assert.deepEqual({ seconds_total: sa.seconds_total, num_inference_steps: sa.num_inference_steps, guidance_scale: sa.guidance_scale }, { seconds_total: 30, num_inference_steps: 6, guidance_scale: 3 });
  assert.equal('negative_prompt' in sa, false, 'Stable Audio 卡不收负面词');

  const ly = await run('fal-ai/lyria2', 'music', { seed: 9 }, { negative: 'harsh cymbals' });
  assert.equal(ly.negative_prompt, 'harsh cymbals');
  assert.equal(ly.seed, 9);

  const auto = await run('fal-ai/minimax-music/v2.6', 'music', {});
  assert.equal(auto.is_instrumental, false);
  assert.equal(auto.lyrics_optimizer, true, '没歌词又不是纯音乐：让它自己写词');
  assert.equal('lyrics' in auto, false);
  assert.equal(auto.audio_setting.format, 'mp3');

  const inst = await run('fal-ai/minimax-music/v2.6', 'music', { instrumental: true });
  assert.equal(inst.is_instrumental, true);
  assert.equal('lyrics_optimizer' in inst, false, '纯音乐不自动写词');

  const withLyrics = await run('fal-ai/minimax-music/v2.6', 'music', { lyrics: '[Verse]\n你好' });
  assert.equal(withLyrics.lyrics, '[Verse]\n你好');
  assert.equal('lyrics_optimizer' in withLyrics, false, '给了歌词就不自动写词');
});
