// 侧边工作区宽度规则：四个分页同一套（折叠屏展开 / 桌面 / 分屏窄格）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMin, dockMin, twoFits, dragBounds } from './sizing.js';

test('给对话留的宽度：medium 300、桌面 360', () => {
  assert.equal(chatMin(true), 300);
  assert.equal(chatMin(false), 360);
});

test('两列门槛按这一行扣掉 aside 算（Codex 线程列表开着要更宽才两列）', () => {
  assert.equal(twoFits(1020), true);
  assert.equal(twoFits(1019), false);
  assert.equal(twoFits(1280, 272), false);
  assert.equal(twoFits(1292, 272), true);
});

test('折叠屏展开 752 宽：一列 300 起，给对话留 300', () => {
  const b = dragBounds({ hostW: 752, mid: true, reserve: chatMin(true) });
  assert.deepEqual(b, { lo: 300, hi: 452 });
  assert.equal(dockMin(false, true), 300);
});

test('桌面两列：下限 560，上限给对话留 360', () => {
  assert.deepEqual(dragBounds({ hostW: 1400, two: true, reserve: 360 }), { lo: 560, hi: 1040 });
});

test('分屏窄格盖在正文上：只给正文露 48', () => {
  assert.deepEqual(dragBounds({ hostW: 600, overlay: true, reserve: 360 }), { lo: 360, hi: 552 });
});

test('放不下时上限不低于下限', () => {
  assert.deepEqual(dragBounds({ hostW: 500, mid: true, reserve: 300 }), { lo: 300, hi: 300 });
});
