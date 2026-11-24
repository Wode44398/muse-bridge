// Media Studio 自动识别（方案 §9.3）：各方言发现的解析、schema → ParamSpec、同族继承 + 参照库精修、巡检合并规则、目录增量、
// openrouter 通用图像 / 视频执行。全部喂 fixtures/ 里的真实样例（2026-11-06 只读接口拉的），不连网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-disc-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
process.env.BRIDGE_VERTEX_RELAY = '';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
process.env.BRIDGE_STUDIO_AUTOSYNC = '0';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18996, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users') }, null, 2));

await (await import('@bridge/core/modules/registry.mjs')).loadModules();
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (f) => JSON.parse(readFileSync(path.join(FX, f), 'utf8'));
const P = await import('../providers.mjs');
const { cardFor } = await import('../cards/index.mjs');
const { googleCard, googleCandidates } = await import('../cards/google.mjs');
const { applySpecs } = await import('../cards/spec.mjs');
const catalogMod = await import('../catalog.mjs');
const store = await import('./store.mjs');
const schema = await import('./schema.mjs');
const family = await import('./family.mjs');
const sources = await import('./sources.mjs');
const disc = await import('./index.mjs');
const { openrouterAdapter, videoBody } = await import('../adapters/openrouter.mjs');

const OR_IMAGES = fx('openrouter-images-models.json').data;
const OR_VIDEOS = fx('openrouter-videos-models.json').data;
const orImage = (id) => OR_IMAGES.find((m) => m.id === id);
const orVideo = (id) => OR_VIDEOS.find((m) => m.id === id);
const keys = (params) => params.map((s) => s.key);
const spec = (params, k) => params.find((s) => s.key === k);
const values = (s) => s.options.map((o) => o.value);

// —— 解析：OpenRouter / Gemini / Vertex ——
test('OpenRouter 目录：图像 63 + 视频 33，名字去掉厂商前缀、厂商单列；视频价目算成每秒价', () => {
  const r = sources.parseOpenRouter(OR_IMAGES, OR_VIDEOS);
  assert.equal(r.models.filter((m) => m.kind === 'image').length, 63);
  assert.equal(r.models.filter((m) => m.kind === 'video').length, 33);
  const gpt = r.models.find((m) => m.id === 'openai/gpt-image-2.6-sunburst');
  assert.deepEqual([gpt.label, gpt.vendor], ['GPT Image 2.6 Sunburst', 'openai']);
  assert.equal(r.schemas['google/gemini-omni-1.2-flash'].src, 'openrouter-video');
  assert.equal(r.schemas['google/gemini-omni-1.2-flash'].priceHint, '$0.023–0.21 / 秒');
  assert.equal(r.schemas['tbc/mischief-1'].priceHint, '$0.005–0.01 / 秒');
  assert.equal(r.schemas['bytedance/seedance-2.0'].priceHint, undefined, '按 token 计价的不给');
  assert.equal(r.schemas['qwen/qwen-image-2.1-turbo'].data.description, undefined, '只存参数相关的字段');
});

test('Gemini models.list：只收图像 / 视频 / 配音 / 音乐；preview 有正式版的、实时 / 原生音频 / 转写、旧 Omni preview 都不收', () => {
  const got = sources.parseGeminiModels(fx('gemini-models.json').models);
  const by = (k) => got.filter((m) => m.kind === k).map((m) => m.id).sort();
  assert.deepEqual(by('image'), ['gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1']);
  assert.deepEqual(by('video'), ['gemini-omni-1.1-flash', 'gemini-omni-1.2-flash']);
  assert.deepEqual(by('speech'), ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']);
  assert.deepEqual(by('music'), ['lyria-3-clip-preview', 'lyria-3-pro-preview', 'lyria-3.5']);
  assert.equal(got.find((m) => m.id === 'gemini-omni-1.2-flash').label, 'Gemini Omni 1.2 Flash');
});

test('Vertex 目录：只收能零成本探活的 Nano Banana / TTS / Veo；Omni、Lyria、Imagen、实时不收', () => {
  const got = sources.parseVertexModels(fx('vertex-publisher-models.json').publisherModels);
  const ids = got.map((m) => m.id).sort();
  assert.ok(ids.includes('gemini-3.8-flash-tts') && ids.includes('gemini-3.8-flash-lite-tts'));
  assert.ok(ids.includes('veo-3.1-lite-generate-001'));
  assert.ok(!ids.some((id) => /omni|lyria|imagen|live|chirp|automl|segmentation/.test(id)), ids.join(','));
  assert.equal(ids.length, 13, ids.join(','));
  assert.ok(!ids.includes('gemini-3.1-flash-image-preview'), '有正式版的 preview 不收');
  assert.equal(sources.probeVerdict(400), true);
  assert.equal(sources.probeVerdict(429), true);
  assert.equal(sources.probeVerdict(404), false);
  assert.equal(sources.probeVerdict(503), null);
});

// —— schema → ParamSpec ——
test('OpenRouter 图像描述 → 参数：键即请求字段、比例 / 分辨率 / 张数进基本、参考图上限进 inputs', () => {
  const b = schema.fromOpenRouterImage(orImage('qwen/qwen-image-2.1-turbo'));
  assert.deepEqual(keys(b.params), ['aspect_ratio', 'resolution', 'n', 'seed', 'extra']);
  const asp = spec(b.params, 'aspect_ratio');
  assert.deepEqual([asp.format, asp.group, asp.default, asp.options[0].value], ['aspect', 'basic', '', '']);
  assert.deepEqual([spec(b.params, 'n').min, spec(b.params, 'n').max, spec(b.params, 'n').format, spec(b.params, 'n').group], [1, 6, 'count', 'basic']);
  assert.equal(spec(b.params, 'seed').group, 'advanced');
  assert.deepEqual(b.inputs.images, { max: 4, roles: ['edit', 'ref'] });
  // GPT Image 2.6：有 auto 就默认 auto；画质、背景、格式、压缩率（%）都在
  const g = schema.fromOpenRouterImage(orImage('openai/gpt-image-2.6-flare'));
  // 2026-11-15：格式排到背景前（透明选项按格式收窄）；目录里有 gif → 补帧数 / 每帧时长
  assert.deepEqual(keys(g.params), ['aspect_ratio', 'quality', 'n', 'output_format', 'output_compression', 'frame_count', 'frame_duration_ms', 'background', 'extra']);
  assert.equal(spec(g.params, 'aspect_ratio').default, 'auto');
  assert.equal(spec(g.params, 'output_compression').unit, '%');
  assert.equal(spec(g.params, 'quality').options.find((o) => o.value === 'xhigh').label, '超高');
  // size 是「可填像素」：给一个文本参数；只出一张的不给张数；只吃文字的没有参考图
  const rf = schema.fromOpenRouterImage(orImage('sourceful/riverflow-v2.6-pro'));
  assert.equal(spec(rf.params, 'size').format, 'size');
  assert.equal(spec(rf.params, 'n'), undefined);
  assert.equal(schema.fromOpenRouterImage(orImage('recraft/recraft-v4.1-flash')).inputs.images, undefined);
  assert.deepEqual(keys(schema.fromOpenRouterImage(orImage('meta/muse-image')).params), ['extra']);
});

test('OpenRouter 视频描述 → 参数：Omni 1.2 时长 3–15、音轨恒开不给开关、首尾帧；可灌视频的放大模型收 inputs.video', () => {
  const o = schema.fromOpenRouterVideo(orVideo('google/gemini-omni-1.2-flash'));
  assert.deepEqual(values(spec(o.params, 'duration')), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(spec(o.params, 'duration').format, 'duration');
  assert.deepEqual(values(spec(o.params, 'resolution')), ['360p', '720p', '1080p', '4K']);
  assert.equal(spec(o.params, 'resolution').default, '720p');
  assert.equal(spec(o.params, 'generate_audio'), undefined, '价目只有带音频的档 = 恒开');
  assert.deepEqual(o.inputs.images, { max: 1, roles: ['first', 'last'] });
  assert.ok(spec(o.params, 'extra').desc.includes('provider.options.<服务商>.task'));
  const k = schema.fromOpenRouterVideo(orVideo('kwaivgi/kling-v3.0-pro'));
  assert.equal(spec(k.params, 'generate_audio').type, 'bool');
  const up = schema.fromOpenRouterVideo(orVideo('black-forest-labs/flux-video-upscale'));
  assert.deepEqual(up.inputs.video, { max: 1 });
  assert.deepEqual([spec(up.params, 'upscale_factor').min, spec(up.params, 'upscale_factor').max], [1.5, 3]);
  // 基本组最多 4 个
  for (const m of OR_VIDEOS) assert.ok(schema.fromOpenRouterVideo(m).params.filter((s) => s.group === 'basic').length <= 4, m.id);
});

test('fal JSON Schema → 参数：预设枚举（anyOf 里的 enum）、步数 / 引导强度带上下限、内部开关不进参数', () => {
  const s = sources.falSchemaOf(fx('fal-flux-dev.json').models[0]);
  const b = schema.fromJsonSchema('image', s.input, s.defs);
  assert.equal(b.wire.text, 'prompt');
  const size = spec(b.params, 'image_size');
  // 「预设名 | { width, height }」联合类型 → 尺寸参数：预设照列，对象分支 = 自定义宽高（ImageSize：1–14142，原样发对象）
  assert.deepEqual([size.label, size.type, size.format, size.group, size.default, size.encode], ['尺寸', 'size', 'size', 'basic', 'landscape_4_3', 'object']);
  assert.deepEqual(size.custom, { width: { min: 1, max: 14142 }, height: { min: 1, max: 14142 }, exact: true });
  assert.equal(size.options.find((o) => o.value === 'square_hd').label, '方形 · 高清');
  const steps = spec(b.params, 'num_inference_steps');
  assert.deepEqual([steps.label, steps.min, steps.max, steps.integer, steps.step, steps.default], ['采样步数', 1, 50, true, 1, 28]);
  assert.deepEqual([spec(b.params, 'guidance_scale').label, spec(b.params, 'guidance_scale').max], ['引导强度', 20]);
  assert.equal(spec(b.params, 'sync_mode'), undefined);
  assert.equal(spec(b.params, 'seed').type, 'seed');
  assert.ok(spec(b.params, 'num_images').group === 'basic');
  assert.ok(b.params.filter((x) => x.group === 'basic').length <= 4);
  assert.equal(b.params[b.params.length - 1].key, 'extra');
});

test('fal 视频 schema：首尾帧 → inputs 角色、负面提示词 → inputs.negative、时长字符串枚举带「秒」；参考视频 / 音频进 inputs.video / audio', () => {
  const k = sources.falSchemaOf(fx('fal-kling-v3-pro-i2v.json').models[0]);
  const kb = schema.fromJsonSchema('video', k.input, k.defs);
  assert.deepEqual(kb.inputs.images.roles.sort(), ['first', 'last']);
  assert.deepEqual([kb.wire.images.first.field, kb.wire.images.last.field], ['start_image_url', 'end_image_url']);
  assert.equal(kb.inputs.negative, true);
  assert.equal(kb.wire.negative, 'negative_prompt');
  const dur = spec(kb.params, 'duration');
  assert.deepEqual([dur.format, dur.default, dur.options.find((o) => o.value === '12').label], ['duration', '5', '12 秒']);
  // 2026-11-15：对象数组（elements / multi_prompt）不再丢进「原始参数」说明，做成 json 数组参数（见下面「参数补全」的测试）
  assert.deepEqual([spec(kb.params, 'elements').type, spec(kb.params, 'elements').array], ['json', true]);
  const sd = sources.falSchemaOf(fx('fal-seedance-2.5-reference.json').models[0]);
  const sb = schema.fromJsonSchema('video', sd.input, sd.defs);
  assert.deepEqual(sb.inputs.video, { max: 10 });
  assert.deepEqual(sb.inputs.audio, { max: 10 });
  assert.deepEqual([sb.wire.video.field, sb.wire.audio.field], ['video_urls', 'audio_urls']);
  assert.ok(sb.inputs.images.roles.includes('ref'));
  // 请求体：素材塞回原字段（列表的 push）
  const body = schema.wireBody(sb.wire, { duration: '5', resolution: '720p', extra: { x: 1 } }, {
    kind: 'video', prompt: 'p', inputs: [{ role: 'video', data: Buffer.from('v'), mime: 'video/mp4' }, { role: 'audio', data: Buffer.from('a'), mime: 'audio/mpeg' }, { role: 'ref', data: Buffer.from('i'), mime: 'image/png' }],
  }, (x) => 'u:' + x.mime);
  assert.deepEqual(body.video_urls, ['u:video/mp4']);
  assert.deepEqual(body.audio_urls, ['u:audio/mpeg']);
  assert.deepEqual([body.prompt, body.duration, body.extra], ['p', '5', undefined]);
});

test('fal 配音 schema：正文字段 text、音色用示例当候选（默认 Rachel）、稳定性 0–1', () => {
  const t = sources.falSchemaOf(fx('fal-elevenlabs-tts-v4.json').models[0]);
  const b = schema.fromJsonSchema('speech', t.input, t.defs);
  assert.equal(b.wire.text, 'text');
  const v = spec(b.params, 'voice');
  assert.deepEqual([v.type, v.default, v.group, v.options[0].value], ['voice', 'Rachel', 'basic', 'Rachel']);
  assert.ok(v.options.length > 10);
  assert.deepEqual([spec(b.params, 'stability').label, spec(b.params, 'stability').min, spec(b.params, 'stability').max], ['稳定性', 0, 1]);
});

test('Replicate openapi_schema（x-order 排序、$ref 枚举）→ 参数', () => {
  const j = { latest_version: { id: 'v1', openapi_schema: { components: { schemas: {
    Input: { type: 'object', required: ['prompt'], properties: {
      prompt: { type: 'string', 'x-order': 0 },
      aspect_ratio: { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }], default: '1:1', 'x-order': 1 },
      num_outputs: { type: 'integer', minimum: 1, maximum: 4, default: 1, 'x-order': 2 },
      go_fast: { type: 'boolean', default: true, 'x-order': 4 },
      megapixels: { allOf: [{ $ref: '#/components/schemas/megapixels' }], default: '1', 'x-order': 3 },
      start_image: { type: 'string', format: 'uri', 'x-order': 5 },
    } },
    aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'] },
    megapixels: { type: 'string', enum: ['1', '0.25'] },
    Output: { type: 'array', items: { type: 'string', format: 'uri' } },
  } } } } };
  const s = sources.replicateSchemaOf(j);
  assert.equal(s.version, 'v1');
  assert.deepEqual(Object.keys(s.defs).sort(), ['aspect_ratio', 'megapixels'], '只带被 Input 引用的定义');
  const b = schema.fromJsonSchema('video', s.input, s.defs);
  assert.deepEqual(keys(b.params), ['aspect_ratio', 'num_outputs', 'megapixels', 'go_fast', 'extra']);
  assert.deepEqual(values(spec(b.params, 'aspect_ratio')), ['1:1', '16:9', '9:16']);
  assert.equal(b.wire.images.first.field, 'start_image');
});

// —— 同族继承 + 参照库精修 ——
test('同族继承：按去掉版本号的族名找最近的内置卡', () => {
  assert.deepEqual(family.familyTokens('gemini-3.8-flash-lite-tts'), ['gemini', 'flash', 'lite', 'tts']);
  assert.equal(family.versionOf('lyria-002'), 2);
  assert.equal(family.versionOf('veo-3.1-fast-generate-001'), 3.1);
  const pick = (id, kind, dialect) => family.pickParent(id, googleCandidates(kind), { dialect })?.id;
  // 方案 §11：Omni 1.2、3.8 Flash TTS / Lite TTS 已经是内置卡；继承留给它们之后才出来的型号
  assert.equal(pick('gemini-omni-1.3-flash', 'video', 'gemini'), 'gemini-omni-1.2-flash');
  assert.equal(pick('gemini-4.0-flash-tts', 'speech', 'gemini'), 'gemini-3.8-flash-tts');
  assert.equal(pick('gemini-4.0-flash-lite-tts', 'speech', 'vertex'), 'gemini-3.8-flash-lite-tts');
  assert.equal(pick('gemini-2.5-flash-preview-tts', 'speech', 'gemini'), 'gemini-2.5-flash-tts');
  assert.equal(pick('veo-3.2-fast-generate-001', 'video', 'vertex'), 'veo-3.1-fast-generate-001');
  assert.equal(pick('lyria-4', 'music', 'gemini'), 'lyria-3.5');
  assert.equal(pick('imagen-5.0-generate', 'image', 'vertex'), undefined, '族根对不上不硬套');
  // 同版本的变体优先，但只限段集合是超集的：3-flash 不能因为同版本去跟 3-pro
  assert.equal(pick('gemini-3-flash-image', 'image', 'vertex'), 'gemini-3.1-flash-image');
  assert.equal(pick('gemini-2.5-flash-lite', 'image', 'vertex'), 'gemini-3.1-flash-lite-image');
});

test('同族继承：裸 gpt-image-2.6 / 2.5（含日期快照）跟同版本的 sunburst 卡（2.6 有 svg / gif、xhigh / max、构图规划），不再落到 gpt-image-2', () => {
  const oa = P.createProvider({ dialect: 'openai', baseUrl: 'https://api.openai.com/v1', models: [] }, 'admin');
  const orp = P.createProvider({ dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', models: [] }, 'admin');
  try {
    const card = (p, id) => cardFor(P.getProvider(p.id, 'admin'), { id, kind: 'image', enabled: true, source: 'remote' });
    for (const id of ['gpt-image-2.6', 'gpt-image-2.6-2026-12-01']) {
      const c = card(oa, id);
      assert.deepEqual([c.paramSource, c.inheritsFrom], ['family', 'gpt-image-2.6-sunburst'], id);
      assert.deepEqual(values(spec(c.params, 'outputFormat')), ['png', 'jpeg', 'webp', 'gif', 'svg']);
      assert.ok(['xhigh', 'max'].every((q) => values(spec(c.params, 'quality')).includes(q)));
      assert.ok(spec(c.params, 'complexity'));
      assert.equal(c.normalize({ size: 'auto', outputFormat: 'svg' }).outputFormat, 'svg');
    }
    assert.equal(card(oa, 'gpt-image-2.5').inheritsFrom, 'gpt-image-2.5-sunburst');
    assert.equal(card(orp, 'openai/gpt-image-2.6').inheritsFrom, 'openai/gpt-image-2.6-sunburst');
    assert.equal(card(oa, 'gpt-image-3').inheritsFrom, 'gpt-image-2', '别的版本照旧按相似度');
  } finally { P.deleteProvider(oa.id, 'admin'); P.deleteProvider(orp.id, 'admin'); }
});

const gem = P.createProvider({ preset: 'gemini', dialect: 'gemini', name: 'Gemini API', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-test-not-real',
  models: [{ id: 'gemini-omni-1.1-flash', kind: 'video', source: 'builtin' }, { id: 'gemini-nano-banana-2.1', kind: 'image', source: 'builtin' }] }, 'admin');
const gp = () => P.getProvider(gem.id, 'admin');

test('Omni 1.2 是内置卡（时长 3–15、首尾帧 + 6 张参考图）；它之后的型号继承它 + 参照库精修，没参照库时就是 1.2 的取值域', () => {
  // 方案 §11：1.2 进了内置卡（2026-11-06 时还靠继承 1.1 + 精修）
  const c12 = cardFor(gp(), { id: 'gemini-omni-1.2-flash', label: 'Gemini Omni 1.2 Flash', kind: 'video', enabled: true, source: 'remote' });
  assert.deepEqual([c12.paramSource, c12.inheritsFrom, c12.refinedBy], [undefined, undefined, undefined]);
  assert.deepEqual(values(spec(c12.params, 'durationSeconds')), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(c12.inputs.images, { max: 6, roles: ['first', 'last', 'ref'] });
  assert.deepEqual(c12.normalize({ durationSeconds: 12, resolution: '360p' }), { aspectRatio: 'auto', resolution: '360p', durationSeconds: 12, generateAudio: false });
  assert.equal(c12.normalize({ durationSeconds: 40 }).durationSeconds, 15);
  assert.equal(c12.normalize({ durationSeconds: 1 }).durationSeconds, 3);
  assert.equal(c12.normalize({ durationSeconds: 14 }, { $last: true }).durationSeconds, 10, '首尾帧插值最长 10 秒');
  // 继承 + 精修：拿一个还不存在的 1.3 来测（参照库里给它一份放宽到 20 秒的取值域）
  const entry = { id: 'gemini-omni-1.3-flash', label: 'Gemini Omni 1.3 Flash', kind: 'video', enabled: true, source: 'remote' };
  store.setReference({ images: [], videos: [] }, { persist: false });
  const plain = cardFor(gp(), entry);
  assert.deepEqual([plain.paramSource, plain.inheritsFrom, plain.refinedBy], ['family', 'gemini-omni-1.2-flash', undefined]);
  assert.deepEqual(values(spec(plain.params, 'durationSeconds')), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const ref12 = OR_VIDEOS.find((m) => m.id === 'google/gemini-omni-1.2-flash');
  store.setReference({ images: OR_IMAGES, videos: [...OR_VIDEOS, { ...ref12, id: 'google/gemini-omni-1.3-flash', supported_durations: Array.from({ length: 18 }, (_, i) => i + 3) }] }, { persist: false });
  const c = cardFor(gp(), entry);
  assert.deepEqual([c.paramSource, c.inheritsFrom, c.refinedBy, c.label, c.desc], ['family', 'gemini-omni-1.2-flash', 'openrouter', 'Gemini Omni 1.3 Flash', undefined]);
  assert.deepEqual(values(spec(c.params, 'durationSeconds')), Array.from({ length: 18 }, (_, i) => i + 3));
  assert.deepEqual(values(spec(c.params, 'resolution')), ['360p', '720p', '1080p', '4k'], '沿用卡上的写法（4k）');
  assert.deepEqual(values(spec(c.params, 'aspectRatio')), ['auto', '16:9', '9:16']);
  assert.deepEqual(c.normalize({ durationSeconds: 18, resolution: '360p' }), { aspectRatio: 'auto', resolution: '360p', durationSeconds: 18, generateAudio: false });
  assert.equal(c.normalize({ durationSeconds: 40 }).durationSeconds, 20);
  assert.equal(c.normalize({ durationSeconds: 1 }).durationSeconds, 3);
  store.setReference({ images: OR_IMAGES, videos: OR_VIDEOS }, { persist: false });
  // 父卡一字不变
  assert.deepEqual(values(spec(c12.params, 'durationSeconds')), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const o11 = googleCard('gemini', 'gemini-omni-1.1-flash');
  assert.deepEqual(values(spec(o11.params, 'durationSeconds')), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(o11.normalize({ durationSeconds: 12 }).durationSeconds, 10);
  assert.equal(cardFor(gp(), { id: 'gemini-omni-1.1-flash', kind: 'video' }), o11, '内置卡照旧是同一张');
});

test('gemini 方言认 Vertex 清单里的 Nano Banana / TTS（内置卡，不带人物生成）；3.8 Flash TTS 是内置卡，再往后的走继承', () => {
  const pro = cardFor(gp(), { id: 'gemini-3-pro-image', kind: 'image' });
  assert.equal(catalogMod.resolvedModel(gp(), { id: 'gemini-3-pro-image', kind: 'image' }).paramSource, 'card');
  assert.equal(spec(pro.params, 'personGeneration'), undefined);
  assert.ok(spec(cardFor({ dialect: 'vertex', id: 'p-ffffff01', models: [] }, { id: 'gemini-3-pro-image', kind: 'image' }).params, 'personGeneration'), 'vertex 方言照旧有');
  const t38 = cardFor(gp(), { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS', kind: 'speech' });
  assert.deepEqual([t38.paramSource, t38.inheritsFrom], [undefined, undefined]);
  assert.deepEqual(t38.normalize({ voice: 'Puck' }), { voice: 'Puck', style: '' });
  const tts = cardFor(gp(), { id: 'gemini-4.0-flash-tts', label: 'Gemini 4.0 Flash TTS', kind: 'speech' });
  assert.deepEqual([tts.paramSource, tts.inheritsFrom], ['family', 'gemini-3.8-flash-tts']);
  assert.equal(spec(tts.params, 'voice').options.length, 30);
  assert.deepEqual(tts.normalize({ voice: 'Puck' }), { voice: 'Puck', style: '' });
});

// —— 巡检合并 ——
const fakeOR = (images, videos) => ({ openrouter: async () => ({ ...sources.parseOpenRouter(images, videos), schemasReplace: true, complete: true }) });
const noFetch = { fetchSchema: async () => null, fetchEndpoints: async () => null };

test('聚合服务：第一次巡检建底（全进备选）、之后新出现的进主列表带「新」、下架标 gone、内置 / 手填 / 关掉的不动、删掉的不加回', async () => {
  const or = P.createProvider({ preset: 'openrouter', dialect: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test',
    models: [{ id: 'openai/gpt-image-2.6-sunburst', kind: 'image', source: 'builtin' }, { id: 'acme/manual-1', kind: 'image', source: 'manual' }] }, 'admin');
  const base = OR_IMAGES.filter((m) => m.id !== 'krea/k3-edit');
  let st = await disc.syncProvider('admin', or.id, { sources: fakeOR(base, OR_VIDEOS), ...noFetch });
  assert.equal(st.ok, true);
  assert.ok(st.baselineAt);
  assert.deepEqual(st.added, [], '建底不算新增');
  let p = P.getProvider(or.id, 'admin');
  assert.equal(p.models.length, 2 + base.length + OR_VIDEOS.length - 1, 'GPT 2.6 是内置的，不重复加');
  const qwen = p.models.find((m) => m.id === 'qwen/qwen-image-2.1-turbo');
  assert.deepEqual([qwen.source, qwen.enabled, qwen.shelf, qwen.vendor, typeof qwen.discoveredAt], ['remote', true, true, 'qwen', 'number']);
  assert.equal(p.models.find((m) => m.id === 'openai/gpt-image-2.6-sunburst').source, 'builtin');
  // 管理员关掉一个备选、删掉一个备选（设置页回传的条目不带发现元数据 → 服务端按 id 补回）
  const ui = p.models.filter((m) => m.id !== 'recraft/recraft-v3').map((m) => ({ id: m.id, label: m.label, kind: m.kind, enabled: m.id === 'qwen/qwen-image-2.1-pro' ? false : m.enabled, source: m.source, defaults: {} }));
  P.updateProvider(or.id, { models: ui }, 'admin');
  p = P.getProvider(or.id, 'admin');
  assert.equal(p.models.find((m) => m.id === 'qwen/qwen-image-2.1-turbo').shelf, true, '回传没带 shelf 也保留');
  // 第二次：多了 krea/k3-edit，少了 meta/muse-image
  st = await disc.syncProvider('admin', or.id, { sources: fakeOR(OR_IMAGES.filter((m) => m.id !== 'meta/muse-image'), OR_VIDEOS), ...noFetch });
  assert.deepEqual(st.added, ['krea/k3-edit']);
  assert.deepEqual(st.gone, ['meta/muse-image']);
  p = P.getProvider(or.id, 'admin');
  const k3 = p.models.find((m) => m.id === 'krea/k3-edit');
  assert.deepEqual([k3.enabled, k3.shelf], [true, undefined]);
  assert.equal(p.models.find((m) => m.id === 'meta/muse-image').gone, true);
  assert.equal(p.models.find((m) => m.id === 'qwen/qwen-image-2.1-pro').enabled, false, '关掉的保持关');
  assert.equal(p.models.some((m) => m.id === 'recraft/recraft-v3'), false, '删掉的不加回');
  assert.ok(p.models.find((m) => m.id === 'acme/manual-1') && !p.models.find((m) => m.id === 'acme/manual-1').gone, '手填的永远不动');
  // 目录：新的在主列表带 isNew + schema 参数；备选只给轻条目；下架的隐藏；内置的照旧
  const cat = catalogMod.catalog('admin');
  const g = cat.kinds.image.groups.find((x) => x.provider.id === or.id);
  const k3m = g.models.find((m) => m.id === 'krea/k3-edit');
  assert.deepEqual([k3m.isNew, k3m.paramSource, k3m.vendor, k3m.label], [true, 'schema', 'krea', 'K3 Edit']);
  assert.deepEqual(keys(k3m.params), ['aspect_ratio', 'resolution', 'seed', 'extra']);
  assert.deepEqual(g.shelf.find((m) => m.id === 'qwen/qwen-image-2.1-turbo'), { key: `${or.id}/qwen/qwen-image-2.1-turbo`, id: 'qwen/qwen-image-2.1-turbo', label: 'Qwen Image 2.1 Turbo', vendor: 'qwen', kind: 'image', shelf: true });
  assert.ok(!g.models.some((m) => m.id === 'meta/muse-image') && !g.shelf.some((m) => m.id === 'meta/muse-image'));
  const gpt = g.models.find((m) => m.id === 'openai/gpt-image-2.6-sunburst');
  assert.deepEqual([gpt.paramSource, gpt.vendor, gpt.isNew], ['card', 'openai', undefined]);
  // 自由尺寸（方案 §10）：一个 size（自动 / 原图 / 预设 / 自定义宽高），不再有比例
  // 2026-11-15 参数补全：张数 / 格式（目录里 2.6 有 gif → 帧数与每帧时长）/ 压缩 / 背景 / 审核 / 构图规划
  assert.deepEqual(gpt.params.map((s) => [s.key, s.type, s.default]), [['size', 'size', 'auto'], ['quality', 'enum', 'high'], ['count', 'number', 1], ['outputFormat', 'enum', 'png'],
    ['outputCompression', 'number', 100], ['frameCount', 'number', 9], ['frameDurationMs', 'number', 200], ['background', 'enum', 'auto'], ['moderation', 'enum', 'auto'], ['complexity', 'enum', ''], ['extra', 'json', undefined]]);
  assert.deepEqual(gpt.params.slice(0, 3).map((s) => s.format), ['size', undefined, 'count'], '内置卡只补渲染提示');
  assert.equal(gpt.params[0].editDefault, 'original');
  const vg = cat.kinds.video.groups.find((x) => x.provider.id === or.id);
  assert.equal(vg.models.length, 0);
  assert.equal(vg.shelf.length, OR_VIDEOS.length);
  assert.ok(Buffer.byteLength(JSON.stringify(cat)) < 200 * 1024, '目录 < 200KB');
  // 本人用过就不算新；备选的完整条目
  store.markUsed('admin', `${or.id}/krea/k3-edit`);
  assert.equal(catalogMod.catalog('admin').kinds.image.groups.find((x) => x.provider.id === or.id).models.find((m) => m.id === 'krea/k3-edit').isNew, undefined);
  const full = catalogMod.resolvedModel(p, p.models.find((m) => m.id === 'google/gemini-omni-1.2-flash'), 'admin');
  assert.deepEqual([full.shelf, full.paramSource, full.priceHint, full.vendor, full.async], [true, 'schema', '$0.023–0.21 / 秒', 'google', true]);
  // 视图：sync 状态 + autoSync
  const view = P.listProviders('admin').find((x) => x.id === or.id);
  assert.deepEqual([view.autoSync, view.sync.ok, view.sync.added], [true, true, ['krea/k3-edit']]);
});

test('直连服务：发现的媒体模型直接启用（不进备选）；上游报错只记状态、模型不动', async () => {
  const st = await disc.syncProvider('admin', gem.id, { sources: { gemini: async () => ({ models: sources.parseGeminiModels(fx('gemini-models.json').models), complete: true }) }, ...noFetch });
  assert.equal(st.ok, true);
  const p = gp();
  const o12 = p.models.find((m) => m.id === 'gemini-omni-1.2-flash');
  assert.deepEqual([o12.enabled, o12.shelf, o12.source], [true, undefined, 'remote']);
  assert.ok(st.added.includes('gemini-3.8-flash-tts'));
  assert.equal(p.models.find((m) => m.id === 'gemini-omni-1.1-flash').source, 'builtin');
  const cat = catalogMod.catalog('admin');
  const m = cat.kinds.video.groups.find((x) => x.provider.id === gem.id).models.find((x) => x.id === 'gemini-omni-1.2-flash');
  assert.deepEqual([m.paramSource, m.inheritsFrom, m.refinedBy, m.isNew], ['card', undefined, undefined, true]);   // 1.2 / 3.8 TTS 已是内置卡（方案 §11）
  const sp = cat.kinds.speech.groups.find((x) => x.provider.id === gem.id);
  assert.ok(sp.models.some((x) => x.id === 'gemini-3.8-flash-tts' && x.paramSource === 'card'));
  const before = JSON.stringify(gp().models);
  const bad = await disc.syncProvider('admin', gem.id, { sources: { gemini: async () => { throw new Error('Gemini API 401：API Key 无效'); } }, ...noFetch });
  assert.deepEqual([bad.ok, bad.error], [false, 'Gemini API 401：API Key 无效']);
  assert.equal(JSON.stringify(gp().models), before);
});

test('同服务巡检去重；拉目录时只补过期的、只补自己的', async () => {
  let calls = 0;
  const slow = { gemini: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { models: [], complete: false }; } };
  const a = disc.syncProvider('admin', gem.id, { sources: slow, ...noFetch });
  const b = disc.syncProvider('admin', gem.id, { sources: slow, ...noFetch });
  assert.equal(a, b);
  await a;
  assert.equal(calls, 1);
  store.setSyncState('admin', gem.id, { ...store.getSyncState('admin', gem.id), at: Date.now() });
  disc.maybeSyncStale('admin');
  assert.equal(disc._syncInflightForTests().has('admin|' + gem.id), false, '6 小时内巡检过的不补');
});

test('成员拉目录不会替管理员共享的服务补巡检；Vertex 的 id 整理成可读名', () => {
  P.updateProvider(gem.id, { shared: true }, 'admin');
  store.setSyncState('admin', gem.id, { ...store.getSyncState('admin', gem.id), at: 1 });
  disc.maybeSyncStale('u:alice');
  assert.equal(disc._syncInflightForTests().size, 0);
  assert.equal(sources.prettyGoogleId('gemini-3.8-flash-lite-tts'), 'Gemini 3.8 Flash Lite TTS');
  assert.equal(sources.prettyGoogleId('veo-3.2-fast-generate-001'), 'Veo 3.2 Fast');
  const r = disc.mergeDiscovered({ dialect: 'vertex', models: [{ id: 'gemini-3.8-flash-tts', label: 'gemini-3.8-flash-tts', kind: 'speech', source: 'remote', enabled: true }, { id: 'x-tts', label: '我改的名', kind: 'speech', source: 'remote', enabled: true }] },
    { models: [{ id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS', kind: 'speech' }, { id: 'x-tts', label: 'X TTS', kind: 'speech' }] });
  assert.deepEqual(r.models.map((m) => m.label), ['Gemini 3.8 Flash TTS', '我改的名']);
});

test('合并规则（纯函数）：manual / builtin 不动、gone 再出现就恢复、种类不对的丢掉', () => {
  const p = { dialect: 'gemini', models: [
    { id: 'a', kind: 'image', source: 'remote', enabled: true, gone: true },
    { id: 'b', kind: 'image', source: 'manual', enabled: true },
  ] };
  const r = disc.mergeDiscovered(p, { models: [{ id: 'a', kind: 'image' }, { id: 'b', kind: 'image', label: 'X' }, { id: 'c', kind: 'chat' }], complete: true }, {}, { now: 1 });
  assert.equal(r.models.find((m) => m.id === 'a').gone, undefined);
  assert.equal(r.models.find((m) => m.id === 'b').label, undefined);
  assert.equal(r.models.some((m) => m.id === 'c'), false);
  assert.deepEqual(r.added, []);
});

// —— 执行：openrouter 通用图像 / 视频 ——
test('openrouter 通用图像：参数原样透传、参考图进 input_references、多张都收', async () => {
  const card = { wire: schema.fromOpenRouterImage(orImage('qwen/qwen-image-2.1-turbo')).wire };
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from('a').toString('base64'), media_type: 'image/png' }, { b64_json: Buffer.from('b').toString('base64') }] }), { status: 200 });
  };
  try {
    const out = await openrouterAdapter.run({ kind: 'image', model: 'qwen/qwen-image-2.1-turbo', card, prompt: '猫', params: { aspect_ratio: '16:9', n: 2, seed: 7, extra: { foo: 1 } },
      inputs: [{ role: 'edit', data: Buffer.from('x'), mime: 'image/png' }], thread: null }, { baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer', headers: {} }, { secret: { key: 'k' } });
    assert.equal(out.assets.length, 2);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
    assert.deepEqual(calls[0].body, { model: 'qwen/qwen-image-2.1-turbo', aspect_ratio: '16:9', n: 2, seed: 7, prompt: '猫', input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }], foo: 1 });
  } finally { globalThis.fetch = orig; }
});

test('openrouter 视频：提交 → 标 uncancelable → 轮询到完成 → content 取片；首尾帧进 frame_images、时长是数', async () => {
  assert.deepEqual(videoBody({ model: 'm', prompt: 'p', params: { durationSeconds: '5', aspectRatio: 'auto', resolution: '480p' }, inputs: [{ role: 'first', data: Buffer.from('f'), mime: 'image/png' }] }),
    { model: 'm', prompt: 'p', duration: 5, resolution: '480p', frame_images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,Zg==' }, frame_type: 'first_frame' }] });
  const seen = [];
  let polls = 0, submitted = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push((init.method || 'GET') + ' ' + url);
    if (init.method === 'POST') return new Response(JSON.stringify({ id: 'gen-vid-1-abcdefghijklmnopqrst', polling_url: '/api/v1/videos/gen-vid-1-abcdefghijklmnopqrst', status: 'pending' }), { status: 202 });
    if (/\/content\?index=0$/.test(url)) return new Response(Buffer.from('MP4'), { status: 200, headers: { 'content-type': 'video/mp4' } });
    polls++;
    return new Response(JSON.stringify(polls < 2 ? { id: 'x', status: 'in_progress' } : { id: 'x', status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/x/content?index=0'], usage: { cost: 0.015 } }), { status: 200 });
  };
  try {
    const out = await openrouterAdapter.run({ kind: 'video', model: 'tbc/mischief-1', card: {}, prompt: '海浪', params: { duration: 3, resolution: '480p' }, inputs: [] },
      { baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer', headers: {}, timeoutSec: 60 }, { secret: { key: 'k' }, submitted: () => { submitted = true; }, progress: () => {}, pollMs: 5 });
    assert.equal(submitted, true);
    assert.equal(out.assets[0].bytes.toString(), 'MP4');
    assert.equal(out.assets[0].meta.cost, 0.015);
    assert.deepEqual(seen, ['POST https://openrouter.ai/api/v1/videos', 'GET https://openrouter.ai/api/v1/videos/gen-vid-1-abcdefghijklmnopqrst', 'GET https://openrouter.ai/api/v1/videos/gen-vid-1-abcdefghijklmnopqrst', 'GET https://openrouter.ai/api/v1/videos/gen-vid-1-abcdefghijklmnopqrst/content?index=0']);
  } finally { globalThis.fetch = orig; }
});

test('标签与渲染提示：对照表 → title → 可读键名；内置卡只补 format / unit', async () => {
  const { labelFor, decorateSpec } = await import('./labels.mjs');
  assert.equal(labelFor('numInferenceSteps'), '采样步数');
  assert.equal(labelFor('aspect-ratio'), '比例');
  assert.equal(labelFor('weird_knob', 'Weird Knob'), 'Weird Knob');
  assert.equal(labelFor('weird_knob'), 'Weird knob');
  const d = decorateSpec({ key: 'durationSeconds', type: 'number', min: 1, max: 60 });
  assert.deepEqual([d.format, d.unit], ['duration', 's']);
  const same = { key: 'temperature', type: 'number', min: 0, max: 2 };
  assert.equal(decorateSpec(same), same, '没有可补的就原样返回');
  assert.deepEqual(applySpecs([spec(schema.fromOpenRouterVideo(orVideo('google/veo-3.1-lite')).params, 'duration')], { durationSeconds: 7 }), { duration: 6 }, '通用名 durationSeconds 搬到 duration，取最近档');
});

test('巡检补 schema（2026-11-15）：fal / Replicate 的内置模型也拉 schema（内置卡与 schema 合并要用）；备选、下架、关掉的照旧不拉', async () => {
  const fal = P.createProvider({ preset: 'fal', dialect: 'fal', name: 'fal 补 schema', baseUrl: 'https://queue.fal.run', apiKey: 'fal-test-not-real', models: [
    { id: 'fal-ai/flux/dev', kind: 'image', source: 'builtin' },
    { id: 'acme/manual-x', kind: 'image', source: 'manual' },
    { id: 'acme/off-x', kind: 'image', source: 'manual', enabled: false },
  ] }, 'admin');
  const asked = [];
  const s = sources.falSchemaOf(fx('fal-flux-dev.json').models[0]);
  const fetchSchema = async (p, m) => { asked.push(m.id); return { src: 'jsonschema', kind: m.kind, data: { input: s.input, defs: s.defs } }; };
  const st = await disc.syncProvider('admin', fal.id, { sources: { fal: async () => ({ models: [], complete: false }) }, fetchSchema, fetchEndpoints: async () => null });
  assert.equal(st.ok, true);
  assert.deepEqual(asked.sort(), ['acme/manual-x', 'fal-ai/flux/dev']);
  assert.equal(store.getSchema('admin', fal.id, 'fal-ai/flux/dev')?.src, 'jsonschema');
});
