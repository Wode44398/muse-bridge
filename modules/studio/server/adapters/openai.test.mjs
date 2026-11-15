// openai 方言单测：全程 mock 全局 fetch，不联网、不需要 Key（没有真打任何接口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiAdapter, CARDS } from './openai.mjs';
import { AdapterError } from './http.mjs';
import { applySpecs, genericCard } from '../cards/spec.mjs';
import { dialectCards, dialectBuiltinModels } from '../cards/dialects.mjs';

const BASE = 'https://api.test.example/v1';
const PROVIDER = (over = {}) => ({ id: 'p-test0001', owner: 'admin', dialect: 'openai', name: '测试服务', baseUrl: BASE, authStyle: 'bearer', headers: {}, params: {}, timeoutSec: 60, models: [], ...over });
const CTX = (over = {}) => ({ secret: { key: 'k' }, signal: new AbortController().signal, progress() {}, submitted() {}, pollMs: 1, ...over });
const IMG_REQ = (over = {}) => ({ kind: 'image', model: 'gpt-image-2.5-sunburst', prompt: '一只猫', params: {}, inputs: [], thread: null, ...over });

// 换掉全局 fetch：handler(url, init, calls) 返回 Response；calls 记下每次请求。结束后还原。
async function withFetch(handler, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', init });
    return handler(String(url), init, calls);
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const binRes = (bytes, type = 'application/octet-stream') => new Response(bytes, { status: 200, headers: { 'content-type': type } });
const bodyOf = (call) => JSON.parse(call.init.body);

test('种类与登记：kinds 与 presets 一致；内置卡登记进方言表；参数表合法', () => {
  assert.deepEqual(openaiAdapter.kinds, ['image', 'video', 'speech']);
  assert.equal(dialectCards('openai', 'gpt-image-2.5-sunburst')?.kind, 'image');
  assert.equal(dialectCards('openai', 'tts-1')?.kind, 'speech');
  assert.deepEqual(dialectBuiltinModels('openai').map((m) => m.id).sort(), Object.keys(CARDS).sort());
  for (const card of Object.values(CARDS)) {
    const last = card.params.at(-1);
    assert.equal(last.key, 'extra');
    assert.equal(last.type, 'json');
    for (const s of card.params.filter((x) => x.type === 'enum')) assert.ok(s.options.some((o) => o.value === s.default), `${card.id} 的 ${s.key} 默认值不在选项里`);
  }
});

test('test()：只调 GET /models（零成本，不发生成请求）；401 / 403 说 API Key 无效', async () => {
  await withFetch(() => jsonRes({ data: [{ id: 'gpt-image-2' }] }), async (calls) => {
    const r = await openaiAdapter.test(PROVIDER(), CTX());
    assert.match(r.detail, /连接正常/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${BASE}/models`);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  });
  for (const status of [401, 403]) {
    await withFetch(() => jsonRes({ error: { message: 'bad' } }, status), async () => {
      await assert.rejects(openaiAdapter.test(PROVIDER(), CTX()), (e) => e instanceof AdapterError && e.status === status && /API Key 无效/.test(e.message));
    });
  }
});

test('listModels：按 id 猜种类，猜不出的不列', async () => {
  const ids = ['gpt-image-2.5-sunburst', 'dall-e-3', 'tts-1', 'gpt-4o-mini-tts', 'sora-2', 'whisper-1', 'gpt-4o'];
  await withFetch(() => jsonRes({ data: ids.map((id) => ({ id })) }), async () => {
    const list = await openaiAdapter.listModels(PROVIDER(), CTX());
    assert.deepEqual(list.map((m) => [m.id, m.kind]), [['gpt-image-2.5-sunburst', 'image'], ['dall-e-3', 'image'], ['tts-1', 'speech'], ['gpt-4o-mini-tts', 'speech'], ['sora-2', 'video']]);
  });
});

test('没填 Key / 地址：直接给人话，不发请求；不支持的种类也直接拒', async () => {
  await withFetch(() => { throw new Error('不应发请求'); }, async (calls) => {
    await assert.rejects(openaiAdapter.run(IMG_REQ(), PROVIDER(), CTX({ secret: {} })), /还没填 API Key/);
    await assert.rejects(openaiAdapter.run(IMG_REQ(), PROVIDER({ baseUrl: '' }), CTX()), /还没填接口地址/);
    await assert.rejects(openaiAdapter.run({ ...IMG_REQ(), kind: 'music' }, PROVIDER(), CTX()), /不做 music/);
    assert.equal(calls.length, 0);
  });
});

test('生成：JSON 请求体与鉴权头；比例映射成 WxH；provider.params 再 extra 依次覆盖；结果 b64 解码', async () => {
  const png = Buffer.from('PNG-ONE');
  await withFetch(() => jsonRes({ created: 1, size: '1536x864', data: [{ b64_json: png.toString('base64') }] }), async (calls) => {
    const r = await openaiAdapter.run(IMG_REQ({ params: { aspectRatio: '16:9', quality: 'high', outputFormat: 'png', count: 2, extra: { quality: 'low', seed: 7 } } }),
      PROVIDER({ params: { quality: 'medium', tag: 'svc' } }), CTX());
    const c = calls[0];
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `${BASE}/images/generations`);
    assert.equal(c.init.headers.Authorization, 'Bearer k');
    assert.equal(c.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(bodyOf(c), { model: 'gpt-image-2.5-sunburst', prompt: '一只猫', n: 2, size: '1536x864', quality: 'low', output_format: 'png', tag: 'svc', seed: 7 });
    assert.equal(r.assets.length, 1);
    assert.deepEqual(r.assets[0].bytes, png);
    assert.equal(r.assets[0].mime, 'image/png');
  });
});

test('改图：有参考图走 multipart（image[] 文件 + 文本字段），不手写 JSON 头', async () => {
  await withFetch(() => jsonRes({ data: [{ b64_json: Buffer.from('OUT').toString('base64') }] }), async (calls) => {
    await openaiAdapter.run(IMG_REQ({ model: 'gpt-image-2', prompt: '换成夜景', params: { aspectRatio: '1:1' }, inputs: [
      { role: 'edit', data: Buffer.from('AAA'), mime: 'image/png', name: 'a.png' },
      { role: 'ref', data: Buffer.from('BBB'), mime: 'image/jpeg' },
    ] }), PROVIDER(), CTX());
    const c = calls[0];
    assert.equal(c.url, `${BASE}/images/edits`);
    assert.ok(c.init.body instanceof FormData);
    const files = c.init.body.getAll('image[]');
    assert.equal(files.length, 2);
    assert.equal(files[0].name, 'a.png');
    assert.equal(files[1].name, 'image2.jpg');
    assert.equal(await files[1].text(), 'BBB');
    assert.equal(c.init.body.get('prompt'), '换成夜景');
    assert.equal(c.init.body.get('model'), 'gpt-image-2');
    assert.equal(c.init.body.get('size'), '1024x1024');
    assert.equal(c.init.headers['Content-Type'], undefined);   // multipart 的 boundary 由 fetch 自己带
    assert.equal(c.init.headers.Authorization, 'Bearer k');
  });
});

test('续改：没给素材时，拿续改链上一张当参考图（走 edits）', async () => {
  await withFetch(() => jsonRes({ data: [{ b64_json: 'AA==' }] }), async (calls) => {
    await openaiAdapter.run(IMG_REQ({ prompt: '再暗一点', thread: { turns: [{ userText: '第一张', data: Buffer.from('PREV'), mime: 'image/png', signature: null }] } }), PROVIDER(), CTX());
    assert.equal(calls[0].url, `${BASE}/images/edits`);
    const files = calls[0].init.body.getAll('image[]');
    assert.equal(files.length, 1);
    assert.equal(await files[0].text(), 'PREV');
  });
});

test('结果是 URL：下载成字节，mime 取下载的 Content-Type；下载请求不带 Key', async () => {
  const handler = (url) => (url.startsWith(BASE)
    ? jsonRes({ output_format: 'webp', data: [{ url: 'https://cdn.example.test/a.webp' }] })
    : binRes(Buffer.from('WEBP'), 'image/webp'));
  await withFetch(handler, async (calls) => {
    const r = await openaiAdapter.run(IMG_REQ(), PROVIDER(), CTX());
    assert.equal(calls[1].url, 'https://cdn.example.test/a.webp');
    assert.equal(calls[1].init.headers.Authorization, undefined);
    assert.deepEqual(r.assets[0].bytes, Buffer.from('WEBP'));
    assert.equal(r.assets[0].mime, 'image/webp');
  });
});

test('固定三档的 GPT 图像模型（如 gpt-image-1.5）：16:9 → 1536x1024；auto 不传 size；不带 response_format', async () => {
  await withFetch(() => jsonRes({ data: [{ b64_json: 'AA==' }] }), async (calls) => {
    await openaiAdapter.run(IMG_REQ({ model: 'gpt-image-1.5', params: { aspectRatio: '16:9' } }), PROVIDER(), CTX());
    await openaiAdapter.run(IMG_REQ({ model: 'gpt-image-1.5', params: { aspectRatio: 'auto' } }), PROVIDER(), CTX());
    assert.equal(bodyOf(calls[0]).size, '1536x1024');
    assert.equal('size' in bodyOf(calls[1]), false);
    assert.equal('response_format' in bodyOf(calls[0]), false);
  });
});

test('gpt-image-2.5-flare 的自定义尺寸都满足文档约束（16 的倍数、长宽比 1:3–3:1、不超 3840x2160）', async () => {
  const sizes = [];
  await withFetch(() => jsonRes({ data: [{ b64_json: 'AA==' }] }), async (calls) => {
    for (const aspectRatio of ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']) {
      await openaiAdapter.run(IMG_REQ({ model: 'gpt-image-2.5-flare', params: { aspectRatio } }), PROVIDER(), CTX());
      sizes.push(bodyOf(calls.at(-1)).size);
    }
  });
  for (const size of sizes) {
    const [w, h] = size.split('x').map(Number);
    assert.equal(w % 16, 0, size);
    assert.equal(h % 16, 0, size);
    assert.ok(w / h <= 3 && h / w <= 3, size);
    assert.ok(w <= 3840 && h <= 2160, size);
  }
});

test('dall-e（已下线，只为兼容服务保留）：带 response_format=b64_json；9:16 → 1024x1792', async () => {
  await withFetch(() => jsonRes({ data: [{ b64_json: 'AA==' }] }), async (calls) => {
    await openaiAdapter.run(IMG_REQ({ model: 'dall-e-3', params: { aspectRatio: '9:16' } }), PROVIDER(), CTX());
    assert.equal(bodyOf(calls[0]).response_format, 'b64_json');
    assert.equal(bodyOf(calls[0]).size, '1024x1792');
  });
});

test('错误映射：401 说 API Key 无效；400 原话透出；429 说限流；500 说服务方出错', async () => {
  const cases = [
    [401, { error: { message: 'Incorrect API key provided' } }, /API Key 无效/],
    [400, { error: { message: "Invalid value: 'huge'." } }, /Invalid value: 'huge'/],
    [429, { error: { message: 'slow down' } }, /限流/],
    [500, { error: { message: 'boom' } }, /服务方出错/],
  ];
  for (const [status, body, re] of cases) {
    await withFetch(() => jsonRes(body, status), async () => {
      await assert.rejects(openaiAdapter.run(IMG_REQ(), PROVIDER(), CTX()), (e) => e instanceof AdapterError && e.status === status && re.test(e.message));
    });
  }
});

test('配音：POST /audio/speech；默认音色 alloy；响应字节原样收下，mime 按格式', async () => {
  const audio = Buffer.from('ID3-MP3');
  await withFetch(() => binRes(audio), async (calls) => {
    const r = await openaiAdapter.run({ kind: 'speech', model: 'tts-1', prompt: '你好', params: { format: 'mp3' }, inputs: [], thread: null }, PROVIDER(), CTX());
    assert.equal(calls[0].url, `${BASE}/audio/speech`);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(bodyOf(calls[0]), { model: 'tts-1', input: '你好', voice: 'alloy', response_format: 'mp3' });
    assert.deepEqual(r.assets[0].bytes, audio);
    assert.equal(r.assets[0].mime, 'audio/mpeg');
  });
});

test('配音：语气说明、语速进请求体；extra 覆盖音色（自定义音色对象）；pcm 带采样率', async () => {
  await withFetch(() => binRes(Buffer.from('PCM')), async (calls) => {
    const r = await openaiAdapter.run({ kind: 'speech', model: 'gpt-4o-mini-tts', prompt: '早上好', params: { voice: 'coral', instructions: '温柔一点', speed: 1.25, format: 'pcm', extra: { voice: { id: 'voice_1234' } } }, inputs: [], thread: null },
      PROVIDER({ params: { tag: 'svc' } }), CTX());
    assert.deepEqual(bodyOf(calls[0]), { model: 'gpt-4o-mini-tts', input: '早上好', voice: { id: 'voice_1234' }, response_format: 'pcm', speed: 1.25, instructions: '温柔一点', tag: 'svc' });
    assert.equal(r.assets[0].mime, 'audio/L16;rate=24000');
    assert.equal(r.assets[0].meta.sampleRate, 24000);
  });
});

test('视频（兼容服务按文档）：创建 → 运行（回进度）→ 完成 → 下载 MP4；首帧进 input_reference；submitted 只调一次', async () => {
  const mp4 = Buffer.from('MP4-DATA');
  const polls = [
    { id: 'vid_1', status: 'in_progress', progress: 50 },
    { id: 'vid_1', status: 'completed', progress: 100, seconds: '8', size: '1280x720' },
  ];
  const progress = [];
  let submitted = 0;
  const handler = (url) => {
    if (url === `${BASE}/videos`) return jsonRes({ id: 'vid_1', object: 'video', status: 'queued', progress: 0 });
    if (url === `${BASE}/videos/vid_1`) return jsonRes(polls.shift());
    if (url === `${BASE}/videos/vid_1/content`) return binRes(mp4, 'video/mp4');
    throw new Error('意外的请求 ' + url);
  };
  await withFetch(handler, async (calls) => {
    const r = await openaiAdapter.run({ kind: 'video', model: 'sora-2', prompt: '海浪', params: { aspectRatio: '16:9', durationSeconds: 8 }, inputs: [{ role: 'first', data: Buffer.from('PNGHEAD'), mime: 'image/png', name: 'f.png' }], thread: null },
      PROVIDER(), CTX({ progress: (x) => progress.push(x), submitted: () => { submitted += 1; } }));
    const create = bodyOf(calls[0]);
    assert.equal(calls[0].method, 'POST');
    assert.equal(create.model, 'sora-2');
    assert.equal(create.prompt, '海浪');
    assert.equal(create.seconds, '8');
    assert.equal(create.size, '1280x720');
    assert.equal(create.input_reference.image_url, `data:image/png;base64,${Buffer.from('PNGHEAD').toString('base64')}`);
    assert.equal(submitted, 1);
    assert.ok(progress.some((x) => x.progress === 0.5), '轮询中的进度应回报');
    assert.deepEqual(r.assets[0].bytes, mp4);
    assert.equal(r.assets[0].mime, 'video/mp4');
    assert.equal(r.assets[0].meta.durationSeconds, 8);
    assert.equal(calls.at(-1).url, `${BASE}/videos/vid_1/content`);
  });
});

test('视频失败状态：报「视频生成失败」，带服务方的原因', async () => {
  const handler = (url, init) => (init.method === 'POST'
    ? jsonRes({ id: 'vid_2', status: 'queued' })
    : jsonRes({ id: 'vid_2', status: 'failed', error: { code: 'moderation', message: '内容未通过审核' } }));
  await withFetch(handler, async () => {
    await assert.rejects(openaiAdapter.run({ kind: 'video', model: 'sora-2', prompt: 'x', params: {}, inputs: [], thread: null }, PROVIDER(), CTX()), /视频生成失败：内容未通过审核/);
  });
});

test('视频取消：轮询途中 abort，立即抛「已取消」，之后不再发请求（文档没有取消接口，不调 DELETE）', async () => {
  const ac = new AbortController();
  const handler = (url, init) => {
    if (init.method === 'POST') return jsonRes({ id: 'vid_3', status: 'queued' });
    ac.abort();   // 用户在第一次查状态时取消
    return jsonRes({ id: 'vid_3', status: 'in_progress', progress: 10 });
  };
  await withFetch(handler, async (calls) => {
    await assert.rejects(openaiAdapter.run({ kind: 'video', model: 'sora-2', prompt: 'x', params: {}, inputs: [], thread: null }, PROVIDER(), CTX({ signal: ac.signal })),
      (e) => e instanceof AdapterError && e.code === 'aborted');
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET']);
  });
});

test('视频只认首帧（first）：其它角色直接报错，不发请求', async () => {
  await withFetch(() => { throw new Error('不应发请求'); }, async (calls) => {
    await assert.rejects(openaiAdapter.run({ kind: 'video', model: 'sora-2', prompt: 'x', params: {}, inputs: [{ role: 'last', data: Buffer.from('x'), mime: 'image/png' }], thread: null }, PROVIDER(), CTX()), /只支持首帧/);
    assert.equal(calls.length, 0);
  });
});

test('未知模型走通用卡也能跑：卡上参数映射进请求体，extra 原样合并，视频时长取最近的合法档', async () => {
  const imgParams = applySpecs(genericCard('openai', 'image').params, { aspectRatio: '3:2', extra: { seed: 3 } });
  const speechParams = applySpecs(genericCard('openai', 'speech').params, { voice: 'nova' });
  const videoParams = applySpecs(genericCard('openai', 'video').params, { aspectRatio: '9:16', durationSeconds: 11 });
  const handler = (url) => {
    if (url.endsWith('/images/generations')) return jsonRes({ data: [{ b64_json: 'AA==' }] });
    if (url.endsWith('/audio/speech')) return binRes(Buffer.from('A'));
    if (url.endsWith('/videos')) return jsonRes({ id: 'v9', status: 'queued' });
    if (url.endsWith('/videos/v9')) return jsonRes({ id: 'v9', status: 'completed', progress: 100, seconds: '12', size: '720x1280' });
    return binRes(Buffer.from('MP4'), 'video/mp4');
  };
  await withFetch(handler, async (calls) => {
    await openaiAdapter.run({ kind: 'image', model: 'future-image-x', prompt: 'x', params: imgParams, inputs: [], thread: null }, PROVIDER(), CTX());
    await openaiAdapter.run({ kind: 'speech', model: 'future-tts-x', prompt: 'hi', params: speechParams, inputs: [], thread: null }, PROVIDER(), CTX());
    await openaiAdapter.run({ kind: 'video', model: 'future-video-x', prompt: 'x', params: videoParams, inputs: [], thread: null }, PROVIDER(), CTX());
    const img = bodyOf(calls[0]);
    const speech = bodyOf(calls[1]);
    const vid = bodyOf(calls[2]);
    assert.equal(img.model, 'future-image-x');
    assert.equal(img.size, '1536x1024');
    assert.equal(img.seed, 3);
    assert.equal(speech.voice, 'nova');
    assert.equal(vid.seconds, '12');
    assert.equal(vid.size, '720x1280');
  });
});

// —— 2026-11-15 参数补全：张数到 10、2.6 的 gif / svg 与构图规划、审核、透明背景跟格式联动 ——
const keysOf = (card) => card.params.map((s) => s.key);
const specOf = (card, k) => card.params.find((s) => s.key === k);
test('图像卡参数清单：2.6 有 gif / svg / 构图规划、画质到 max；2.5 无 gif / svg；gpt-image-2 标弃用、画质只到 high', () => {
  const c26 = CARDS['gpt-image-2.6-sunburst'];
  assert.deepEqual(keysOf(c26), ['size', 'quality', 'count', 'outputFormat', 'outputCompression', 'frameCount', 'frameDurationMs', 'background', 'moderation', 'complexity', 'extra']);
  assert.deepEqual(specOf(c26, 'quality').options.map((o) => o.value), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(specOf(c26, 'outputFormat').options.map((o) => o.value), ['png', 'jpeg', 'webp', 'gif', 'svg']);
  assert.deepEqual(specOf(c26, 'outputFormat').options.find((o) => o.value === 'svg').only, { $edit: false, $ref: false });
  assert.deepEqual([specOf(c26, 'count').max, specOf(c26, 'count').format, specOf(c26, 'count').group], [10, 'count', 'basic']);
  assert.equal(specOf(c26, 'outputFormat').group, 'basic');
  assert.deepEqual(specOf(c26, 'background').options.find((o) => o.value === 'transparent').only, { outputFormat: ['png', 'webp'] });
  assert.deepEqual(keysOf(CARDS['gpt-image-2.5-flare']), ['size', 'quality', 'count', 'outputFormat', 'outputCompression', 'background', 'moderation', 'extra']);
  assert.deepEqual(specOf(CARDS['gpt-image-2.5-flare'], 'outputFormat').options.map((o) => o.value), ['png', 'jpeg', 'webp']);
  const g2 = CARDS['gpt-image-2'];
  assert.match(g2.desc, /弃用.*2027-02-10/);
  assert.deepEqual(specOf(g2, 'quality').options.map((o) => o.value), ['auto', 'low', 'medium', 'high']);
  assert.equal(specOf(g2, 'complexity'), undefined);
  assert.ok(CARDS['gpt-4o-mini-tts-2025-12-15'].params.some((s) => s.key === 'instructions'));
});

test('图像卡规范化：svg 有改图对象 / 参考图时不可选（回落 png）、svg 时不给张数；压缩只 jpeg / webp；透明只 png / webp；每帧时长取整到 10', () => {
  const c = CARDS['gpt-image-2.6-flare'];
  const n = (raw, ctx) => c.normalize(raw, ctx);
  assert.deepEqual(n({ size: 'auto' }), { size: 'auto', quality: 'auto', count: 1, outputFormat: 'png', background: 'auto', moderation: 'auto' });
  const svg = n({ outputFormat: 'svg', count: 4, outputCompression: 50 });
  assert.equal(svg.outputFormat, 'svg');
  assert.equal('count' in svg, false, 'svg 只能一张');
  assert.equal('outputCompression' in svg, false);
  assert.equal(n({ outputFormat: 'svg' }, { $edit: true }).outputFormat, 'png', '有改图对象：svg 不成立');
  assert.equal(n({ outputFormat: 'svg' }, { $ref: true }).outputFormat, 'png');
  const gif = n({ outputFormat: 'gif', frameCount: 30, frameDurationMs: 333, count: 12 });
  assert.deepEqual([gif.frameCount, gif.frameDurationMs, gif.count], [16, 330, 10]);
  assert.equal(n({ outputFormat: 'jpeg', outputCompression: 60 }).outputCompression, 60);
  assert.equal('frameCount' in n({ outputFormat: 'png' }), false);
  assert.equal(n({ outputFormat: 'jpeg', background: 'transparent' }).background, 'auto', 'jpeg 不能透明');
  assert.equal(n({ outputFormat: 'webp', background: 'transparent' }).background, 'transparent');
  assert.equal(n({ moderation: 'low', complexity: 'medium' }).complexity, 'medium');
  assert.equal(n({ moderation: 'low' }).moderation, 'low');
});

test('图像请求体：gif 带帧数 / 每帧时长；svg 强制 n=1、不发压缩；审核默认不发、宽松才发；构图规划照发；gif / svg 的 mime 对', async () => {
  const gifBytes = Buffer.from('GIF89a....');
  await withFetch(() => jsonRes({ data: [{ b64_json: gifBytes.toString('base64') }, { b64_json: gifBytes.toString('base64') }] }), async (calls) => {
    const r = await openaiAdapter.run(IMG_REQ({ model: 'gpt-image-2.6-sunburst', params: { size: 'auto', quality: 'high', count: 2, outputFormat: 'gif', outputCompression: 80, frameCount: 6, frameDurationMs: 120, background: 'auto', moderation: 'auto', complexity: 'low' } }), PROVIDER(), CTX());
    assert.deepEqual(bodyOf(calls[0]), { model: 'gpt-image-2.6-sunburst', prompt: '一只猫', n: 2, quality: 'high', background: 'auto', output_format: 'gif', frame_count: 6, frame_duration_ms: 120, complexity: 'low' });
    assert.deepEqual(r.assets.map((a) => a.mime), ['image/gif', 'image/gif']);
  });
  await withFetch(() => jsonRes({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }), async (calls) => {
    const r = await openaiAdapter.run(IMG_REQ({ model: 'gpt-image-2.6-sunburst', params: { outputFormat: 'svg', count: 3, outputCompression: 50, moderation: 'low', extra: { n: 4, output_compression: 10 } } }), PROVIDER(), CTX());
    const b = bodyOf(calls[0]);
    assert.deepEqual([b.n, 'output_compression' in b, b.moderation, b.output_format], [1, false, 'low', 'svg']);
    assert.equal(r.assets[0].mime, 'image/svg+xml');
  });
  await withFetch(() => { throw new Error('不应发请求'); }, async () => {
    await assert.rejects(openaiAdapter.run(IMG_REQ({ model: 'gpt-image-2.6-sunburst', params: { outputFormat: 'svg' }, inputs: [{ role: 'edit', data: Buffer.from('A'), mime: 'image/png' }] }), PROVIDER(), CTX()), (e) => e.status === 400 && /SVG/.test(e.message));
  });
  // 压缩只对 jpeg / webp：png 时不发
  await withFetch(() => jsonRes({ data: [{ b64_json: 'AA==' }] }), async (calls) => {
    await openaiAdapter.run(IMG_REQ({ params: { outputFormat: 'png', outputCompression: 50 } }), PROVIDER(), CTX());
    assert.equal('output_compression' in bodyOf(calls[0]), false);
  });
});

test('配音：voice_ 开头的自定义音色 id 发成 { id } 对象；内置音色照旧是名字', async () => {
  await withFetch(() => binRes(Buffer.from('MP3')), async (calls) => {
    await openaiAdapter.run({ kind: 'speech', model: 'gpt-4o-mini-tts-2025-12-15', prompt: '你好', params: { voice: 'voice_abc123' }, inputs: [], thread: null }, PROVIDER(), CTX());
    await openaiAdapter.run({ kind: 'speech', model: 'gpt-4o-mini-tts', prompt: '你好', params: { voice: 'marin' }, inputs: [], thread: null }, PROVIDER(), CTX());
    assert.deepEqual(bodyOf(calls[0]).voice, { id: 'voice_abc123' });
    assert.equal(bodyOf(calls[0]).model, 'gpt-4o-mini-tts-2025-12-15');
    assert.equal(bodyOf(calls[1]).voice, 'marin');
  });
});
