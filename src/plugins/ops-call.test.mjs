// 八期：ctx.ops.call（plugins/ops-call.mjs）——插件以某个身份调只读 agent 操作；审批策略回 'ask'（plugins/claude-tools.mjs）；能力名。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-ops-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const CT = await import('./claude-tools.mjs');
const { PLUGIN_FEATURES } = await import('./engines.mjs');
const { PERMISSIONS } = await import('./discover.mjs');
const { defineOp, removeOp } = await import('../agent-api/registry.mjs');

installMixins();
kernel.provide('router', { on: () => () => {}, use: () => () => {}, prefix: () => () => {}, has: () => false });

const HOST = { kind: 'admin', sandbox: false, key: 'admin' };
const SHARE = { kind: 'share', key: 'share:x' };
const calls = [];
const ops = [
  defineOp({ name: 'opsprobe.echo', title: 't', params: { n: { type: 'integer', default: 1 } }, handler: async (ctx, args, env) => {
    calls.push({ kind: ctx.kind, args, via: env.via, plugin: env.plugin, identity: env.identity });
    return { n: args.n, inner: { at: 1 } };
  } }),
  defineOp({ name: 'opsprobe.hostonly', title: 't', need: ['server.manage'], handler: async () => ({ ok: true }) }),
  defineOp({ name: 'opsprobe.write', title: 't', access: 'write', handler: async () => ({ ok: true }) }),
];

let c;
test.before(async () => {
  await kernel.start();
  await kernel.register({
    id: 'ops-b', name: 'ops-b', source: 'local', dir: tmp, pluginApi: 3,
    load: async () => ({ apply: (ctx) => {
      c = ctx;
      ctx.claude.permission(({ tool, input }) => (tool === 'mcp__bridge__call' && input?.args?.agent === 'agy' ? 'ask' : tool === 'X' ? { ask: true, message: '先问我' } : undefined));
    } }),
  });
  await kernel.setEnabled('ops-b', true);
});
test.after(() => {
  for (const op of ops) removeOp(op);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('能力名与权限词条：ops.call / claude.permission.ask / events.via', () => {
  for (const f of ['ops.call', 'claude.permission.ask', 'events.via']) {
    assert.ok(PLUGIN_FEATURES.includes(f), f);
    assert.equal(c.has(f), true, f);
  }
  assert.ok(PERMISSIONS.ops);
});

test('ctx.ops.call：缺省按服务器主机；参数照操作表校验；返回副本', async () => {
  calls.length = 0;
  const r = await c.ops.call('opsprobe.echo', { n: 3 });
  assert.deepEqual(r, { n: 3, inner: { at: 1 } });
  assert.equal(calls[0].kind, 'admin');
  assert.equal(calls[0].via, 'plugin');
  assert.equal(calls[0].plugin, 'ops-b');
  assert.equal(calls[0].identity.kind, 'admin');
  assert.deepEqual((await c.ops.call('opsprobe.echo')).n, 1, '没给 args 用缺省值');
  await assert.rejects(c.ops.call('opsprobe.echo', { m: 1 }), (e) => e.code === 'bad_args');
  await assert.rejects(c.ops.call('opsprobe.echo', [1]), (e) => e.code === 'bad_args');
  assert.deepEqual(await c.ops.call('opsprobe.hostonly', {}, { who: HOST }), { ok: true });
});

test('ctx.ops.call：只读；按身份判权限；不认识的、非登录身份都拒', async () => {
  await assert.rejects(c.ops.call('opsprobe.write'), (e) => e.code === 'forbidden' && /只读/.test(e.message));
  await assert.rejects(c.ops.call('opsprobe.nope'), (e) => e.code === 'not_found');
  await assert.rejects(c.ops.call('bad name'), (e) => e.code === 'bad_args');
  await assert.rejects(c.ops.call('opsprobe.echo', {}, { who: SHARE }), (e) => e.code === 'forbidden');
  await assert.rejects(c.ops.call('opsprobe.echo', {}, { who: 'host' }), (e) => e.code === 'bad_args');
});

test("审批策略回 'ask'：给出 behavior 'ask' 与理由；不表态仍是 null", async () => {
  const turn = { kind: 'chat', ctx: HOST, snap: null, sessionId: 's1' };
  const a = await CT.pluginPermission(turn, { tool: 'mcp__bridge__call', input: { op: 'chat.send', args: { agent: 'agy' } } });
  assert.equal(a.behavior, 'ask');
  assert.equal(a.by, 'ops-b');
  const b = await CT.pluginPermission(turn, { tool: 'X', input: {} });
  assert.deepEqual([b.behavior, b.message], ['ask', '先问我']);
  assert.equal(await CT.pluginPermission(turn, { tool: 'mcp__bridge__call', input: { op: 'sessions.list', args: {} } }), null);
});

test('ctx.claude.ensureProject：不是项目就建，已是就原样返回；路径不合格拒', async () => {
  const { busSubscribe } = await import('../runtime/bus.mjs');
  const { mkdirSync } = await import('node:fs');
  const got = [];
  const off = busSubscribe('admin', { write: (s) => { try { got.push(JSON.parse(String(s).replace(/^data:\s*/, ''))); } catch {} return true; }, on() {}, once() {}, end() {}, writeHead() {}, setHeader() {}, flushHeaders() {} });
  const dir = path.join(tmp, 'Collab Proj');
  mkdirSync(dir, { recursive: true });
  const a = await c.claude.ensureProject(dir, { name: '协作' });
  assert.equal(a.created, true);
  assert.equal(a.name, '协作');
  assert.ok(a.id);
  const b = await c.claude.ensureProject(dir + path.sep);
  assert.deepEqual([b.id, b.created], [a.id, false]);
  await assert.rejects(c.claude.ensureProject('relative/x'), /绝对路径/);
  await assert.rejects(c.claude.ensureProject(path.join(tmp, 'nope')), /不存在/);
  try { off?.(); } catch {}
  assert.ok(c.has('claude.ensureProject'));
});

test('消息改写的 hint：包进 <session-hint> 放最前面、尖括号换掉；不给就不动', async () => {
  await kernel.register({
    id: 'hint-b', name: 'hint-b', source: 'local', dir: tmp, pluginApi: 3,
    load: async () => ({ apply: (ctx) => { ctx.claude.input(({ message }, turn) => (turn.via === 'agy' ? { hint: '这条来自 <Antigravity>，不是用户本人' } : undefined)); } }),
  });
  await kernel.setEnabled('hint-b', true);
  const turn = { kind: 'chat', ctx: HOST, snap: null, sessionId: 's1' };
  const r = await CT.pluginInput({ ...turn, via: 'agy' }, { message: '帮我出 apk', attachments: [] });
  assert.equal(r.message, '<session-hint>这条来自 ‹Antigravity›，不是用户本人</session-hint>\n\n帮我出 apk');
  assert.equal(r.changed, true);
  const plain = await CT.pluginInput(turn, { message: '你好', attachments: [] });
  assert.deepEqual([plain.message, plain.changed], ['你好', false]);
  assert.ok(c.has('claude.input.hint') && c.has('claude.permission.agy'));
  await kernel.setEnabled('hint-b', false);
});

test('会话标题：hint 旁注不进标题（trimTitle 剥 session-hint）', async () => {
  const { trimTitle } = await import('../routes/sessions/transcript-text.mjs');
  assert.equal(trimTitle('<session-hint>这条「来自 Antigravity」，不是用户本人</session-hint>\n\n出 apk 验脚注窄屏'), '出 apk 验脚注窄屏');
});
