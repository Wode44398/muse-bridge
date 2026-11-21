// 同机实例（dimensio）调核心共享终端的内部接口：凭据与本机直连、只认 dimensio、命令行门禁、工作空间圈定、
// 池键按凭据认出的属主分（成员的终端与管理员的同一目录互不相通，与面板 /api/claude/term/*?ws= 同一把键）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-runtime-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_BROWSER_PERSIST = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: 'x'.repeat(32), features: { multiUser: true } }, null, 2));

const users = await import('../users.mjs');
const { contextFor, userIdentity } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerAgentTermRoutes, registerAgentBrowserRoutes, agentBrowserSession } = await import('./agent-runtime.mjs');
const { agentUrlGuard, controlPorts } = await import('./agent-runtime/url-guard.mjs');
const browser = await import('../runtime/claude-browser.mjs');
const { ensureHostSecret } = await import('../runtime/host-secret.mjs');
const { mintAgentDeviceToken } = await import('../runtime/agent-device-token.mjs');
const { poolRef } = await import('../runtime/principal.mjs');
const term = await import('../runtime/claude-term.mjs');

const router = createRouter();
registerAgentTermRoutes(router);
registerAgentBrowserRoutes(router);
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const spawned = [];
after(() => { for (const ref of spawned) term.killTerm(ref); server.close(); });

const post = async (route, tok, body, headers = {}) => {
  const r = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};
const DIM = { 'x-bridge-agent': 'dimensio' };
const say = (j) => (j?.content || []).map((c) => c.text).join('\n');

test('凭据：没有 / 认不出 → 404；主机密钥不报 dimensio → 403', async () => {
  const ws = mkdtempSync(path.join(tmp, 'ws-'));
  assert.equal((await post('/api/internal/agent-term', '', { ws, args: { action: 'status' } })).status, 404);
  assert.equal((await post('/api/internal/agent-term', 'nope', { ws, args: { action: 'status' } })).status, 404);
  const host = await post('/api/internal/agent-term', ensureHostSecret(), { ws, args: { action: 'status' } });
  assert.equal(host.status, 403);
  assert.equal(host.json.code, 'agent');
  const codex = await post('/api/internal/agent-term', ensureHostSecret(), { ws, args: { action: 'status' } }, { 'x-bridge-agent': 'codex' });
  assert.equal(codex.status, 403, '别的同机实例不走这条');
});

test('管理员实例：ws 必填、不存在 404；status 不凭空起壳', async () => {
  const ws = mkdtempSync(path.join(tmp, 'ws-'));
  const sec = ensureHostSecret();
  assert.equal((await post('/api/internal/agent-term', sec, { args: { action: 'status' } }, DIM)).status, 400);
  assert.equal((await post('/api/internal/agent-term', sec, { ws: path.join(tmp, 'nope'), args: { action: 'status' } }, DIM)).status, 404);
  assert.equal((await post('/api/internal/agent-term', sec, { ws, args: {} }, DIM)).status, 400);
  const r = await post('/api/internal/agent-term', sec, { ws, args: { action: 'status' } }, DIM);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.match(say(r.json), /终端尚未启动/);
  assert.equal(term.getTerm(poolRef('admin', realpathSync(ws))), null);
});

test('成员：普通档没有命令行 → 403；完全信任档只能进自己的空间，终端按他的属主键开', { timeout: 60_000 }, async () => {
  const plain = await users.createUser('rtplain', 'pw-rtplain-123', 'user');
  assert.ok(plain.ok, plain.error);
  users.setAgents('rtplain', ['claude', 'dimensio']);
  const plainCtx = contextFor(userIdentity(plain.id));
  mkdirSync(plainCtx.cwd, { recursive: true });
  const r0 = await post('/api/internal/agent-term', mintAgentDeviceToken(plain.id, 'dimensio'), { ws: plainCtx.cwd, args: { action: 'status' } });
  assert.equal(r0.status, 403);
  assert.equal(r0.json.code, 'no_shell');

  const pro = await users.createUser('rtpro', 'pw-rtpro-123', 'pro');
  assert.ok(pro.ok, pro.error);
  users.setAgents('rtpro', ['claude', 'dimensio']);
  const ctx = contextFor(userIdentity(pro.id));
  const own = path.join(ctx.cwd, 'proj');
  mkdirSync(own, { recursive: true });
  const tok = mintAgentDeviceToken(pro.id, 'dimensio');
  const outside = mkdtempSync(path.join(tmp, 'ws-'));
  const r1 = await post('/api/internal/agent-term', tok, { ws: outside, args: { action: 'status' } });
  assert.equal(r1.status, 403, '工作空间外的目录不给');

  const r2 = await post('/api/internal/agent-term', tok, { ws: own, args: { action: 'run', command: 'echo agent-term-ok', waitSec: 15 } });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  const ref = poolRef(ctx, realpathSync(own));
  spawned.push(ref);
  assert.match(say(r2.json), /agent-term-ok/);
  assert.ok(term.getTerm(ref), '开在成员自己的属主键上（面板 /api/claude/term/stream?ws= 拿到的就是它）');
  assert.equal(term.getTerm(poolRef('admin', realpathSync(own))), null, '同一路径的管理员键上没有');
});

// —— 浏览器 ——
test('浏览器会话键：dimensio 会话 id → d_<id>（过 cleanSessionId）；不合法的拒', () => {
  assert.equal(agentBrowserSession('9f1c2b3a-1111-4222-8333-444455556666'), 'd_9f1c2b3a-1111-4222-8333-444455556666');
  assert.equal(agentBrowserSession(''), 'd_', '还不属于任何会话的那份');
  assert.equal(agentBrowserSession('a/b'), null);
  assert.equal(agentBrowserSession('x'.repeat(79)), null, '拼上前缀超过 80 位');
});

test('浏览器接口：会话键不合法 400；state / isolate / close 落在 (属主, ws, d_<id>) 上，与面板同一把键', async () => {
  const ws = mkdtempSync(path.join(tmp, 'ws-'));
  const sec = ensureHostSecret();
  const call = (body) => post('/api/internal/agent-browser', sec, { ws, ...body }, DIM);
  assert.equal((await call({ session: 'a b', op: 'state' })).status, 400);
  assert.equal((await call({ session: 's1', op: 'nope' })).status, 400);
  const st = await call({ session: 's1', op: 'state' });
  assert.deepEqual(st.json, { ok: true, alive: false, isolated: false });
  const iso = await call({ session: 's1', op: 'isolate', on: true });
  assert.equal(iso.json.isolated, true);
  const ref = poolRef('admin', realpathSync(ws), 'd_s1');
  assert.equal(browser.browserIsolated(ref), true, '面板 /api/claude/browser/state?ws=&session=d_s1 看到的就是这个开关');
  assert.equal(browser.browserIsolated(poolRef('admin', realpathSync(ws), 's1')), false, '没有前缀的键是另一份（Claude 的会话）');
  assert.equal((await call({ session: 's1', op: 'close', forget: true })).json.ok, true);
  assert.equal(browser.browserIsolated(ref), false, '会话删了：隔离开关一起忘掉');
  assert.equal((await call({ session: 's1', args: { action: 'batch', actions: [] } })).status, 400, 'batch 要逐步来');
  const tabs = await call({ session: 's1', args: { action: 'tabs' } });
  assert.equal(tabs.status, 200, JSON.stringify(tabs.json));
  assert.match(say(tabs.json), /浏览器没在运行/);
  assert.equal(tabs.json.activity, false);
});

test('浏览器接口：控制面与工作空间外的 file:// 在拉起浏览器之前就拒；成员普通档没有浏览器', async () => {
  const ws = mkdtempSync(path.join(tmp, 'ws-'));
  const sec = ensureHostSecret();
  const nav = (tok, body, h = DIM) => post('/api/internal/agent-browser', tok, { session: 's2', ...body }, h);
  const cp = await nav(sec, { ws, args: { action: 'navigate', url: 'http://127.0.0.1:8787/' } });
  assert.equal(cp.json.isError, true);
  assert.match(say(cp.json), /控制面/);
  const extra = await nav(sec, { ws, denyPorts: [8851], args: { action: 'navigate', url: 'http://localhost:8851/api' } });
  assert.match(say(extra.json), /控制面/, '实例报来的端口一起拦');
  assert.equal(browser.existingBrowser(poolRef('admin', realpathSync(ws), 'd_s2')), null, '没有为注定被拒的导航拉起浏览器');

  const m = await users.createUser('rtbrowser', 'pw-rtbrowser-123', 'pro');
  assert.ok(m.ok, m.error);
  users.setAgents('rtbrowser', ['claude', 'dimensio']);
  const ctx = contextFor(userIdentity(m.id));
  const own = path.join(ctx.cwd, 'site');
  mkdirSync(own, { recursive: true });
  const tok = mintAgentDeviceToken(m.id, 'dimensio');
  const outside = mkdtempSync(path.join(tmp, 'secret-'));
  writeFileSync(path.join(outside, 'a.txt'), 'x');
  const f = await nav(tok, { ws: own, args: { action: 'navigate', url: 'file:///' + path.join(outside, 'a.txt').replace(/\\/g, '/') } }, {});
  assert.equal(f.json.isError, true);
  assert.match(say(f.json), /工作空间/);

  const plain = await users.createUser('rtbrowserplain', 'pw-rtbrowserplain-123', 'user');
  users.setAgents('rtbrowserplain', ['claude', 'dimensio']);
  const pctx = contextFor(userIdentity(plain.id));
  mkdirSync(pctx.cwd, { recursive: true });
  const r = await nav(mintAgentDeviceToken(plain.id, 'dimensio'), { ws: pctx.cwd, args: { action: 'tabs' } }, {});
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'no_shell', '普通档成员继续用 dimensio 本地的浏览器');
});

test('去处守卫：回环上的控制面端口（含解析到回环的写法）拒；公网、普通本机端口、about/data 放行；javascript: 拒', async () => {
  const ws = mkdtempSync(path.join(tmp, 'ws-'));
  const admin = contextFor({ kind: 'admin', user: null });
  const deny = agentUrlGuard(admin, ws, { extraPorts: [8860] });
  assert.ok(controlPorts().has(8787) && controlPorts().has(8799) && controlPorts().has(5178));
  for (const u of ['http://127.0.0.1:8787/', 'http://localhost:8799/api/info', 'http://[::1]:8787/', 'http://0.0.0.0:8860/']) assert.ok(await deny(u), u);
  for (const u of ['about:blank', 'data:text/html,hi', 'https://example.com/', 'http://127.0.0.1:5173/', 'file:///C:/anything.txt']) assert.equal(await deny(u), null, u);
  assert.ok(await deny('javascript:alert(1)'));
});
