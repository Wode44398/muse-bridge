import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-steer-'));
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

writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18994,
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
  dataDir: fakeAgyData,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile, FAKE_AGY_DATA_DIR: fakeAgyData },
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

// —— 以下是本文件自己的部分：中途插话、后台子代理（agy 自带生图）的续接、会话产物目录 ——

const jget = async (p) => (await fetch(`${BASE}${p}`, { headers: ADMIN_HEADERS })).json();
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const startChat = (body) => fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ agent: 'agy', ...body }),
}).then((r) => r.text());
const liveSession = (sid = '') => waitFor(async () => {
  const st = await jget('/api/agy/active' + (sid ? `?session=${encodeURIComponent(sid)}` : ''));
  return st.active && st.sessionId ? st : null;
});
const idle = (sid) => waitFor(async () => !(await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`)).active);

test('中途插话：在跑时送进这一轮、不打断；事件流里有这条用户消息；重开历史时它排在两段回答中间', async () => {
  const first = startChat({ cwd: projectDir, message: '第一条 [SLOW]' });
  const sid = (await liveSession()).sessionId;

  const st = await jpost('/api/chat', {
    agent: 'agy', sessionId: sid, message: '补充一句 [GO]', steer: true,
    agyAtts: [{ path: path.join(projectDir, 'a.png'), name: 'a.png', isImage: true }],
  });
  assert.equal(st.status, 200);
  assert.equal(st.body.steered, true);
  assert.equal(st.body.steer.text, '补充一句 [GO]');

  const frames = parseSseFrames(await first);
  const steerAt = frames.findIndex((f) => f.type === 'steer');
  assert.ok(steerAt > 0, '事件流里要有 steer');
  assert.equal(frames[steerAt].text, '补充一句 [GO]');
  assert.equal(frames[steerAt].atts[0].name, 'a.png');
  const after = frames.slice(steerAt + 1);
  assert.ok(after.some((f) => f.type === 'text' && f.text.includes('steered=补充一句 [GO]')), '模型要读到插话');
  const ends = frames.filter((f) => f.type === 'done' || f.type === 'interrupted' || f.type === 'error');
  assert.equal(ends.length, 1, '前一条 prompt 的返回不能把这一轮收掉');
  assert.equal(ends[0].type, 'done', '插话不打断这一轮');
  assert.ok(ends[0].result.includes('Part 1') && ends[0].result.includes('steered='), '收尾带整轮正文');
  assert.equal(ends[0].usage.totalTokens, 240, '两条 prompt 的用量加起来');

  await idle(sid);
  const detail = await jget(`/api/agy/session/${sid}`);
  assert.deepEqual(detail.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(detail.messages[2].text, '补充一句 [GO]');
  assert.ok(detail.messages[3].text.includes('steered='));
  assert.ok(detail.messages[3].stats, '最后一轮的统计按最后那条用户消息（插话）对上');
});

test('插话撞上「已经跑完」直接开一轮；这一轮收不了消息时改成排队', async () => {
  const chat = startChat({ cwd: projectDir, message: '跑完的一轮' });
  const sid = parseSseFrames(await chat).find((f) => f.type === 'done').sessionId;
  await idle(sid);
  const direct = await jpost('/api/chat', { agent: 'agy', sessionId: sid, message: '晚到的插话', steer: true });
  assert.equal(direct.body.started, true);
  const second = parseSseFrames(await (await fetch(`${BASE}/api/agy/attach?session=${encodeURIComponent(sid)}`, { method: 'POST', headers: ADMIN_HEADERS })).text());
  assert.equal(second[0].userText, '晚到的插话');
  assert.ok(second.some((f) => f.type === 'done'));
  await idle(sid);

  // 正在被停下的轮收不了插话：落进排队，随停止退回
  const slow = startChat({ sessionId: sid, message: '再来 [SLOW]' });
  await liveSession(sid);
  await waitFor(() => testClient.turns.get(sid));
  testClient.turns.get(sid).aborted = true;
  const q = await jpost('/api/chat', { agent: 'agy', sessionId: sid, message: '收不了就排队', steer: true });
  assert.equal(q.body.queued, true);
  testClient.turns.get(sid).aborted = false;
  await jpost('/api/agy/stop', { sessionId: sid });
  const end = parseSseFrames(await slow).find((f) => f.type === 'interrupted');
  assert.deepEqual(end.queueReturned.map((x) => x.text), ['收不了就排队']);
});

test('后台子代理（自带生图）：一轮不提前收尾，回报到了自动续接；成品在会话产物目录里也能交付', async () => {
  const chat = startChat({ cwd: projectDir, message: '画一张图 [BG:700]' });
  const sid = (await liveSession()).sessionId;
  // 等的时候别的设备问状态：还在跑、看得到在等谁
  const waiting = await waitFor(async () => {
    const s = await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`);
    return s.background?.length ? s : null;
  });
  assert.equal(waiting.active, true);
  assert.equal(waiting.background[0].kind, 'image');

  const frames = parseSseFrames(await chat);
  const kinds = frames.filter((f) => f.type === 'background').map((f) => f.state);
  assert.deepEqual(kinds, ['waiting', 'reported', 'resumed']);
  const reported = frames.find((f) => f.type === 'background' && f.state === 'reported');
  assert.equal(reported.from.typeName, 'image-generator');
  assert.equal(reported.files.length, 1);
  assert.equal(reported.files[0].kind, 'image');
  const ends = frames.filter((f) => f.type === 'done' || f.type === 'interrupted' || f.type === 'error');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].type, 'done');
  assert.ok(ends[0].result.includes('请稍候') && ends[0].result.includes('图片好了'));
  assert.equal(ends[0].attachments.length, 1, '产物目录里的成品要进交付物');
  const img = ends[0].attachments[0].path;
  assert.ok(img.startsWith(realpathSync(fakeAgyData)));

  // 重开历史：续接那句不当成用户说的话，前后两段是同一条回答，成品附件还在
  await idle(sid);
  const detail = await jget(`/api/agy/session/${sid}`);
  assert.deepEqual(detail.messages.map((m) => m.role), ['user', 'assistant']);
  assert.ok(detail.messages[1].text.includes('请稍候') && detail.messages[1].text.includes('图片好了'));
  assert.equal(detail.messages[1].attachments.length, 1);

  // 产物路由：成品给，agy 的内部记录不给，不带会话 id 的不给
  const ok = await fetch(`${BASE}/api/agy/artifact?id=${sid}&path=${encodeURIComponent(img)}`, { headers: ADMIN_HEADERS });
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
  const inner = path.join(fakeAgyData, 'brain', sid, '.system_generated', 'messages', 'read.json');
  const no = await fetch(`${BASE}/api/agy/artifact?id=${sid}&path=${encodeURIComponent(inner)}`, { headers: ADMIN_HEADERS });
  assert.equal(no.status, 403);
  const noId = await fetch(`${BASE}/api/agy/artifact?path=${encodeURIComponent(img)}`, { headers: ADMIN_HEADERS });
  assert.equal(noId.status, 403);
});

test('等后台回报时按停止：这一轮按被打断收尾；等的时候插话则由插话把回报带回来', async () => {
  const chat = startChat({ cwd: projectDir, message: '画一张慢的 [BG:60000]' });
  const sid = (await liveSession()).sessionId;
  await waitFor(async () => (await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`)).background?.length);
  await jpost('/api/agy/stop', { sessionId: sid });
  const frames = parseSseFrames(await chat);
  assert.ok(frames.some((f) => f.type === 'interrupted'));
  assert.ok(!frames.some((f) => f.type === 'done'));

  const chat2 = startChat({ cwd: projectDir, message: '再画一张 [BG:1500]' });
  const sid2 = (await liveSession()).sessionId;
  await waitFor(async () => (await jget(`/api/agy/active?session=${encodeURIComponent(sid2)}`)).background?.length);
  // 等的时候插话：不用再等回报，这一条直接接着这一轮往下走
  const st = await jpost('/api/chat', { agent: 'agy', sessionId: sid2, message: '先不等了，说说别的', steer: true });
  assert.equal(st.body.steered, true);
  const frames2 = parseSseFrames(await chat2);
  assert.ok(frames2.some((f) => f.type === 'steer'));
  assert.ok(frames2.some((f) => f.type === 'background' && f.state === 'idle'), '不等了要告诉界面收掉进度卡');
  // 答完插话后子代理还没回报：接着等，到了再续接，整轮只收尾一次
  assert.equal(frames2.filter((f) => f.type === 'done').length, 1);
  assert.ok(frames2.find((f) => f.type === 'done').result.includes('图片好了'));
});

test('系统提示：自带生图的用法无条件给（带内置工具时）；bridge 媒体工具开着时说明两条路各管什么', async () => {
  const s = await import('./settings.mjs');
  const plain = s.buildEffectiveAgySystemPrompt({}, { hasBridgeTools: false });
  assert.ok(plain.includes('image-generator') && plain.includes('直接结束这一轮'));
  assert.ok(!plain.includes('media_image'), '没挂 bridge 媒体工具时不提它');
  const both = s.buildEffectiveAgySystemPrompt({}, { hasBridgeTools: true, localCategories: ['media'] });
  assert.ok(both.includes('image-generator') && both.includes('media_image') && both.includes('自带的生图'));
  const bare = s.buildEffectiveAgySystemPrompt({}, { hasBridgeTools: false, builtInTools: false });
  assert.ok(!bare.includes('image-generator'), '不带内置工具的会话没有子代理可派');
});

test('转来的消息开头那句：服务端加的与界面认的逐字一致（界面靠它把这类消息收成一行说明）', async () => {
  const { RELAY_NOTE } = await import('./mcp/deliver.mjs');
  const web = await import('../../../web/src/lib/agy/relay.js');
  assert.equal(web.RELAY_NOTE, RELAY_NOTE);
  const r = web.relayedMessage(`${RELAY_NOTE}\n\n<side-sessions-event from="x">做完了，改了 3 个文件</side-sessions-event>`);
  assert.equal(r.kind, 'report');
  assert.ok(r.peek.includes('做完了') && !r.peek.includes('<'));
  assert.equal(web.relayedMessage('用户自己说的话'), null);
});
