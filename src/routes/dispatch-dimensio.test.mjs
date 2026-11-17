// 子 agent 调用策略的 dimensio 作用域（routes/dispatch.mjs 的 scope=dimensio + 同机接口 /api/internal/dispatch-policy，
// 解析在 runtime/dispatch-dimensio.mjs）：设置页读写带作用域、跟随 / 单独两种模式下给实例的生效策略与预览用的策略、
// Claude 写法的档位自定义映射成 dimensio 认得的写法、旧偏好迁移、总线与实例通知、同机接口的凭据。
// dimensio 扩展用 _setDimensioHooksForTests 顶替（不拉起真的 harness）；同机接口走真的 http（要认本机直连）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dispatch-dimensio-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: 'x'.repeat(32), features: { multiUser: true } }, null, 2));

const users = await import('../users.mjs');
const { INTERNAL_IDENTITY, contextFor, userIdentity } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerDispatchRoutes, _setDimensioHooksForTests } = await import('./dispatch.mjs');
const { setInternalRouter, internalRequest } = await import('../agent-api/internal.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const { setChartRoot } = await import('../runtime/dispatch-chart.mjs');
const { ensureHostSecret } = await import('../runtime/host-secret.mjs');
const { mintAgentDeviceToken } = await import('../runtime/agent-device-token.mjs');
const { portableOverride, portableStrategy, dimensioEffective } = await import('../runtime/dispatch-dimensio.mjs');
const { provideModelService, serviceHash, _resetModelServicesForTests } = await import('../runtime/model-services.mjs');

setChartRoot(path.join(tmp, 'chart-root'));
after(() => { setChartRoot(); _setDimensioHooksForTests(undefined); });

const router = createRouter();
registerDispatchRoutes(router, { identify: (req) => req[INTERNAL_IDENTITY] || { kind: 'none' } });
setInternalRouter(router);
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
after(() => server.close());

const ADMIN = { kind: 'admin', user: null };
const GET = (id, url) => internalRequest(id, 'GET', url);
const POST = (id, url, body = {}) => internalRequest(id, 'POST', url, body);
const listen = (key) => {
  const seen = [];
  const res = { writableEnded: false, write(s) { seen.push(JSON.parse(String(s).replace(/^data: /, ''))); return true; }, end() { this.writableEnded = true; } };
  return { seen, off: busSubscribe(key, res) };
};

// 假的 dimensio 扩展：记下每次要预览时收到的策略，回一份固定的落点
const calls = { preview: [], legacy: 0, changed: 0 };
let legacyReply = { ladder: true, note: '' };
let previewFails = false;
const PICK = { model: 'zhipu:glm-5.3-flash', label: 'GLM-5.3 Flash', effort: 'high', ii: 41.8, cost: 1.9, basis: 'api', provider: 'Zhipu' };
_setDimensioHooksForTests({
  async dispatchPreview(ctx, body) {
    calls.preview.push(body);
    if (previewFails) throw new Error('dimensio 没起来');
    return {
      tiers: ['top', 'hard', 'normal', 'light'].map((key) => ({ key, use: 'x', floor: 40, floorDefault: 35, source: 'chart', short: false, overrideSkipped: false, pick: PICK })),
      candidates: [{ ...PICK, creator: 'Zhipu' }], unrated: [],
    };
  },
  async dispatchLegacy() { calls.legacy++; return legacyReply; },
  dispatchChanged() { calls.changed++; },
});

const internal = async (tok, body = {}, headers = {}) => {
  const r = await fetch(base + '/api/internal/dispatch-policy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};

test('设置页：scope=dimensio 读到 dimensio 那份（默认开着、跟随 Claude）、Claude 生效那套的摘要、实例算的预览；第一次读先迁旧偏好', async () => {
  legacyReply = { ladder: true, note: '简单检索一律用 MiMo' };
  const r = await GET(ADMIN, '/api/claude/dispatch?scope=dimensio');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(calls.legacy, 1, '还没落盘：问实例要旧偏好');
  // 旧偏好有备注 → 迁成 dimensio 自己那套 + follow:false（改造前的行为原样保住）
  assert.deepEqual([r.json.scope, r.json.policy.enabled, r.json.policy.follow, r.json.policy.strategies[0].note], ['dimensio', true, false, '简单检索一律用 MiMo']);
  assert.deepEqual(Object.keys(r.json.claude).sort(), ['activeId', 'enabled', 'name', 'note', 'overrides', 'rev']);
  assert.deepEqual([r.json.claude.note, r.json.claude.overrides.top], ['', null]);
  assert.equal(r.json.preview.basis, 'dimensio');
  assert.deepEqual(r.json.preview.tiers.map((t) => [t.key, t.title, t.pick.model]), [['top', '最难', 'zhipu:glm-5.3-flash'], ['hard', '难', 'zhipu:glm-5.3-flash'], ['normal', '常规', 'zhipu:glm-5.3-flash'], ['light', '机械', 'zhipu:glm-5.3-flash']]);
  assert.equal(r.json.preview.chart.source, 'builtin');
  assert.deepEqual([r.json.canEdit, r.json.canImport], [true, true]);
  // 再读不再问（已经落盘）；Claude 那份没被碰
  await GET(ADMIN, '/api/claude/dispatch?scope=dimensio');
  assert.equal(calls.legacy, 1);
  assert.equal((await GET(ADMIN, '/api/claude/dispatch')).json.policy.follow, undefined);
  assert.equal((await GET(ADMIN, '/api/claude/dispatch?scope=nope')).status, 400);
  // 实例起不来：策略照给，预览 null + 原因
  previewFails = true;
  try {
    const d = await GET(ADMIN, '/api/claude/dispatch?scope=dimensio');
    assert.deepEqual([d.status, d.json.preview, d.json.previewError], [200, null, 'dimensio 没起来']);
  } finally { previewFails = false; }
});

test('写：带 scope 的改动落进 dimensio 那份；推 { rev, scope:dimensio }，叫在跑的实例丢缓存；Claude 那份的改动也叫（跟随模式依赖它）', async () => {
  const key = contextFor(ADMIN).key;
  const bus = listen(key);
  const before = calls.changed;
  try {
    const r = await POST(ADMIN, '/api/claude/dispatch/update', { scope: 'dimensio', patch: { follow: true, scope: { session: true } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.policy.follow, r.json.policy.scope.session], [true, true]);
    assert.equal(r.json.preview.basis, 'dimensio');
    assert.deepEqual(bus.seen.at(-1), { type: 'claude.dispatch', rev: r.json.policy.rev, scope: 'dimensio' });
    await POST(ADMIN, '/api/claude/dispatch/update', { patch: { allowThirdParty: true, enabled: false } });
    assert.deepEqual(bus.seen.at(-1), { type: 'claude.dispatch', rev: 1 }, 'Claude 那份的消息形状不变');
    assert.equal(calls.changed, before + 2);
    await POST(ADMIN, '/api/claude/dispatch/update', { patch: { enabled: true } });
  } finally { bus.off(); }
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/update', { scope: 'dimensio', patch: { follow: 'x' } })).status, 400);
  // dimensio 那份没有「调用非 Claude 模型」（11-15 去掉）
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/update', { scope: 'dimensio', patch: { allowThirdParty: false } })).status, 400);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/update', { scope: 'codex', patch: {} })).status, 400);
});

test('跟随：给实例的策略是 Claude 生效那套，档位自定义映射成可携写法（别名 → 型号 id；发布给 dimensio 的服务带上它在 dimensio 的厂商 id）', async () => {
  _resetModelServicesForTests();
  provideModelService('model-hub', 'Model hub', {
    id: 'h-12345678', name: 'Hub', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k',
    agents: ['claude', 'dimensio'], models: [{ id: 'glm-5.3-flash', label: 'GLM' }, { id: 'only-claude', label: 'C', agents: ['claude'] }],
  });
  const pid = 'p-' + serviceHash('model-hub', 'h-12345678', 10);
  try {
    const s = await POST(ADMIN, '/api/claude/dispatch/strategy/save', {
      strategy: { name: '跟随测试', floors: { hard: 44 }, overrides: { light: { model: 'haiku', effort: '' }, normal: { model: `custom:${pid}:glm-5.3-flash`, effort: 'high' }, top: { model: `custom:${pid}:only-claude`, effort: 'max' } } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.json));
    await POST(ADMIN, '/api/claude/dispatch/update', { patch: { activeId: s.json.strategy.id } });
    calls.preview.length = 0;
    await GET(ADMIN, '/api/claude/dispatch?scope=dimensio');
    const st = calls.preview.at(-1).strategy;
    assert.deepEqual([st.from, st.name, st.floors.hard], ['claude', '跟随测试', 44]);
    assert.deepEqual(st.overrides.light, { model: 'claude-haiku-5-5', effort: '', ref: 'haiku' });
    assert.deepEqual(st.overrides.normal, { model: 'glm-5.3-flash', provider: 'custom-' + serviceHash('model-hub', 'h-12345678', 8), effort: 'high', ref: `custom:${pid}:glm-5.3-flash` });
    assert.deepEqual(st.overrides.top, { model: 'only-claude', effort: 'max', ref: `custom:${pid}:only-claude` }, '没发给 dimensio 的型号不带厂商');
    assert.equal(st.overrides.hard, null);
    // 同机接口给实例的是同一份
    const r = await internal(ensureHostSecret(), {}, { 'x-bridge-agent': 'dimensio' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.policy.strategy, st);
    assert.deepEqual([r.json.policy.follow, r.json.policy.enabled, r.json.policy.scope.session], [true, true, true]);
  } finally { _resetModelServicesForTests(); }
});

test('单独一套：预览与给实例的都是 dimensio 自己那套（「厂商:型号」拆开）；草稿按 dimensio 写法认', async () => {
  const s = await POST(ADMIN, '/api/claude/dispatch/strategy/save', { scope: 'dimensio', strategy: { name: '自己的', overrides: { light: { model: 'custom-1a2b3c4d:qwen3:32b', effort: 'low' } } } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  await POST(ADMIN, '/api/claude/dispatch/update', { scope: 'dimensio', patch: { follow: false, activeId: s.json.strategy.id } });
  const r = await internal(ensureHostSecret(), {}, { 'x-bridge-agent': 'dimensio' });
  assert.deepEqual([r.json.policy.follow, r.json.policy.strategy.from, r.json.policy.strategy.name], [false, 'dimensio', '自己的']);
  assert.deepEqual(r.json.policy.strategy.overrides.light, { model: 'qwen3:32b', provider: 'custom-1a2b3c4d', effort: 'low', ref: 'custom-1a2b3c4d:qwen3:32b' });
  // 草稿预览：不落盘，按 dimensio 写法认（Claude 写法那档被宽松规范化丢掉）
  calls.preview.length = 0;
  const pv = await POST(ADMIN, '/api/claude/dispatch/preview', { scope: 'dimensio', strategy: { floors: { hard: 33.3 }, overrides: { top: { model: 'kimi:k3', effort: 'max' }, light: { model: 'opus', effort: '' } } }, allowThirdParty: false });
  assert.equal(pv.status, 200);
  const sent = calls.preview.at(-1);
  assert.equal(sent.allowThirdParty, true, 'dimensio 没有「调用非 Claude 模型」开关：请求里带了也恒为 true');
  assert.deepEqual([sent.strategy.floors.hard, sent.strategy.overrides.top.provider, sent.strategy.overrides.light], [33.3, 'kimi', null]);
  assert.equal((await GET(ADMIN, '/api/claude/dispatch?scope=dimensio')).json.policy.strategies.find((x) => x.id === s.json.strategy.id).floors.hard, null);
});

test('同机接口：只认本机直连的实例凭据、只给 dimensio；成员令牌 = 他自己那份（没命令行 = 只读默认：开着、单独一套）；带旧偏好迁一次；图谱版本键', async () => {
  assert.equal((await internal('')).status, 404);
  assert.equal((await internal('not-a-secret-at-all-xxxxxxxx')).status, 404);
  assert.equal((await internal(ensureHostSecret(), {}, { 'x-bridge-agent': 'codex' })).status, 403);
  // 隧道转发头 = 不是本机直连
  assert.equal((await internal(ensureHostSecret(), {}, { 'x-bridge-agent': 'dimensio', 'x-forwarded-for': '1.2.3.4' })).status, 404);
  const admin = await internal(ensureHostSecret(), { chart: '' }, { 'x-bridge-agent': 'dimensio' });
  assert.deepEqual(admin.json.chart, { key: 'builtin' });
  assert.equal(admin.json.policy.readOnly, false);

  const m = await users.createUser('dimplain', 'pw-dimplain-123', 'user');
  assert.ok(m.ok, m.error);
  users.setAgents('dimplain', ['claude', 'dimensio']);
  const tok = mintAgentDeviceToken(m.id, 'dimensio');
  const r = await internal(tok, { legacy: { ladder: false, note: 'x' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.policy.enabled, r.json.policy.follow, r.json.policy.readOnly], [true, false, true], '没权限的不迁、读到只读默认');
  const ctx = contextFor(userIdentity(m.id));
  assert.equal(existsSync(path.join(ctx.dataDir || tmp, 'dispatch-policy.dimensio.json')), false);

  // 有命令行的成员：带来的旧偏好迁进他自己那份
  const p = await users.createUser('dimpro', 'pw-dimpro-123', 'pro');
  assert.ok(p.ok, p.error);
  users.setAgents('dimpro', ['claude', 'dimensio']);
  const r2 = await internal(mintAgentDeviceToken(p.id, 'dimensio'), { legacy: { ladder: false, note: '' } });
  assert.deepEqual([r2.json.policy.enabled, r2.json.policy.follow, r2.json.policy.readOnly], [false, false, false]);
});

test('快照访客：dimensio 那份只读、不去实例上算落点（别借管理员的实例看到它能用的型号），写 403', async () => {
  const SNAP = { kind: 'snap', user: null, token: 'tok-dispatch-dim', dir: path.join(tmp, 'snap') };
  mkdirSync(SNAP.dir, { recursive: true });
  const n = calls.preview.length;
  const r = await GET(SNAP, '/api/claude/dispatch?scope=dimensio');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.canEdit, r.json.preview, r.json.policy.follow], [false, null, false]);
  assert.equal(calls.preview.length, n, '没有去问实例');
  assert.equal((await POST(SNAP, '/api/claude/dispatch/update', { scope: 'dimensio', patch: { follow: false } })).status, 403);
});

test('可携写法：认不出的写法 → null；Claude 自己加的服务（不是发布出来的）只给型号 id；dimensioEffective 带草稿', () => {
  assert.equal(portableOverride({ model: 'what', effort: '' }, 'claude'), null);
  assert.equal(portableOverride({ model: 'opus', effort: '' }, 'dimensio'), null);
  assert.deepEqual(portableOverride({ model: 'custom:p-1a2b3c4d:deepseek-v4', effort: 'high' }, 'claude'), { model: 'deepseek-v4', effort: 'high', ref: 'custom:p-1a2b3c4d:deepseek-v4' });
  assert.deepEqual(portableOverride({ model: 'local:strata-orca', effort: '' }, 'dimensio'), { model: 'strata-orca', provider: 'local', effort: '', ref: 'local:strata-orca' });
  assert.equal(portableStrategy(null, 'claude'), null);
  const e = dimensioEffective(contextFor(ADMIN), { strategy: { id: 'draft', name: 'd', floors: { top: 50 }, overrides: {}, note: 'n' } });
  assert.deepEqual([e.strategy.floors.top, e.strategy.note, e.strategy.from], [50, 'n', 'dimensio']);
});
