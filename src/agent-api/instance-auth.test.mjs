// 同机 agent 实例（dimensio）调 /agent/* 的凭据（instance-auth.mjs）：按人令牌 = 那个成员本人、主机密钥 = 管理员；
// 只认本机直连；伪造 / 篡改 / 换人 / 停用 / 删号 / 收回 dimensio 授权一律不认；设备组不给、媒体组按 设置 › Agent › Gemini 放行；铸不了 agent 密钥。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-instance-auth-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
const MASTER = 'master-token-for-instance-auth-tests-01';
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: MASTER, features: { multiUser: true, remoteAdmin: true } }, null, 2));

const users = await import('../users.mjs');
const { createAuth } = await import('../auth.mjs');
const { makeIdentify } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerAgentApiRoutes } = await import('./http.mjs');
const { mintAgentDeviceToken } = await import('../runtime/agent-device-token.mjs');
const { ensureHostSecret } = await import('../runtime/host-secret.mjs');
const { allOps } = await import('./registry.mjs');
const { instanceExcluded } = await import('./instance-auth.mjs');
const { setVertexSettings } = await import('../runtime/vertex-settings.mjs');

const auth = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
const identify = makeIdentify({ authOk: auth.authOk, getCookie: auth.getCookie, bearerToken: auth.bearerToken, queryToken: auth.queryToken });
const router = createRouter();
registerAgentApiRoutes(router, { identify, adminGen: auth.gen });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
after(() => server.close());

const call = async (op, args = {}, tok = '', headers = {}) => {
  const r = await fetch(base + '/agent/v1/' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json() };
};
const catalogOf = async (tok) => (await (await fetch(base + '/agent/v1', { headers: { authorization: 'Bearer ' + tok } })).json());

const frank = await users.createUser('frank', 'password123', 'pro');
assert.ok(frank.ok, frank.error);
users.setAgents('frank', ['claude', 'dimensio']);
const alice = await users.createUser('alice', 'password123', 'pro');
assert.ok(alice.ok, alice.error);
users.setAgents('alice', ['claude', 'dimensio']);
const FRANK = mintAgentDeviceToken(frank.id);

test('按人令牌：就是那个成员本人；主机密钥：管理员', async () => {
  const me = await call('whoami', {}, FRANK);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.data.you.kind, 'member');
  assert.equal(me.body.data.you.account, 'frank');
  const host = await call('whoami', {}, ensureHostSecret());
  assert.equal(host.body.ok, true);
  assert.equal(host.body.data.you.kind, 'host');
  // X-Bridge-Key 同样认
  assert.equal((await call('whoami', {}, '', { 'x-bridge-key': FRANK })).body.data.you.account, 'frank');
  // 手册带身份也照常给
  const man = await fetch(base + '/agent/manual?q=定时任务', { headers: { authorization: 'Bearer ' + FRANK } });
  assert.equal(man.status, 200);
});

test('设备组不给、媒体组默认不给：目录里标不可用，调用回 403；其余照常', async () => {
  for (const tok of [FRANK, ensureHostSecret()]) {
    const cat = await catalogOf(tok);
    assert.equal(cat.ok, true);
    const excluded = cat.ops.filter((o) => instanceExcluded(o.name));
    assert.ok(excluded.some((o) => o.name === 'devices.list') && !excluded.some((o) => o.name.startsWith('media.')));
    for (const o of excluded) assert.equal(o.available, false, o.name);
    // 媒体组：管理员没在 设置 › Agent › Gemini 打开 dimensio 之前不可用，原因指到那里
    const img = cat.ops.find((o) => o.name === 'media.image');
    assert.equal(img.available, false);
    assert.match(img.unavailableReason, /设置 › Agent › Gemini|不能生成媒体/);
    assert.ok(cat.ops.find((o) => o.name === 'feedback.diagnose').available);
    const r = await call('devices.list', {}, tok);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'forbidden');
    assert.equal((await call('media.image', { prompt: 'x' }, tok)).status, 403);
  }
  // 普通 agent 密钥不受这条限制（只管实例入口）
  const k = users.createAgentKey({ user: frank.id }, { label: 'plain' });
  assert.equal((await catalogOf(k.token)).ops.find((o) => o.name === 'devices.list').available, true);
  users.revokeAgentKey({ user: frank.id }, k.id);
});

test('媒体组按实例放行：打开 dimensio 后它那一项不再被设置挡；主机密钥没自报身份的照样不给', async () => {
  const reasonOf = async (tok) => (await catalogOf(tok)).ops.find((o) => o.name === 'media.image').unavailableReason || '';
  assert.equal(setVertexSettings({ dimensioMedia: true }).ok, true);
  try {
    // 测试环境里没装 Vertex 扩展 → 还是不可用，但原因换成了 agent 开关（设置这一关已经过了）
    assert.doesNotMatch(await reasonOf(FRANK), /设置 › Agent › Gemini/);
    assert.match(await reasonOf(ensureHostSecret()), /不能生成媒体/);
    // 种类单独关：dimensio 开着也挡
    assert.equal(setVertexSettings({ agentImage: false }).ok, true);
    assert.match(await reasonOf(FRANK), /生成图片/);
  } finally {
    setVertexSettings({ dimensioMedia: null, agentImage: null });
  }
});

test('bug 诊断：成员看不到服务端日志，管理员看得到', async () => {
  const m = await call('feedback.diagnose', {}, FRANK);
  assert.equal(m.body.ok, true);
  assert.equal(m.body.data.logs, null);
  const a = await call('feedback.diagnose', {}, ensureHostSecret());
  assert.ok(Array.isArray(a.body.data.logs));
});

test('只认本机直连：带隧道 / 代理转发头一律不认', async () => {
  for (const h of [{ 'cf-connecting-ip': '1.2.3.4' }, { 'x-forwarded-for': '1.2.3.4' }]) {
    assert.equal((await call('whoami', {}, FRANK, h)).status, 401);
    assert.equal((await call('whoami', {}, ensureHostSecret(), h)).status, 401);
  }
});

test('伪造 / 篡改 / 换人：一律不认', async () => {
  const [p, agent, idPart, sig] = FRANK.split('.');
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
  const wrongKey = createHmac('sha256', 'not-the-host-secret').update(`bridge-agent-device-v1\n${agent}\n${frank.id}`).digest('base64url');
  const flip = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  const bad = [
    `${p}.${agent}.${idPart}.${wrongKey}`,                 // 别的密钥签的
    `${p}.${agent}.${idPart}.${flip}`,                     // 改了一个字符
    `${p}.${agent}.${b64(alice.id)}.${sig}`,               // 拿 frank 的签名冒充 alice
    `${p}.codex.${idPart}.${sig}`,                         // 不认的 agent
    `${p}.${agent}.${idPart}`,                             // 缺段
    ensureHostSecret().slice(0, -1) + 'x',                 // 主机密钥差一个字符
  ];
  for (const t of bad) {
    const r = await call('whoami', {}, t);
    assert.equal(r.status, 401, t);
    assert.equal((await catalogOf(t)).ok, false, t);
  }
  // alice 自己的令牌是 alice，不是 frank
  assert.equal((await call('whoami', {}, mintAgentDeviceToken(alice.id))).body.data.you.account, 'alice');
});

test('收回 dimensio 授权、停用、删号：当场失效', async () => {
  users.setAgents('frank', ['claude']);
  assert.equal((await call('whoami', {}, FRANK)).status, 401);
  users.setAgents('frank', ['claude', 'dimensio']);
  users.setDisabled('frank', true);
  assert.equal((await call('whoami', {}, FRANK)).status, 401);
  users.setDisabled('frank', false);
  assert.equal((await call('whoami', {}, FRANK)).status, 200);
  const tmpUser = await users.createUser('gone', 'password123', 'pro');
  users.setAgents('gone', ['dimensio']);
  const GONE = mintAgentDeviceToken(tmpUser.id);
  assert.equal((await call('whoami', {}, GONE)).status, 200);
  users.deleteUser('gone');
  assert.equal((await call('whoami', {}, GONE)).status, 401);
});

test('铸不了 agent 密钥：操作表里没有铸密钥的操作，设置页接口不认实例凭据', async () => {
  assert.ok(!allOps().some((op) => /^keys\./.test(op.name) && !/^keys\.(list|revoke)$/.test(op.name)), '密钥组只有列出 / 吊销');
  for (const tok of [FRANK, ensureHostSecret()]) {
    const r = await fetch(base + '/api/agent-keys/create', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.equal((await fetch(base + '/api/agent-keys', { headers: { authorization: 'Bearer ' + tok } })).status, 401);
  }
  assert.equal(users.listAgentKeys({ user: frank.id }).length, 0);
});
