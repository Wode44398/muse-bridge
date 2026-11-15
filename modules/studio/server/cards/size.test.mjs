// 尺寸能力（方案 §10）：规则校验、原图适配、上游编码，以及各方言接上之后的请求体。全程 mock fetch，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, sizeProblems, sizeError, fitSize, originalSize, encodeSizeParams, imageDims } from './size.mjs';
import { applySpecs, P } from './spec.mjs';
import { cardFor } from './index.mjs';
import { CARDS as OPENAI, FLEX_RULE, openaiAdapter } from '../adapters/openai.mjs';
import { CARDS as ARK, SEEDREAM5_RULE, arkAdapter } from '../adapters/ark.mjs';
import { applyEditDefaults } from '../jobs.mjs';

// 只有文件头的 PNG（imageDims 只读 IHDR 里的宽高）
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
async function withFetch(handler, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const ok = () => new Response(JSON.stringify({ data: [{ b64_json: 'AA==' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const OAI = { id: 'p-oai00001', owner: 'admin', dialect: 'openai', name: '中转', baseUrl: 'https://relay.example.test/v1', authStyle: 'bearer', headers: {}, params: {}, models: [] };
const CTX = { secret: { key: 'k' }, signal: new AbortController().signal, progress() {}, submitted() {} };

test('parseSize：对象、WxH、W*H、W×H 都认；别的回 null', () => {
  assert.deepEqual(parseSize({ width: 2048, height: 1152 }), { width: 2048, height: 1152 });
  assert.deepEqual(parseSize('1536x864'), { width: 1536, height: 864 });
  assert.deepEqual(parseSize('1024*1024'), { width: 1024, height: 1024 });
  assert.deepEqual(parseSize('1024×1536'), { width: 1024, height: 1536 });
  for (const bad of ['2K', 'auto', '', null, { width: 0, height: 5 }, { width: 1.5, height: 2 }, '0x10']) assert.equal(parseSize(bad), null, String(bad));
});

test('规则校验：倍数、边长、宽高比、总像素；exact:false 不查倍数', () => {
  assert.deepEqual(sizeProblems(FLEX_RULE, { width: 2048, height: 1152 }), []);
  assert.equal(sizeProblems(FLEX_RULE, { width: 2000, height: 1000 })[0].code, 'multiple');
  assert.equal(sizeProblems(FLEX_RULE, { width: 4096, height: 1024 })[0].code, 'max');
  assert.ok(sizeProblems(FLEX_RULE, { width: 3840, height: 1024 }).some((p) => p.code === 'aspect'), '3.75:1 超出 3:1');
  assert.ok(sizeProblems(FLEX_RULE, { width: 512, height: 512 }).some((p) => p.code === 'pixels'), '低于 655360 像素');
  assert.equal(sizeError(FLEX_RULE, { width: 2000, height: 1000 }), '宽和高都要是 16 的倍数');
  assert.deepEqual(sizeProblems({ ...FLEX_RULE, exact: false }, { width: 2000, height: 1000 }), []);
});

test('原图适配：合规的原样、不合规的挪进规则且保持比例最接近', () => {
  assert.deepEqual(fitSize(FLEX_RULE, { width: 2048, height: 1152 }), { width: 2048, height: 1152, adapted: false });
  const a = fitSize(FLEX_RULE, { width: 1920, height: 1080 });   // 1080 不是 16 的倍数
  assert.equal(a.adapted, true); assert.equal(a.width % 16, 0); assert.equal(a.height % 16, 0);
  assert.ok(Math.abs(a.width / a.height - 16 / 9) < 0.02, `${a.width}x${a.height}`);
  const small = fitSize(FLEX_RULE, { width: 640, height: 480 });   // 低于最低像素：等比放大
  assert.deepEqual(sizeProblems(FLEX_RULE, small), []);
  assert.ok(Math.abs(small.width / small.height - 4 / 3) < 0.03);
  const huge = fitSize(FLEX_RULE, { width: 6000, height: 4000 });   // 超像素 / 超边长：等比缩小
  assert.deepEqual(sizeProblems(FLEX_RULE, huge), []);
  const pano = fitSize(FLEX_RULE, { width: 4000, height: 1000 });   // 4:1 超出 3:1：夹到 3:1
  assert.deepEqual(sizeProblems(FLEX_RULE, pano), []);
  assert.ok(pano.width / pano.height <= 3 + 1e-9);
  const sd = fitSize(SEEDREAM5_RULE, { width: 800, height: 600 });   // Seedream 5：至少 921600 像素
  assert.deepEqual(sizeProblems(SEEDREAM5_RULE, sd), []);
});

test('读原图像素：「改这张图」优先；没有就续改链上一张；只给参考图时不算原图', () => {
  assert.deepEqual(imageDims(png(1920, 1080)), [1920, 1080]);
  const inputs = [{ role: 'ref', data: png(500, 500) }, { role: 'edit', data: png(1536, 1024) }];
  assert.deepEqual(originalSize(FLEX_RULE, { inputs }), { width: 1536, height: 1024, adapted: false, from: { width: 1536, height: 1024 } });
  const chain = { inputs: [], thread: { turns: [{ data: png(1024, 1536), mime: 'image/png' }] } };
  assert.equal(originalSize(FLEX_RULE, chain).height, 1536);
  assert.equal(originalSize(FLEX_RULE, { inputs: [{ role: 'ref', data: png(1024, 1024) }], thread: chain.thread }), null);
  assert.equal(originalSize(FLEX_RULE, { inputs: [] }), null);
});

test('编码：auto / 默认不传；原图换成宽高；对象 / WxH / W*H / 拆字段各按 encode；预设原样', () => {
  const specs = [
    P.size('size', '尺寸', [{ value: 'auto' }, { value: 'original' }, { value: '1024x1024' }], { custom: FLEX_RULE, encode: 'x' }),
    P.size('image_size', '尺寸', [{ value: 'square_hd' }], { custom: { width: { min: 1 }, height: { min: 1 } }, encode: 'object' }),
    P.size('wh', '尺寸', [], { custom: { width: { min: 1 }, height: { min: 1 } }, encode: 'split', fields: { width: 'width', height: 'height' } }),
    P.size('qs', '尺寸', [], { custom: { width: { min: 1 }, height: { min: 1 } }, encode: '*' }),
  ];
  const req = { inputs: [{ role: 'edit', data: png(1536, 1024) }] };
  assert.deepEqual(encodeSizeParams(specs, { size: 'auto', image_size: 'square_hd' }, req).params, { image_size: 'square_hd' });
  assert.deepEqual(encodeSizeParams(specs, { size: 'original' }, req).params, { size: '1536x1024' });
  assert.deepEqual(encodeSizeParams(specs, { size: 'original' }, { inputs: [] }).params, {}, '没有改图素材：原图 = 自动');
  assert.deepEqual(encodeSizeParams(specs, { size: '1024x1024', image_size: { width: 900, height: 600 }, wh: { width: 1280, height: 704 }, qs: { width: 1024, height: 768 } }, req).params,
    { size: '1024x1024', image_size: { width: 900, height: 600 }, width: 1280, height: 704, qs: '1024*768' });
  const fitted = encodeSizeParams(specs, { size: 'original' }, { inputs: [{ role: 'edit', data: png(1920, 1080) }] });
  assert.equal(fitted.meta.sizeAdapted.from, '1920x1080');
});

test('applySpecs：坏的自定义宽高 400；被 when 藏起来的不挡请求；预设 / WxH 字符串都收', () => {
  const specs = [
    P.enum('aspect_ratio', '比例', [{ value: '1:1' }, { value: 'custom' }], { default: '1:1' }),
    P.size('wh', '尺寸', [], { default: { width: 1024, height: 1024 }, when: { aspect_ratio: 'custom' }, custom: { width: { min: 256, max: 2048, multipleOf: 16 }, height: { min: 256, max: 2048, multipleOf: 16 } }, encode: 'split', fields: { width: 'width', height: 'height' } }),
  ];
  assert.deepEqual(applySpecs(specs, { aspect_ratio: '1:1', wh: { width: 9999, height: 1 } }), { aspect_ratio: '1:1' }, '藏起来的坏值不报错');
  assert.throws(() => applySpecs(specs, { aspect_ratio: 'custom', wh: { width: 9999, height: 1 } }), (e) => e.status === 400 && /尺寸：/.test(e.message));
  assert.deepEqual(applySpecs(specs, { aspect_ratio: 'custom', wh: '1280x704' }), { aspect_ratio: 'custom', wh: { width: 1280, height: 704 } });
  // when 里写 ''：「默认，不传」的值没出现在结果里也算 ''
  const sp2 = [P.size('size', '尺寸', [{ value: '', label: '默认' }], { default: '', custom: { width: { min: 16 }, height: { min: 16 } } }), P.enum('aspect_ratio', '比例', [{ value: '16:9' }], { default: '16:9', when: { size: '' } })];
  assert.deepEqual(applySpecs(sp2, {}), { aspect_ratio: '16:9' });
  assert.deepEqual(applySpecs(sp2, { size: { width: 1200, height: 800 } }), { size: { width: 1200, height: 800 } }, '填了自定义尺寸就不发比例');
});

test('维护者报的问题：OpenAI 兼容服务里的 gpt-image-2.6-sunburst-c 有尺寸参数、没有比例；请求发出 size', async () => {
  const entry = { id: 'gpt-image-2.6-sunburst-c', label: 'gpt-image-2.6-sunburst-c', kind: 'image', enabled: true, source: 'manual' };
  const card = cardFor(OAI, entry);
  assert.deepEqual([card.paramSource, card.inheritsFrom], ['family', 'gpt-image-2.6-sunburst']);
  const keys = card.params.map((s) => s.key);
  assert.ok(keys.includes('size') && !keys.includes('aspectRatio'), keys.join());
  const size = card.params.find((s) => s.key === 'size');
  assert.deepEqual([size.type, size.default, size.editDefault], ['size', 'auto', 'original']);
  await withFetch(ok, async (calls) => {
    const run = (params, inputs = []) => openaiAdapter.run({ kind: 'image', model: entry.id, card, prompt: '樱花', params: card.normalize(params), inputs, thread: null }, OAI, CTX);
    await run({ size: { width: 2048, height: 1152 } });
    await run({ size: '1024x1536' });
    await run({ size: 'auto' });
    await run({ size: 'original' }, [{ role: 'edit', data: png(1920, 1080), mime: 'image/png' }]);
    await run({ aspectRatio: '16:9', imageSize: '2K' });   // 旧写法（Claude 媒体工具）
    const body = (c) => (c.init.body instanceof FormData ? Object.fromEntries([...c.init.body.entries()].filter(([k]) => k !== 'image[]')) : JSON.parse(c.init.body));
    assert.equal(body(calls[0]).size, '2048x1152');
    assert.equal(body(calls[1]).size, '1024x1536');
    assert.equal('size' in body(calls[2]), false, '自动：不传');
    assert.equal(calls[3].url.endsWith('/images/edits'), true);
    const orig = body(calls[3]).size.split('x').map(Number);
    assert.deepEqual(sizeProblems(FLEX_RULE, { width: orig[0], height: orig[1] }), [], body(calls[3]).size);
    assert.equal(body(calls[4]).size, '2048x1152');
  });
  assert.throws(() => card.normalize({ size: { width: 2000, height: 1000 } }), (e) => e.status === 400);
});

test('固定尺寸的老模型和未知模型不受影响：仍是比例 → 固定三档', () => {
  const generic = cardFor(OAI, { id: 'some-image-model', kind: 'image', enabled: true, source: 'manual' });
  assert.ok(generic.params.some((s) => s.key === 'aspectRatio'));
  assert.ok(!generic.params.some((s) => s.type === 'size'));
  for (const id of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.6-sunburst']) {
    assert.ok(OPENAI[id].params.some((s) => s.type === 'size'), id);
    assert.ok(!OPENAI[id].params.some((s) => s.key === 'aspectRatio'), id);
  }
});

test('改图默认原图：有「改这张图」或在续改链里、本次没给尺寸时套 editDefault；只给参考图 / 旧写法给了比例档位不套', () => {
  const card = OPENAI['gpt-image-2.5-sunburst'];
  assert.equal(applyEditDefaults(card, {}, { inputs: [{ role: 'edit' }] }).size, 'original');
  assert.equal(applyEditDefaults(card, {}, { inputs: [], thread: 'abc123' }).size, 'original');
  assert.equal(applyEditDefaults(card, {}, { inputs: [{ role: 'ref' }] }).size, undefined);
  assert.equal(applyEditDefaults(card, { size: 'auto' }, { inputs: [{ role: 'edit' }] }).size, 'auto', '用户选了自动就是自动');
  assert.equal(applyEditDefaults(card, { imageSize: '4K' }, { inputs: [{ role: 'edit' }] }).size, undefined, 'Claude 工具给了档位');
  assert.equal(applyEditDefaults(card, {}, { inputs: [] }).size, undefined);
});

test('Seedream 5：档位或自定义宽高；原图按像素区间适配', async () => {
  const card = ARK['doubao-seedream-5-0-pro-260628'];
  const size = card.params.find((s) => s.key === 'size');
  assert.deepEqual([size.type, size.default, size.editDefault], ['size', '2K', 'original']);
  const prov = { id: 'p-ark00001', owner: 'admin', dialect: 'ark', name: '火山', baseUrl: 'https://ark.example.test/api/v3', authStyle: 'bearer', headers: {}, params: {}, models: [] };
  await withFetch(ok, async (calls) => {
    const run = (params, inputs = []) => arkAdapter.run({ kind: 'image', model: 'doubao-seedream-5-0-pro-260628', card, prompt: 'x', params: applySpecs(card.params, params), inputs, thread: null }, prov, CTX);
    await run({ size: '1.5K' });
    await run({ size: { width: 2048, height: 1152 } });
    await run({ size: 'original' }, [{ role: 'edit', data: png(800, 600), mime: 'image/png' }]);
    const b = calls.map((c) => JSON.parse(c.init.body).size);
    assert.equal(b[0], '1.5K');
    assert.equal(b[1], '2048x1152');
    const [w, h] = b[2].split('x').map(Number);
    assert.deepEqual(sizeProblems(SEEDREAM5_RULE, { width: w, height: h }), [], b[2]);
  });
  assert.throws(() => applySpecs(card.params, { size: { width: 800, height: 600 } }), (e) => e.status === 400 && /总像素/.test(e.message));
});

test('OpenRouter 的 GPT Image：新写法发 size（自动不传、原图按原图像素）；旧写法（比例 + 档位）照旧', async () => {
  const { openrouterAdapter } = await import('../adapters/openrouter.mjs');
  const prov = { id: 'p-or000001', owner: 'admin', dialect: 'openrouter', name: 'OpenRouter', baseUrl: 'https://or.example.test/api/v1', authStyle: 'bearer', headers: {}, params: {}, models: [] };
  const entry = { id: 'openai/gpt-image-2.6-sunburst', kind: 'image', enabled: true, source: 'builtin' };
  const card = cardFor(prov, entry);
  assert.deepEqual(card.params.map((s) => s.key), ['size', 'quality']);
  await withFetch(ok, async (calls) => {
    const run = (params, inputs = []) => openrouterAdapter.run({ kind: 'image', model: entry.id, card, prompt: 'x', params: card.normalize(params), inputs, thread: null }, prov, CTX);
    const edit = [{ role: 'edit', data: png(1536, 1024), mime: 'image/png' }];
    await run({ size: { width: 2048, height: 1152 }, quality: 'low' });
    await run({ size: 'auto' }, edit);
    await run({ size: 'original' }, edit);
    await run({ aspectRatio: '16:9', imageSize: '4K' });
    await run({ aspectRatio: 'auto', imageSize: '2K' }, edit);
    const b = calls.map((c) => JSON.parse(c.init.body));
    assert.deepEqual([b[0].size, b[0].quality], ['2048x1152', 'low']);
    assert.equal('size' in b[1], false, '新写法的自动：不传（不再偷偷跟参考图比例）');
    assert.equal(b[2].size, '1536x1024');
    assert.equal(b[3].size, '3840x2160', '旧写法 16:9 4K 不变');
    assert.equal(b[4].size, '2048x1360', '旧写法：自动 + 参考图 = 跟参考图比例（不变）');
  });
});

// —— 素材条件（$edit / $first / $last / $ref）：选项 only 条件表与 when 前后端同一套 ——
test('素材条件：海螺 1080P 没有 10 秒；Veo 有参考图只能 8 秒；Veo 3.1 Lite 不收参考图；纯音乐不收歌词', async () => {
  const { CARDS: MM } = await import('../adapters/minimax.mjs');
  const { googleCard } = await import('./google.mjs');
  const hl = MM['MiniMax-Hailuo-2.3'];
  assert.equal(applySpecs(hl.params, { resolution: '1080P', durationSeconds: 10 }).durationSeconds, 6, '1080P：10 秒不成立，落到 6');
  assert.equal(applySpecs(hl.params, { resolution: '768P', durationSeconds: 10 }).durationSeconds, 10);
  const veo = googleCard('vertex', 'veo-3.1-generate-001');
  assert.equal(veo.normalize({ durationSeconds: 4 }, { $ref: true }).durationSeconds, 8);
  assert.equal(veo.normalize({ durationSeconds: 4 }, {}).durationSeconds, 4);
  assert.equal(veo.normalize({ durationSeconds: 4 }).durationSeconds, 4, '不知道素材时不收窄');
  assert.ok(veo.params.find((s) => s.key === 'durationSeconds').options.filter((o) => o.only?.$ref === false).length > 0);
  const lite = googleCard('vertex', 'veo-3.1-lite-generate-001');
  assert.ok(!lite.inputs.images.roles.includes('ref'), 'Lite 没有参考图');
  const mu = MM['music-2.6'] || Object.values(MM).find((c) => c.kind === 'music');
  assert.deepEqual(Object.keys(applySpecs(mu.params, { instrumental: true, lyrics: '[Verse] x' })).includes('lyrics'), false);
  assert.equal(applySpecs(mu.params, { instrumental: false, lyrics: '[Verse] x' }).lyrics, '[Verse] x');
});
