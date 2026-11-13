// 模型中心首页（HubHome.svelte）的模板逻辑——服务端渲染成 HTML 再看结构，不起浏览器：
//   · 连着老服务端（v1 的总览：没有 v / studio 键，服务不带 counts、模型不带 kind）：顶上一行「服务器版本较旧…」，
//     服务行照常列出、数量按文本算；v2 上没有这一行
//   · Studio 的服务列表读不出（studioErr）：在 Studio 那几行的位置出一行报错 + 重试，不算「空」
//   · 副行：域名单独包一层（窄处让位给数量）；没有数量可说时标 solo（窄处留着）
//   · 行尾的 agent 图标用 18；两套外壳各用各的开关
// 做法：用 svelte 编译器把真的 HubHome.svelte 与 modelHub.svelte.js 编成服务端模块，子组件与其余依赖换成桩。
// 点击、筛选切换、动效这些要 DOM 的不在这里测（见 lib/modelHub.test.js 测状态层的那一半）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', '..', '..');
const require = createRequire(join(WEB, 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const url = (...p) => pathToFileURL(join(svelteRoot, ...p)).href;
const SV = {
  'svelte': url('src', 'index-server.js'),
  'svelte/internal/server': url('src', 'internal', 'server', 'index.js'),
  'svelte/internal/disclose-version': url('src', 'internal', 'disclose-version.js'),
  'svelte/internal/flags/legacy': url('src', 'internal', 'flags', 'legacy.js'),
};
// svelte 的包名换成绝对地址（临时目录里没有 node_modules）；import 的 .svelte 换成编译出来的 .svelte.js
const fix = (code) => code
  .replace(/(from|import)\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, kw, s) => (SV[s] ? `${kw} '${SV[s]}'` : m))
  .replace(/(from\s+['"][^'"]+\.svelte)(['"])/g, '$1.js$2');
const { compile, compileModule } = await import(url('src', 'compiler', 'index.js'));
const { render } = await import(url('src', 'server', 'index.js'));

const dir = mkdtempSync(join(tmpdir(), 'hubhome-test-'));
const put = (rel, code) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, code); };
const comp = (rel, src) => put(rel + '.js', fix(compile(src, { filename: rel, generate: 'server' }).js.code));
const mod = (rel, src) => put(rel, fix(compileModule(src, { filename: rel, generate: 'server' }).js.code));
put('package.json', '{"type":"module"}');

// 目录结构照真的摆（HubHome 用相对路径 import）
const MH = 'web/src/components/modelhub/';
comp(MH + 'HubHome.svelte', readFileSync(join(here, 'HubHome.svelte'), 'utf8'));
mod('web/src/lib/modelHub.svelte.js', readFileSync(join(WEB, 'src', 'lib', 'modelHub.svelte.js'), 'utf8'));
put('web/src/lib/motion.js', readFileSync(join(WEB, 'src', 'lib', 'motion.js'), 'utf8'));
// —— 桩：子组件只把收到的参数印成属性 ——
comp(MH + 'BrandLogo.svelte', '<script>let { logo = "", name = "", size = 36 } = $props();</script><i class="logo" data-logo={logo} data-size={size}>{name}</i>');
comp(MH + 'AgentStack.svelte', '<script>let { agents = [], size = 16 } = $props();</script><i class="stack" data-agents={agents.join(",")} data-size={size}></i>');
put(MH + 'kindIcons.js', 'export const KIND_ICON = { text: "", image: "", video: "", voice: "", music: "" };');
comp('web/src/desktop/kit/DSwitch.svelte', '<script>let { checked = false } = $props();</script><i class="dsw" data-on={checked}></i>');
comp('web/src/components/ios27/Toggle.svelte', '<script>let { checked = false, label = "" } = $props();</script><i class="tgl" data-on={checked} data-label={label}></i>');
comp('web/src/components/ios27/Sym.svelte', '<i class="sym"></i>');
// —— 桩：别的状态层（数据由测试经 globalThis 现配）——
put('web/src/lib/claudeProviders.svelte.js', `export const cp = globalThis.__cp;
export const loadProviders = async () => {}; export const updateProvider = async () => {};
export const canUseCustomApi = () => true; export const cpSummaryText = () => '';`);
put('web/src/lib/dimensioSettings.svelte.js', `export const ds = { rev: 0 }; export const loadDimensio = async () => {};
export const dimReady = () => globalThis.__dim.ready; export const keyVendors = () => globalThis.__dim.vendors;
export const canSetKey = () => true; export const openInDimensio = () => {}; export const customSummary = () => '';`);
put('web/src/lib/modelHubAdopt.js', 'export const adoptDimensioService = async () => null;');
put('web/src/lib/agentSettings.svelte.js', 'export const ags = { poolOk: false, accounts: [], usage: {} }; export const loadPool = async () => {}; export const loadUsage = async () => {};');
put('web/src/lib/settingsNav.svelte.js', 'export const openSettings = () => {}; export const openSettingsFromChat = () => true;');
put('web/src/lib/state.svelte.js', 'export const me = { get kind() { return globalThis.__me; } };');
put('web/src/lib/api.js', 'export const api = { get: async () => ({}), post: async () => ({}) };');
put('web/src/lib/dialogs.js', 'export const uiConfirm = async () => false; export const uiAlert = async () => {};');
// t() 照填占位；tr() 加个记号，看得出运行时文案确实走了 tr
put('web/src/lib/i18n.js', `export const t = (s, p) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? p[k] : m));
export const tr = (s) => 'tr:' + s;`);
put('src/model-knowledge/brands.mjs', 'export const providerOf = () => null; export const providerInfo = () => null; export const vendorInfo = () => null;');

globalThis.__me = 'admin';
globalThis.__cp = { ok: false, err: '', providers: [], shared: [], presets: [], canShare: true, member: false, maxProviders: 0 };
globalThis.__dim = { ready: false, vendors: [] };
const H = await import(pathToFileURL(join(dir, 'web', 'src', 'lib', 'modelHub.svelte.js')).href);
const Home = (await import(pathToFileURL(join(dir, MH + 'HubHome.svelte.js')).href)).default;

const EMPTY = { ok: true, v2: true, loading: false, err: '', studioErr: '', vertex: null, services: [], claude: [], dimensio: [], studio: [], plugins: [], builtins: null };
const setHub = (o) => Object.assign(H.hub, EMPTY, o);
// 去掉 svelte 的注释锚点与作用域类名，断言好写
const html = (shell = 'desk') => render(Home, { props: { shell } }).body
  .replace(/<!--.*?-->/g, '').replace(/ svelte-[a-z0-9]+/g, '');
const OLD = '服务器版本较旧，添加服务与改模型要先更新服务器';
const names = (h) => [...h.matchAll(/<span class="hh-name">([^<]*)<\/span>/g)].map((m) => m[1]);
const rowOf = (h, name) => {
  const rows = h.split('<div class="hh-row').slice(1).map((s) => '<div class="hh-row' + s);
  return rows.find((r) => r.includes(`<span class="hh-name">${name}</span>`)) || '';
};

const SVC = {
  id: 'h-1', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', enabled: true, authStyle: 'bearer',
  lines: [{ enabled: true, hasKey: true }], models: [{ id: 'a', kind: 'text', agents: ['claude'] }],
  counts: { text: 5, image: 2 }, agents: ['claude', 'dimensio', 'studio'],
};

test('v2：没有「服务器版本较旧」；域名单独包一层、后面跟数量；行尾 agent 图标 18', () => {
  setHub({ services: [SVC] });
  const h = html();
  assert.ok(!h.includes(OLD));
  const row = rowOf(h, 'OpenRouter');
  assert.match(row, /<span class="hh-subt"><span class="hh-host">openrouter\.ai · <\/span>文本 5 · 图像 2<\/span>/);
  assert.match(row, /<i class="stack" data-agents="claude,dimensio,studio" data-size="18">/);
  assert.match(row, /class="hh-hit"[^>]*aria-label="编辑 OpenRouter"/);
});

test('副行：没有数量可说时域名标 solo（窄处不藏，免得副行空掉）；Vertex 的说明不算域名', () => {
  setHub({
    services: [{ ...SVC, models: [], counts: {}, agents: [] }],
    vertex: { configured: true, enabled: true, agents: ['claude'], models: ['gemini-x', 'gemini-y'] },
  });
  const h = html();
  assert.match(rowOf(h, 'OpenRouter'), /<span class="hh-host solo">openrouter\.ai<\/span><\/span>/);
  const vx = rowOf(h, 'Vertex AI');
  assert.ok(!vx.includes('hh-host'), 'Google Cloud 是说明，不是域名');
  assert.match(vx, /<span class="hh-subt">Google Cloud · 文本 2<\/span>/);
});

test('老服务端（v1 的总览）：顶上一行状态；服务照常列出，不带 counts / kind 的按文本数', () => {
  setHub({
    v2: false, studio: null,
    services: [{ id: 'h-9', name: '老服务', baseUrl: 'https://api.example.com/v1', enabled: true, authStyle: 'bearer',
      lines: [{ enabled: true, hasKey: true }], models: [{ id: 'gpt-x' }, { id: 'gpt-y' }], agents: ['claude', 'dimensio'] }],
  });
  assert.equal(H.hubLegacy(), true);
  const h = html();
  assert.match(h, new RegExp(`<div class="hh-note hh-note-plain" role="status"><span class="hh-note-tx">${OLD}</span></div>`));
  const row = rowOf(h, '老服务');
  assert.match(row, /<span class="hh-host">api\.example\.com · <\/span>文本 2<\/span>/, 'v1 的模型没有 kind：按文本算，筛「文本」时这一行还在');
  assert.match(row, /<i class="dsw" data-on="true">/, '启停照常');
  assert.match(row, /class="hh-hit"/, '行还是可点的（点了弹同一句，不进服务浮层）');
  // 状态行在筛选条之上
  assert.ok(h.indexOf(OLD) < h.indexOf('class="hh-strip"'));
});

test('老服务端 + 一个服务都没有：空态上面也有那行状态', () => {
  setHub({ v2: false, studio: null });
  const h = html();
  assert.ok(h.includes(OLD));
  assert.ok(h.includes('hh-empty'));
});

test('studioErr：在 Studio 那几行的位置出一行报错（走 tr）+ 重试；排在 dimensio 之后、插件之前；不算空', () => {
  setHub({
    services: [SVC],
    dimensio: [{ id: 'd-1', name: '自建', protocol: 'openai', host: 'd.example.com', models: 2, shared: false, kinds: { text: 2 } }],
    studio: [], studioErr: '读不出 Media Studio 的服务',
    plugins: [{ id: 'k', name: '插件服务', plugin: '某插件', agents: ['claude'], models: 1 }],
  });
  const h = html();
  assert.deepEqual(names(h), ['OpenRouter', '自建', 'Media Studio', '插件服务']);
  const row = rowOf(h, 'Media Studio');
  assert.match(row, /<span class="hh-subt warn">tr:读不出 Media Studio 的服务<\/span>/);
  assert.match(row, /<button type="button" class="hh-go">重试<\/button>/);
  assert.ok(!row.includes('hh-hit'), '这一行不是服务，点不开');

  // 只有这一行时也不落到空态（空态会让人以为 Studio 里一个服务都没有）
  setHub({ studio: [], studioErr: '读不出 Media Studio 的服务' });
  const only = html();
  assert.ok(!only.includes('hh-empty'));
  assert.deepEqual(names(only), ['Media Studio']);

  // 读得出来就没有这一行；托管给模型中心的 Studio 服务不单列
  setHub({ services: [SVC], studio: [
    { id: 's-1', name: '托管的', managed: true, hubRef: 'h-1', enabled: true, kinds: { image: 1 }, models: 1 },
    { id: 's-2', name: '本机图像模型', dialect: 'local', enabled: true, shared: true, kinds: { image: 1 }, models: 1, adoptable: false },
  ] });
  assert.deepEqual(names(html()), ['OpenRouter', '本机图像模型']);
});

test('「改为共用」只出在能收编的行上；dimensio 的行带着协议（Gemini 接口的确认框措辞不同）', () => {
  setHub({
    claude: [{ id: 'p-1', name: 'C 专用', host: 'c.example.com', enabled: true, shown: true, hasKey: true, models: 2, kinds: { text: 2 } },
      { id: 'p-2', name: 'C 已隐藏', host: 'c2.example.com', enabled: true, shown: false, hasKey: true, models: 2, kinds: { text: 2 } }],
    dimensio: [{ id: 'd-1', name: 'D 自建', protocol: 'gemini', host: 'd.example.com', models: 1, kinds: { text: 1 } }],
    studio: [{ id: 's-1', name: 'S 可收编', host: 's.example.com', enabled: true, hasKey: true, kinds: { image: 2 }, models: 2, adoptable: true },
      { id: 's-2', name: 'S 本机', dialect: 'local', enabled: true, kinds: { image: 1 }, models: 1, adoptable: false }],
  });
  const h = html();
  const has = (name) => rowOf(h, name).includes('class="hh-adopt"');
  assert.equal(has('C 专用'), true);
  // 收编过的原件服务端已经不列了（迁移台账）；还列着的都没并进来，隐藏着的也一样交给模型中心
  assert.equal(has('C 已隐藏'), true);
  assert.equal(has('D 自建'), true);
  assert.equal(has('S 可收编'), true);
  assert.equal(has('S 本机'), false, '老服务端（总览里没有 builtins）的本机服务照旧走 Studio 自己的面板');
  assert.equal(H.adoptReach('dimensio', 'gemini'), 'origin');
});

test('统一入口：新服务端带 builtins 时 Studio 的 Vertex / 本机不单列成 Studio 服务——Vertex 的媒体模型记在 Vertex 那一行，本机是自己一行', () => {
  setHub({
    vertex: { enabled: true, configured: true, agents: ['claude'], models: ['gemini-x'] },
    studio: [{ id: 'p-v', name: 'Google Vertex AI', dialect: 'vertex', builtin: 'vertex', enabled: true, kinds: { image: 2 }, models: 2 },
      { id: 'p-l', name: '本机图像模型', dialect: 'local', builtin: 'local', enabled: true, kinds: { image: 1 }, models: 1 }],
    builtins: [
      { id: 'p-v', name: 'Google Vertex AI', dialect: 'vertex', enabled: true, shared: false, models: [{ id: 'imagen', kind: 'image', enabled: true }, { id: 'veo', kind: 'video', enabled: false }] },
      { id: 'p-l', name: '本机图像模型', dialect: 'local', enabled: true, shared: false, models: [{ id: 'qwen', kind: 'image', enabled: true }] },
    ],
  });
  const h = html();
  assert.deepEqual(names(h), ['Vertex AI', '本机图像模型']);
  const vx = rowOf(h, 'Vertex AI');
  assert.ok(vx.includes('文本 1') && vx.includes('图像 1') && !vx.includes('视频'), '只数打开的媒体模型');
  assert.ok(!rowOf(h, '本机图像模型').includes('class="hh-adopt"'));
});

test('两套外壳：desk 用 DSwitch，ios 用 Toggle（带读屏名字）', () => {
  setHub({ services: [SVC] });
  const d = html('desk');
  assert.match(d, /<div class="hh desk">/);
  assert.ok(d.includes('class="dsw"') && !d.includes('class="tgl"'));
  const i = html('ios');
  assert.match(i, /<div class="hh ios">/);
  assert.match(i, /<i class="tgl" data-on="true" data-label="启用 OpenRouter">/);
  assert.ok(!i.includes('class="dsw"'));
});

test('成员（没有总览、有自己的 Claude 服务）：不出「服务器版本较旧」，自己的服务行同样把域名包一层', () => {
  setHub({ ok: false, v2: false });
  globalThis.__me = 'user';
  Object.assign(globalThis.__cp, { ok: true, providers: [{ id: 'p-1', name: '我的', baseUrl: 'https://api.mine.com/v1', enabled: true, hasKey: true,
    models: [{ id: 'm', enabled: true, kind: 'chat' }] }] });
  try {
    const h = html('ios');
    assert.ok(!h.includes(OLD));
    assert.match(rowOf(h, '我的'), /<span class="hh-host">api\.mine\.com · <\/span>文本 1<\/span>/);
    assert.ok(h.includes('我的服务'));
  } finally {
    globalThis.__me = 'admin';
    Object.assign(globalThis.__cp, { ok: false, providers: [] });
  }
});
