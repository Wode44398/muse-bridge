// OpenRouter：GPT Image 内置卡 + 驱动的参数补全（2026-11-15）、schema 卡的格式联动 / 透传 / gif、视频的精确尺寸 / 音频默认 / Veo 与 Seedance 透传。
// 全程 mock 全局 fetch，不联网、不花钱；巡检缓存写在临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-or-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const { cardFor, gptImageCard } = await import('../cards/index.mjs');
const { applySpecs } = await import('../cards/spec.mjs');
const store = await import('../discovery/store.mjs');
const schema = await import('../discovery/schema.mjs');
const { openrouterAdapter } = await import('./openrouter.mjs');
const { openRouterImageBody } = await import('./openrouter-image.mjs');

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'discovery', 'fixtures');
const fx = (f) => JSON.parse(readFileSync(path.join(FX, f), 'utf8')).data;
const OR_IMAGES = fx('openrouter-images-models.json');
const OR_VIDEOS = fx('openrouter-videos-models.json');
const orImage = (id) => OR_IMAGES.find((m) => m.id === id);
const orVideo = (id) => OR_VIDEOS.find((m) => m.id === id);
const keys = (params) => params.map((s) => s.key);
const spec = (params, k) => params.find((s) => s.key === k);
const values = (s) => s.options.map((o) => o.value);

async function withFetch(handler, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const PROV = (over = {}) => ({ id: 'p-0a0000aa', owner: 'admin', dialect: 'openrouter', name: 'OpenRouter', baseUrl: 'https://or.example.test/api/v1', authStyle: 'bearer', headers: {}, params: {}, models: [], ...over });
const CTX = { secret: { key: 'k' }, signal: new AbortController().signal, progress() {}, submitted() {} };
const entry = (id) => ({ id, kind: 'image', enabled: true, source: 'builtin' });

// —— GPT Image 内置卡 ——
test('GPT Image 内置卡：五个模型都有；2.6 带 gif 与构图规划，2.5 没有，gpt-image-2 画质只到 high、没有透明背景、标弃用', () => {
  const prov = PROV();
  for (const id of ['openai/gpt-image-2.6-sunburst', 'openai/gpt-image-2.6-flare', 'openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare', 'openai/gpt-image-2']) {
    const c = cardFor(prov, entry(id));
    assert.equal(c.id, `openrouter:${id}`, id);
    assert.equal(spec(c.params, 'size').custom.width.max, 3840, `${id} 走自由尺寸（2K / 4K 出得来）`);
  }
  const c26 = cardFor(prov, entry('openai/gpt-image-2.6-flare'));
  assert.deepEqual(keys(c26.params), ['size', 'quality', 'count', 'outputFormat', 'outputCompression', 'frameCount', 'frameDurationMs', 'background', 'moderation', 'complexity', 'extra']);
  assert.deepEqual(values(spec(c26.params, 'quality')), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(spec(c26.params, 'quality').default, 'high');
  assert.deepEqual(values(spec(c26.params, 'outputFormat')), ['png', 'jpeg', 'webp', 'gif']);
  assert.deepEqual(spec(c26.params, 'frameDurationMs').when, { outputFormat: 'gif' });
  assert.deepEqual([spec(c26.params, 'frameDurationMs').step, spec(c26.params, 'frameDurationMs').unit], [10, 'ms']);
  assert.deepEqual(spec(c26.params, 'outputCompression').when, { outputFormat: ['jpeg', 'webp'] });
  assert.deepEqual(spec(c26.params, 'background').options.find((o) => o.value === 'transparent').only, { outputFormat: ['png', 'webp'] });
  assert.deepEqual(keys(cardFor(prov, entry('openai/gpt-image-2.5-sunburst')).params), ['size', 'quality', 'count', 'outputFormat', 'outputCompression', 'background', 'moderation', 'extra']);
  const g2 = cardFor(prov, entry('openai/gpt-image-2'));
  assert.deepEqual(values(spec(g2.params, 'quality')), ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(values(spec(g2.params, 'background')), ['auto', 'opaque']);
  assert.match(g2.desc, /弃用/);
});

test('GPT Image 规范化：新写法全部参数按卡规范化；旧写法（比例 + 档位）参数表一字不变，只并上显式给了的新参数', () => {
  const c = cardFor(PROV(), entry('openai/gpt-image-2.6-sunburst'));
  assert.deepEqual(c.normalize({ size: 'auto' }), { size: 'auto', quality: 'high', count: 1, outputFormat: 'png', background: 'auto', moderation: 'auto' });
  const gif = c.normalize({ size: { width: 1024, height: 1024 }, outputFormat: 'gif', frameDurationMs: 155, count: 3, complexity: 'low', junk: 1 });
  assert.deepEqual([gif.size, gif.outputFormat, gif.frameCount, gif.frameDurationMs, gif.count, gif.complexity, 'junk' in gif], [{ width: 1024, height: 1024 }, 'gif', 9, 160, 3, 'low', false]);
  // 旧写法：同以前（Claude 媒体工具靠 imageSize 查降档）
  assert.deepEqual(c.normalize({ aspectRatio: '16:9', imageSize: '4K', quality: 'low', thinkingLevel: 'minimal' }), { aspectRatio: '16:9', imageSize: '4K', quality: 'low' });
  assert.deepEqual(c.normalize({ aspectRatio: 'weird' }), { aspectRatio: 'auto', imageSize: undefined, quality: undefined });
  assert.deepEqual(c.normalize({ aspectRatio: '1:1', imageSize: '2K', count: 4, outputFormat: 'webp', outputCompression: 70 }),
    { aspectRatio: '1:1', imageSize: '2K', quality: undefined, count: 4, outputFormat: 'webp', outputCompression: 70 });
  // gpt-image-2：没有 xhigh、没有透明
  const g2 = cardFor(PROV(), entry('openai/gpt-image-2'));
  assert.equal(g2.normalize({ size: 'auto', quality: 'xhigh' }).quality, 'high');
  assert.equal(g2.normalize({ aspectRatio: '1:1', quality: 'xhigh' }).quality, undefined, '旧写法不认的画质：不传（驱动按 high）');
  assert.equal(g2.normalize({ size: 'auto', background: 'transparent' }).background, 'auto');
});

test('GPT Image 精修：有巡检缓存的目录 schema 就按它收窄 / 放宽（格式、画质、背景、张数上限）；端点只有 openai 时按透传表给审核 / 构图规划', () => {
  const prov = PROV({ id: 'p-0a0000bb' });
  const sp = { ...orImage('openai/gpt-image-2.6-sunburst').supported_parameters };
  sp.output_format = { type: 'enum', values: ['png', 'jpeg', 'webp', 'gif', 'svg'] };
  sp.n = { type: 'range', min: 1, max: 4 };
  store.putSchemas('admin', prov.id, { 'openai/gpt-image-2.6-sunburst': { src: 'openrouter-image', kind: 'image', data: { id: 'openai/gpt-image-2.6-sunburst', supported_parameters: sp }, endpoints: { n: 1, slug: 'openai', passthrough: ['moderation'] }, priceHint: '$0.04 / 张' } });
  const c = cardFor(prov, entry('openai/gpt-image-2.6-sunburst'));
  assert.deepEqual(values(spec(c.params, 'outputFormat')), ['png', 'jpeg', 'webp', 'gif', 'svg'], '上游新开的格式自动出现');
  assert.deepEqual(spec(c.params, 'outputFormat').options.find((o) => o.value === 'svg').only, { $edit: false, $ref: false });
  assert.equal(spec(c.params, 'count').max, 4);
  assert.equal(spec(c.params, 'complexity'), undefined, '透传表里没有 complexity');
  assert.ok(spec(c.params, 'moderation'));
  assert.equal(c.priceHint, '1.5K medium ≈ $0.034，4K 16:9 low ≈ $0.047', '写死的价格提示优先');
  assert.equal(cardFor(prov, entry('openai/gpt-image-2.6-sunburst')), c, '同一发现状态版本内缓存');
  // 别的服务没有缓存：照写死的表
  assert.ok(spec(cardFor(PROV({ id: 'p-0a0000cc' }), entry('openai/gpt-image-2.6-sunburst')).params, 'complexity'));
  // 多服务商（没有 slug）：不信缓存的透传表
  assert.ok(spec(gptImageCard('openai/gpt-image-2.6-sunburst', sp, { n: 2, passthrough: [] }).params, 'complexity'));
});

test('GPT Image 请求体：张数→n、gif 帧参数、压缩只 jpeg / webp、背景非自动才发、审核 / 构图规划进 provider.options.openai（extra 优先）；gif + 自动尺寸不传 size', () => {
  const b = openRouterImageBody({ model: 'openai/gpt-image-2.6-sunburst', prompt: 'x', size: null, count: 4, outputFormat: 'gif', outputCompression: 50, frameCount: 5, frameDurationMs: 123, background: 'opaque', moderation: 'low', complexity: 'high',
    extra: { provider: { order: ['openai'], options: { openai: { complexity: 'low' } } } } });
  assert.deepEqual(b, { model: 'openai/gpt-image-2.6-sunburst', prompt: 'x', n: 4, quality: 'high', output_format: 'gif', frame_count: 5, frame_duration_ms: 120, background: 'opaque',
    provider: { order: ['openai'], options: { openai: { moderation: 'low', complexity: 'low' } } } });
  const j = openRouterImageBody({ model: 'm', prompt: 'x', size: '2048x1152', outputFormat: 'jpeg', outputCompression: 70, background: 'auto', moderation: 'auto', quality: 'auto' });
  assert.deepEqual(j, { model: 'm', prompt: 'x', n: 1, quality: 'auto', output_format: 'jpeg', output_compression: 70, size: '2048x1152' });
  assert.equal('output_compression' in openRouterImageBody({ model: 'm', outputFormat: 'png', outputCompression: 70 }), false);
  // 旧写法 + gif：「自动」不再跟参考图比例算 size
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50]).copy(png, 0); png.writeUInt32BE(1536, 16); png.writeUInt32BE(1024, 20);
  const refs = [{ data: png.toString('base64'), mimeType: 'image/png' }];
  assert.equal('size' in openRouterImageBody({ model: 'm', refs, aspectRatio: 'auto', imageSize: '2K', outputFormat: 'gif' }), false);
  assert.equal(openRouterImageBody({ model: 'm', refs, aspectRatio: 'auto', imageSize: '2K' }).size, '2048x1360', '非 gif 照旧');
});

test('GPT Image 执行：data[] 每张都收；mime 优先 media_type，没给按请求的格式兜底；sizeAdapted 照留', async () => {
  const prov = PROV();
  const card = cardFor(prov, entry('openai/gpt-image-2.6-sunburst'));
  const g = Buffer.from('GIF89a').toString('base64');
  await withFetch(() => jsonRes({ data: [{ b64_json: g }, { b64_json: g, media_type: 'image/gif' }, { url: 'x' }] }), async (calls) => {
    const params = card.normalize({ size: 'auto', outputFormat: 'gif', count: 2, moderation: 'low' });
    const out = await openrouterAdapter.run({ kind: 'image', model: 'openai/gpt-image-2.6-sunburst', card, prompt: '动图', params, inputs: [], thread: null }, prov, CTX);
    assert.deepEqual(out.assets.map((a) => a.mime), ['image/gif', 'image/gif']);
    const b = JSON.parse(calls[0].init.body);
    assert.deepEqual([b.n, b.output_format, b.frame_count, b.frame_duration_ms, 'size' in b, b.provider.options.openai.moderation], [2, 'gif', 9, 200, false, 'low']);
  });
});

// —— schema 卡 ——
test('schema 卡：压缩率只在 jpeg / webp 时出现；透明跟格式联动；gif 补帧数 / 每帧时长；只有一种格式的不出格式参数但照发', async () => {
  const g = schema.fromOpenRouterImage(orImage('openai/gpt-image-2.6-flare'));
  assert.deepEqual(spec(g.params, 'output_compression').when, { output_format: ['jpeg', 'webp'] });
  assert.deepEqual(spec(g.params, 'frame_count').when, { output_format: 'gif' });
  assert.deepEqual([spec(g.params, 'frame_duration_ms').min, spec(g.params, 'frame_duration_ms').max, spec(g.params, 'frame_duration_ms').default], [20, 2000, 200]);
  assert.deepEqual(spec(g.params, 'background').options.find((o) => o.value === 'transparent').only, { output_format: ['', 'png', 'webp'] });
  assert.deepEqual(applySpecs(g.params, { output_format: 'jpeg', background: 'transparent', output_compression: 50 }), { aspect_ratio: 'auto', quality: 'auto', n: 1, output_format: 'jpeg', output_compression: 50, background: 'auto' });
  assert.equal('frame_count' in applySpecs(g.params, { output_format: 'png', frame_count: 4 }), false);
  // Recraft vector：只有 svg
  const v = schema.fromOpenRouterImage(orImage('recraft/recraft-v4-vector'));
  assert.equal(spec(v.params, 'output_format'), undefined);
  assert.deepEqual(v.wire.fixed, { output_format: 'svg' });
  // riverflow 2.5 fast：只有 jpeg（压缩率留着，不加 when）
  const rf = schema.fromOpenRouterImage(orImage('sourceful/riverflow-v2.5-fast'));
  assert.equal(spec(rf.params, 'output_format'), undefined);
  // 执行：固定格式补进请求体，svg 的 mime 兜底
  const card = { params: v.params, wire: v.wire };
  await withFetch(() => jsonRes({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }), async (calls) => {
    const out = await openrouterAdapter.run({ kind: 'image', model: 'recraft/recraft-v4-vector', card, prompt: '图标', params: { n: 2 }, inputs: [], thread: null }, PROV(), CTX);
    const b = JSON.parse(calls[0].init.body);
    assert.deepEqual([b.output_format, b.n], ['svg', 2]);
    assert.equal(out.assets[0].mime, 'image/svg+xml');
  });
});

test('schema 卡透传：单一服务商端点的 allowed_passthrough_parameters 做成参数，执行时挪进 provider.options.<slug>；多服务商只列进说明', async () => {
  const eps = [{ provider_slug: 'openai', allowed_passthrough_parameters: ['moderation', 'complexity', 'style_hint'], pricing: [] }];
  const info = schema.imageEndpointInfo(eps);
  assert.deepEqual(info, { n: 1, slug: 'openai', passthrough: ['moderation', 'complexity', 'style_hint'] });
  assert.deepEqual(schema.imageEndpointInfo([...eps, { provider_slug: 'azure', allowed_passthrough_parameters: ['moderation'] }]), { n: 2, passthrough: ['moderation', 'complexity', 'style_hint'] });
  const b = schema.fromOpenRouterImage(orImage('openai/gpt-image-2.6-flare'), { endpoints: info });
  assert.deepEqual([spec(b.params, 'moderation').type, spec(b.params, 'moderation').passthrough, spec(b.params, 'style_hint').type], ['enum', 'openai', 'text']);
  assert.deepEqual(values(spec(b.params, 'complexity')), ['', 'low', 'medium', 'high']);
  assert.deepEqual(b.wire.passthrough, { moderation: { slug: 'openai' }, complexity: { slug: 'openai' }, style_hint: { slug: 'openai' } });
  const multi = schema.fromOpenRouterImage(orImage('openai/gpt-image-2.6-flare'), { endpoints: { n: 2, passthrough: ['moderation'] } });
  assert.equal(spec(multi.params, 'moderation'), undefined);
  assert.match(spec(multi.params, 'extra').desc, /provider\.options\.<服务商>\.moderation/);
  // 执行
  const card = { params: b.params, wire: b.wire };
  await withFetch(() => jsonRes({ data: [{ b64_json: 'AA==', media_type: 'image/png' }] }), async (calls) => {
    await openrouterAdapter.run({ kind: 'image', model: 'openai/gpt-image-2.6-flare', card, prompt: 'x', params: applySpecs(b.params, { moderation: 'low', complexity: 'high', extra: { provider: { options: { openai: { complexity: 'low' } } } } }), inputs: [], thread: null }, PROV(), CTX);
    const body = JSON.parse(calls[0].init.body);
    assert.equal('moderation' in body, false);
    assert.deepEqual(body.provider.options.openai, { complexity: 'low', moderation: 'low' }, '原始参数里手写的优先');
  });
});

test('巡检缓存：端点信息存进 schema；目录换新（没带端点）、参数描述没变时沿用；旧缓存没有这个字段照旧', () => {
  const pid = 'p-0a0000dd';
  const data = { id: 'x/y', supported_parameters: { n: { type: 'range', min: 1, max: 2 } } };
  store.putSchemas('admin', pid, { 'x/y': { src: 'openrouter-image', kind: 'image', data } });
  assert.equal(store.getSchema('admin', pid, 'x/y').endpoints, undefined);
  store.putSchemas('admin', pid, { 'x/y': { src: 'openrouter-image', kind: 'image', data, endpoints: { n: 1, slug: 'a', passthrough: ['k'] } } });
  assert.equal(store.getSchema('admin', pid, 'x/y').endpoints.slug, 'a');
  store.putSchemas('admin', pid, { 'x/y': { src: 'openrouter-image', kind: 'image', data } }, { replace: true });
  assert.equal(store.getSchema('admin', pid, 'x/y').endpoints.slug, 'a', '目录换新：沿用');
  store.putSchemas('admin', pid, { 'x/y': { src: 'openrouter-image', kind: 'image', data: { ...data, supported_parameters: {} } } }, { replace: true });
  assert.equal(store.getSchema('admin', pid, 'x/y').endpoints, undefined, '参数描述变了：作废，等补取');
});

// —— 视频 ——
test('视频 schema：有分辨率也给「精确尺寸」（选了就不发比例 / 分辨率）；生成音频默认跟上游，带音频更贵的保持关', () => {
  const veo = schema.fromOpenRouterVideo(orVideo('google/veo-3.1-fast'));
  const size = spec(veo.params, 'size');
  assert.deepEqual([size.label, size.group, size.default, values(size)[0]], ['精确尺寸', 'advanced', '', '']);
  assert.ok(values(size).includes('1920x1080'));
  assert.deepEqual(spec(veo.params, 'resolution').when, { size: '' });
  assert.deepEqual(applySpecs(veo.params, { size: '1920x1080', resolution: '4K', aspect_ratio: '16:9' }).resolution, undefined);
  assert.equal(applySpecs(veo.params, { size: '1920x1080' }).size, '1920x1080');
  assert.equal(spec(veo.params, 'generate_audio').default, false, 'Veo 带音频更贵：默认关');
  assert.equal(spec(schema.fromOpenRouterVideo(orVideo('kwaivgi/kling-v3.0-pro')).params, 'generate_audio').default, false, 'Kling 带音频更贵');
  assert.equal(spec(schema.fromOpenRouterVideo(orVideo('alibaba/wan-3.0')).params, 'generate_audio').default, true, '价目不分音频：跟上游默认开');
  assert.equal(spec(schema.fromOpenRouterVideo(orVideo('bytedance/seedance-2.0')).params, 'generate_audio').default, true, 'Seedance 带不带音频一个价');
  assert.equal(schema.audioCostsMore({ duration_seconds_with_audio: '0.12', duration_seconds_without_audio: '0.10' }), true);
  assert.equal(schema.audioCostsMore({ video_tokens: '0.000007', video_tokens_without_audio: '0.000007' }), false);
  assert.equal(schema.audioCostsMore({}), false);
  // 基本组仍最多 4 个（精确尺寸不挤进去）
  for (const m of OR_VIDEOS) assert.ok(schema.fromOpenRouterVideo(m).params.filter((s) => s.group === 'basic').length <= 4, m.id);
});

test('视频透传：Veo → provider.options["google-vertex"].parameters（负面提示词走 inputs.negative）；Seedance → provider.options.seed；其余厂商照旧只列说明', async () => {
  const veo = schema.fromOpenRouterVideo(orVideo('google/veo-3.1'));
  assert.equal(veo.inputs.negative, true);
  assert.deepEqual(keys(veo.params).filter((k) => ['personGeneration', 'enhancePrompt', 'conditioningScale'].includes(k)), ['personGeneration', 'conditioningScale', 'enhancePrompt']);
  assert.doesNotMatch(spec(veo.params, 'extra').desc || '', /negativePrompt|personGeneration|aspectRatio/);
  const sd = schema.fromOpenRouterVideo(orVideo('bytedance/seedance-2.0'));
  assert.deepEqual(values(spec(sd.params, 'watermark')), ['', true, false]);
  assert.match(spec(sd.params, 'extra').desc, /req_key/);
  const kl = schema.fromOpenRouterVideo(orVideo('kwaivgi/kling-v3.0-pro'));
  assert.equal(kl.wire, undefined);
  assert.match(spec(kl.params, 'extra').desc, /negative_prompt/);
  // 执行
  const card = { params: veo.params, wire: veo.wire };
  let polls = 0;
  await withFetch((url, init) => {
    if (init.method === 'POST') return jsonRes({ id: 'gen-1', status: 'pending' }, 202);
    if (/content/.test(url)) return new Response(Buffer.from('MP4'), { status: 200, headers: { 'content-type': 'video/mp4' } });
    polls++;
    return jsonRes({ id: 'gen-1', status: 'completed' });
  }, async (calls) => {
    const params = applySpecs(veo.params, { personGeneration: 'allow_adult', enhancePrompt: 'false', resolution: '1080p' });
    await openrouterAdapter.run({ kind: 'video', model: 'google/veo-3.1', card, prompt: '海浪', negative: '人群', params, inputs: [] }, PROV({ timeoutSec: 60 }), { ...CTX, pollMs: 1 });
    const b = JSON.parse(calls[0].init.body);
    assert.deepEqual(b.provider, { options: { 'google-vertex': { parameters: { personGeneration: 'allow_adult', enhancePrompt: false, negativePrompt: '人群' } } } });
    assert.equal('personGeneration' in b, false);
    assert.equal(b.resolution, '1080p');
  });
  assert.ok(polls >= 1);
});
