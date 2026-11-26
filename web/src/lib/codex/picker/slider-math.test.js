import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HALF, xOf, pOf, stopXs, fillRight, rubber, clampRubber, nearestStop, liveIndex,
  springStep, settled, velocity, dotSwell,
} from './slider-math.js';

test('几何：滑块中心贴着轨道内沿，两端各留 13px', () => {
  assert.equal(xOf(0, 300), HALF);
  assert.equal(xOf(1, 300), 300 - HALF);
  assert.equal(pOf(xOf(0.4, 300), 300).toFixed(6), '0.400000');
  assert.deepEqual(stopXs(3, 226), [13, 113, 213]);
  assert.deepEqual(stopXs(1, 200), [13]);
});

test('填充：最低档藏起来、最高档铺满、中间右沿落在滑块中心', () => {
  assert.equal(fillRight(0, 4, 300), 0);
  assert.equal(fillRight(1, 4, 300), 300);
  // 第一档以后右沿 = 滑块中心
  const p = 1 / 3;
  assert.ok(Math.abs(fillRight(p, 4, 300) - xOf(p, 300)) < 1e-9);
  // 单调不减
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const r = fillRight(i / 100, 4, 300);
    assert.ok(r >= prev - 1e-9);
    prev = r;
  }
});

test('橡皮筋：越拉越紧、有上限、界内原样', () => {
  assert.equal(rubber(0), 0);
  assert.equal(rubber(-5), 0);
  assert.ok(rubber(10) < 10);
  assert.ok(rubber(40) > rubber(10));
  assert.ok(rubber(1e6, 18) < 18);
  assert.equal(clampRubber(50, 13, 200), 50);
  assert.ok(clampRubber(-30, 13, 200) < 13 && clampRubber(-30, 13, 200) > 13 - 18);
  assert.ok(clampRubber(260, 13, 200) > 200 && clampRubber(260, 13, 200) < 218);
});

test('吸附：慢放落最近的，甩一下跨到下一档，投射不越界', () => {
  const stops = [13, 113, 213];
  assert.equal(nearestStop(120, 0, stops), 1);
  assert.equal(nearestStop(150, 0, stops), 1);
  assert.equal(nearestStop(150, 900, stops), 2);      // 150 + 90 = 240 → 213
  assert.equal(nearestStop(80, -500, stops), 0);      // 80 - 50 = 30 → 13
  assert.equal(nearestStop(205, 5000, stops), 2);
  assert.equal(nearestStop(10, 0, []), -1);
});

test('拖动中的档：过中点还要再多一点才换，抖动不来回跳', () => {
  const stops = [0, 100, 200];
  assert.equal(liveIndex(40, stops, -1), 0);
  assert.equal(liveIndex(55, stops, 0), 0);           // 过了中点 5px，不到 12px
  assert.equal(liveIndex(63, stops, 0), 1);
  assert.equal(liveIndex(45, stops, 1), 1);           // 往回也一样
  assert.equal(liveIndex(37, stops, 1), 0);
  assert.equal(liveIndex(190, stops, 0), 2);          // 一下跳过两档也认
});

test('弹簧：带初速度能收敛到目标，回弹很轻', () => {
  let s = { x: 0, v: 0 };
  let max = 0;
  for (let i = 0; i < 120; i++) {
    s = springStep(s, 100, undefined, 1 / 60);
    max = Math.max(max, s.x);
  }
  assert.ok(settled(s, 100));
  assert.ok(max > 100 && max < 106, 'overshoot ' + max);
  // 迎着目标反向甩出去的初速度：先被带走一段，再回来
  let r = { x: 100, v: -1500 };
  r = springStep(r, 100, undefined, 1 / 60);
  assert.ok(r.x < 100);
  for (let i = 0; i < 180; i++) r = springStep(r, 100, undefined, 1 / 60);
  assert.ok(settled(r, 100));
  // 掉帧（一帧 200ms）时也不发散
  const big = springStep({ x: 0, v: 0 }, 100, undefined, 0.2);
  assert.ok(Number.isFinite(big.x) && Math.abs(big.x) < 200);
});

test('松手速度：取最近一段，停住再松 = 0', () => {
  const s = [{ t: 0, x: 0 }, { t: 16, x: 10 }, { t: 32, x: 20 }, { t: 48, x: 30 }];
  assert.equal(Math.round(velocity(s, 50)), 625);
  assert.equal(velocity(s, 200), 0);
  assert.equal(velocity([{ t: 0, x: 0 }], 2), 0);
  // 只看最近 80ms
  const long = [{ t: 0, x: 0 }, { t: 100, x: 0 }, { t: 140, x: 40 }, { t: 180, x: 80 }];
  assert.equal(Math.round(velocity(long, 182)), 1000);
});

test('档点鼓起：贴近时大、远了回 1', () => {
  assert.equal(dotSwell(0), 1.6);
  assert.equal(dotSwell(100), 1);
  assert.ok(dotSwell(20) > 1 && dotSwell(20) < 1.6);
});
