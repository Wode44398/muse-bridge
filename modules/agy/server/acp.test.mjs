import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-acp-'));
const projectDir = path.join(tmp, 'proj');
const stateFile = path.join(tmp, 'state.json');
mkdirSync(projectDir, { recursive: true });

process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.AGY_BIN = FAKE_AGENT;
process.env.FAKE_ACP_STATE_FILE = stateFile;

const { AcpClient } = await import('./acp/client.mjs');

const extraClients = [];
const client = new AcpClient({
  daemonCwd: path.join(tmp, 'daemon'),
  logFile: null,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile },
});

after(() => {
  client.shutdown();
  for (const c of extraClients) {
    try { c.shutdown(); } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 6000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('AcpClient：并发单飞启动、请求超时、崩溃自动重启后按顺序补挂载与恢复配置', async () => {
  const [i1, i2, i3] = await Promise.all([
    client.ensureStarted(),
    client.ensureStarted(),
    client.ensureStarted(),
  ]);
  assert.equal(i1.protocolVersion, 1);
  assert.equal(i2.agentInfo.name, 'Antigravity ACP Server');
  assert.equal(i3.protocolVersion, 1);

  const disk1 = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(disk1.bootCount, 1, '并发 ensureStarted 只拉起一个子进程');

  await assert.rejects(
    client.request('test/hang', {}, 150),
    /请求超时/,
  );

  // 新建会话并切到只有 hydrogen 才支持的 xhigh 思考档位与 accept-edits 模式
  const snap = await client.createSession({
    cwd: projectDir,
    systemPromptAppend: '保持简洁',
    desiredConfig: {
      model: 'gemini-4-hydrogen',
      thought_level: 'xhigh',
      mode: 'accept-edits',
    },
  });
  assert.ok(snap.sessionId);

  // 触发非预期崩溃退出，等待自动恢复完成
  const oldPid = client.status().pid;
  await assert.rejects(client.request('test/crash', {}, 2000));

  await waitFor(() => {
    const st = client.status();
    return st.running && st.pid !== oldPid && st.mountedSessions.includes(snap.sessionId);
  });

  // 崩溃恢复后直接发一轮 prompt，验证 hydrogen / xhigh / accept-edits 已自动按序补发还原
  const turnRes = await client.runPrompt({
    sessionId: snap.sessionId,
    cwd: projectDir,
    promptBlocks: [{ type: 'text', text: '测试崩溃后配置保持' }],
  });
  assert.equal(turnRes.status, 'completed');
  assert.match(turnRes.text, /model=gemini-4-hydrogen\/xhigh\/accept-edits/);
});

test('AcpClient：同会话并发 load 合并复用且与 close/prompt 严格串行互斥', async () => {
  const snap = await client.createSession({ cwd: projectDir });
  const sid = snap.sessionId;
  await client.runPrompt({
    sessionId: sid,
    cwd: projectDir,
    promptBlocks: [{ type: 'text', text: '第一轮沉淀历史 [EDIT]' }],
  });

  const disk = JSON.parse(readFileSync(stateFile, 'utf8'));
  disk.loadDelayMs = 80;
  disk.closeDelayMs = 80;
  writeFileSync(stateFile, JSON.stringify(disk, null, 2), 'utf8');

  try {
    // 1) 并发两次 loadSessionWithReplay：两路都拿到完整的非空回放，不会出现前路 0 条
    const [loadA, loadB] = await Promise.all([
      client.loadSessionWithReplay(sid, { cwd: projectDir }),
      client.loadSessionWithReplay(sid, { cwd: projectDir }),
    ]);
    assert.ok(loadA.updates.length >= 4);
    assert.equal(loadA.updates.length, loadB.updates.length);

    // 2) load 刚进入 close 等待窗口时立刻发起 runPrompt：经同会话锁排队，不会把刚挂载的会话误关掉
    const loadPromise = client.loadSessionWithReplay(sid, { cwd: projectDir });
    await new Promise((r) => setTimeout(r, 20));
    const promptPromise = client.runPrompt({
      sessionId: sid,
      cwd: projectDir,
      promptBlocks: [{ type: 'text', text: '紧随 load 窗口的续聊' }],
    });

    const [loadRes, promptRes] = await Promise.all([loadPromise, promptPromise]);
    assert.ok(loadRes.updates.length >= 4);
    assert.equal(promptRes.status, 'completed');
  } finally {
    const cleanDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
    delete cleanDisk.loadDelayMs;
    delete cleanDisk.closeDelayMs;
    writeFileSync(stateFile, JSON.stringify(cleanDisk, null, 2), 'utf8');
  }
});

test('AcpClient：load 响应之后才推来的回放尾巴也要收齐（热加载时 agy 先回响应）', async () => {
  const snap = await client.createSession({ cwd: projectDir });
  const sid = snap.sessionId;
  await client.runPrompt({ sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text: '第一轮 [EDIT]' }] });
  await client.runPrompt({ sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text: '第二轮收尾' }] });

  const full = await client.loadSessionWithReplay(sid, { cwd: projectDir });
  const histCount = (ups) => ups.filter((u) => u.params.update.sessionUpdate !== 'usage_update'
    && u.params.update.sessionUpdate !== 'session_info_update'
    && u.params.update.sessionUpdate !== 'available_commands_update').length;
  const expected = histCount(full.updates);
  assert.ok(expected >= 4);

  const disk = JSON.parse(readFileSync(stateFile, 'utf8'));
  disk.lateReplayCount = 3;
  disk.lateReplayGapMs = 30;
  writeFileSync(stateFile, JSON.stringify(disk, null, 2), 'utf8');
  try {
    const t0 = Date.now();
    const res = await client.loadSessionWithReplay(sid, { cwd: projectDir });
    assert.equal(histCount(res.updates), expected, '响应后推来的历史不能丢');
    const last = res.updates.filter((u) => u.params.update.sessionUpdate === 'user_message_chunk').at(-1);
    assert.match(last.params.update.content.text, /第二轮收尾/);
    // 标题更新夹在回放中间（真 agy 热加载如此），不能据此提前收尾；静默窗口收尾也不该拖太久
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    const cleanDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
    delete cleanDisk.lateReplayCount;
    delete cleanDisk.lateReplayGapMs;
    writeFileSync(stateFile, JSON.stringify(cleanDisk, null, 2), 'utf8');
  }
});

test('AcpClient：在跑会话交出「本轮之前」的历史；本进程没有历史的会话续聊改用 load 挂载', async () => {
  const snap = await client.createSession({ cwd: projectDir });
  const sid = snap.sessionId;
  await client.runPrompt({ sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text: '第一轮' }] });

  const userTexts = (ups) => ups
    .map((u) => u.params.update)
    .filter((u) => u.sessionUpdate === 'user_message_chunk')
    .map((u) => u.content.text);

  const ctrl = new AbortController();
  const running = client.runPrompt({
    sessionId: sid,
    cwd: projectDir,
    promptBlocks: [{ type: 'text', text: '第二轮 [SLOW]' }],
    signal: ctrl.signal,
  });
  await waitFor(() => (client.historyUpdates.get(sid) || []).some((u) => u.params.update.content?.text === 'Part 1... '));
  const before = client.getLiveHistory(sid);
  assert.deepEqual(userTexts(before), ['第一轮'], '只含本轮之前的历史，不含正在跑的这一轮');
  assert.ok(before.some((u) => u.params.update.sessionUpdate === 'agent_message_chunk'), '第一轮的回复在历史里');
  assert.deepEqual(userTexts(client.historyUpdates.get(sid)), ['第一轮', '第二轮 [SLOW]'], '本轮实时更新照样记进历史');

  ctrl.abort();
  assert.equal((await running).status, 'interrupted');
  assert.equal(client.getLiveHistory(sid), null, '不在跑就不给');

  // 本进程丢了这个会话的历史（等同服务重启后直接续聊）：用 session/load 挂载、顺带拿回全量历史
  client.forgetSession(sid);
  const logBefore = JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog.length;
  const res = await client.runPrompt({ sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text: '第三轮' }] });
  assert.equal(res.status, 'completed');
  const methods = JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog.slice(logBefore).map((r) => r.method);
  assert.ok(methods.includes('session/load'), '续聊前补拿历史：' + methods.join(','));
  assert.ok(!methods.includes('session/resume'));
  assert.deepEqual(userTexts(client.historyUpdates.get(sid)).slice(0, 1), ['第一轮']);
  assert.equal(userTexts(client.historyUpdates.get(sid)).at(-1), '第三轮');
});

test('AcpClient：连续崩溃达到上限后停止自动重启并清理孙进程，手动 restart 可恢复（含在途失败启动）', async () => {
  const crashStateFile = path.join(tmp, 'crash-state.json');
  writeFileSync(crashStateFile, JSON.stringify({
    sessions: {},
    bootCount: 0,
    rpcLog: [],
    spawnGrandchild: true,
    autoCrashRemaining: 6,
    autoCrashAfterMs: 45,
  }, null, 2), 'utf8');

  const crashClient = new AcpClient({
    daemonCwd: path.join(tmp, 'crash-daemon'),
    logFile: null,
    maxCrashCount: 3,
    stableWindowMs: 60_000,
    env: { ...process.env, FAKE_ACP_STATE_FILE: crashStateFile },
  });
  extraClients.push(crashClient);

  await crashClient.ensureStarted();
  await waitFor(() => crashClient.status().stoppedAfterCrashes === true, 8000, 50);

  const stoppedStatus = crashClient.status();
  assert.equal(stoppedStatus.running, false);
  assert.equal(stoppedStatus.state, 'stopped');
  assert.equal(stoppedStatus.stoppedAfterCrashes, true);

  const crashDisk = JSON.parse(readFileSync(crashStateFile, 'utf8'));
  // 初次启动 1 次 + 最多连续自动重启 3 次 = 4 次，不会把预设的 6 次全部拉起
  assert.equal(crashDisk.bootCount, 4);
  assert.ok(Array.isArray(crashDisk.grandchildPids) && crashDisk.grandchildPids.length >= 4);
  for (const gpid of crashDisk.grandchildPids) {
    assert.equal(isPidAlive(gpid), false, `孙进程 ${gpid} 应已被进程树收尸`);
  }

  // 已进入 stopped 态时普通 ensureStarted 拒绝自动拉起，等待显式 restart
  await assert.rejects(crashClient.ensureStarted(), /连续异常退出已停止/);

  // 验证在途启动失败窗口内调 restart：不会返回旧的失败 Promise
  crashDisk.autoCrashRemaining = 0;
  crashDisk.spawnGrandchild = false;
  crashDisk.failInitOnce = true;
  crashDisk.failInitDelayMs = 180;
  writeFileSync(crashStateFile, JSON.stringify(crashDisk, null, 2), 'utf8');

  crashClient.stoppedAfterCrashes = false;
  crashClient.crashCount = 0;
  const failingStart = crashClient.ensureStarted().then(() => null, (err) => err);
  await new Promise((r) => setTimeout(r, 30));

  const recoveredStatus = await crashClient.restart();
  const failingErr = await failingStart;
  assert.ok(failingErr instanceof Error);
  assert.equal(recoveredStatus.running, true);
  assert.equal(recoveredStatus.state, 'running');
  assert.equal(recoveredStatus.stoppedAfterCrashes, false);
  assert.equal(recoveredStatus.crashCount, 0);
});

test('AcpClient：空闲挂载会话超上限后按 LRU 自动关闭释放 worker，同时保护有后台任务的会话', async () => {
  const evictStateFile = path.join(tmp, 'evict-state.json');
  const evictClient = new AcpClient({
    daemonCwd: path.join(tmp, 'evict-daemon'),
    logFile: null,
    maxIdleMountedSessions: 2,
    env: { ...process.env, FAKE_ACP_STATE_FILE: evictStateFile },
  });
  extraClients.push(evictClient);

  const aliveBg = new Set();
  evictClient.setBackgroundHandlers({
    hasAliveBackground: (sid) => aliveBg.has(sid),
  });

  const s1 = await evictClient.createSession({ cwd: projectDir });
  await new Promise((r) => setTimeout(r, 15));
  const s2 = await evictClient.createSession({ cwd: projectDir });
  await new Promise((r) => setTimeout(r, 15));
  const s3 = await evictClient.createSession({ cwd: projectDir });
  await new Promise((r) => setTimeout(r, 15));
  // 标记 s1 有活着的子代理/后台任务，即使它最老也不能被淘汰
  aliveBg.add(s1.sessionId);

  const s4 = await evictClient.createSession({ cwd: projectDir });
  await waitFor(() => {
    const mounted = evictClient.status().mountedSessions;
    // keep=s4，受保护=s1，空闲列表 [s2, s3] 超过 limit=2？再建一个 s5 触发淘汰 s2
    return mounted.includes(s4.sessionId);
  });
  await new Promise((r) => setTimeout(r, 15));
  const s5 = await evictClient.createSession({ cwd: projectDir });

  // 现在 mounted 候选空闲（不含 keep=s5 和受保护 s1）为 [s2, s3, s4]，limit=2 → 最老的 s2 被关闭，s1 完好
  await waitFor(() => !evictClient.status().mountedSessions.includes(s2.sessionId));
  const mounted = evictClient.status().mountedSessions;
  assert.equal(mounted.includes(s1.sessionId), true, '有活着后台任务的会话绝不能被淘汰关闭');
  assert.equal(mounted.includes(s2.sessionId), false, '最久未活跃的空闲会话应被自动关闭释放 worker');
  assert.equal(mounted.includes(s3.sessionId), true);
  assert.equal(mounted.includes(s4.sessionId), true);
  assert.equal(mounted.includes(s5.sessionId), true);
});
