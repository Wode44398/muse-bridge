// 管理员可见性（开源路线 S2-7 / N13）的契约：管理员默认只看元数据；看对话内容、代聊代答、看成员的电脑要成员自己允许，
// 每次都在成员那边记一笔；服务账号默认全开；管理员自己的数据不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-adminaccess-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';

const users = await import('./users.mjs');
const acc = await import('./runtime/admin-access.mjs');
const { registerAdminRoutes } = await import('./routes/admin.mjs');
const { registerAdminAccessRoutes } = await import('./routes/admin-access.mjs');
const { userIdentity } = await import('./runtime/identity.mjs');
const { userRoot } = await import('./config/index.mjs');
const { pendingQuestions } = await import('./runtime/questions.mjs');

await users.createUser('nina', 'password123', 'user');
await users.createUser('robo', 'password123', 'user');
users.setService('robo', true);
const ninaId = userIdentity('nina').user;

test('默认：成员两项都没允许；服务账号默认全开；不存在的账号一律不许', () => {
  assert.deepEqual(acc.consentsOf('nina'), { view: false, assist: false, at: 0, service: false });
  const r = acc.consentsOf('robo');
  assert.equal(r.view && r.assist, true);
  assert.equal(acc.accessAllowed('robo', 'device'), false, '没有「看他的电脑」这一项');
  assert.equal(acc.accessAllowed('ghost', 'view'), false);
  assert.equal(acc.ownerAllows('admin', 'view'), true, '主机自己的不经过成员允许');
  assert.equal(acc.ownerAllows('c:sometoken', 'view'), true, '快照桶不是成员');
  assert.equal(acc.ownerAllows('u:' + ninaId, 'view'), false);
});

test('成员自己改；按登录名 / 账号 id / owner 键都认', () => {
  const r = acc.setConsents('nina', { view: true, assist: 'yes' });
  assert.equal(r.consents.view, true);
  assert.equal(r.consents.assist, false, '只收布尔值');
  assert.ok(r.consents.at > 0);
  assert.equal(acc.accessAllowed(ninaId, 'view'), true);
  assert.equal(acc.ownerAllows('u:' + ninaId, 'view'), true);
  acc.setConsents('nina', { view: false });
  assert.equal(acc.accessAllowed('nina', 'view'), false);
});

test('访问记录：新的在前、带人话标签、封顶', () => {
  acc.logAccess('nina', { action: 'view_session', what: 'abc' });
  acc.logAccess('u:' + ninaId, { action: 'answer', what: 'permission' });
  const log = acc.accessLog('nina');
  assert.equal(log[0].action, 'answer');
  assert.equal(log[0].label, '替你回答了一个提问或审批');
  assert.equal(log[1].what, 'abc');
  for (let i = 0; i < 260; i++) acc.logAccess('nina', { action: 'view_session', what: 'k' + i });
  assert.equal(acc.accessLog('nina', 1000).length, 200);
});

test('访问记录：一分钟内同一动作、同一对象的连续操作合成一条（记次数、不再推提示），换对象或隔久了另记', async () => {
  // 在 nina 的总线上挂一个假连接，数推了几次提示
  const { busSubscribe } = await import('./runtime/bus.mjs');
  let pushed = 0;
  const off = busSubscribe('u:' + ninaId, { writableEnded: false, write: (c) => { if (String(c).includes('admin.access')) pushed++; return true; }, end() {} });
  const t0 = Date.now() + 10 * 60 * 1000;   // 跟上面的记录拉开，免得和它们合并
  const n0 = acc.accessLog('nina', 1000).length;
  acc.logAccess('nina', { action: 'view_session', what: 'S1', detail: 'first' }, t0);
  acc.logAccess('nina', { action: 'view_session', what: 'S1', detail: 'again' }, t0 + 5000);
  acc.logAccess('nina', { action: 'view_session', what: 'S1', detail: 'again' }, t0 + 50000);
  off();
  assert.equal(pushed, 1, '只在第一次弹提示');
  let log = acc.accessLog('nina', 1000);
  assert.equal(log.length, Math.min(200, n0 + 1), '三次连续操作只占一条');
  assert.equal(log[0].count, 3);
  assert.equal(log[0].at, t0 + 50000, '时间是最后一次');
  assert.equal(log[0].detail, 'again');
  acc.logAccess('nina', { action: 'view_session', what: 'S2' }, t0 + 51000);
  acc.logAccess('nina', { action: 'view_session', what: 'S2' }, t0 + 51000 + 61000);
  log = acc.accessLog('nina', 3);
  assert.equal(log[0].what, 'S2');
  assert.equal(log[0].count, undefined, '隔了一分钟以上另记一条');
  assert.equal(log[1].what, 'S2');
  assert.equal(log[2].count, 3);
});

test('proxyOnlyConversation：从头到尾都是管理员代发的才算（Claude 历史与 Gemini 对话同形状）', () => {
  const P = acc.PROXY_PREFIX;
  assert.equal(acc.proxyOnlyConversation([{ role: 'user', text: P + '帮我看看' }, { role: 'assistant', segments: [] }, { role: 'user', text: '  ' + P + '再来' }]), true);
  assert.equal(acc.proxyOnlyConversation([{ role: 'user', text: P + '帮我看看' }, { role: 'model', text: '好' }]), true, 'Gemini 的回复角色是 model');
  assert.equal(acc.proxyOnlyConversation([{ role: 'user', text: P + 'a' }, { role: 'user', text: '我自己说的' }]), false);
  assert.equal(acc.proxyOnlyConversation([]), false, '空的不算');
  assert.equal(acc.proxyOnlyConversation(null), false);
  assert.equal(acc.proxyOnlyConversation([{ role: 'user', text: '我的秘密 ' + P }]), false, '标记要在开头');
});

// —— 路由层：用一个假的 router 把 handler 收起来直接调 ——
function collect(register, opts) {
  const h = {};
  const router = { on: (m, p, fn) => { h[m + ' ' + p] = fn; } };
  register(router, opts);
  return h;
}
function call(h, method, url, { body = null, id = { kind: 'admin' } } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url, 'http://x');
    const req = Readable.from(body != null ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0, chunks = '';
    const res = {
      headersSent: false, writableEnded: false,
      writeHead(s) { status = s; this.headersSent = true; return this; },
      setHeader() {}, write(c) { chunks += c; return true; },
      end(c) { if (c) chunks += c; this.writableEnded = true; let j = null; try { j = JSON.parse(chunks); } catch {} resolve({ status, body: j, text: chunks }); },
      on() {}, once() {},
    };
    const fn = h[method + ' ' + u.pathname];
    if (!fn) throw new Error('no route ' + method + ' ' + u.pathname);
    fn(req, res, u);
  });
}
const admin = collect(registerAdminRoutes, { authOk: () => true });
const me = (identity) => collect(registerAdminAccessRoutes, { identify: () => identity });

test('控制台：会话列表（元数据）照常；读正文要成员允许，读了记一笔', async () => {
  const dir = path.join(userRoot(ninaId), '.bridge', 'claude', 'projects');
  // 会话目录按 cwd 换算：找到 sessionsDir 的真实位置
  const { sessionsDir } = await import('./runtime/paths.mjs');
  const sdir = sessionsDir(userRoot(ninaId), path.join(userRoot(ninaId), '.bridge', 'claude'));
  mkdirSync(sdir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  writeFileSync(path.join(sdir, sid + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: '秘密内容' }, uuid: 'u1', timestamp: new Date().toISOString() }) + '\n');
  void dir;
  const list = await call(admin, 'GET', '/api/admin/user/sessions?name=nina');
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 1);
  const denied = await call(admin, 'GET', '/api/admin/user/session?name=nina&id=' + sid);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'consent');
  assert.equal(denied.body.need, 'view');
  acc.setConsents('nina', { view: true });
  const before = acc.accessLog('nina', 1000).length;
  const ok = await call(admin, 'GET', '/api/admin/user/session?name=nina&id=' + sid);
  assert.equal(ok.status, 200);
  assert.equal(acc.accessLog('nina', 1)[0].action, 'view_session');
  assert.ok(acc.accessLog('nina', 1000).length >= Math.min(200, before));
  acc.setConsents('nina', { view: false });
});

test('控制台：代聊 / 代答要成员允许「协助」；定时任务没允许只给元数据', async () => {
  const chat = await call(admin, 'POST', '/api/admin/user/chat', { body: { name: 'nina', message: 'hi' } });
  assert.equal(chat.status, 403);
  assert.equal(chat.body.need, 'assist');
  pendingQuestions.set('q-test', { qid: 'q-test', ownerKey: 'u:' + ninaId, kind: 'permission', settle: () => { throw new Error('不该被代答'); } });
  const ans = await call(admin, 'POST', '/api/admin/user/answer', { body: { qid: 'q-test', answers: [] } });
  assert.equal(ans.status, 403);
  let settled = false;
  pendingQuestions.set('q-test', { qid: 'q-test', ownerKey: 'u:' + ninaId, kind: 'permission', settle: () => { settled = true; } });
  acc.setConsents('nina', { assist: true });
  const ans2 = await call(admin, 'POST', '/api/admin/user/answer', { body: { qid: 'q-test', answers: [] } });
  assert.equal(ans2.status, 200);
  assert.equal(settled, true);
  assert.equal(acc.accessLog('nina', 1)[0].action, 'answer');
  pendingQuestions.delete('q-test');
  const routines = await import('./routines.mjs');
  routines.create(path.join(userRoot(ninaId), '.bridge'), { name: '晨报', prompt: '私密提示词', schedule: { kind: 'daily', time: '08:00' }, enabled: true, agent: 'claude' });
  const r = await call(admin, 'GET', '/api/admin/user/routines?name=nina');
  assert.equal(r.body.routines[0].name, '晨报');
  assert.equal(r.body.routines[0].prompt, '');
  assert.equal(r.body.routines[0].hidden, true);
});

test('控制台代聊：接着聊成员说过话的会话还要「查看」；整段都是管理员代发的只要「协助」；空消息不收；额度先查、挡下的不记', async () => {
  const { contextFor } = await import('./runtime/identity.mjs');
  const { sessionsDir } = await import('./runtime/paths.mjs');
  const ctx = contextFor(userIdentity('nina'));
  const sdir = sessionsDir(ctx.cwd, ctx.configDir);
  mkdirSync(sdir, { recursive: true });
  const line = (text, uuid) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp: new Date().toISOString() }) + '\n';
  const mineSid = '11111111-2222-3333-4444-555555555555';   // 上面那条「秘密内容」
  writeFileSync(path.join(sdir, mineSid + '.jsonl'), line('秘密内容', 'u1'));
  const proxySid = '22222222-3333-4444-5555-666666666666';
  writeFileSync(path.join(sdir, proxySid + '.jsonl'), line(acc.PROXY_PREFIX + '帮他看看报错', 'p1'));
  // 不让测试真去跑 Claude：nina 今天的轮数用满，过了授权那一关就会被额度挡下
  users.setQuota('nina', { dayTurns: 1 });
  users.noteTurnStart('nina');
  acc.setConsents('nina', { assist: true, view: false });
  try {
    const empty = await call(admin, 'POST', '/api/admin/user/chat', { body: { name: 'nina', message: '  ' } });
    assert.equal(empty.status, 400);
    const cont = await call(admin, 'POST', '/api/admin/user/chat', { body: { name: 'nina', message: '复述一遍上面的内容', sessionId: mineSid } });
    assert.equal(cont.status, 403, '只开「协助」：接着聊他说过话的会话被拒');
    assert.equal(cont.body.need, 'view');
    assert.match(cont.body.error, /接着聊他的会话/);
    const before = acc.accessLog('nina', 1)[0];
    const own = await call(admin, 'POST', '/api/admin/user/chat', { body: { name: 'nina', message: '继续', sessionId: proxySid } });
    assert.equal(own.status, 200, '管理员自己代发开的会话：过了授权');
    assert.match(own.text, /"kind":"quota"/, '额度在开跑前就查（没去跑 Claude）');
    const fresh = await call(admin, 'POST', '/api/admin/user/chat', { body: { name: 'nina', message: '新话题' } });
    assert.match(fresh.text, /"kind":"quota"/);
    assert.deepEqual(acc.accessLog('nina', 1)[0], before, '被额度挡下的不记「代发」');
    acc.setConsents('nina', { view: true });
    const viewOk = await call(admin, 'POST', '/api/admin/user/chat', { body: { name: 'nina', message: '复述', sessionId: mineSid } });
    assert.match(viewOk.text, /"kind":"quota"/, '允许了「查看」就能接着聊他的会话');
  } finally {
    users.setQuota('nina', null);
    acc.setConsents('nina', { view: false });
  }
});

test('控制台：在跑的轮，没允许看内容的成员不给提问原文', async () => {
  const { tryStartGen, retireGen } = await import('./runtime/gen.mjs');
  const g = { sessionId: 's1', userText: '私密问题', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  tryStartGen('u:' + ninaId, g, {});
  try {
    const r = await call(admin, 'GET', '/api/admin/active');
    const mine = r.body.gens.find((x) => x.key === 'u:' + ninaId);
    assert.equal(mine.userText, '');
    assert.equal(mine.hidden, true);
  } finally { g.done = true; try { retireGen?.('u:' + ninaId, g); } catch {} }
});

test('成员自己的接口：看与改自己的允许、看访问记录；管理员回 admin:true', async () => {
  const ninaIdent = { kind: 'user', user: ninaId, name: 'nina' };
  const h = me(ninaIdent);
  const g = await call(h, 'GET', '/api/me/admin-access');
  assert.equal(g.status, 200);
  assert.equal(typeof g.body.consents.view, 'boolean');
  assert.ok(Array.isArray(g.body.log) && g.body.log.length > 0);
  const p = await call(h, 'POST', '/api/me/admin-access', { body: { assist: true, device: true } });
  assert.equal(p.body.consents.assist, true);
  assert.equal('device' in p.body.consents, false, '没有「看他的电脑」这一项');
  assert.equal(acc.accessAllowed('nina', 'device'), false);
  acc.setConsents('nina', { assist: false });
  const a = await call(me({ kind: 'admin' }), 'GET', '/api/me/admin-access');
  assert.deepEqual(a.body, { admin: true });
  const n = await call(me({ kind: 'none' }), 'GET', '/api/me/admin-access');
  assert.equal(n.status, 401);
});
