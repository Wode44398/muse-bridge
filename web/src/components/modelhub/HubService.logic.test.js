// 服务浮层两个组件的状态机——跑的是组件里真的那段 <script>：
//   HubService.svelte：识别 / 保存互斥、去向片与保存、连接改动后的识别、置顶
//   HsConn.svelte：    「重新识别」先存连接改动、保存连接时报出识别要用的那一段变没变、共享给成员、Key 框的粘贴 / 输入清洗
// 做法同 lib/dialogs.test.js：把 <script> 原样抠出来包成一个工厂函数，用 svelte 编译器编成客户端模块；
// 子组件、总览状态、接口、对话框换成桩，HsKit / brands / motion / i18n 用真的。不画界面、不起浏览器、不碰数据根。
// 跑法：node --test web/src/components/modelhub/HubService.logic.test.js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', '..');
const require = createRequire(join(webRoot, 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const href = (...p) => pathToFileURL(join(...p)).href;

// —— 假环境（要在加载模块之前就位）——
const HS = { ask: null, post: null, get: null, loadHub: async () => {}, confirm: async () => true, toasts: [], cpLoads: 0 };
globalThis.__hs = HS;
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),   // 宽屏
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = { activeElement: null, body: {} };

const dir = mkdtempSync(join(tmpdir(), 'hubservice-test-'));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });   // 跑完把编出来的临时模块收走
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(join(dir, 'comp.js'), 'export default {};');
writeFileSync(join(dir, 'misc.js'), [
  'export const pushBackLayer = () => () => {};',
  'export const uiConfirm = (...a) => globalThis.__hs.confirm(...a);',
  'export const activeRequest = () => null;',
  'export const showToast = (...a) => { globalThis.__hs.toasts.push(a); };',
].join('\n'));

const SV = {
  'svelte': href(svelteRoot, 'src', 'index-client.js'),
  'svelte/transition': href(svelteRoot, 'src', 'transition', 'index.js'),
  'svelte/reactivity': href(svelteRoot, 'src', 'reactivity', 'index-client.js'),
  'svelte/internal/client': href(svelteRoot, 'src', 'internal', 'client', 'index.js'),
  'svelte/internal/disclose-version': href(svelteRoot, 'src', 'internal', 'disclose-version.js'),
  'svelte/internal/flags/legacy': href(svelteRoot, 'src', 'internal', 'flags', 'legacy.js'),
};
const MAP = {
  ...SV,
  './HsKit.js': href(here, 'HsKit.js'),
  '../../lib/modelHub.svelte.js': href(dir, 'hub.svelte.js'),
  '../../lib/claudeProviders.svelte.js': href(dir, 'cp.svelte.js'),
  '../../../../src/model-knowledge/brands.mjs': href(webRoot, '..', 'src', 'model-knowledge', 'brands.mjs'),
  '../../lib/nav.js': href(dir, 'misc.js'),
  '../../lib/dialogs.js': href(dir, 'misc.js'),
  '../../lib/dialogState.svelte.js': href(dir, 'misc.js'),
  '../../lib/toast.svelte.js': href(dir, 'misc.js'),
  '../../lib/motion.js': href(webRoot, 'src', 'lib', 'motion.js'),
  '../../lib/i18n.js': href(webRoot, 'src', 'lib', 'i18n.js'),
};
const fixImports = (code) => code.replace(/from\s+['"]([^'"]+)['"]/g, (m, s) => {
  if (MAP[s]) return `from '${MAP[s]}'`;
  if (s.endsWith('.svelte')) return `from '${href(dir, 'comp.js')}'`;
  if (/^file:/.test(s)) return m;
  throw new Error('组件多了一个没登记的 import：' + s + '（在本测试的 MAP 里补上真文件或桩）');
});

const { compileModule } = await import(href(svelteRoot, 'src', 'compiler', 'index.js'));
const build = (name, code) => {
  writeFileSync(join(dir, name), fixImports(compileModule(code, { filename: name, generate: 'client' }).js.code));
  return import(href(dir, name));
};

// 总览状态与接口的桩：hub 是真的 $state（组件里的派生要跟着它变），接口转给测试里的 HS
const Hub = await build('hub.svelte.js', `
  export const hub = $state({ ok: true, loading: false, err: '', vertex: null, services: [], claude: [], dimensio: [], studio: [], plugins: [] });
  export const KINDS = ['text', 'image', 'video', 'voice', 'music'];
  export const KIND_NAME = { text: '文本', image: '图像', video: '视频', voice: '配音', music: '音乐' };
  export const AGENT_NAME = { claude: 'Claude', dimensio: 'dimensio', studio: 'Media Studio' };
  export const PROTO_NAME = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };
  export const hubPost = (p, b) => globalThis.__hs.post(p, b);
  export const hubAsk = (p, b) => globalThis.__hs.ask(p, b);
  export const hubGet = (p) => globalThis.__hs.get(p);
  export const loadHub = (f) => globalThis.__hs.loadHub(f);
  export const lineNote = () => '';
`);
// Claude 服务的配置（只用到 canShare：多用户服务器的管理员才有「共享给成员」）
const Cp = await build('cp.svelte.js', `
  export const cp = $state({ ok: true, canShare: false });
  export const loadProviders = () => { globalThis.__hs.cpLoads++; return Promise.resolve(); };
  export const canUseCustomApi = () => true;
`);

// 组件的 <script> → 工厂函数：import 提到模块顶上，其余原样放进函数体；$props 的解构换成一个个 $state（初值取自 P，测试里能改）；
// export 的函数去掉 export；末尾把要看 / 要调的（look）和要改的（poke，经 api.$set.<名字>(值)）交出来
function componentModule(file, look, poke) {
  const src = readFileSync(join(here, file), 'utf8').replace(/\r\n/g, '\n');
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(src)?.[1];
  assert.ok(script, file + ' 里没找到 <script>');
  const PROPS = /let \{([\s\S]*?)\} = \$props\(\);/;
  assert.ok(PROPS.test(script), file + ' 的 $props 写法变了，同步改这里的替换');
  const IMPORT = /^\s*import .*;$/gm;
  const imports = script.match(IMPORT) || [];
  const body = script.replace(IMPORT, '')
    .replace(PROPS, (m, inner) => inner.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const i = x.indexOf('=');
      const name = (i < 0 ? x : x.slice(0, i)).trim();
      const def = (i < 0 ? '' : x.slice(i + 1).trim().replace(/^\$bindable\((.*)\)$/, '$1')) || 'undefined';
      return `let ${name} = $state(P.${name} === undefined ? ${def} : P.${name});`;
    }).join('\n'))
    .replace(/^(\s*)export (async function|function)/gm, '$1$2');
  return `
${imports.join('\n')}
function make(P) {
${body}
  return {
    ${look.map((n) => `get ${n}() { return ${n}; }`).join(', ')},
    $set: { ${poke.map((n) => `${n}(v) { ${n} = v; }`).join(', ')} },
  };
}
export function mount(P) {
  let api;
  const stop = $effect.root(() => { api = make(P); });
  return { api, stop };
}`;
}
const M = await build('hs.svelte.js', componentModule('HubService.svelte', [
  'sid', 'svc', 'phase', 'kind', 'd', 'cat', 'rows', 'rowsKind', 'pinN', 'picked', 'detecting', 'saving', 'stale',
  'dests', 'changes', 'canSave', 'barNote', 'connOpen', 'connMoved', 'notes', 'listErr', 'listRetry', 'detErr', 'saveErr',
  'detect', 'redetectAny', 'save', 'onConnSaved', 'pick', 'toggleDest', 'pickKind', 'onAll',
], ['connRef', 'sheet']));
const Conn = await build('conn.svelte.js', componentModule('HsConn.svelte', [
  'ed', 'edDirty', 'dirty', 'err', 'busy', 'save', 'redetect', 'revert', 'onKeyPaste', 'onKeyInput',
], ['svc', 'mode', 'locked', 'detecting']));
const { flushSync, tick } = await import(SV.svelte);
const settle = async () => { flushSync(); await tick(); await new Promise((r) => setImmediate(r)); flushSync(); };
const defer = () => { let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); return { promise, res, rej }; };

// —— 数据 ——
const A = { id: 'openai/gpt-5', label: 'OpenAI: GPT-5', kind: 'text', vendor: 'openai', contextWindow: 400000, source: 'api' };
const B = { id: '~anthropic/claude-sonnet-latest', label: '', kind: 'text', vendor: 'anthropic', source: 'api' };   // Claude 不认 ~
const C = { id: 'openai/gpt-3.5-turbo-instruct', label: '', kind: 'text', vendor: 'openai', contextWindow: 4095, source: 'api' };
const E = { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', kind: 'text', vendor: 'deepseek', contextWindow: 131072, source: 'api' };
const DET = (models) => ({ conn: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer', name: 'OpenRouter', brand: null }, models, media: null, warnings: [] });
const SID = 'h-0000abcd';
const service = (models = [], over = {}) => ({
  id: SID, name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', brand: null,
  enabled: true, members: false, useProxy: true, strategy: 'failover',
  lines: [{ id: 'l1', label: 'Key 1', baseUrl: '', enabled: true, hasKey: true, keyTail: '…5678', state: null }],
  models, counts: {}, agents: [], detectedAt: Date.now(), catalogSize: 0, media: null, published: true, ...over,
});

function fresh() {
  HS.toasts.length = 0;
  HS.loadHub = async () => {};
  HS.confirm = async () => true;
  Hub.hub.services = [];
  Hub.hub.dimensio = [];
  Hub.hub.studio = [];
  const calls = [];
  return calls;
}
async function openDraft(calls, models) {
  HS.ask = async (p, b) => { calls.push(['ask', p, b]); if (p === 'detect') return DET(models); throw new Error('unexpected ' + p); };
  const m = M.mount({ sheet: { type: 'service', add: true }, onClose() {} });
  m.api.d.url = 'https://openrouter.ai/api/v1';
  m.api.d.key = 'sk-test-12345678';
  await m.api.detect();
  await settle();
  return m;
}
async function openService(calls, svcModels, catalog) {
  Hub.hub.services = [service(svcModels)];
  HS.get = async (p) => { calls.push(['get', p]); return { at: 1, models: catalog }; };
  HS.ask = async (p, b) => { calls.push(['ask', p, b]); if (p === 'detect') return DET(catalog); throw new Error('unexpected ' + p); };
  HS.post = async (p, b) => { calls.push(['post', p, b]); throw new Error('unexpected ' + p); };
  const m = M.mount({ sheet: { type: 'service', id: SID }, onClose() {} });
  await settle();
  return m;
}
const asks = (calls, p) => calls.filter((c) => c[0] === 'ask' && c[1] === p);

test('草稿：识别 → 勾模型 → 点亮去向 → 保存，就地变成服务', async () => {
  const calls = fresh();
  const { api, stop } = await openDraft(calls, [A, E]);
  try {
    assert.equal(api.phase, 'models');
    assert.equal(api.rows.length, 2);
    assert.equal(api.canSave, false, '没勾没点：不能保存');
    api.pick([A.id, E.id], true);
    assert.deepEqual(api.dests.map((x) => [x.id, x.on, x.disabled]), [['claude', false, false], ['dimensio', false, false]]);
    api.toggleDest('claude'); api.toggleDest('dimensio');
    assert.equal(api.canSave, true);
    assert.equal(api.barNote, '');
    HS.post = async (p, b) => {
      calls.push(['post', p, b]);
      const svc = service(b.assign.map((x) => ({ ...x, kind: 'text' })));
      Hub.hub.services = [svc];   // hubPost 成功后会重拉总览
      return { service: svc };
    };
    await api.save();
    await settle();
    const [, p, body] = calls.find((c) => c[0] === 'post');
    assert.equal(p, 'create');
    assert.equal(body.key, 'sk-test-12345678');
    assert.equal(body.catalog.length, 2);
    assert.deepEqual(body.assign, [{ id: A.id, agents: ['claude', 'dimensio'] }, { id: E.id, agents: ['claude', 'dimensio'] }]);
    assert.equal(api.sid, SID);
    assert.equal(api.picked.size, 0, '保存后清掉勾选');
    assert.deepEqual(api.rows.map((r) => r.agents), [['claude', 'dimensio'], ['claude', 'dimensio']]);
  } finally { stop(); }
});

test('点亮 Claude 之后勾进来一个 Claude 不收的模型：跳过它、操作条写明、照样能保存；两种勾选顺序结果一样', async () => {
  const calls = fresh();
  const { api, stop } = await openDraft(calls, [A, B, C]);
  try {
    // 顺序一：先 A、点亮 Claude、再 B
    api.pick([A.id], true);
    api.toggleDest('claude');
    api.pick([B.id], true);
    const one = { dests: api.dests.map((x) => [x.id, x.on, x.disabled]), changes: api.changes, note: api.barNote, canSave: api.canSave };
    assert.deepEqual(one.dests, [['claude', true, false], ['dimensio', false, false]]);
    assert.deepEqual(one.changes, [{ id: A.id, agents: ['claude'] }], 'B 不进 Claude，A 不受连累');
    assert.match(one.note, /其中 1 个不添加到 Claude/);
    assert.equal(one.canSave, true);
    // 顺序二：先 B、再 A、点亮 Claude
    api.pick([A.id, B.id], false);
    // 界面上每一步之后都会重画（读一遍去向片）：勾选清空，点亮的片跟着归零。测试里没有模板，手动读一次
    assert.equal(api.dests.some((x) => x.on), false);
    api.pick([B.id], true);
    let claude = api.dests[0];
    assert.equal(claude.disabled, true, '只勾了 Claude 不收的：片点不亮');
    assert.ok(claude.title && api.barNote === claude.title, '原因写在操作条上（不只是 title）');
    assert.equal(api.canSave, false);
    api.pick([A.id], true);
    claude = api.dests[0];
    assert.equal(claude.disabled, false, '有一行能加：片能点');
    api.toggleDest('claude');
    assert.deepEqual({ dests: api.dests.map((x) => [x.id, x.on, x.disabled]), changes: api.changes, note: api.barNote, canSave: api.canSave }, one);
    // 全选（Ctrl+A 同一条路）：三个里两个不收，只有 A 进 Claude
    api.onAll();
    assert.equal(api.picked.size, 3);
    assert.deepEqual(api.changes, [{ id: A.id, agents: ['claude'] }]);
    assert.match(api.barNote, /其中 2 个不添加到 Claude/);
    // 两个去向都点亮：不收的只进 dimensio
    api.toggleDest('dimensio');
    assert.deepEqual(api.changes, [
      { id: A.id, agents: ['claude', 'dimensio'] }, { id: B.id, agents: ['dimensio'] }, { id: C.id, agents: ['dimensio'] },
    ]);
  } finally { stop(); }
});

test('上下文窗口不到 4096 的文本模型不能给 Claude（与模型 ID 规则同一处理）', async () => {
  const calls = fresh();
  const { api, stop } = await openDraft(calls, [A, C]);
  try {
    api.pick([C.id], true);
    const claude = api.dests[0];
    assert.equal(claude.disabled, true);
    assert.match(claude.title, /4096/);
    assert.equal(api.barNote, claude.title);
    assert.equal(api.dests[1].disabled, false, 'dimensio 照样能加');
  } finally { stop(); }
  // dimensio 没开时这一行根本勾不了（没有任何去向可加）
  const calls2 = fresh();
  Hub.hub.dimensio = null;
  HS.ask = async (p) => { calls2.push(['ask', p]); return DET([A, C]); };
  const m = M.mount({ sheet: { type: 'service', add: true }, onClose() {} });
  try {
    m.api.d.url = 'https://openrouter.ai/api/v1'; m.api.d.key = 'sk-test-12345678';
    await m.api.detect(); await settle();
    const r = m.api.rows.find((x) => x.id === C.id);
    assert.equal(r.can, false);
    assert.match(r.why, /4096/);
    assert.equal(m.api.rows.find((x) => x.id === A.id).can, true);
  } finally { m.stop(); }
});

test('识别进行中不能保存；保存进行中不能识别', async () => {
  const calls = fresh();
  const { api, stop } = await openDraft(calls, [A, E]);
  try {
    api.pick([A.id], true);
    api.toggleDest('claude');
    assert.equal(api.canSave, true);
    // 重新识别（挂着不回）
    const det = defer();
    HS.ask = (p, b) => { calls.push(['ask', p, b]); return det.promise; };
    HS.post = async (p, b) => { calls.push(['post', p, b]); return {}; };
    const dp = api.detect();
    assert.equal(api.detecting, true);
    assert.equal(api.canSave, false, '识别中：保存点不了');
    await api.save();
    assert.equal(calls.filter((c) => c[0] === 'post').length, 0, '识别中调 save 也不发请求');
    det.res(DET([A, E]));
    await dp; await settle();
    assert.equal(api.detecting, false);
    assert.equal(api.canSave, true);
    // 保存（挂着不回）
    const sv = defer();
    HS.post = (p, b) => { calls.push(['post', p, b]); return sv.promise; };
    const before = asks(calls, 'detect').length;
    const sp = api.save();
    assert.equal(api.saving, true);
    await api.detect();
    await api.redetectAny();
    assert.equal(asks(calls, 'detect').length, before, '保存中：不发识别');
    const svc = service([{ id: A.id, kind: 'text', agents: ['claude'] }]);
    Hub.hub.services = [svc];
    sv.res({ service: svc });
    await sp; await settle();
    assert.equal(api.sid, SID);
    assert.equal(api.saving, false);
  } finally { stop(); }
});

test('已有服务：列表头 / 错误条的「重新识别」经连接面板走（先存连接改动），没有面板时直接识别', async () => {
  const calls = fresh();
  const { api, stop } = await openService(calls, [{ id: A.id, kind: 'text', agents: ['claude'], vendor: 'openai' }], [A, E]);
  try {
    assert.equal(api.svc?.id, SID);
    assert.equal(api.rows.length, 2);
    assert.equal(asks(calls, 'detect').length, 0, '识别过的服务打开时不自动识别');
    // 没有连接面板的引用：直接识别
    await api.redetectAny(); await settle();
    assert.equal(asks(calls, 'detect').length, 1);
    assert.deepEqual(asks(calls, 'detect')[0][2], { id: SID });
    // 有连接面板：交给它的 redetect（它会先存再调 ondetect），这里不直接发识别
    // （计数放在闭包里：connRef 是 $state，普通对象赋进去会被包成代理，写 this 上的字段改不到这个对象）
    let n = 0, ok = true;
    const conn = { redetect: async () => { n++; return ok; } };
    api.$set.connRef(conn);
    await api.redetectAny(); await settle();
    assert.equal(n, 1);
    assert.equal(asks(calls, 'detect').length, 1, '不绕过连接面板直接识别');
    assert.equal(api.connOpen, false);
    // 连接改动没存上：展开面板让人看见原因
    ok = false;
    await api.redetectAny(); await settle();
    assert.equal(n, 2);
    assert.equal(api.connOpen, true);
    // 识别失败后错误条的「重试」也是同一条路
    api.$set.connRef(null);
    HS.ask = async (p, b) => { calls.push(['ask', p, b]); throw new Error('Key 无效'); };
    await api.detect(); await settle();
    assert.equal(api.listErr, 'Key 无效');
    ok = true; n = 0;
    api.$set.connRef(conn);
    await api.listRetry(); await settle();
    assert.equal(n, 1, '重试走连接面板的 redetect');
  } finally { stop(); }
});

test('已有服务保存连接：地址变了自动重新识别；只换了 Key 提示建议重新识别，识别成功后消掉', async () => {
  const calls = fresh();
  const { api, stop } = await openService(calls, [{ id: A.id, kind: 'text', agents: ['claude'], vendor: 'openai' }], [A, E]);
  try {
    // 没动识别要用的那一段（改名、启停…）：不识别、不提示
    api.onConnSaved(service([{ id: A.id, kind: 'text', agents: ['claude'] }], { name: '改名' }), [], { moved: '' });
    await settle();
    assert.equal(asks(calls, 'detect').length, 0);
    assert.equal(api.connMoved, false);
    assert.equal(HS.toasts.length, 1, '弹「已保存」');
    // quiet（解除冷却）：不弹
    api.onConnSaved(null, [], { quiet: true });
    assert.equal(HS.toasts.length, 1);
    // 只换了 Key
    api.onConnSaved(null, [], { moved: 'key' });
    await settle();
    assert.equal(asks(calls, 'detect').length, 0, '不自动识别');
    assert.equal(api.connMoved, true);
    await api.detect(); await settle();
    assert.equal(asks(calls, 'detect').length, 1);
    assert.equal(api.connMoved, false, '识别成功后提示消掉');
    // 地址变了：直接识别，目录换成新上游的
    HS.ask = async (p, b) => { calls.push(['ask', p, b]); return DET([E]); };
    api.onConnSaved(null, [], { moved: 'url' });
    assert.equal(api.detecting, true);
    await settle();
    assert.equal(asks(calls, 'detect').length, 2);
    assert.equal(api.connMoved, false);
    assert.deepEqual(api.cat.map((m) => m.id), [E.id]);
    assert.deepEqual(api.rows.map((r) => r.id), [A.id, E.id], '已添加的 A 新目录里没有：照样列着（能取消）');
  } finally { stop(); }
});

test('识别途中保存了连接：在途的那次（旧连接）作废，按新连接重来', async () => {
  const calls = fresh();
  const { api, stop } = await openService(calls, [], [A, E]);
  try {
    const d1 = defer(), d2 = defer();
    const queue = [d1, d2];
    HS.ask = (p, b) => { calls.push(['ask', p, b]); return queue.shift().promise; };
    const p1 = api.detect();
    assert.equal(api.detecting, true);
    api.onConnSaved(null, [], { moved: 'key' });
    assert.equal(asks(calls, 'detect').length, 2, '重发了一次');
    assert.equal(api.detecting, true);
    d2.res(DET([E]));
    await settle();
    assert.deepEqual(api.cat.map((m) => m.id), [E.id]);
    assert.equal(api.detecting, false);
    // 旧的那次晚到：不作数
    d1.res(DET([A, B, C]));
    await p1; await settle();
    assert.deepEqual(api.cat.map((m) => m.id), [E.id]);
    assert.equal(api.detecting, false);
  } finally { stop(); }
});

test('已添加的置顶：打开时拍快照，保存后不重排，换栏回来再排', async () => {
  const calls = fresh();
  const added = [{ id: E.id, kind: 'text', agents: ['claude'], vendor: 'deepseek' }];
  const { api, stop } = await openService(calls, added, [A, B, E]);
  try {
    assert.deepEqual(api.rowsKind.map((r) => r.id), [E.id, A.id, B.id], '已添加的 E 排到最前');
    assert.equal(api.pinN, 1);
    // 再添加排在最后的 B：保存后顺序不变（行不跳）
    api.pick([B.id], true);
    api.toggleDest('dimensio');
    HS.post = async (p, b) => {
      calls.push(['post', p, b]);
      const svc = service([...added, { id: B.id, kind: 'text', agents: ['dimensio'], vendor: 'anthropic' }]);
      Hub.hub.services = [svc];
      return { service: svc };
    };
    await api.save(); await settle();
    const [, p, body] = calls.find((c) => c[0] === 'post');
    assert.equal(p, 'assign');
    assert.deepEqual(body, { id: SID, changes: [{ id: B.id, agents: ['dimensio'] }] });
    assert.deepEqual(api.rowsKind.map((r) => r.id), [E.id, A.id, B.id]);
    assert.equal(api.pinN, 1);
    assert.deepEqual(api.rowsKind.find((r) => r.id === B.id).agents, ['dimensio']);
    // 换到别的栏再回来：重拍快照，B 也排到前面（置顶段内按目录原序）
    api.pickKind('image');
    api.pickKind('text');
    assert.deepEqual(api.rowsKind.map((r) => r.id), [B.id, E.id, A.id]);
    assert.equal(api.pinN, 2);
    // 重新识别成功也重拍
    Hub.hub.services = [service(added)];
    await api.detect(); await settle();
    assert.deepEqual(api.rowsKind.map((r) => r.id), [E.id, A.id, B.id]);
    assert.equal(api.pinN, 1);
  } finally { stop(); }
});

// ———————————————————— HsConn（连接面板） ————————————————————

// 已有服务的连接面板：接口记在 calls 里（顺序就是发生的先后）
async function openConn(calls, over = {}) {
  Cp.cp.canShare = false;
  HS.post = async (p, b) => {
    calls.push(['post', p, b]);
    return { service: service([], { name: b.patch.name, baseUrl: b.patch.baseUrl, members: b.patch.members === true }) };
  };
  const m = Conn.mount({
    mode: 'service', svc: service(), d: null,
    ondetect: () => { calls.push(['detect']); },
    onsaved: (svc, warnings, opts) => { calls.push(['saved', opts]); },
    ...over,
  });
  await settle();   // 编辑态 ed 由 effect 从 svc 填出来
  return m;
}
const kinds = (calls) => calls.map((c) => c[0]);
// 假的 Key 输入框与事件
const keyBox = (value, start = value.length, end = start) => ({
  value, selectionStart: start, selectionEnd: end, caret: -1,
  setSelectionRange(a) { this.caret = a; },
});
const pasteEv = (el, text) => ({ currentTarget: el, prevented: false, clipboardData: { getData: () => text }, preventDefault() { this.prevented = true; } });

test('连接面板「重新识别」：没改动直接识别；有改动先存上再识别；没存上就不识别', async () => {
  const calls = fresh();
  const { api, stop } = await openConn(calls);
  try {
    assert.equal(api.ed.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(api.edDirty, false);
    assert.equal(await api.redetect(), true);
    assert.deepEqual(kinds(calls), ['detect'], '没改动：不存，直接识别');
    // 改了地址没点保存
    calls.length = 0;
    api.ed.baseUrl = 'https://api.deepseek.com/v1';
    await settle();
    assert.equal(api.edDirty, true);
    assert.equal(api.dirty, true, '报给外面（关闭前要问一句）');
    assert.equal(await api.redetect(), true);
    assert.deepEqual(kinds(calls), ['post', 'saved', 'detect'], '先存、再识别');
    assert.equal(calls[0][1], 'update');
    assert.equal(calls[0][2].id, SID);
    assert.equal(calls[0][2].patch.baseUrl, 'https://api.deepseek.com/v1');
    assert.deepEqual(calls[1][1], { moved: 'url' }, '告诉外面：地址变了');
    // 存不上：报错留在面板里，不去识别
    calls.length = 0;
    HS.post = async (p, b) => { calls.push(['post', p, b]); throw new Error('Key 无效'); };
    api.ed.name = '换个名字';
    await settle();
    assert.equal(await api.redetect(), false);
    assert.deepEqual(kinds(calls), ['post']);
    assert.equal(api.err, 'Key 无效');
    // 名字清空：本地校验就拦下，连请求都不发
    calls.length = 0;
    api.ed.name = '  ';
    assert.equal(await api.redetect(), false);
    assert.deepEqual(kinds(calls), []);
    assert.ok(api.err);
  } finally { stop(); }
});

test('连接面板：外面正在保存模型去向（locked）时不识别也不存', async () => {
  const calls = fresh();
  const { api, stop } = await openConn(calls, { locked: true });
  try {
    api.ed.baseUrl = 'https://api.deepseek.com/v1';
    await settle();
    assert.equal(await api.redetect(), true);
    assert.deepEqual(kinds(calls), []);
    api.$set.locked(false);
    assert.equal(await api.redetect(), true);
    assert.deepEqual(kinds(calls), ['post', 'saved', 'detect']);
  } finally { stop(); }
});

test('Key 框：粘贴带换行 / 空白的 Key——框里显示的和状态里存的是同一串，保存提交的也是它', async () => {
  const calls = fresh();
  const { api, stop } = await openConn(calls);
  try {
    const line = api.ed.lines[0];
    const set = (v) => { line.key = v; };
    // 从折行的文档里复制：中间夹着换行，首尾有空白
    const el = keyBox('');
    const ev = pasteEv(el, '  sk-ant-api03-AAAA\r\nBBBB\t \n');
    api.onKeyPaste(ev, set);
    assert.equal(ev.prevented, true);
    assert.equal(el.value, 'sk-ant-api03-AAAABBBB');
    assert.equal(line.key, el.value, '状态 = 显示');
    assert.equal(el.caret, el.value.length);
    // 选中一段再粘贴
    const el2 = keyBox('sk-OLD-tail', 3, 6);
    api.onKeyPaste(pasteEv(el2, ' NEW\n'), set);
    assert.equal(el2.value, 'sk-NEW-tail');
    assert.equal(line.key, 'sk-NEW-tail');
    assert.equal(el2.caret, 6);
    // 打字 / 输入法联想带进来的空白
    const el3 = keyBox('sk- ab\tc', 4);
    api.onKeyInput({ currentTarget: el3, isComposing: false }, set);
    assert.equal(el3.value, 'sk-abc');
    assert.equal(line.key, 'sk-abc');
    assert.equal(el3.caret, 3);
    // 输入法组字中途不动框里的字（状态照实跟着）
    const el4 = keyBox('sk- x');
    api.onKeyInput({ currentTarget: el4, isComposing: true }, set);
    assert.equal(el4.value, 'sk- x');
    assert.equal(line.key, 'sk- x');
    // 换了 Key 保存：提交的是清洗过的那串；告诉外面 Key 换了
    api.onKeyPaste(pasteEv(keyBox(''), 'sk-new\nkey-12345678'), set);
    await settle();
    assert.equal(api.edDirty, true);
    assert.equal(await api.save(), true);
    assert.equal(calls[0][2].patch.lines[0].key, 'sk-newkey-12345678');
    assert.deepEqual(calls[1][1], { moved: 'key' });
    assert.equal(api.ed.lines[0].key, '', '存完编辑态收回');
  } finally { stop(); }
});

test('共享给成员：写 members；只有多用户服务器的管理员（cp.canShare）才参与', async () => {
  const calls = fresh();
  const { api, stop } = await openConn(calls);
  try {
    assert.equal(api.ed.members, false);
    // 不是多用户服务器的管理员：没有开关，字段不算改动、也不提交
    api.ed.members = true;
    await settle();
    assert.equal(api.edDirty, false);
    api.ed.name = 'OpenRouter 2';
    await settle();
    assert.equal(await api.save(), true);
    assert.equal('members' in calls[0][2].patch, false);
    assert.deepEqual(calls[1][1], { moved: '' }, '改名不算动了连接');
    // 多用户服务器的管理员：拨开关 = 有改动，保存带上 members
    calls.length = 0;
    Cp.cp.canShare = true;
    api.$set.svc(service([], { name: 'OpenRouter 2' }));
    await settle();
    assert.equal(api.ed.members, false, '没改动时编辑态跟着服务走');
    assert.equal(api.edDirty, false);
    api.ed.members = true;
    await settle();
    assert.equal(api.edDirty, true);
    assert.equal(await api.save(), true);
    assert.equal(calls[0][2].patch.members, true);
    assert.equal(api.ed.members, true);
  } finally { stop(); Cp.cp.canShare = false; }
});
