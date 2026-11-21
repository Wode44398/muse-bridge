// 插件页面里和 Claude 对话：_bridge/chat/start|send|events|stop|sessions|history。
// /api/chat、/api/stop、/api/session 用替身路由（setInternalRouter 指向测试路由器）：替身照真路由的样子占一个 gen、
// 「SDK init」后打 pluginOrigin 标、推 session 帧，事件由测试按需推——这样能测授权、归属、参数翻译、事件映射与跨轮，
// 不起真 Claude。pluginOrigin 的真判定（只认内部请求）用的是 routes/chat.mjs 导出的 pluginOriginFor 本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-pagechat-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
mkdirSync(process.env.VAULT_PATH, { recursive: true });

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { normUi, PERMISSIONS } = await import('./discover.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerPluginRoutes } = await import('../routes/plugins.mjs');
const { mintTicket } = await import('./tickets.mjs');
const { setInternalRouter } = await import('../agent-api/internal.mjs');
const { pluginOriginFor } = await import('../routes/chat.mjs');
const { mapChatEvent, chatEvents, turnIdOf, PROMPT_MAX, _setTranscriptCheck } = await import('./page-chat.mjs');
// 这里的会话 id 是假的（sess-<uuid>），磁盘上没有转录：sessions 的「转录还在」过滤一律当在（过滤本身在 finish3b.test.mjs 测）
_setTranscriptCheck(() => true);
const G = await import('../runtime/gen.mjs');
const { writeSseHeaders, sseWrite } = await import('../runtime/sse.mjs');
const users = await import('../users.mjs');
const { userIdentity, contextFor, INTERNAL_IDENTITY } = await import('../runtime/identity.mjs');

installMixins();
const router = createRouter();
let memberIdentity = null;
const identify = (req) => {
  if (req[INTERNAL_IDENTITY]) return req[INTERNAL_IDENTITY];
  const k = req.headers['x-test'];
  if (k === 'admin') return { kind: 'admin', user: null };
  if (k === 'member') return memberIdentity;
  return { kind: 'none', user: null };
};
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
registerPluginRoutes(router, { identify });

// ---- 替身：/api/chat、/api/stop、/api/session ----
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
async function readAll(req) { const a = []; for await (const ch of req) a.push(Buffer.from(ch)); return Buffer.concat(a).toString('utf8'); }
const calls = [];       // 每次 /api/chat：{ key, internal, parsed, origin }
const turns = [];       // 替身占的每个 gen
const stops = [];
const histories = new Map();
let mode = 'ok';        // ok | quota | busy | reject | held | notRunning | spare
router.on('POST', '/api/chat', async (req, res) => {
  const c = contextFor(identify(req));
  const parsed = JSON.parse((await readAll(req)) || '{}');
  // 真路由（routes/chat.mjs）就是这一句：只认进程内请求带来的 pluginOrigin
  const origin = pluginOriginFor(req, parsed, { sessionId: parsed.sessionId });
  calls.push({ key: c.key, internal: !!req[INTERNAL_IDENTITY], parsed, origin });
  if (mode === 'reject') { sendJson(res, 403, { error: '这个档位用不了这个模型' }); return; }
  if (mode === 'held') { sendJson(res, 409, { error: 'held', code: 'held_elsewhere' }); return; }
  if (parsed.priority === 'later') {
    const live = G.getLiveGens(c.key).some((g) => g.sessionId === parsed.sessionId);
    if (live && mode !== 'notRunning') { sendJson(res, 200, { ok: true, queued: true }); return; }
    sendJson(res, 409, { error: '这个会话没在跑', code: 'not_running' });
    return;
  }
  writeSseHeaders(res);
  if (mode === 'quota') { sseWrite(res, { type: 'error', kind: 'quota', title: '额度用完了', message: '周一恢复' }); res.end(); return; }
  if (mode === 'busy') { sseWrite(res, { type: 'error', kind: 'busy', title: '同时在跑的对话太多' }); res.end(); return; }
  const g = { sessionId: parsed.sessionId || null, userText: parsed.message, events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  G.tryStartGen(c.key, g);
  G.genSubscribe(g, res);
  turns.push(g);
  // 新会话要等「SDK init」才有 id：异步一拍再打标、推 session 帧（真路由在 agents/claude/frames.mjs 的 onInit 里）。
  // spare：这一轮被预热好的 CLI 接走——init 落在预热那一轮的 run 上，看不到这次的 pluginOrigin，不打标
  setTimeout(() => {
    if (!g.sessionId) g.sessionId = 'sess-' + randomUUID();
    if (origin && mode !== 'spare') G.markPluginSession(g.sessionId, { ...origin, owner: c.key });
    G.genEmit(g, { type: 'session', sessionId: g.sessionId });
    G.genEmit(g, { type: 'text', text: '收到：' + parsed.message });
  }, 5);
});
router.on('POST', '/api/stop', async (req, res) => {
  const c = contextFor(identify(req));
  const b = JSON.parse((await readAll(req)) || '{}');
  stops.push({ key: c.key, ...b });
  for (const g of G.getLiveGens(c.key)) if (g.sessionId === b.sessionId) { G.genEmit(g, { type: 'interrupted' }); G.genFinish(g); }
  sendJson(res, 200, { ok: true });
});
router.on('GET', '/api/session', (req, res, url) => {
  const h = histories.get(url.searchParams.get('id'));
  if (!h) { sendJson(res, 404, { error: 'not found' }); return; }
  sendJson(res, 200, { messages: h });
});
setInternalRouter(router);

const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const PID = 'pg-chat';
const NODECL = 'pg-chat-nodecl';
const HOSTONLY = 'pg-chat-host';
const OTHER = 'pg-chat-other';
const perms = (...ids) => ids.map((id) => ({ id, label: PERMISSIONS[id] || id }));
async function addPlugin(id, apps, permissions) {
  const dir = path.join(tmp, 'src-' + id);
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'web', 'app.html'), '<!doctype html><p>app</p>');
  const manifest = { id, name: '插件 ' + id, ui: { apps } };
  await kernel.register({
    id, name: manifest.name, source: 'local', dir, pluginApi: 3,
    extra: { ui: normUi(manifest, dir), permissions },
    load: async () => ({ apply() {} }),
  });
  assert.ok(kernel.isActive(id), kernel.get(id)?.error || '');
}

test.before(async () => {
  await kernel.start();
  const r = await users.createUser('chatmember', 'pw-chatmember-123', 'user');
  assert.ok(r.ok, r.error);
  memberIdentity = userIdentity(r.id);
  await addPlugin(PID, [
    { id: 'main', title: '对话应用', page: 'web/app.html', who: 'members' },
    { id: 'side', title: '侧边应用', page: 'web/app.html', who: 'members' },
  ], perms('page.chat'));
  await addPlugin(NODECL, [{ id: 'main', title: '没声明', page: 'web/app.html', who: 'members' }], perms('ui'));
  await addPlugin(HOSTONLY, [{ id: 'main', title: '主机的', page: 'web/app.html' }], perms('page.chat'));
  await addPlugin(OTHER, [{ id: 'main', title: '别的插件', page: 'web/app.html', who: 'members' }], perms('page.chat'));
});
test.after(async () => { server.closeAllConnections?.(); server.close(); await kernel.stop(); });
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const MKEY = () => 'u:' + memberIdentity.user;
async function call(method, p, { as = '', ticket = '', body } = {}) {
  const headers = {};
  if (as) headers['x-test'] = as;
  // 授权接口只认 bridge 自己界面发的（X-Bridge-UI: 1），这里模拟主界面
  if (p.startsWith('/api/plugins/grants')) headers['x-bridge-ui'] = '1';
  if (ticket) headers.authorization = 'Plugin ' + ticket;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const chat = (plugin, sub) => `/api/plugin/${plugin}/_bridge/chat/${sub}`;
const grant = (as, plugin, allow = true) => call('POST', '/api/plugins/grants', { as, body: { plugin, perm: 'page.chat', allow } });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// 开一条页面事件流（真 HTTP），逐帧收事件；waitFor(条件) 等到某帧
function openEvents(p, as) {
  return new Promise((resolve) => {
    const req = http.get(base + p, { headers: { 'x-test': as } }, (res) => {
      const out = { status: res.statusCode, headers: res.headers, events: [], raw: '', ended: false, close: () => req.destroy() };
      const waiters = new Set();
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (s) => {
        out.raw += s;
        buf += s;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const d = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (d) { try { out.events.push(JSON.parse(d)); } catch {} }
        }
        for (const w of [...waiters]) w();
      });
      res.on('end', () => { out.ended = true; for (const w of [...waiters]) w(); });
      out.waitFor = (pred, ms = 3000) => new Promise((ok, no) => {
        const check = () => {
          const hit = out.events.find(pred);
          if (hit) { waiters.delete(check); clearTimeout(t); ok(hit); }
        };
        const t = setTimeout(() => { waiters.delete(check); no(new Error('等不到事件，已收：' + JSON.stringify(out.events))); }, ms);
        waiters.add(check);
        check();
      });
      resolve(out);
    });
    req.on('error', () => {});
  });
}
const finishTurn = (g, result = '好了') => { G.genEmit(g, { type: 'done', result }); G.genFinish(g); };

test('没授权：start / sessions / events 都 403 needGrant；没声明的带 undeclared；主机专用插件成员够不着', async () => {
  const s = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '你好' } });
  assert.equal(s.status, 403);
  assert.equal(s.json.needGrant, 'page.chat');
  assert.equal(s.json.undeclared, undefined);
  assert.equal((await call('GET', chat(PID, 'sessions'), { as: 'member' })).json.needGrant, 'page.chat');
  const ev = await call('GET', chat(PID, 'events?session=sess-whatever'), { as: 'member' });
  assert.equal(ev.status, 403, '前置检查不过回 JSON，不开 SSE');
  assert.equal(ev.json.needGrant, 'page.chat');
  const nd = await call('POST', chat(NODECL, 'start'), { as: 'member', body: { prompt: '你好' } });
  assert.equal(nd.status, 403);
  assert.equal(nd.json.undeclared, true);
  assert.equal(nd.json.perm, 'page.chat');
  assert.equal(nd.json.needGrant, undefined, '没声明就别让 SDK 弹授权框（弹了也是白弹）');
  assert.equal((await call('POST', chat(HOSTONLY, 'start'), { as: 'member', body: { prompt: '你好' } })).status, 403);
  assert.equal(calls.length, 0, '一次都没发到 /api/chat');
  assert.equal((await call('POST', chat(PID, 'answer'), { as: 'member', body: { qid: 'q1', allow: true } })).status, 404, '没有代批接口');
});

let SID = '';
test('start：经内部请求代发 /api/chat（带 pluginOrigin、不带 family），拿到会话 id 就松手；会话打上插件 / 应用 / 使用者标', async () => {
  assert.equal((await grant('member', PID)).status, 200);
  const ticket = mintTicket(PID, memberIdentity, { app: 'main' }).ticket;
  const r = await call('POST', chat(PID, 'start'), { ticket, body: { prompt: '帮我看看', app: 'side', family: { origin: 'x' }, model: 'opus', effort: 'high', pluginOrigin: { plugin: 'evil' } } });
  assert.equal(r.status, 200, r.text);
  SID = r.json.sessionId;
  assert.match(SID, /^sess-/);
  const c = calls.at(-1);
  assert.equal(c.internal, true);
  assert.equal(c.key, MKEY(), '以使用者本人身份发');
  assert.deepEqual(c.parsed, { message: '帮我看看', agent: 'claude', pluginOrigin: { plugin: PID, app: 'main', label: '对话应用' }, model: 'opus', effort: 'high' }, '票据上的应用为准；family / 页面自带的 pluginOrigin 都不转');
  assert.deepEqual(c.origin, { plugin: PID, app: 'main', label: '对话应用' });
  const ps = G.pluginSessions.get(SID);
  assert.equal(ps.plugin, PID);
  assert.equal(ps.app, 'main');
  assert.equal(ps.owner, MKEY());
  assert.equal(ps.label, '对话应用');
  // 松手：内部请求的收集端已从这一轮的订阅里摘掉，这一轮照跑
  const g = turns.at(-1);
  assert.equal(g.subscribers.size, 0);
  assert.equal(g.done, false);
  finishTurn(g);

  // 嵌入模式（登录态、没有票据）：请求体里的 app 只认本插件确有的
  const e1 = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '侧边', app: 'side', model: 'bad model!' } });
  assert.equal(e1.status, 200, e1.text);
  assert.deepEqual(calls.at(-1).parsed, { message: '侧边', agent: 'claude', pluginOrigin: { plugin: PID, app: 'side', label: '侧边应用' } }, '型号不合规就不带');
  finishTurn(turns.at(-1));
  const e2 = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '没应用', app: 'ghost' } });
  assert.equal(e2.status, 200);
  assert.deepEqual(calls.at(-1).parsed.pluginOrigin, { plugin: PID, app: null, label: '插件 pg-chat' });
  assert.equal(G.pluginSessions.get(e2.json.sessionId).app, undefined);
  finishTurn(turns.at(-1));

  // 参数
  assert.equal((await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '  ' } })).status, 400);
  assert.equal((await call('POST', chat(PID, 'start'), { as: 'member', body: {} })).status, 400);
  assert.equal((await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: 'x'.repeat(PROMPT_MAX + 1) } })).status, 413);
  assert.equal((await call('GET', chat(PID, 'start'), { as: 'member' })).status, 404, '方法不对');
});

test('start：/api/chat 的各种失败翻成页面看得懂的状态码', async () => {
  try {
    mode = 'quota';
    const q = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '1' } });
    assert.equal(q.status, 429);
    assert.match(q.json.error, /额度用完了/);
    mode = 'busy';
    assert.equal((await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '1' } })).status, 409);
    mode = 'reject';
    const rj = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '1' } });
    assert.equal(rj.status, 403);
    assert.match(rj.json.error, /档位/);
    mode = 'held';
    assert.equal((await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '1' } })).status, 409);
  } finally { mode = 'ok'; }
});

test('start：新会话被预热好的 CLI（spare）接走、init 里没打标——start 自己打标，send / events / history / 会话列表照常', async () => {
  let sid = '';
  mode = 'spare';
  try {
    const r = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '预热接走', app: 'side' } });
    assert.equal(r.status, 200, r.text);
    sid = r.json.sessionId;
  } finally { mode = 'ok'; }
  assert.ok(calls.at(-1).origin, '/api/chat 照样收到了 pluginOrigin，只是 init 回调没用上');
  const ps = G.pluginSessions.get(sid);
  assert.deepEqual({ plugin: ps.plugin, app: ps.app, label: ps.label, owner: ps.owner }, { plugin: PID, app: 'side', label: '侧边应用', owner: MKEY() });
  const g1 = turns.at(-1);
  // 转录还没落盘（第一轮还在跑）：history 回空，不是 404「记录没了」——页面刚 start 完就拉历史也照常往下订阅
  const h0 = await call('GET', chat(PID, 'history?session=' + sid), { as: 'member' });
  assert.equal(h0.status, 200, h0.text);
  assert.deepEqual(h0.json, { messages: [] });
  // events 认得这个会话：补发正在跑的这一轮
  const es = await openEvents(chat(PID, 'events?session=' + sid), 'member');
  try {
    assert.equal(es.status, 200);
    await es.waitFor((e) => e.type === 'text' && e.text === '收到：预热接走');
    finishTurn(g1, '完了');
    await es.waitFor((e) => e.type === 'done');
    // send 认得这个会话
    const s = await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: sid, text: '接着说' } });
    assert.deepEqual(s.json, { ok: true, queued: false });
    await es.waitFor((e) => e.type === 'turn' && e.userText === '接着说');
    finishTurn(turns.at(-1));
  } finally { es.close(); }
  histories.set(sid, [{ role: 'user', text: '预热接走' }]);
  assert.equal((await call('GET', chat(PID, 'history?session=' + sid), { as: 'member' })).status, 200);
  histories.delete(sid);
  assert.ok((await call('GET', chat(PID, 'sessions?app=side'), { as: 'member' })).json.some((x) => x.sessionId === sid));
});

test('send / stop / history / events：只认本插件替本人开的会话，别的一律 404', async () => {
  // 别的插件替他开的、主机的、ctx.chat 开的（没有 owner）、手打的
  const foreign = 'sess-' + randomUUID();
  G.markPluginSession(foreign, { plugin: OTHER, label: 'x', app: 'main', owner: MKEY() });
  const hosts = 'sess-' + randomUUID();
  G.markPluginSession(hosts, { plugin: PID, label: 'x', app: 'main', owner: 'admin' });
  const legacy = 'sess-' + randomUUID();
  G.markPluginSession(legacy, { plugin: PID, label: 'x' });
  for (const sid of [foreign, hosts, legacy, 'sess-unknown-1234', '../etc', '']) {
    assert.equal((await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: sid, text: 'hi' } })).status, 404, 'send ' + sid);
    assert.equal((await call('POST', chat(PID, 'stop'), { as: 'member', body: { sessionId: sid } })).status, 404, 'stop ' + sid);
    assert.equal((await call('GET', chat(PID, 'history?session=' + encodeURIComponent(sid)), { as: 'member' })).status, 404, 'history ' + sid);
    const ev = await call('GET', chat(PID, 'events?session=' + encodeURIComponent(sid)), { as: 'member' });
    assert.equal(ev.status, 404, 'events ' + sid);
    assert.match(ev.json.error, /不是这个插件替你开的/);
  }
  // 别的插件拿这个会话 id 也不行；主机拿成员的也不行
  assert.equal((await grant('member', OTHER)).status, 200);
  assert.equal((await call('POST', chat(OTHER, 'send'), { as: 'member', body: { sessionId: SID, text: 'hi' } })).status, 404);
  assert.equal((await grant('admin', PID)).status, 200);
  assert.equal((await call('POST', chat(PID, 'send'), { as: 'admin', body: { sessionId: SID, text: 'hi' } })).status, 404);
  // 参数
  assert.equal((await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: SID, text: '' } })).status, 400);
});

test('send：没在跑就开新一轮；正在跑就排队（queued:true）；刚好收尾了去掉排队重发', async () => {
  const n = calls.length;
  const r = await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: SID, text: '接着说' } });
  assert.deepEqual(r.json, { ok: true, queued: false });
  assert.deepEqual(calls.at(-1).parsed, { message: '接着说', agent: 'claude', sessionId: SID });
  assert.equal(calls.at(-1).origin, null, '续聊不再打标');
  const g = turns.at(-1);
  assert.equal(g.sessionId, SID);
  assert.equal(g.subscribers.size, 0, '同样松手');

  const q = await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: SID, text: '再补一句' } });
  assert.deepEqual(q.json, { ok: true, queued: true });
  assert.equal(calls.at(-1).parsed.priority, 'later');

  // done 已发、只剩定局收尾（agents/claude/turn-ledger.mjs 的 emitDone 打的 finalizing）：页面那头这轮已经完了，走普通发送（/api/chat 自带
  // fin-wait 接着用停放的 CLI），不排队——排了要等收尾完 + 队列延迟才发，页面还白看一句「上一轮还没完」（要多等 2–3s）
  g.finalizing = true;
  const f = await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: SID, text: '收尾时又说一句' } });
  assert.deepEqual(f.json, { ok: true, queued: false });
  assert.equal(calls.at(-1).parsed.priority, undefined, '收尾中的轮不算在跑');
  assert.equal(calls.at(-1).parsed.message, '收尾时又说一句');
  G.genFinish(g);   // 替身：老一轮收完（真路由里 fin-wait 等的就是这个）

  mode = 'notRunning';
  try {
    const q2 = await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: SID, text: '第三句' } });
    assert.deepEqual(q2.json, { ok: true, queued: false });
    assert.equal(calls.at(-2).parsed.priority, 'later');
    assert.equal(calls.at(-1).parsed.priority, undefined);
  } finally { mode = 'ok'; }
  assert.equal(calls.length, n + 5);
  for (const t of G.getLiveGens(MKEY())) finishTurn(t);
});

test('events：连上补发正在跑的一轮，映射成页面事件；之后每开一轮推 turn 再推这一轮；stop 收到 interrupted', async () => {
  const s = await call('POST', chat(PID, 'start'), { as: 'member', body: { prompt: '第一轮', app: 'main' } });
  const sid = s.json.sessionId;
  const g1 = turns.at(-1);
  await tick();
  const es = await openEvents(chat(PID, 'events?session=' + sid), 'member');
  try {
    assert.equal(es.status, 200);
    assert.match(es.headers['content-type'], /event-stream/);
    await es.waitFor((e) => e.type === 'text');
    assert.deepEqual(es.events.slice(0, 2), [{ type: 'turn', turn: turnIdOf(g1), userText: '第一轮' }, { type: 'text', text: '收到：第一轮' }], 'session 帧不转');
    assert.ok(typeof es.events[0].turn === 'string' && es.events[0].turn.endsWith('-' + sid), '轮次号是字符串、带会话 id');
    G.genEmit(g1, { type: 'tool', id: 't1', name: 'Read', input: { file_path: 'C:/secret' } });
    G.genEmit(g1, { type: 'tool_done', id: 't1', isError: false, output: '...' });
    G.genEmit(g1, { type: 'perm_request', qid: 'q1', tool: 'Bash', displayName: 'Bash', title: '运行命令 ls', description: 'ls -la', input: { command: 'ls' } });
    G.genEmit(g1, { type: 'question', sessionId: sid, pending: true });
    G.genEmit(g1, { type: 'perm_answer', qid: 'q1', allow: true });
    G.genEmit(g1, { type: 'thinking', text: '想一想' });
    finishTurn(g1, '第一轮完了');
    await es.waitFor((e) => e.type === 'done');
    assert.deepEqual(es.events.slice(2), [
      { type: 'tool', id: 't1', name: 'Read', status: 'start' },
      { type: 'tool', id: 't1', status: 'done', isError: false },
      { type: 'approval', kind: 'permission', qid: 'q1', title: '运行命令 ls', description: 'ls -la' },
      { type: 'approval.done', qid: 'q1' },
      { type: 'done', ok: true, result: '第一轮完了' },
    ], '工具入参、思考、状态通知都不给页面');

    // 跨轮：页面再发一句（同一条事件流接着推）
    await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: sid, text: '第二轮' } });
    const g2 = turns.at(-1);
    await es.waitFor((e) => e.type === 'turn' && e.userText === '第二轮');
    await es.waitFor((e) => e.type === 'text' && e.text === '收到：第二轮');
    // 轮次号：实时推（es 在这一轮开之前就连着）与连上补发（es2 这一轮开了以后才连）同号；换一轮换号
    const live2 = es.events.find((e) => e.type === 'turn' && e.userText === '第二轮');
    assert.equal(live2.turn, turnIdOf(g2));
    assert.notEqual(live2.turn, es.events[0].turn, '新一轮新号');
    const es2 = await openEvents(chat(PID, 'events?session=' + sid), 'member');
    try {
      await es2.waitFor((e) => e.type === 'text' && e.text === '收到：第二轮');
      assert.deepEqual(es2.events[0], { type: 'turn', turn: live2.turn, userText: '第二轮' }, '补发与实时推同号');
    } finally { es2.close(); }
    // stop：经 /api/stop 停掉，页面收到 interrupted
    const st = await call('POST', chat(PID, 'stop'), { as: 'member', body: { sessionId: sid } });
    assert.deepEqual(st.json, { ok: true });
    assert.deepEqual(stops.at(-1), { key: MKEY(), sessionId: sid });
    assert.equal(g2.done, true);
    await es.waitFor((e) => e.type === 'done' && e.interrupted);

    // 用户在 Claude 分页里接着这个会话说（不经页面）：页面照样看到新的一轮
    const g3 = { sessionId: sid, userText: '我在 Claude 分页里说的', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
    G.tryStartGen(MKEY(), g3);
    G.genEmit(g3, { type: 'text', text: '第三轮' });
    await es.waitFor((e) => e.type === 'turn' && e.userText === '我在 Claude 分页里说的');
    await es.waitFor((e) => e.text === '第三轮');
    finishTurn(g3);
    await es.waitFor((e) => e.type === 'done' && e.result === '好了');
    // 同一句话又发了一遍、甚至同一毫秒开起来（排队的下一轮紧接着上一轮收尾）：照样是新的一轮、新的号
    const g3b = { sessionId: sid, userText: g3.userText, events: [], subscribers: new Set(), done: false, startedAt: g3.startedAt };
    G.tryStartGen(MKEY(), g3b);
    G.genEmit(g3b, { type: 'text', text: '第三轮又一遍' });
    await es.waitFor((e) => e.text === '第三轮又一遍');
    const t3 = es.events.filter((e) => e.type === 'turn' && e.userText === g3.userText);
    assert.equal(t3.length, 2);
    assert.deepEqual(t3.map((e) => e.turn), [turnIdOf(g3), turnIdOf(g3b)]);
    assert.notEqual(t3[0].turn, t3[1].turn, '同文同毫秒也不撞号');
    finishTurn(g3b);
    await es.waitFor((e) => e.type === 'done' && es.events.filter((x) => x.type === 'done').length >= 4);
    // 别的会话的轮不混进来
    assert.ok(!es.events.some((e) => e.userText === '侧边'));
  } finally { es.close(); }
  // 页面断开：订阅收掉，之后的轮没人挂着
  await tick(50);
  const g4 = { sessionId: sid, userText: '断开以后', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  G.tryStartGen(MKEY(), g4);
  assert.equal(g4.subscribers.size, 0);
  finishTurn(g4);
});

test('sessions / history：只列本插件替本人开的（新的在前，可按应用筛）；记录只给正文', async () => {
  const list = (await call('GET', chat(PID, 'sessions'), { as: 'member' })).json;
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 4, JSON.stringify(list));
  assert.ok(list.every((x) => G.pluginSessions.get(x.sessionId).owner === MKEY()));
  assert.ok(list.some((x) => x.sessionId === SID && x.app === 'main' && x.label === '对话应用'));
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].at >= list[i].at, '新的在前');
  const side = (await call('GET', chat(PID, 'sessions?app=side'), { as: 'member' })).json;
  assert.ok(side.length >= 1 && side.every((x) => x.app === 'side'));
  const mine = new Set(list.map((x) => x.sessionId));
  const adminList = (await call('GET', chat(PID, 'sessions'), { as: 'admin' })).json;
  assert.equal(adminList.length, 1, '主机只看到替主机开的那个');
  assert.ok(adminList.every((x) => !mine.has(x.sessionId) && G.pluginSessions.get(x.sessionId).owner === 'admin'));
  const otherList = (await call('GET', chat(OTHER, 'sessions'), { as: 'member' })).json;
  assert.ok(otherList.every((x) => !mine.has(x.sessionId) && G.pluginSessions.get(x.sessionId).plugin === OTHER), '别的插件看不到这个插件的');

  histories.set(SID, [
    { role: 'user', text: '帮我看看' },
    { role: 'assistant', segments: [{ kind: 'tool', name: 'Read' }, { kind: 'text', md: '第一段' }, { kind: 'text', md: '第二段' }] },
    { role: 'assistant', segments: [{ kind: 'tool', name: 'Bash' }] },
    { role: 'system', text: '压缩了上下文' },
    { role: 'assistant', text: 'x'.repeat(25000) },
  ]);
  const h = await call('GET', chat(PID, 'history?session=' + SID), { as: 'member' });
  assert.equal(h.status, 200, h.text);
  assert.deepEqual(h.json.messages.slice(0, 2), [{ role: 'user', text: '帮我看看' }, { role: 'assistant', text: '第一段\n第二段' }]);
  assert.equal(h.json.messages.length, 3, '只有工具的、系统的都不给');
  assert.equal(h.json.messages[2].text.length, 20001, '每条截 20000 字');
  histories.delete(SID);
  assert.equal((await call('GET', chat(PID, 'history?session=' + SID), { as: 'member' })).status, 404, '记录没了');
});

test('网络上来的 /api/chat 带 pluginOrigin 一律忽略：冒充不了插件开的会话', async () => {
  // 真 HTTP 打 /api/chat（替身用的是真的 pluginOriginFor）
  const r = await fetch(base + '/api/chat', {
    method: 'POST', headers: { 'x-test': 'member', 'content-type': 'application/json' },
    body: JSON.stringify({ message: '冒充', agent: 'claude', pluginOrigin: { plugin: PID, app: 'main', label: '对话应用' } }),
  });
  const reader = r.body.getReader();
  await reader.read();
  reader.cancel().catch(() => {});
  assert.equal(calls.at(-1).internal, false);
  assert.equal(calls.at(-1).origin, null);
  const g = turns.at(-1);
  await tick();
  assert.ok(g.sessionId);
  assert.equal(G.pluginSessions.get(g.sessionId), undefined, '没打标');
  assert.equal((await call('POST', chat(PID, 'send'), { as: 'member', body: { sessionId: g.sessionId, text: 'x' } })).status, 404, '页面续不了它');
  finishTurn(g);

  // 判定本身
  const ident = { kind: 'admin', user: null };
  const o = { pluginOrigin: { plugin: PID, app: 'main', label: '  对话\n应用 ' + 'x'.repeat(80) } };
  assert.equal(pluginOriginFor({ headers: {} }, o, {}), null, '外部请求');
  assert.equal(pluginOriginFor({ headers: {}, [INTERNAL_IDENTITY]: ident }, o, { sessionId: 'sess-1' }), null, '续聊');
  assert.equal(pluginOriginFor({ headers: {}, [INTERNAL_IDENTITY]: ident }, o, { isSnap: true }), null, '快照对话');
  const ok = pluginOriginFor({ headers: {}, [INTERNAL_IDENTITY]: ident }, o, {});
  assert.equal(ok.plugin, PID);
  assert.equal(ok.app, 'main');
  assert.equal(ok.label.length, 60);
  assert.ok(!/\n/.test(ok.label));
  assert.equal(pluginOriginFor({ [INTERNAL_IDENTITY]: ident }, { pluginOrigin: { plugin: 'Bad/Id' } }, {}), null);
  assert.equal(pluginOriginFor({ [INTERNAL_IDENTITY]: ident }, { pluginOrigin: { plugin: PID, app: '../x' } }, {}).app, null);
  assert.equal(pluginOriginFor({ [INTERNAL_IDENTITY]: ident }, { pluginOrigin: [PID] }, {}), null);
});

test('mapChatEvent：gen 事件到页面事件的映射表', () => {
  assert.deepEqual(mapChatEvent({ type: 'text', text: 'a' }), { type: 'text', text: 'a' });
  assert.equal(mapChatEvent({ type: 'text', text: '' }), null);
  assert.deepEqual(mapChatEvent({ type: 'plan_request', qid: 'p1', plan: '\n## 改登录页\n1. 先…' }), { type: 'approval', kind: 'plan', qid: 'p1', title: '改登录页', description: '\n## 改登录页\n1. 先…' });
  assert.deepEqual(mapChatEvent({ type: 'question', qid: 'k1', questions: [{ question: '选哪个？', options: [] }] }), { type: 'approval', kind: 'question', qid: 'k1', title: '选哪个？' });
  assert.equal(mapChatEvent({ type: 'question', pending: true }), null, '状态通知');
  assert.equal(mapChatEvent({ type: 'perm_request', tool: 'Bash' }), null, '没有 qid');
  assert.deepEqual(mapChatEvent({ type: 'plan_answer', qid: 'p1' }), { type: 'approval.done', qid: 'p1' });
  assert.deepEqual(mapChatEvent({ type: 'answer', qid: 'k1' }), { type: 'approval.done', qid: 'k1' });
  assert.deepEqual(mapChatEvent({ type: 'done', result: 'r', isError: true }), { type: 'done', ok: false, result: 'r' });
  assert.deepEqual(mapChatEvent({ type: 'interrupted' }), { type: 'done', ok: false, interrupted: true });
  assert.deepEqual(mapChatEvent({ type: 'error', kind: 'quota', title: '额度', message: '用完了' }), { type: 'error', kind: 'quota', message: '额度：用完了' });
  for (const t of ['session', 'thinking', 'usage', 'bg_hold', 'model_notice', 'tool_progress']) assert.equal(mapChatEvent({ type: t, text: 'x' }), null, t);
  assert.equal(mapChatEvent(null), null);
});

// 直调 chatEvents（短心跳 / 短空闲）：新会话的 gen 起初没有会话 id，心跳时补扫挂上；30 分钟（这里 80ms）没有新轮就关
class FakeRes extends EventEmitter {
  constructor() { super(); this.raw = ''; this.writableEnded = false; this.headersSent = false; }
  writeHead() { this.headersSent = true; return this; }
  write(s) { this.raw += String(s); return true; }
  end() { if (!this.writableEnded) { this.writableEnded = true; this.emit('close'); } }
  get events() { return this.raw.split('\n\n').filter((b) => b.startsWith('data:')).map((b) => JSON.parse(b.slice(5))); }
}
test('chatEvents：心跳时补扫没有会话 id 的新轮；没有新轮到点自己关；断开收订阅', async () => {
  const c = contextFor(memberIdentity);
  const sid = 'sess-' + randomUUID();
  G.markPluginSession(sid, { plugin: PID, label: '对话应用', app: 'main', owner: MKEY() });
  const res = new FakeRes();
  const stop = chatEvents(c, PID, sid, res, { heartbeatMs: 15, idleMs: 80 });
  assert.equal(typeof stop, 'function');
  const g = { sessionId: null, userText: '新会话', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  G.tryStartGen(MKEY(), g);
  await tick(5);
  assert.equal(g.subscribers.size, 0, '还没有会话 id，挂不上');
  g.sessionId = sid;
  G.genEmit(g, { type: 'text', text: '早到的' });
  await tick(40);
  assert.equal(g.subscribers.size, 1, '心跳补扫挂上了');
  assert.deepEqual(res.events.slice(0, 2), [{ type: 'turn', turn: turnIdOf(g), userText: '新会话' }, { type: 'text', text: '早到的' }], '挂上时补发缓冲');
  assert.ok(turnIdOf(g).endsWith('-' + sid), '起初没有会话 id 的轮，挂上时用订阅的会话 id 记号');
  assert.ok(res.raw.includes(': ping'));
  G.genEmit(g, { type: 'text', text: '后到的' });
  finishTurn(g);
  assert.deepEqual(res.events.slice(2), [{ type: 'text', text: '后到的' }, { type: 'done', ok: true, result: '好了' }]);
  assert.equal(res.writableEnded, false, '一轮完了不关，等下一轮');
  await tick(150);
  assert.equal(res.writableEnded, true, '空闲到点关');

  // 页面断开：tap 从正在跑的轮里摘掉
  const res2 = new FakeRes();
  const g2 = { sessionId: sid, userText: '再来', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  G.tryStartGen(MKEY(), g2);
  chatEvents(c, PID, sid, res2, { heartbeatMs: 15, idleMs: 10_000 });
  assert.equal(g2.subscribers.size, 1);
  res2.end();
  assert.equal(g2.subscribers.size, 0);
  finishTurn(g2);
});

// 连上之后条件变了：撤销授权、插件停用、账号停用都要把已经连着的事件流断掉（否则撤了授权的页面还能一直读到用户之后的对话）
const waitEnded = (es, ms = 2000) => new Promise((ok, no) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (es.ended) { clearInterval(iv); ok(); } else if (Date.now() - t0 > ms) { clearInterval(iv); no(new Error('事件流没断，已收：' + JSON.stringify(es.events))); }
  }, 10);
});
async function openedTurn(plugin, prompt) {
  assert.equal((await grant('member', plugin)).status, 200);
  const s = await call('POST', chat(plugin, 'start'), { as: 'member', body: { prompt } });
  assert.equal(s.status, 200, s.text);
  const g = turns.at(-1);
  const es = await openEvents(chat(plugin, 'events?session=' + s.json.sessionId), 'member');
  assert.equal(es.status, 200);
  await es.waitFor((e) => e.type === 'text' && e.text === '收到：' + prompt);
  assert.equal(g.subscribers.size, 1);
  return { sid: s.json.sessionId, g, es };
}

test('events：撤销 page.chat 当场断流，挂着的轮也摘掉；之后这个会话新开的轮不再推给页面；重连 403 needGrant', async () => {
  const P = 'pg-chat-revoke';
  await addPlugin(P, [{ id: 'main', title: '撤销测试', page: 'web/app.html', who: 'members' }], perms('page.chat'));
  const { sid, g, es } = await openedTurn(P, '撤销之前');
  try {
    assert.equal((await grant('member', P, false)).status, 200);
    await waitEnded(es);
    assert.equal(g.subscribers.size, 0, '正在跑的那一轮上的订阅也收了');
    G.genEmit(g, { type: 'text', text: '撤销以后的正文' });
    finishTurn(g);
    // 用户事后在 Claude 分页里接着这个会话说
    const g2 = { sessionId: sid, userText: '撤销以后在 Claude 分页说的', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
    G.tryStartGen(MKEY(), g2);
    G.genEmit(g2, { type: 'text', text: '不该给页面' });
    await tick(30);
    assert.equal(g2.subscribers.size, 0, '新的一轮没挂上');
    assert.ok(!es.events.some((e) => e.type === 'turn' && e.userText === g2.userText), JSON.stringify(es.events));
    assert.ok(!es.events.some((e) => e.text === '撤销以后的正文' || e.text === '不该给页面'));
    finishTurn(g2);
    const again = await call('GET', chat(P, 'events?session=' + sid), { as: 'member' });
    assert.equal(again.status, 403);
    assert.equal(again.json.needGrant, 'page.chat');
  } finally { es.close(); }
  // 别人撤、撤别的权限、撤别的插件都不断这条流
  const other = await openedTurn(PID, '不相干的撤销');
  try {
    await grant('admin', PID, false);
    await call('POST', '/api/plugins/grants', { as: 'member', body: { plugin: PID, perm: 'page.files', allow: false } });
    await grant('member', OTHER, false);
    await tick(30);
    assert.equal(other.es.ended, false);
    assert.equal(other.g.subscribers.size, 1);
  } finally { other.es.close(); finishTurn(other.g); }
});

test('events：插件停用当场断流；重连 404', async () => {
  const P = 'pg-chat-off';
  await addPlugin(P, [{ id: 'main', title: '停用测试', page: 'web/app.html', who: 'members' }], perms('page.chat'));
  const { sid, g, es } = await openedTurn(P, '停用之前');
  try {
    await kernel.setEnabled(P, false);
    assert.equal(kernel.isActive(P), false);
    await waitEnded(es);
    assert.equal(g.subscribers.size, 0);
    finishTurn(g);
    assert.equal((await call('GET', chat(P, 'events?session=' + sid), { as: 'member' })).status, 404);
  } finally { es.close(); }
});

test('chatEvents：账号停用、成员失去这个插件的页面，下一次心跳断开；正常时照常心跳', async () => {
  const r = await users.createUser('chatmember-off', 'pw-chatmember-off-1', 'user');
  assert.ok(r.ok, r.error);
  const c = contextFor(userIdentity(r.id));
  const { setGrant } = await import('./page-grants.mjs');
  setGrant(c, PID, 'page.chat', true);
  const sid = 'sess-' + randomUUID();
  G.markPluginSession(sid, { plugin: PID, label: '对话应用', app: 'main', owner: c.key });
  const res = new FakeRes();
  chatEvents(c, PID, sid, res, { heartbeatMs: 15, idleMs: 10_000 });
  await tick(50);
  assert.equal(res.writableEnded, false, '账号正常：照常心跳');
  assert.ok(res.raw.includes(': ping'));
  users.setDisabled(r.id, true);
  await tick(60);
  assert.equal(res.writableEnded, true, '账号停用：下一次心跳断开');
  users.setDisabled(r.id, false);

  // 成员失去页面：直调时用一个主机专用插件的身份上下文模拟（canUsePluginPages 为假）
  setGrant(contextFor({ kind: 'admin' }), HOSTONLY, 'page.chat', true);
  const sid2 = 'sess-' + randomUUID();
  G.markPluginSession(sid2, { plugin: HOSTONLY, label: '主机的', app: 'main', owner: c.key });
  const all = JSON.parse(readFileSync(path.join(tmp, 'plugin-data', HOSTONLY, 'grants.json'), 'utf8'));
  all[c.key] = { 'page.chat': new Date().toISOString() };
  writeFileSync(path.join(tmp, 'plugin-data', HOSTONLY, 'grants.json'), JSON.stringify(all));
  const res2 = new FakeRes();
  chatEvents(c, HOSTONLY, sid2, res2, { heartbeatMs: 15, idleMs: 10_000 });
  await tick(50);
  assert.equal(res2.writableEnded, true, '这个身份用不了这个插件的页面：心跳时断开');
});

test('markPluginSession：超过 60 字的标签重复标也是空操作（不刷新 at、不重写文件）', async () => {
  const sid = 'sess-' + randomUUID();
  const label = '很长的应用标题'.repeat(12);
  G.markPluginSession(sid, { plugin: PID, label, app: 'main', owner: MKEY() });
  const first = G.pluginSessions.get(sid);
  assert.equal(first.label.length, 60);
  await tick(5);
  G.markPluginSession(sid, { plugin: PID, label, app: 'main', owner: MKEY() });
  assert.equal(G.pluginSessions.get(sid), first, '同一个对象，没重写');
  assert.equal(G.pluginSessions.get(sid).at, first.at);
});
