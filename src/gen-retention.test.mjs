// 已完成 gen 的长保留语义（gen.mjs retireGen / tryStartGen 配对回收）：
// ① 完成后不立刻消失——重连任何时候都能 findGenBySession 拿到并整轮重放；
// ② 同会话新一轮开跑 → 旧完成轮被替换；
// ③ 已完成轮数量有 LRU 上限，最老的先走；
// ④ 活轮永远优先于完成轮被找到。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tryStartGen, retireGen, findGenBySession, getGens, getLiveGens,
} from './runtime/gen.mjs';

const KEY = 'test:retention';
let seq = 0;
function mkGen(sessionId, { done = false } = {}) {
  return {
    sessionId,
    userText: 'u' + (++seq),
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
    done,
    startedAt: Date.now(),
    settled: Promise.resolve(),
  };
}
function reset() {
  const a = getGens(KEY);
  a.splice(0, a.length);
}

test('完成的轮保留可查，直到同会话下一轮开跑才被替换', () => {
  reset();
  const g1 = mkGen('s1');
  assert.equal(tryStartGen(KEY, g1, { singleSession: true }).ok, true);
  g1.done = true;
  retireGen(KEY, g1);
  // 完成很久之后仍能按会话找到（不再有 60s 悬崖）
  assert.equal(findGenBySession(KEY, 's1'), g1);
  assert.equal(getLiveGens(KEY).length, 0);
  // 同会话下一轮开跑 → 旧完成轮被回收，新轮occupies
  const g2 = mkGen('s1');
  assert.equal(tryStartGen(KEY, g2, { singleSession: true }).ok, true);
  assert.equal(getGens(KEY).includes(g1), false);
  assert.equal(findGenBySession(KEY, 's1'), g2);
  reset();
});

test('活轮优先于同会话的完成轮', () => {
  reset();
  const done1 = mkGen('s2', { done: true });
  getGens(KEY); // ensure bucket
  assert.equal(tryStartGen(KEY, mkGen('s3'), {}).ok, true); // 别的会话占位，避免空桶被删
  const live = mkGen('s2');
  assert.equal(tryStartGen(KEY, live, { singleSession: true }).ok, true);
  // 完成轮如果晚于活轮出现（乱序注册），find 仍然回活轮
  getGens(KEY).push(done1);
  assert.equal(findGenBySession(KEY, 's2'), live);
  reset();
});

test('已完成轮 LRU 上限：最老的先被淘汰', () => {
  reset();
  const kept = [];
  for (let i = 0; i < 10; i++) {
    const g = mkGen('lru-' + i);
    assert.equal(tryStartGen(KEY, g, {}).ok, true);
    g.done = true;
    retireGen(KEY, g);
    kept.push(g);
  }
  const remaining = getGens(KEY).filter((g) => g.done);
  assert.equal(remaining.length, 8);           // DONE_KEEP_PER_KEY
  assert.equal(remaining.includes(kept[0]), false);  // 最老两轮被淘汰
  assert.equal(remaining.includes(kept[1]), false);
  assert.equal(remaining.includes(kept[9]), true);
  reset();
});

test('retireGen 后并发额度立即释放（done 不占 maxPerKey）', () => {
  reset();
  const g1 = mkGen('cap-1');
  assert.equal(tryStartGen(KEY, g1, { maxPerKey: 1 }).ok, true);
  g1.done = true;
  retireGen(KEY, g1);
  const g2 = mkGen('cap-2');
  assert.equal(tryStartGen(KEY, g2, { maxPerKey: 1 }).ok, true);
  reset();
});
