// 扫码配对登录的状态机：领票 → 长轮询 → 扫描 → 确认 → 领取；钥匙分工与终态一次性。
// admin 确认铸的是管理员会话（三端拆分 P4，以前是主令牌本身），落在临时数据根的 sessions.json 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-pair-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
const { registerPairRoutes, _resetPairStore, describeClient } = await import('./pair.mjs');
const users = await import('../users.mjs');

const GEN = 'gen-for-test';

function makeApp() {
  const handlers = new Map();
  const router = { on: (method, path, fn) => handlers.set(method + ' ' + path, fn) };
  const identify = (req) => {
    const who = req.headers['x-test-id'] || '';
    if (who === 'admin') return { kind: 'admin', user: null };
    if (who.startsWith('user:')) return { kind: 'user', user: who.slice(5) };
    if (who === 'share') return { kind: 'share', user: null };
    return { kind: 'none', user: null };
  };
  registerPairRoutes(router, {
    identify, adminGen: GEN,
    authCookie: (_req, t) => 'bridge_auth=' + t + '; Path=/',
    userCookie: (_req, t) => 'bridge_user=' + t + '; Path=/',
  });
  // 发一次请求：body 为对象，headers 可带 x-test-id 模拟登录身份。返回 {code, headers, body}
  function call(path, body, headers = {}) {
    const fn = handlers.get('POST ' + path);
    assert.ok(fn, '没注册 ' + path);
    const req = new EventEmitter();
    req.headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Edg/130', ...headers };
    req.socket = { remoteAddress: '127.0.0.1' };
    req.url = path; req.method = 'POST';
    const res = new EventEmitter();
    let code = 0, hdrs = {}, out = '';
    res.writeHead = (c, h) => { code = c; hdrs = h || {}; };
    res.end = (chunk) => { out = chunk || ''; res.writableEnded = true; res.emit('finish'); };
    const p = fn(req, res, new URL('http://x' + path));
    queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end'); });
    return Promise.resolve(p).then(() => ({ code, headers: hdrs, body: out ? JSON.parse(out) : null }));
  }
  return { call };
}

test('完整流程：领票 → 扫描 → 确认 → 领取，且票一次性', async () => {
  _resetPairStore();
  const { call } = makeApp();
  const t = (await call('/api/pair/new', { label: 'Win' })).body;
  assert.ok(t.id && t.key && t.claim && t.expiresAt > Date.now());
  assert.notEqual(t.key, t.claim);

  // 未登录/share 身份不能扫
  assert.equal((await call('/api/pair/scan', { id: t.id, key: t.key })).code, 401);
  assert.equal((await call('/api/pair/scan', { id: t.id, key: t.key }, { 'x-test-id': 'share' })).code, 401);
  // 拿 claim 当 key 扫不动（钥匙分工）
  assert.equal((await call('/api/pair/scan', { id: t.id, key: t.claim }, { 'x-test-id': 'admin' })).code, 404);

  // 网页在等；手机扫描后 wait 立刻醒来
  const w1 = call('/api/pair/wait', { id: t.id, claim: t.claim, status: 'pending' });
  const sc = await call('/api/pair/scan', { id: t.id, key: t.key }, { 'x-test-id': 'admin' });
  assert.equal(sc.code, 200);
  assert.equal(sc.body.device, 'Windows · Edge');
  assert.equal((await w1).body.status, 'scanned');

  // 拿 key 领不到凭据（钥匙分工）；未确认前 claim 是 409
  assert.equal((await call('/api/pair/claim', { id: t.id, claim: t.key })).code, 404);
  assert.equal((await call('/api/pair/claim', { id: t.id, claim: t.claim })).code, 409);

  const w2 = call('/api/pair/wait', { id: t.id, claim: t.claim, status: 'scanned' });
  assert.equal((await call('/api/pair/approve', { id: t.id, key: t.key }, { 'x-test-id': 'admin' })).code, 200);
  assert.equal((await w2).body.status, 'approved');

  const c = await call('/api/pair/claim', { id: t.id, claim: t.claim });
  assert.equal(c.code, 200);
  assert.equal(c.body.kind, 'admin');
  // 发的是一张管理员会话（能单独吊销），不是主令牌
  assert.ok(users.isAdminSession(c.body.token, GEN));
  assert.equal(users.isAdminSession(c.body.token, 'other-gen'), false, '主令牌一换，会话即失效');
  assert.equal(c.headers['Set-Cookie'], 'bridge_auth=' + c.body.token + '; Path=/');
  assert.equal(users.getSession(c.body.token), null, '管理员会话不能当账号会话用');
  // 票已销毁：再领 404，再确认 410
  assert.equal((await call('/api/pair/claim', { id: t.id, claim: t.claim })).code, 404);
  assert.equal((await call('/api/pair/approve', { id: t.id, key: t.key }, { 'x-test-id': 'admin' })).code, 410);
});

test('管理员确认后网页迟迟不领：过期即把铸好的管理员会话收回', async (t) => {
  _resetPairStore();
  users.revokeAdminSessions('all');
  const { call } = makeApp();
  const tk = (await call('/api/pair/new', {})).body;
  assert.equal((await call('/api/pair/approve', { id: tk.id, key: tk.key }, { 'x-test-id': 'admin' })).code, 200);
  assert.equal(users.listAdminSessions(GEN).length, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  const c = await call('/api/pair/claim', { id: tk.id, claim: tk.claim });
  assert.notEqual(c.code, 200);
  assert.equal(users.listAdminSessions(GEN).length, 0);
});

test('手机取消 → 网页拿到 rejected；之后不能再确认', async () => {
  _resetPairStore();
  const { call } = makeApp();
  const t = (await call('/api/pair/new', {})).body;
  const w = call('/api/pair/wait', { id: t.id, claim: t.claim, status: 'pending' });
  assert.equal((await call('/api/pair/reject', { id: t.id, key: t.key }, { 'x-test-id': 'user:bob' })).code, 200);
  assert.equal((await w).body.status, 'rejected');
  assert.equal((await call('/api/pair/approve', { id: t.id, key: t.key }, { 'x-test-id': 'user:bob' })).code, 409);
});

test('wait 状态未变时到点回当前状态；错 claim 404', async () => {
  _resetPairStore();
  const { call } = makeApp();
  const t = (await call('/api/pair/new', {})).body;
  assert.equal((await call('/api/pair/wait', { id: t.id, claim: 'nope', status: 'pending' })).code, 404);
  // 传一个与当前不同的 status，立刻返回当前 pending（不挂 20s）
  const r = await call('/api/pair/wait', { id: t.id, claim: t.claim, status: 'scanned' });
  assert.equal(r.body.status, 'pending');
});

test('describeClient 识别常见 UA', () => {
  assert.equal(describeClient('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Mobile Safari/604'), 'iPhone · Safari');
  assert.equal(describeClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/130 Safari/537'), 'Mac · Chrome');
  assert.equal(describeClient(''), '未知设备');
});
