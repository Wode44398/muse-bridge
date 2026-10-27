// 扫码配对路由：出示方领票 → 兑换方换会话（管理员会话 / 他本人的账号会话）→ 出示方看到「已连接」、能撤销。
// 会话落在临时数据根的 sessions.json 里（与 pair.test.mjs 同一套假路由）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-pairc-route-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
const { registerPairRoutes, _resetPairStore, rateIp } = await import('./pair.mjs');
const users = await import('../users.mjs');
const { ensureHostSecret } = await import('../runtime/host-secret.mjs');

const GEN = 'gen-for-test';
const UA_APP = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
};
const bearerOf = (req) => { const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); return m ? m[1].trim() : ''; };

// 身份解析照 runtime/identity.mjs 的口径：x-test-id 是测试捷径；真会话走 bridge_user cookie / Bearer（带 sid）、
// 管理员会话走 x-test-admin-session（adminCredential 认出 via:'session'）。bindHost 默认当成监听 0.0.0.0（S1-7 之前生成的老配置）。
function makeApp({ gen = GEN, bindHost = '0.0.0.0' } = {}) {
  const handlers = new Map();
  const router = { on: (method, p, fn) => handlers.set(method + ' ' + p, fn) };
  const adminCredential = (req) => {
    const s = req.headers['x-test-admin-session'] || cookieOf(req, 'bridge_auth');
    if (s && users.isAdminSession(s, gen)) return { via: 'session', token: s };
    if (req.headers['x-test-id'] === 'admin') return { via: 'master', token: 'master' };
    return null;
  };
  const identify = (req) => {
    if (adminCredential(req)) return { kind: 'admin', user: null };
    const who = req.headers['x-test-id'] || '';
    if (who.startsWith('user:')) return { kind: 'user', user: who.slice(5) };
    if (who === 'share') return { kind: 'share', user: null };
    const tok = cookieOf(req, 'bridge_user') || bearerOf(req);
    const s = tok ? users.getSession(tok) : null;
    if (s) return { kind: 'user', user: s.id || s.user, name: s.user, sid: s.sid };
    return { kind: 'none', user: null };
  };
  registerPairRoutes(router, {
    identify, adminGen: gen,
    authCookie: (_req, t) => 'bridge_auth=' + t + '; Path=/',
    userCookie: (_req, t) => 'bridge_user=' + t + '; Path=/',
    clearAuthCookie: () => 'bridge_auth=; Max-Age=0',
    clearUserCookie: () => 'bridge_user=; Max-Age=0',
    getCookie: cookieOf, bearerToken: bearerOf, adminCredential,
    lanIPs: () => ['192.168.50.7', '172.17.0.1'],
    bindHost,
  });
  function call(method, p, body, headers = {}, sock = '127.0.0.1') {
    const fn = handlers.get(method + ' ' + p);
    assert.ok(fn, '没注册 ' + method + ' ' + p);
    const req = new EventEmitter();
    req.headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Edg/130', ...headers };
    req.socket = { remoteAddress: sock };
    req.url = p; req.method = method;
    const res = new EventEmitter();
    let code = 0, hdrs = {}, out = '';
    res.writeHead = (c, h) => { code = c; hdrs = h || {}; };
    res.end = (chunk) => { out = chunk || ''; res.writableEnded = true; res.emit('finish'); };
    const pr = fn(req, res, new URL('http://x' + p));
    queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end'); });
    return Promise.resolve(pr).then(() => ({ code, headers: hdrs, body: out ? JSON.parse(out) : null }));
  }
  return { call, post: (p, b, h, sock) => call('POST', p, b, h, sock), get: (p, h) => call('GET', p, null, h) };
}

test('管理员出码 → App 扫码换到一张管理员会话（不是主令牌），出示方看到「已连接」', async () => {
  _resetPairStore();
  const { post } = makeApp();
  assert.equal((await post('/api/pair/connect', {})).code, 401);
  assert.equal((await post('/api/pair/connect', {}, { 'x-test-id': 'share' })).code, 401);
  const tk = (await post('/api/pair/connect', { origin: 'http://127.0.0.1:8787' }, { 'x-test-id': 'admin' })).body;
  assert.match(tk.code, /^\d{8}$/);
  assert.match(tk.svg, /^<svg /);
  // 没有公网地址、页面在回环上 → 码里放局域网地址；局域网候选只给私网
  assert.equal(tk.origin, 'http://192.168.50.7:8787');
  assert.equal(tk.reachable, true);
  assert.match(tk.url, /^http:\/\/192\.168\.50\.7:8787\/\?connect=[\w-]+\.[\w-]+&lan=172\.17\.0\.1:8787&sid=srv_[0-9a-f]{20}$/);
  const [id, secret] = new URL(tk.url).searchParams.get('connect').split('.');

  const w = post('/api/pair/connect/wait', { id: tk.id, status: 'pending' }, { 'x-test-id': 'admin' });
  const r = await post('/api/pair/redeem', { id, secret, client: 'app' }, { 'user-agent': UA_APP, 'cf-connecting-ip': '100.64.0.9' });
  assert.equal(r.code, 200);
  assert.equal(r.body.kind, 'admin');
  assert.ok(users.isAdminSession(r.body.token, GEN), '发的是管理员会话');
  assert.match(String(r.headers['Set-Cookie']), /^bridge_auth=/);
  assert.ok(r.body.address && r.body.address.id && Array.isArray(r.body.address.lan), '带地址簿（管理员有局域网候选）');
  const v = (await w).body;
  assert.equal(v.status, 'redeemed');
  assert.equal(v.device, 'Android · The Bridge App');
  assert.equal(v.ip, '100.64.0.9');
  // 控制台「管理员登录」里能看到并单独吊销
  assert.ok(users.listAdminSessions(GEN).some((s) => s.label === 'Android · The Bridge App（扫码配对）'));
  // 同一张票再兑换不行
  assert.equal((await post('/api/pair/redeem', { id, secret })).code, 410);
});

test('普通账号出码 → 换到他自己的账号会话；码里不带局域网；出示方能撤销', async () => {
  _resetPairStore();
  await users.createUser('alice', 'password123', 'user');
  const { post } = makeApp();
  const tk = (await post('/api/pair/connect', { origin: 'https://bridge.example.com' }, { 'x-test-id': 'user:alice' })).body;
  assert.equal(tk.origin, 'https://bridge.example.com');
  assert.deepEqual(tk.lan, []);
  assert.doesNotMatch(tk.url, /lan=/);
  const r = await post('/api/pair/redeem', { code: tk.codeText });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.kind, r.body.user], ['user', 'alice']);
  assert.equal(users.getSession(r.body.token)?.user, 'alice');
  assert.equal(r.body.address.lan, undefined, '普通账号拿不到局域网候选');
  // 别人撤销不了；本人撤销 → 会话立刻失效
  assert.equal((await post('/api/pair/connect/revoke', { id: tk.id }, { 'x-test-id': 'admin' })).code, 409);
  assert.equal((await post('/api/pair/connect/revoke', { id: tk.id }, { 'x-test-id': 'user:alice' })).code, 200);
  assert.equal(users.getSession(r.body.token), null);
});

test('出示方作废 / 账号停用后兑换不了', async () => {
  _resetPairStore();
  await users.createUser('bob', 'password123', 'user');
  const { post } = makeApp();
  const a = (await post('/api/pair/connect', {}, { 'x-test-id': 'user:bob' })).body;
  assert.equal((await post('/api/pair/connect/cancel', { id: a.id }, { 'x-test-id': 'user:bob' })).body.ok, true);
  assert.equal((await post('/api/pair/redeem', { code: a.code })).code, 404);
  const b = (await post('/api/pair/connect', {}, { 'x-test-id': 'user:bob' })).body;
  users.setDisabled('bob', true);
  assert.equal((await post('/api/pair/redeem', { code: b.code })).code, 410);
});

test('主令牌换了（gen 变了）：旧码兑换不了', async () => {
  _resetPairStore();
  const old = makeApp({ gen: 'old-gen' });
  const tk = (await old.post('/api/pair/connect', {}, { 'x-test-id': 'admin' })).body;
  const fresh = makeApp({ gen: 'new-gen' });   // 换了主令牌、用新令牌挂的路由（同一个票仓）
  assert.equal((await fresh.post('/api/pair/redeem', { code: tk.code })).code, 410);
});

test('审计接口只给管理员', async () => {
  _resetPairStore();
  const { get } = makeApp();
  assert.equal((await get('/api/pair/connect/audit')).code, 401);
  const a = await get('/api/pair/connect/audit', { 'x-test-id': 'admin' });
  assert.equal(a.code, 200);
  assert.ok(Array.isArray(a.body.entries));
});

test('本机命令行（cli.mjs pair）：回环直连 + 主机密钥当管理员出码；带代理头不认', async () => {
  _resetPairStore();
  const { post } = makeApp();
  const secret = ensureHostSecret();
  const ok = await post('/api/pair/connect', { via: 'cli' }, { authorization: 'Bearer ' + secret });
  assert.equal(ok.code, 200);
  assert.deepEqual(ok.body.as, { kind: 'admin' });
  assert.ok(ok.body.url && /^\d{8}$/.test(ok.body.code) && ok.body.expiresAt > Date.now());
  assert.equal((await post('/api/pair/connect', {}, { authorization: 'Bearer ' + secret, 'cf-connecting-ip': '1.2.3.4' })).code, 401, '经隧道来的不算本机');
  assert.equal((await post('/api/pair/connect', {}, { authorization: 'Bearer wrong' })).code, 401);
});

test('票绑出示方那次登录：账号会话被踢（改密码）/ 管理员会话被吊销后，已领的票兑换不了', async () => {
  _resetPairStore();
  await users.createUser('carol', 'password123', 'user');
  const { post } = makeApp();
  const sess = users.createSession('carol');
  const a = (await post('/api/pair/connect', {}, { cookie: 'bridge_user=' + sess })).body;
  assert.match(a.code, /^\d{8}$/);
  users.deleteUserSessions('carol');   // 等同改 / 重置密码：这次登录没了
  assert.equal((await post('/api/pair/redeem', { code: a.code })).code, 410);
  // 登录还在时照常
  const sess2 = users.createSession('carol');
  const b = (await post('/api/pair/connect', {}, { authorization: 'Bearer ' + sess2 })).body;
  const ok = await post('/api/pair/redeem', { code: b.code });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.user, 'carol');

  const adm = users.createAdminSession({ gen: GEN, label: 'test' });
  const c = (await post('/api/pair/connect', {}, { 'x-test-admin-session': adm })).body;
  assert.deepEqual(c.as, { kind: 'admin' });
  users.revokeAdminSessions([users.adminSessionIdOf(adm)]);   // 控制台吊销了出码的那张管理员会话
  assert.equal((await post('/api/pair/redeem', { code: c.code })).code, 410);
  // 主令牌出码（没有会话可绑）只认主令牌指纹，照常
  const d = (await post('/api/pair/connect', {}, { 'x-test-id': 'admin' })).body;
  assert.equal((await post('/api/pair/redeem', { code: d.code })).code, 200);
});

test('服务端只听本机（bindHost=127.0.0.1）且没有公网：码里没有局域网地址，reachable=false', async () => {
  _resetPairStore();
  const { post } = makeApp({ bindHost: '127.0.0.1' });
  const tk = (await post('/api/pair/connect', { origin: 'http://127.0.0.1:8787' }, { 'x-test-id': 'admin' })).body;
  assert.deepEqual(tk.lan, []);
  assert.equal(tk.reachable, false);
  assert.doesNotMatch(tk.url, /192\.168\./);
});

test('兑换带 replace：退出这个浏览器原来的登录、清掉另一种 cookie；不带 replace 不动原登录', async () => {
  _resetPairStore();
  await users.createUser('dave', 'password123', 'user');
  await users.createUser('erin', 'password123', 'user');
  const { post } = makeApp();
  const old = users.createSession('dave');
  const keep = users.createSession('dave');
  const t1 = (await post('/api/pair/connect', {}, { 'x-test-id': 'user:erin' })).body;
  const r1 = await post('/api/pair/redeem', { code: t1.code }, { cookie: 'bridge_user=' + keep });
  assert.equal(r1.code, 200);
  assert.ok(users.getSession(keep), '没确认替换：原来的登录不动');

  const t2 = (await post('/api/pair/connect', {}, { 'x-test-id': 'user:erin' })).body;
  const adm = users.createAdminSession({ gen: GEN, label: 'browser' });
  const r2 = await post('/api/pair/redeem', { code: t2.code, replace: true }, { cookie: 'bridge_user=' + old + '; bridge_auth=' + adm });
  assert.equal(r2.code, 200);
  assert.equal(r2.body.user, 'erin');
  assert.equal(users.getSession(old), null, '原来的账号会话退出了');
  assert.equal(users.isAdminSession(adm, GEN), false, '原来的管理员会话也退出了');
  const sc = [].concat(r2.headers['Set-Cookie']);
  assert.ok(sc.some((c) => c.startsWith('bridge_user=' + r2.body.token)));
  assert.ok(sc.some((c) => c.startsWith('bridge_auth=;')), '换成账号会话：管理员 cookie 清掉，不然它优先');
  assert.ok(users.getSession(r2.body.token), '新会话有效');
});

test('撤销过期后的提示按出示方区分：管理员去控制台吊销，普通账号改密码', async () => {
  _resetPairStore();
  await users.createUser('fay', 'password123', 'user');
  const { post } = makeApp();
  const u = await post('/api/pair/connect/revoke', { id: 'gone' }, { 'x-test-id': 'user:fay' });
  assert.equal(u.code, 409);
  assert.match(u.body.error, /改一次密码/);
  const a = await post('/api/pair/connect/revoke', { id: 'gone' }, { 'x-test-id': 'admin' });
  assert.match(a.body.error, /管理员登录/);
});

test('限流来源：只有本机 / 内网对端才认代理头，公网直连只认 socket 地址', () => {
  const req = (sock, headers = {}) => ({ headers, socket: { remoteAddress: sock } });
  assert.equal(rateIp(req('127.0.0.1', { 'cf-connecting-ip': '8.8.8.8' })), '8.8.8.8');
  assert.equal(rateIp(req('::ffff:172.18.0.3', { 'cf-connecting-ip': '8.8.4.4' })), '8.8.4.4', 'Docker 网络里的隧道侧车');
  assert.equal(rateIp(req('203.0.113.9', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })), '203.0.113.9');
  assert.equal(rateIp(req('203.0.113.9')), '203.0.113.9');
});

test('公网直连伪造代理头刷错码：按真实来源封禁', async () => {
  _resetPairStore();
  const { post } = makeApp();
  for (let i = 0; i < 10; i++) await post('/api/pair/redeem', { id: 'nope1234', secret: 'x'.repeat(20) }, { 'cf-connecting-ip': '9.9.9.' + i }, '203.0.113.50');
  const tk = (await post('/api/pair/connect', {}, { 'x-test-id': 'admin' })).body;
  const [id, secret] = new URL(tk.url).searchParams.get('connect').split('.');
  assert.equal((await post('/api/pair/redeem', { id, secret }, { 'cf-connecting-ip': '9.9.9.99' }, '203.0.113.50')).code, 429);
});
