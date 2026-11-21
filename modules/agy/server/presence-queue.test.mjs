import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-presence-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const projectDir = path.join(tmp, 'my-project');
const stateFile = path.join(tmp, 'fake-acp-state.json');

mkdirSync(dataRoot, { recursive: true });
mkdirSync(usersRoot, { recursive: true });
mkdirSync(vaultDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.FAKE_ACP_STATE_FILE = stateFile;

writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18993,
  token: 'agy-test-master-token-0123456789',
  vaultPath: vaultDir,
  usersRoot,
  features: { multiUser: true },
}, null, 2));

const { loadModules, registerModuleRoutes } = await import('@bridge/core/modules/registry.mjs');
await loadModules();

const { createRouter } = await import('@bridge/core/runtime/router.mjs');
const { registerAuthRoutes } = await import('@bridge/core/routes/auth.mjs');
const { registerChatRoutes } = await import('@bridge/core/routes/chat.mjs');
const { registerOverviewRoutes } = await import('@bridge/core/routes/overview.mjs');
const { createAuth } = await import('@bridge/core/auth.mjs');
const { makeIdentify } = await import('@bridge/core/runtime/identity.mjs');
const { agentAuthed } = await import('@bridge/core/runtime/agent-status.mjs');
const users = await import('@bridge/core/users.mjs');
const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('./acp/index.mjs');

const testClient = new AcpClient({
  daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'),
  logFile: null,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile },
});
setAcpClientForTest(testClient);

const MASTER = 'agy-test-master-token-0123456789';
const auth = createAuth(MASTER, false, {
  isAdminSession: (t, g) => users.isAdminSession(t, g),
  isUserSession: (t) => !!users.getSession(t),
});
const identify = makeIdentify({
  authOk: auth.authOk,
  getCookie: auth.getCookie,
  bearerToken: auth.bearerToken,
  queryToken: auth.queryToken,
});

const router = createRouter();
registerAuthRoutes(router, { ...auth, adminGen: auth.gen, identify });
registerChatRoutes(router, { authOk: auth.authOk, identify });
registerOverviewRoutes(router, { authOk: auth.authOk, identify });
registerModuleRoutes(router, { authOk: auth.authOk, identify });

const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const BASE = `http://127.0.0.1:${server.address().port}`;
const ADMIN_HEADERS = {
  authorization: `Bearer ${MASTER}`,
  'content-type': 'application/json',
  connection: 'close',
};

const activeControllers = new Set();
const rawFetch = globalThis.fetch;
function fetch(url, init = {}) {
  const ctl = new AbortController();
  activeControllers.add(ctl);
  return rawFetch(url, { ...init, signal: ctl.signal });
}

function cleanupTempTree() {
  // users.mjs 对 usersRoot/_system 挂了 fs.watch：Windows Node 24 下在起过 http.Server 后直接删除被监视目录本身，
  // 会触发 libuv uv_fs_event 句柄不释放导致进程无法退出，因此只清空 _system 目录内容而保留空壳目录。
  try {
    for (const top of readdirSync(tmp)) {
      const fullTop = path.join(tmp, top);
      if (top === 'users') {
        for (const entry of readdirSync(fullTop)) {
          const full = path.join(fullTop, entry);
          if (entry === '_system') {
            for (const sub of readdirSync(full)) {
              rmSync(path.join(full, sub), { recursive: true, force: true });
            }
          } else {
            rmSync(full, { recursive: true, force: true });
          }
        }
      } else {
        rmSync(fullTop, { recursive: true, force: true });
      }
    }
  } catch {}
}

after(async () => {
  for (const ctl of [...activeControllers]) {
    try { ctl.abort(); } catch {}
  }
  activeControllers.clear();
  shutdownAgy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  cleanupTempTree();
});

function parseSseFrames(rawText) {
  const frames = [];
  for (const chunk of String(rawText).split('\n\n')) {
    const dataLines = chunk
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    if (!dataLines.length) continue;
    try { frames.push(JSON.parse(dataLines.join('\n'))); } catch {}
  }
  return frames;
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// —— 以下是本文件自己的部分：排队消息、会话消息通知、跨设备状态（总线 + /api/active 的 ext）——

const jget = async (p) => (await fetch(`${BASE}${p}`, { headers: ADMIN_HEADERS })).json();
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// 边读边收的 SSE（总线是常驻流，等不到它结束）
function openStream(p, method = 'POST') {
  const frames = [];
  const ctl = new AbortController();
  activeControllers.add(ctl);
  const done = (async () => {
    try {
      const r = await rawFetch(`${BASE}${p}`, { method, headers: ADMIN_HEADERS, signal: ctl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          frames.push(...parseSseFrames(buf.slice(0, i) + '\n\n'));
          buf = buf.slice(i + 2);
        }
      }
    } catch {}
  })();
  return { frames, close: () => { try { ctl.abort(); } catch {} }, done };
}

const startChat = (body) => fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ agent: 'agy', ...body }),
}).then((r) => r.text());

const liveSession = () => waitFor(async () => {
  const st = await jget('/api/agy/active');
  return st.active && st.sessionId ? st : null;
});

test('排队消息：在跑时入队、撤回、立即发送接着跑；人按停止则整队退回', async () => {
  const proj = (await jpost('/api/agy/project/create', { path: projectDir })).body;
  assert.equal(proj.ok, true);
  const bus = openStream('/api/stream');
  await waitFor(() => bus.frames.some((f) => f.type === 'hello'));
  const hello = bus.frames.find((f) => f.type === 'hello');
  assert.ok(hello.noticeAgents.includes('agy'), 'hello 要声明 agy 的通知由服务端发');

  // 第一轮：慢速，一直占着
  const first = startChat({ agyProjectId: proj.project.id, message: '第一条 [SLOW]' });
  const st = await liveSession();
  const sid = st.sessionId;

  // 在跑时再发：不带 queue 仍是 409；带 queue 入队
  const busy = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ agent: 'agy', sessionId: sid, message: '硬发' }),
  });
  assert.equal(busy.status, 409);

  const q1 = await jpost('/api/chat', { agent: 'agy', sessionId: sid, message: '第二条', queue: true, agyAtts: [{ path: path.join(projectDir, 'a.png'), name: 'a.png', isImage: true }] });
  assert.equal(q1.status, 200);
  assert.equal(q1.body.queued, true);
  assert.equal(q1.body.queue.length, 1);
  assert.equal(q1.body.item.atts[0].name, 'a.png');
  const q2 = await jpost('/api/chat', { agent: 'agy', sessionId: sid, message: '第三条', queue: true });
  assert.equal(q2.body.queue.length, 2);

  // 别的设备问状态：排队在、没在等人
  const act = await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`);
  assert.deepEqual(act.queue.map((x) => x.text), ['第二条', '第三条']);
  assert.equal(act.activeSessions[0].pending, '');
  assert.equal(act.notices, true);
  // 核心 /api/active：Claude 那几项不受影响，agy 在 ext 里
  const core = await jget('/api/active');
  assert.equal(core.active, false);
  assert.equal(core.ext.length, 1);
  assert.equal(core.ext[0].agent, 'agy');
  assert.equal(core.ext[0].runs[0].sessionId, sid);

  // 撤回第三条
  const rm = await jpost('/api/agy/queue/remove', { sessionId: sid, id: q2.body.item.id });
  assert.equal(rm.body.ok, true);
  assert.equal(rm.body.item.text, '第三条');
  assert.equal(rm.body.queue.length, 1);
  assert.equal((await jpost('/api/agy/queue/remove', { sessionId: sid, id: 'nope' })).status, 404);

  // 立即发送第二条：停下手头这一步，终止事件里带 next
  const now = await jpost('/api/agy/queue/send-now', { sessionId: sid, id: q1.body.item.id });
  assert.equal(now.body.ok, true);
  const firstFrames = parseSseFrames(await first);
  const endA = firstFrames.find((f) => f.type === 'interrupted');
  assert.ok(endA, '第一轮应以 interrupted 收尾');
  assert.equal(endA.next.text, '第二条');
  assert.equal(endA.queueReturned, undefined);
  assert.ok(firstFrames.some((f) => f.type === 'queue' && f.items.length === 2), '入队要广播给在看的客户端');

  // 第二轮已经自己开跑：挂上去看完
  const second = parseSseFrames(await (await fetch(`${BASE}/api/agy/attach?session=${encodeURIComponent(sid)}`, { method: 'POST', headers: ADMIN_HEADERS })).text());
  assert.equal(second[0].type, 'attach');
  assert.equal(second[0].userText, '第二条');
  assert.equal(second[0].userAtts[0].name, 'a.png');
  assert.notEqual(second[0].turn, 0);
  const endB = second.find((f) => f.type === 'done');
  assert.ok(endB, '排队的那条要跑完');
  assert.equal(endB.next, undefined);

  // 通知：只有最后一轮的「完成」，带 agent 与会话
  await waitFor(async () => (await jget('/api/active')).notices.some((n) => n.kind === 'done' && n.agent === 'agy'));
  const notices = (await jget('/api/active')).notices.filter((n) => n.agent === 'agy');
  assert.equal(notices.length, 1, '被打断的那一轮不发完成通知');
  assert.equal(notices[0].sessionId, sid);
  assert.ok(notices[0].title);
  assert.equal((await jget('/api/active')).ext.length, 0);

  // 总线：开跑 → 收尾
  await waitFor(() => bus.frames.some((f) => f.type === 'agy.run' && f.sessionId === sid && f.live === false));
  assert.ok(bus.frames.some((f) => f.type === 'agy.run' && f.sessionId === sid && f.live === true));
  assert.ok(bus.frames.some((f) => f.type === 'notice' && f.agent === 'agy' && f.kind === 'done'));

  // 人按停止：排着的整队退回，不自动发
  const third = startChat({ sessionId: sid, message: '第四条 [SLOW]' });
  await waitFor(async () => { const s = await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`); return s.active ? s : null; });
  await jpost('/api/chat', { agent: 'agy', sessionId: sid, message: '退回我', queue: true });
  await jpost('/api/agy/stop', { sessionId: sid });
  const endC = parseSseFrames(await third).find((f) => f.type === 'interrupted');
  assert.ok(endC);
  assert.equal(endC.next, undefined);
  assert.deepEqual(endC.queueReturned.map((x) => x.text), ['退回我']);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`)).active, false, '停止后不该有新一轮开跑');
  assert.equal((await jget('/api/active')).notices.filter((n) => n.agent === 'agy').length, 1, '人按的停止不通知');

  // queue 请求撞上「已经跑完」：直接开跑、回 JSON
  const direct = await jpost('/api/chat', { agent: 'agy', sessionId: sid, message: '直接开跑', queue: true });
  assert.equal(direct.body.started, true);
  const fourth = parseSseFrames(await (await fetch(`${BASE}/api/agy/attach?session=${encodeURIComponent(sid)}`, { method: 'POST', headers: ADMIN_HEADERS })).text());
  assert.equal(fourth[0].userText, '直接开跑');
  assert.ok(fourth.some((f) => f.type === 'done'));
  bus.close();
});

test('在等你：审批卡进通知与 ext.asks，别的设备看得到 pending；答完即清', async () => {
  const bus = openStream('/api/stream');
  await waitFor(() => bus.frames.some((f) => f.type === 'hello'));
  const before = (await jget('/api/active')).notices.length;

  const chat = startChat({ cwd: projectDir, message: '要审批 [PERM]' });
  const st = await waitFor(async () => {
    const s = await jget('/api/agy/active');
    return s.active && s.pendingPermission ? s : null;
  });
  const sid = st.sessionId;
  assert.equal(st.activeSessions.find((r) => r.sessionId === sid).pending, 'permission');

  const core = await jget('/api/active');
  const ext = core.ext.find((e) => e.agent === 'agy');
  assert.equal(ext.asks.length, 1);
  assert.equal(ext.asks[0].sessionId, sid);
  assert.equal(ext.asks[0].kind, 'permission');
  const ask = core.notices.slice(before).find((n) => n.kind === 'permission');
  assert.ok(ask, '审批要发「需要你批准」通知');
  assert.equal(ask.agent, 'agy');
  assert.equal(ask.sessionId, sid);
  assert.ok(bus.frames.some((f) => f.type === 'agy.run' && f.sessionId === sid && f.pending === 'permission'));

  const ans = await jpost('/api/agy/permission', { requestId: st.pendingPermission.requestId, optionId: 'allow' });
  assert.equal(ans.body.ok, true);
  await waitFor(() => bus.frames.some((f) => f.type === 'agy.run' && f.sessionId === sid && f.live && f.pending === '' && f !== bus.frames.find((x) => x.type === 'agy.run' && x.sessionId === sid)));
  assert.ok(parseSseFrames(await chat).some((f) => f.type === 'done'));
  await waitFor(async () => (await jget('/api/active')).ext.length === 0);

  // 改名 / 隐藏：列表变了要广播
  await jpost('/api/agy/session/rename', { id: sid, title: '改过的名字' });
  await jpost('/api/agy/session/delete', { id: sid });
  await waitFor(() => bus.frames.filter((f) => f.type === 'agy.sessions').some((f) => f.why === 'hide'));
  assert.ok(bus.frames.some((f) => f.type === 'agy.sessions' && f.why === 'rename' && f.sessionId === sid));
  bus.close();
});
