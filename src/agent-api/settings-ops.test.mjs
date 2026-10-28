// settings.claude / settings.claude_set / chat.models 与 overview 的「被中断」清单：经进程内请求走现成路由
//（/api/claude/settings、/api/claude/providers），权限与校验跟设置页一致，API Key 不出服务端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-settings-ops-'));
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
const { registerClaudeProviderRoutes } = await import('../routes/claude-providers.mjs');
const { setInternalRouter, identityOfCtx } = await import('./internal.mjs');
const { callOp, OpError } = await import('./registry.mjs');
await import('./ops/index.mjs');
const S = await import('../runtime/claude-settings.mjs');
const P = await import('../runtime/claude-providers.mjs');
const inflight = await import('../runtime/inflight.mjs');

const identify = (req) => req[INTERNAL_IDENTITY] || { kind: 'none' };
const router = createRouter();
registerSessionRoutes(router, { authOk: () => false, identify });
registerClaudeProviderRoutes(router, { identify });
setInternalRouter(router);

const adminId = { kind: 'admin', user: null };
const admin = contextFor(adminId);
await users.createUser('setops', 'pw-setops-123', 'user');
const memberCtx0 = contextFor({ kind: 'user', user: users.getUser('setops').id || 'setops' });
const memberId = identityOfCtx(memberCtx0);
const member = contextFor(memberId);
const env = (identity) => ({ via: 'mcp', identity });
const run = (ctx, id, op, args = {}) => callOp(ctx, op, args, env(id));
const code = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof OpError, String(e)); return e.code; } };
const item = (r, k) => r.settings.find((s) => s.key === k);

test('settings.claude：管理员看得到主机级项与「自动继续被中断的对话」，带分组名与可选值', async () => {
  const r = await run(admin, adminId, 'settings.claude');
  const ar = item(r, 'autoResumeOnRestart');
  assert.equal(ar.value, true);
  assert.equal(ar.group, '服务意外重启时');
  assert.equal(item(r, 'allowBypass').scope, 'host');
  assert.equal(item(r, 'allowBypass').confirm, true);
  assert.ok(item(r, 'questionTimeout').options.some((o) => o.value === '10m' && o.label === '10 分钟后继续'));
  assert.equal(item(r, 'newChatLanding').noUi, true);
  assert.equal(item(r, 'notifyPermission'), undefined, '只存设备上的项不列');
});

test('settings.claude_set：改了落盘、回报改动；null 恢复默认；不认识的键与设备项都拒', async () => {
  const r = await run(admin, adminId, 'settings.claude_set', { values: { autoResumeOnRestart: false } });
  assert.deepEqual(r.changed, [{ key: 'autoResumeOnRestart', label: '自动继续被中断的对话', from: true, to: false }]);
  assert.equal(S.getClaudeSettings(admin).autoResumeOnRestart, false);
  assert.equal(item(await run(admin, adminId, 'settings.claude'), 'autoResumeOnRestart').value, false);
  assert.equal((await run(admin, adminId, 'settings.claude_set', { values: { autoResumeOnRestart: false } })).changed.length, 0);
  await run(admin, adminId, 'settings.claude_set', { values: { autoResumeOnRestart: null } });
  assert.equal(S.getClaudeSettings(admin).autoResumeOnRestart, true);
  assert.equal(await code(run(admin, adminId, 'settings.claude_set', { values: { nope: 1 } })), 'bad_args');
  assert.equal(await code(run(admin, adminId, 'settings.claude_set', { values: { notifyPermission: false } })), 'bad_args');
  assert.equal(await code(run(admin, adminId, 'settings.claude_set', { values: { autoArchiveDays: 3 } })), 'bad_args', '不在可选值里');
  assert.equal(await code(run(admin, adminId, 'settings.claude_set', { values: {} })), 'bad_args');
});

test('settings.claude_set：高风险开关要 confirm', async () => {
  assert.equal(await code(run(admin, adminId, 'settings.claude_set', { values: { allowBypass: true } })), 'conflict');
  assert.equal(S.getClaudeSettings(admin).allowBypass, false);
  await run(admin, adminId, 'settings.claude_set', { values: { allowBypass: true }, confirm: true });
  assert.equal(S.getClaudeSettings(admin).allowBypass, true);
  await run(admin, adminId, 'settings.claude_set', { values: { allowBypass: false } });
  assert.equal(S.getClaudeSettings(admin).allowBypass, false, '关掉不用 confirm');
});

test('成员：看不到主机级 / 管理员项，改不了；自己的项照改', async () => {
  const r = await run(member, memberId, 'settings.claude');
  assert.equal(item(r, 'allowBypass'), undefined);
  assert.equal(item(r, 'crossSessionInbound'), undefined);
  assert.ok(item(r, 'autoResumeOnRestart'));
  assert.equal(await code(run(member, memberId, 'settings.claude_set', { values: { allowBypass: true }, confirm: true })), 'forbidden');
  await run(member, memberId, 'settings.claude_set', { values: { autoResumeOnRestart: false } });
  assert.equal(S.getClaudeSettings(member).autoResumeOnRestart, false);
  assert.equal(S.getClaudeSettings(admin).autoResumeOnRestart, true, '各管各的');
});

test('chat.models：订阅模型 + 自己的自定义模型，Key 不出服务端，成员看不到主机的服务', async () => {
  P.createProvider({ name: '测试服务', baseUrl: 'https://api.example.com', apiKey: 'sk-secret-should-not-leak', models: [{ id: 'm-one', label: 'M One' }] });
  const r = await run(admin, adminId, 'chat.models');
  assert.ok(r.builtin.models.length > 0 && r.builtin.default);
  assert.equal(r.custom.length, 1);
  assert.match(r.custom[0].id, /^custom:p-[0-9a-f]+:m-one$/);
  assert.equal(r.custom[0].provider, '测试服务');
  assert.equal(r.services[0].hasKey, true);
  assert.doesNotMatch(JSON.stringify(r), /sk-secret|keyTail/);
  const m = await run(member, memberId, 'chat.models');
  assert.equal(m.custom.length, 0, '成员的注册表是自己那份');
  assert.equal(m.maxServices, P.MEMBER_MAX_PROVIDERS);
});

test('overview：被服务重启打断、还没人看过的会话列在 claude.interrupted', async () => {
  const root = path.join(tmp, 'inflight');
  mkdirSync(root, { recursive: true });
  const sid = '0123abcd-0000-4000-8000-000000000001';
  writeFileSync(path.join(root, 'inflight-runs.json'), JSON.stringify([{ key: admin.key, sessionId: sid, userText: '整理周报', startedAt: Date.now() - 5000, cwd: tmp }]));
  inflight.initInflight(root);
  const o = await run(admin, adminId, 'overview');
  assert.deepEqual(o.claude.interrupted.map((x) => [x.sessionId, x.prompt]), [[sid, '整理周报']]);
  inflight.setResuming(admin.key, sid, true);
  assert.equal((await run(admin, adminId, 'overview')).claude.interrupted[0].autoResume, true);
  assert.equal((await run(member, memberId, 'overview')).claude.interrupted, undefined, '别人的看不到');
});

test('whoami：带部署形态 hosting 与发行版品牌（本体不带 distro）', async () => {
  const w = await run(admin, adminId, 'whoami');
  assert.ok(['host', 'server'].includes(w.server.hosting));
  assert.equal(w.server.brand, 'The Bridge');
  assert.equal(w.server.distro, undefined);
});
