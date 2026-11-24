// 智能分派的打分（placement.mjs）：维护者点名的两条（Fable 任务去 Fable 剩得多的号、Opus 任务优先去 Fable 已用完的号），
// 以及长活挑装得下的号、并行分开、快重置的先用、缓存热的留原号、全都快满时的退路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAccounts, reasonFor } from './placement.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const H = 3600_000;
// 速率（百分点 / MW）：5 小时桶 10、周桶 1.5、Fable 周限额 3；Fable 每 MW 贵 1.6 倍
const rate = (_a, k, f) => ({ five_hour: 10, seven_day: 1.5, seven_day_overage_included: 3 }[k] || 1.5) * (f === 'fable' ? 1.6 : 1);
const acct = (id, idx, limits, blocked = {}) => ({
  id, idx, plan: 'max5x', soft: false,
  blocked: { fable: false, opus: false, sonnet: false, haiku: false, ...blocked },
  limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, typeof v === 'number' ? { pct: v, resetsAt: NOW + 3 * 86400_000 } : v])),
});
const task = (family, est, extra = {}) => ({ family, est, rebuild: 0, warm: false, current: '', parent: '', ...extra });
const rank = (accounts, t, others = []) => rankAccounts({ accounts, task: t, others, rate, now: NOW });

test('Opus 任务优先放到 Fable 已用完的号上，给 Fable 任务留共用额度', () => {
  const accounts = [
    acct('y', 0, { five_hour: 30, seven_day: 50, seven_day_overage_included: 20 }),
    acct('x', 1, { five_hour: 30, seven_day: 50, seven_day_overage_included: 100 }, { fable: true }),
  ];
  const rows = rank(accounts, task('opus', 1));
  assert.equal(rows[0].id, 'x');
  assert.equal(reasonFor(rows, task('opus', 1)), 'keep_fable');
});

test('11-23 实况：Fable 被自己的周限额卡住时，Opus 照样优先去 Fable 已爆的号（不被均衡 / 快重置拉回）', () => {
  // alice：Fable 58%、周 30%、5 小时 13% 三分钟后重置；dali：Fable 100% 被拒（2.5 天后恢复）、周 72%、5 小时 0%
  const alice = acct('alice', 0, { five_hour: { pct: 13, resetsAt: NOW + 3 * 60_000 }, seven_day: { pct: 30, resetsAt: NOW + 6 * 86400_000 }, seven_day_overage_included: { pct: 58, resetsAt: NOW + 6 * 86400_000 } });
  const dali = acct('dali', 1, { five_hour: { pct: 0, resetsAt: NOW + 3 * H }, seven_day: { pct: 72, resetsAt: NOW + 60 * H }, seven_day_overage_included: { pct: 100, status: 'rejected', resetsAt: NOW + 60 * H } }, { fable: true });
  dali.until = { fable: NOW + 60 * H };
  const t = task('opus', 1.9);
  const rows = rank([alice, dali], t);
  assert.equal(rows[0].id, 'dali');
  assert.equal(reasonFor(rows, t), 'keep_fable');
  // Fable 任务当然不去 dali
  assert.deepEqual(rank([alice, dali], task('fable', 1)).map((r) => r.id), ['alice']);
});

test('Fable 马上就恢复的号，「用别人用不了的额度」加分随之变小', () => {
  const y = acct('y', 0, { five_hour: 10, seven_day: 30, seven_day_overage_included: 40 });
  const x = acct('x', 1, { five_hour: 10, seven_day: 30, seven_day_overage_included: 100 }, { fable: true });
  x.until = { fable: NOW + 20 * 60_000 };
  const rows = rank([y, x], task('opus', 1));
  const xr = rows.find((r) => r.id === 'x');
  assert.ok(xr.parts.free > 0 && xr.parts.free < 0.1);
});

test('5 小时窗口几分钟内就重置：不算「快重置先用」', () => {
  const accounts = [
    acct('soon', 0, { five_hour: { pct: 10, resetsAt: NOW + 3 * 60_000 }, seven_day: 40 }),
    acct('other', 1, { five_hour: 10, seven_day: 40 }),
  ];
  const rows = rank(accounts, task('opus', 1));
  const u = (id) => rows.find((r) => r.id === id).parts.urgency;
  assert.ok(Math.abs(u('soon') - u('other')) < 1e-9);
});

test('Pro 号没有 Fable：Opus 任务优先去它，Fable 任务不会去它', () => {
  const accounts = [
    acct('max', 0, { five_hour: 20, seven_day: 40, seven_day_overage_included: 30 }),
    { ...acct('pro', 1, { five_hour: 20, seven_day: 40 }, { fable: true }), plan: 'pro' },
  ];
  assert.equal(rank(accounts, task('opus', 0.5))[0].id, 'pro');
  const fable = rank(accounts, task('fable', 0.5));
  assert.deepEqual(fable.map((r) => r.id), ['max']);
});

test('Fable 任务分给 Fable 剩得最多的号', () => {
  const accounts = [
    acct('low', 0, { five_hour: 5, seven_day: 40, seven_day_overage_included: 75 }),
    acct('high', 1, { five_hour: 5, seven_day: 40, seven_day_overage_included: 15 }),
  ];
  const t = task('fable', 0.3);
  const rows = rank(accounts, t);
  assert.equal(rows[0].id, 'high');
  assert.equal(reasonFor(rows, t), 'fable_room');
});

test('长活挑装得下这一段的号，哪怕另一个号排在前面', () => {
  const accounts = [
    acct('tight', 0, { five_hour: 60, seven_day: 30 }),   // 5 小时还剩 38 点 ≈ 3.8 MW
    acct('roomy', 1, { five_hour: 20, seven_day: 30 }),   // ≈ 7.8 MW
  ];
  const t = task('opus', 5);
  const rows = rank(accounts, t);
  assert.equal(rows[0].id, 'roomy');
  assert.equal(rows[0].fits, true);
  assert.equal(rows[1].fits, false);
  assert.equal(reasonFor(rows, t), 'fit_only');
});

test('原号装不下下一段：开跑前换号，重建缓存的量也算进新号要装下的量', () => {
  const accounts = [
    acct('cur', 0, { five_hour: 70, seven_day: 30 }),
    acct('next', 1, { five_hour: 10, seven_day: 30 }),
  ];
  const t = task('opus', 3, { current: 'cur', warm: true, rebuild: 0.4 });
  const rows = rank(accounts, t);
  assert.equal(rows[0].id, 'next');
  assert.equal(reasonFor(rows, t, 'cur'), 'refit');
});

test('并行的任务分到不同的号：别的任务预留的量先扣掉', () => {
  const accounts = [acct('a', 0, { five_hour: 10, seven_day: 30 }), acct('b', 1, { five_hour: 10, seven_day: 30 })];
  const first = rank(accounts, task('opus', 1));
  assert.equal(first[0].id, 'a');
  const second = rank(accounts, task('opus', 1), [{ acct: 'a', family: 'opus', rem: 1 }]);
  assert.equal(second[0].id, 'b');
  assert.equal(reasonFor(second, task('opus', 1)), 'spread');
});

test('额度快重置的号先用（过了重置点没用的就作废了）', () => {
  const accounts = [
    acct('later', 0, { five_hour: 10, seven_day: { pct: 60, resetsAt: NOW + 6 * 86400_000 } }),
    acct('soon', 1, { five_hour: 10, seven_day: { pct: 60, resetsAt: NOW + 10 * H } }),
  ];
  const rows = rank(accounts, task('opus', 0.5));
  assert.equal(rows[0].id, 'soon');
  assert.equal(reasonFor(rows, task('opus', 0.5)), 'expiring');
});

test('缓存还热、原号也装得下：留在原号，不为一点余量差去重建缓存', () => {
  const accounts = [acct('cur', 0, { five_hour: 40, seven_day: 50 }), acct('other', 1, { five_hour: 10, seven_day: 30 })];
  const rows = rank(accounts, task('opus', 1, { current: 'cur', warm: true, rebuild: 0.6 }));
  assert.equal(rows[0].id, 'cur');
});

test('5 小时窗口马上就重置：不算卡脖子，长活照样能放', () => {
  const accounts = [
    acct('refill', 0, { five_hour: { pct: 90, resetsAt: NOW + 10 * 60_000 }, seven_day: 20 }),
    acct('other', 1, { five_hour: 80, seven_day: 20 }),
  ];
  const rows = rank(accounts, task('opus', 4));
  assert.equal(rows[0].id, 'refill');
  assert.equal(rows[0].fits, true);
});

test('都快满了：退一步只排除真用满的；全都用满返回空', () => {
  const a = { ...acct('a', 0, { five_hour: 99, seven_day: 30 }), soft: true };
  const b = { ...acct('b', 1, { five_hour: 100, seven_day: 30 }, { opus: true }), soft: true };
  const rows = rank([a, b], task('opus', 0.5));
  assert.deepEqual(rows.map((r) => r.id), ['a']);
  assert.equal(reasonFor(rows, task('opus', 0.5)), 'fallback');
  assert.deepEqual(rank([b], task('opus', 0.5)), []);
});

test('子 agent 跟主线程同号（同等条件下）', () => {
  const accounts = [acct('a', 0, { five_hour: 10, seven_day: 30 }), acct('b', 1, { five_hour: 10, seven_day: 30 })];
  const rows = rank(accounts, task('opus', 0.4, { parent: 'b' }));
  assert.equal(rows[0].id, 'b');
});

test('没人用 Fable 时不替它留额度', () => {
  const accounts = [
    acct('y', 0, { five_hour: 30, seven_day: 50, seven_day_overage_included: 20 }),
    acct('x', 1, { five_hour: 30, seven_day: 50, seven_day_overage_included: 100 }, { fable: true }),
  ];
  const rows = rankAccounts({ accounts, task: task('opus', 1), rate, now: NOW, demanded: () => false });
  assert.equal(rows[0].id, 'y');
});
