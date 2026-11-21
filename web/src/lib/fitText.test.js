import test from 'node:test';
import assert from 'node:assert/strict';
import { fitFontSize } from './fitText.js';

test('放得下就用上限字号', () => {
  assert.equal(fitFontSize({ max: 22, avail: 133, natural: 120 }), 22);
  assert.equal(fitFontSize({ max: 22, avail: 133, natural: 133 }), 22);
});

test('放不下按比例缩，留余量后排出来不超过可用宽度', () => {
  // 一排四张卡：内宽 133，「¥12,000.00」在 24.5px 下量得 142（原先按字符估宽没缩到位的那种）
  const px = fitFontSize({ max: 24.5, avail: 133, natural: 142 });
  assert.ok(px < 24.5);
  assert.ok((142 * px) / 24.5 <= 133, '缩完一行放得下');
  assert.equal(px * 2, Math.floor(px * 2), '取到 0.5px');
});

test('最小字号兜底；上限比最小还小时不放大', () => {
  assert.equal(fitFontSize({ max: 26, min: 15, avail: 133, natural: 900 }), 15);
  assert.equal(fitFontSize({ max: 12, min: 15, avail: 50, natural: 900 }), 12);
});

test('量不出来（宽度 0、还没排版）就不动', () => {
  assert.equal(fitFontSize({ max: 26, avail: 0, natural: 300 }), 26);
  assert.equal(fitFontSize({ max: 26, avail: 133, natural: 0 }), 26);
});
