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
