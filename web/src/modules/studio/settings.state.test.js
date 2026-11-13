// 设置 › Media Studio 数据面（settings.svelte.js）的单测：做法同 lib/devices.state.test.js——用 svelte 编译器把真模块编成客户端模块，
// 依赖换成桩（api 记下每次请求、按路径回假数据），注册表用真的 src/config/studio-settings.mjs。
// 跑法：node --test web/src/modules/studio/settings.state.test.js
//   ① 管理员改主机层、成员只能改个人层（主机项成员不可改、看不见）
//   ② 成员改某个种类的默认模型：只写自己覆盖的种类，选「跟随管理员」= 删掉那一项
//   ③ 改设置失败：乐观更新回滚、报错留在 ss.err
//   ④ 安全设置适用判断（默认图像服务是不是 Google 系）
//   ⑤ 服务品牌标映射（本机模型不用 Ollama 的标，「OpenAI 兼容」不冒充 OpenAI）、调用日志状态
//   ⑥ 注册表的每一句界面文案在英文字典里都有（后端改了注册表忘了补译文时这里会红）
//   ⑦ 自动发现（方案 §9.3）：discoverable、立即检查、新模型 / 备选 / 已下线的判定、检查失败
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', '..');
const repoRoot = join(webRoot, '..');
const require = createRequire(join(webRoot, 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));
const registryUrl = pathToFileURL(join(repoRoot, 'src', 'config', 'studio-settings.mjs')).href;

// —— 桩：api 按路径回数据，记下每次请求；fail 里的路径抛 400 ——
const STUBS = {
  'lib/api.js': `
    export const calls = []; export const routes = {}; export const fail = new Set();
    const hit = (method, path, body) => {
      calls.push({ method, path, body });
      const key = method + ' ' + path.split('?')[0];
      if (fail.has(key)) { const e = new Error('bad'); e.status = 400; e.body = { error: '服务端拒绝了' }; throw e; }
      const r = routes[key];
      return typeof r === 'function' ? r(body, path) : r ?? {};
    };
    export const api = { async get(p) { return hit('GET', p); }, async post(p, b) { return hit('POST', p, b); } };`,
  'lib/bus.js': `export const busOn = () => () => {};`,
  'lib/state.svelte.js': `export const me = { kind: 'admin' };`,
  'lib/i18n.js': `const fill = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (m, k) => (v && k in v ? v[k] : m));
    export const t = (s, v) => fill(s, v); export const tr = (s) => (s == null ? '' : String(s));
    export const isEn = () => false;`,
  'lib/providerLogos.js': readFileSync(join(webRoot, 'src', 'lib', 'providerLogos.js'), 'utf8'),
  'modules/studio/settingsRegistry.js': readFileSync(join(here, 'settingsRegistry.js'), 'utf8').replaceAll('../../../../src/config/studio-settings.mjs', registryUrl),
  'modules/studio/icons.js': readFileSync(join(here, 'icons.js'), 'utf8'),   // 种类字形（设置页与 Studio 共用一套线稿）
};

const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'studio-settings-test-'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
for (const [f, src] of Object.entries(STUBS)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), src); }
const out = compileModule(readFileSync(join(here, 'settings.svelte.js'), 'utf8'), { filename: 'settings.svelte.js', generate: 'client' }).js.code;
// vite 才有 import.meta.env：dev fixture 分支在这里恒关
writeFileSync(join(dir, 'modules', 'studio', 'settings.svelte.js'), fixImports(out).replaceAll('import.meta.env.DEV', 'false'));
// 模块顶层读 localStorage / location（dev fixture 开关）：node 里给个空壳
globalThis.localStorage = { getItem: () => null };
globalThis.location = { search: '' };
const m = await import(pathToFileURL(join(dir, 'modules', 'studio', 'settings.svelte.js')).href);
const stub = await import(pathToFileURL(join(dir, 'lib', 'api.js')).href);
const posts = (path) => stub.calls.filter((c) => c.method === 'POST' && c.path === path);

// 服务端 GET /api/studio/settings 的形状（studio-backend 定案）：管理员带 host，成员只有 mine
const adminSettings = (values = {}) => ({
  ok: true, canEditHost: true,
  host: { values: { autoSave: true, saveDir: 'Media Studio', claudeMedia: true, dimensioMedia: false, defaults: {}, ...values }, changed: Object.keys(values) },
  mine: { values: {}, changed: [] }, effective: { autoSave: true, saveDir: 'Media Studio', defaults: {}, ...values },
});
// 成员：mine.values 是个人可改的那几项的值——自己改过的给自己的，没改过的给主机的（studioMineSnapshot）；changed = 自己改过的键。
const memberSettings = (mine = {}, hostDefaults = {}, host = { autoSave: true, saveDir: 'Media Studio' }) => ({
  ok: true, canEditHost: false,
  mine: { values: { defaults: hostDefaults, ...host, ...mine }, changed: Object.keys(mine) },
  effective: { ...host, ...mine, defaults: { ...hostDefaults, ...(mine.defaults || {}) } },
});

test('① 管理员改主机层；成员只能改个人项，主机项不可改也不出现在组里', async () => {
  stub.routes['GET /api/studio/settings'] = adminSettings();
  await m.loadSettings();
  assert.equal(m.scopeOf('claudeMedia'), 'host');
  assert.equal(m.scopeOf('saveDir'), 'host');
  assert.deepEqual(m.groupKeys('agents', ['claude']), ['claudeMedia', 'claudeProactive', 'apiMedia']);   // dimensio / codex 这台没有
  assert.ok(m.groupKeys('agents', ['claude', 'dimensio']).includes('dimensioMedia'));

  stub.routes['GET /api/studio/settings'] = memberSettings();
  await m.loadSettings();
  assert.equal(m.scopeOf('claudeMedia'), null);
  assert.equal(m.scopeOf('saveDir'), 'mine');
  assert.deepEqual(m.groupKeys('agents', null), []);
  assert.deepEqual(m.groupKeys('safety', null), []);
  assert.deepEqual(m.groupKeys('storage', null), ['autoSave', 'saveDir']);
  assert.equal(await m.setSetting('claudeMedia', false), false);   // 成员改主机项：直接拒，不发请求
  assert.equal(posts('/api/studio/settings').length, 0);
});

test('② 成员的默认模型只写自己覆盖的种类；选「跟随管理员」删掉那一项', async () => {
  const host = { image: { provider: 'p-aaaaaa01', model: 'nano' } };
  stub.routes['GET /api/studio/settings'] = memberSettings({}, host);
  stub.routes['POST /api/studio/settings'] = (b) => memberSettings(b.values.defaults ? { defaults: b.values.defaults } : {}, host);
  await m.loadSettings();
  assert.equal(m.defaultMine('image'), false);   // mine.values.defaults 里是主机的值，但没改过就不算「我的」（11-05 回归）
  assert.deepEqual(m.defaultOf('image'), host.image);   // 没覆盖：生效值是管理员的

  await m.setDefault('video', { provider: 'p-bbbbbb02', model: 'veo' });
  let last = posts('/api/studio/settings').at(-1).body;
  assert.equal(last.scope, 'mine');
  assert.deepEqual(last.values, { defaults: { video: { provider: 'p-bbbbbb02', model: 'veo' } } });   // 没把主机的 image 抄进个人层
  assert.equal(m.defaultMine('video'), true);

  await m.setDefault('image', { provider: 'p-cccccc03', model: 'gpt' });
  last = posts('/api/studio/settings').at(-1).body;
  assert.deepEqual(Object.keys(last.values.defaults).sort(), ['image', 'video']);

  await m.setDefault('video', null);
  last = posts('/api/studio/settings').at(-1).body;
  assert.deepEqual(last.values.defaults, { image: { provider: 'p-cccccc03', model: 'gpt' } });
});

test('③ 改设置失败：乐观更新回滚，原因留在 ss.err', async () => {
  stub.routes['GET /api/studio/settings'] = adminSettings({ claudeMedia: true });
  await m.loadSettings();
  stub.fail.add('POST /api/studio/settings');
  const ok = await m.setSetting('claudeMedia', false);
  stub.fail.delete('POST /api/studio/settings');
  assert.equal(ok, false);
  assert.equal(m.valueOf('claudeMedia'), true);
  assert.equal(m.ss.err, '服务端拒绝了');
  assert.equal(m.ss.busy, '');
});

test('④ 安全设置只对 Google 系的默认图像服务适用', async () => {
  stub.routes['GET /api/studio/catalog'] = { kinds: { image: { defaults: null, groups: [
    { provider: { id: 'p-aaaaaa01', name: 'Vertex', dialect: 'vertex' }, models: [{ key: 'p-aaaaaa01/nano', id: 'nano', label: 'Nano Banana' }] },
    { provider: { id: 'p-cccccc03', name: 'OpenRouter', dialect: 'openrouter' }, models: [{ key: 'p-cccccc03/gpt', id: 'gpt', label: 'GPT Image' }] },
  ] } } };
  await m.loadCatalog(true);
  stub.routes['GET /api/studio/settings'] = adminSettings({ defaults: { image: { provider: 'p-cccccc03', model: 'gpt' } } });
  await m.loadSettings();
  assert.equal(m.safetyApplies(), false);
  assert.deepEqual(m.resolvePick('image', m.defaultOf('image')), { label: 'GPT Image', provider: 'OpenRouter', dialect: 'openrouter', preset: undefined });
  stub.routes['GET /api/studio/settings'] = adminSettings({ defaults: { image: { provider: 'p-aaaaaa01', model: 'nano' } } });
  await m.loadSettings();
  assert.equal(m.safetyApplies(), true);
  stub.routes['GET /api/studio/settings'] = adminSettings();
  await m.loadSettings();
  assert.equal(m.safetyApplies(), true);   // 没设默认 = 跟内置（Google）走
});

test('⑤ 品牌标映射与调用日志状态', async () => {
  const { PROVIDER_LOGOS } = await import(pathToFileURL(join(dir, 'lib', 'providerLogos.js')).href);
  assert.equal(m.logoFor({ preset: 'local', dialect: 'local' }), PROVIDER_LOGOS['local-image']);
  assert.notEqual(m.logoFor({ preset: 'local', dialect: 'local' }), PROVIDER_LOGOS.local);   // 不是 Ollama 那只羊驼
  assert.equal(m.logoFor({ preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://api.example.com/v1' }), '');
  assert.equal(m.logoFor({ preset: 'custom', dialect: 'fal' }), PROVIDER_LOGOS.fal);
  assert.equal(m.logoFor({ preset: 'vertex', dialect: 'vertex' }), PROVIDER_LOGOS.vertex);
  assert.ok(m.logOk({ status: 'ok' }) && m.logOk({ status: 204 }));
  assert.ok(m.logBad({ status: 'error' }) && m.logBad({ status: 502 }) && m.logBad({ status: 0 }));
  assert.ok(!m.logOk({ status: 'canceled' }) && !m.logBad({ status: 'canceled' }));
  assert.equal(m.logStatusText({ status: 'canceled' }), '已取消');
});

test('⑦ 自动发现：discoverable、立即检查（进行中标记、刷新服务与目录）、新模型 / 备选 / 已下线、检查失败', async () => {
  const now = Date.now();
  const models = [
    { id: 'a', kind: 'image', enabled: true, source: 'builtin' },
    { id: 'n', kind: 'image', enabled: true, source: 'remote', discoveredAt: now - 3600_000 },
    { id: 'old', kind: 'image', enabled: true, source: 'remote', discoveredAt: now - 8 * 86400_000 },
    { id: 's', kind: 'video', enabled: true, source: 'remote', discoveredAt: now, shelf: true },
    { id: 'g', kind: 'video', enabled: true, source: 'remote', discoveredAt: now, gone: true },
  ];
  const before = { id: 'p-abc123', dialect: 'openrouter', autoSync: true, sync: null, models };
  const after = { ...before, sync: { at: now, ok: false, error: '巡检超时', added: [], gone: [] } };
  stub.routes['GET /api/studio/providers'] = { providers: [before], discoverable: ['openrouter', 'gemini'] };
  stub.routes['GET /api/studio/catalog'] = { kinds: {} };
  await m.loadProviders(true);
  assert.ok(m.canDiscover('openrouter') && !m.canDiscover('minimax') && !m.canDiscover(''));
  assert.ok(m.isNewModel(models[1]) && !m.isNewModel(models[0]) && !m.isNewModel(models[2]));
  assert.ok(!m.isNewModel(models[3]) && !m.isNewModel(models[4]));   // 备选、已下线不算新
  assert.ok(m.hasNewModels(before));
  assert.deepEqual(m.enabledModels(before).map((x) => x.id), ['a', 'n', 'old']);
  assert.deepEqual(m.providerKinds(before), ['image']);
  assert.equal(m.syncFailed(before), false);

  let seen = null;
  stub.routes['POST /api/studio/providers/sync'] = (b) => {
    seen = { body: b, syncing: !!m.sp.syncing['p-abc123'] };
    stub.routes['GET /api/studio/providers'] = { providers: [after], discoverable: ['openrouter', 'gemini'] };
    return { ok: true, results: { 'p-abc123': after.sync }, providers: [after] };
  };
  const r = await m.syncProvider('p-abc123');
  assert.deepEqual(seen, { body: { id: 'p-abc123' }, syncing: true });
  assert.deepEqual(r, after.sync);
  assert.equal(m.sp.syncing['p-abc123'], undefined);
  assert.equal(m.syncFailed(m.sp.providers[0]), true);
  assert.ok(stub.calls.some((c) => c.method === 'GET' && c.path === '/api/studio/catalog'));

  stub.fail.add('POST /api/studio/providers/sync');
  await assert.rejects(m.syncProvider('p-abc123'), /服务端拒绝了/);
  assert.equal(m.sp.syncing['p-abc123'], undefined);   // 失败也收起进行中
  stub.fail.delete('POST /api/studio/providers/sync');
});

test('⑧ 模型行的主名：自己起的名 > 目录（Studio）里的显示名 > id；主列表、备选都找，按种类和服务对上', async () => {
  stub.routes['GET /api/studio/catalog'] = { kinds: {
    image: { groups: [
      { provider: { id: 'p-v' }, models: [{ key: 'p-v/gemini-3-pro-image', id: 'gemini-3-pro-image', label: 'Nano Banana Pro' }, { key: 'p-v/raw', id: 'raw', label: 'raw' }] },
      { provider: { id: 'p-o' }, models: [], shelf: [{ key: 'p-o/x/y', id: 'x/y', label: 'XY Image' }] },
    ] },
    video: { groups: [{ provider: { id: 'p-v' }, models: [{ key: 'p-v/veo', id: 'veo', label: 'Veo 3.1' }] }] },
  } };
  await m.loadCatalog(true);
  assert.equal(m.catalogLabel('p-v', 'gemini-3-pro-image', 'image'), 'Nano Banana Pro');
  assert.equal(m.catalogLabel('p-v', 'gemini-3-pro-image'), 'Nano Banana Pro');   // 不给种类：各种类都找
  assert.equal(m.catalogLabel('p-v', 'gemini-3-pro-image', 'video'), '');
  assert.equal(m.catalogLabel('p-other', 'gemini-3-pro-image', 'image'), '');      // 别的服务的同名模型不算
  assert.equal(m.catalogLabel('p-o', 'x/y', 'image'), 'XY Image');                  // 备选也找
  assert.equal(m.catalogLabel('p-v', 'raw', 'image'), '');                          // 显示名就是 id = 没有
  assert.equal(m.modelTitle({ id: 'gemini-3-pro-image', label: 'gemini-3-pro-image', kind: 'image' }, 'p-v'), 'Nano Banana Pro');
  assert.equal(m.modelTitle({ id: 'gemini-3-pro-image', label: '我的香蕉', kind: 'image' }, 'p-v'), '我的香蕉');
  assert.equal(m.modelTitle({ id: 'veo', kind: 'video' }, 'p-v'), 'Veo 3.1');
  assert.equal(m.modelTitle({ id: 'nope', label: 'nope', kind: 'image' }, 'p-v'), 'nope');
  assert.equal(m.modelTitle(null, 'p-v'), '');
});

test('⑥ 注册表里每句界面文案在英文字典里都有', async () => {
  const reg = await import(registryUrl);
  const enDir = join(webRoot, 'src', 'i18n', 'en');
  const dict = {};
  for (const f of readdirSync(enDir)) if (f.endsWith('.js') && f !== 'index.js') Object.assign(dict, (await import(pathToFileURL(join(enDir, f)).href)).default);
  const missing = [];
  const want = (s) => { if (s && /[一-鿿]/.test(s) && !dict[s]) missing.push(s); };
  for (const g of reg.STUDIO_SETTING_GROUPS) { want(g.label); want(g.foot); }
  for (const s of reg.STUDIO_SETTINGS) { want(s.label); want(s.desc); for (const o of s.optionLabels || []) want(o); }
  assert.deepEqual(missing, []);
});
