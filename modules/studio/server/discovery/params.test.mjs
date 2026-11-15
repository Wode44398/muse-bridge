// Media Studio 参数补全（2026-11-15）：schema 转换器（嵌套对象拍平、对象数组 json、改图角色、描述里的数量上限、负面词默认值）、
// 内置卡 + schema 合并、通用卡、fal / Replicate 的请求组装。全部喂 fixtures/ 里的真实 schema 或手写的小 schema，不连网、不起服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.mjs';
import { applySpecs, genericCard, parseJsonParam } from '../cards/spec.mjs';
import { mergeBuiltinWithSchema, coveredFields } from '../cards/merge.mjs';
import { falAdapter, CARDS as FAL } from '../adapters/fal.mjs';
import { replicateAdapter, CARDS as REP } from '../adapters/replicate.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
// 同 sources.falSchemaOf（那个文件带着 Google 卡的依赖，这里只要 schema）
function falSchema(f) {
  const o = JSON.parse(readFileSync(path.join(FX, f), 'utf8')).models[0].openapi;
  const cs = o.components?.schemas || {};
  for (const [p, ops] of Object.entries(o.paths)) {
    if (/\{request_id\}/.test(p) || !ops?.post) continue;
    const s = ops.post.requestBody.content['application/json'].schema;
    return { input: s.$ref ? cs[s.$ref.split('/').pop()] : s, defs: cs };
  }
}
const conv = (f, kind) => { const s = falSchema(f); return schema.fromJsonSchema(kind, s.input, s.defs); };
const keys = (params) => params.map((s) => s.key);
const spec = (params, k) => params.find((s) => s.key === k);

// —— 假 fetch（fal / Replicate 执行）——
async function withFetch(handler, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const c = { url: String(url), method: String(init.method || 'GET').toUpperCase(), body };
    calls.push(c);
    return handler(c);
  };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const bin = (b, type) => new Response(b, { status: 200, headers: { 'content-type': type } });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const falOk = (result, mime) => (c) => {
  if (c.method === 'POST') return json({ request_id: 'r1', response_url: 'https://queue.fal.run/x/y/requests/r1', status_url: 'https://queue.fal.run/x/y/requests/r1/status', cancel_url: 'https://queue.fal.run/x/y/requests/r1/cancel' });
  if (c.url.endsWith('/status')) return json({ status: 'COMPLETED' });
  if (c.url.endsWith('/requests/r1')) return json(result);
  return bin(Buffer.from('x'), mime);
};
const falProvider = { id: 'p-t', dialect: 'fal', baseUrl: 'https://queue.fal.run', authStyle: 'fal-key', headers: {}, params: {}, timeoutSec: 60 };
const falCtx = () => ({ secret: { key: 'k' }, signal: new AbortController().signal, pollMs: 1, progress() {}, submitted() {} });
const repProvider = { id: 'p-r', dialect: 'replicate', baseUrl: 'https://api.replicate.com/v1', authStyle: 'bearer', headers: {}, params: {}, timeoutSec: 60 };
const repOk = (out, mime) => (c) => (c.method === 'POST' ? json({ id: 'pred1', status: 'succeeded', output: out }, 201) : bin(Buffer.from('x'), mime));
const repCtx = () => ({ secret: { key: 'k' }, signal: new AbortController().signal, pollMs: 1, progress() {}, submitted() {} });

// —— fixtures：转换前后 ——
test('flux-dev：参数键不变（加速档标签修成中文）；没有复杂字段时原始参数说明不列东西', () => {
  const b = conv('fal-flux-dev.json', 'image');
  assert.deepEqual(keys(b.params), ['image_size', 'num_inference_steps', 'seed', 'guidance_scale', 'num_images', 'enable_safety_checker', 'output_format', 'acceleration', 'extra']);
  assert.equal(spec(b.params, 'acceleration').label, '加速');
  assert.deepEqual(spec(b.params, 'acceleration').options.map((o) => o.label), ['无', '常规', '高']);
  assert.equal(spec(b.params, 'extra').desc, 'JSON 对象，原样合并进请求体');
});

test('Kling v3 i2v：multi_prompt / elements 做成 json 数组（带示例骨架）；负面词默认值进 inputs.negativeDefault；数组参数服务端只收数组', () => {
  const b = conv('fal-kling-v3-pro-i2v.json', 'video');
  assert.deepEqual(keys(b.params), ['enable_safety_checker', 'multi_prompt', 'duration', 'generate_audio', 'elements', 'shot_type', 'cfg_scale', 'extra']);
  const mp = spec(b.params, 'multi_prompt');
  assert.deepEqual([mp.type, mp.array, mp.group, mp.label], ['json', true, 'advanced', '分镜']);
  assert.ok(mp.desc.startsWith('JSON 数组，如 [{ "prompt": "", "duration": "5" }]'), mp.desc);
  const el = spec(b.params, 'elements');
  assert.ok(el.desc.includes('"frontal_image_url": ""') && el.desc.includes('"reference_image_urls": [""]'), el.desc);
  assert.equal(b.inputs.negativeDefault, 'blur, distort, and low quality');
  assert.equal(spec(b.params, 'extra').desc, 'JSON 对象，原样合并进请求体', '不再有丢进原始参数的复杂字段');
  // 规范化：字符串 JSON 解析成数组；空数组不发；对象 → 400
  assert.deepEqual(applySpecs([mp], { multi_prompt: '[{"prompt":"a","duration":"3"}]' }), { multi_prompt: [{ prompt: 'a', duration: '3' }] });
  assert.deepEqual(applySpecs([mp], { multi_prompt: [] }), {});
  assert.throws(() => applySpecs([mp], { multi_prompt: '{"prompt":"a"}' }), (e) => e.status === 400 && /JSON 数组/.test(e.message));
  assert.throws(() => parseJsonParam('[{"__proto__":1}]', '分镜', { array: true }), /不允许的键/);
  assert.throws(() => parseJsonParam([1], '额外参数'), /JSON 对象/, '不带 array 照旧只收对象');
  // 请求体：数组原样进字段
  const body = schema.wireBody(b.wire, applySpecs(b.params, { multi_prompt: [{ prompt: 'a', duration: '5' }] }), { kind: 'video', prompt: 'p', inputs: [] }, (x) => x);
  assert.deepEqual(body.multi_prompt, [{ prompt: 'a', duration: '5' }]);
});

test('Seedance 2.5 reference：image_urls 没有 maxItems，从描述「Up to 30 images」解析出 30（不再一律 10）', () => {
  const b = conv('fal-seedance-2.5-reference.json', 'video');
  assert.deepEqual(b.inputs.images, { max: 30, roles: ['ref'] });
  assert.deepEqual([b.inputs.video, b.inputs.audio], [{ max: 10 }, { max: 10 }]);
  assert.equal(schema.maxFromDescription('Max 30 MB per image. Up to 30 images. Total files must not exceed 50.'), 30, '「Max 30 MB」不算');
  assert.equal(schema.maxFromDescription('Reference audio files (up to 3, total duration max 15s)'), 3);
  assert.equal(schema.maxFromDescription('List of input images. Maximum 8 images.'), 8);
  assert.equal(schema.maxFromDescription('最多 9 张参考图'), 9);
  assert.equal(schema.maxFromDescription('Up to 3 shots'), 3, '「shots」不是单位 s');
  assert.equal(schema.maxFromDescription('max 15s, at most 120 seconds'), undefined);
});

test('ElevenLabs v4：参数清单不变（回归）；language_code 单行', () => {
  const b = conv('fal-elevenlabs-tts-v4.json', 'speech');
  assert.deepEqual(keys(b.params), ['voice', 'stability', 'similarity_boost', 'seed', 'language_code', 'output_format', 'apply_text_normalization', 'timestamps', 'extra']);
  assert.equal(spec(b.params, 'language_code').multiline, undefined);
});

test('fal MiniMax Speech 2.8 HD（没有内置卡时的 schema 卡）：嵌套对象拍平成点路径键，音色可选；可选整组不碰就不发；wireBody 装回嵌套对象', () => {
  const b = conv('fal-minimax-speech-2.8-hd.json', 'speech');
  assert.equal(b.wire.text, 'prompt');
  const v = spec(b.params, 'voice_setting.voice_id');
  assert.deepEqual([v.type, v.group, v.default, v.label], ['voice', 'basic', 'Wise_Woman', '音色'], 'voice_setting 有默认对象：子字段默认取它的');
  assert.deepEqual([spec(b.params, 'voice_setting.speed').label, spec(b.params, 'voice_setting.speed').default, spec(b.params, 'voice_setting.speed').max], ['语速', 1, 2]);
  // audio_setting 可选、没有默认对象：子字段都不带默认（枚举带「默认」档）
  const sr = spec(b.params, 'audio_setting.sample_rate');
  assert.deepEqual([sr.type, sr.default, sr.options[0].value, sr.label], ['enum', '', '', '采样率']);
  assert.deepEqual(spec(b.params, 'audio_setting.channel').options.map((o) => o.label), ['默认', '单声道', '立体声']);
  assert.equal(spec(b.params, 'audio_setting.format').label, '音频设置 · 格式', '和顶层 output_format（格式）撞名时加父名');
  assert.equal(spec(b.params, 'voice_modify.pitch').label, '明暗');
  assert.equal(spec(b.params, 'voice_modify.pitch').default, undefined);
  const en = spec(b.params, 'normalization_setting.enabled');
  assert.deepEqual([en.type, en.default, en.options.map((o) => o.value), en.label], ['enum', '', ['', true, false], '响度均衡'], '可选整组里的开关给三档');
  assert.deepEqual([spec(b.params, 'pronunciation_dict').type, spec(b.params, 'pronunciation_dict').array], ['json', undefined], '子字段里有数组：整个当 json 对象');
  assert.ok(spec(b.params, 'pronunciation_dict').desc.startsWith('JSON 对象，如 { "tone_list": [""] }'));
  assert.equal(spec(b.params, 'language_boost').label, '语种增强');
  assert.ok(b.params.filter((s) => s.group === 'basic').length <= 4);
  // 请求体
  const p = applySpecs(b.params, { 'voice_setting.voice_id': 'Chinese (Mandarin)_Warm_Girl', 'voice_setting.speed': 1.2, 'audio_setting.sample_rate': 44100, 'voice_modify.timbre': 30 });
  const body = schema.wireBody(b.wire, p, { kind: 'speech', prompt: '你好', inputs: [] }, (x) => x);
  assert.deepEqual(body.voice_setting, { voice_id: 'Chinese (Mandarin)_Warm_Girl', speed: 1.2, vol: 1, pitch: 0, english_normalization: false });
  assert.deepEqual(body.audio_setting, { sample_rate: 44100 });
  assert.deepEqual(body.voice_modify, { timbre: 30 });
  assert.equal('normalization_setting' in body, false, '没碰的可选整组不发');
  assert.equal(body.prompt, '你好');
  assert.equal(Object.keys(body).some((k) => k.includes('.')), false, '请求体里没有点路径键');
});

test('mediaRole：图像模型的列表型主图同一个字段既是 edit 又是 ref；纯参考字段只当 ref；续改链上一张走它', () => {
  const s = { type: 'object', required: ['prompt'], properties: {
    prompt: { type: 'string' },
    image_urls: { type: 'array', items: { type: 'string' }, description: 'Images to edit (up to 6)' },
    pdf_url: { type: 'string', description: 'Optional PDF document' },
  } };
  const b = schema.fromJsonSchema('image', s);
  assert.deepEqual(b.inputs.images, { max: 6, roles: ['edit', 'ref'] });
  assert.deepEqual([b.wire.images.edit, b.wire.images.ref], [{ field: 'image_urls', list: true }, { field: 'image_urls', list: true }]);
  assert.deepEqual(schema.mediaRole('image_urls', s.properties.image_urls, 'image'), { role: 'edit', roles: ['edit', 'ref'], list: true, max: 6 });
  const pdf = spec(b.params, 'pdf_url');
  assert.deepEqual([pdf.type, pdf.multiline], ['text', undefined], '非媒体 URL 照旧是单行文本');
  // 续改链：没给素材，拿上一张当改图对象塞进 image_urls
  const body = schema.wireBody(b.wire, {}, { kind: 'image', prompt: 'p', inputs: [], thread: { turns: [{ data: 'D', mime: 'image/png' }] } }, (x) => 'u:' + x.data);
  assert.deepEqual(body.image_urls, ['u:D']);
  // 改图 + 参考图同一个数组
  const b2 = schema.wireBody(b.wire, {}, { kind: 'image', prompt: 'p', inputs: [{ role: 'edit', data: 'A' }, { role: 'ref', data: 'B' }] }, (x) => x.data);
  assert.deepEqual(b2.image_urls, ['A', 'B']);
  // 只有 reference_images：纯参考，不给 edit
  const r = schema.fromJsonSchema('image', { type: 'object', properties: { prompt: { type: 'string' }, reference_images: { type: 'array', items: { type: 'string', format: 'uri' } } } });
  assert.deepEqual(r.inputs.images.roles, ['ref']);
  // 视频模型的列表主图照旧是参考图
  assert.equal(schema.mediaRole('image_urls', { type: 'array' }, 'video').role, 'ref');
});

test('参数上限放宽到 60：超出的照样列进「原始参数」说明', () => {
  const props = { prompt: { type: 'string' } };
  for (let i = 0; i < 70; i++) props[`knob_${i}`] = { type: 'number', minimum: 0, maximum: 1 };
  const b = schema.fromJsonSchema('image', { type: 'object', properties: props });
  assert.equal(b.params.length, 61);
  assert.ok(spec(b.params, 'extra').desc.includes('knob_60'), spec(b.params, 'extra').desc);
});

test('setPath / expandDotted / mergeBodies：点路径只展开一层、挡掉原型键；同名对象并一层', () => {
  assert.deepEqual(schema.expandDotted({ 'a.b': 1, 'a.c': 2, d: 3 }), { a: { b: 1, c: 2 }, d: 3 });
  assert.deepEqual(schema.expandDotted({ '__proto__.x': 1, 'a.__proto__': 2 }), {});
  assert.deepEqual(schema.mergeBodies({ v: { a: 1 }, n: [1] }, { v: { b: 2 }, n: [2] }), { v: { a: 1, b: 2 }, n: [2] });
});

// —— 内置卡 + schema 合并 ——
test('合并：内置卡已经发过的上游字段不重复追加（fal 用探测 wire 看实际字段，含嵌套子字段）；没东西可加就原样返回', () => {
  const flux = FAL['fal-ai/flux/dev'];
  assert.ok(coveredFields(flux).has('acceleration'), '等于默认才不发的字段也算发过');
  assert.equal(mergeBuiltinWithSchema(flux, conv('fal-flux-dev.json', 'image')), flux);
  const mm = FAL['fal-ai/minimax/speech-2.8-hd'];
  assert.ok(['voice_setting.voice_id', 'audio_setting.channel', 'voice_modify.timbre', 'normalization_setting.enabled', 'pronunciation_dict'].every((k) => coveredFields(mm).has(k)));
  assert.equal(mergeBuiltinWithSchema(mm, conv('fal-minimax-speech-2.8-hd.json', 'speech')), mm);
  const kling = FAL['fal-ai/kling-video/v3/pro/image-to-video'];
  assert.equal(mergeBuiltinWithSchema(kling, conv('fal-kling-v3-pro-i2v.json', 'video')), kling);
});

test('合并（fal，函数 wire）：schema 多出的参数追加到 advanced 末尾（extra 前），多出的素材角色补进 inputs；执行时经 wireExtra 进请求体', async () => {
  const s = falSchema('fal-flux-dev.json');
  const input = { ...s.input, properties: { ...s.input.properties,
    new_knob: { type: 'number', minimum: 0, maximum: 1, description: 'A new knob' },
    old_knob: { type: 'boolean', description: 'Deprecated alias for new_knob' },
    reference_image_url: { type: 'string', description: 'Style reference' },
    camera: { type: 'object', properties: { pan: { type: 'integer', minimum: -10, maximum: 10 }, zoom: { type: 'number' } } },
  } };
  const flux = FAL['fal-ai/flux/dev'];
  const m = mergeBuiltinWithSchema(flux, schema.fromJsonSchema('image', input, s.defs));
  assert.notEqual(m, flux);
  assert.equal(flux.schemaMerged, undefined, '内置卡本身不动');
  assert.deepEqual(m.schemaAdded, ['new_knob', 'camera.pan', 'camera.zoom'], '已弃用的 old_knob 不追加');
  assert.deepEqual(keys(m.params).slice(-5), ['seed', 'new_knob', 'camera.pan', 'camera.zoom', 'extra']);
  assert.ok(m.params.filter((x) => m.schemaAdded.includes(x.key)).every((x) => x.group === 'advanced'));
  assert.deepEqual(m.inputs.images, { max: 1, roles: ['ref'] });
  assert.deepEqual(m.wireExtra, { params: ['new_knob', 'camera.pan', 'camera.zoom'], images: { ref: { field: 'reference_image_url', list: false } } });
  assert.equal(m.wire, flux.wire);
  const params = applySpecs(m.params, { imageSize: 'square_hd', new_knob: 0.3, 'camera.pan': 4 });
  await withFetch(falOk({ images: [{ url: 'https://v3b.fal.media/a.png' }] }, 'image/png'), async (calls) => {
    await falAdapter.run({ kind: 'image', model: 'fal-ai/flux/dev', card: m, prompt: '猫', negative: '', params, inputs: [{ role: 'ref', data: PNG, mime: 'image/png' }], thread: null }, falProvider, falCtx());
    const b = calls[0].body;
    assert.equal(b.image_size, 'square_hd');
    assert.equal(b.num_inference_steps, 28, '内置卡的映射照旧');
    assert.equal(b.new_knob, 0.3);
    assert.deepEqual(b.camera, { pan: 4 });
    assert.ok(String(b.reference_image_url).startsWith('data:image/png;base64,'));
    assert.equal('acceleration' in b, false);
  });
});

test('合并（Replicate，对象 wire）：追加参数原样透传、点路径装回嵌套对象；追加的视频素材并进 wire；内置卡的张数上限保住', async () => {
  const kling = REP['kwaivgi/kling-v3-video'];
  const input = { type: 'object', required: ['prompt'], properties: {
    prompt: { type: 'string' }, duration: { type: 'integer', minimum: 3, maximum: 15 }, start_image: { type: 'string', format: 'uri' },
    camera_control: { type: 'object', properties: { type: { type: 'string', enum: ['simple', 'down_back'] }, horizontal: { type: 'number', minimum: -10, maximum: 10 } } },
    reference_video: { type: 'string', format: 'uri' },
  } };
  const m = mergeBuiltinWithSchema(kling, schema.fromJsonSchema('video', input));
  assert.deepEqual(m.schemaAdded, ['camera_control.type', 'camera_control.horizontal']);
  assert.deepEqual(m.inputs.video, { max: 1 });
  assert.deepEqual(m.wire.video, { field: 'reference_video', list: false });
  assert.deepEqual(m.wire.images, kling.wire.images);
  assert.equal(m.wireExtra, undefined);
  const params = applySpecs(m.params, { duration: 5, 'camera_control.type': 'simple', 'camera_control.horizontal': 2, multi_prompt: '[{"prompt":"a","duration":5}]' });
  await withFetch(repOk('https://replicate.delivery/x/v.mp4', 'video/mp4'), async (calls) => {
    await replicateAdapter.run({ kind: 'video', model: 'kwaivgi/kling-v3-video', card: m, prompt: 'p', negative: '', params, inputs: [{ role: 'video', data: Buffer.from('v'), mime: 'video/mp4' }], thread: null }, repProvider, repCtx());
    const inp = calls[0].body.input;
    assert.deepEqual(inp.camera_control, { type: 'simple', horizontal: 2 });
    assert.equal(inp.multi_prompt, '[{"prompt":"a","duration":5}]', 'Kling 的 multi_prompt 按字符串发（schema 是字符串）');
    assert.ok(inp.reference_video.startsWith('data:video/mp4;base64,'));
    assert.equal(Object.keys(inp).some((k) => k.includes('.')), false);
  });
  // Veo：schema 的 reference_images 没有 maxItems（描述里写的是 1 to 3），合并后上限仍是内置卡的 3
  const veo = REP['google/veo-3.1'];
  const v = mergeBuiltinWithSchema(veo, schema.fromJsonSchema('video', { type: 'object', properties: { prompt: { type: 'string' }, reference_images: { type: 'array', items: { type: 'string', format: 'uri' } }, image: { type: 'string', format: 'uri' }, end_frame: { type: 'string', format: 'uri' } } }));
  assert.equal(v.inputs.images.max, 3);
  assert.deepEqual(v.inputs.images.roles, ['first', 'last', 'ref'], 'end_frame（尾帧）内置卡已有角色，不重复');
});

test('合并：内置卡自带 normalize 时追加参数也规范化；negativeDefault 补上', () => {
  const music = REP['minimax/music-2.5'];
  const m = mergeBuiltinWithSchema(music, schema.fromJsonSchema('music', { type: 'object', properties: {
    prompt: { type: 'string' }, lyrics: { type: 'string' }, new_flag: { type: 'boolean', default: false },
    negative_prompt: { type: 'string', default: 'noise' },
    audio_format: { type: 'string', enum: ['mp3', 'wav'], default: 'mp3', description: 'Deprecated alias for output_format.' },
  } }));
  assert.deepEqual(m.schemaAdded, ['new_flag']);
  assert.deepEqual([m.inputs.negative, m.inputs.negativeDefault, m.wire.negative], [true, 'noise', 'negative_prompt']);
  assert.deepEqual(m.normalize({ audio_format: 'wav', new_flag: true }), { new_flag: true, output_format: 'wav', bitrate: 256000, sample_rate: 44100 });
});

// —— 内置卡补项 ——
test('fal 内置卡补项：新参数界面默认 = 上游默认、等于默认不发（老请求体不变）；改了才进请求体', async () => {
  const bodyOf = async (model, kind, raw, extra = {}) => {
    const card = FAL[model];
    let b;
    await withFetch(falOk({ images: [{ url: 'https://v3b.fal.media/a.png' }], video: { url: 'https://v3b.fal.media/v.mp4' }, audio: { url: 'https://v3b.fal.media/a.mp3' } }, 'image/png'), async (calls) => {
      await falAdapter.run({ kind, model, card, prompt: 'a long prompt for testing', negative: '', params: applySpecs(card.params, raw), inputs: [], thread: null, ...extra }, falProvider, falCtx());
      b = calls[0].body;
    });
    return b;
  };
  const f0 = await bodyOf('fal-ai/flux/dev', 'image', {});
  assert.deepEqual(Object.keys(f0).sort(), ['guidance_scale', 'image_size', 'num_images', 'num_inference_steps', 'output_format', 'prompt']);
  const f1 = await bodyOf('fal-ai/flux/dev', 'image', { acceleration: 'high', enableSafetyChecker: false });
  assert.deepEqual([f1.acceleration, f1.enable_safety_checker], ['high', false]);
  const nb = await bodyOf('fal-ai/nano-banana-2', 'image', { safetyTolerance: '6', thinkingLevel: 'high', temperature: 0.7, limitGenerations: false, systemPrompt: '写实' });
  assert.deepEqual([nb.safety_tolerance, nb.thinking_level, nb.temperature, nb.limit_generations, nb.system_prompt], ['6', 'high', 0.7, false, '写实']);
  const nb0 = await bodyOf('fal-ai/nano-banana-2', 'image', {});
  assert.equal(['safety_tolerance', 'thinking_level', 'limit_generations', 'include_thoughts', 'enable_image_search'].some((k) => k in nb0), false);
  // 改图：只给视频也能发（openapi：有 video / audio / pdf 时 image_urls 可不给）
  const ed = await bodyOf('fal-ai/nano-banana-2/edit', 'image', { pdfUrl: 'https://x/a.pdf' }, { inputs: [{ role: 'video', data: Buffer.from('v'), mime: 'video/mp4' }] });
  assert.ok(ed.video_url.startsWith('data:video/mp4;base64,'));
  assert.equal(ed.pdf_url, 'https://x/a.pdf');
  // Kling：分镜给了就不发 prompt；镜头类型 / 安全检查等于默认不发
  const k = await bodyOf('fal-ai/kling-video/v3/pro/text-to-video', 'video', { multiPrompt: [{ prompt: 'a', duration: '5' }], shotType: 'intelligent' });
  assert.deepEqual([k.multi_prompt, k.shot_type, 'prompt' in k, 'enable_safety_checker' in k], [[{ prompt: 'a', duration: '5' }], 'intelligent', false, false]);
  assert.equal(FAL['fal-ai/kling-video/v3/pro/image-to-video'].inputs.negativeDefault, 'blur, distort, and low quality');
  assert.ok(FAL['fal-ai/kling-video/v3/pro/image-to-video'].params.some((s) => s.key === 'elements' && s.array));
  assert.ok(/已弃用/.test(FAL['fal-ai/bytedance/seedance/v1.5/pro/text-to-video'].desc));
  // MiniMax 语音：默认请求体不变；整组设置碰了才发
  const s0 = await bodyOf('fal-ai/minimax/speech-2.8-hd', 'speech', {});
  assert.deepEqual(s0.voice_setting, { voice_id: 'Chinese (Mandarin)_Wise_Women', speed: 1, vol: 1, pitch: 0 });
  assert.deepEqual(s0.audio_setting, { format: 'mp3' });
  assert.equal(['voice_modify', 'normalization_setting', 'language_boost', 'pronunciation_dict', 'enable_safety_checker'].some((k2) => k2 in s0), false);
  const s1 = await bodyOf('fal-ai/minimax/speech-2.8-hd', 'speech', { languageBoost: 'Chinese', sampleRate: 44100, channel: 2, bitrate: 256000, englishNormalization: true, modifyTimbre: 20, loudnessNorm: true, targetLoudness: -16, pronunciationDict: { tone_list: ['处理/(chu3)(li3)'] } });
  assert.deepEqual(s1.audio_setting, { format: 'mp3', sample_rate: 44100, bitrate: 256000, channel: 2 });
  assert.equal(s1.voice_setting.english_normalization, true);
  assert.deepEqual([s1.voice_modify, s1.normalization_setting, s1.language_boost], [{ timbre: 20 }, { enabled: true, target_loudness: -16 }, 'Chinese']);
  assert.deepEqual(s1.pronunciation_dict, { tone_list: ['处理/(chu3)(li3)'] });
  // ElevenLabs Turbo / MiniMax Music
  const el = await bodyOf('fal-ai/elevenlabs/tts/turbo-v2.5', 'speech', { previousText: '上一句', timestamps: true });
  assert.deepEqual([el.previous_text, el.timestamps], ['上一句', true]);
  const mu0 = await bodyOf('fal-ai/minimax-music/v2.6', 'music', {});
  assert.deepEqual(mu0.audio_setting, { format: 'mp3' }, '采样率 / 码率等于默认不发');
  const mu1 = await bodyOf('fal-ai/minimax-music/v2.6', 'music', { sampleRate: 32000, bitrate: 128000 });
  assert.deepEqual(mu1.audio_setting, { format: 'mp3', sample_rate: 32000, bitrate: 128000 });
  assert.equal(FAL['fal-ai/lyria2'].inputs.negativeDefault, 'low quality');
});

test('Replicate 内置卡补项：Seedance 2.0 收参考视频 / 音频（各 ≤3）；MiniMax 语音声道 / 字幕 / 语种枚举；Music 2.5 改用 output_format（旧 audio_format 照收）；Gemini TTS 语言枚举', async () => {
  const sd = REP['bytedance/seedance-2.0'];
  assert.deepEqual([sd.inputs.video, sd.inputs.audio], [{ max: 3 }, { max: 3 }]);
  await withFetch(repOk('https://replicate.delivery/x/v.mp4', 'video/mp4'), async (calls) => {
    await replicateAdapter.run({ kind: 'video', model: 'bytedance/seedance-2.0', card: sd, prompt: 'p', negative: '', params: applySpecs(sd.params, {}),
      inputs: [{ role: 'ref', data: PNG, mime: 'image/png' }, { role: 'video', data: Buffer.from('v'), mime: 'video/mp4' }, { role: 'audio', data: Buffer.from('a'), mime: 'audio/mpeg' }], thread: null }, repProvider, repCtx());
    const inp = calls[0].body.input;
    assert.equal(inp.reference_videos.length, 1);
    assert.equal(inp.reference_audios.length, 1);
    assert.equal(inp.reference_images.length, 1);
  });
  const sp = REP['minimax/speech-2.8-hd'];
  const lb = sp.params.find((s) => s.key === 'language_boost');
  assert.deepEqual([lb.type, lb.default, lb.options.some((o) => o.value === 'Chinese,Yue')], ['enum', 'None', true]);
  const sp0 = applySpecs(sp.params, {});
  assert.equal('channel' in sp0 || 'subtitle_enable' in sp0, false, '新参数默认不传');
  assert.deepEqual(applySpecs(sp.params, { channel: 'stereo', subtitle_enable: true, language_boost: 'Japanese' }).channel, 'stereo');
  const mu = REP['minimax/music-2.5'];
  assert.deepEqual(mu.normalize({}), { output_format: 'mp3', bitrate: 256000, sample_rate: 44100 });
  assert.equal(mu.normalize({ audio_format: 'wav' }).output_format, 'wav', '旧预设的 audio_format 搬到 output_format');
  assert.equal('audio_format' in mu.normalize({ audio_format: 'wav' }), false);
  const g = REP['google/gemini-3.1-flash-tts'].params.find((s) => s.key === 'language_code');
  assert.deepEqual([g.type, g.default, g.options.length], ['enum', 'en-US', 87]);
});

// —— 通用卡 ——
test('通用卡：各方言只给适配器认得的键；全部默认不传（规范化后只剩比例 auto）；填了尺寸就不发比例', () => {
  const ks = (d, k) => keys(genericCard(d, k).params);
  assert.deepEqual(ks('openai', 'image'), ['aspectRatio', 'count', 'size', 'quality', 'outputFormat', 'outputCompression', 'background', 'extra']);
  assert.deepEqual(ks('fal', 'image'), ['aspectRatio', 'count', 'size', 'quality', 'outputFormat', 'outputCompression', 'background', 'seed', 'extra']);
  assert.deepEqual(ks('replicate', 'image'), ['aspectRatio', 'count', 'size', 'outputFormat', 'seed', 'extra']);
  assert.deepEqual(ks('ark', 'image'), ['aspectRatio', 'size', 'outputFormat', 'extra']);
  assert.deepEqual(ks('openrouter', 'video'), ['aspectRatio', 'durationSeconds', 'resolution', 'seed', 'extra']);
  assert.deepEqual(ks('openai', 'video'), ['aspectRatio', 'durationSeconds', 'extra']);
  assert.deepEqual(ks('openai', 'speech'), ['voice', 'speed', 'format', 'instructions', 'extra']);
  assert.deepEqual(ks('minimax', 'speech'), ['voice', 'speed', 'format', 'extra']);
  assert.deepEqual(ks('elevenlabs', 'music'), ['durationSeconds', 'seed', 'extra']);
  assert.deepEqual(ks('gemini', 'image'), ['aspectRatio', 'extra'], '没列的方言照旧');
  const mm = genericCard('minimax', 'speech').params.find((s) => s.key === 'speed');
  assert.deepEqual([mm.min, mm.max, mm.default], [0.5, 2, undefined]);
  for (const d of ['openai', 'openrouter', 'fal', 'replicate', 'ark', 'minimax', 'elevenlabs']) {
    for (const k of ['image', 'video', 'speech', 'music']) {
      const out = applySpecs(genericCard(d, k).params, {});
      assert.deepEqual(out, k === 'image' || k === 'video' ? { aspectRatio: 'auto' } : {}, `${d} ${k}`);
    }
  }
  assert.equal(genericCard('fal', 'video').inputs.negative, true);
  assert.equal(genericCard('openai', 'image').inputs.negative, undefined, '不发负面词的方言不开');
  const img = genericCard('openai', 'image');
  assert.deepEqual(applySpecs(img.params, { aspectRatio: '16:9', size: { width: 1600, height: 900 } }), { size: { width: 1600, height: 900 } });
  assert.deepEqual(applySpecs(img.params, { aspectRatio: '16:9', outputFormat: 'png', outputCompression: 50 }), { aspectRatio: '16:9', outputFormat: 'png' }, '压缩只对 jpeg / webp');
});

test('通用卡执行：fal 的新键按惯用字段名发（张数 → num_images、尺寸 → image_size 对象），其余 snake_case 透传；Replicate 张数 → num_outputs、尺寸拆 width / height', async () => {
  const fc = genericCard('fal', 'image');
  await withFetch(falOk({ images: [{ url: 'https://v3b.fal.media/a.png' }] }, 'image/png'), async (calls) => {
    const params = applySpecs(fc.params, { count: 2, size: '1280x720', outputFormat: 'webp', outputCompression: 80, quality: 'high', background: 'transparent', seed: 5 });
    await falAdapter.run({ kind: 'image', model: 'acme/new-image', card: fc, prompt: 'p', negative: 'blur', params, inputs: [], thread: null }, falProvider, falCtx());
    const b = calls[0].body;
    assert.deepEqual([b.num_images, b.image_size, b.output_format, b.output_compression, b.quality, b.background, b.seed, b.negative_prompt], [2, { width: 1280, height: 720 }, 'webp', 80, 'high', 'transparent', 5, 'blur']);
    assert.equal('aspect_ratio' in b, false);
  });
  const rc = genericCard('replicate', 'image');
  await withFetch(repOk('https://replicate.delivery/x/o.png', 'image/png'), async (calls) => {
    const params = applySpecs(rc.params, { count: 3, size: { width: 1024, height: 768 }, outputFormat: 'png', seed: 1 });
    await replicateAdapter.run({ kind: 'image', model: 'acme/new-image', card: rc, prompt: 'p', negative: 'blur', params, inputs: [], thread: null }, repProvider, repCtx());
    const inp = calls[0].body.input;
    assert.deepEqual([inp.num_outputs, inp.width, inp.height, inp.output_format, inp.seed, inp.negative_prompt], [3, 1024, 768, 'png', 1, 'blur']);
    assert.equal('count' in inp || 'size' in inp || 'outputFormat' in inp, false);
  });
});
