// ark 适配器单测：mock 全局 fetch，不联网、不需要 Key（没有真打任何接口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { arkAdapter, CARDS } from './ark.mjs';
import { applySpecs, genericCard } from '../cards/spec.mjs';
import { dialectCards } from '../cards/dialects.mjs';
import { AdapterError, dataUrl } from './http.mjs';

const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const KEY = 'ark-test-key';
const PNG = Buffer.from('fake-png-bytes');

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const bin = (bytes, type) => new Response(bytes, { status: 200, headers: { 'content-type': type } });

// 替换全局 fetch：每次调用记下方法、地址、请求头、请求体；events 里也记一笔（和 submitted / progress 放在一起看先后）。
// handle(call) 返回 Response。restore() 还原。
function installFetch(handle, events = []) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method || 'GET').toUpperCase(),
      headers: { ...(init.headers || {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    events.push({ type: 'fetch', method: call.method, url: call.url });
    return handle(call);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

const provider = (over = {}) => ({ id: 'p-test0001', owner: 'admin', dialect: 'ark', baseUrl: BASE, authStyle: 'bearer', headers: {}, params: {}, timeoutSec: 60, models: [], ...over });
const ctxFor = (events, over = {}) => ({
  secret: { key: KEY }, signal: new AbortController().signal, pollMs: 1,
  progress: (x) => events.push({ type: 'progress', ...x }),
  submitted: () => events.push({ type: 'submitted' }),
  ...over,
});

// 和真实管线（jobs.mjs）一样：先规范化参数（卡有自定义 normalize 就走它，否则按 ParamSpec），素材条件按素材角色算；没有内置卡的模型用通用卡
const flagsOf = (inputs) => ({ $edit: inputs.some((x) => x.role === 'edit'), $first: inputs.some((x) => x.role === 'first'), $last: inputs.some((x) => x.role === 'last'), $ref: inputs.some((x) => x.role === 'ref') });
const norm = (card, raw = {}, flags = {}) => (card.normalize ? card.normalize(raw, flags) : applySpecs(card.params, raw, flags));
function reqFor(kind, model, { prompt = '', raw = {}, inputs = [], thread = null } = {}) {
  const card = CARDS[model] || genericCard('ark', kind);
  return { kind, model, card: card.id, prompt, negative: '', params: norm(card, raw, flagsOf(inputs)), inputs, thread };
}

test('内置卡登记到 ark 方言，参数规范化后符合界面预期', () => {
  for (const [id, card] of Object.entries(CARDS)) {
    assert.ok(card.kind === 'image' || card.kind === 'video', id);
    assert.equal(dialectCards('ark', id)?.kind, card.kind, id);
  }
  // 2026-11-15：时长改成任意整数 + 「模型定时长」开关（默认开 = 发 -1，和以前默认 -1 一致）；新开关 / 枚举的默认都是文档默认（不进请求体）
  assert.deepEqual(norm(CARDS['doubao-seedance-2-5-260628'], {}),
    { aspectRatio: 'adaptive', resolution: '720p', autoDuration: true, generateAudio: true, watermark: false, priority: 0, outputFormat: 'mp4', omniReferenceTaskType: 'auto' });
  assert.deepEqual(norm(CARDS['doubao-seedream-5-0-pro-260628'], {}),
    { size: '2K', outputFormat: 'jpeg', background: 'opaque', watermark: true, promptMode: 'standard' });
  // 时长夹进 2–12（99 → 12）；比例默认不传（以前固定 16:9，会盖掉图生视频的 adaptive 默认）；种子、固定镜头照常
  assert.deepEqual(norm(CARDS['doubao-seedance-1-0-pro-250528'], { durationSeconds: 99, seed: 42, cameraFixed: true }),
    { resolution: '1080p', useFrames: false, durationSeconds: 12, cameraFixed: true, seed: 42, watermark: false, serviceTier: 'default' });
});

test('test() 先查任务列表（只读 GET，分页 1 条）：200 即 Key 有效，不发任何生成请求', async () => {
  const f = installFetch(() => json({ items: [], total: 0 }, 200));
  try {
    const r = await arkAdapter.test(provider(), ctxFor([]));
    assert.match(r.detail, /Key 有效/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls[0].url, `${BASE}/contents/generations/tasks?page_num=1&page_size=1`);
  } finally { f.restore(); }
});

test('test() 列表接口 404 时退到保险丝（不带 model、size 非法），400 即视为 Key 有效', async () => {
  const f = installFetch((c) => (c.url.includes('/contents/generations/tasks') ? json({ error: { message: 'not found' } }, 404) : json({ error: { code: 'InvalidParameter', message: 'size is invalid' } }, 400)));
  try {
    const r = await arkAdapter.test(provider(), ctxFor([]));
    assert.match(r.detail, /Key 有效/);
    assert.equal(f.calls.length, 2);
    const c = f.calls[1];
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `${BASE}/images/generations`);
    assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(c.body.size, 'ZZZ');
    assert.equal('model' in c.body, false);
  } finally { f.restore(); }
});

test('test() 把 401 / 403 映射成 API Key 无效，不碰生成接口', async () => {
  for (const status of [401, 403]) {
    const f = installFetch(() => json({ error: { message: 'nope' } }, status));
    try {
      await assert.rejects(arkAdapter.test(provider(), ctxFor([])),
        (e) => e instanceof AdapterError && e.status === status && /API Key 无效/.test(e.message));
      assert.ok(f.calls.every((c) => c.method === 'GET' && !c.url.includes('/images/generations')));
    } finally { f.restore(); }
  }
});

test('没有 Key 时 test / run 直接报人话，不发请求', async () => {
  const f = installFetch(() => { throw new Error('should not fetch'); });
  try {
    await assert.rejects(arkAdapter.test(provider(), { secret: {} }), /还没填 API Key/);
    await assert.rejects(arkAdapter.run(reqFor('image', 'doubao-seedream-5-0-flash-260915', { prompt: 'x' }), provider(), { secret: {} }), /还没填 API Key/);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('listModels 返回空列表，且不发请求（文档没有模型列表接口）', async () => {
  const f = installFetch(() => { throw new Error('should not fetch'); });
  try {
    assert.deepEqual(await arkAdapter.listModels(provider(), ctxFor([])), []);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('图像请求体：鉴权、data URI 参考图、档位尺寸；provider.params 盖过卡上参数，额外参数盖过 provider.params', async () => {
  const events = [];
  const f = installFetch(() => json({ model: 'doubao-seedream-5-0-pro-260628', data: [{ b64_json: PNG.toString('base64'), output_format: 'png', size: '2048x2048' }] }), events);
  try {
    const req = reqFor('image', 'doubao-seedream-5-0-pro-260628', {
      prompt: '一只猫', raw: { size: '1.5K', promptMode: 'fast', extra: { seed: 9, guidance_scale: 2.5 } },
      inputs: [
        { role: 'edit', data: Buffer.from('a'), mime: 'image/png', name: 'a.png' },
        { role: 'ref', data: Buffer.from('b'), mime: 'image/jpeg', name: 'b.jpg' },
      ],
    });
    const out = await arkAdapter.run(req, provider({ params: { seed: 7, watermark: false } }), ctxFor(events));
    const c = f.calls[0];
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `${BASE}/images/generations`);
    assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(c.body.model, 'doubao-seedream-5-0-pro-260628');
    assert.equal(c.body.prompt, '一只猫');
    assert.equal(c.body.size, '1.5K');
    assert.equal(c.body.output_format, 'jpeg');
    assert.equal(c.body.response_format, 'b64_json');
    assert.equal(c.body.watermark, false);   // provider.params 盖过卡上的默认 true
    assert.deepEqual(c.body.optimize_prompt_options, { mode: 'fast' });
    assert.equal(c.body.seed, 9);            // 额外参数盖过 provider.params 里的 7
    assert.equal(c.body.guidance_scale, 2.5);
    assert.deepEqual(c.body.image, [dataUrl(Buffer.from('a'), 'image/png'), dataUrl(Buffer.from('b'), 'image/jpeg')]);
    // 同步出图是秒级短请求：不标「发出去收不回」（限流 429 时任务执行器还能重试）
    assert.equal(events.filter((e) => e.type === 'submitted').length, 0);
    assert.deepEqual(out.assets[0].bytes, PNG);
    assert.equal(out.assets[0].mime, 'image/png');
    assert.equal(out.assets[0].meta.size, '2048x2048');
  } finally { f.restore(); }
});

test('单张参考图是一个字符串；URL 结果会再下载一次', async () => {
  const f = installFetch((c) => {
    if (c.method === 'POST') return json({ data: [{ url: 'https://cdn.example.com/out.jpg', size: '2048x2048', output_format: 'jpeg' }] });
    return bin(Buffer.from('JPEGBYTES'), 'image/jpeg');
  });
  try {
    const req = reqFor('image', 'doubao-seedream-5-0-flash-260915', {
      prompt: '换背景', raw: { extra: { response_format: 'url' } },
      inputs: [{ role: 'ref', data: PNG, mime: 'image/png', name: 'r.png' }],
    });
    const out = await arkAdapter.run(req, provider(), ctxFor([]));
    assert.equal(f.calls[0].body.image, dataUrl(PNG, 'image/png'));
    assert.equal(f.calls[0].body.response_format, 'url');   // 额外参数覆盖了默认的 b64_json
    assert.equal(f.calls[1].url, 'https://cdn.example.com/out.jpg');
    assert.equal(f.calls[1].method, 'GET');
    assert.deepEqual(out.assets[0].bytes, Buffer.from('JPEGBYTES'));
    assert.equal(out.assets[0].mime, 'image/jpeg');
  } finally { f.restore(); }
});

test('续改且没给素材：拿续改链上最后一张当参考图', async () => {
  const f = installFetch(() => json({ data: [{ b64_json: PNG.toString('base64'), output_format: 'png' }] }));
  try {
    const req = reqFor('image', 'doubao-seedream-5-0-flash-260915', {
      prompt: '改成红色',
      thread: { turns: [
        { userText: '画一只猫', data: Buffer.from('first'), mime: 'image/webp' },
        { userText: '改成蓝色', data: Buffer.from('last'), mime: 'image/png' },
      ] },
    });
    await arkAdapter.run(req, provider(), ctxFor([]));
    assert.equal(f.calls[0].body.image, dataUrl(Buffer.from('last'), 'image/png'));
  } finally { f.restore(); }
});

test('图像报错保留上游原话：4xx 原文透出，401 提 API Key，没出图时带上 error', async () => {
  const cases = [
    [() => json({ error: { code: 'InvalidParameter', message: 'size 不合法' } }, 422), /size 不合法/],
    [() => json({ error: { message: 'bad key' } }, 401), /API Key/],
    [() => json({ data: [], error: { code: 'OutputImageSensitiveContentDetected', message: '内容未通过审核' } }), /内容未通过审核/],
  ];
  for (const [handle, re] of cases) {
    const f = installFetch(handle);
    try {
      await assert.rejects(arkAdapter.run(reqFor('image', 'doubao-seedream-5-0-flash-260915', { prompt: 'x' }), provider(), ctxFor([])), re);
    } finally { f.restore(); }
  }
});

test('未知图像模型走通用卡：比例换成像素尺寸，且都落在 Seedream 的像素区间里', async () => {
  for (const ratio of ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']) {
    const f = installFetch(() => json({ data: [{ b64_json: PNG.toString('base64'), output_format: 'jpeg' }] }));
    try {
      await arkAdapter.run(reqFor('image', 'doubao-future-image-9', {
        prompt: 'x', raw: { aspectRatio: ratio, extra: { sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 3 } } },
      }), provider(), ctxFor([]));
      const b = f.calls[0].body;
      const [w, h] = b.size.split('x').map(Number);
      const [a, z] = ratio.split(':').map(Number);
      assert.ok(w * h >= 3686400 && w * h <= 4624220, `${ratio} → ${b.size}`);
      assert.ok(Math.abs(w / h - a / z) < 0.01, `${ratio} → ${b.size}`);
      assert.equal(b.model, 'doubao-future-image-9');
      assert.equal(b.sequential_image_generation, 'auto');   // 额外参数（组图）原样透传
      assert.equal('image' in b, false);
    } finally { f.restore(); }
  }
  // 比例 auto（模型自选）：不传 size
  const f = installFetch(() => json({ data: [{ b64_json: PNG.toString('base64') }] }));
  try {
    await arkAdapter.run(reqFor('image', 'doubao-future-image-9', { prompt: 'x' }), provider(), ctxFor([]));
    assert.equal('size' in f.calls[0].body, false);
  } finally { f.restore(); }
});

test('视频：提交 → 排队 → 运行 → 成功；进度带阶段文字；submitted 在拿到任务 id 之后；结果是 mp4', { timeout: 10_000 }, async () => {
  const TASK = 'cgt-20261104-0001';
  const seq = ['queued', 'running', 'succeeded'];
  let gets = 0;
  const events = [];
  const f = installFetch((c) => {
    if (c.method === 'POST' && c.url === `${BASE}/contents/generations/tasks`) return json({ id: TASK });
    if (c.method === 'GET' && c.url === `${BASE}/contents/generations/tasks/${TASK}`) {
      const status = seq[Math.min(gets++, seq.length - 1)];
      return json(status === 'succeeded'
        ? { id: TASK, model: 'doubao-seedance-2-5-260628', status, content: { video_url: 'https://tos.example.com/v.mp4' }, duration: 5, resolution: '720p', ratio: '16:9', seed: 42, generate_audio: true }
        : { id: TASK, status });
    }
    if (c.method === 'GET' && c.url === 'https://tos.example.com/v.mp4') return bin(Buffer.from('MP4DATA'), 'video/mp4');
    return json({ error: { message: `unexpected ${c.method} ${c.url}` } }, 404);
  }, events);
  try {
    const req = reqFor('video', 'doubao-seedance-2-5-260628', { prompt: '海边日落', raw: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 5 } });
    const out = await arkAdapter.run(req, provider(), ctxFor(events));
    const create = f.calls[0];
    assert.equal(create.method, 'POST');
    assert.equal(create.body.model, 'doubao-seedance-2-5-260628');
    assert.deepEqual(create.body.content, [{ type: 'text', text: '海边日落' }]);
    assert.equal(create.body.ratio, '16:9');
    assert.equal(create.body.resolution, '720p');
    assert.equal(create.body.duration, 5);
    assert.equal(create.body.generate_audio, true);
    assert.equal(create.body.watermark, false);
    const notes = events.filter((e) => e.type === 'progress').map((e) => e.note);
    assert.ok(notes.includes('排队中') && notes.includes('生成中'), notes.join(','));
    assert.equal(events.filter((e) => e.type === 'submitted').length, 1);
    assert.ok(events.findIndex((e) => e.type === 'submitted') > events.findIndex((e) => e.type === 'fetch' && e.method === 'POST'));
    assert.deepEqual(out.assets[0].bytes, Buffer.from('MP4DATA'));
    assert.equal(out.assets[0].mime, 'video/mp4');
    assert.equal(out.assets[0].meta.duration, 5);
  } finally { f.restore(); }
});

test('首帧 / 尾帧映射成 first_frame / last_frame；参考图和首尾帧混用直接拒绝，不发请求', { timeout: 10_000 }, async () => {
  const f = installFetch(() => json({ error: { message: 'stop here' } }, 400));
  try {
    const first = { role: 'first', data: Buffer.from('f'), mime: 'image/png', name: 'f.png' };
    const last = { role: 'last', data: Buffer.from('l'), mime: 'image/png', name: 'l.png' };
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-0-260128', { prompt: 'x', inputs: [first, last] }), provider(), ctxFor([])), /stop here/);
    const content = f.calls[0].body.content;
    assert.deepEqual(content.slice(1).map((x) => x.role), ['first_frame', 'last_frame']);
    assert.equal(content[1].image_url.url, dataUrl(Buffer.from('f'), 'image/png'));
    const before = f.calls.length;
    const ref = { role: 'ref', data: Buffer.from('r'), mime: 'image/png', name: 'r.png' };
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-0-260128', { prompt: 'x', inputs: [first, ref] }), provider(), ctxFor([])), /不能混用/);
    assert.equal(f.calls.length, before);
  } finally { f.restore(); }
});

test('任务失败：把上游原因带出来；终态不发取消请求', { timeout: 10_000 }, async () => {
  const f = installFetch((c) => {
    if (c.method === 'POST') return json({ id: 'cgt-fail-1' });
    if (c.method === 'GET') return json({ id: 'cgt-fail-1', status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: '内容审核未通过' } });
    return json({ error: { message: `unexpected ${c.method}` } }, 404);
  });
  try {
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x' }), provider(), ctxFor([])), /内容审核未通过/);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
  } finally { f.restore(); }
});

test('排队中途取消：发一次 DELETE 尽力取消，run 以 aborted 结束', { timeout: 10_000 }, async () => {
  const ac = new AbortController();
  const f = installFetch((c) => {
    if (c.method === 'POST') return json({ id: 'cgt-abort-1' });
    if (c.method === 'GET') { ac.abort(); return json({ id: 'cgt-abort-1', status: 'queued' }); }
    if (c.method === 'DELETE') return json({});
    return json({ error: { message: `unexpected ${c.method}` } }, 404);
  });
  try {
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x' }), provider(), ctxFor([], { signal: ac.signal })),
      (e) => e instanceof AdapterError && e.code === 'aborted');
    const del = f.calls.filter((c) => c.method === 'DELETE');
    assert.equal(del.length, 1);
    assert.equal(del[0].url, `${BASE}/contents/generations/tasks/cgt-abort-1`);
  } finally { f.restore(); }
});

test('轮询时遇到 503 不算失败，下一轮照常查', { timeout: 10_000 }, async () => {
  let gets = 0;
  const f = installFetch((c) => {
    if (c.method === 'POST') return json({ id: 'cgt-flaky-1' });
    if (c.method === 'GET' && c.url.endsWith('/cgt-flaky-1')) {
      gets++;
      if (gets === 1) return json({ error: { message: 'busy' } }, 503);
      return json({ id: 'cgt-flaky-1', status: 'succeeded', content: { video_url: 'https://tos.example.com/f.mp4' } });
    }
    return bin(Buffer.from('MP4'), 'video/mp4');
  });
  try {
    const out = await arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x' }), provider(), ctxFor([]));
    assert.equal(gets, 2);
    assert.deepEqual(out.assets[0].bytes, Buffer.from('MP4'));
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
  } finally { f.restore(); }
});

test('Seedance 1.0 pro：种子和固定镜头发出去，没有 generate_audio', { timeout: 10_000 }, async () => {
  const f = installFetch(() => json({ error: { message: 'stop' } }, 400));
  try {
    const req = reqFor('video', 'doubao-seedance-1-0-pro-250528', {
      prompt: 'x', raw: { seed: 42, cameraFixed: true },
      inputs: [{ role: 'first', data: Buffer.from('f'), mime: 'image/jpeg', name: 'f.jpg' }],
    });
    await assert.rejects(arkAdapter.run(req, provider(), ctxFor([])), /stop/);
    const b = f.calls[0].body;
    assert.equal(b.seed, 42);
    assert.equal(b.camera_fixed, true);
    assert.equal(b.resolution, '1080p');
    assert.equal(b.duration, 5);
    assert.equal('ratio' in b, false);   // 2026-11-15：比例默认不传，交给服务端（图生视频默认 adaptive）
    assert.equal('generate_audio' in b, false);
    assert.equal(b.content[1].role, 'first_frame');
  } finally { f.restore(); }
});

test('未知视频模型走通用卡：比例和时长映射，额外参数和 provider.params 原样合并', { timeout: 10_000 }, async () => {
  const f = installFetch(() => json({ error: { message: 'stop' } }, 400));
  try {
    const req = reqFor('video', 'doubao-seedance-future', {
      prompt: '雨夜街道', raw: { aspectRatio: '9:16', durationSeconds: 6, extra: { resolution: '1080p' } },
      inputs: [{ role: 'first', data: Buffer.from('f'), mime: 'image/png', name: 'f.png' }],
    });
    await assert.rejects(arkAdapter.run(req, provider({ params: { service_tier: 'flex' } }), ctxFor([])), /stop/);
    const b = f.calls[0].body;
    assert.equal(b.model, 'doubao-seedance-future');
    assert.equal(b.ratio, '9:16');
    assert.equal(b.duration, 6);
    assert.equal(b.resolution, '1080p');
    assert.equal(b.service_tier, 'flex');
    assert.equal(b.content[1].role, 'first_frame');
  } finally { f.restore(); }
});

// —— 2026-11-15：参数补全 ——
const stop = () => installFetch(() => json({ error: { message: 'stop' } }, 400));
const img = (role, d = 'x', mime = 'image/png') => ({ role, data: Buffer.from(d), mime, name: `${role}.png` });

test('Seedance 时长：区间内任意整数；默认「模型定时长」发 -1；旧写法 -1 / 只给时长照旧；2.5 有首帧时只能自适应', { timeout: 10_000 }, async () => {
  const c25 = CARDS['doubao-seedance-2-5-260628'], c20 = CARDS['doubao-seedance-2-0-260128'];
  assert.equal(norm(c25, { durationSeconds: 7 }).durationSeconds, 7);
  assert.equal(norm(c25, { durationSeconds: 40 }).durationSeconds, 30);
  assert.equal(norm(c20, { durationSeconds: 40 }).durationSeconds, 15);
  assert.deepEqual([norm(c25, { durationSeconds: -1 }).autoDuration, norm(c25, { durationSeconds: -1 }).durationSeconds], [true, undefined]);
  assert.equal(norm(c25, { autoDuration: true, durationSeconds: 9 }).durationSeconds, undefined);
  assert.equal(norm(c25, { aspectRatio: '16:9' }, { $first: true }).aspectRatio, 'adaptive');
  assert.equal(norm(c20, { aspectRatio: '16:9' }, { $first: true }).aspectRatio, '16:9');
  const f = stop();
  try {
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x' }), provider(), ctxFor([])), /stop/);
    assert.equal(f.calls[0].body.duration, -1);
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-0-260128', { prompt: 'x', raw: { durationSeconds: 11 } }), provider(), ctxFor([])), /stop/);
    assert.equal(f.calls[1].body.duration, 11);
  } finally { f.restore(); }
});

test('Seedance 新字段：默认都不进请求体；返回尾帧 / 联网 / 优先级 / 样片（强制 480p）/ MOV / 参考任务类型照发', { timeout: 10_000 }, async () => {
  const f = stop();
  try {
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x' }), provider(), ctxFor([])), /stop/);
    for (const k of ['return_last_frame', 'tools', 'priority', 'draft', 'output_format', 'omni_reference_task_type', 'service_tier', 'frames']) assert.equal(k in f.calls[0].body, false, k);
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x', raw: {
      resolution: '1080p', returnLastFrame: true, webSearch: true, priority: 6, draft: true, outputFormat: 'mov', omniReferenceTaskType: 'extend',
    } }), provider(), ctxFor([])), /stop/);
    const b = f.calls[1].body;
    assert.equal(b.return_last_frame, true);
    assert.deepEqual(b.tools, [{ type: 'web_search' }]);
    assert.equal(b.priority, 6);
    assert.equal(b.draft, true);
    assert.equal(b.resolution, '480p');
    assert.equal(b.output_format, 'mov');
    assert.equal(b.omni_reference_task_type, 'extend');
    // 2.0 没有 2.5 专有的三项
    const keys = CARDS['doubao-seedance-2-0-260128'].params.map((s) => s.key);
    assert.ok(!['draft', 'outputFormat', 'omniReferenceTaskType'].some((k) => keys.includes(k)));
  } finally { f.restore(); }
});

test('Seedance 1.0 pro：按帧数发 frames（落到 25+4n）不发 duration；离线档发 service_tier', { timeout: 10_000 }, async () => {
  const f = stop();
  try {
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-1-0-pro-250528', { prompt: 'x', raw: { frames: 100, serviceTier: 'flex' } }), provider(), ctxFor([])), /stop/);
    const b = f.calls[0].body;
    assert.equal(b.frames, 101);
    assert.equal('duration' in b, false);
    assert.equal(b.service_tier, 'flex');
  } finally { f.restore(); }
});

test('返回尾帧：成功后多一个图片产出（meta.kind image、role lastFrame）；查询结果没给尾帧地址时只有视频', { timeout: 10_000 }, async () => {
  for (const withFrame of [true, false]) {
    const f = installFetch((c) => {
      if (c.method === 'POST') return json({ id: 'cgt-lf' });
      if (c.url.endsWith('/cgt-lf')) return json({ id: 'cgt-lf', status: 'succeeded', content: { video_url: 'https://tos.example.com/v.mp4', ...(withFrame ? { last_frame_url: 'https://tos.example.com/last.jpg' } : {}) } });
      if (c.url.endsWith('v.mp4')) return bin(Buffer.from('MP4'), 'video/mp4');
      return bin(Buffer.from('JPG'), 'image/jpeg');
    });
    try {
      const out = await arkAdapter.run(reqFor('video', 'doubao-seedance-2-0-260128', { prompt: 'x', raw: { returnLastFrame: true } }), provider(), ctxFor([]));
      assert.equal(out.assets.length, withFrame ? 2 : 1);
      assert.equal(out.assets[0].mime, 'video/mp4');
      if (withFrame) {
        assert.deepEqual(out.assets[1].bytes, Buffer.from('JPG'));
        assert.equal(out.assets[1].mime, 'image/jpeg');
        assert.equal(out.assets[1].meta.role, 'lastFrame');
        assert.equal(out.assets[1].meta.kind, 'image');
      }
    } finally { f.restore(); }
  }
});

test('参考视频 / 参考音频 → video_url / audio_url 项；和首帧混用、2.0 只给音频都直接 400（不发请求）', { timeout: 10_000 }, async () => {
  const c25 = CARDS['doubao-seedance-2-5-260628'], c20 = CARDS['doubao-seedance-2-0-260128'];
  assert.deepEqual([c25.inputs.video.max, c25.inputs.audio.max, c20.inputs.video.max, c20.inputs.audio.max], [10, 10, 3, 3]);
  const video = { role: 'video', data: Buffer.from('v'), mime: 'video/mp4', name: 'v.mp4' };
  const audio = { role: 'audio', data: Buffer.from('a'), mime: 'audio/mpeg', name: 'a.mp3' };
  const f = stop();
  try {
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-0-260128', { prompt: '@Video1 的动作', inputs: [img('ref'), video, audio] }), provider(), ctxFor([])), /stop/);
    const content = f.calls[0].body.content;
    assert.deepEqual(content.slice(1).map((x) => [x.type, x.role]), [['image_url', 'reference_image'], ['video_url', 'reference_video'], ['audio_url', 'reference_audio']]);
    assert.equal(content[2].video_url.url, dataUrl(Buffer.from('v'), 'video/mp4'));
    assert.equal(content[3].audio_url.url, dataUrl(Buffer.from('a'), 'audio/mpeg'));
    // 2.5 可以只给音频
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x', inputs: [audio] }), provider(), ctxFor([])), /stop/);
    const n = f.calls.length;
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-0-260128', { prompt: 'x', inputs: [audio] }), provider(), ctxFor([])), (e) => e.status === 400 && /单独/.test(e.message));
    await assert.rejects(arkAdapter.run(reqFor('video', 'doubao-seedance-2-5-260628', { prompt: 'x', inputs: [img('first'), video] }), provider(), ctxFor([])), (e) => e.status === 400 && /混用/.test(e.message));
    assert.equal(f.calls.length, n);
  } finally { f.restore(); }
});


test('Seedream 背景：等于默认不发（5.0 = 不透明、5.5 = 自动）；5.5 卡默认 PNG、没有提示词快速档', async () => {
  const c55 = CARDS['doubao-seedream-5-5-261028'];
  assert.equal(dialectCards('ark', 'doubao-seedream-5-5-261028')?.kind, 'image');
  assert.deepEqual(norm(c55, {}), { size: '2K', outputFormat: 'png', background: 'auto', watermark: true });
  const flashBg = CARDS['doubao-seedream-5-0-flash-260915'].params.find((s) => s.key === 'background').options.map((o) => o.value);
  assert.deepEqual(flashBg, ['opaque', 'transparent']);
  const f = installFetch(() => json({ data: [{ b64_json: PNG.toString('base64'), output_format: 'png' }] }));
  try {
    const run = (model, raw) => arkAdapter.run(reqFor('image', model, { prompt: 'x', raw }), provider(), ctxFor([]));
    await run('doubao-seedream-5-0-flash-260915', {});
    await run('doubao-seedream-5-0-flash-260915', { background: 'transparent' });
    await run('doubao-seedream-5-5-261028', {});
    await run('doubao-seedream-5-5-261028', { background: 'opaque' });
    assert.deepEqual(f.calls.map((c) => c.body.background), [undefined, 'transparent', undefined, 'opaque']);
    assert.equal(f.calls[2].body.output_format, 'png');
  } finally { f.restore(); }
});
