import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-swarm-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const projectDir = path.join(tmp, 'my-project');
const stateFile = path.join(tmp, 'fake-acp-state.json');
const fakeAgyData = path.join(tmp, 'agy-data');

mkdirSync(dataRoot, { recursive: true });
mkdirSync(usersRoot, { recursive: true });
mkdirSync(vaultDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(fakeAgyData, { recursive: true });

process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.FAKE_ACP_STATE_FILE = stateFile;
process.env.FAKE_AGY_DATA_DIR = fakeAgyData;

const MASTER = 'agy-swarm-test-token-0123456789';
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18996,
  token: MASTER,
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
const users = await import('@bridge/core/users.mjs');
const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('./acp/index.mjs');
const { setMonitorTimingForTest, stopAllSubagentMonitors } = await import('./subagent-monitor.mjs');
const { hasProtectedSubagents } = await import('./subagents.mjs');
const {
  mentionsOf,
  channelMentions,
  channelRegistry,
  channelsAt,
  seesIn,
  visibleUnread,
} = await import('./swarm-channels.mjs');

setMonitorTimingForTest({ activePollMs: 120, quietPollMs: 200, wakeGraceDbMs: 250, wakeGraceNoDbMs: 200 });

const testClient = new AcpClient({
  daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'),
  logFile: null,
  dataDir: fakeAgyData,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile, FAKE_AGY_DATA_DIR: fakeAgyData },
});
setAcpClientForTest(testClient);

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
const HEADERS = {
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
  try {
    for (const top of readdirSync(tmp)) {
      const fullTop = path.join(tmp, top);
      if (top === 'users') {
        for (const entry of readdirSync(fullTop)) {
          const full = path.join(fullTop, entry);
          if (entry === '_system') {
            for (const sub of readdirSync(full)) rmSync(path.join(full, sub), { recursive: true, force: true });
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
  stopAllSubagentMonitors();
  for (const ctl of [...activeControllers]) { try { ctl.abort(); } catch {} }
  activeControllers.clear();
  shutdownAgy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  cleanupTempTree();
});

function parseSseFrames(rawText) {
  const frames = [];
  for (const chunk of String(rawText).split('\n\n')) {
    const dataLines = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    if (!dataLines.length) continue;
    try { frames.push(JSON.parse(dataLines.join('\n'))); } catch {}
  }
  return frames;
}

const jget = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: HEADERS });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const startChat = (body) => fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: HEADERS, body: JSON.stringify({ agent: 'agy', ...body }),
}).then((r) => r.text());

test('swarm-channels：@mention / 分片组展开 / @#channel / 订阅与归档可见性及未读计数', () => {
  const roster = ['coordinator', 'worker-1', 'worker-2', 'reviewer'];
  const m1 = mentionsOf('@worker @reviewer 忽略邮箱 a@worker-1.com', roster);
  assert.equal(m1.all, false);
  assert.deepEqual(m1.mentions.sort(), ['reviewer', 'worker-1', 'worker-2']);

  const m2 = mentionsOf('@all 全员同步', roster);
  assert.equal(m2.all, true);

  const cMentions = channelMentions('@#ui @#api 以及 @#all @#main');
  assert.deepEqual(cMentions, ['ui', 'api', 'main']);

  const board = [
    { seq: 1, agent: 'coordinator', channel: 'ui', control: { op: 'create', channel: 'ui', topic: 'UI 频道' }, text: '[channel] created #ui' },
    { seq: 2, agent: 'coordinator', channel: 'api', control: { op: 'create', channel: 'api', topic: 'API 频道' }, text: '[channel] created #api' },
    { seq: 3, agent: 'coordinator', channel: 'ui', text: '@worker-1 做布局' },
    { seq: 4, agent: 'coordinator', channel: 'api', text: '@worker-2 做接口' },
    { seq: 5, agent: 'worker-2', channel: 'main', text: '@#ui 通知 UI 组接口好了' },
  ];

  const reg = channelRegistry(board);
  assert.equal(reg.length, 2);
  assert.equal(reg.find((c) => c.name === 'ui')?.topic, 'UI 频道');
  const sets = channelsAt('worker-1', ['ui'], board);
  assert.deepEqual(sets[4], ['ui']);
  const isActive = (c) => reg.some((r) => r.name === c && !r.archived);
  assert.equal(seesIn('worker-1', ['ui'], board[2], isActive), true);
  assert.equal(seesIn('worker-1', ['ui'], board[3], isActive), false);
  assert.equal(seesIn('worker-1', ['ui'], board[4], isActive), true);
  assert.equal(visibleUnread('worker-1', 'worker', ['ui'], board, 2, reg), 2);
});

test('Native Swarm 端到端适配：/api/agy/swarm 快照与 ETag、/api/agy/subagents 联动、成员转录钻取、截图白名单防越权与防 session/close', async () => {
  const raw = await startChat({ cwd: projectDir, message: '启动 Swarm 协作演示 [SWARM_DEMO]' });
  const frames = parseSseFrames(raw);
  const doneFrame = frames.find((f) => f.type === 'done');
  assert.ok(doneFrame?.sessionId, '派发轮应正常返回 sessionId');
  const sid = doneFrame.sessionId;

  // 1) GET /api/agy/swarm 返回完整快照
  const swRes = await jget(`/api/agy/swarm?session=${encodeURIComponent(sid)}`);
  assert.equal(swRes.status, 200);
  const sw = swRes.body;
  assert.equal(sw.hasSwarm, true);
  assert.equal(sw.title, 'Swarm 面板适配与验收');
  assert.equal(sw.hasActive, true);
  assert.equal(sw.finished, false);
  assert.equal(sw.members.length, 5);
  assert.equal(sw.channels.length, 2);
  assert.deepEqual(sw.channels.map((c) => c.name).sort(), ['api', 'ui']);
  assert.equal(sw.messages.length, 7);
  assert.equal(sw.plan?.goal?.title, '完成 Bridge Swarm 完整视图适配');
  assert.equal(sw.plan?.threads?.length, 2);
  assert.equal(sw.frames.length, 2, '应解析出两张进度截图帧');

  const frontend = sw.members.find((m) => m.name === 'frontend');
  const backend = sw.members.find((m) => m.name === 'backend');
  const verifier = sw.members.find((m) => m.name === 'verifier');
  const monitor = sw.members.find((m) => m.name === 'monitor');
  assert.equal(frontend?.status, 'working');
  assert.equal(backend?.status, 'waiting');
  assert.equal(monitor?.roleWorker, true);
  assert.ok(frontend?.conversationId);

  // #7 使用了 @#ui，应自动展开 viaChannel 到 ui 订阅者（frontend / verifier）
  const msg7 = sw.messages.find((m) => m.seq === 7);
  assert.deepEqual(msg7?.channelMentions, ['ui']);
  assert.ok(msg7?.viaChannel?.includes('frontend'));
  assert.ok(sw.edges.some((e) => e.from === 'verifier' && e.to === 'frontend'));

  // 2) ETag 短路：携带相同 etag 时返回 unchanged: true
  const swCached = await jget(`/api/agy/swarm?session=${encodeURIComponent(sid)}&etag=${encodeURIComponent(sw.etag)}`);
  assert.equal(swCached.status, 200);
  assert.equal(swCached.body.unchanged, true);
  assert.equal(swCached.body.etag, sw.etag);

  // 3) GET /api/agy/subagents 携带 swarm 摘要且折叠进 hasActive
  const subRes = await jget(`/api/agy/subagents?session=${encodeURIComponent(sid)}`);
  assert.equal(subRes.status, 200);
  assert.equal(subRes.body.hasActive, true);
  assert.equal(subRes.body.swarm?.hasSwarm, true);
  assert.equal(subRes.body.swarm?.workingCount, 1);
  assert.equal(subRes.body.swarm?.totalWorkers, 3);

  // 4) 点击 Swarm 成员钻取：/api/agy/subagent-transcript 直接读出 worker 转录；外来 UUID 仍返回 404
  const trFront = await jget(`/api/agy/subagent-transcript?session=${encodeURIComponent(sid)}&agentId=${encodeURIComponent(frontend.conversationId)}`);
  assert.equal(trFront.status, 200);
  assert.equal(trFront.body.agent?.role, 'frontend');
  assert.equal(trFront.body.agent?.kind, 'swarm');
  assert.equal(trFront.body.agent?.model, 'gemini-4-hydrogen-tiered-high');
  assert.ok(trFront.body.entries.some((e) => e.kind === 'thinking'));
  assert.ok(trFront.body.entries.some((e) => e.kind === 'tools' && e.tools.some((t) => t.name === 'edit_file')));

  const trForeign = await jget(`/api/agy/subagent-transcript?session=${encodeURIComponent(sid)}&agentId=11111111-2222-3333-4444-555555555555`);
  assert.equal(trForeign.status, 404);

  // 5) /api/agy/artifact 截图白名单鉴权（支持 <img> 的 ?token=，同时拦截 .system_generated 与未在消息板登记的图片）
  const framePath = sw.frames[0].path;
  assert.ok(framePath && framePath.endsWith('step1-before.png'));
  const imgResp = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sid)}&path=${encodeURIComponent(framePath)}&token=${encodeURIComponent(MASTER)}`);
  assert.equal(imgResp.status, 200);
  assert.match(imgResp.headers.get('content-type') || '', /^image\/png/i);
  const imgBuf = Buffer.from(await imgResp.arrayBuffer());
  assert.deepEqual([...imgBuf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], '应返回真实 PNG 字节流');

  // 未登记在消息板上的同目录图片 → 必须拒绝（403）
  const secretPng = path.join(fakeAgyData, 'brain', frontend.conversationId, 'unlisted-secret.png');
  writeFileSync(secretPng, imgBuf);
  const unlistedResp = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sid)}&path=${encodeURIComponent(secretPng)}&token=${encodeURIComponent(MASTER)}`);
  assert.equal(unlistedResp.status, 403, '未在消息板登记的 worker 图片禁止经 /api/agy/artifact 越权读取');

  // .system_generated/swarm/members.json → 必须拒绝（403）
  const sysFile = path.join(fakeAgyData, 'brain', sid, '.system_generated', 'swarm', 'members.json');
  const sysResp = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sid)}&path=${encodeURIComponent(sysFile)}&token=${encodeURIComponent(MASTER)}`);
  assert.equal(sysResp.status, 403, '.system_generated 内部状态文件禁止经 /api/agy/artifact 读取');

  // 6) 活跃 Swarm 受到会话保护：hasProtectedSubagents 为 true 且重开会话不触发 session/close
  assert.equal(hasProtectedSubagents(fakeAgyData, sid), true);
  const reopen = await jget(`/api/agy/session/${encodeURIComponent(sid)}`);
  assert.equal(reopen.status, 200);
  const rpcLog = JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog;
  const closeCalls = rpcLog.filter((r) => r.method === 'session/close' && r.params?.sessionId === sid);
  assert.equal(closeCalls.length, 0, '活跃 Swarm 会话重开时禁止发 session/close');
});
