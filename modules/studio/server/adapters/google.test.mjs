// Google 系（vertex / gemini 方言）模型卡与驱动：卡的参数清单 / 规范化（新参数、按型号门控、旧写法兼容），
// 以及真正发出去的请求体——SDK 照常跑，只把 globalThis.fetch 换成假的（记下请求、回假响应），不联网、不花钱。
// Vertex 走「客户端中继」模式（BRIDGE_VERTEX_RELAY）：SDK 用占位令牌，不去找 ADC。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCoreResolver } from '../../../../src/modules/core-resolve.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-google-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_VERTEX_RELAY = 'https://relay.test/v1/vertex';
process.env.BRIDGE_GEMINI_RELAY = '';
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 1, token: 'test-token-not-real' }));
installCoreResolver();
const { googleCard } = await import('../cards/google.mjs');
const { googleAdapter, fitImageBody } = await import('./google.mjs');
const tts = await import('./tts.mjs');
const omni = await import('./omni.mjs');
const music = await import('./music.mjs');
const caps = await import('@bridge/core/config/capabilities.mjs');

const spec = (card, k) => card.params.find((s) => s.key === k);
const keys = (card) => card.params.map((s) => s.key);
const values = (s) => s.options.map((o) => o.value);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pcm = Buffer.alloc(480, 1);
const wav = tts.toPlayable({ data: pcm.toString('base64'), mimeType: 'audio/L16;codec=pcm;rate=24000' }).bytes;

// —— 假 fetch：记下每个请求，按地址回假响应 ——
let calls = [], reply = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url instanceof URL ? url : url?.url || url);
  let body = init.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const call = { url: u, body, headers: init.headers };
  calls.push(call);
  const r = reply ? reply(call) : {};
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
test.after(() => { globalThis.fetch = realFetch; });
const imgReply = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') }, thoughtSignature: 's' }] } }] });
const vertex = { dialect: 'vertex', google: { project: 'p1', location: 'global', mediaLocation: 'us-central1' } };
const gemini = { dialect: 'gemini' };
const actx = (extra = {}) => ({ secret: { key: 'AIza-test' }, signal: new AbortController().signal, progress() {}, submitted() {}, ...extra });
const run = (dialect, req, extra) => googleAdapter(dialect).run({ inputs: [], thread: null, ...req }, dialect === 'vertex' ? vertex : gemini, actx(extra));

// ====================== 图像 ======================
test('图像卡：思考档按型号、512 只 3.1 Flash、超宽比例放行 2.1 与 3.1 Flash、参考图张数按型号', () => {
  const nb21 = googleCard('vertex', 'gemini-nano-banana-2.1');
  const flash = googleCard('vertex', 'gemini-3.1-flash-image');
  const lite = googleCard('vertex', 'gemini-3.1-flash-lite-image');
  const pro = googleCard('vertex', 'gemini-3-pro-image');
  const nb25 = googleCard('vertex', 'gemini-2.5-flash-image');
  assert.deepEqual(values(spec(nb21, 'thinkingLevel')), ['', 'minimal', 'medium', 'high']);
  assert.deepEqual(values(spec(flash, 'thinkingLevel')), ['', 'minimal', 'high']);
  assert.deepEqual(values(spec(lite, 'thinkingLevel')), ['', 'minimal', 'high']);
  assert.equal(spec(pro, 'thinkingLevel'), undefined);
  assert.equal(nb21.normalize({ thinkingLevel: 'medium' }).thinkingLevel, 'medium');
  assert.equal(flash.normalize({ thinkingLevel: 'medium' }).thinkingLevel, undefined, '3.1 Flash 没有 medium');
  assert.equal(flash.normalize({ thinkingLevel: 'high' }).thinkingLevel, 'high');
  // 尺寸
  assert.deepEqual(values(spec(flash, 'imageSize')), ['', '512', '1K', '2K', '4K']);
  assert.deepEqual(values(spec(nb21, 'imageSize')), ['', '1K', '2K', '4K']);
  assert.equal(flash.normalize({ imageSize: '512' }).imageSize, '512');
  assert.equal(pro.normalize({ imageSize: '512' }).imageSize, '1K', '不收 512 的落到最小档，不往 4K 落');
  assert.equal(lite.normalize({ imageSize: '512' }).imageSize, '1K');
  // 超宽比例：卡放行 2.1 与 3.1 Flash；Claude 工具那份（imgAspectFor）照旧只 2.1
  for (const a of ['4:1', '1:4', '8:1', '1:8']) {
    assert.ok(values(spec(flash, 'aspectRatio')).includes(a));
    assert.equal(flash.normalize({ aspectRatio: a }).aspectRatio, a);
    assert.equal(lite.normalize({ aspectRatio: a }).aspectRatio, 'auto');
    assert.equal(pro.normalize({ aspectRatio: a }).aspectRatio, 'auto');
    assert.equal(caps.imgAspectFor('gemini-3.1-flash-image', a), 'auto', '工具的取值域不动');
  }
  // 参考图
  for (const c of [nb21, flash, lite, pro]) assert.equal(c.inputs.images.max, 14);
  assert.equal(nb25.inputs.images.max, 3);
});

test('图像卡：人物生成 / 名人 / 输出格式只 Vertex（2.5 不给人物生成）；种子 2.1 不给；JPEG 质量只在选了 JPEG 时', () => {
  const nb25 = googleCard('vertex', 'gemini-2.5-flash-image');
  assert.equal(spec(nb25, 'personGeneration'), undefined, 'Vertex 2.5 模型页：Person generation 不支持');
  assert.equal(spec(nb25, 'prominentPeople'), undefined);
  assert.equal(nb25.normalize({ personGeneration: 'ALLOW_ADULT' }).personGeneration, undefined);
  const flash = googleCard('vertex', 'gemini-3.1-flash-image');
  assert.ok(spec(flash, 'personGeneration') && spec(flash, 'prominentPeople') && spec(flash, 'outputMimeType'));
  assert.deepEqual(spec(flash, 'compressionQuality').when, { outputMimeType: 'image/jpeg' });
  assert.deepEqual([spec(flash, 'seed').min, spec(flash, 'seed').max, spec(flash, 'seed').default], [0, 2147483647, undefined]);
  const n = flash.normalize({ outputMimeType: 'image/jpeg', compressionQuality: 180, prominentPeople: 'BLOCK_PROMINENT_PEOPLE', seed: '42' });
  assert.deepEqual([n.outputMimeType, n.compressionQuality, n.prominentPeople, n.seed], ['image/jpeg', 100, 'BLOCK_PROMINENT_PEOPLE', 42]);
  assert.equal(flash.normalize({ outputMimeType: 'image/png', compressionQuality: 50 }).compressionQuality, undefined, 'PNG 不带质量');
  assert.equal(flash.normalize({ outputMimeType: 'image/gif' }).outputMimeType, undefined);
  // 2.1：没有种子；2K / 4K 走 dev API 时 Vertex 专属项全丢、界面按尺寸收起
  const nb21 = googleCard('vertex', 'gemini-nano-banana-2.1');
  assert.equal(spec(nb21, 'seed'), undefined);
  assert.equal(nb21.normalize({ seed: 7 }).seed, undefined);
  for (const k of ['personGeneration', 'prominentPeople', 'outputMimeType']) assert.deepEqual(spec(nb21, k).when, { imageSize: ['', '1K'] }, k);
  assert.deepEqual(spec(nb21, 'compressionQuality').when, { outputMimeType: 'image/jpeg', imageSize: ['', '1K'] });
  const big = nb21.normalize({ imageSize: '4K', outputMimeType: 'image/jpeg', compressionQuality: 80, prominentPeople: 'BLOCK_PROMINENT_PEOPLE' });
  assert.deepEqual([big.outputMimeType, big.compressionQuality, big.prominentPeople], [undefined, undefined, undefined]);
  // gemini 方言（dev API）：Vertex 专属的一个都不给，种子照给
  const dev = googleCard('gemini', 'gemini-3.1-flash-image');
  for (const k of ['personGeneration', 'prominentPeople', 'outputMimeType', 'compressionQuality']) assert.equal(spec(dev, k), undefined, k);
  assert.ok(spec(dev, 'seed'));
  assert.equal(dev.normalize({ outputMimeType: 'image/jpeg' }).outputMimeType, undefined);
});

test('图像卡：旧写法（Claude 工具 / 旧接口）的参数规范化结果一字不变', () => {
  const flash = googleCard('vertex', 'gemini-3.1-flash-image');
  // 媒体工具给的：aspectRatio（已按工具那份夹成 auto）/ imageSize 2K / thinkingLevel minimal / 两个搜索
  assert.deepEqual(flash.normalize({ aspectRatio: 'auto', imageSize: '2K', thinkingLevel: 'minimal', useSearch: true, useImageSearch: true }),
    { aspectRatio: 'auto', imageSize: '2K', thinkingLevel: 'minimal', useImageSearch: true, useSearch: true, outputFormat: 'both' });
  // 前端默认值（温度 1、top_p 0.95）
  assert.deepEqual(googleCard('vertex', 'gemini-3-pro-image').normalize({ aspectRatio: '16:9', temperature: 1, topP: 0.95, outputFormat: 'both' }),
    { aspectRatio: '16:9', useImageSearch: false, useSearch: false, temperature: 1, topP: 0.95, outputFormat: 'both' });
});

test('图像请求体：种子 / 输出格式 / 名人进对的位置；dev 通道一律不带 Vertex 专属项', async () => {
  calls = []; reply = imgReply;
  const card = googleCard('vertex', 'gemini-3.1-flash-image');
  const params = card.normalize({ imageSize: '512', aspectRatio: '8:1', thinkingLevel: 'high', seed: 9, outputMimeType: 'image/jpeg', compressionQuality: 70, prominentPeople: 'BLOCK_PROMINENT_PEOPLE', personGeneration: 'ALLOW_ADULT' });
  const out = await run('vertex', { kind: 'image', model: 'gemini-3.1-flash-image', card, prompt: '海报', params });
  assert.equal(out.assets.length, 1);
  const b = calls.find((c) => /:generateContent/.test(c.url)).body;
  assert.match(calls[0].url, /^https:\/\/relay\.test\/v1\/vertex\/global\//);
  assert.deepEqual(b.generationConfig.imageConfig, { aspectRatio: '8:1', imageSize: '512', personGeneration: 'ALLOW_ADULT', prominentPeople: 'BLOCK_PROMINENT_PEOPLE', imageOutputOptions: { mimeType: 'image/jpeg', compressionQuality: 70 } });
  assert.equal(b.generationConfig.seed, 9);
  assert.equal(b.generationConfig.thinkingConfig.thinkingLevel, 'high');
  // dev 通道：同样的参数（卡不会给，但旧数据 / 直调也别让 SDK 在客户端抛错）
  calls = [];
  await run('gemini', { kind: 'image', model: 'gemini-3.1-flash-image', card: googleCard('gemini', 'gemini-3.1-flash-image'), prompt: 'x', params: { ...params } });
  const d = calls.find((c) => /:generateContent/.test(c.url)).body;
  assert.deepEqual(d.generationConfig.imageConfig, { aspectRatio: '8:1', imageSize: '512' });
  assert.equal(d.generationConfig.seed, 9);
});

test('图像请求体大小保护：参考图 ≤3 张照旧；超过 3 张时先丢续改链最早的轮次，参考图本身超了不发', () => {
  const big = (n) => ({ data: Buffer.alloc(n) });
  const turns = [big(5e6), big(5e6), big(5e6)];
  const refs4 = Array.from({ length: 4 }, () => ({ role: 'ref', data: Buffer.alloc(1e6) }));
  assert.equal(fitImageBody(turns, refs4.slice(0, 3)), turns, '3 张以内一字不动');
  const kept = fitImageBody(turns, refs4);
  assert.equal(kept.length, 2, '4MB 参考图 + 3×5MB 链（base64 后 ~25MB）超了：丢最早一轮');
  assert.equal(kept[0], turns[1]);
  const huge = Array.from({ length: 14 }, () => ({ role: 'ref', data: Buffer.alloc(2e6) }));
  assert.throws(() => fitImageBody([], huge), /参考图加起来太大/);
});

// ====================== 视频 ======================
test('Veo 卡：种子 / 人物生成 / 首帧适配（只在有首帧时）/ 条数；默认都不传、旧参数规范化不变', () => {
  const veo = googleCard('vertex', 'veo-3.1-fast-generate-001');
  assert.deepEqual(keys(veo), ['aspectRatio', 'resolution', 'durationSeconds', 'generateAudio', 'count', 'enhancePrompt', 'compressionQuality', 'personGeneration', 'resizeMode', 'seed']);
  assert.deepEqual([spec(veo, 'count').format, spec(veo, 'count').group, spec(veo, 'count').default, spec(veo, 'count').max], ['count', 'basic', 1, 4]);
  assert.deepEqual(values(spec(veo, 'personGeneration')), ['', 'allow_adult', 'dont_allow']);
  assert.deepEqual(spec(veo, 'resizeMode').when, { $first: true });
  assert.equal(spec(veo, 'seed').max, 4294967295);
  assert.equal(spec(veo, 'generateAudio').default, false, '生成音频默认照旧关（计费不变）');
  // 旧写法：没给的新参数一个都不出现
  assert.deepEqual(veo.normalize({ durationSeconds: 8, resolution: '720p', aspectRatio: 'auto', generateAudio: true }),
    { aspectRatio: 'auto', resolution: '720p', durationSeconds: 8, generateAudio: true });
  const n = veo.normalize({ count: 9, seed: 5, personGeneration: 'dont_allow', resizeMode: 'CROP' }, { $first: true });
  assert.deepEqual([n.count, n.seed, n.personGeneration, n.resizeMode], [4, 5, 'dont_allow', 'CROP']);
  assert.equal(veo.normalize({ resizeMode: 'CROP' }, { $first: false }).resizeMode, undefined, '没首帧不带');
  assert.equal(veo.normalize({ personGeneration: 'allow_all' }).personGeneration, undefined);
  assert.equal(veo.normalize({ durationSeconds: 4 }, { $ref: true }).durationSeconds, 8, '参考图只能 8 秒（照旧）');
});

test('Omni 卡：两款都收首尾帧、1.2 另收 6 张参考图；首尾帧时长 ≤10 秒；种子；Veo 专属项照旧不给', () => {
  const o11 = googleCard('gemini', 'gemini-omni-1.1-flash');
  const o12 = googleCard('gemini', 'gemini-omni-1.2-flash');
  assert.deepEqual(o11.inputs.images, { max: 1, roles: ['first', 'last'] });
  assert.deepEqual(o12.inputs.images, { max: 6, roles: ['first', 'last', 'ref'] });
  assert.equal(o12.label, 'Gemini Omni 1.2');
  assert.deepEqual(values(spec(o12, 'durationSeconds')), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(spec(o12, 'durationSeconds').options.find((o) => o.value === 11).only, { $last: false });
  assert.equal(spec(o12, 'durationSeconds').options.find((o) => o.value === 10).only, undefined);
  assert.equal(o12.normalize({ durationSeconds: 15 }, { $first: true, $last: true }).durationSeconds, 10);
  assert.equal(o12.normalize({ durationSeconds: 15 }, { $ref: true }).durationSeconds, 15, '参考图不受 8 秒限制（那是 Veo 的）');
  assert.equal(o12.normalize({ durationSeconds: 15 }).durationSeconds, 15);
  assert.deepEqual(keys(o11), ['aspectRatio', 'resolution', 'durationSeconds', 'seed']);
  assert.equal(spec(o11, 'seed').max, 2147483647);
  assert.deepEqual(o11.normalize({ durationSeconds: 3, resolution: '360p', count: 3, personGeneration: 'dont_allow', seed: 4 }),
    { aspectRatio: 'auto', resolution: '360p', durationSeconds: 3, generateAudio: false, seed: 4 });
  assert.ok(caps.veoTaskOk('gemini-omni-1.1-flash', 'interp') && !caps.veoTaskOk('gemini-omni-1.1-flash', 'ref'));
  assert.ok(caps.veoTaskOk('gemini-omni-1.2-flash', 'ref'));
  assert.ok(!caps.VEO_MODELS.has('gemini-omni-1.2-flash'), 'Claude 工具 / 旧接口的白名单不动');
});

test('Omni 请求体：首尾帧两张图在前 + task image_to_video、时长夹到 10；参考图 + task reference_to_video；种子；文生 / 图生请求体同以前', () => {
  const im = (d) => ({ imageBytes: d, mimeType: 'image/png' });
  const interp = omni.buildRequest({ model: 'gemini-omni-1.2-flash', prompt: '日出到星空', task: 'interp', image: im('A'), lastFrame: im('B'), durationSeconds: 15, maxDuration: 15, seed: 3 });
  assert.deepEqual(interp.input.map((x) => x.type + ':' + (x.data || x.text)), ['image:A', 'image:B', 'text:日出到星空']);
  assert.equal(interp.response_format.duration, '10s');
  assert.deepEqual(interp.generation_config, { seed: 3, video_config: { task: 'image_to_video' } });
  const ref = omni.buildRequest({ model: 'gemini-omni-1.2-flash', prompt: '猫玩毛线', task: 'ref', referenceImages: [im('C'), im('D')], durationSeconds: 12, maxDuration: 15 });
  assert.deepEqual(ref.input.map((x) => x.type), ['image', 'image', 'text']);
  assert.equal(ref.response_format.duration, '12s');
  assert.deepEqual(ref.generation_config, { video_config: { task: 'reference_to_video' } });
  // 以前的两种：一字不变（没有 generation_config）
  assert.deepEqual(omni.buildRequest({ model: 'gemini-omni-1.1-flash', prompt: 'p', task: 't2v', aspectRatio: 'auto', durationSeconds: 12, resolution: '360p' }),
    { model: 'gemini-omni-1.1-flash', input: 'p', response_format: { type: 'video', resolution: '360p', duration: '10s' }, background: true });
  assert.deepEqual(omni.buildRequest({ model: 'gemini-omni-1.1-flash', prompt: 'p', task: 'i2v', image: im('A'), aspectRatio: '9:16', durationSeconds: 5 }),
    { model: 'gemini-omni-1.1-flash', input: [{ type: 'image', data: 'A', mime_type: 'image/png' }, { type: 'text', text: 'p' }], response_format: { type: 'video', aspect_ratio: '9:16', duration: '5s' }, background: true });
});

test('Omni 适配器：首帧 + 尾帧按 interp 发；1.2 的参考图按 ref 发', async () => {
  calls = [];
  reply = () => ({ id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('mp4').toString('base64'), mime_type: 'video/mp4' }] }] });
  const card = googleCard('gemini', 'gemini-omni-1.2-flash');
  const inputs = [{ role: 'first', data: PNG, mime: 'image/png' }, { role: 'last', data: PNG, mime: 'image/png' }];
  const params = card.normalize({ durationSeconds: 14, seed: 8 }, { $first: true, $last: true });
  const out = await run('gemini', { kind: 'video', model: 'gemini-omni-1.2-flash', card, prompt: '过渡', params, inputs });
  assert.equal(out.assets[0].meta.task, 'interp');
  const b = calls.find((c) => /interactions/.test(c.url)).body;
  assert.equal(b.input.filter((x) => x.type === 'image').length, 2);
  assert.deepEqual(b.generation_config, { seed: 8, video_config: { task: 'image_to_video' } });
  assert.equal(b.response_format.duration, '10s');
  calls = [];
  const refs = Array.from({ length: 6 }, () => ({ role: 'ref', data: PNG, mime: 'image/png' }));
  const r2 = await run('gemini', { kind: 'video', model: 'gemini-omni-1.2-flash', card, prompt: '两个角色', params: card.normalize({}, { $ref: true }), inputs: refs });
  assert.equal(r2.assets[0].meta.task, 'ref');
  const b2 = calls.find((c) => /interactions/.test(c.url)).body;
  assert.equal(b2.input.filter((x) => x.type === 'image').length, 6);
  assert.equal(b2.generation_config.video_config.task, 'reference_to_video');
});

test('Veo 适配器：条数 / 种子 / 人物生成 / 首帧适配进 parameters；多条视频每条一件作品', async () => {
  calls = [];
  reply = (c) => (/:predictLongRunning/.test(c.url)
    ? { name: 'projects/p1/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op1', done: true,
      response: { videos: [{ bytesBase64Encoded: Buffer.from('v1').toString('base64'), mimeType: 'video/mp4' }, { bytesBase64Encoded: Buffer.from('v2').toString('base64'), mimeType: 'video/mp4' }] } }
    : {});
  const card = googleCard('vertex', 'veo-3.1-fast-generate-001');
  const params = card.normalize({ count: 2, seed: 11, personGeneration: 'allow_adult', resizeMode: 'PAD', durationSeconds: 8 }, { $first: true });
  const out = await run('vertex', { kind: 'video', model: 'veo-3.1-fast-generate-001', card, prompt: '海浪', params, inputs: [{ role: 'first', data: PNG, mime: 'image/png' }] });
  assert.deepEqual(out.assets.map((a) => a.bytes.toString()), ['v1', 'v2']);
  const b = calls.find((c) => /:predictLongRunning/.test(c.url)).body;
  assert.match(calls.find((c) => /:predictLongRunning/.test(c.url)).url, /relay\.test\/v1\/vertex\/us-central1\//);
  assert.equal(b.parameters.sampleCount, 2);
  assert.equal(b.parameters.seed, 11);
  assert.equal(b.parameters.personGeneration, 'allow_adult');
  assert.equal(b.parameters.resizeMode, 'PAD');
  assert.ok(b.instances[0].image);
  // 旧写法（没给新参数）：sampleCount 照旧 1、新键一个都不带
  calls = [];
  await run('vertex', { kind: 'video', model: 'veo-3.1-fast-generate-001', card, prompt: '海浪', params: card.normalize({ durationSeconds: 8 }) });
  const p0 = calls.find((c) => /:predictLongRunning/.test(c.url)).body.parameters;
  assert.equal(p0.sampleCount, 1);
  for (const k of ['seed', 'personGeneration', 'resizeMode']) assert.equal(k in p0, false, k);
});

// ====================== 配音 ======================
test('配音卡：说话人模式（单人 / 双人对白）与 when；语言；3.8 两款是内置卡；gemini 方言认 dev API 的 -preview id', () => {
  const c = googleCard('vertex', 'gemini-2.5-flash-tts');
  assert.deepEqual(keys(c), ['mode', 'voice', 'speakerA', 'voiceA', 'speakerB', 'voiceB', 'style', 'languageCode']);
  assert.deepEqual([spec(c, 'mode').default, spec(c, 'mode').group], ['single', 'basic']);
  assert.deepEqual(spec(c, 'voice').when, { mode: 'single' });
  for (const k of ['speakerA', 'voiceA', 'speakerB', 'voiceB']) { assert.deepEqual(spec(c, k).when, { mode: 'multi' }, k); assert.equal(spec(c, k).group, 'basic', k); }
  assert.equal(spec(c, 'languageCode').options.length, 31);
  assert.equal(spec(c, 'languageCode').options[0].value, '');
  for (const id of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']) {
    const v = googleCard('vertex', id);
    assert.ok(v && !v.inheritsFrom, id + ' 是内置卡');
    assert.match(spec(v, 'style').desc, /不念出来/);
    assert.ok(googleCard('gemini', id), id + ' gemini 方言也认');
  }
  assert.equal(googleCard('vertex', 'gemini-3.8-flash-tts').label, 'Gemini 3.8 Flash TTS');
  const devFlash = googleCard('gemini', 'gemini-2.5-flash-preview-tts');
  assert.ok(devFlash && devFlash.id === 'google:gemini-2.5-flash-preview-tts' && devFlash.label === 'Gemini 2.5 Flash TTS');
  assert.ok(googleCard('gemini', 'gemini-2.5-pro-preview-tts'));
  assert.equal(googleCard('gemini', 'gemini-2.5-flash-tts'), null, 'dev API 上没有不带 -preview 的这个 id');
});

test('配音规范化：没给 mode 行为同以前；single 忽略说话人；multi 才组 speakers；语言白名单', () => {
  const c = googleCard('vertex', 'gemini-3.1-flash-tts-preview');
  const A = { speakerA: '甲', voiceA: 'Puck', speakerB: '乙', voiceB: 'Zephyr' };
  const two = [{ speaker: '甲', voice: 'Puck' }, { speaker: '乙', voice: 'Zephyr' }];
  // 旧写法
  assert.deepEqual(c.normalize({ voice: 'Puck' }), { voice: 'Puck', style: '' });
  assert.deepEqual(c.normalize(A), { voice: 'Kore', style: '', speakers: two });
  assert.deepEqual(c.normalize({ speakers: two, style: ' 轻松 ' }), { voice: 'Kore', style: '轻松', speakers: two });
  assert.equal(c.normalize({ speakers: [two[0]] }).speakers, undefined, '不足 2 人退回单人');
  // 新写法
  assert.deepEqual(c.normalize({ mode: 'single', voice: 'Leda', ...A }), { voice: 'Leda', style: '', mode: 'single' });
  assert.deepEqual(c.normalize({ mode: 'multi', ...A }), { voice: 'Kore', style: '', speakers: two, mode: 'multi' });
  assert.equal(c.normalize({ mode: 'multi', speakerA: '甲', voiceA: 'Puck' }).speakers, undefined);
  assert.equal(c.normalize({ mode: 'bogus', ...A }).mode, undefined, '不认的 mode 当没给（旧写法）');
  assert.deepEqual(c.normalize({ mode: 'bogus', ...A }).speakers, two);
  assert.equal(c.normalize({ languageCode: 'cmn-CN' }).languageCode, 'cmn-CN');
  assert.equal(c.normalize({ languageCode: 'zz-ZZ' }).languageCode, undefined);
});

test('配音请求体：旧型号风格拼在正文前；3.8 风格 / 说话人走 speechMetadata（extraBody 覆盖 contents，SDK 那份是纯文字）', () => {
  const old = tts.buildRequest({ text: '你好', voiceName: 'Puck', style: '轻松地说：', languageCode: 'cmn-CN' });
  assert.deepEqual(old.contents, [{ role: 'user', parts: [{ text: '轻松地说：\n你好' }] }]);
  assert.deepEqual(old.config.speechConfig, { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }, languageCode: 'cmn-CN' });
  assert.equal(old.config.httpOptions, undefined);
  // 旧型号、旧参数：一字不变
  assert.deepEqual(tts.buildRequest({ text: 'hi', voiceName: 'Kore', style: '' }), { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } } });
  // 3.8 单人
  const one = tts.buildRequest({ text: '你好', voiceName: 'Puck', style: '轻松', metaStyle: true });
  assert.deepEqual(one.config.httpOptions.extraBody.contents, [{ role: 'user', parts: [{ text: '你好', speechMetadata: { style: '轻松' } }] }]);
  assert.deepEqual(one.contents, [{ role: 'user', parts: [{ text: '你好' }] }]);
  assert.equal(tts.buildRequest({ text: '你好', metaStyle: true }).config.httpOptions, undefined, '没风格就不用 extraBody');
  // 3.8 多人：按「名字：台词」拆 turn，每个 turn 带 speaker
  const sp = [{ speaker: '甲', voice: 'Puck' }, { speaker: '乙', voice: 'Kore' }];
  const multi = tts.buildRequest({ text: '甲：早\n乙: 早上好\n今天不错\n丙：路人', speakers: sp, style: '', metaStyle: true });
  assert.deepEqual(multi.config.httpOptions.extraBody.contents[0].parts, [
    { text: '早', speechMetadata: { speaker: '甲' } },
    { text: '早上好\n今天不错\n丙：路人', speechMetadata: { speaker: '乙' } },
  ]);
  assert.equal(multi.config.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs.length, 2);
  assert.deepEqual(tts.splitTurns('开场白\n甲：嗨', ['甲', '乙']), [{ speaker: '甲', text: '开场白' }, { speaker: '甲', text: '嗨' }]);
});

test('配音出声：3.8 回的 WAV 原样用（不再套第二层头）；裸 PCM 照旧包头', () => {
  const p = tts.toPlayable({ data: wav.toString('base64'), mimeType: 'audio/wav' });
  assert.equal(p.bytes.length, wav.length);
  assert.equal(p.bytes.indexOf('RIFF', 4), -1, '只有一层 RIFF 头');
  assert.equal(tts.toPlayable({ data: wav.toString('base64'), mimeType: '' }).bytes.length, wav.length, '没标 mime 但带 RIFF 头的也认');
  const raw = tts.toPlayable({ data: pcm.toString('base64'), mimeType: 'audio/L16;codec=pcm;rate=16000' });
  assert.equal(raw.bytes.length, pcm.length + 44);
  assert.equal(raw.bytes.readUInt32LE(24), 16000);
  assert.equal(raw.mime, 'audio/wav');
});

test('配音适配器：3.8 的 speechMetadata 真的进了两条通道的请求体；回的 WAV 不双头', async () => {
  for (const dialect of ['vertex', 'gemini']) {
    calls = [];
    reply = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] });
    const card = googleCard(dialect, 'gemini-3.8-flash-tts');
    const params = card.normalize({ mode: 'multi', speakerA: '甲', voiceA: 'Puck', speakerB: '乙', voiceB: 'Kore', style: '温柔', languageCode: 'cmn-CN' });
    const out = await run(dialect, { kind: 'speech', model: 'gemini-3.8-flash-tts', card, prompt: '甲：你好\n乙：你好呀', params });
    assert.equal(out.assets[0].bytes.length, wav.length, dialect);
    const b = calls.find((c) => /:generateContent/.test(c.url)).body;
    assert.deepEqual(b.contents[0].parts, [{ text: '你好', speechMetadata: { style: '温柔', speaker: '甲' } }, { text: '你好呀', speechMetadata: { style: '温柔', speaker: '乙' } }], dialect);
    assert.equal(b.generationConfig.speechConfig.languageCode, 'cmn-CN', dialect);
    assert.equal(b.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs[1].voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  }
  // 旧型号（3.1）：风格照旧拼在正文前，不带 speechMetadata
  calls = [];
  reply = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm.toString('base64') } }] } }] });
  const c31 = googleCard('vertex', 'gemini-3.1-flash-tts-preview');
  const o = await run('vertex', { kind: 'speech', model: 'gemini-3.1-flash-tts-preview', card: c31, prompt: '你好', params: c31.normalize({ voice: 'Puck', style: '轻松地说：' }) });
  assert.equal(o.assets[0].bytes.length, pcm.length + 44);
  assert.deepEqual(calls.find((c) => /:generateContent/.test(c.url)).body.contents[0].parts, [{ text: '轻松地说：\n你好' }]);
});

// ====================== 音乐 ======================
test('音乐卡：lyria-002 种子 + 条数（种子优先）；lyria-3.5 输出格式与参考图；其余没参数', () => {
  const l2 = googleCard('vertex', 'lyria-002');
  assert.deepEqual(keys(l2), ['count', 'seed']);
  assert.deepEqual([spec(l2, 'count').format, spec(l2, 'count').max, spec(l2, 'count').default], ['count', 4, 1]);
  assert.match(spec(l2, 'seed').desc, /种子优先/);
  assert.deepEqual(l2.normalize({}), {});
  assert.deepEqual(l2.normalize({ count: 3 }), { count: 3 });
  assert.deepEqual(l2.normalize({ count: 3, seed: 12 }), { seed: 12 }, '给了种子就不发条数');
  const l35 = googleCard('gemini', 'lyria-3.5');
  assert.deepEqual(keys(l35), ['outputFormat']);
  assert.deepEqual(values(spec(l35, 'outputFormat')), ['', 'wav']);
  assert.deepEqual(l35.inputs.images, { max: 10, roles: ['ref'] });
  assert.deepEqual(l35.normalize({ outputFormat: 'wav', seed: 3 }), { outputFormat: 'wav' });
  assert.deepEqual(googleCard('gemini', 'lyria-3-clip-preview').params, []);
  assert.equal('images' in googleCard('gemini', 'lyria-3-pro-preview').inputs, false);
});

test('音乐请求体：lyria-002 种子与 sample_count 互斥、两种返回字段都认；lyria-3.5 WAV 走 responseFormat、图片在前', () => {
  assert.deepEqual(music.buildLyria2Body({ prompt: 'p', negativePrompt: 'n' }), { instances: [{ prompt: 'p', negative_prompt: 'n' }], parameters: { sample_count: 1 } }, '旧请求体一字不变');
  assert.deepEqual(music.buildLyria2Body({ prompt: 'p', count: 3 }).parameters, { sample_count: 3 });
  assert.deepEqual(music.buildLyria2Body({ prompt: 'p', seed: 5, count: 3 }), { instances: [{ prompt: 'p', seed: 5 }], parameters: {} });
  const clips = music.lyria2Clips({ predictions: [{ bytesBase64Encoded: Buffer.from('a').toString('base64') }, { audioContent: Buffer.from('b').toString('base64'), mimeType: 'audio/wav' }, {}] });
  assert.deepEqual(clips.map((c) => [c.bytes.toString(), c.mime]), [['a', 'audio/wav'], ['b', 'audio/wav']]);
  assert.deepEqual(music.buildLyria3Request({ model: 'lyria-3.5', prompt: 'song' }), { model: 'lyria-3.5', contents: [{ role: 'user', parts: [{ text: 'song' }] }] }, '旧请求一字不变');
  const w = music.buildLyria3Request({ model: 'lyria-3.5', prompt: 'song', outputFormat: 'wav', images: [{ data: 'IMG', mimeType: 'image/png' }] });
  assert.deepEqual(w.contents[0].parts, [{ inlineData: { data: 'IMG', mimeType: 'image/png' } }, { text: 'song' }]);
  assert.deepEqual(w.config.httpOptions.extraBody, { generationConfig: { responseFormat: { audio: { mimeType: 'AUDIO_WAV' } } } });
});

test('音乐适配器：lyria-3.5 歌词进作品侧车、WAV 真的进了请求体；lyria-002 多条每条一件', async () => {
  calls = [];
  reply = () => ({ candidates: [{ content: { parts: [{ text: '[Verse]\n第一段' }, { text: '{"structure":"verse"}' }, { inlineData: { mimeType: 'audio/wav', data: Buffer.from('song').toString('base64') } }] } }] });
  const card = googleCard('gemini', 'lyria-3.5');
  const out = await run('gemini', { kind: 'music', model: 'lyria-3.5', card, prompt: '民谣', params: card.normalize({ outputFormat: 'wav' }), inputs: [{ role: 'ref', data: PNG, mime: 'image/png' }] });
  assert.equal(out.assets[0].bytes.toString(), 'song');
  assert.equal(out.assets[0].meta.lyrics, '[Verse]\n第一段\n\n{"structure":"verse"}');
  const b = calls.find((c) => /:generateContent/.test(c.url)).body;
  assert.equal(b.generationConfig.responseFormat.audio.mimeType, 'AUDIO_WAV');
  assert.equal(b.contents[0].parts[0].inlineData.mimeType, 'image/png');
  calls = [];
  reply = () => ({ predictions: [{ audioContent: Buffer.from('x').toString('base64'), mimeType: 'audio/wav' }, { bytesBase64Encoded: Buffer.from('y').toString('base64') }] });
  const l2 = googleCard('vertex', 'lyria-002');
  const o2 = await run('vertex', { kind: 'music', model: 'lyria-002', card: l2, prompt: 'calm piano', params: l2.normalize({ count: 2 }) });
  assert.deepEqual(o2.assets.map((a) => a.bytes.toString()), ['x', 'y']);
  assert.equal(o2.assets[0].meta, undefined, 'lyria-002 没有歌词');
  assert.deepEqual(calls[0].body.parameters, { sample_count: 2 });
});
