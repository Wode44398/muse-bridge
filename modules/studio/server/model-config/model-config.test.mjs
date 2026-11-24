// 模型配置层：参数覆盖叠到卡上、配方换掉适配器、托管服务也能配、预演 / 试跑、删服务连带清配置、成员改不了共享服务。
// 数据根改道到临时目录（核心 config 导入时就读数据根，先设环境变量再动态 import）。上游一律 mock 全局 fetch。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-modelcfg-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18996, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true } }, null, 2));

await (await import('@bridge/core/modules/registry.mjs')).loadModules();
const P = await import('../providers.mjs');
const { cardFor } = await import('../cards/index.mjs');
const catalogMod = await import('../catalog.mjs');
const jobs = await import('../jobs.mjs');
const MC = await import('./index.mjs');
const { getModelConfig } = await import('./store.mjs');
const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
const { RECIPE_EXAMPLES } = await import('../recipe/examples.mjs');

const admin = contextFor({ kind: 'admin' });
const KEY = 'sk-relay-0123456789abcdef';
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
async function withFetch(handler, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', init }); return handler(String(url), init, calls); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const relay = P.createProvider({ name: '中转站', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://relay.example/v1', apiKey: KEY,
  models: [{ id: 'gpt-image-2', kind: 'image' }, { id: 'kling-v2', kind: 'video' }] }, 'admin');
const pid = relay.id;
const entryOf = (mid) => P.getProvider(pid, 'admin').models.find((m) => m.id === mid);

test('参数覆盖：补选项、改默认、垫额外请求体；键不在卡上 / 不是选项型都拒', () => {
  const base = cardFor(P.getProvider(pid, 'admin'), entryOf('gpt-image-2'));
  assert.ok(base.params.some((s) => s.key === 'outputFormat'));
  assert.throws(() => MC.writeConfig('admin', { key: `${pid}/gpt-image-2`, over: { options: { nope: ['x'] } } }), /没有参数「nope」/);
  assert.throws(() => MC.writeConfig('admin', { key: `${pid}/gpt-image-2`, over: { options: { extra: ['x'] } } }), /不是选项型/);
  const { view } = MC.writeConfig('admin', { key: `${pid}/gpt-image-2`, over: { options: { outputFormat: ['svg'] }, defaults: { quality: 'high' }, extra: { moderation: 'low' } } });
  const fmt = view.effective.params.find((s) => s.key === 'outputFormat');
  assert.ok(fmt.options.some((o) => o.value === 'svg' && o.custom), '补的选项标 custom');
  assert.equal(view.effective.params.find((s) => s.key === 'quality').default, 'high');
  assert.ok(!view.base.params.find((s) => s.key === 'outputFormat').options.some((o) => o.value === 'svg'), '基础卡不变');
  const card = cardFor(P.getProvider(pid, 'admin'), entryOf('gpt-image-2'));
  assert.equal(card.extraBase.moderation, 'low');
  const m = catalogMod.catalog('admin').kinds.image.groups.flatMap((g) => g.models).find((x) => x.key === `${pid}/gpt-image-2`);
  assert.deepEqual(m.custom, { over: true });
});

test('覆盖在生成里生效：选了补的选项照原样发、默认值垫底、额外请求体叠在调用方的下面', async () => {
  await withFetch(() => jsonRes({ data: [{ b64_json: PNG.toString('base64') }] }), async (calls) => {
    const { job, done } = jobs.startJob(admin, { kind: 'image', key: `${pid}/gpt-image-2`, prompt: '图标', params: { outputFormat: 'svg', extra: { user: 'me' } } });
    assert.equal(job.params.outputFormat, 'svg');
    assert.equal(job.params.quality, 'high');
    assert.deepEqual(job.params.extra, { moderation: 'low', user: 'me' });
    const fin = await done;
    assert.equal(fin.state, 'done', fin.error);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.output_format, 'svg');
    assert.equal(body.moderation, 'low');
  });
});

test('配方：给已有模型写配方后改走配方适配器（不再按 OpenAI 方言拼），目录标 recipe', async () => {
  const recipe = RECIPE_EXAMPLES.find((x) => x.id === 'async-video').recipe;
  const { view } = MC.writeConfig('admin', { key: `${pid}/kling-v2`, recipe });
  assert.equal(view.effective.paramSource, 'recipe');
  assert.ok(view.effective.params.some((s) => s.key === 'duration'));
  const m = catalogMod.catalog('admin').kinds.video.groups.flatMap((g) => g.models).find((x) => x.key === `${pid}/kling-v2`);
  assert.deepEqual(m.custom, { recipe: true });
  await withFetch((url) => (url.endsWith('/video/create') ? jsonRes({ id: 'j1' }) : url.includes('/video/query') ? jsonRes({ status: 'completed', video_url: 'https://cdn.example/a.mp4' })
    : new Response(Buffer.from('MP4'), { headers: { 'content-type': 'video/mp4' } })), async (calls) => {
    const { done } = jobs.startJob(admin, { kind: 'video', key: `${pid}/kling-v2`, prompt: '海浪', params: { duration: 10 } });
    const fin = await done;
    assert.equal(fin.state, 'done', fin.error);
    assert.equal(calls[0].url, 'https://relay.example/v1/video/create');
    assert.equal(JSON.parse(calls[0].init.body).duration, 10);
  });
});

test('新建模型条目 + 配方；换配方时对不上的覆盖自动清掉并说明；null 删掉', () => {
  assert.throws(() => MC.writeConfig('admin', { key: `${pid}/new-tts`, recipe: RECIPE_EXAMPLES.find((x) => x.id === 'binary-speech').recipe }), /create/);
  const { view } = MC.writeConfig('admin', { key: `${pid}/new-tts`, create: { kind: 'speech', label: '新配音' }, recipe: RECIPE_EXAMPLES.find((x) => x.id === 'binary-speech').recipe, over: { defaults: { voice: 'nova' } } });
  assert.equal(view.exists, true);
  assert.equal(view.label, '新配音');
  assert.equal(entryOf('new-tts').source, 'manual');
  const r2 = MC.writeConfig('admin', { key: `${pid}/new-tts`, recipe: { submit: { path: '/tts', body: { t: '{{prompt}}' } }, result: { binary: true } } });
  assert.equal(r2.view.over, null);
  assert.match(r2.warnings[0], /对不上/);
  MC.writeConfig('admin', { key: `${pid}/new-tts`, recipe: null });
  assert.equal(getModelConfig('admin', pid, 'new-tts'), null);
});

test('预演：只拼请求不发，Key 只剩尾号；没配方的模型说明要真跑；草稿配方给没加进服务的模型也能预演', async () => {
  await withFetch(() => { throw new Error('预演不该联网'); }, async () => {
    const r = MC.trial(admin, 'admin', { key: `${pid}/kling-v2`, dry: true, prompt: 'p', params: { duration: 5 }, inputs: [{ role: 'first' }] });
    assert.equal(r.request.submit.url, 'https://relay.example/v1/video/create');
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.match(r.request.submit.headers.Authorization, /…/);
    const n = MC.trial(admin, 'admin', { key: `${pid}/gpt-image-2`, dry: true, prompt: 'p' });
    assert.equal(n.request, null);
    assert.match(n.note, /真跑/);
    const d = MC.trial(admin, 'admin', { key: `${pid}/brand-new`, dry: true, kind: 'image', prompt: 'p', recipe: RECIPE_EXAMPLES.find((x) => x.id === 'sync-image').recipe });
    assert.equal(d.request.submit.url, 'https://relay.example/v1/images/generations');
    assert.equal(entryOf('brand-new'), undefined, '预演不会把模型加进服务');
  });
});

test('试跑：真发一次，记录每一步的请求与响应，记录里没有 Key', async () => {
  await withFetch(() => jsonRes({ data: [{ b64_json: PNG.toString('base64') }], echo: KEY }), async () => {
    const { job } = MC.trial(admin, 'admin', { key: `${pid}/draft-img`, kind: 'image', prompt: 'p', recipe: RECIPE_EXAMPLES.find((x) => x.id === 'sync-image').recipe });
    for (let i = 0; i < 100 && !MC.trialResult('admin', job.id)?.done; i++) await new Promise((r) => setTimeout(r, 10));
    const r = MC.trialResult('admin', job.id);
    assert.equal(r.done, true);
    assert.equal(r.job.state, 'done', r.job.error);
    assert.equal(r.trace.length, 1);
    assert.equal(r.trace[0].response.status, 200);
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.equal(MC.trialResult('u:bob', job.id), null, '别人的试跑看不到');
    assert.equal(r.job.result[0].wsPath, undefined, '试跑不自动存进工作空间');
  });
});

test('托管服务：不能在这里新建模型（去模型中心加），已有模型的覆盖与配方照样能写', () => {
  const hub = P.createProvider({ name: '托管', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://hub.example/v1', models: [{ id: 'img-a', kind: 'image' }] }, 'admin');
  P.updateProvider(hub.id, {}, 'admin');
  const d = P.getProvider(hub.id, 'admin');
  d.managedBy = 'hub'; d.hubRef = 'h-0000abcd';   // 直接打标：模型中心托管服务的 managed 只有 hub-bridge 能写
  assert.throws(() => MC.writeConfig('admin', { key: `${hub.id}/img-b`, create: { kind: 'image' }, over: null }), /模型中心/);
  const { view } = MC.writeConfig('admin', { key: `${hub.id}/img-a`, over: { options: { outputFormat: ['svg'] } } });
  assert.equal(view.provider.managed, true);
  assert.ok(view.effective.params.find((s) => s.key === 'outputFormat').options.some((o) => o.value === 'svg'));
});

test('成员改不了管理员共享的服务的配置；删服务连带清掉它的配置', () => {
  const shared = P.createProvider({ name: '共享', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://s.example/v1', shared: true, models: [{ id: 'm', kind: 'image' }] }, 'admin');
  assert.throws(() => MC.writeConfig('u:bob', { key: `${shared.id}/m`, over: { defaults: { quality: 'low' } } }), (e) => e.status === 403);
  MC.writeConfig('admin', { key: `${shared.id}/m`, over: { defaults: { quality: 'low' } } });
  assert.ok(getModelConfig('admin', shared.id, 'm'));
  P.deleteProvider(shared.id, 'admin');
  assert.equal(getModelConfig('admin', shared.id, 'm'), null);
  const f = path.join(tmp, 'studio-providers', 'model-config.json');
  assert.ok(existsSync(f) && !readFileSync(f, 'utf8').includes(shared.id));
});
