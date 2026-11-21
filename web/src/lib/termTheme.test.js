import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendedAnsi, termTheme } from './termTheme.js';

test('256 色 16–255 段与 xterm 默认一致，浅色模式只倒灰阶', () => {
  const d = extendedAnsi(false), l = extendedAnsi(true);
  assert.equal(d.length, 240);
  assert.equal(d[0], '#000000');            // 16
  assert.equal(d[196 - 16], '#ff0000');     // 196
  assert.equal(d[232 - 16], '#080808');     // 232：最深的灰
  assert.equal(d[255 - 16], '#eeeeee');
  assert.deepEqual(l.slice(0, 216), d.slice(0, 216));
  assert.equal(l[232 - 16], '#eeeeee');
  assert.equal(l[235 - 16], '#d0d0d0');     // 深灰垫底 → 浅灰
});

test('浅色开最低对比度，深色不动；底色取所在元素的 --bg', () => {
  const vars = (n) => ({ '--bg': '#ffffff', '--text': '#121212' })[n] || '';
  const l = termTheme(false, vars), d = termTheme(true, () => '');
  assert.equal(l.minimumContrastRatio, 4.5);
  assert.equal(d.minimumContrastRatio, 1);
  assert.equal(l.theme.background, '#ffffff');
  assert.equal(l.theme.cursorAccent, '#ffffff');
  assert.equal(d.theme.background, '#262624');
});
