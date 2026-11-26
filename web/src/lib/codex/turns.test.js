import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTurn, applyEvent, applyTool, displayCommand, diffStat, parseTurnDiff, turnSummary, turnFromHistory, mergeHistory } from './turns.js';

test('displayCommand 去掉 powershell / bash 包装', () => {
  assert.equal(displayCommand('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"'), 'npm test');
  assert.equal(displayCommand("powershell.exe -NoProfile -Command 'Get-ChildItem src'"), 'Get-ChildItem src');
  assert.equal(displayCommand("/bin/bash -lc 'rg -n foo src'"), 'rg -n foo src');
  assert.equal(displayCommand(['bash', '-lc', 'ls -la']), 'ls -la');
  assert.equal(displayCommand('npm run build'), 'npm run build');
});

test('读文件 / 搜代码的命令合并成一行「查看」，跑命令另起一行', () => {
  const t = newTurn({ text: 'hi', live: true });
  applyTool(t, { kind: 'command', id: 'c1', status: 'inProgress', command: 'cat a.js', commandActions: [{ type: 'read', name: 'a.js', path: 'src/a.js', command: 'cat a.js' }] });
  applyTool(t, { kind: 'command', id: 'c2', status: 'inProgress', command: 'rg foo', commandActions: [{ type: 'search', query: 'foo', path: 'src', command: 'rg foo' }] });
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].kind, 'explore');
  assert.equal(t.rows[0].items.length, 2);
  assert.equal(t.rows[0].status, 'run');
  applyTool(t, { kind: 'command', id: 'c1', status: 'completed', exitCode: 0, commandActions: [{ type: 'read', name: 'a.js', path: 'src/a.js' }] });
  applyTool(t, { kind: 'command', id: 'c2', status: 'completed', exitCode: 0, commandActions: [{ type: 'search', query: 'foo' }] });
  assert.equal(t.rows[0].status, 'ok');
  applyTool(t, { kind: 'command', id: 'c3', status: 'inProgress', command: 'npm test', commandActions: [{ type: 'unknown', command: 'npm test' }] });
  applyTool(t, { kind: 'command', id: 'c3', status: 'completed', command: 'npm test', exitCode: 1, durationMs: 812, output: 'FAIL' });
  assert.equal(t.rows.length, 2);
  assert.deepEqual([t.rows[1].kind, t.rows[1].status, t.rows[1].exit, t.rows[1].ms], ['cmd', 'fail', 1, 812]);
  // 命令之后再读文件：新开一行「查看」，不并回前面那行
  applyTool(t, { kind: 'command', id: 'c4', status: 'completed', exitCode: 0, command: 'cat b.js', commandActions: [{ type: 'read', name: 'b.js', path: 'b.js' }] });
  assert.equal(t.rows.length, 3);
});

test('改文件统计增删行，新建文件按整份内容算', () => {
  assert.deepEqual(diffStat('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n'), { a: 2, d: 1 });
  assert.deepEqual(diffStat('line1\nline2\n', 'add'), { a: 2, d: 0 });
  const t = newTurn({ live: true });
  applyTool(t, { kind: 'file_change', id: 'f1', status: 'completed', changes: [{ path: 'src/math.js', kind: { type: 'update' }, diff: '@@\n-a\n+b\n+c\n' }] });
  assert.equal(t.rows[0].files[0].name, 'math.js');
  assert.deepEqual([t.rows[0].files[0].a, t.rows[0].files[0].d], [2, 1]);
});

test('整轮 diff 按文件统计，收起那一行以它为准', () => {
  const d = parseTurnDiff('diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@\n-1\n+2\n+3\ndiff --git a/y.js b/y.js\n@@\n+z\n');
  assert.deepEqual(d.files.map((f) => [f.path, f.a, f.d]), [['x.js', 2, 1], ['y.js', 1, 0]]);
  const t = newTurn({ live: true });
  applyEvent(t, { type: 'diff', diff: 'diff --git a/x.js b/x.js\n@@\n+1\n' });
  const s = turnSummary(t);
  assert.deepEqual([s.a, s.d, s.files.length], [1, 0, 1]);
});

test('审批：等你批准先占一行，批了原地变成在跑的命令，带「允许了一次」', () => {
  const t = newTurn({ live: true });
  const out = applyEvent(t, { type: 'perm_request', qid: 'q1', preview: { kind: 'command', command: 'powershell.exe -Command "npm i"' }, codex: { itemId: 'c9' } });
  assert.equal(out.ask.qid, 'q1');
  assert.equal(t.status, 'ask');
  assert.deepEqual([t.rows[0].cmd, t.rows[0].status], ['npm i', 'wait']);
  applyEvent(t, { type: 'perm_answer', qid: 'q1', decision: 'once' });
  assert.deepEqual([t.rows[0].status, t.rows[0].approval], ['run', 'once']);
  applyEvent(t, { type: 'tool', tool: { kind: 'command', id: 'c9', status: 'completed', exitCode: 0, command: 'npm i' } });
  assert.equal(t.rows.length, 1);
  assert.deepEqual([t.rows[0].status, t.rows[0].approval], ['ok', 'once']);
});

test('终态：done 收口，在跑的行收成完成；error 带 limit', () => {
  const t = newTurn({ live: true });
  applyEvent(t, { type: 'tool', tool: { kind: 'command', id: 'c1', status: 'inProgress', command: 'sleep 1' } });
  applyEvent(t, { type: 'text', text: 'ok' });
  const out = applyEvent(t, { type: 'done', result: 'ok!' });
  assert.equal(out.terminal, true);
  assert.deepEqual([t.status, t.live, t.answer, t.rows[0].status], ['done', false, 'ok!', 'ok']);
  const e = newTurn({ live: true });
  applyEvent(e, { type: 'error', message: '额度用完', limit: { accountId: 'a', until: 1 } });
  assert.equal(e.error.limit.accountId, 'a');
});

test('历史：ThreadItem 还原成同样的行，侧车补附件', () => {
  const raw = [{
    id: 't1', status: 'completed', startedAt: 1700000000, completedAt: 1700000060,
    items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '修一下' }] },
      { type: 'agentMessage', id: 'm0', phase: 'commentary', text: '先看看' },
      { type: 'commandExecution', id: 'c', status: 'completed', command: 'cat a', commandActions: [{ type: 'read', name: 'a', path: 'a' }], exitCode: 0 },
      { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a', kind: { type: 'update' }, diff: '@@\n+x\n' }] },
      { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: '改好了' },
    ],
  }];
  const turns = mergeHistory(raw, [
    { role: 'user', text: '修一下', attachments: [{ path: 'p.png', name: 'p.png', kind: 'image' }] },
    { role: 'assistant', text: '改好了', attachments: [] },
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].rows.map((r) => r.kind), ['say', 'explore', 'edit']);
  assert.equal(turns[0].answer, '改好了');
  assert.equal(turns[0].user.attachments[0].path, 'p.png');
  assert.equal(turnSummary(turns[0]).ms, 60000);
  // 没有真实历史时退回侧车
  const side = mergeHistory(null, [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }]);
  assert.deepEqual([side[0].user.text, side[0].answer], ['a', 'b']);
  assert.equal(turnFromHistory({ id: 'x', status: 'completed', items: [] }).adopted, true);
});
