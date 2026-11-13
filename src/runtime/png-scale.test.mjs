import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng, scalePng } from './png-scale.mjs';

function image(width, height, channels, fn) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = fn(x, y);
    for (let c = 0; c < channels; c++) data[(y * width + x) * channels + c] = px[c];
  }
  return { width, height, channels, data };
}

test('编解码往返：RGBA / RGB 原样', () => {
  for (const ch of [4, 3]) {
    const img = image(37, 11, ch, (x, y) => [x * 7 & 255, y * 23 & 255, (x ^ y) & 255, 200]);
    const back = decodePng(encodePng(img));
    assert.equal(back.width, 37); assert.equal(back.height, 11); assert.equal(back.channels, ch);
    assert.deepEqual([...back.data], [...img.data]);
  }
});

test('缩小：尺寸按比例、面积平均（左红右蓝的 2×1 块缩成 1 像素取平均）', () => {
  const img = image(300, 200, 4, (x) => (x % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]));
  const out = decodePng(scalePng(encodePng(img), 150));
  assert.equal(out.width, 150); assert.equal(out.height, 100);
  const p = out.data.subarray(0, 4);
  assert.ok(Math.abs(p[0] - 128) <= 1 && Math.abs(p[2] - 128) <= 1, `应为紫色，实得 ${[...p]}`);
});

test('非整数比例与只缩不放', () => {
  const buf = encodePng(image(2067, 1213, 4, (x, y) => [x & 255, y & 255, 0, 255]));
  const out = decodePng(scalePng(buf, 1378));
  assert.equal(out.width, 1378); assert.equal(out.height, Math.round(1213 * 1378 / 2067));
  assert.equal(scalePng(buf, 3000), buf, '目标更大就原样返回');
});

test('不是 PNG 就报错', () => {
  assert.throws(() => decodePng(Buffer.from('nope')), /不是 PNG/);
});
