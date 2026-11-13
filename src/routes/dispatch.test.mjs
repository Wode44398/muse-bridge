// /api/claude/dispatch*（routes/dispatch.mjs）：鉴权（没登录 / 分享 401，快照访客只读、写 403，没命令行的成员只读，
// 图谱数据只给管理员）、请求体校验与大小上限、预览不落盘、写成功后推总线（策略推同账号 { rev }，图谱推所有人 { chart:true }）、
// 图谱的导入 / 全图点 / 清除。走进程内请求（agent-api/internal.mjs 的 internalRequest），数据根与图谱根都换到临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dispatch-routes-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: 'x'.repeat(32), features: { multiUser: true } }, null, 2));

const users = await import('../users.mjs');
const { INTERNAL_IDENTITY, contextFor, userIdentity } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerDispatchRoutes } = await import('./dispatch.mjs');
const { setInternalRouter, internalRequest } = await import('../agent-api/internal.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const { setChartRoot, CHART_MAX_BYTES } = await import('../runtime/dispatch-chart.mjs');

// 临时目录不在用例里删：Windows 上 Node 24 的 rmSync 偶尔会卡住整个进程
setChartRoot(path.join(tmp, 'chart-root'));
test.after(() => setChartRoot());

const router = createRouter();
registerDispatchRoutes(router, { identify: (req) => req[INTERNAL_IDENTITY] || { kind: 'none' } });
registerDispatchRoutes(createRouter(), { identify: () => ({ kind: 'none' }) });   // 再注册一次（另一个路由表）：总线推送不重复
setInternalRouter(router);

const ADMIN = { kind: 'admin', user: null };
const SNAP = { kind: 'snap', user: null, token: 'tok-dispatch', dir: path.join(tmp, 'snap') };
mkdirSync(SNAP.dir, { recursive: true });
const memberId = async (name, tier) => { await users.createUser(name, 'pw-' + name + '-123', tier); return userIdentity(name); };
const PLAIN = await memberId('rtplain', 'user');
const PRO = await memberId('rtpro', 'pro');

const GET = (id, url) => internalRequest(id, 'GET', url);
const POST = (id, url, body = {}) => internalRequest(id, 'POST', url, body);
const listen = (key) => {
  const seen = [];
  const res = { writableEnded: false, write(s) { seen.push(JSON.parse(String(s).replace(/^data: /, ''))); return true; }, end() { this.writableEnded = true; } };
  return { seen, off: busSubscribe(key, res) };
};

// 假的性价比图：凑够 50 个点，至少一个 Anthropic 的 API 点
function chartHtml() {
  const points = [{ id: 'api|claude-route-test', src: 'api', vkey: 'anthropic', slug: 'claude-route-test', family: 'Claude Route Test', aaName: 'Claude Route Test', effort: 'high', creator: 'Anthropic', score: 12.3, cost: 4.56, rel: '2026-11-01' }];
  for (let i = 0; i < 49; i++) points.push({ id: 'f|' + i, src: 'plan', vkey: 'tp_filler', plan: 'Filler', planFull: 'Filler', price: 10, slug: 'filler-' + i, family: 'filler', aaName: 'filler', effort: 'high', score: 10 + i / 10, cost: 1 + i });
  const D = { generated: '2026-11-10', fx: 6.7, source: 'Artificial Analysis Intelligence Index v5.0（测试）', vendors: [{ key: 'anthropic', name: 'Anthropic' }], plans: [], points };
  return '<!doctype html><html><body><script>\nconst DATA = ' + JSON.stringify(D) + ';\n</script></body></html>';
}

test('鉴权：没登录 / 分享身份一律 401', async () => {
  for (const id of [{ kind: 'none' }, { kind: 'share', user: null }]) {
    for (const r of [await GET(id, '/api/claude/dispatch'), await GET(id, '/api/claude/dispatch/chart/points'), await POST(id, '/api/claude/dispatch/update', { patch: { enabled: false } }), await POST(id, '/api/claude/dispatch/preview')]) {
      assert.equal(r.status, 401);
      assert.equal(r.json.error, '没有登录');
    }
  }
});

test('GET：管理员拿到可改的全貌与四档预览；basis=custom 换口径', async () => {
  const r = await GET(ADMIN, '/api/claude/dispatch');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.canEdit, r.json.canImport], [true, true, true]);
  assert.deepEqual([r.json.policy.enabled, r.json.policy.activeId, r.json.policy.rev], [true, 's-00000000', 0]);
  assert.equal(r.json.preview.basis, 'official');
  assert.deepEqual(r.json.preview.tiers.map((t) => t.key), ['top', 'hard', 'normal', 'light']);
  assert.equal(r.json.preview.chart.source, 'builtin');
  assert.equal((await GET(ADMIN, '/api/claude/dispatch?basis=custom')).json.preview.basis, 'custom');
  assert.equal((await GET(ADMIN, '/api/claude/dispatch?basis=xx')).json.preview.basis, 'official');
  const pts = await GET(ADMIN, '/api/claude/dispatch/chart/points');
  assert.deepEqual([pts.status, pts.json.points], [200, null], '没导入过：没有全图');
});

test('预览只算不写：rev 不变、不落盘；按给的策略算；参数不对 400', async () => {
  const file = path.join(tmp, 'dispatch-policy.json');
  assert.equal(existsSync(file), false);
  const r = await POST(ADMIN, '/api/claude/dispatch/preview', { strategy: { floors: { hard: 33.3 } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.preview.tiers.find((t) => t.key === 'hard').floor, 33.3);
  assert.equal(existsSync(file), false);
  assert.equal((await GET(ADMIN, '/api/claude/dispatch')).json.policy.rev, 0);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/preview', { strategy: 'x' })).status, 400);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/preview', { allowThirdParty: 'yes' })).status, 400);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/preview', { allowThirdParty: false })).status, 200);
});

test('快照访客：读到总开关关着的只读默认；写 403（预览照算）', async () => {
  const r = await GET(SNAP, '/api/claude/dispatch');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.policy.enabled, r.json.canEdit, r.json.canImport], [false, false, false]);
  for (const [url, body] of [['/api/claude/dispatch/update', { patch: { enabled: true } }], ['/api/claude/dispatch/strategy/save', { strategy: { name: 'x' } }], ['/api/claude/dispatch/strategy/delete', { id: 's-00000000' }], ['/api/claude/dispatch/chart/clear', {}]]) {
    const w = await POST(SNAP, url, body);
    assert.equal(w.status, 403, url);
    assert.match(w.json.error, /快照访客/);
  }
  assert.equal((await POST(SNAP, '/api/claude/dispatch/preview', {})).status, 200);
});

test('没有命令行的成员只读；有命令行的成员能改自己的；图谱只给管理员', async () => {
  const p = await GET(PLAIN, '/api/claude/dispatch');
  assert.deepEqual([p.json.policy.enabled, p.json.canEdit, p.json.canImport], [false, false, false]);
  const w = await POST(PLAIN, '/api/claude/dispatch/update', { patch: { enabled: true } });
  assert.equal(w.status, 403);
  assert.match(w.json.error, /不能修改子 agent 调用策略/);
  const q = await GET(PRO, '/api/claude/dispatch');
  assert.deepEqual([q.json.canEdit, q.json.canImport], [true, false]);
  const u = await POST(PRO, '/api/claude/dispatch/update', { patch: { scope: { session: true } } });
  assert.equal(u.status, 200);
  assert.equal(u.json.policy.scope.session, true);
  assert.equal((await GET(ADMIN, '/api/claude/dispatch')).json.policy.scope.session, false, '管理员那份没动');
  for (const id of [PLAIN, PRO]) {
    for (const url of ['/api/claude/dispatch/chart/import', '/api/claude/dispatch/chart/fetch', '/api/claude/dispatch/chart/clear']) {
      const r = await POST(id, url, { html: chartHtml() });
      assert.equal(r.status, 403, url);
      assert.match(r.json.error, /只有服务器管理员/);
    }
  }
});

test('写：校验与大小上限；成功后推同账号 claude.dispatch { rev }，只推一次', async () => {
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/update', {})).status, 400, '没给 patch');
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/update', { patch: { nope: 1 } })).status, 400);
  const bad = await POST(ADMIN, '/api/claude/dispatch/update', '{not json');
  assert.deepEqual([bad.status, bad.json.error], [400, '请求内容不是合法的 JSON 对象']);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/update', '[1,2]')).status, 400);
  const big = await POST(ADMIN, '/api/claude/dispatch/update', { patch: {}, pad: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /上限 64 KB/);

  const admin = listen(contextFor(ADMIN).key), other = listen(contextFor(PRO).key);
  try {
    const r = await POST(ADMIN, '/api/claude/dispatch/update', { patch: { enabled: false }, basis: 'custom' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.policy.enabled, r.json.policy.rev, r.json.preview.basis], [false, 1, 'custom']);
    assert.deepEqual(admin.seen, [{ type: 'claude.dispatch', rev: 1 }]);
    assert.deepEqual(other.seen, [], '别的账号收不到');
  } finally { admin.off(); other.off(); }
  await POST(ADMIN, '/api/claude/dispatch/update', { patch: { enabled: true } });
});

test('策略：新建 / 修改 / 删除；生效中的不能删、没有的 404', async () => {
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/strategy/save', {})).status, 400, '没给 strategy');
  const s = await POST(ADMIN, '/api/claude/dispatch/strategy/save', { strategy: { name: '路由测试', floors: { light: 5 } } });
  assert.equal(s.status, 200);
  const id = s.json.strategy.id;
  assert.deepEqual([s.json.strategy.name, s.json.strategy.floors.light, s.json.policy.strategies.length], ['路由测试', 5, 2]);
  const cp = await POST(ADMIN, '/api/claude/dispatch/strategy/save', { strategy: {}, copyOf: id });
  assert.deepEqual([cp.status, cp.json.strategy.name, cp.json.strategy.floors.light], [200, '路由测试 副本', 5]);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/strategy/save', { strategy: { id, floors: { top: 1, hard: 2 } } })).status, 400);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/strategy/save', { strategy: { id: 's-ffffffff', note: 'x' } })).status, 404);
  const act = await POST(ADMIN, '/api/claude/dispatch/update', { patch: { activeId: id } });
  assert.equal(act.json.preview.tiers.find((t) => t.key === 'light').floor, 5, '预览按生效的那套算');
  const del = await POST(ADMIN, '/api/claude/dispatch/strategy/delete', { id });
  assert.equal(del.status, 400);
  assert.match(del.json.error, /生效中的策略不能删/);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/strategy/delete', { id: 's-ffffffff' })).status, 404);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/strategy/delete', {})).status, 400);
  await POST(ADMIN, '/api/claude/dispatch/update', { patch: { activeId: 's-00000000' } });
  const ok = await POST(ADMIN, '/api/claude/dispatch/strategy/delete', { id: cp.json.strategy.id });
  assert.deepEqual([ok.status, ok.json.policy.strategies.length], [200, 2]);
});

test('图谱：导入（不是图 400、超 12MB 413）→ 全图点 → 清除；每次推所有在线身份 { chart:true }', async () => {
  const notChart = await POST(ADMIN, '/api/claude/dispatch/chart/import', { html: '<html>随便一个页面</html>' });
  assert.deepEqual([notChart.status, notChart.json.error], [400, '这不是订阅 plan 性价比图']);
  assert.equal((await POST(ADMIN, '/api/claude/dispatch/chart/import', {})).status, 400, '没给 html');
  const tooBig = await POST(ADMIN, '/api/claude/dispatch/chart/import', { html: 'x'.repeat(CHART_MAX_BYTES + 1) });
  assert.deepEqual([tooBig.status, tooBig.json.error], [413, '文件太大：性价比图上限 12MB']);
  const huge = await POST(ADMIN, '/api/claude/dispatch/chart/import', { html: 'x'.repeat(2 * CHART_MAX_BYTES + 2 * 1024 * 1024) });
  assert.deepEqual([huge.status, huge.json.error], [413, '文件太大：性价比图上限 12MB'], '请求体本身超限');

  const a = listen(contextFor(ADMIN).key), b = listen(contextFor(PLAIN).key);
  try {
    const r = await POST(ADMIN, '/api/claude/dispatch/chart/import', { html: chartHtml(), name: 'C:\\Users\\x\\订阅plan性价比图.html' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.chart.source, r.json.chart.generated, r.json.chart.from, r.json.chart.name], ['imported', '2026-11-10', 'file', '订阅plan性价比图.html']);
    assert.equal(r.json.preview.chart.source, 'imported');
    const pts = await GET(PLAIN, '/api/claude/dispatch/chart/points');
    assert.equal(pts.status, 200);
    assert.equal(pts.json.generated, '2026-11-10');
    assert.equal(pts.json.points.length, 50);
    const c = await POST(ADMIN, '/api/claude/dispatch/chart/clear');
    assert.deepEqual([c.status, c.json.chart.source], [200, 'builtin']);
    assert.equal((await GET(ADMIN, '/api/claude/dispatch/chart/points')).json.points, null);
    for (const l of [a, b]) assert.deepEqual(l.seen, [{ type: 'claude.dispatch', chart: true }, { type: 'claude.dispatch', chart: true }]);
  } finally { a.off(); b.off(); }
});
