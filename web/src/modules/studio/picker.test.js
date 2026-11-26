// v4 模型选择器的纯逻辑：按厂商分组、两家服务都有的同名模型合成一行（方案 §12.4）
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelRows, sameNameKey, bareLabel, modelVendor, serviceShort } from './picker.js';

const VERTEX = { id: 'p-v', name: 'Google Vertex AI', dialect: 'vertex', preset: 'vertex' };
const GEMINI = { id: 'p-g', name: 'Gemini API', dialect: 'gemini', preset: 'gemini' };
const OR = { id: 'p-o', name: 'OpenRouter', dialect: 'openrouter', preset: 'openrouter' };
const OR2 = { id: 'p-o2', name: 'OpenRouter（团队）', dialect: 'openrouter', preset: 'openrouter' };
const m = (p, id, label, extra = {}) => ({ key: p.id + '/' + id, id, label, ...extra });

const CAT = [
  { provider: VERTEX, models: [m(VERTEX, 'gemini-3-pro-image', 'Nano Banana Pro'), m(VERTEX, 'gemini-nano-banana-2.1', 'Nano Banana 2.1'), m(VERTEX, 'gemini-3.1-flash-image', 'Nano Banana Flash')] },
  { provider: GEMINI, models: [m(GEMINI, 'gemini-nano-banana-2.1', 'Nano Banana 2.1')] },
  { provider: OR, models: [m(OR, 'openai/gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst', { vendor: 'openai' })], shelf: [m(OR, 'google/gemini-nano-banana-2.1', 'Nano Banana 2.1', { vendor: 'google' })] },
];

test('同名判定：去掉服务前缀 / 后缀与「厂商: 」，大小写与空白不计较；(free) 是另一个模型', () => {
  assert.equal(sameNameKey('Nano Banana 2.1'), 'nano banana 2.1');
  assert.equal(sameNameKey('Google: Nano Banana 2.1'), 'nano banana 2.1');
  assert.equal(sameNameKey('Vertex · Nano  Banana 2.1'), 'nano banana 2.1');
  assert.equal(sameNameKey('Nano Banana 2.1 (Gemini API)'), 'nano banana 2.1');
  assert.equal(sameNameKey('Nano Banana 2.1 - Vertex AI'), 'nano banana 2.1');
  assert.notEqual(sameNameKey('Recraft V4.1 Flash V2 (free)'), sameNameKey('Recraft V4.1 Flash V2'));
  // 「Gemini 2.5 Flash TTS」的 Gemini 是名字的一部分，不是服务前缀
  assert.equal(sameNameKey('Gemini 2.5 Flash TTS'), 'gemini 2.5 flash tts');
  assert.equal(bareLabel('Google: Nano Banana Pro'), 'Nano Banana Pro');
});

test('厂商：直连服务按方言推（Vertex / Gemini API → Google），聚合服务按 id 前缀', () => {
  assert.equal(modelVendor({ id: 'gemini-3-pro-image' }, VERTEX), 'google');
  assert.equal(modelVendor({ id: 'lyria-3.5' }, GEMINI), 'google');
  assert.equal(modelVendor({ id: 'openai/gpt-image-2.6' }, OR), 'openai');
  assert.equal(serviceShort(VERTEX), 'Vertex');
  assert.equal(serviceShort(GEMINI), 'Gemini');
});

test('Vertex 与 Gemini API 都有的 Nano Banana 2.1 合成一行，行尾两家', () => {
  const vs = modelRows(CAT);
  assert.deepEqual(vs.map((v) => v.label), ['Google', 'OpenAI']);
  const g = vs[0];
  assert.deepEqual(g.rows.map((r) => r.label), ['Nano Banana Pro', 'Nano Banana 2.1', 'Nano Banana Flash']);
  const nb = g.rows[1];
  assert.deepEqual(nb.variants.map((x) => x.short), ['Vertex', 'Gemini']);
  assert.deepEqual(nb.variants.map((x) => x.model.key), ['p-v/gemini-nano-banana-2.1', 'p-g/gemini-nano-banana-2.1']);
  assert.equal(nb.pick, 0);
  assert.equal(nb.on, false);
  // 只有一家的：一个 variant
  assert.equal(g.rows[0].variants.length, 1);
  // 备选（shelf）不进主列表
  assert.equal(vs.flatMap((v) => v.rows).filter((r) => r.label === 'Nano Banana 2.1').length, 1);
});

test('当前选中的是第二家：pick 指向它、整行亮；没选中时按 prefer 记住的那家', () => {
  const nb = modelRows(CAT, { current: 'p-g/gemini-nano-banana-2.1' })[0].rows[1];
  assert.equal(nb.pick, 1);
  assert.equal(nb.on, true);
  const id = nb.id;
  assert.equal(modelRows(CAT, { prefer: { [id]: 'p-g' } })[0].rows[1].pick, 1);
});

test('当前选中的备选模型并进同名行（OpenRouter 的 Google: 前缀也算同名）', () => {
  const cat = [CAT[0], CAT[1], { provider: OR, models: [], shelf: [m(OR, 'google/gemini-nano-banana-2.1', 'Google: Nano Banana 2.1', { vendor: 'google' })] }];
  const nb = modelRows(cat, { current: 'p-o/google/gemini-nano-banana-2.1' })[0].rows[1];
  assert.deepEqual(nb.variants.map((x) => x.short), ['Vertex', 'Gemini', 'OpenRouter']);
  assert.equal(nb.pick, 2);
});

test('同一服务里重名的不合；两个同方言服务撞短名时退回服务全名', () => {
  const cat = [
    { provider: OR, models: [m(OR, 'openai/a', 'GPT Image', { vendor: 'openai' }), m(OR, 'openai/b', 'GPT Image', { vendor: 'openai' })] },
    { provider: OR2, models: [m(OR2, 'openai/a', 'GPT Image', { vendor: 'openai' })] },
  ];
  const rows = modelRows(cat)[0].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].variants.map((x) => x.short), ['OpenRouter', 'OpenRouter（团队）']);
  assert.equal(rows[1].variants.length, 1);
});

test('搜索：只留配得上的；按服务名搜只剩那一家', () => {
  const vs = modelRows(CAT, { q: 'banana 2.1' });
  assert.equal(vs.length, 1);
  assert.equal(vs[0].rows.length, 1);
  assert.equal(vs[0].rows[0].variants.length, 2);
  const only = modelRows(CAT, { q: 'gemini api' });
  assert.deepEqual(only[0].rows.map((r) => r.variants.map((x) => x.short).join()), ['Gemini']);
});
