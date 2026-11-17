// 号池计量（meter.mjs）：1% 粒度的读数也能学出「每 MW 涨几点」；分家族分摊；窗口重置、别处的用量不把估计带偏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeter, usageWeight, contextTokens, priorRate } from './meter.mjs';

test('usage 折成权重：读缓存 0.1、写缓存 1.25 / 1 小时档 2、输出 5', () => {
  const w = usageWeight({ input_tokens: 1000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 1000 }, output_tokens: 400 });
  assert.equal(+w.toFixed(6), +((1000 + 1.25 * 1000 + 2 * 1000 + 10_000 + 2000) / 1e6).toFixed(6));
  assert.equal(contextTokens({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }), 125);
  assert.equal(usageWeight(null), 0);
});

test('先验按套餐缩放：Pro 的 1% 比 Ultra 的小得多', () => {
  assert.ok(priorRate('pro', 'five_hour', 'opus') > priorRate('ultra', 'five_hour', 'opus') * 10);
  assert.ok(priorRate('max5x', 'seven_day_overage_included', 'fable') > priorRate('max5x', 'seven_day', 'fable'));
});

// 模拟一个真实速率为 trueRate 点 / MW 的号：每次用 w，读数按整数百分点上报
function simulate(m, acct, k, fam, trueRate, steps, w = 0.05, start = 20) {
  let real = start;
  m.observe(acct, k, Math.floor(real), 1e15);
  for (let i = 0; i < steps; i++) {
    m.addUsage(acct, fam, w);
    real += trueRate * w;
    m.observe(acct, k, Math.floor(real), 1e15);
  }
}

test('整数百分点的读数：几十次涨幅后学到的速率接近真实值', () => {
  const m = createMeter({ planOf: () => 'max5x' });
  simulate(m, 'a', 'five_hour', 'opus', 4, 300);   // 先验是 10，真实是 4
  const r = m.rate('a', 'five_hour', 'opus');
  assert.ok(r > 3.3 && r < 4.8, `学到 ${r}`);
});

test('第一次涨只对齐不学：起点落在 1% 中间也不会高估', () => {
  const m = createMeter({ planOf: () => 'max5x' });
  m.observe('a', 'five_hour', 20, 1e15);
  m.addUsage('a', 'opus', 0.01);
  assert.equal(m.observe('a', 'five_hour', 21, 1e15), false);   // 对齐
  m.addUsage('a', 'opus', 0.25);
  assert.equal(m.observe('a', 'five_hour', 22, 1e15), true);    // 学到一次
});

test('窗口重置（重置时刻变了 / 读数往回走）：攒的用量作废，不算成样本', () => {
  const m = createMeter({ planOf: () => 'max5x' });
  m.observe('a', 'five_hour', 50, 1000_000);
  m.addUsage('a', 'opus', 1);
  assert.equal(m.observe('a', 'five_hour', 3, 9_000_000), false);
  m.addUsage('a', 'opus', 1);
  assert.equal(m.observe('a', 'five_hour', 4, 9_000_000), false);   // 新窗口重新对齐
});

test('bridge 没用这个号时读数涨了（别处在用）：不学；一大笔别处的用量也截在 4 倍以内', () => {
  const m = createMeter({ planOf: () => 'max5x' });
  const before = m.rate('a', 'five_hour', 'opus');
  m.observe('a', 'five_hour', 10, 1e15);
  m.addUsage('a', 'opus', 0.1);
  m.observe('a', 'five_hour', 11, 1e15);   // 对齐
  assert.equal(m.observe('a', 'five_hour', 30, 1e15), false);   // 没有 bridge 用量
  m.addUsage('a', 'opus', 0.01);
  m.observe('a', 'five_hour', 80, 1e15);   // 0.01 MW 涨 50 点：截断
  assert.ok(m.rate('a', 'five_hour', 'opus') < before * 4);
});

test('Fable 周限额只记 Fable 的用量；共用桶按家族分摊', () => {
  const m = createMeter({ planOf: () => 'max5x' });
  simulate(m, 'a', 'seven_day_overage_included', 'fable', 2, 200, 0.1);
  simulate(m, 'a', 'seven_day_overage_included', 'opus', 50, 50, 0.1, 30);   // Opus 用量不进 Fable 桶：读数涨了也不学
  const r = m.rate('a', 'seven_day_overage_included', 'fable');
  assert.ok(r > 1.5 && r < 2.6, `学到 ${r}`);
});

test('落盘再读回：学到的速率还在', () => {
  const m = createMeter({ planOf: () => 'max5x' });
  simulate(m, 'a', 'five_hour', 'opus', 4, 200);
  const m2 = createMeter({ planOf: () => 'max5x' });
  m2.load(JSON.parse(JSON.stringify(m.dump())));
  assert.equal(+m2.rate('a', 'five_hour', 'opus').toFixed(4), +m.rate('a', 'five_hour', 'opus').toFixed(4));
  assert.ok(m.learned('a').five_hour.opus > 0);
});
