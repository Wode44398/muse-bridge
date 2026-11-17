// 智能分派（dispatch.mjs）：按任务绑号、段中不动、段与段之间重新打分、被挡住时只换走这一个任务、子 agent 跟主线程、落盘续上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch } from './dispatch.mjs';
import { IDLE_GAP } from './tasks.mjs';

function setup({ limits, blockedFor = () => null, mid = true, plans = {} } = {}) {
  const accts = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
  const state = { limits: limits || { a: {}, b: {}, c: {} }, mid };
  const d = createDispatch({
    listAccounts: () => accts,
    accountLimits: (id) => state.limits[id] || {},
    planOf: (id) => plans[id] || 'max5x',
    blocked: (id, model, opts) => blockedFor(id, model, opts),
    midSwitch: () => state.mid,
  });
  return { d, state };
}
const fresh = (pct = 10) => ({ five_hour: { pct, resetsAt: Date.now() + 3 * 3600_000 }, seven_day: { pct: 30, resetsAt: Date.now() + 3 * 86400_000 } });
const run = (d, r, w = 0.2) => { d.begin(r.task); d.usage(r.task, r.acct, 'claude-opus-5-5', { input_tokens: 0, output_tokens: Math.round(w * 1e6 / 5) }); d.end(r.task); };

test('三个会话并行开跑：各占一个号', () => {
  const { d } = setup({ limits: { a: fresh(), b: fresh(), c: fresh() } });
  const got = [];
  for (const sid of ['s1', 's2', 's3']) { const r = d.pick({ sid, model: 'claude-opus-5-5' }); d.begin(r.task); got.push(r.acct); }
  assert.deepEqual([...new Set(got)].length, 3);
});

test('同一段里不换号；段中被挡住且开着无缝换号才换走，只换这一个任务', () => {
  let blockA = false;
  const { d } = setup({ limits: { a: fresh(), b: fresh(), c: fresh() }, blockedFor: (id) => (blockA && id === 'a' ? { until: Date.now() + 3600_000, type: 'five_hour' } : null) });
  const r1 = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  d.begin(r1.task);
  assert.equal(r1.acct, 'a');
  const r2 = d.pick({ sid: 's2', model: 'claude-opus-5-5' });
  d.begin(r2.task);
  assert.notEqual(r2.acct, 'a');
  assert.equal(d.pick({ sid: 's1', model: 'claude-opus-5-5' }).acct, 'a');   // 段中：原号
  blockA = true;
  const moved = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  assert.notEqual(moved.acct, 'a');
  assert.equal(moved.entry.kind, 'move');
  assert.equal(moved.entry.reason, 'five_hour');
  assert.equal(d.pick({ sid: 's2', model: 'claude-opus-5-5' }).acct, r2.acct);   // 另一个会话不受影响
});

test('没开无缝换号：段中被挡住也不换（让这一轮撞墙停下），撞墙后重发那条再选号', () => {
  let blockA = false;
  const { d } = setup({ mid: false, limits: { a: fresh(), b: fresh(), c: fresh() }, blockedFor: (id) => (blockA && id === 'a' ? { until: Date.now() + 3600_000, type: 'five_hour' } : null) });
  const r = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  d.begin(r.task);
  blockA = true;
  assert.equal(d.pick({ sid: 's1', model: 'claude-opus-5-5' }).acct, 'a');
  d.end(r.task);
  d.limitHit(r.task);
  const again = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  assert.notEqual(again.acct, 'a');
  assert.equal(again.entry.kind, 'move');
});

test('新的一段：原号还装得下就留着（缓存热）；装不下就开跑前换', () => {
  const { d, state } = setup({ limits: { a: fresh(10), b: fresh(10), c: fresh(10) } });
  const r = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  assert.equal(r.acct, 'a');
  for (let i = 0; i < 3; i++) {
    run(d, d.pick({ sid: 's1', model: 'claude-opus-5-5' }), 1);   // 一段约 1 MW
    r.task.lastAt -= IDLE_GAP + 1000;
  }
  assert.equal(d.pick({ sid: 's1', model: 'claude-opus-5-5' }).acct, 'a');
  run(d, d.pick({ sid: 's1', model: 'claude-opus-5-5' }), 1);
  r.task.lastAt -= IDLE_GAP + 1000;
  state.limits.a = fresh(93);   // 5 小时只剩 5 点 ≈ 0.5 MW，装不下下一段
  const next = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  assert.notEqual(next.acct, 'a');
  assert.equal(next.entry.kind, 'rebalance');
  assert.equal(next.entry.reason, 'refit');
});

test('子 agent 默认跟主线程同号；主线程的号对子 agent 的模型不可用时子 agent 单独去别的号', () => {
  const { d } = setup({
    limits: { a: fresh(), b: fresh(), c: fresh() },
    blockedFor: (id, model) => (id === 'a' && /fable/.test(model) ? { until: Infinity, type: 'seven_day_overage_included' } : null),
  });
  const main = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  d.begin(main.task);
  const sub = d.pick({ sid: 's1', agent: 'ag1', model: 'claude-opus-5-5' });
  assert.equal(sub.acct, main.acct);
  const fable = d.pick({ sid: 's1', agent: 'ag2', model: 'claude-fable-5-2' });
  assert.notEqual(fable.acct, 'a');
  assert.equal(fable.entry && fable.entry.kind, 'sub');
  assert.equal(d.pick({ sid: 's1', model: 'claude-opus-5-5' }).acct, main.acct);   // 主线程不受影响
});

test('不认识的模型（自定义 API 等）不归分派管', () => {
  const { d } = setup();
  assert.equal(d.pick({ sid: 's1', model: 'mimo-v2.6-flash' }), null);
  assert.equal(d.pick({ sid: '', model: 'claude-opus-5-5' }), null);
});

test('落盘读回：续聊的会话回到原来的号', () => {
  const { d } = setup({ limits: { a: fresh(), b: fresh(), c: fresh() } });
  d.pick({ sid: 's0', model: 'claude-opus-5-5' });
  const r = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  run(d, r, 0.5);
  const saved = JSON.parse(JSON.stringify(d.dump()));
  const { d: d2 } = setup({ limits: { a: fresh(), b: fresh(), c: fresh() } });
  d2.load(saved);
  assert.equal(d2.pick({ sid: 's1', model: 'claude-opus-5-5' }).acct, r.acct);
});

test('状态视图：每个号在跑几个任务、最近的分派', () => {
  const { d } = setup({ limits: { a: fresh(), b: fresh(), c: fresh() } });
  d.setLabel('s1', '帮我改个按钮');
  const r = d.pick({ sid: 's1', model: 'claude-opus-5-5' });
  d.begin(r.task);
  const st = d.status();
  assert.equal(st.accounts[r.acct].tasks, 1);
  assert.equal(st.running[0].label, '帮我改个按钮');
  assert.equal(st.log[0].kind, 'place');
  assert.equal(st.log[0].label, '帮我改个按钮');
});
