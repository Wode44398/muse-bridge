// Antigravity 的插件回合事件：一次发送 = 一轮，turn.start / turn.end 各一次（modules/agy/server/turn-events.mjs）。
// 测试环境照 presence-queue.test.mjs：假 ACP agent + 隔离数据根。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-turn-events-'));
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
  port: 18997,
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

// —— 以下是本文件自己的部分：agy 一轮发给插件的 turn.start / turn.end（turn-events.mjs）——

const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jget = async (p) => (await fetch(`${BASE}${p}`, { headers: ADMIN_HEADERS })).json();
const startChat = (body) => fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ agent: 'agy', ...body }),
}).then((r) => r.text());
const liveSession = () => waitFor(async () => {
  const st = await jget('/api/agy/active');
  return st.active && st.sessionId ? st : null;
});

const { kernel } = await import('@bridge/core/plugins/state.mjs');
const { installMixins } = await import('@bridge/core/plugins/host.mjs');
installMixins();
await kernel.start();
after(async () => { await kernel.stop(); });

const events = [];
await kernel.register({
  id: 'agy-turns', name: 'agy-turns', source: 'local', dir: tmp, pluginApi: 3,
  load: async () => ({ apply: (c) => {
    c.events.on('turn.start', (e, name) => { if (e.agent === 'agy') events.push({ name, ...e }); });
    c.events.on('turn.end', (e, name) => { if (e.agent === 'agy') events.push({ name, ...e }); });
  } }),
});

test('agy 回合事件：新会话一轮各发一次 start / end；续聊带会话 id；人按停止 stopped', async () => {
  const frames = parseSseFrames(await startChat({ cwd: projectDir, message: '你好' }));
  const done = frames.find((f) => f.type === 'done');
  assert.ok(done, '第一轮正常完成');
  const sid = done.sessionId;
  await waitFor(() => events.length >= 2);
  const [s1, e1] = events;
  assert.equal(s1.name, 'turn.start');
  assert.equal(s1.event, 'turn.start');
  assert.equal(s1.kind, 'chat');
  assert.equal(s1.isNew, true);
  assert.equal(s1.sessionId, null, '新会话开跑时还没有 id');
  assert.equal(s1.message, '你好');
  assert.equal(s1.source, '');
  assert.deepEqual(s1.owner, { kind: 'admin', login: 'host' });
  assert.ok(s1.cwd, 'cwd 带上');
  assert.equal(e1.name, 'turn.end');
  assert.equal(e1.sessionId, sid);
  assert.equal(e1.ok, true);
  assert.equal(e1.stopped, false);
  assert.equal(e1.costUsd, 0);
  assert.ok(e1.durationMs >= 0);
  assert.ok(Array.isArray(e1.tools));
  assert.equal(e1.cwd, s1.cwd);

  // 续聊：慢速一轮，中途人按停止
  const slow = startChat({ sessionId: sid, message: '第二轮 [SLOW]' });
  await liveSession();
  await waitFor(() => events.length >= 3);
  assert.equal(events[2].name, 'turn.start');
  assert.equal(events[2].sessionId, sid);
  assert.equal(events[2].isNew, false);
  await jpost('/api/agy/stop', { sessionId: sid });
  await slow;
  await waitFor(() => events.length >= 4);
  assert.equal(events[3].name, 'turn.end');
  assert.equal(events[3].stopped, true);
  assert.equal(events[3].ok, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, 4, '每轮只各发一次');
});
