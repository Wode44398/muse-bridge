// dispatch.*（子 agent 调用策略）：经进程内请求走 /api/claude/dispatch*（routes/dispatch.mjs），权限、校验、落盘与设置页一致。
// 覆盖：读全貌与候选、改开关 / 范围 / 生效策略（名字 → id，同名报 conflict）、策略的新建 / 复制 / 按名字修改 / 校验、
// 删除（生效中的不能删）、没命令行的身份只读、图谱刷新只给管理员、写操作的 access 档、改完推总线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dispatch-ops-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: 'x'.repeat(32), features: { multiUser: true } }, null, 2));

const users = await import('../users.mjs');
const { INTERNAL_IDENTITY, contextFor } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerSessionRoutes } = await import('../routes/sessions.mjs');
const { registerDispatchRoutes } = await import('../routes/dispatch.mjs');
const { setInternalRouter, identityOfCtx } = await import('./internal.mjs');
const { callOp, OpError, getOp } = await import('./registry.mjs');
await import('./ops/index.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const { setChartRoot } = await import('../runtime/dispatch-chart.mjs');

setChartRoot(path.join(tmp, 'chart-root'));
// 临时目录不在用例里删：Windows 上 Node 24 的 rmSync 偶尔会卡住整个进程（同 settings-ops.test 不清理）
test.after(() => setChartRoot());

const identify = (req) => req[INTERNAL_IDENTITY] || { kind: 'none' };
const router = createRouter();
registerSessionRoutes(router, { authOk: () => false, identify });
registerDispatchRoutes(router, { identify });
setInternalRouter(router);

const adminId = { kind: 'admin', user: null };
const admin = contextFor(adminId);
const memberOf = async (name, tier) => {
  await users.createUser(name, 'pw-' + name + '-123', tier);
  const id = identityOfCtx(contextFor({ kind: 'user', user: users.getUser(name).id || name }));
  return { id, ctx: contextFor(id) };
};
const plain = await memberOf('dispplain', 'user');   // 普通（没有命令行）：只读
const pro = await memberOf('disppro', 'pro');        // 完全信任（有命令行）：能改自己的，不能动图谱
const run = (ctx, id, op, args = {}) => callOp(ctx, op, args, { via: 'mcp', identity: id });
const code = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof OpError, String(e)); return e.code; } };
const A = (op, args) => run(admin, adminId, op, args);

test('access：读的是 read，改的是 write，删策略是 danger；图谱刷新标 slow', () => {
  assert.equal(getOp('dispatch.get').access, 'read');
  for (const n of ['dispatch.set', 'dispatch.strategy_save', 'dispatch.chart_refresh']) assert.equal(getOp(n).access, 'write', n);
  assert.equal(getOp('dispatch.strategy_delete').access, 'danger');
  assert.equal(getOp('dispatch.chart_refresh').slow, true);
  assert.equal(getOp('dispatch.get').group, 'dispatch');
});

test('dispatch.get：默认全貌（总开关开、范围默认、一套「默认」、四档落点），candidates=true 另带候选', async () => {
  const r = await A('dispatch.get');
  assert.equal(r.enabled, true);
  assert.deepEqual(r.scope, { workflow: true, subagent: true, session: false });
  assert.equal(r.allowThirdParty, true);
  assert.deepEqual(r.active, { id: 's-00000000', name: '默认' });
  assert.equal(r.strategies.length, 1);
  assert.deepEqual(r.strategies[0], {
    id: 's-00000000', name: '默认', active: true,
    floors: { top: null, hard: null, normal: null, light: null }, overrides: { top: null, hard: null, normal: null, light: null }, note: '',
  });
  assert.deepEqual(r.tiers.map((t) => t.key), ['top', 'hard', 'normal', 'light']);
  for (const t of r.tiers) {
    assert.equal(t.source, 'chart');
    assert.ok(t.model && typeof t.ii === 'number' && typeof t.floor === 'number', JSON.stringify(t));
  }
  assert.equal(r.candidates, undefined);
  assert.deepEqual(r.you, { canEdit: true, canImport: true });
  assert.equal(r.note, undefined);
  assert.ok(r.chart && r.chart.source === 'builtin');
  const c = await A('dispatch.get', { candidates: true });
  assert.ok(c.candidates.length > 0 && c.candidates.every((x) => x.model && typeof x.ii === 'number'));
  assert.ok(Array.isArray(c.unrated));
  assert.deepEqual((await A('dispatch.get', { basis: 'custom' })).active.name, '默认');
  assert.equal(await code(A('dispatch.get', { basis: 'nope' })), 'bad_args');
});

test('dispatch.set：只改给了的，回报改动；值一样 = 没改动；什么都没给 / 不认识的范围拒；改完推总线', async () => {
  const seen = [];
  const fake = { writableEnded: false, write(s) { seen.push(JSON.parse(String(s).replace(/^data: /, ''))); return true; }, end() { this.writableEnded = true; } };
  const unsub = busSubscribe(admin.key, fake);
  try {
    const r = await A('dispatch.set', { scope: { session: true } });
    assert.deepEqual(r.changed, [{ key: 'scope.session', from: false, to: true }]);
    assert.deepEqual(r.scope, { workflow: true, subagent: true, session: true });
    assert.ok(seen.some((e) => e.type === 'claude.dispatch' && e.rev === r.rev), JSON.stringify(seen));
  } finally { unsub(); }
  const same = await A('dispatch.set', { scope: { session: true } });
  assert.deepEqual(same.changed, []);
  assert.match(same.note, /没有改动/);
  const off = await A('dispatch.set', { enabled: false, allow_third_party: false });
  assert.deepEqual(off.changed.map((c) => c.key).sort(), ['allowThirdParty', 'enabled']);
  await A('dispatch.set', { enabled: true, allow_third_party: true, scope: { session: false } });
  assert.equal(await code(A('dispatch.set', {})), 'bad_args');
  assert.equal(await code(A('dispatch.set', { scope: { nope: true } })), 'bad_args');
  assert.equal(await code(A('dispatch.set', { scope: { session: 'yes' } })), 'bad_args');
  assert.equal(await code(A('dispatch.set', { activate: '没有这套' })), 'not_found');
});

test('dispatch.strategy_save：新建不生效、带它自己的落点；按名字修改不改名；复制；判定线顺序与写法校验', async () => {
  const { candidates } = await A('dispatch.get', { candidates: true });
  const cell = candidates.find((c) => c.model === 'haiku') || candidates[candidates.length - 1];
  const r = await A('dispatch.strategy_save', { name: '省钱', floors: { hard: 40 }, overrides: { light: { model: cell.model, effort: cell.effort } } });
  assert.equal(r.created, true);
  assert.match(r.strategy.id, /^s-[0-9a-f]{8}$/);
  assert.deepEqual([r.strategy.name, r.strategy.active, r.strategy.floors.hard], ['省钱', false, 40]);
  assert.match(r.note, new RegExp('activate=' + r.strategy.id));
  const light = r.tiers.find((t) => t.key === 'light');
  assert.deepEqual([light.source, light.model, light.effort], ['override', cell.model, cell.effort || '']);
  assert.equal(r.tiers.find((t) => t.key === 'hard').floor, 40);
  assert.equal(r.warning, undefined);
  const id = r.strategy.id;
  // 生效的仍是「默认」
  assert.equal((await A('dispatch.get')).active.name, '默认');

  // 没给 id、name 正好是现有的：改那一套
  const m = await A('dispatch.strategy_save', { name: '省钱', note: '轻活别派 opus' });
  assert.equal(m.created, false);
  assert.deepEqual([m.strategy.id, m.strategy.name, m.strategy.note, m.strategy.floors.hard], [id, '省钱', '轻活别派 opus', 40]);

  // 指定的模型不在候选里：照存，但这一档按图谱选，给 warning
  const w = await A('dispatch.strategy_save', { id, overrides: { top: { model: 'custom:p-abcdef:no-such-model', effort: '' } } });
  assert.match(w.warning, /top/);
  assert.equal(w.tiers.find((t) => t.key === 'top').overrideSkipped, true);
  await A('dispatch.strategy_save', { id, overrides: { top: null } });

  // 复制：以「省钱」为底新建
  const cp = await A('dispatch.strategy_save', { copy_of: '省钱', name: '省钱 2' });
  assert.equal(cp.created, true);
  assert.notEqual(cp.strategy.id, id);
  assert.deepEqual([cp.strategy.name, cp.strategy.floors.hard, cp.strategy.note], ['省钱 2', 40, '轻活别派 opus']);

  // 校验：判定线要从高到低、写法不对的模型、什么都没给、改不存在的
  assert.equal(await code(A('dispatch.strategy_save', { id, floors: { top: 10, hard: 90 } })), 'bad_args');
  assert.equal(await code(A('dispatch.strategy_save', { id, overrides: { light: { model: 'gpt-9' } } })), 'bad_args');
  assert.equal(await code(A('dispatch.strategy_save', { id, floors: { huge: 1 } })), 'bad_args');
  assert.equal(await code(A('dispatch.strategy_save', {})), 'bad_args');
  assert.equal(await code(A('dispatch.strategy_save', { id: '没有这套', note: 'x' })), 'not_found');
  assert.equal(await code(A('dispatch.strategy_save', { copy_of: '没有这套', name: 'y' })), 'not_found');
});

test('dispatch.set activate：按名字切换；同名的两套报 conflict 并给出 id', async () => {
  const before = await A('dispatch.get');
  const cheap = before.strategies.find((s) => s.name === '省钱');
  const r = await A('dispatch.set', { activate: '省钱' });
  assert.deepEqual(r.changed, [{ key: 'active', from: '默认', to: '省钱' }]);
  assert.deepEqual(r.active, { id: cheap.id, name: '省钱' });
  assert.equal(r.tiers.find((t) => t.key === 'hard').floor, 40);
  // 把「省钱 2」改名成「省钱」：两套同名，按名字切报 conflict，hint 里有两个 id
  const twin = before.strategies.find((s) => s.name === '省钱 2');
  await A('dispatch.strategy_save', { id: twin.id, name: '省钱' });
  let err;
  try { await A('dispatch.set', { activate: '省钱' }); } catch (e) { err = e; }
  assert.equal(err?.code, 'conflict');
  assert.ok(err.hint.includes(cheap.id) && err.hint.includes(twin.id), err.hint);
  // id 照样能用
  assert.equal((await A('dispatch.set', { activate: 's-00000000' })).active.name, '默认');
  await A('dispatch.strategy_save', { id: twin.id, name: '省钱 2' });
});

test('dispatch.strategy_delete：生效中的不能删；按名字删；删完回报剩下的', async () => {
  assert.equal(await code(A('dispatch.strategy_delete', { id: '默认' })), 'bad_args', '生效中的那套');
  assert.equal(await code(A('dispatch.strategy_delete', { id: '没有这套' })), 'not_found');
  assert.equal(await code(A('dispatch.strategy_delete', {})), 'bad_args', 'id 必填');
  const r = await A('dispatch.strategy_delete', { id: '省钱 2' });
  assert.equal(r.deleted.name, '省钱 2');
  assert.deepEqual(r.remaining.map((s) => [s.name, s.active]), [['默认', true], ['省钱', false]]);
  const r2 = await A('dispatch.strategy_delete', { id: '省钱' });
  assert.deepEqual(r2.remaining, [{ id: 's-00000000', name: '默认', active: true }]);
  assert.equal(await code(A('dispatch.strategy_delete', { id: 's-00000000' })), 'bad_args');
});

test('没有命令行的成员：读到总开关关着的只读默认，写一律 forbidden', async () => {
  const r = await run(plain.ctx, plain.id, 'dispatch.get');
  assert.equal(r.enabled, false);
  assert.deepEqual(r.you, { canEdit: false, canImport: false });
  assert.match(r.note, /不能改调用策略/);
  assert.equal(await code(run(plain.ctx, plain.id, 'dispatch.set', { enabled: true })), 'forbidden');
  assert.equal(await code(run(plain.ctx, plain.id, 'dispatch.strategy_save', { name: 'x' })), 'forbidden');
  assert.equal(await code(run(plain.ctx, plain.id, 'dispatch.strategy_delete', { id: '默认' })), 'forbidden');
  assert.equal(await code(run(plain.ctx, plain.id, 'dispatch.chart_refresh')), 'forbidden');
});

test('有命令行的成员：改的是自己那份（不影响管理员的）；图谱刷新 forbidden', async () => {
  const r = await run(pro.ctx, pro.id, 'dispatch.get');
  assert.deepEqual([r.enabled, r.you.canEdit, r.you.canImport], [true, true, false]);
  const s = await run(pro.ctx, pro.id, 'dispatch.set', { scope: { workflow: false } });
  assert.deepEqual(s.changed, [{ key: 'scope.workflow', from: true, to: false }]);
  assert.equal((await A('dispatch.get')).scope.workflow, true, '管理员那份没动');
  let err;
  try { await run(pro.ctx, pro.id, 'dispatch.chart_refresh'); } catch (e) { err = e; }
  assert.equal(err?.code, 'forbidden');
  assert.match(err.hint, /管理员/);
});
