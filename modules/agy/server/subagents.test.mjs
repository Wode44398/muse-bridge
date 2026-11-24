import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-subagents-'));
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
  port: 18995,
  token: 'agy-sub-test-token-0123456789',
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

setMonitorTimingForTest({ activePollMs: 80, quietPollMs: 120, wakeGraceDbMs: 200, wakeGraceNoDbMs: 180 });

const testClient = new AcpClient({
  daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'),
  logFile: null,
  dataDir: fakeAgyData,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile, FAKE_AGY_DATA_DIR: fakeAgyData },
});
setAcpClientForTest(testClient);

const MASTER = 'agy-sub-test-token-0123456789';
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

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

const jget = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: HEADERS });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const startChat = (body) => fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: HEADERS, body: JSON.stringify({ agent: 'agy', ...body }),
}).then((r) => r.text());

test('多代理团队：递归树、增量转录、归属校验、刷新不触发 session/close 误杀、自动同步后台唤醒回复', async () => {
  const raw = await startChat({ cwd: projectDir, message: '启动项目审查 [TEAMWORK_AUTO]' });
  const frames = parseSseFrames(raw);
  const doneFrame = frames.find((f) => f.type === 'done');
  assert.ok(doneFrame?.sessionId, '派发轮应立即收尾，不卡住用户输入');
  const sid = doneFrame.sessionId;

  // 1) 查询递归多代理树（Coordinator -> Codebase Explorer 两层）
  const treeRes = await jget(`/api/agy/subagents?session=${encodeURIComponent(sid)}`);
  assert.equal(treeRes.status, 200);
  const tree = treeRes.body;
  assert.equal(tree.agents.length, 1);
  assert.equal(tree.agents[0].role, 'Teamwork Coordinator');
  assert.equal(tree.agents[0].children.length, 1);
  assert.equal(tree.agents[0].children[0].role, 'Codebase Explorer');
  assert.equal(tree.counts.total, 2);
  assert.ok(tree.modelMix.length >= 1);

  const coordId = tree.agents[0].id;
  const childId = tree.agents[0].children[0].id;

  // 2) 查询子代理转录（含提示词、思考、工具调用参数+输出、子代理跳链）+ 增量 offset + 越权 404
  const trCoord = await jget(`/api/agy/subagent-transcript?session=${encodeURIComponent(sid)}&agentId=${encodeURIComponent(coordId)}`);
  assert.equal(trCoord.status, 200);
  assert.match(trCoord.body.prompt, /协调整个代码审查/);
  assert.ok(trCoord.body.entries.some((e) => e.kind === 'thinking'));
  const toolEntry = trCoord.body.entries.find((e) => e.kind === 'tools');
  assert.ok(toolEntry, '转录中应包含工具调用');
  assert.equal(toolEntry.tools[0].name, 'invoke_subagent');
  assert.equal(toolEntry.tools[0].childAgentId, childId, '应自动关联到下级子代理 id');

  const trChild = await jget(`/api/agy/subagent-transcript?session=${encodeURIComponent(sid)}&agentId=${encodeURIComponent(childId)}`);
  assert.equal(trChild.status, 200);
  const cmdTool = trChild.body.entries.find((e) => e.kind === 'tools')?.tools?.[0];
  assert.equal(cmdTool?.name, 'run_command');
  assert.match(cmdTool?.output || '', /src\/index\.mjs/);

  // 增量拉取：无新行时返回 delta:true 且 entries 为空
  const trDelta = await jget(`/api/agy/subagent-transcript?session=${encodeURIComponent(sid)}&agentId=${encodeURIComponent(childId)}&from=${trChild.body.offset}`);
  assert.equal(trDelta.status, 200);
  assert.equal(trDelta.body.delta, true);
  assert.equal(trDelta.body.entries.length, 0);

  // 越权查一个不属于该会话的 UUID → 404
  const foreign = await jget(`/api/agy/subagent-transcript?session=${encodeURIComponent(sid)}&agentId=11111111-2222-3333-4444-555555555555`);
  assert.equal(foreign.status, 404);

  // 3) 等待 agy 后台自动唤醒（不发 session/update，只落盘 transcript_full.jsonl）被监视器同步进历史
  await waitFor(async () => {
    const det = await jget(`/api/agy/session/${encodeURIComponent(sid)}`);
    const texts = (det.body?.messages || []).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    return texts.includes('草案已就绪') ? det.body : null;
  });

  // 4) 核心防杀验证：重开 / 刷新带有 ALIVE 子代理的挂载会话时，绝不能向 agy 发 session/close
  const rpcLog = JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog;
  const closeCalls = rpcLog.filter((r) => r.method === 'session/close' && r.params?.sessionId === sid);
  assert.equal(closeCalls.length, 0, '挂载且有 ALIVE 子代理的会话禁止调 session/close（会触发 ForceStopCascadeTree 杀子代理）');
});

test('后台唤醒期间的 ask_question（elicitation/create）不再被静默取消，能正常弹窗并把回答送回 agy', async () => {
  const raw = await startChat({ cwd: projectDir, message: '启动审批流程 [TEAMWORK_ASK]' });
  const sid = parseSseFrames(raw).find((f) => f.type === 'done')?.sessionId;
  assert.ok(sid);

  // 等待后台唤醒触发 elicitation/create 并挂在被动 gen 的 pendingQuestion 上
  const activeWithQ = await waitFor(async () => {
    const r = await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`);
    return r.body?.pendingQuestion ? r.body : null;
  });
  assert.equal(activeWithQ.backgroundWake, true);
  assert.match(activeWithQ.pendingQuestion.message, /是否批准启动执行/);

  // 提交真实回答（批准启动）
  const ans = await jpost('/api/agy/question', {
    requestId: activeWithQ.pendingQuestion.requestId,
    action: 'accept',
    content: { approve: 'yes' },
  });
  assert.equal(ans.status, 200);
  assert.equal(ans.body.ok, true);

  // agy 收到真实回答后继续写完后续回复，并同步进会话历史（不再变成 User Skipped，也不被误标成已停止）
  const detail = await waitFor(async () => {
    const det = await jget(`/api/agy/session/${encodeURIComponent(sid)}`);
    if (det.body?.live) return null;
    const allText = (det.body?.messages || []).map((m) => m.text).join('\n');
    return allText.includes('已收到批准') && allText.includes('yes') ? det.body : null;
  });
  const lastAi = [...(detail.messages || [])].reverse().find((m) => m.role === 'assistant');
  assert.ok(lastAi);
  assert.notEqual(lastAi.status, 'interrupted', '后台唤醒收尾后 ask_question 应收敛为 completed，不能触发误判 interrupted');
  const askTool = (lastAi.tools || []).find((t) => t.name === 'ask_question');
  if (askTool) assert.equal(askTool.status, 'completed');
});

test('子代理汇报到达但 agy 未自动唤醒时，监视器自动兜底唤醒并隐藏内部唤醒词', async () => {
  const raw = await startChat({ cwd: projectDir, message: '启动兜底唤醒测试 [TEAMWORK_STALL]' });
  const sid = parseSseFrames(raw).find((f) => f.type === 'done')?.sessionId;
  assert.ok(sid);

  // 等待监视器过宽限期后自动发 internalWake，并把子代理汇报后的回复同步进历史
  const detail = await waitFor(async () => {
    const det = await jget(`/api/agy/session/${encodeURIComponent(sid)}`);
    const allText = (det.body?.messages || []).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    return allText.includes('子代理已汇报') ? det.body : null;
  });

  // 内部唤醒提示词不能变成一条用户气泡出现在历史里
  const userMsgs = (detail.messages || []).filter((m) => m.role === 'user');
  assert.equal(userMsgs.length, 1, '内部兜底唤醒不产生额外的用户气泡');
  assert.match(userMsgs[0].text, /启动兜底唤醒测试/);
});

test('parseModelAndEffort / unwrapSystemMessage：准确拆分模型与 effort 并剥离真实 agy 前导系统包装', async () => {
  const { parseModelAndEffort, unwrapSystemMessage } = await import('./subagents.mjs');
  assert.deepEqual(parseModelAndEffort('gemini-4-hydrogen-tiered-high'), {
    raw: 'gemini-4-hydrogen-tiered-high',
    modelBase: 'gemini-4-hydrogen',
    effort: 'high',
  });
  assert.deepEqual(parseModelAndEffort('gemini-4-neon-xhigh'), {
    raw: 'gemini-4-neon-xhigh',
    modelBase: 'gemini-4-neon',
    effort: 'xhigh',
  });
  assert.deepEqual(parseModelAndEffort('claude-sonnet-4-6'), {
    raw: 'claude-sonnet-4-6',
    modelBase: 'claude-sonnet-4-6',
    effort: '',
  });

  const realPrompt = 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-21T00:39:20Z sender=a0fc4bfc-9c8a-43e5-a41a-90650455772e priority=MESSAGE_PRIORITY_HIGH content=请全面审查后端代码\n</SYSTEM_MESSAGE>';
  const unwrapped = unwrapSystemMessage(realPrompt);
  assert.equal(unwrapped.sender, 'a0fc4bfc-9c8a-43e5-a41a-90650455772e');
  assert.equal(unwrapped.text, '请全面审查后端代码');
});

test('主会话后台命令（step_type=132, status=2）已被后续 PLANNER_RESPONSE 越过时，不误判为后台自动唤醒，也不阻塞真实唤醒收尾', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readDbActivity, hasProtectedSubagents } = await import('./subagents.mjs');
  const {
    armSubagentMonitor,
    getPassiveBackgroundGen,
    stopSubagentMonitor,
    syncSessionSubagents,
  } = await import('./subagent-monitor.mjs');

  const sid = '11111111-2222-4333-8444-555555555555';
  const convDir = path.join(fakeAgyData, 'conversations');
  const logDir = path.join(fakeAgyData, 'brain', sid, '.system_generated', 'logs');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const dbFile = path.join(convDir, sid + '.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0)');
  const ins = db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
  ins.run(0, 14, 3);   // USER_INPUT DONE
  ins.run(1, 15, 3);   // PLANNER_RESPONSE (calls run_command) DONE
  ins.run(2, 132, 2);  // GENERIC (backgrounded run_command) RUNNING
  ins.run(3, 15, 3);   // PLANNER_RESPONSE (final reply "正在后台构建…") DONE

  const trFile = path.join(logDir, 'transcript_full.jsonl');
  const nowIso = new Date().toISOString();
  writeFileSync(trFile, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: '构建 APK' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, tool_calls: [{ name: 'run_command', args: { CommandLine: 'build-apk.ps1' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: nowIso, content: 'Tool is running as a background task with task id: ' + sid + '/task-2' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, content: '正在后台构建 APK。' }),
  ].join('\n') + '\n', 'utf8');

  // 1) DB 识别：step 2 仍在跑，但模型已完成 step 3 → hasActiveSteps=true（保护不被 session/close 杀），hasRunning=false（前台轮已空闲）
  const act1 = readDbActivity(fakeAgyData, sid);
  assert.equal(act1.exists, true);
  assert.equal(act1.hasActiveSteps, true);
  assert.equal(act1.hasRunning, false);
  assert.equal(act1.activeStepIdxs.has(2), true);
  assert.equal(act1.activeTurnStepIdxs.size, 0);
  assert.equal(hasProtectedSubagents(fakeAgyData, sid), true);

  // 2) 挂载后台监视器并立即轮询：绝不能凭空挂起被动 gen（0 tokens · 等待 Antigravity...）
  const mockCtx = { key: 'admin', agyDir: path.join(dataRoot, 'agy') };
  const mockClient = {
    dataDir: fakeAgyData,
    hasActiveTurn: () => false,
    historyUpdates: new Map([[sid, []]]),
    mountedSessions: new Map([[sid, { cwd: projectDir }]]),
    cancelSession: () => {},
  };
  armSubagentMonitor(mockCtx, mockClient, sid, { pollNow: false });
  await syncSessionSubagents(mockCtx, mockClient, sid, { wake: false });
  assert.equal(getPassiveBackgroundGen('admin', sid), null, '历史轮转入后台的 run_command 不得触发空被动 gen');

  // 3) 稍后真正发生后台自动唤醒（step 4 SYSTEM_MESSAGE + step 5 PLANNER_RESPONSE GENERATING）→ 正常拉起被动 gen
  ins.run(4, 101, 3);
  ins.run(5, 15, 8);
  const act2 = readDbActivity(fakeAgyData, sid);
  assert.equal(act2.hasRunning, true);
  assert.equal(act2.activeTurnStepIdxs.has(5), true);
  assert.equal(act2.activeTurnStepIdxs.has(2), false);

  await syncSessionSubagents(mockCtx, mockClient, sid, { wake: false });
  assert.ok(getPassiveBackgroundGen('admin', sid), '真实后台自动唤醒应挂起被动 gen');

  // 4) 后台唤醒结束（step 5 变 DONE），即便旧的 step 2 依然是 RUNNING，被动 gen 也必须干净收尾
  db.prepare('UPDATE steps SET status = 3 WHERE idx = 5').run();
  writeFileSync(trFile, readFileSync(trFile, 'utf8') + JSON.stringify({
    step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, content: '后台构建已全部完成。',
  }) + '\n', 'utf8');
  const act3 = readDbActivity(fakeAgyData, sid);
  assert.equal(act3.hasRunning, false);
  assert.equal(act3.hasActiveSteps, true);

  await syncSessionSubagents(mockCtx, mockClient, sid, { wake: false });
  assert.equal(getPassiveBackgroundGen('admin', sid), null, '后台唤醒收尾后，旧后台命令不得卡住被动 gen');

  // 5) 并行同步工具调用场景：最新 PLANNER_RESPONSE(5) 之后有 step 6(RUNNING) 与 step 7(DONE) → 仍判定为前台轮在跑
  ins.run(6, 132, 2);
  ins.run(7, 132, 3);
  const act4 = readDbActivity(fakeAgyData, sid);
  assert.equal(act4.hasRunning, true);
  assert.equal(act4.activeTurnStepIdxs.has(6), true);

  stopSubagentMonitor('admin', sid);
  db.close();
});

test('Teamwork 深层子代理权限申请：完全放行（bypass）模式下自动接通并秒批，不弹审批卡也不超时', async () => {
  const raw = await startChat({
    cwd: projectDir,
    agyMode: 'bypass',
    message: '全自动跑 Teamwork 抓取 [TEAMWORK_SUB_PERM]',
  });
  const sid = parseSseFrames(raw).find((f) => f.type === 'done')?.sessionId;
  assert.ok(sid);

  // 监视器应检测到第 2 层 worker 的 steps.status=9，对其 session/resume 接通权限流并按主会话 bypass 自动允许
  const detail = await waitFor(async () => {
    const det = await jget(`/api/agy/session/${encodeURIComponent(sid)}`);
    const allText = (det.body?.messages || []).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    return allText.includes('子代理权限结果：allow') ? det.body : null;
  });
  assert.ok(detail, 'bypass 模式下子代理权限应被自动放行');

  // 确认没有残留挂起的审批卡
  const act = await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`);
  assert.equal(act.body?.pendingPermission || null, null);
});

test('Teamwork 深层子代理权限申请：非放行模式下透传到主对话屏幕与 active/overview，允许后子代理继续执行', async () => {
  const raw = await startChat({
    cwd: projectDir,
    agyMode: 'default',
    message: '逐项确认跑 Teamwork 抓取 [TEAMWORK_SUB_PERM]',
  });
  const sid = parseSseFrames(raw).find((f) => f.type === 'done')?.sessionId;
  assert.ok(sid);

  // 等待第 2 层 worker 的权限申请经 session/resume 透传到主会话的被动 gen
  const activeWithPerm = await waitFor(async () => {
    const r = await jget(`/api/agy/active?session=${encodeURIComponent(sid)}`);
    return r.body?.pendingPermission ? r.body : null;
  });
  assert.equal(activeWithPerm.backgroundWake, true);
  assert.equal(activeWithPerm.pendingPermission.sessionId, sid);
  assert.equal(activeWithPerm.pendingPermission.subagent?.role, 'M1 Live Sync Worker');
  assert.equal(activeWithPerm.pendingPermission.subagent?.depth, 2);
  assert.equal(activeWithPerm.pendingPermission.toolCall?.name, 'run_command');
  assert.equal(activeWithPerm.pendingPermissions.length, 1);

  // /api/active 的 ext（供通知 / 桌面壳 / agent overview 消费）里也能看到这条来自子代理的待审批条目
  const ov = await jget('/api/active');
  const agyAgent = (ov.body?.ext || []).find((a) => a.agent === 'agy');
  assert.ok(agyAgent?.asks?.some((a) => a.sessionId === sid && a.kind === 'permission' && a.question.includes('M1 Live Sync Worker')));

  // 用户在主对话点击允许
  const ans = await jpost('/api/agy/permission', {
    requestId: activeWithPerm.pendingPermission.requestId,
    optionId: 'allow',
    outcome: 'selected',
  });
  assert.equal(ans.status, 200);
  assert.equal(ans.body.ok, true);

  // 子代理拿到允许结果后继续跑完并同步回主对话
  const detail = await waitFor(async () => {
    const det = await jget(`/api/agy/session/${encodeURIComponent(sid)}`);
    if (det.body?.live) return null;
    const allText = (det.body?.messages || []).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    return allText.includes('子代理权限结果：allow') ? det.body : null;
  });
  assert.ok(detail);
});
