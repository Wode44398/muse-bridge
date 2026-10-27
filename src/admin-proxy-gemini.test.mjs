// 管理员代聊 Gemini（开源路线 S2-6）：和代聊 Claude 一个口径——开跑前查被代的人的额度、开跑即记他的账；
// 接着聊他自己说过话的 Gemini 对话还要他允许「查看」。要真的加载 Gemini 扩展（agent 才算可用），单独一个文件，
// 免得改了别的测试的环境。数据根改道到临时目录：别碰仓库里（或正式服）的 config.json / 账号库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-proxygem-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18998, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true } }, null, 2));

const registry = await import('./modules/registry.mjs');
await registry.loadModules();
const users = await import('./users.mjs');
const acc = await import('./runtime/admin-access.mjs');
const { registerAdminRoutes } = await import('./routes/admin.mjs');
const { userIdentity, contextFor } = await import('./runtime/identity.mjs');

await users.createUser('olga', 'password123', 'user');
const vertex = registry.getModule('vertex');
const ctx = contextFor(userIdentity('olga'));
const skip = !vertex?.runVertexChat ? 'Gemini 扩展没加载' : !ctx.allowGemini ? '这台机器上 Gemini agent 不可用' : false;

function call(h, method, url, body) {
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
    h[method + ' ' + u.pathname](req, res, u);
  });
}
const h = {};
registerAdminRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, { authOk: () => true });

test('代聊 Gemini：被代的人额度用满就挡下（以前直接开跑、也不记账），挡下的不记账也不记「代发」', { skip }, async () => {
  acc.setConsents('olga', { assist: true });
  users.setQuota('olga', { dayTurns: 1 });
  users.noteTurnStart('olga');
  const turns = () => users.usageWindow('olga').today.turns;
  assert.equal(turns(), 1);
  const before = acc.accessLog('olga', 1)[0];
  const r = await call(h, 'POST', '/api/admin/user/chat', { name: 'olga', agent: 'vertex', message: '帮他查一下' });
  assert.equal(r.status, 200);
  assert.match(r.text, /"kind":"quota"/);
  assert.equal(turns(), 1, '挡下的不记轮');
  assert.deepEqual(acc.accessLog('olga', 1)[0], before);
  // Claude 同一个口径
  const c = await call(h, 'POST', '/api/admin/user/chat', { name: 'olga', message: '帮他查一下' });
  assert.match(c.text, /"kind":"quota"/);
  users.setQuota('olga', null);
});

test('代聊 Gemini：接着聊他自己说过话的对话要「查看」；整段管理员代发的只要「协助」', { skip }, async () => {
  acc.setConsents('olga', { assist: true, view: false });
  const dir = ctx.vertexHist;
  mkdirSync(dir, { recursive: true });
  // 直接按 vertex-history 的存法摆两段对话（turns: [{ role, text }]）
  const put = (id, turns) => writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, title: 't', turns }));
  const mine = 'aaaaaaaa-1111-2222-3333-444444444444';
  const own = 'bbbbbbbb-1111-2222-3333-444444444444';
  put(mine, [{ role: 'user', text: '我的私事' }, { role: 'model', text: '好的' }]);
  put(own, [{ role: 'user', text: acc.PROXY_PREFIX + '帮他看看' }, { role: 'model', text: '好的' }]);
  assert.ok(vertex.loadConversation(own, dir), '对话按 vertex-history 的格式摆好了');
  users.setQuota('olga', { dayTurns: 1 });
  try {
    const a = await call(h, 'POST', '/api/admin/user/chat', { name: 'olga', agent: 'vertex', message: '复述', sessionId: mine });
    assert.equal(a.status, 403);
    assert.equal(a.body.need, 'view');
    const b = await call(h, 'POST', '/api/admin/user/chat', { name: 'olga', agent: 'vertex', message: '继续', sessionId: own });
    assert.equal(b.status, 200, '过了授权（随后被额度挡下）');
    assert.match(b.text, /"kind":"quota"/);
  } finally { users.setQuota('olga', null); }
});
