// 幻影 result 判据（agents/claude.mjs isPhantomResult）——这条判据被咬过两次，用例钉住：
//  · 09-13：CLI 在 resume 时替上一条命的孤儿后台任务补的那一轮，会在用户这轮 init 之前吐一个
//    空 result（origin.kind='task-notification'、num_turns 0、无正文）。当成本轮定局就把「继续」腰斩。
//  · 09-15：后台任务悬停之后，任务跑完 CLI 唤醒模型汇报，那个【真】result 同样带
//    origin.kind='task-notification'，但 num_turns ≥ 1、正文齐全。按 origin 判会把汇报整轮丢掉。
// 结论：判据是「零轮次空壳」，origin 只是常见来源，不能单独作准。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPhantomResult } from './agents/claude.mjs';

const result = (o) => ({ type: 'result', is_error: false, num_turns: 1, duration_api_ms: 1200, result: '好', ...o });

test('幻影 = 孤儿后台任务补的那一轮：零轮次、没走 API、没正文', () => {
  assert.equal(isPhantomResult(result({ origin: { kind: 'task-notification' }, num_turns: 0, duration_api_ms: 0, result: '' })), true);
  assert.equal(isPhantomResult(result({ num_turns: 0, duration_api_ms: 0, result: '' })), true);   // 没 origin 的同形状也算
});

test('悬停续轮（后台任务完成 → 模型汇报）的 result 不是幻影', () => {
  assert.equal(isPhantomResult(result({ origin: { kind: 'task-notification' }, result: '后台命令已跑完（退出码 0）' })), false);
  // 正文为空但真走过 API 的一轮同样不是幻影（本地斜杠命令 / 纯工具轮）
  assert.equal(isPhantomResult(result({ origin: { kind: 'task-notification' }, result: '', num_turns: 1, duration_api_ms: 0 })), false);
});

test('普通轮 / 错误轮都不是幻影', () => {
  assert.equal(isPhantomResult(result({})), false);
  assert.equal(isPhantomResult(result({ is_error: true, num_turns: 0, duration_api_ms: 0, result: '' })), false);
  assert.equal(isPhantomResult({ type: 'assistant' }), false);
  assert.equal(isPhantomResult(null), false);
});

// 挂起接力（09-28）：输入流在首条消息之后挂着，push 的消息逐条送出（带 uuid），release 即收尾。
test('makeTurnInput：首条之后挂住，push 逐条送出，release 后结束且不再收', async () => {
  const { makeTurnInput } = await import('./agents/claude.mjs');
  const ti = makeTurnInput('第一条', []);
  const it = ti.stream[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.value.message.content[0].text, '第一条');
  assert.equal(first.value.uuid, undefined);
  const pending = it.next();                       // 没有新消息 → 挂住
  const race = await Promise.race([pending.then(() => 'moved'), new Promise((r) => setTimeout(() => r('held'), 30))]);
  assert.equal(race, 'held');
  assert.equal(ti.push('第二条', [], 'u-2'), true);
  const second = await pending;
  assert.equal(second.value.message.content[0].text, '第二条');
  assert.equal(second.value.uuid, 'u-2');
  ti.push('第三条', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }], 'u-3');
  const third = await it.next();
  assert.deepEqual(third.value.message.content.map((b) => b.type), ['text', 'image']);
  const tail = it.next();
  ti.release();
  assert.equal((await tail).done, true);
  assert.equal(ti.push('太晚了', [], 'u-4'), false);
});
