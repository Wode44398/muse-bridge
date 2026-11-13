// 模型中心前端状态层（lib/modelHub.svelte.js）的纯逻辑：
//   · 认服务端版本：v2 带 v: 2（或至少带 studio 键）；老服务端（v1）两样都没有 → hub.ok 但不是 v2（hubLegacy）
//   · 老服务端上不开服务浮层（添加 / 详情背后的接口它没有），别的浮层照常
//   · studioErr：Studio 列表读不出时的那句话跟着总览进状态、下一次读好了就清掉
//   · kindTally：不带 kind 的模型按文本数（v1 的模型没有这个字段）
//   · adoptReach：「改为共用」之后模型给谁（确认框按它措辞，得和后端 adopt 一致）
// 做法同 dialogs.test.js：用 svelte 编译器把真的 modelHub.svelte.js 编成客户端模块，依赖换成桩。不起浏览器、不碰任何数据根。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));

const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'modelhub-test-'));
mkdirSync(join(dir, 'lib'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
const js = compileModule(readFileSync(join(here, 'modelHub.svelte.js'), 'utf8'), { filename: 'modelHub.svelte.js', generate: 'client' }).js.code;
writeFileSync(join(dir, 'lib', 'modelHub.svelte.js'), fixImports(js));
// 桩：api 的应答 / 报错由测试现配（globalThis.__hubApi）；身份现读 globalThis.__me
writeFileSync(join(dir, 'lib', 'api.js'), `export const calls = [];
export const api = {
  async get(u) { calls.push(['GET', u]); return globalThis.__hubApi.get(u); },
  async post(u, b) { calls.push(['POST', u, b]); return globalThis.__hubApi.post(u, b); },
};`);
writeFileSync(join(dir, 'lib', 'state.svelte.js'), 'export const me = { get kind() { return globalThis.__me; } };');
writeFileSync(join(dir, 'lib', 'claudeProviders.svelte.js'), 'export const cpSummaryText = () => "cp";');
writeFileSync(join(dir, 'lib', 'settingsNav.svelte.js'), 'export const opened = []; export const openSettingsFromChat = (s) => { opened.push(s); return true; };');
writeFileSync(join(dir, 'lib', 'i18n.js'), 'export const t = (s, p) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? p[k] : m)); export const tr = (s) => s;');

const H = await import(pathToFileURL(join(dir, 'lib', 'modelHub.svelte.js')).href);
const { hub, hubUi } = H;

const V2 = { ok: true, v: 2, vertex: null, services: [], claude: [], dimensio: [], studio: [], plugins: [] };
// main 上线版（v1）的总览：没有 v、没有 studio 键；服务不带 counts，模型不带 kind
const V1 = { ok: true, vertex: null, services: [{ id: 'h-1', name: 'old', agents: ['claude', 'dimensio'], models: [{ id: 'gpt-x' }] }], claude: [], dimensio: null, plugins: [] };
const httpErr = (status, body) => Object.assign(new Error('http ' + status), { status, body });

function serve(overview) {
  globalThis.__hubApi = { get: async () => (typeof overview === 'function' ? overview() : overview), post: async () => ({ ok: true }) };
}
async function load(overview, kind = 'admin') {
  globalThis.__me = kind;
  serve(overview);
  H.closeHubSheet();
  await H.loadHub(true);
}

test('认版本：带 v: 2 是 v2；没带 v 但有 studio 键（哪怕是 null）也算 v2；v1 的形状 → ok 但不是 v2', async () => {
  await load(V2);
  assert.equal(hub.ok, true);
  assert.equal(hub.v2, true);
  assert.equal(H.hubLegacy(), false);

  const { v, ...noV } = V2;
  await load({ ...noV, studio: null });
  assert.equal(hub.v2, true, '没装 Studio 的 v2 也会序列化 studio: null');
  assert.equal(hub.studio, null);

  await load(V1);
  assert.equal(hub.ok, true, '老服务端也有总览');
  assert.equal(hub.v2, false);
  assert.equal(hub.studio, null);
  assert.equal(H.hubLegacy(), true);

  // 升级之后再拉一次：回到 v2
  await load(V2);
  assert.equal(H.hubLegacy(), false);
});

test('总览还没拿到（hub.ok 为假）不算老服务端：不知道是哪一版，别提前拦', async () => {
  globalThis.__me = 'admin';
  globalThis.__hubApi = { get: async () => { throw httpErr(404, 'not found'); }, post: async () => ({}) };
  await H.loadHub(true);
  assert.equal(hub.ok, false);
  assert.equal(H.hubLegacy(), false);
});

test('老服务端上不开服务浮层（添加 / 详情），别的浮层照常；v2 上都能开', async () => {
  await load(V1);
  assert.equal(H.openHubSheet({ type: 'service', add: true }), false);
  assert.equal(H.openHubSheet({ type: 'service', id: 'h-1' }), false);
  assert.equal(hubUi.sheet, null, '没开成就不留半截状态');
  // dimensio 的「模型服务」面板经 openModelHub('add') 进来：如实回 false，它据此退回自己的表单
  assert.equal(H.openModelHub('add'), false);
  assert.equal(H.openModelHub({ type: 'service', id: 'h-1' }), false);
  // 启停、Vertex、Claude 专用服务、内置厂商 Key 这些 v1 都有
  assert.equal(H.openHubSheet({ type: 'vertex' }), true);
  assert.equal(hubUi.sheet.type, 'vertex');
  assert.equal(H.openHubSheet({ type: 'claude', id: 'p-1' }), true);
  assert.equal(H.openHubSheet({ type: 'dkey', vendor: { id: 'openai', name: 'DeepSeek', hasKey: true } }), true);
  // 不带参数 = 打开设置里的模型中心分区（首页自己会显示「服务器版本较旧」）
  assert.equal(H.openModelHub(), true);

  await load(V2);
  assert.equal(H.openHubSheet({ type: 'service', add: true }), true);
  assert.deepEqual({ ...hubUi.sheet }, { type: 'service', add: true });
  assert.equal(H.openModelHub('add'), true);
  assert.equal(H.openHubSheet({ type: 'studio', initial: { view: 'google' } }), true, 'HubVertex 的「Google 云凭据」走这条');
  assert.deepEqual({ ...hubUi.sheet.initial }, { view: 'google' });
  H.closeHubSheet();
});

test('成员：只有 Claude 专用服务的浮层能开，和服务端版本无关', async () => {
  await load(V2, 'user');   // 成员不拉总览：hub 保持上一次的样子，这里只看身份闸门
  assert.equal(H.openHubSheet({ type: 'service', add: true }), false);
  assert.equal(H.openHubSheet({ type: 'studio', initial: { view: 'google' } }), false);
  assert.equal(H.openHubSheet({ type: 'claude', presets: true }), true);
  assert.equal(H.openModelHub('add'), true, '成员的「添加」= Claude 专用服务的预设选择');
  assert.deepEqual({ ...hubUi.sheet }, { type: 'claude', presets: true });
  H.closeHubSheet();
});

test('studioErr：跟着总览进状态，不是字符串的不收，下一次读好了就清掉', async () => {
  await load({ ...V2, studio: [], studioErr: '读不出 Media Studio 的服务' });
  assert.equal(hub.studioErr, '读不出 Media Studio 的服务');
  assert.deepEqual([...hub.studio], [], '空数组照收：首页靠 studioErr 知道这不是「一个都没有」');
  assert.equal(hub.v2, true);

  await load({ ...V2, studioErr: { nope: 1 } });
  assert.equal(hub.studioErr, '');

  await load({ ...V2, studio: [], studioErr: 'x' });
  await load(V2);
  assert.equal(hub.studioErr, '');
});

test('401 / 403 / 404：入口没了，上一次留下的报错一并清掉；别的失败记成人话', async () => {
  globalThis.__me = 'admin';
  globalThis.__hubApi = { get: async () => { throw httpErr(500, { error: '模型中心出错了' }); }, post: async () => ({}) };
  await H.loadHub(true);
  assert.equal(hub.err, '模型中心出错了');

  for (const status of [401, 403, 404]) {
    hub.err = '上一次的错';
    hub.ok = true;
    globalThis.__hubApi.get = async () => { throw httpErr(status, 'nope'); };
    await H.loadHub(true);
    assert.equal(hub.ok, false, String(status));
    assert.equal(hub.err, '', String(status));
  }

  // 网关替服务器答的一整页 HTML：不把标签亮给用户
  globalThis.__hubApi.get = async () => { throw httpErr(502, '<html><body>Bad gateway</body></html>'); };
  await H.loadHub(true);
  assert.equal(hub.err, '服务器没有正常响应（HTTP 502）');

  await load(V2);
  assert.equal(hub.err, '');
});

test('kindTally：按种类数；不带 kind 的按文本（v1 的模型）；other 与认不出的不数', () => {
  assert.deepEqual(H.kindTally([{ id: 'a', kind: 'text' }, { id: 'b', kind: 'image' }, { id: 'c', kind: 'text' }]), { text: 2, image: 1 });
  assert.deepEqual(H.kindTally([{ id: 'gpt-x' }, { id: 'y', kind: undefined }, { id: 'z', kind: null }]), { text: 3 });
  assert.deepEqual(H.kindTally([{ id: 'e', kind: 'other' }, { id: 'f', kind: 'embedding' }, null, undefined]), {});
  assert.deepEqual(H.kindTally([{ id: 'v', kind: 'voice' }, { id: 'm', kind: 'music' }, { id: 'vd', kind: 'video' }]), { voice: 1, music: 1, video: 1 });
  assert.deepEqual(H.kindTally(null), {});
  assert.deepEqual(H.kindTally(undefined), {});
  // v1 总览里那条服务：没有 counts，首页用它算出 { text: 1 }，筛「文本」时这一行还在
  assert.deepEqual(H.kindTally(V1.services[0].models), { text: 1 });
});

test('adoptReach：Claude / dimensio 的服务两边都给；Gemini 接口的给不了 Claude、没开 dimensio 谈不上两边；Studio 原地托管', async () => {
  await load(V2);   // dimensio: []（开着，只是没有自建服务）
  assert.equal(H.adoptReach('claude'), 'both');
  assert.equal(H.adoptReach('dimensio', 'openai'), 'both');
  assert.equal(H.adoptReach('dimensio', 'anthropic'), 'both');
  assert.equal(H.adoptReach('dimensio', ''), 'both');
  assert.equal(H.adoptReach('dimensio', 'gemini'), 'origin');
  assert.equal(H.adoptReach('studio'), 'studio');
  assert.equal(H.adoptReach('studio', 'gemini'), 'studio');

  await load({ ...V2, dimensio: null });   // 这台服务器没开 dimensio
  assert.equal(H.adoptReach('claude'), 'origin');
  assert.equal(H.adoptReach('studio'), 'studio');
});

test('hubSummaryText：托管给模型中心的 Studio 服务不重复数', async () => {
  await load({
    ...V2,
    services: [{ id: 'h-1' }],
    vertex: { configured: true },
    claude: [{ id: 'p-1' }],
    dimensio: [{ id: 'd-1' }],
    studio: [{ id: 's-1', managed: true }, { id: 's-2', managed: false }],
  });
  assert.equal(H.hubSummaryText(), '5 个模型服务');
});
