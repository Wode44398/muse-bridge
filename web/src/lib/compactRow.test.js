// 上下文压缩条目的前端纯函数：官方文案、分组汇总句里「compacted the session」的位置、撤回计数跳过它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_TOOL, compactLabel, groupSummary } from './toolVerbs.js';
import { retractSegments } from './retract.js';

const tool = (id, name, input = {}) => ({ id, name, input, status: 'done' });
const compact = (id, pre, post, status = 'done') => ({ id, name: COMPACT_TOOL, input: {}, status, compact: { preTokens: pre, postTokens: post, summary: '' } });
const sentence = (parts) => parts.map((p) => p.verb + (p.meta ? ' ' + p.meta : '')).join(', ');

test('compactLabel：桌面端原文（saved / from / 裸句 / 运行中 / 失败）', () => {
  assert.equal(compactLabel(compact('b', 970452, 15624)), 'Compacted session · saved 954.8k tokens');
  assert.equal(compactLabel(compact('b', 29803, 0)), 'Compacted session · from 29.8k tokens');
  assert.equal(compactLabel(compact('b', 0, 0)), 'Compacted session');
  assert.equal(compactLabel(compact('', 0, 0, 'running')), 'Compacting…');
  assert.equal(compactLabel(compact('', 0, 0, 'error')), 'Compaction failed');
});

test('groupSummary：压缩片段插在「压缩后才首次出现」的第一个类目之前', () => {
  const tools = [tool('1', 'Bash'), tool('2', 'Bash'), compact('c', 9e5, 2e4), tool('3', 'Bash'), tool('4', 'Edit', { file_path: 'a.js' })];
  assert.equal(sentence(groupSummary(tools)), 'ran 3 commands, compacted the session, edited a file');
});

test('groupSummary：压缩后没有新类目 → 垫在句尾；压缩不计入工具数', () => {
  const tools = [tool('1', 'Bash'), compact('c', 9e5, 2e4), tool('2', 'Bash')];
  assert.equal(sentence(groupSummary(tools)), 'ran 2 commands, compacted the session');
});

test('groupSummary：失败的压缩不进汇总句', () => {
  const tools = [tool('1', 'Bash'), compact('', 0, 0, 'error'), tool('2', 'Grep')];
  assert.equal(sentence(groupSummary(tools)), 'ran a command, searched code');
});

test('retract：工具行序号不数压缩条目，也绝不删它', () => {
  const m = { thinking: '', segments: [{ kind: 'tools', tools: [tool('t0', 'Bash'), compact('c', 9e5, 2e4), tool('t1', 'Bash'), tool('t2', 'Read')] }] };
  retractSegments(m, { toolsFrom: 1, toolsTo: 2 });   // 服务端第 1 条（从 0 数）= t1
  assert.deepEqual(m.segments[0].tools.map((t) => t.id), ['t0', 'c', 't2']);
});
