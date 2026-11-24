// 主会话后台任务（run_command 转入后台、schedule 的 Cron / Timer）：标题、种类、计划与最近输出的解析
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeBackgroundTask, readSubagentTree, readTaskLogTail } from './subagents.mjs';
import { noteAgyProcessStart } from './proc-epoch.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-bgtask-'));
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const SID = 'bd0f7846-66c9-41e8-9fd3-52618110b00e';

test('后台任务描述：命令取 toolSummary，Cron / Timer 拆出计划与提示词', () => {
  const cmd = describeBackgroundTask(
    'Created At: 2026-11-23T01:38:56-05:00\nTool is running as a background task with task id: s/task-352\nTask Description: Set-Location "E:\\scene2"\n& .\\sc2.exe frames=16',
    { name: 'run_command', args: { CommandLine: 'Set-Location "E:\\scene2"\n& .\\sc2.exe frames=16', toolSummary: 'Run OptiX optcheck and clamp tuning tests' } },
    's/task-352',
  );
  assert.equal(cmd.kind, 'command');
  assert.equal(cmd.title, 'Run OptiX optcheck and clamp tuning tests');
  assert.equal(cmd.command, 'Set-Location "E:\\scene2"');

  // 没有对上工具调用时退回命令首行，绝不是「Created At: …」
  const bare = describeBackgroundTask('Created At: x\nTool is running as a background task with task id: s/task-9\nTask Description: npm test -- --watch', null, 's/task-9');
  assert.equal(bare.title, 'npm test -- --watch');

  const cron = describeBackgroundTask('Created At: x\nTool is running as a background task with task id: s/task-18\nTask Description: Cron: */10 * * * *, Prompt: Heartbeat check: verify progress.md Task logs are available at: file:///C:/x', null, 's/task-18');
  assert.deepEqual([cron.kind, cron.schedule, cron.title], ['cron', '*/10 * * * *', 'Heartbeat check: verify progress.md']);

  const timer = describeBackgroundTask('Task Description: Timer: 10m, Prompt: Safety timer fired', null, 's/task-12');
  assert.deepEqual([timer.kind, timer.schedule, timer.title], ['timer', '10m', 'Safety timer fired']);
});

test('主会话后台任务：parentTasks 带标题，在跑的读日志最后一行', () => {
  const sysDir = path.join(tmp, 'brain', SID, '.system_generated');
  mkdirSync(path.join(sysDir, 'logs'), { recursive: true });
  mkdirSync(path.join(sysDir, 'tasks'), { recursive: true });
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const lines = [
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(now - 60_000), tool_calls: [
      { name: 'run_command', args: { CommandLine: 'python scan.py', toolSummary: 'Scan videos' } },
      { name: 'run_command', args: { CommandLine: 'Get-ChildItem out', toolSummary: 'List outputs' } },
    ] },
    { step_index: 2, type: 'GENERIC', status: 'RUNNING', created_at: iso(now - 59_000), content: `Created At: x\nTool is running as a background task with task id: ${SID}/task-2\nTask Description: python scan.py` },
    { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: iso(now - 58_000), content: 'Created At: x\nCompleted At: y' },
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(now - 57_000), content: '扫描在后台跑，跑完我接着看。' },
  ];
  writeFileSync(path.join(sysDir, 'logs', 'transcript_full.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // agy 进程在任务发起之前就起来了（否则会被当成随旧进程没了的任务）
  noteAgyProcessStart(tmp, now - 120_000);
  writeFileSync(path.join(sysDir, 'tasks', 'task-2.log'), 'start\n\x1b[32mframe 10/48\x1b[0m\r\nframe 11/48\n\n');

  const tree = readSubagentTree(tmp, SID);
  assert.equal(tree.parentTasks.length, 1);
  const tk = tree.parentTasks[0];
  assert.equal(tk.status, 'running');
  assert.equal(tk.title, 'Scan videos');
  assert.equal(tk.logTail, 'frame 11/48');
  assert.ok(tk.logAt > 0);
  assert.equal(tree.hasActive, true);

  assert.deepEqual(readTaskLogTail(tmp, SID, '../../etc/passwd'), { logAt: 0, logTail: '' });
});

test('比当前 agy 进程更早发起的后台命令记成已中断；后台在干活才拦空闲重启', async () => {
  const { backgroundBusy, backgroundShown } = await import('./subagents.mjs');
  const now = Date.now();
  // 上一个用例写的会话：task-2 在 59 秒前发起
  noteAgyProcessStart(tmp, now - 120_000);
  let tree = readSubagentTree(tmp, SID);
  assert.equal(tree.parentTasks[0].status, 'running');
  assert.equal(backgroundBusy(tree, now), true);
  // 15 分钟没新输出的后台命令（挂着的 dev server 之类）不再拦重启，但仍显示在跑
  assert.equal(backgroundBusy(tree, now + 16 * 60_000), false);

  noteAgyProcessStart(tmp, now);
  tree = readSubagentTree(tmp, SID);
  assert.equal(tree.parentTasks[0].status, 'lost');
  assert.equal(tree.hasActive, false);
  assert.equal(backgroundBusy(tree, now), false);

  // 只剩 Cron 不拦，Timer 拦
  assert.equal(backgroundBusy({ hasActive: true, counts: {}, parentTasks: [{ status: 'running', kind: 'cron' }] }), false);
  assert.equal(backgroundBusy({ hasActive: true, counts: {}, parentTasks: [{ status: 'running', kind: 'timer' }] }), true);
  assert.equal(backgroundBusy({ hasActive: true, counts: { active: 2 }, parentTasks: [], updatedAt: now }, now), true);
  // 子代理 15 分钟没动静（随旧进程死掉、.db 停在 RUNNING 的残留）不再拦
  assert.equal(backgroundBusy({ hasActive: true, counts: { active: 2 }, parentTasks: [], updatedAt: now - 20 * 60_000 }, now), false);
  // 主会话残留的 RUNNING 步骤：界面不显示「后台在跑」，也不拦重启
  const residue = { hasActive: true, parentActive: true, counts: {}, parentTasks: [], updatedAt: now - 3600_000 };
  assert.equal(backgroundShown(residue), false);
  assert.equal(backgroundBusy(residue, now), false);
  assert.equal(backgroundShown({ hasActive: true, counts: {}, parentTasks: [{ status: 'running', kind: 'cron' }] }), true);
});
