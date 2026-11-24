import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyAssistantTurn, applyAgyStreamEvent } from './logic.js';
import { computeDoing, computeDid, turnTokens, turnElapsed } from './run-status.js';

const tool = (id, extra) => ({ type: 'tool', tool: { toolCallId: id, status: 'in_progress', ...extra } });

test('状态栏：进行中按当前动作给标记与文案', () => {
  const m = createEmptyAssistantTurn();
  assert.equal(computeDoing(m).mark, 'waiting');

  applyAgyStreamEvent(m, { type: 'thinking', text: '想一想' });
  assert.deepEqual(computeDoing(m), { mark: 'thinking', text: '思考中…' });

  applyAgyStreamEvent(m, tool('a', { kind: 'edit', name: 'edit_file', locations: [{ path: 'E:\\p\\demo.html' }] }));
  assert.deepEqual(computeDoing(m), { mark: 'editing', text: '正在修改 demo.html…' });

  applyAgyStreamEvent(m, tool('b', { kind: 'execute', name: 'run_command', args: { CommandLine: 'npm test' } }));
  assert.equal(computeDoing(m).mark, 'orbiting');

  applyAgyStreamEvent(m, { type: 'tool-update', tool: { toolCallId: 'a', status: 'completed' } });
  assert.deepEqual(computeDoing(m), { mark: 'executing', text: '正在执行命令…' });

  applyAgyStreamEvent(m, { type: 'tool-update', tool: { toolCallId: 'b', status: 'completed' } });
  assert.equal(computeDoing(m).text, '正在规划下一步…');

  applyAgyStreamEvent(m, { type: 'text', text: '好了' });
  assert.deepEqual(computeDoing(m), { mark: 'writing', text: '正在回复…' });

  m.permissions.push({ requestId: 'r', status: 'pending' });
  assert.equal(computeDoing(m).mark, 'approval');
});

test('状态栏：跑完不展示步骤汇总，仅保留真实 token、用时及异常终止提示', () => {
  const m = createEmptyAssistantTurn({ startedAt: 1000 });
  applyAgyStreamEvent(m, tool('a', { kind: 'edit', name: 'edit_file', locations: [{ path: 'a.js' }] }));
  applyAgyStreamEvent(m, tool('b', { kind: 'edit', name: 'edit_file', locations: [{ path: 'b.js' }] }));
  applyAgyStreamEvent(m, tool('c', { kind: 'execute', name: 'run_command' }));
  applyAgyStreamEvent(m, { type: 'text', text: 'hello world, done' });
  assert.ok(turnTokens(m) > 0, '流式时按字数估');

  applyAgyStreamEvent(m, { type: 'done', usage: { outputTokens: 58, thoughtTokens: 43 }, elapsedMs: 12_345 });
  assert.equal(m.status, 'done');
  assert.equal(computeDid(m), '');
  assert.equal(turnTokens(m), 101);
  assert.equal(turnElapsed(m), 12_345);

  const plain = createEmptyAssistantTurn();
  applyAgyStreamEvent(plain, { type: 'text', text: 'hi' });
  applyAgyStreamEvent(plain, { type: 'interrupted' });
  assert.equal(computeDid(plain), '已停止');

  const failed = createEmptyAssistantTurn();
  applyAgyStreamEvent(failed, { type: 'error', message: 'boom' });
  assert.equal(computeDid(failed), '出错了');
});

test('状态栏：中途接上的轮次按服务端起点计时；老历史没有用时', () => {
  const m = createEmptyAssistantTurn();
  applyAgyStreamEvent(m, { type: 'attach', elapsedMs: 90_000 });
  const e = turnElapsed(m);
  assert.ok(e >= 90_000 && e < 95_000);

  const old = createEmptyAssistantTurn({ status: 'done' });
  delete old.startedAt;
  assert.equal(turnElapsed(old), null);
  old.stats = { ms: 5000, tokens: 777 };
  assert.equal(turnElapsed(old), 5000);
  assert.equal(turnTokens(old), 777);
});

// —— 这一轮说完了、后台还在跑 ——
import { computeBgWait, cronLabel, timerMs, fmtSpan, BG_STALL_MS } from './run-status.js';

test('后台等待：没有在跑的东西就不显示', () => {
  assert.equal(computeBgWait(null), null);
  assert.equal(computeBgWait({ hasActive: false, parentTasks: [{ status: 'running' }] }), null);
  // 只有主会话残留的 RUNNING 步骤、没有可描述的后台活：不显示
  assert.equal(computeBgWait({ hasActive: true, parentActive: true, counts: {}, parentTasks: [] }), null);
});

test('后台等待：转入后台的命令写标题与已跑时长，15 分钟没新输出算没动静', () => {
  const now = 10_000_000;
  const tree = {
    hasActive: true,
    counts: { active: 0 },
    parentTasks: [
      { id: 's/task-1', status: 'done', kind: 'command', title: '旧的', at: now - 9e6 },
      { id: 's/task-2', status: 'running', kind: 'command', title: 'Run OptiX optcheck', at: now - 250_000, logAt: now - 3000, logTail: '[0.85] scene loaded' },
    ],
  };
  const bg = computeBgWait(tree, now);
  assert.equal(bg.kind, 'task');
  assert.equal(bg.label, '后台任务在跑');
  assert.equal(bg.detail, 'Run OptiX optcheck');
  assert.equal(bg.since, now - 250_000);
  assert.equal(bg.stallMs, 0);
  assert.equal(bg.tail, '[0.85] scene loaded');

  tree.parentTasks[1].logAt = now - BG_STALL_MS - 60_000;
  assert.ok(computeBgWait(tree, now).stallMs > BG_STALL_MS);

  tree.parentTasks.push({ id: 's/task-3', status: 'running', kind: 'command', title: 'b', at: now - 1000 });
  assert.equal(computeBgWait(tree, now).detail, '2 个任务');
});

test('后台等待：子代理优先于后台命令，定时任务排最后', () => {
  const now = 50_000_000;
  const team = {
    hasActive: true,
    counts: { active: 3, running: 2 },
    updatedAt: now - 1000,
    agents: [{ status: 'waiting', spawnedAt: now - 3_600_000, subtreeCounts: { active: 3 } }],
    parentTasks: [{ status: 'running', kind: 'command', title: 'x', at: now }],
  };
  const a = computeBgWait(team, now);
  assert.equal(a.kind, 'team');
  assert.equal(a.detail, '2 个在干活');
  assert.equal(a.since, now - 3_600_000);

  const timer = { hasActive: true, counts: {}, parentTasks: [{ status: 'running', kind: 'timer', schedule: '10m', at: now - 4 * 60_000 }] };
  const b = computeBgWait(timer, now);
  assert.equal(b.kind, 'sched');
  assert.equal(b.detail, '约 6 分钟后');

  const cron = { hasActive: true, counts: {}, parentTasks: [{ status: 'running', kind: 'cron', schedule: '*/10 * * * *', at: now }] };
  assert.equal(computeBgWait(cron, now).detail, '每 10 分钟');
});

test('后台等待：计划与时长的人话', () => {
  assert.equal(cronLabel('*/8 * * * *'), '每 8 分钟');
  assert.equal(cronLabel('* * * * *'), '每分钟');
  assert.equal(cronLabel('0 * * * *'), '每小时');
  assert.equal(cronLabel('0 */2 * * *'), '每 2 小时');
  assert.equal(cronLabel('30 9 * * 1'), '30 9 * * 1');
  assert.equal(timerMs('10m'), 600_000);
  assert.equal(timerMs('1h30m'), 5_400_000);
  assert.equal(timerMs('600s'), 600_000);
  assert.equal(fmtSpan(59_000), '59s');
  assert.equal(fmtSpan(252_000), '4m12s');
  assert.equal(fmtSpan(27_528_000), '7h38m');
});
