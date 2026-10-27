// 账号生命周期（开源路线 S2-2 / S2-3 / S2-4）的契约：
//   · 不可变账号 id：新账号 id = 名字-随机串，目录 / owner 键 / 用量 / 会话都挂在 id 上；老账号（没有 id 字段）id = 用户名，零迁移；
//   · 删号后同名重新注册拿到全新 id，继承不到旧人的目录、用量、设备；改登录名不动 id；
//   · 「完全信任」（存储值仍是 'pro'）：老账号缺 tier 照旧是完全信任、标「待确认」；升档 / 发码 / 建号要 ack；
//   · 邀请码有效期与作废；
//   · 设备令牌跟着登记它的那次登录走：退出 / 停用 / 删号即失效，401 区分 revoked / signed-out / account / unknown；
//     吊销后同一次登录不能自动登记回来（409），重新登录后可以；
//   · 删号联动：设备（留墓碑）、端口转发、用量、邀请记录、管理员可见性记录，数据删除或归档；停用时关掉他铸的聊天快照；
//   · 「给别人用」开关只改 config.json 的 features.multiUser，其余配置原样；
//   · 降为普通当场生效（在跑的轮中止）；账号名 / id 只认自己的键（__proto__ 改不到原型上）；
//   · 升级前登记的成员设备回一次 signed-out、重新登记即绑上登录；升级前的完全信任码标 legacyFull；
//   · 删号时页面没断开 → 数据记 pending、断开后再处理；最近写过的会话的停放 CLI 一并关掉。
// 真起 http 服务，鉴权走真的 createAuth + makeIdentify（同 server.mjs 的接法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-acctlife-'));
// 临时目录在进程退出那一刻再删，别放进 test.after：users.mjs 用 fs.watch 盯着 <tmp>/users/_system，
// Windows 上被盯着的目录一删，那个 watcher 会空转并拖住进程不退出（整个 node --test 卡死）。'exit' 时事件循环已停，没这个问题。
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_CLIENT_UPDATE_FEED = '';
for (const k of ['BRIDGE_SUPERVISED', 'INVOCATION_ID', 'JOURNAL_STREAM', 'pm_id', 'PM2_HOME', 'BRIDGE_AUDIENCE', 'BRIDGE_EDITION']) delete process.env[k];
const MASTER = 'master-token-for-acct-tests-0123456789';
// 预置 config.json：多用户开着（才认普通账号的登录会话），外加一个无关键，验证开关只改 features.multiUser
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: MASTER, features: { multiUser: true, remoteAdmin: true }, keepMe: { a: 1 } }, null, 2));

// 老数据：分档 / 账号 id 之前的账号（没有 id、没有 tier）与它的登录会话、用量、目录
const SYS = path.join(tmp, 'users', '_system');
mkdirSync(SYS, { recursive: true });
mkdirSync(path.join(tmp, 'users', 'oldfriend', '.bridge'), { recursive: true });
writeFileSync(path.join(SYS, 'users.json'), JSON.stringify({
  oldfriend: { name: 'oldfriend', salt: 'x', hash: 'y', created: 1, disabled: false },
  snapowner: { name: 'snapowner', salt: 'x', hash: 'y', created: 2, disabled: false, tier: 'user', snapshot: true },
}));
writeFileSync(path.join(SYS, 'usage.json'), JSON.stringify({ oldfriend: { tokens: 5, calls: 1, costUsd: 0.5 } }));
// snapowner 铸的一个还开着的聊天快照（停用他时要一并关掉）；快照模块第一次被 import 时读这份
const SNAP_TOKEN = 'snaptok-0123456789abcdef0123';
writeFileSync(path.join(tmp, 'chat-snapshots.json'), JSON.stringify({ [SNAP_TOKEN]: { owner: 'u:snapowner', createdAt: Date.now(), lastTouch: Date.now() } }));

const users = await import('./users.mjs');
const { createAuth } = await import('./auth.mjs');
const { makeIdentify, contextFor, userIdentity } = await import('./runtime/identity.mjs');
const { createRouter } = await import('./runtime/router.mjs');
const { registerDeviceRoutes } = await import('./routes/devices.mjs');
const { registerAdminRoutes } = await import('./routes/admin.mjs');
const { registerAuthRoutes } = await import('./routes/auth.mjs');
const registry = await import('./runtime/device-registry.mjs');
const forwards = await import('./runtime/device-forward.mjs');
const lifecycle = await import('./runtime/account-lifecycle.mjs');
const { userRoot, NATIVE_ROOT, CONFIG_PATH } = await import('./config/index.mjs');

const auth = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
const identify = makeIdentify({ authOk: auth.authOk, getCookie: auth.getCookie, bearerToken: auth.bearerToken, queryToken: auth.queryToken });
const router = createRouter();
registerAuthRoutes(router, { ...auth, adminGen: auth.gen, identify });
registerDeviceRoutes(router, { identify, adminCredential: auth.adminCredential, adminGen: auth.gen });
registerAdminRoutes(router, { authOk: auth.authOk, adminCredential: auth.adminCredential, adminGen: auth.gen });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(() => { server.closeAllConnections?.(); server.close(); });

const call = async (method, p, { bearer = '', body } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { code: r.status, body: await r.json().catch(() => null) };
};
const admin = (p, body) => call('POST', p, { bearer: MASTER, body });
const login = async (name, pw = 'password123') => (await call('POST', '/api/login', { body: { username: name, password: pw } })).body?.token;
const register = (bearer, machineId = 'machine-1') => call('POST', '/api/devices/register', { bearer, body: { name: 'pc', platform: 'win32', hostname: 'pc', machineId } });
const whoami = (deviceToken) => call('GET', '/api/device/whoami', { bearer: deviceToken });

test('老账号零迁移：没有 id = id 就是用户名；缺 tier = 完全信任（存储值 pro）且待确认；目录 / 用量键不变', () => {
  const rec = users.getUser('oldfriend');
  assert.equal(users.accountId(rec), 'oldfriend');
  const row = users.listUsers().find((u) => u.name === 'oldfriend');
  assert.equal(row.id, 'oldfriend');
  assert.equal(row.tier, 'pro');
  assert.equal(row.trustPending, true, '分档之前的账号等管理员确认，不自动降级');
  assert.equal(users.getUsage('oldfriend').costUsd, 0.5);
  const id = userIdentity('oldfriend');
  assert.equal(id.user, 'oldfriend');
  assert.equal(contextFor(id).key, 'u:oldfriend');
  assert.equal(contextFor(id).cwd, userRoot('oldfriend'));
  // 读老数据不写盘：users.json 原样
  assert.equal(JSON.parse(readFileSync(path.join(SYS, 'users.json'), 'utf8')).oldfriend.tier, undefined);
  assert.equal(users.ackTrust('oldfriend').ok, true);
  assert.equal(users.listUsers().find((u) => u.name === 'oldfriend').trustPending, false);
  assert.equal(users.getUser('oldfriend').tier, 'pro', '确认时写成显式值');
});

test('新账号：id = 名字-随机串，目录按 id 建；按名字或 id 都找得到；名字不能等于别人的 id', async () => {
  const r = await users.createUser('alice', 'password123', 'user');
  assert.ok(r.ok);
  assert.match(r.id, /^alice-[a-z2-9]{4}$/);
  assert.ok(existsSync(path.join(userRoot(r.id), '.bridge')));
  assert.equal(existsSync(userRoot('alice')), false, '不再按名字建目录');
  assert.equal(users.getUser(r.id).name, 'alice');
  assert.equal(users.getUserById(r.id).name, 'alice');
  assert.equal((await users.createUser(r.id, 'password123', 'user')).error, '该用户名已被占用');
  // 登录：会话落 id，身份的 user = id、name = 登录名，/api/auth 回登录名 + uid + key
  const tok = await login('alice');
  assert.ok(tok);
  const s = users.getSession(tok);
  assert.equal(s.user, 'alice');
  assert.equal(s.id, r.id);
  const me = await call('GET', '/api/auth', { bearer: tok });
  assert.equal(me.body.user, 'alice');
  assert.equal(me.body.uid, r.id);
  assert.equal(me.body.key, 'u:' + r.id);
  // 部署形态两分（前端「电脑 / 服务器」措辞）：照 config/deploy-profile.mjs 的 hosting 下发
  assert.equal(me.body.hosting, (await import('./config/index.mjs')).DEPLOY.hosting);
  assert.ok(['host', 'server'].includes(me.body.hosting));
  // 用量按 id 记，传名字也认
  users.addUsage(r.id, { tokens: 10, costUsd: 1 });
  assert.equal(users.getUsage('alice').costUsd, 1);
});

test('改登录名：id、会话、用量都不动；旧名字（= 老账号的 id）别人注册不了', async () => {
  const tok = await login('alice');
  const id = users.accountIdOf('alice');
  const r = users.renameUser('alice', 'alicia');
  assert.equal(r.ok, true);
  assert.equal(r.id, id);
  assert.equal(users.getSession(tok).user, 'alicia', '已登录的会话照常，显示新名字');
  assert.equal(users.getUsage('alicia').costUsd, 1);
  assert.ok(await login('alicia'));
  assert.equal(await login('alice'), undefined, '旧名字登不上了');
  // 老账号改名：id 留在旧名字上，旧名字从此被占着
  assert.equal(users.renameUser('oldfriend', 'newfriend').id, 'oldfriend');
  assert.equal((await users.createUser('oldfriend', 'password123', 'user')).error, '该用户名已被占用');
  assert.equal(contextFor(userIdentity('newfriend')).cwd, userRoot('oldfriend'), '目录还是原来那个');
  users.renameUser('newfriend', 'oldfriend');
  assert.equal(users.getUser('oldfriend').id, 'oldfriend', '改回原名也行');
});

test('完全信任要 ack：发码 / 建号 / 升档；降为普通随时可以并清掉确认', async () => {
  assert.equal((await admin('/api/admin/invite', { tier: 'pro' })).code, 400);
  const ok = await admin('/api/admin/invite', { tier: 'pro', ack: true });
  assert.equal(ok.code, 200);
  assert.ok(ok.body.expiresAt > Date.now());
  assert.equal((await admin('/api/admin/user/create', { name: 'bob', password: 'password123', tier: 'pro' })).code, 400);
  const c = await admin('/api/admin/user/create', { name: 'bob', password: 'password123', tier: 'pro', ack: true });
  assert.equal(c.code, 200);
  assert.equal(users.listUsers().find((u) => u.name === 'bob').trustPending, false);
  assert.equal((await admin('/api/admin/user/tier', { name: 'bob', tier: 'user' })).code, 200);
  assert.equal(users.getUser('bob').trustAck, undefined);
  assert.equal((await admin('/api/admin/user/tier', { name: 'bob', tier: 'pro' })).code, 400, '升档没 ack 被拒');
  assert.equal((await admin('/api/admin/user/tier', { name: 'bob', tier: 'pro', ack: true })).code, 200);
  // 用确认过的完全信任码注册：直接记为已确认
  const reg = await call('POST', '/api/register', { body: { username: 'carol', password: 'password123', password2: 'password123', invite: ok.body.code } });
  assert.equal(reg.code, 200);
  const carol = users.listUsers().find((u) => u.name === 'carol');
  assert.equal(carol.tier, 'pro');
  assert.equal(carol.trustPending, false);
});

test('邀请码：过期不认、没用的能作废、老码（没有 expiresAt）不过期', async () => {
  const code = users.createInvite('user', { ttlMs: 60_000 });
  const inv = JSON.parse(readFileSync(path.join(SYS, 'invites.json'), 'utf8'));
  inv[code].expiresAt = Date.now() - 1; inv.legacyCode = { created: 1, used: false, usedBy: null, tier: 'user' };
  writeFileSync(path.join(SYS, 'invites.json'), JSON.stringify(inv));
  assert.equal(users.consumeInvite(code, 'x'), null, '过期');
  assert.equal(users.listInvites().find((i) => i.code === code).expired, true);
  const fresh = users.createInvite('user');
  assert.equal((await admin('/api/admin/invite/revoke', { code: fresh })).code, 200);
  assert.equal(users.consumeInvite(fresh, 'x'), null, '作废了');
  assert.equal(users.consumeInvite('legacyCode', 'x'), 'user', '老码照常能用');
  users.revertInvite('legacyCode');
});

test('设备跟着登记它的那次登录走：退出即失效（signed-out），重新登录可以再登记', async () => {
  await users.createUser('dave', 'password123', 'user');
  const tok = await login('dave');
  const reg = await register(tok);
  assert.equal(reg.code, 200);
  assert.equal((await whoami(reg.body.token)).code, 200);
  assert.equal(registry.deviceById(reg.body.device.id).login.kind, 'user');
  await call('POST', '/api/logout', { bearer: tok });
  const w = await whoami(reg.body.token);
  assert.equal(w.code, 401);
  assert.equal(w.body.reason, 'signed-out');
  const tok2 = await login('dave');
  const again = await register(tok2);
  assert.equal(again.code, 200);
  assert.equal(again.body.device.id, reg.body.device.id, '同一台电脑复用原设备 id');
  assert.equal((await whoami(again.body.token)).code, 200);
});

test('吊销：401 说 revoked（不是「不认识」）；同一次登录自动登记被拒（409），重新登录后可以', async () => {
  await users.createUser('erin', 'password123', 'user');
  const tok = await login('erin');
  const reg = await register(tok, 'erin-pc');
  const id = reg.body.device.id;
  assert.equal((await call('POST', '/api/devices/action', { bearer: tok, body: { id, action: 'revoke' } })).code, 200);
  const w = await whoami(reg.body.token);
  assert.equal(w.code, 401);
  assert.equal(w.body.reason, 'revoked');
  assert.equal((await whoami('x'.repeat(40))).body.reason, 'unknown');
  const retry = await register(tok, 'erin-pc');
  assert.equal(retry.code, 409, '客户端 5 秒后自动登记回来——现在被拒');
  // 删掉吊销记录后墓碑还在：老令牌照样回 revoked、同一次登录照样登记不回来
  assert.equal((await call('POST', '/api/devices/action', { bearer: tok, body: { id, action: 'delete' } })).code, 200);
  assert.equal((await whoami(reg.body.token)).body.reason, 'revoked');
  assert.equal((await register(tok, 'erin-pc')).code, 409);
  await new Promise((r) => setTimeout(r, 5));
  const tok2 = await login('erin');
  const fresh = await register(tok2, 'erin-pc');
  assert.equal(fresh.code, 200, '重新登录 = 明确要这台电脑回来');
  assert.notEqual(fresh.body.device.id, id);
});

test('停用：登录与设备都失效（account）；启用后原令牌照常', async () => {
  await users.createUser('frank', 'password123', 'user');
  const tok = await login('frank');
  const reg = await register(tok, 'frank-pc');
  assert.equal((await admin('/api/admin/user/disable', { name: 'frank', disabled: true })).code, 200);
  assert.equal(users.getSession(tok), null);
  const w = await whoami(reg.body.token);
  assert.equal(w.code, 401);
  assert.equal(w.body.reason, 'account');
  assert.ok(registry.deviceById(reg.body.device.id).suspended);
  assert.equal((await admin('/api/admin/user/disable', { name: 'frank', disabled: false })).code, 200);
  assert.equal((await whoami(reg.body.token)).code, 200);
});

test('停用：他铸的聊天快照（还在跑的公开对话）一并关掉', async () => {
  const snap = await import('./routes/chat-snapshot.mjs');
  assert.ok(snap.resolveSnapToken(SNAP_TOKEN), '停用前快照开着');
  assert.equal((await admin('/api/admin/user/disable', { name: 'snapowner', disabled: true })).code, 200);
  for (let i = 0; i < 20 && snap.resolveSnapToken(SNAP_TOKEN); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(snap.resolveSnapToken(SNAP_TOKEN), null);
  assert.equal((await admin('/api/admin/user/disable', { name: 'snapowner', disabled: false })).code, 200);
});

test('删号：设备（留墓碑）、端口转发、用量、邀请记录一并清掉；数据默认删除；同名重新注册什么都继承不到', async () => {
  const code = users.createInvite('user');
  const reg0 = await call('POST', '/api/register', { body: { username: 'gina', password: 'password123', password2: 'password123', invite: code } });
  assert.equal(reg0.code, 200);
  const oldId = users.accountIdOf('gina');
  const tok = reg0.body.token;
  const dev = await register(tok, 'gina-pc');
  const ctx = contextFor(userIdentity('gina'));
  const fw = forwards.createForward(ctx, dev.body.device.id, 5173, 'vite');
  assert.ok(fw.forward);
  users.addUsage(oldId, { tokens: 1, costUsd: 2 });
  writeFileSync(path.join(userRoot(oldId), 'secret.txt'), 'old');
  // 成员侧的管理员可见性与访问记录（runtime/admin-access.mjs）：删号时一并摘掉
  const access = await import('./runtime/admin-access.mjs');
  access.setConsents(oldId, { view: true });
  access.logAccess(oldId, { action: 'view_session', what: 'x' });
  const accessFile = path.join(SYS, 'admin-access.json');
  assert.ok(JSON.parse(readFileSync(accessFile, 'utf8')).consents[oldId]);
  const del = await admin('/api/admin/user/delete', { name: 'gina' });
  assert.equal(del.code, 200);
  assert.equal(del.body.data, 'purged');
  assert.equal(existsSync(userRoot(oldId)), false);
  assert.equal(registry.listDevices({ owner: 'u:' + oldId, includeRevoked: true }).length, 0);
  assert.equal((await whoami(dev.body.token)).body.reason, 'revoked', '删号后老令牌是「已吊销」，客户端不会自动登记回来');
  assert.equal(forwards.forwardByToken(fw.forward.token), null);
  assert.equal(users.getUsage(oldId).costUsd, 0);
  assert.equal(users.listInvites().some((i) => i.code === code), false);
  assert.ok(users.listRetired().some((r) => r.id === oldId && r.data === 'purged'));
  const acc = JSON.parse(readFileSync(accessFile, 'utf8'));
  assert.equal(oldId in acc.consents, false);
  assert.equal(oldId in acc.log, false);
  // 同名重新注册：新 id、空目录、没用量、没设备
  const again = await users.createUser('gina', 'password123', 'user');
  assert.notEqual(again.id, oldId);
  assert.equal(existsSync(path.join(userRoot(again.id), 'secret.txt')), false);
  assert.equal(users.getUsage('gina').costUsd, 0);
  assert.equal(registry.listDevices({ owner: 'u:' + again.id }).length, 0);
});

test('删号先推 me.changed，等他的总线订阅断开再动目录（订阅在时 session-watch 正盯着他的会话文件夹）', async () => {
  const bus = await import('./runtime/bus.mjs');
  await users.createUser('kate', 'password123', 'user');
  const id = users.accountIdOf('kate');
  const key = 'u:' + id;
  // 假的在线页面：收到 me.changed 后过 150ms 才断开总线（模拟重新问 /api/auth → 未登录 → busStop）
  let off = null, sawChanged = 0, dirWhenLeft = null;
  const page = {
    writableEnded: false, on() {}, end() {},
    write(s) { if (String(s).includes('me.changed') && !sawChanged++) setTimeout(() => { dirWhenLeft = existsSync(userRoot(id)); off(); }, 150); return true; },
  };
  off = bus.busSubscribe(key, page);
  const del = await admin('/api/admin/user/delete', { name: 'kate' });
  assert.equal(del.code, 200);
  assert.equal(del.body.data, 'purged');
  assert.equal(sawChanged, 1, '只推一次 me.changed');
  assert.equal(dirWhenLeft, true, '订阅断开之前目录还在');
  assert.equal(existsSync(userRoot(id)), false);
  assert.equal(bus.busSubscribers(key), 0);
});

test('删号归档：目录整个挪进 _archive（带 account.json，不含密码）', async () => {
  await users.createUser('hank', 'password123', 'user');
  const id = users.accountIdOf('hank');
  writeFileSync(path.join(userRoot(id), 'notes.md'), 'keep me');
  users.addUsage(id, { tokens: 3, costUsd: 0.25 });
  const del = await admin('/api/admin/user/delete', { name: 'hank', mode: 'archive' });
  assert.equal(del.code, 200);
  assert.equal(del.body.data, 'archived');
  assert.equal(existsSync(userRoot(id)), false);
  const arch = path.join(NATIVE_ROOT, '_archive');
  const dir = readdirSync(arch).find((d) => d.startsWith(id + '-'));
  assert.ok(dir);
  assert.equal(readFileSync(path.join(arch, dir, 'notes.md'), 'utf8'), 'keep me');
  const meta = JSON.parse(readFileSync(path.join(arch, dir, 'account.json'), 'utf8'));
  assert.equal(meta.name, 'hank');
  assert.equal(meta.usage.costUsd, 0.25);
  assert.equal('hash' in meta || 'salt' in meta, false);
  // 老界面只传 purge:false 也按归档处理（不再是「只删账号行、目录留在原地」）
  await users.createUser('ivy', 'password123', 'user');
  assert.equal((await admin('/api/admin/user/delete', { name: 'ivy', purge: false })).body.data, 'archived');
});

test('「给别人用」开关：只改 config.json 的 features.multiUser，其余原样；重启后生效', async () => {
  const before = await call('GET', '/api/admin/access', { bearer: MASTER });
  assert.equal(before.code, 200);
  assert.equal(before.body.multiUser, true);
  assert.equal(before.body.isolation.level, 'L1');
  assert.deepEqual(before.body.isolation.issuable, ['user']);
  const off = await admin('/api/admin/access', { multiUser: false });
  assert.equal(off.code, 200);
  assert.equal(off.body.next, false);
  assert.equal(off.body.pendingRestart, true);
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(cfg.features.multiUser, false);
  assert.equal(cfg.features.remoteAdmin, true);
  assert.deepEqual(cfg.keepMe, { a: 1 });
  assert.equal(cfg.token, MASTER);
  assert.equal((await admin('/api/admin/access', { multiUser: true })).body.pendingRestart, false);
  assert.equal((await call('POST', '/api/admin/access', { body: { multiUser: true } })).code, 404, '非管理员看不到');
});

test('「给别人用」部署方接管：环境变量 / config.json 声明后 GET 带 managed、POST 拒绝且不动 config.json；没声明 = null', async () => {
  const { audienceManaged } = await import('./routes/admin-accounts.mjs');
  assert.equal(audienceManaged({ env: {}, config: {} }), null);
  assert.deepEqual(audienceManaged({ env: { BRIDGE_AUDIENCE_HINT: ' 在 Muse 里说 ' }, config: { audienceHint: '别的' } }), { hint: '在 Muse 里说' }, '环境变量优先');
  assert.deepEqual(audienceManaged({ env: {}, config: { audienceHint: '用部署脚本切换' } }), { hint: '用部署脚本切换' });
  assert.equal(audienceManaged({ env: {}, config: { audienceHint: 1 } }), null);

  assert.equal((await call('GET', '/api/admin/access', { bearer: MASTER })).body.managed, null, '本体默认不接管');
  const hint = '要切换，在 Muse 里说「改成多人用」或「改成自己用」。';
  process.env.BRIDGE_AUDIENCE_HINT = hint;
  try {
    const g = await call('GET', '/api/admin/access', { bearer: MASTER });
    assert.deepEqual(g.body.managed, { hint });
    const before = readFileSync(CONFIG_PATH, 'utf8');
    const r = await admin('/api/admin/access', { multiUser: !g.body.next });
    assert.equal(r.code, 400);
    assert.match(r.body.error, /由部署方管理/);
    assert.deepEqual(r.body.managed, { hint });
    assert.equal(readFileSync(CONFIG_PATH, 'utf8'), before, '没写 config.json');
  } finally { delete process.env.BRIDGE_AUDIENCE_HINT; }
  // config.json 的 audienceHint 同样算数
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...raw, audienceHint: '用部署脚本切换' }, null, 2));
  try {
    assert.deepEqual((await call('GET', '/api/admin/access', { bearer: MASTER })).body.managed, { hint: '用部署脚本切换' });
    assert.equal((await admin('/api/admin/access', { multiUser: true })).code, 400);
  } finally { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); }
  assert.equal((await admin('/api/admin/access', { multiUser: true })).code, 200, '撤掉声明后照旧能改');
});

test('会话结束事件当场断开设备；巡检兜底', async () => {
  await users.createUser('jack', 'password123', 'user');
  const tok = await login('jack');
  const reg = await register(tok, 'jack-pc');
  const sid = registry.deviceById(reg.body.device.id).login.sid;
  assert.equal(lifecycle.onSessionsEnded([sid]), 1);
  assert.equal(lifecycle.deviceLoginState(registry.deviceById(reg.body.device.id)), 'ok', '会话还在：只是断开，令牌照常');
  users.deleteUserSessions('jack');
  assert.equal(lifecycle.deviceLoginState(registry.deviceById(reg.body.device.id)), 'signed-out');
});

test('账号名 / id 只认自己的键：__proto__ 这类名字找不到账号，改不到 Object.prototype 上', async () => {
  assert.equal(users.getUser('__proto__'), null);
  assert.equal(users.ackTrust('__proto__').error, '用户不存在');
  assert.equal(users.renameUser('__proto__', 'ghost').error, '用户不存在');
  assert.equal(users.setTier('constructor', 'pro', { ack: true }).error, '用户不存在');
  assert.equal((await admin('/api/admin/user/trust-ack', { name: '__proto__' })).code, 400);
  assert.equal(({}).tier, undefined);
  assert.equal(({}).trustAck, undefined);
  assert.equal(users.getUser('ghost'), null, '没建出没有密码的账号');
  assert.equal(users.getSession('__proto__'), null);
  assert.equal(users.sessionInfo('__proto__'), null);
  assert.equal(users.getUsage('__proto__').costUsd, 0);
});

test('降为普通当场生效：在跑的轮中止、发 downgraded；升档 / 档位没变不收', async () => {
  const gen = await import('./runtime/gen.mjs');
  await users.createUser('lena', 'password123', 'pro', { trustAck: Date.now() });
  const id = users.accountIdOf('lena');
  const key = 'u:' + id;
  const g = { done: false, abort: new AbortController(), subscribers: new Set() };
  gen.setCurrentGen(key, g);
  const seen = [];
  const onDown = (e) => seen.push(e);
  lifecycle.accountEvents.on('downgraded', onDown);
  try {
    const up = await admin('/api/admin/user/tier', { name: id, tier: 'pro', ack: true });
    assert.equal(up.code, 200);
    assert.equal(g.abort.signal.aborted, false, '档位没变：什么都不收');
    const r = await admin('/api/admin/user/tier', { name: id, tier: 'user' });
    assert.equal(r.code, 200);
    assert.equal(r.body.tier, 'user');
    assert.equal(r.body.runs, 1);
    assert.equal(g.abort.signal.aborted, true, '带着命令行开跑的那一轮被中止');
    assert.deepEqual(seen.map((e) => e.id), [id]);
    const g2 = { done: false, abort: new AbortController(), subscribers: new Set() };
    gen.setCurrentGen(key, g2);
    assert.equal((await admin('/api/admin/user/tier', { name: id, tier: 'pro', ack: true })).code, 200);
    assert.equal(g2.abort.signal.aborted, false, '升档不收');
    gen.clearCurrentGenIfMatches(key, g2);
  } finally {
    lifecycle.accountEvents.off('downgraded', onDown);
    gen.clearCurrentGenIfMatches(key, g);
  }
});

test('升级前登记的成员设备（没有 login）：回一次 signed-out，重新登记就绑上当前登录；之后退出即失效', async () => {
  const { DEVICES_PATH } = registry;
  await users.createUser('mona', 'password123', 'user');
  const tok = await login('mona');
  const reg = await register(tok, 'mona-pc');
  const devId = reg.body.device.id;
  // 模拟这一版之前的记录：去掉 login（renameDevice 现读现改，顺带作废缓存）
  const raw = JSON.parse(readFileSync(DEVICES_PATH, 'utf8'));
  delete raw.devices.find((d) => d.id === devId).login;
  writeFileSync(DEVICES_PATH, JSON.stringify(raw, null, 2));
  registry.renameDevice(devId, 'mona-pc');
  assert.equal(registry.deviceById(devId).login, undefined);
  const w = await whoami(reg.body.token);
  assert.equal(w.code, 401);
  assert.equal(w.body.reason, 'signed-out', '新老客户端收到 signed-out 都会自动重新登记');
  const again = await register(tok, 'mona-pc');
  assert.equal(again.code, 200, '同一次登录重新登记不算「吊销后登记回来」');
  assert.equal(again.body.device.id, devId, '复用原设备 id');
  assert.equal(registry.deviceById(devId).login.kind, 'user');
  assert.equal((await whoami(again.body.token)).code, 200);
  await call('POST', '/api/logout', { bearer: tok });
  assert.equal((await whoami(again.body.token)).body.reason, 'signed-out');
  // 管理员名下没有 login 的老设备（MOONLIGHT 这类）不受影响
  assert.equal(lifecycle.deviceLoginState({ id: 'x', owner: 'admin' }), 'ok');
  // 这一版之后登记却没有可绑登录的成员设备（loginless）：账号在就算数，不来回重登
  assert.equal(lifecycle.deviceLoginState({ id: 'y', owner: 'u:' + users.accountIdOf('mona'), loginless: '2026-10-22' }), 'ok');
  assert.equal(lifecycle.deviceLoginState({ id: 'z', owner: 'u:nobody-here' }), 'account', '账号已不在');
});

test('升级前发的完全信任码在列表里标出来（legacyFull），作废后消失', async () => {
  const file = path.join(SYS, 'invites.json');
  const inv = JSON.parse(readFileSync(file, 'utf8'));
  inv.oldProCode = { created: 1, used: false, usedBy: null, tier: 'pro' };
  inv.oldUserCode = { created: 1, used: false, usedBy: null, tier: 'user' };
  writeFileSync(file, JSON.stringify(inv));
  const list = users.listInvites();
  assert.equal(list.find((i) => i.code === 'oldProCode').legacyFull, true);
  assert.equal(list.find((i) => i.code === 'oldUserCode').legacyFull, false);
  const fresh = users.createInvite('pro', { ack: true });
  assert.equal(users.listInvites().find((i) => i.code === fresh).legacyFull, false, '新码有有效期、确认过');
  assert.equal((await admin('/api/admin/invite/revoke', { code: 'oldProCode' })).code, 200);
  assert.equal(users.listInvites().some((i) => i.legacyFull), false);
});

test('删号时页面一直不断开（半死的连接）：目录先不动、记成 pending，断开后再删', async () => {
  const bus = await import('./runtime/bus.mjs');
  await users.createUser('nina', 'password123', 'user');
  const id = users.accountIdOf('nina');
  const key = 'u:' + id;
  writeFileSync(path.join(userRoot(id), 'a.txt'), 'x');
  const page = { writableEnded: false, on() {}, end() {}, write() { return true; } };   // 收到 me.changed 也不走
  const off = bus.busSubscribe(key, page);
  const del = await lifecycle.deleteAccount('nina', { drainMs: 200 });
  assert.equal(del.ok, true);
  assert.equal(del.data, 'pending');
  assert.equal(existsSync(path.join(userRoot(id), 'a.txt')), true, '连接还在：目录不动');
  const rec = users.listRetired().find((r) => r.id === id);
  assert.equal(rec.data, 'pending');
  assert.equal(rec.want, 'purge');
  assert.equal(await lifecycle.finishPendingData(), 0, '还连着：继续等');
  off();
  assert.equal(await lifecycle.finishPendingData(), 1);
  assert.equal(existsSync(userRoot(id)), false);
  const done = users.listRetired().find((r) => r.id === id);
  assert.equal(done.data, 'purged');
  assert.equal('want' in done, false);
  assert.equal(users.retiredRecord(id).meta, undefined, '处理完不再留元数据');
});

test('删号时半死的连接经路由登记过收尾（busAttach 的 onDrop）：等不到就强制断开、收尾，数据照常删', async () => {
  const bus = await import('./runtime/bus.mjs');
  await users.createUser('pia', 'password123', 'user');
  const id = users.accountIdOf('pia');
  const key = 'u:' + id;
  writeFileSync(path.join(userRoot(id), 'a.txt'), 'x');
  let ended = 0, dropped = 0;
  const page = { writableEnded: false, on() {}, end() { ended++; this.writableEnded = true; }, write() { return true; } };   // 收到 me.changed 也不走
  let off = null;
  off = bus.busAttach(key, page, () => { dropped++; off(); });
  const del = await lifecycle.deleteAccount('pia', { drainMs: 200 });
  assert.equal(del.ok, true);
  assert.equal(del.data, 'purged');
  assert.equal(dropped, 1, '路由的收尾（退订 + 关 session-watch）被调了一次');
  assert.equal(ended, 1, '响应被结束');
  assert.equal(bus.busSubscribers(key), 0);
  assert.equal(existsSync(userRoot(id)), false);
});

test('删号收掉停放的 CLI：最近写过的会话逐个关（目录在 Windows 上被 CLI 占着删不掉）；数据照常删除', async () => {
  await users.createUser('olga', 'password123', 'user');
  const id = users.accountIdOf('olga');
  const proj = path.join(userRoot(id), '.bridge', 'claude', 'projects', 'C--x');
  mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(proj, '0123abcd-0000-4000-8000-000000000001.jsonl'), '{}\n');
  const del = await lifecycle.deleteAccount('olga');
  assert.equal(del.ok, true);
  assert.equal(del.parked, 1, '最近写过的会话都过一遍 releaseWarmClaude（没有停放的是空操作）');
  assert.equal(del.data, 'purged');
  assert.equal(existsSync(userRoot(id)), false);
});
