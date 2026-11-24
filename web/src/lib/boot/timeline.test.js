import test from 'node:test';
import assert from 'node:assert/strict';
import { idlePlan, plan, planned, frameAt, sceneAt, camAt, holeAt, BREATH } from './timeline.js';

const phone = { W: 390, H: 844, u: 2.2, cx: 195, cy: 424.2 };
const far = (g) => Math.max(Math.hypot(g.cx, g.cy), Math.hypot(g.W - g.cx, g.cy), Math.hypot(g.cx, g.H - g.cy), Math.hypot(g.W - g.cx, g.H - g.cy));

test('没就绪：停在门心光点上，所有参数都是有限数（NaN 会一路传进着色器）', () => {
  const T = idlePlan();
  assert.equal(planned(T), false);
  for (const t of [0, 80, 150, 500, 1400]) {
    const { g, cam } = frameAt(t, T, { cx: phone.cx, cy: phone.cy, u: phone.u, dark: false });
    for (const [k, v] of Object.entries({ ...g, ...cam })) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} @${t} = ${v}`);
    assert.equal(g.hole, 0, '门还没开');
  }
});

test('就绪后立刻开门不空等整拍呼吸；就绪得早就是 150ms', () => {
  assert.equal(plan(0, phone).i0, 150);
  assert.equal(plan(150, phone).i0, 150);
  assert.equal(plan(151, phone).i0, 151);
  assert.equal(plan(620, phone).i0, 620);
  assert.ok(BREATH > 0);
});

test('门出画那一刻：门洞盖住最远的屏幕角，洞里的景正好停稳', () => {
  for (const g of [phone, { W: 1280, H: 800, u: 1.7, cx: 640, cy: 401.7 }, { W: 1920, H: 1080, u: 1.7, cx: 960, cy: 541.7 }]) {
    const T = plan(0, g);
    assert.ok(T.exit > T.p0 && T.exit < T.p1, `exit ${T.exit} 在推镜中段`);
    assert.ok(holeAt(T.exit, T, g.u) >= far(g), '门洞盖住全屏');
    assert.ok(holeAt(T.exit - 1, T, g.u) < far(g) + 6, '再早一毫秒还没盖住');
    assert.equal(sceneAt(T.exit, T), 1, '洞里的景停稳（和主页壁纸一样）');
    assert.ok(camAt(T.exit, T) < 0.93, '门这台相机还没穿过（门在镜头前冲出画面）');
    const { g: f } = frameAt(T.exit, T, { cx: g.cx, cy: g.cy, u: g.u, dark: false });
    assert.equal(f.lod, 0); assert.equal(f.expo, 1); assert.equal(f.warm, 0);
  }
});

test('开门后单调顺滑推镜，无回退悬浮', () => {
  const T = plan(0, phone);
  assert.ok(T.exit < 500, `手机门出画应在 500ms 内，实际 ${T.exit}`);
  let prev = 0;
  for (let t = T.p0; t <= T.p1; t += 10) {
    const e = camAt(t, T);
    assert.ok(e >= prev, `t=${t} 不应回退: ${e} < ${prev}`);
    prev = e;
  }
  assert.equal(camAt(T.p1, T), 1);
});
