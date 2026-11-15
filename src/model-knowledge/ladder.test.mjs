// 子 agent 四档的判定线与取舍（ladder.mjs）：bridge 的 Claude 阶梯与 dimensio 的阶梯共用，口径钉在这里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultFloors, floorOf, cheapestCell, cheapestAltCell, strongestCell, pickAtFloor, nearestEffortCell, LADDER_FRACS, LADDER_TOP_SLACK, LADDER_TIER_KEYS,
} from './ladder.mjs';

const c = (name, ii, cost, effort = '', extra = {}) => ({ name, ii, cost, effort, ...extra });

test('默认线：top = 最高分 − 1.5，其余 = 最高分 × frac，一位小数往上取；候选为空全 0', () => {
  assert.deepEqual(LADDER_TIER_KEYS, ['top', 'hard', 'normal', 'light']);
  assert.deepEqual([LADDER_FRACS.hard, LADDER_FRACS.normal, LADDER_FRACS.light, LADDER_TOP_SLACK], [0.88, 0.6, 0.4, 1.5]);
  assert.deepEqual(defaultFloors([c('a', 58, 1), c('b', 25, 1)]), { top: 56.5, hard: 51.1, normal: 34.8, light: 23.2 });
  assert.deepEqual(defaultFloors([]), { top: 0, hard: 0, normal: 0, light: 0 });
  assert.equal(floorOf({ hard: 40 }, 'hard', 51.1), 40);
  assert.equal(floorOf({ hard: null }, 'hard', 51.1), 51.1);
  assert.equal(floorOf(null, 'top', 3), 3);
});

test('首选：够线的里成本最低、同价取更贴近线的；prefer 先挑、挑不出退回全部；够不着取最强（同分取便宜）并标 short', () => {
  const list = [c('strong', 60, 10), c('mid', 45, 2), c('tie-low', 41, 2), c('local', 50, 0, '', { local: true })];
  assert.equal(pickAtFloor(list, 40).pick.name, 'local');
  assert.equal(pickAtFloor(list, 40, { prefer: (x) => !x.local }).pick.name, 'tie-low', '同价 ¥2：取智力分低的');
  assert.equal(pickAtFloor([c('local', 50, 0, '', { local: true })], 40, { prefer: (x) => !x.local }).pick.name, 'local', '只有本机够得着');
  const short = pickAtFloor([c('a', 30, 5), c('b', 30, 3)], 70);
  assert.deepEqual([short.pick.name, short.short, short.ok.length], ['b', true, 0]);
  assert.deepEqual(pickAtFloor([], 10), { pick: null, short: false, ok: [] });
  assert.equal(cheapestCell([c('x', 40, 1), c('y', 45, 1)]).name, 'x');
  assert.equal(cheapestAltCell([c('x', 40, 1), c('y', 45, 1)]).name, 'y', '备选同价取更稳的');
  assert.equal(strongestCell([c('x', 40, 1), c('y', 40, 0.5)]).name, 'y');
});

test('档位自定义借格：同档直接用；没有就按最接近的官方档借分数与成本（不指定按 high，minimal 按 low），标 est', () => {
  const cells = [c('m', 50, 9, 'max'), c('m', 30, 1, 'medium'), c('m', 20, 0.5, 'low')];
  assert.equal(nearestEffortCell(cells, 'medium'), cells[1]);
  assert.deepEqual(nearestEffortCell(cells, 'high'), { ...cells[1], effort: 'high', est: true });
  assert.deepEqual(nearestEffortCell(cells, ''), { ...cells[1], effort: '', est: true });
  assert.deepEqual(nearestEffortCell(cells, 'minimal'), { ...cells[2], effort: 'minimal', est: true });
  assert.deepEqual(nearestEffortCell(cells, 'turbo'), { ...cells[0], effort: 'turbo', est: true }, '不是官方档：借最强的');
  assert.equal(nearestEffortCell([], 'high'), null);
});
