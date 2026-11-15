// 子 agent 调用策略的前端状态层（lib/dispatchPolicy.svelte.js）里和「应答先后 / 失败回滚」有关的逻辑：
//   · setBasis：新口径的落点没读出来 → 换回原来的口径并抛；能重试；刚失败过的那一小会儿里不再发请求（防响应式调用方打转）
//   · 图谱操作（导入 / 获取 / 清除）的应答比它之后发起的请求晚到 → 预览被判成旧的没收，要当场补拉
//   · 全图点表不进深层代理
// 做法同 modelHub.test.js：用 svelte 编译器把真的 dispatchPolicy.svelte.js 编成客户端模块，依赖换成桩。不起浏览器、不碰任何数据根。
//   node --test web/src/lib/dispatchPolicy.test.js
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
const dir = mkdtempSync(join(tmpdir(), 'dispatch-policy-test-'));
mkdirSync(join(dir, 'lib'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
const js = compileModule(readFileSync(join(here, 'dispatchPolicy.svelte.js'), 'utf8'), { filename: 'dispatchPolicy.svelte.js', generate: 'client' }).js.code;
writeFileSync(join(dir, 'lib', 'dispatchPolicy.svelte.js'), fixImports(js));
// 桩：api 的应答 / 报错由测试现配（globalThis.__dpApi）；总线的监听收在 handlers 里
writeFileSync(join(dir, 'lib', 'api.js'), `export const calls = [];
export const api = {
  get(u) { calls.push(['GET', u]); return globalThis.__dpApi.get(u); },
  post(u, b) { calls.push(['POST', u, b]); return globalThis.__dpApi.post(u, b); },
};`);
writeFileSync(join(dir, 'lib', 'bus.js'), 'export const handlers = []; export const busOn = (fn) => { handlers.push(fn); };');
writeFileSync(join(dir, 'lib', 'state.svelte.js'), 'export const caps = { data: null };');
writeFileSync(join(dir, 'lib', 'caps.js'), 'export const splitClaudeModels = () => ({ primary: [] });');
writeFileSync(join(dir, 'lib', 'i18n.js'), 'export const t = (s) => s; export const tc = (c, s) => s;');
writeFileSync(join(dir, 'lib', 'claudeProviders.svelte.js'),
  'export const agentModelName = (s) => s; export const agentEffortName = (s) => s; export const isCustomModel = (s) => /^custom:/.test(s); export const customModelInfo = () => null;');

const D = await import(pathToFileURL(join(dir, 'lib', 'dispatchPolicy.svelte.js')).href);
const { calls } = await import(pathToFileURL(join(dir, 'lib', 'api.js')).href);
const { dp } = D;

const BUILTIN = { source: 'builtin', generated: '2026-11-07', hasPlanPoints: false };
const IMPORTED = { source: 'imported', generated: '2026-11-10', at: 1, from: 'file', points: 2426, hasPlanPoints: true };
const policy = (rev, more = {}) => ({
  v: 1, enabled: true, scope: { workflow: true, subagent: true, session: false }, allowThirdParty: true, activeId: 's-1',
  strategies: [{ id: 's-1', name: '默认', floors: {}, overrides: {}, note: '' }], rev, ...more,
});
const preview = (basis, chart = BUILTIN) => ({ basis, tiers: [], candidates: [{ model: basis === 'custom' ? 'custom:a:b' : 'opus', effort: 'max', ii: 50, cost: 1 }], unrated: [], poolPlans: ['max20'], chart });
const httpErr = (status, error) => Object.assign(new Error('http ' + status), { status, body: { error } });
const basisIn = (u) => new URL(u, 'http://x').searchParams.get('basis');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const gets = () => calls.filter((c) => c[0] === 'GET' && c[1].startsWith('/api/claude/dispatch?'));

/** 一台假的服务端：GET 按当前的 rev / 图谱回；fail(basis) 让某个口径的 GET 报错。 */
function server() {
  const s = { rev: 1, chart: BUILTIN, down: new Set(), post: async () => ({ ok: true }) };
  globalThis.__dpApi = {
    get: async (u) => {
      if (u.startsWith('/api/claude/dispatch/chart/points')) return s.points || { ok: true, points: null };
      const basis = basisIn(u);
      if (s.down.has(basis)) throw httpErr(502, '网关没响应');
      return { ok: true, policy: policy(s.rev), preview: preview(basis, s.chart), canEdit: true, canImport: true };
    },
    post: (u, b) => s.post(u, b),
  };
  return s;
}
async function fresh() {
  D._resetDispatchForTests();
  calls.length = 0;
  const s = server();
  await D.loadDispatch();
  assert.equal(dp.loaded, true);
  return s;
}

test('loadDispatch：读到了回 true；读不出来不抛、回 false，原因在 dp.err', async () => {
  D._resetDispatchForTests();
  const s = server();
  s.down.add('official');
  assert.equal(await D.loadDispatch(), false);
  assert.equal(dp.loaded, false);
  assert.equal(dp.err, '网关没响应');
  s.down.clear();
  assert.equal(await D.loadDispatch(), true);
  assert.equal(dp.loaded, true);
  assert.equal(dp.err, '');
  assert.equal(await D.loadDispatch(), true, '已经读过、不 force：直接回');
});

test('setBasis：读到了 → 口径与预览一起换过去', async () => {
  await fresh();
  await D.setBasis('custom');
  assert.equal(dp.basis, 'custom');
  assert.equal(dp.preview.basis, 'custom');
  await D.setBasis('official');
  assert.equal(dp.basis, 'official');
  assert.equal(dp.preview.basis, 'official');
});

test('setBasis：新口径的落点没读出来 → 换回原来的口径并抛（预览还是原口径的那份）；之后能重试', async () => {
  const s = await fresh();
  s.down.add('custom');
  const before = dp.preview;
  const going = D.setBasis('custom');
  assert.equal(dp.basis, 'custom', '界面先变');
  await assert.rejects(going, /网关没响应/);
  assert.equal(dp.basis, 'official', '换回去了：分段和落点 / 图是同一个口径');
  assert.equal(dp.preview.basis, 'official');
  assert.deepEqual(dp.preview, before);
  await sleep(0);   // 回滚后按原口径补的那一次读取
  // 网络好了，过了冷却再点一次：这回成
  s.down.clear();
  await sleep(450);
  await D.setBasis('custom');
  assert.equal(dp.basis, 'custom');
  assert.equal(dp.preview.basis, 'custom');
});

test('setBasis：刚失败过的口径紧接着再要 → 直接按上次的原因抛，不发请求、不动口径（响应式调用方不会打转）', async () => {
  const s = await fresh();
  s.down.add('custom');
  await assert.rejects(D.setBasis('custom'), /网关没响应/);
  await sleep(0);
  const n = gets().filter((c) => basisIn(c[1]) === 'custom').length;
  assert.equal(n, 1);
  // 模拟「口径不对就纠正」的 effect：回滚一发生它立刻再调一次
  for (let i = 0; i < 5; i++) {
    const again = D.setBasis('custom');
    assert.equal(dp.basis, 'official', '没有再闪到新口径');
    await assert.rejects(again, /网关没响应/);
  }
  assert.equal(gets().filter((c) => basisIn(c[1]) === 'custom').length, n, '冷却期内不再发请求');
});

test('setBasis：这次没读成、但同一个口径更晚的一次读取读到了 → 不回滚、不抛', async () => {
  const s = await fresh();
  const first = deferred();
  const real = globalThis.__dpApi.get;
  let n = 0;
  globalThis.__dpApi.get = (u) => (basisIn(u) === 'custom' && ++n === 1 ? first.promise : real(u));
  const going = D.setBasis('custom');
  const later = D.loadDispatch({ force: true });   // 总线事件触发的重拉：发得晚、回得早
  assert.equal(await later, true);
  first.reject(httpErr(502, '网关没响应'));
  await going;
  assert.equal(dp.basis, 'custom');
  assert.equal(dp.preview.basis, 'custom');
  assert.equal(s.rev, 1);
});

test('setBasis：等应答的工夫又换回去 → 后来的那次说了算，先前那次不回滚也不抛', async () => {
  await fresh();
  const slow = deferred();
  const real = globalThis.__dpApi.get;
  globalThis.__dpApi.get = (u) => (basisIn(u) === 'custom' ? slow.promise : real(u));
  const a = D.setBasis('custom');
  const b = D.setBasis('official');
  await b;
  slow.reject(httpErr(502, '网关没响应'));
  await a;
  assert.equal(dp.basis, 'official');
  assert.equal(dp.preview.basis, 'official');
});

test('图谱操作的应答比它之后发起的写请求晚到：预览按取号算是旧的没收 → 当场补拉，新图谱不用等总线事件', async () => {
  const s = await fresh();
  assert.equal(dp.preview.chart.source, 'builtin');
  const importing = deferred();
  s.post = async (u) => {
    if (u.endsWith('/chart/import')) return importing.promise;
    if (u.endsWith('/update')) { s.rev = 2; return { ok: true, policy: policy(2, { scope: { workflow: true, subagent: true, session: true } }), preview: preview('official', s.chart) }; }
    return { ok: true };
  };
  const file = { size: 12, name: '订阅plan性价比图.html', text: async () => '<html></html>' };
  const op = D.importChartFile(file);
  await sleep(0);
  // 导入还在路上（在线获取最长 30 秒）时点了一个范围勾选：它的应答先回来
  await D.setDispatch({ scope: { session: true } });
  assert.equal(dp.policy.rev, 2);
  const before = gets().length;
  s.chart = IMPORTED;
  importing.resolve({ ok: true, chart: IMPORTED, preview: preview('official', IMPORTED) });
  assert.deepEqual(await op, IMPORTED);
  await sleep(0);
  assert.equal(gets().length, before + 1, '补拉了一次');
  assert.equal(dp.preview.chart.source, 'imported', '图下方的数据来源、候选和落点是新图谱的');
  assert.equal(dp.preview.chart.generated, '2026-11-10');
  assert.equal(dp.chartBusy, '');
});

test('图谱操作的应答按时回来：预览直接收下，不多拉一次', async () => {
  const s = await fresh();
  s.post = async (u) => (u.endsWith('/chart/fetch') ? (s.chart = IMPORTED, { ok: true, chart: IMPORTED, preview: preview('official', IMPORTED) }) : { ok: true });
  const before = gets().length;
  assert.deepEqual(await D.fetchChartOnline(), IMPORTED);
  await sleep(0);
  assert.equal(dp.preview.chart.source, 'imported');
  assert.equal(gets().length, before);
});

test('全图点表：整份原样放着，不进 dp 的深层代理（两千多行逐格过代理，图上拼一遍全图要慢近一倍）', async () => {
  const s = await fresh();
  const rows = [['anthropic', 'Claude Max', 'claude-opus-5-5', 'Claude Opus 5.5', 'max', 59.11, 1.25875, 'plan']];
  const vendors = [{ key: 'anthropic', name: 'Anthropic', cn: false, tp: false }];
  s.points = { ok: true, points: rows, vendors };
  const got = await D.loadAllPoints();
  assert.equal(got, dp.points);
  assert.equal(dp.points.points, rows, '就是服务端回来的那个数组');
  assert.equal(dp.points.points[0], rows[0]);
  assert.equal(dp.points.vendors, vendors);
  assert.equal(Array.isArray(dp.points), false);
  // 没导入过图谱 → null
  s.points = { ok: true, points: null };
  assert.equal(await D.loadAllPoints({ force: true }), null);
  assert.equal(dp.points, null);
});

// —— dimensio 那份（dimDispatch）：请求都带作用域、不带口径；跟随 / 单独两种模式的切换；总线事件对两份状态的重拉规则 ——
const { handlers } = await import(pathToFileURL(join(dir, 'lib', 'bus.js')).href);
const dimD = D.dimDispatch;
const ddp = dimD.dp;
const scopeIn = (u) => new URL(u, 'http://x').searchParams.get('scope');
const dimPolicy = (rev, more = {}) => ({ ...policy(rev), follow: true, ...more });
const dimPreview = () => ({ basis: 'dimensio', tiers: [], candidates: [{ model: 'zhipu:glm-5.3-flash', label: 'GLM-5.3 Flash', effort: 'high', ii: 41.8, cost: 1.9, basis: 'api' }], unrated: [{ model: 'custom-1a2b3c4d:qwen3:32b', label: '', provider: '本机 Ollama' }], poolPlans: [], chart: BUILTIN });
/** 两份都答的假服务端：dimensio 的 GET 认 scope 查询串；harnessDown = 落点算不出来（preview:null + previewError）。 */
function bothServer() {
  const s = { rev: 1, dimRev: 1, follow: true, harnessDown: false, post: async () => ({ ok: true }) };
  globalThis.__dpApi = {
    get: async (u) => {
      if (scopeIn(u) === 'dimensio') {
        return {
          ok: true, scope: 'dimensio', policy: dimPolicy(s.dimRev, { follow: s.follow }), canEdit: true, canImport: true,
          claude: { activeId: 's-1', name: '省钱', enabled: true, rev: s.rev },
          ...(s.harnessDown ? { preview: null, previewError: 'dimensio 服务没起来' } : { preview: dimPreview() }),
        };
      }
      return { ok: true, policy: policy(s.rev), preview: preview(basisIn(u) || 'official'), canEdit: true, canImport: true };
    },
    post: (u, b) => s.post(u, b),
  };
  return s;
}
async function freshBoth() {
  D._resetDispatchForTests();
  dimD._reset();
  calls.length = 0;
  const s = bothServer();
  await D.loadDispatch();
  await dimD.loadDispatch();
  return s;
}
const dimGets = () => calls.filter((c) => c[0] === 'GET' && scopeIn(c[1]) === 'dimensio');
const claudeGets = () => calls.filter((c) => c[0] === 'GET' && c[1].startsWith('/api/claude/dispatch?') && scopeIn(c[1]) !== 'dimensio');

test('dimensio：读取带 scope=dimensio、不带 basis；策略、Claude 那边生效的那一套、落点一起收下；模型显示名从它自己的预览里取', async () => {
  await freshBoth();
  const g = dimGets();
  assert.equal(g.length, 1);
  assert.equal(basisIn(g[0][1]), null, 'dimensio 没有口径一说');
  assert.equal(ddp.loaded, true);
  assert.equal(ddp.policy.follow, true);
  assert.equal(ddp.claude.name, '省钱');
  assert.equal(ddp.preview.basis, 'dimensio');
  assert.equal(ddp.basis, 'dimensio');
  assert.notEqual(ddp, dp, '两份状态各是各的');
  assert.equal(dp.preview.basis, 'official', 'Claude 那份照旧');
  assert.equal(dimD.modelName('zhipu:glm-5.3-flash'), 'GLM-5.3 Flash');
  assert.equal(dimD.modelName('custom-1a2b3c4d:qwen3:32b'), 'qwen3:32b', '预览里没有显示名：只写型号段（型号 id 自己带冒号也不拆）');
  assert.equal(dimD.modelName('kimi:k3'), 'k3');
  assert.equal(dimD.effortName('zhipu:glm-5.3-flash', ''), '默认');
  assert.equal(dimD.effortName('zhipu:glm-5.3-flash', 'off'), '不思考');
});

test('dimensio：写请求的体里都带 scope:dimensio、不带 basis（即点即存、存 / 删策略、实时预览、图谱操作）', async () => {
  const s = await freshBoth();
  const posts = [];
  s.post = async (u, b) => {
    posts.push([u, b]);
    if (u.endsWith('/update')) { s.dimRev++; return { ok: true, policy: dimPolicy(s.dimRev, { scope: { workflow: true, subagent: true, session: true } }), preview: dimPreview() }; }
    if (u.endsWith('/strategy/save')) { s.dimRev++; return { ok: true, policy: dimPolicy(s.dimRev), strategy: { id: 's-1', name: '默认' }, preview: dimPreview() }; }
    if (u.endsWith('/strategy/delete')) { s.dimRev++; return { ok: true, policy: dimPolicy(s.dimRev), preview: dimPreview() }; }
    if (u.endsWith('/preview')) return { ok: true, preview: dimPreview() };
    if (u.endsWith('/chart/fetch')) return { ok: true, chart: BUILTIN, preview: dimPreview() };
    return { ok: true };
  };
  await dimD.setDispatch({ scope: { session: true } });
  await dimD.saveStrategy({ id: 's-1', note: '审查用最强的' });
  await dimD.deleteStrategy('s-2');
  const p = await dimD.previewStrategy({ id: 's-1', floors: {} }, { allowThirdParty: false });
  assert.equal(p.basis, 'dimensio');
  await dimD.fetchChartOnline();
  assert.deepEqual(posts.map(([u]) => u.replace('/api/claude/dispatch', '')), ['/update', '/strategy/save', '/strategy/delete', '/preview', '/chart/fetch']);
  for (const [u, b] of posts) {
    assert.equal(b.scope, 'dimensio', u + ' 带作用域');
    assert.equal('basis' in b, false, u + ' 不带口径');
  }
  assert.deepEqual(posts[0][1], { patch: { scope: { session: true } }, scope: 'dimensio' });
  assert.equal(posts[3][1].allowThirdParty, false);
  // Claude 那份的写请求照旧不带作用域
  s.post = async (u, b) => { posts.push([u, b]); s.rev++; return { ok: true, policy: policy(s.rev), preview: preview('official') }; };
  await D.setDispatch({ enabled: false });
  assert.deepEqual(posts.at(-1)[1], { patch: { enabled: false } });
  await dimD.setBasis('custom');
  assert.equal(ddp.basis, 'dimensio', 'dimensio 那份没有口径可换');
});

test('dimensio：跟随 ⇄ 单独即点即存——界面先变；失败撤回这一次并抛；成功后按服务端那份', async () => {
  const s = await freshBoth();
  const gate = deferred();
  s.post = async (u, b) => {
    await gate.promise;
    if (b.patch.follow === false && s.fail) throw httpErr(500, '没写进磁盘');
    s.dimRev++; s.follow = b.patch.follow;
    return { ok: true, policy: dimPolicy(s.dimRev, { follow: s.follow }), preview: dimPreview() };
  };
  // 失败：先变成「单独」，应答回来撤回「跟随」
  s.fail = true;
  const going = dimD.setDispatch({ follow: false });
  await sleep(0);
  assert.equal(ddp.policy.follow, false, '界面先变');
  gate.resolve();
  await assert.rejects(going, /没写进磁盘/);
  assert.equal(ddp.policy.follow, true, '撤回了');
  assert.equal(dp.policy.follow, undefined, 'Claude 那份不受影响');
  // 成功
  s.fail = false;
  await dimD.setDispatch({ follow: false });
  assert.equal(ddp.policy.follow, false);
  assert.equal(ddp.policy.rev, 2);
  await dimD.setDispatch({ follow: true });
  assert.equal(ddp.policy.follow, true);
  assert.equal(ddp.policy.rev, 3);
});

test('dimensio：落点算不出来（preview:null + previewError）→ 清掉手上的落点、记下原因；好了以后再读就回来', async () => {
  const s = await freshBoth();
  assert.ok(ddp.preview);
  s.harnessDown = true;
  assert.equal(await dimD.loadDispatch({ force: true }), true, '策略照样读到了');
  assert.equal(ddp.preview, null);
  assert.equal(ddp.previewError, 'dimensio 服务没起来');
  assert.equal(ddp.policy.follow, true);
  s.harnessDown = false;
  await dimD.loadDispatch({ force: true });
  assert.equal(ddp.preview.basis, 'dimensio');
  assert.equal(ddp.previewError, '');
});

test('总线：Claude 那份只认自己的（scope 缺省 / claude）与图谱变更；dimensio 那份全认（跟随模式依赖 Claude 那边）', async () => {
  await freshBoth();
  const emit = async (ev) => {
    const c0 = claudeGets().length, d0 = dimGets().length;
    for (const h of handlers) h(ev);
    await sleep(0);
    return [claudeGets().length - c0, dimGets().length - d0];
  };
  assert.deepEqual(await emit({ type: 'claude.dispatch', rev: 2, scope: 'dimensio' }), [0, 1], 'dimensio 的改动：只有 dimensio 那份重拉');
  assert.deepEqual(await emit({ type: 'claude.dispatch', rev: 3, scope: 'claude' }), [1, 1], 'Claude 的改动：两份都重拉');
  assert.deepEqual(await emit({ type: 'claude.dispatch', rev: 4 }), [1, 1], '老服务端不带 scope：当作 Claude 的');
  assert.deepEqual(await emit({ type: 'claude.dispatch', chart: true }), [1, 1], '图谱换了：两份都重拉');
  assert.deepEqual(await emit({ type: 'claude.settings' }), [0, 0], '别的事件不管');
  // 没人看过 dimensio 那页：不拉
  dimD._reset();
  assert.deepEqual(await emit({ type: 'claude.dispatch', rev: 5, scope: 'dimensio' }), [0, 0]);
});
