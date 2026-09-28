// 管理员会话化（三端拆分 P4）的契约：主令牌只在登录那一下用，换来可吊销的管理员会话；
// 会话绑主令牌指纹，换令牌即全部作废；config 可以只存主令牌哈希；登出吊销当前这一张。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-adminsess-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const users = await import('./users.mjs');
const { createAuth } = await import('./auth.mjs');
const { registerAuthRoutes } = await import('./routes/auth.mjs');
const { SYSTEM_DIR } = await import('./config/index.mjs');

const MASTER = 'master-token-for-tests-0123456789';
const req = ({ bearer = '', cookie = '', url = '/api/x', method = 'GET', ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Edg/130' } = {}) => ({
  method, url, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(cookie ? { cookie } : {}), 'user-agent': ua },
  socket: { remoteAddress: '127.0.0.1' },
});

test('认主令牌与未吊销的管理员会话；会话绑主令牌指纹，换令牌即失效', () => {
  const a = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
  assert.equal(a.adminCredential(req({ bearer: MASTER })).via, 'master');
  const s = users.createAdminSession({ gen: a.gen, label: 'x' });
  assert.equal(a.adminCredential(req({ bearer: s })).via, 'session');
  assert.equal(a.adminCredential(req({ cookie: 'bridge_auth=' + encodeURIComponent(s) })).via, 'session');
  assert.equal(a.authOk(req({ bearer: 'nope' })), false);
  // 另一把主令牌（= 换过令牌）下，旧会话不认
  const b = createAuth(MASTER + '-rotated', false, { isAdminSession: users.isAdminSession });
  assert.equal(b.authOk(req({ bearer: s })), false);
  assert.equal(users.revokeAdminSessions([users.adminSessionIdOf(s)]), 1);
  assert.equal(a.authOk(req({ bearer: s })), false, '吊销即失效');
});

test('config 只存主令牌哈希也能登录，且与明文配置算出同一个指纹', () => {
  const hash = createHash('sha256').update(MASTER).digest('hex');
  const h = createAuth('', false, { tokenHash: hash, isAdminSession: users.isAdminSession });
  const p = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
  assert.equal(h.gen, p.gen);
  assert.equal(h.authOk(req({ bearer: MASTER })), true);
  assert.equal(h.authOk(req({ bearer: hash })), false, '拿哈希本身当令牌登不上');
});

test('管理员会话不是账号会话；落盘只存哈希', () => {
  const a = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
  const s = users.createAdminSession({ gen: a.gen });
  assert.equal(users.getSession(s), null);
  assert.equal(readFileSync(path.join(SYSTEM_DIR, 'sessions.json'), 'utf8').includes(s), false);
  users.revokeAdminSessions('all');
});

function loginRoutes(auth) {
  const h = {};
  const router = { on: (m, p, fn) => { h[m + ' ' + p] = fn; } };
  const identify = (r) => (auth.authOk(r) ? { kind: 'admin', user: null } : { kind: 'none', user: null });
  registerAuthRoutes(router, { ...auth, adminGen: auth.gen, identify });
  return async (p, r) => {
    let code = 0, headers = {}, body = '';
    const res = { writeHead(c, hh) { code = c; headers = hh || {}; }, end(b) { body = b || ''; } };
    const rq = Object.assign(r, { on() {}, [Symbol.asyncIterator]: async function* () {} });
    await h['POST ' + p](rq, res, new URL('http://x' + p));
    return { code, headers, json: body ? JSON.parse(body) : null };
  };
}

test('/api/login：主令牌换一张新会话（cookie 与 JSON 都是它）；已是会话则原样续上；登出吊销这一张', async () => {
  users.revokeAdminSessions('all');
  const auth = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
  const call = loginRoutes(auth);
  const r1 = await call('/api/login', req({ bearer: MASTER, method: 'POST' }));
  assert.equal(r1.code, 200);
  assert.equal(r1.json.kind, 'admin');
  assert.ok(r1.json.token && r1.json.token !== MASTER, '发回的是会话令牌，不是主令牌');
  assert.match(r1.headers['Set-Cookie'], new RegExp('^bridge_auth=' + encodeURIComponent(r1.json.token)));
  assert.equal(users.listAdminSessions(auth.gen).length, 1);
  assert.equal(users.listAdminSessions(auth.gen)[0].label, 'Windows · Edge');

  const r2 = await call('/api/login', req({ bearer: r1.json.token, method: 'POST' }));
  assert.equal(r2.json.token, r1.json.token, '拿会话来登录不再铸新的');
  assert.equal(users.listAdminSessions(auth.gen).length, 1);

  const out = await call('/api/logout', req({ cookie: 'bridge_auth=' + encodeURIComponent(r1.json.token), method: 'POST' }));
  assert.equal(out.code, 200);
  assert.equal(users.listAdminSessions(auth.gen).length, 0);
  assert.equal(auth.authOk(req({ bearer: r1.json.token })), false);
});

test('重置 / 修改密码：这个人别的设备下线，发起修改的那台保留', async () => {
  await users.createUser('carol', 'password123', 'user');
  const keep = users.createSession('carol');
  const other = users.createSession('carol');
  users.deleteUserSessions('carol', keep);
  assert.equal(users.getSession(keep)?.user, 'carol');
  assert.equal(users.getSession(other), null);
  users.deleteUserSessions('carol');
  assert.equal(users.getSession(keep), null);
});
