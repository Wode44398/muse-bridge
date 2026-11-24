import test from 'node:test';
import assert from 'node:assert/strict';
import { Ink, EXIT_MS, clean, roundPoly } from './engine.js';

// 只要能往里 append 的假 SVG：引擎只用到 createElementNS / setAttribute / append / style / remove
function fakeSvg() {
  const mk = () => ({ attrs: {}, style: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    append(...k) { this.kids.push(...k); }, remove() { this.removed = true; } });
  const svg = mk();
  svg.ownerDocument = { createElementNS: () => mk() };
  return svg;
}
const line = (key, y1, x1, x2) => ({ key, bid: 1, y1, h: 20, x1, x2 });
const settle = (ink, ms = 600) => { for (let t = 0; t < ms; t += 16) ink.step(16); };

test('拖选：新的一行从起点那一侧长出来，跟到目标', () => {
  const ink = new Ink(fakeSvg(), { mode: 'drag', ox: 50, oy: 10 });
  ink.set([line('1:0', 0, 40, 300)]);
  const L = ink.lines.get('1:0');
  assert.equal(L.x1, L.x2);          // 起点处收成一条缝
  settle(ink);
  assert.equal(L.x1, 40);
  assert.equal(L.x2, 300);
});

test('退场：负的时间差（rAF 时间戳早于开始那一刻）不会让墨留下', () => {
  const ink = new Ink(fakeSvg(), { mode: 'drag', ox: 0, oy: 10 });
  ink.set([line('1:0', 0, 0, 100)]);
  settle(ink);
  ink.exit();
  ink.step(-25);
  assert.equal(ink.exiting, true);
  for (let t = 0; t <= EXIT_MS + 16; t += 16) ink.step(16);
  assert.equal(ink.dead, true);
});

test('收缩的行朝起点方向收回后删掉', () => {
  const ink = new Ink(fakeSvg(), { mode: 'drag', ox: 0, oy: 10 });
  ink.set([line('1:0', 0, 0, 400), line('1:1', 20, 0, 200)]);
  settle(ink);
  ink.set([line('1:0', 0, 0, 250)]);
  settle(ink);
  assert.equal(ink.lines.has('1:1'), false);
  assert.equal(ink.lines.get('1:0').x2, 250);
});

test('同一段相邻两行连成一块：一条闭合路径', () => {
  const ink = new Ink(fakeSvg(), { mode: 'drag', ox: 100, oy: 10 });
  ink.set([line('1:0', 0, 100, 400), line('1:1', 20, 0, 200)]);
  settle(ink);
  const d = ink.path();
  assert.equal((d.match(/Z/g) || []).length, 1);
});

test('横向不重叠的两行各成一块', () => {
  const ink = new Ink(fakeSvg(), { mode: 'drag', ox: 300, oy: 10 });
  ink.set([line('1:0', 0, 300, 400), line('1:1', 20, 0, 200)]);
  settle(ink);
  assert.equal((ink.path().match(/Z/g) || []).length, 2);
});

test('clean 去掉重合点与共线点', () => {
  const pts = clean([{ x: 0, y: 0, r: 6 }, { x: 10, y: 0, r: 6 }, { x: 20, y: 0, r: 6 }, { x: 20, y: 10, r: 6 }, { x: 20, y: 10, r: 6 }, { x: 0, y: 10, r: 6 }]);
  assert.equal(pts.length, 4);
});

test('倒角半径不超过相邻边的一半', () => {
  // 4×40 的窄条：半径 6 只能用到 2
  const d = roundPoly([{ x: 0, y: 0, r: 6 }, { x: 4, y: 0, r: 6 }, { x: 4, y: 40, r: 6 }, { x: 0, y: 40, r: 6 }]);
  const nums = d.match(/-?[\d.]+/g).map(Number);
  assert.ok(nums.every((n) => n >= -0.01 && n <= 40.01));
  assert.ok(d.startsWith('M0 2C'));   // 第一个角朝上一个点（0,40）退 2，而不是 6
});
