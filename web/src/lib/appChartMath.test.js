// 声明式应用 chart 积木的纯函数（lib/appChartMath.js）：高度夹取、数据整理、好看的刻度、时间刻度、格式、几何、落点与提示框。
// 纯 JS，不起浏览器：node --test web/src/lib/appChartMath.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHART_H_MIN, CHART_H_MAX, CHART_H_DEFAULT, clampHeight, xTypeOf, parseTime, parseY, parseX, prepare,
  niceStep, niceTicks, yDomain, timeTicks, fmtNum, fmtTime, textW, clip, labelStride,
  buildChart, nearestSlot, placeTip, seriesColor,
} from './appChartMath.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('高度：夹在 120～480，没给 / 坏值用默认', () => {
  assert.equal(clampHeight(50), CHART_H_MIN);
  assert.equal(clampHeight(9999), CHART_H_MAX);
  assert.equal(clampHeight(300), 300);
  assert.equal(clampHeight('260'), 260);
  assert.equal(clampHeight(undefined), CHART_H_DEFAULT);
  assert.equal(clampHeight(NaN), CHART_H_DEFAULT);
  assert.equal(clampHeight(-5), CHART_H_DEFAULT);
});

test('横轴类型认不出当 category', () => {
  assert.equal(xTypeOf(undefined), 'category');
  assert.equal(xTypeOf({ type: 'time' }), 'time');
  assert.equal(xTypeOf({ type: 'log' }), 'category');
});

test('时间解析：毫秒、秒、数字串、ISO；坏值 null', () => {
  assert.equal(parseTime(1700000000000), 1700000000000);
  assert.equal(parseTime(1700000000), 1700000000000, '秒级时间戳乘 1000');
  assert.equal(parseTime('1700000000'), 1700000000000);
  assert.equal(parseTime('2024-01-02T00:00:00Z'), Date.UTC(2024, 0, 2));
  assert.equal(parseTime('2026-11-16'), new Date(2026, 10, 16).getTime(), '纯日期按本地午夜，UTC 以西不早一天');
  assert.equal(new Date(parseTime('2026-11-16')).getDate(), 16);
  assert.equal(parseTime('2026-11'), new Date(2026, 10, 1).getTime());
  assert.equal(parseTime('2026-02-30'), null, '不存在的日子');
  assert.equal(parseTime('not a date'), null);
  assert.equal(parseTime(null), null);
  assert.equal(parseTime(NaN), null);
});

test('纵 / 横轴取值：数字串可用，空和坏值跳过', () => {
  assert.equal(parseY('3.5'), 3.5);
  assert.equal(parseY(''), null);
  assert.equal(parseY(null), null);
  assert.equal(parseY(Infinity), null);
  assert.equal(parseX(3, 'category'), '3');
  assert.equal(parseX({}, 'category'), null);
  assert.equal(parseX('7', 'number'), 7);
  assert.equal(parseX('x', 'number'), null);
});

test('整理数据：category 按首次出现排；number 去重升序；坏点跳过；最多 8 组', () => {
  const d = prepare({
    kind: 'line',
    series: [
      { name: 'A', points: [['一月', 1], ['二月', 2], 'bad', [null, 3]] },
      { name: 'B', points: [['三月', 1], ['一月', 4]] },
    ],
  });
  assert.equal(d.xType, 'category');
  assert.deepEqual(d.keys, ['一月', '二月', '三月']);
  assert.equal(d.series[0].points.length, 2);
  const n = prepare({ kind: 'bar', x: { type: 'number' }, series: [{ name: 'A', points: [[3, 1], [1, 2], [3, 5]] }] });
  assert.equal(n.kind, 'bar');
  assert.deepEqual(n.keys, [1, 3]);
  assert.deepEqual(n.series[0].points.map((p) => p.x), [1, 3, 3], '点按 x 排序');
  const many = prepare({ series: Array.from({ length: 12 }, (_, i) => ({ name: 's' + i, points: [[1, i]] })) });
  assert.equal(many.series.length, 8);
  assert.equal(prepare(null).series.length, 0);
});

test('好看的步长：1 / 2 / 2.5 / 5 × 10^k；整数数据至少 1、不出 2.5', () => {
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(12, 5), 2.5);
  assert.equal(niceStep(12, 5, { integer: true }), 2);
  assert.equal(niceStep(1, 5), 0.2);
  assert.equal(niceStep(1, 5, { integer: true }), 1);
  assert.equal(niceStep(0, 5), 1);
  assert.equal(niceStep(120, 5, { integer: true }), 25, '25 本身是整数，留着');
  assert.equal(niceStep(7000, 5), 2000);
});

test('纵轴刻度：外扩到步长整数倍，两端都是刻度，没有浮点尾巴', () => {
  const a = niceTicks(3, 97, 5);
  assert.equal(a.lo, 0);
  assert.equal(a.hi, 100);
  assert.deepEqual(a.ticks, [0, 20, 40, 60, 80, 100]);
  const b = niceTicks(0.1, 0.7, 5);
  assert.deepEqual(b.ticks, [0, 0.2, 0.4, 0.6, 0.8]);
  const c = niceTicks(-12, 30, 5);
  assert.ok(c.ticks.includes(0));
  assert.ok(c.lo <= -12 && c.hi >= 30);
  const one = niceTicks(5, 5, 5, { integer: true });
  assert.ok(one.lo <= 5 && one.hi > 5, '只有一个值时上下让出空间');
  assert.ok(one.ticks.every(Number.isInteger));
  const zero = niceTicks(0, 0, 5);
  assert.deepEqual([zero.lo, zero.hi], [0, 1]);
  const bad = niceTicks(NaN, 3, 5);
  assert.ok(bad.ticks.length >= 2);
});

test('纵轴范围：柱状含 0；折线小起伏不硬拉到 0、靠近 0 的从 0 起', () => {
  const s = (ys) => [{ points: ys.map((y, i) => ({ x: i, y })) }];
  assert.deepEqual(yDomain(s([50, 60]), 'bar'), { lo: 0, hi: 60, integer: true, empty: false });
  assert.equal(yDomain(s([50, 60]), 'line').lo, 50, '50 > 60 × 0.35，不从 0 起');
  assert.equal(yDomain(s([10, 60]), 'line').lo, 0);
  assert.equal(yDomain(s([-5, -1]), 'bar').hi, 0);
  assert.equal(yDomain(s([1.5, 2]), 'line').integer, false);
  assert.equal(yDomain(s([null]), 'line').empty, true);
});

test('时间刻度：一天内按整点、一周按天零点、一年按月初、十年按年初；都落在范围内', () => {
  const lo = new Date(2024, 0, 1, 9, 7).getTime();
  const h = timeTicks(lo, lo + 10 * 3600e3, 5);
  assert.equal(h.unit, 'hour');
  for (const v of h.ticks) { const d = new Date(v); assert.equal(d.getMinutes(), 0); assert.ok(v >= lo && v <= lo + 10 * 3600e3); }
  const d0 = new Date(2024, 0, 1, 15).getTime();
  const days = timeTicks(d0, d0 + 6 * 86400e3, 5);
  assert.equal(days.unit, 'day');
  for (const v of days.ticks) assert.equal(new Date(v).getHours(), 0);
  const m = timeTicks(new Date(2024, 0, 15).getTime(), new Date(2024, 11, 20).getTime(), 5);
  assert.equal(m.unit, 'month');
  for (const v of m.ticks) assert.equal(new Date(v).getDate(), 1);
  const y = timeTicks(new Date(2010, 5, 1).getTime(), new Date(2024, 5, 1).getTime(), 5);
  assert.equal(y.unit, 'year');
  for (const v of y.ticks) { const d = new Date(v); assert.equal(d.getMonth(), 0); assert.equal(d.getDate(), 1); }
  assert.deepEqual(timeTicks(5, 5).ticks, [5]);
});

test('数字格式：按步长的小数位；≥ 10000 紧凑', () => {
  assert.equal(fmtNum(1, { step: 0.5, locale: 'en-US' }), '1.0');
  assert.equal(fmtNum(1234, { locale: 'en-US' }), '1,234');
  assert.equal(fmtNum(12000, { locale: 'en-US' }), '12K');
  assert.equal(fmtNum(3.14159, { locale: 'en-US' }), '3.14');
  assert.equal(fmtNum(NaN), '');
  assert.ok(fmtNum(20000, { locale: 'zh-CN' }).includes('万'));
});

test('时间格式：月份刻度带年份，小时刻度 24 小时制', () => {
  const ms = new Date(2024, 2, 5, 14, 30).getTime();
  assert.match(fmtTime(ms, 'hour', 'en-US'), /14:30/);
  assert.match(fmtTime(ms, 'month', 'en-US'), /2024/);
  assert.equal(fmtTime(NaN), '');
});

test('文字宽度与截断：中文按整字号、西文按 0.6', () => {
  near(textW('ab', 10), 12);
  near(textW('中文', 10), 20);
  assert.equal(clip('abcdefghijklmnop', 5), 'abcd…');
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(labelStride(10, 500, 30), 1);
  assert.equal(labelStride(40, 300, 30), 6);
  assert.equal(labelStride(1, 10, 100), 1);
});

const two = (kind, x) => ({
  kind, x,
  series: [
    { name: '收入', points: [['一月', 10], ['二月', 30], ['三月', 20]] },
    { name: '支出', points: [['一月', 5], ['二月', 15], ['三月', 25]] },
  ],
});

test('折线几何：每组一条路径，点在图版内；落点每格一个、列出两组的值', () => {
  const c = buildChart(two('line'), { width: 400, height: 220 });
  assert.equal(c.series.length, 2);
  for (const s of c.series) {
    assert.match(s.path, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){2}$/);
    for (const d of s.dots) {
      assert.ok(d.x >= c.box.l && d.x <= c.box.l + c.box.w);
      assert.ok(d.y >= c.box.t - 1e-6 && d.y <= c.box.t + c.box.h + 1e-6);
    }
  }
  assert.equal(c.slots.length, 3);
  assert.deepEqual(c.slots[1].items.map((i) => i.v), [30, 15]);
  assert.equal(c.yTicks[0].v, 0, '从 0 起（5 < 30 × 0.35）');
  assert.equal(c.xTicks.length, 3);
  assert.ok(c.box.l + c.box.w <= 400);
});

test('缺值断线：null 让下一个点重新起笔', () => {
  const c = buildChart({ kind: 'line', series: [{ name: 'a', points: [['a', 1], ['b', null], ['c', 3], ['d', 4]] }] }, { width: 300 });
  assert.equal((c.series[0].path.match(/M/g) || []).length, 2);
  assert.equal(c.series[0].dots.length, 3);
});

test('柱状几何：从 0 长出，柱宽 ≤ 24、相邻留 2px，负值朝下', () => {
  const c = buildChart(two('bar'), { width: 600, height: 240 });
  const [a, b] = c.series;
  assert.equal(a.bars.length, 3);
  for (const bar of [...a.bars, ...b.bars]) {
    assert.ok(bar.w <= 24 + 1e-9);
    near(bar.y + bar.h, c.zeroY);
  }
  near(b.bars[0].x - (a.bars[0].x + a.bars[0].w), 2);
  const neg = buildChart({ kind: 'bar', series: [{ name: 'n', points: [['a', -3], ['b', 6]] }] }, { width: 300 });
  const nb = neg.series[0].bars[0];
  assert.equal(nb.neg, true);
  near(nb.y, neg.zeroY, 1e-6);
  assert.ok(neg.yTicks.some((t0) => t0.v === 0));
});

test('藏掉一组：它不画、不进落点，纵轴只按剩下的算；颜色按原位置', () => {
  const c = buildChart(two('line'), { width: 400, hidden: new Set([0]) });
  assert.equal(c.series[0].hidden, true);
  assert.equal(c.series[0].path, '');
  assert.ok(c.slots.every((s) => s.items.every((i) => i.si === 1)));
  assert.equal(seriesColor(1), 'var(--cx-2)');
  assert.equal(seriesColor(9), 'var(--cx-2)');
});

test('数值横轴的折线按比例摆；时间横轴的刻度在范围内', () => {
  const c = buildChart({ kind: 'line', x: { type: 'number' }, series: [{ name: 'a', points: [[0, 1], [1, 2], [10, 3]] }] }, { width: 400 });
  const [p0, p1, p2] = c.series[0].dots;
  near((p1.x - p0.x) / (p2.x - p0.x), 0.1);
  assert.ok(c.xTicks.length >= 2);
  const t0 = Date.UTC(2024, 0, 1);
  const tc = buildChart({ kind: 'line', x: { type: 'time' }, series: [{ name: 'a', points: Array.from({ length: 30 }, (_, i) => [t0 + i * 86400e3, i]) }] }, { width: 500, locale: 'en-US' });
  assert.ok(tc.xTicks.length >= 2);
  for (const tk of tc.xTicks) assert.ok(tk.x >= tc.box.l - 1 && tk.x <= tc.box.l + tc.box.w + 1);
  assert.equal(tc.slots.length, 30);
});

test('窄图隔着标横轴；空数据不崩', () => {
  const pts = Array.from({ length: 60 }, (_, i) => ['第' + i + '天', i]);
  const c = buildChart({ kind: 'bar', series: [{ name: 'a', points: pts }] }, { width: 320 });
  assert.ok(c.xTicks.length < 60 && c.xTicks.length >= 2);
  const e = buildChart({ kind: 'line', series: [] }, { width: 300 });
  assert.equal(e.empty, true);
  assert.equal(e.slots.length, 0);
});

test('最近落点与提示框：右边放不下换左边，上下夹在图内', () => {
  const slots = [{ x: 10 }, { x: 50 }, { x: 90 }];
  assert.equal(nearestSlot(slots, 62), 1);
  assert.equal(nearestSlot([], 5), -1);
  assert.deepEqual(placeTip(10, 50, 80, 40, 300, 200), { x: 22, y: 30 });
  assert.deepEqual(placeTip(280, 50, 80, 40, 300, 200), { x: 188, y: 30 });
  assert.deepEqual(placeTip(50, 5, 80, 40, 100, 200), { x: 10, y: 0 });
});
