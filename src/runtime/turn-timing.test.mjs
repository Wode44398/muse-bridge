import test from 'node:test';
import assert from 'node:assert/strict';
import { startTurnTiming, markTurn, handedTurn } from './turn-timing.mjs';

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('分段计时：一个请求只打一行，带路径与各段', () => {
  const req = {};
  startTurnTiming(req, Date.now() - 20);
  markTurn(req, 'body');
  const lines = capture(() => { handedTurn(req, 'a0f44122-b0cf', 'warm'); handedTurn(req, 'a0f44122-b0cf', 'warm'); });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[claude\] timing a0f44122 handed to CLI in \d+ms via warm \(.*last \d+\)$/);
});

test('排队重放：起点是入队时刻，超过 5 秒带 SLOW', () => {
  const req = {};
  startTurnTiming(req, Date.now() - 104_000);
  startTurnTiming(req);   // 路由进门不覆盖已有起点
  const [line] = capture(() => handedTurn(req, null, 'cold'));
  assert.match(line, /^\[claude\] SLOW timing new handed to CLI in 10\d{4}ms via cold/);
});

test('没有起点（预热、内部调用）什么都不打', () => {
  assert.deepEqual(capture(() => { markTurn(null, 'x'); handedTurn({}, 's', 'cold'); }), []);
});
