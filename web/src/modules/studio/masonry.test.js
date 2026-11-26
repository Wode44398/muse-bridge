import test from 'node:test';
import assert from 'node:assert/strict';
import { wallCols, wallGap, clampRatio, ratioOf, ratioFromParams, masonry, RATIO_GUESS } from './masonry.js';

test('列数：手机 2 列，墙宽 ≥700 三列、≥1180 四列', () => {
  assert.equal(wallCols(1600, true), 2);
  assert.equal(wallCols(699, false), 2);
  assert.equal(wallCols(700, false), 3);
  assert.equal(wallCols(1179, false), 3);
  assert.equal(wallCols(1180, false), 4);
  assert.equal(wallGap(true), 6);
  assert.equal(wallGap(false), 10);
});

test('比例夹在 0.56–1.78，认不出按 4:3', () => {
  assert.equal(clampRatio(0.2), 0.56);
  assert.equal(clampRatio(3), 1.78);
  assert.equal(clampRatio(1), 1);
  assert.equal(clampRatio(NaN), RATIO_GUESS);
  assert.equal(clampRatio(0), RATIO_GUESS);
  assert.equal(clampRatio(undefined), RATIO_GUESS);
  assert.equal(ratioOf(1600, 900), 900 / 1600);
  assert.equal(ratioOf(0, 900), null);
});

test('发出时的比例参数 → 高 / 宽', () => {
  assert.equal(ratioFromParams({ aspectRatio: '16:9', imageSize: '2K' }), 9 / 16);
  assert.equal(ratioFromParams({ size: '1024x1536', quality: 'high' }), 1.5);
  assert.equal(ratioFromParams({ size: { width: 1280, height: 720 } }), 0.5625);
  // 比例值优先于尺寸
  assert.equal(ratioFromParams({ size: '1024x1024', ratio: '3:4' }), 4 / 3);
  assert.equal(ratioFromParams({ aspectRatio: '自动' }), null);
  assert.equal(ratioFromParams(null), null);
  assert.equal(ratioFromParams({ duration: 8, resolution: '1080p' }), null);
});

test('瀑布格：往最矮的一列放，等高取靠左', () => {
  const { boxes, height, colW } = masonry([1, 0.5, 1, 1], { width: 210, cols: 2, gap: 10 });
  assert.equal(colW, 100);
  assert.deepEqual(boxes.map((b) => [b.x, b.y, b.w, b.h, b.col]), [
    [0, 0, 100, 100, 0],
    [110, 0, 100, 56, 1],      // 0.5 被夹成 0.56
    [110, 66, 100, 100, 1],    // 右列更矮
    [0, 110, 100, 100, 0],
  ]);
  assert.equal(height, 210);
});

test('瀑布格：空列表高 0；一列铺满宽', () => {
  assert.equal(masonry([], { width: 300, cols: 3, gap: 6 }).height, 0);
  const one = masonry([0.75], { width: 300, cols: 1, gap: 6 });
  assert.deepEqual(one.boxes[0], { x: 0, y: 0, w: 300, h: 225, col: 0 });
});

test('瀑布格：差不到半像素算一样高（新的一件不左右乱跳）', () => {
  const { boxes } = masonry([1, 1.003, 1], { width: 1000, cols: 2, gap: 0 });
  assert.equal(boxes[2].col, 0);
});
