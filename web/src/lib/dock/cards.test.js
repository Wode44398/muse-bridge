// 工作区卡片的排布：两列顺序的修复、拖动预览、按比例的格子、卡间缝调高度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { columns, dividers, emptyColCss, normCols, normWeights, place, resizePair, slots, target } from './cards.js';

const KEYS = ['tasks', 'review', 'term', 'browser', 'files', 'memory'];
const colOf = (k) => (['term', 'review', 'tasks'].includes(k) ? 'a' : 'b');
const DEFAULT = { a: ['term', 'review', 'tasks'], b: ['browser', 'files', 'memory'] };

test('存坏的列顺序：去重、去掉不认识的、缺的按默认列补在末尾', () => {
  assert.deepEqual(normCols(DEFAULT, KEYS, colOf), DEFAULT);
  assert.deepEqual(normCols(null, KEYS, colOf), { a: ['tasks', 'review', 'term'], b: ['browser', 'files', 'memory'] });
  assert.deepEqual(normCols({ a: ['browser', 'browser', 'nope', 'term'], b: ['term', 'files'] }, KEYS, colOf), {
    a: ['browser', 'term', 'tasks', 'review'],
    b: ['files', 'memory'],
  });
  assert.deepEqual(normWeights({ review: 99, term: -1, x: 2, files: '1' }, KEYS), { review: 8, term: 0.15 });
});

test('宿主多了一张新工具：已存的顺序不动，新的按它的默认列补在末尾', () => {
  const saved = { a: ['review', 'term'], b: ['files', 'browser'] };
  assert.deepEqual(normCols(saved, ['term', 'review', 'browser', 'files', 'notes'], (k) => (k === 'notes' ? 'a' : 'b')), {
    a: ['review', 'term', 'notes'],
    b: ['files', 'browser'],
  });
});

test('插进某列：按看得见的卡数位置，没开的卡留在原处', () => {
  const shown = ['term', 'tasks', 'browser'];
  assert.deepEqual(place(DEFAULT, 'browser', 'a', 1, shown), { a: ['term', 'review', 'browser', 'tasks'], b: ['files', 'memory'] });
  assert.deepEqual(place(DEFAULT, 'browser', 'a', 9, shown), { a: ['term', 'review', 'tasks', 'browser'], b: ['files', 'memory'] });
});

test('拖动预览：两列按左右半定列；一列时进右侧三成才拆两列，拆开后退回门槛放宽到一半', () => {
  const shown = ['term', 'review', 'browser'];
  const two = { start: DEFAULT, v: 'browser', n0: 2, split: false, canTwo: true, shown };
  const left = target(two, 0.2, 0.9);
  assert.equal(left.n, 2);
  assert.deepEqual(left.cols.a.filter((k) => shown.includes(k)), ['term', 'review', 'browser'], '拖到左列最下');
  const emptied = columns(left.cols, shown, true);
  assert.deepEqual(emptied[1], [], '右列拖空了：留作落点');
  assert.match(emptyColCss(emptied), /^left:calc\(\(100% - 8px\) \* 0\.500000 \+ 8px\);width:calc\(\(100% - 8px\) \* 0\.500000\);top:0;height:100%$/);
  assert.equal(emptyColCss(columns(DEFAULT, shown, true)), '');

  const one = { start: DEFAULT, v: 'term', n0: 1, split: false, canTwo: true, shown };
  assert.equal(target(one, 0.6, 0.5).split, false, '右侧三成之外不拆');
  const split = target(one, 0.8, 0.5);
  assert.equal(split.split, true);
  assert.deepEqual(columns(split.cols, shown, true), [['review', 'browser'], ['term']], '拆开：它单独占右列');
  assert.equal(target({ ...one, split: true }, 0.55, 0.5).split, true, '已拆开：退到一半以内才合回');
  assert.equal(target({ ...one, canTwo: false }, 0.9, 0.5).split, false, '放不下两列：不拆');
  assert.equal(target(one, 0.9, 0.5, false).split, false, '还没停够：不拆');
});

test('格子按比例：列宽均分，高度按权重分，缝 8px；卡间缝落在上一张的下沿', () => {
  const list = [['term', 'review'], ['browser']];
  const at = slots(list, { term: 3, review: 1 });
  assert.equal(at.term.col, 0);
  assert.equal(at.browser.col, 1);
  assert.match(at.term.height, /\* 0\.750000\)/);
  assert.match(at.review.top, /\* 0\.750000 \+ 8px\)/);
  assert.match(at.browser.left, /\* 0\.500000 \+ 8px\)/);
  const seams = dividers(list, at);
  assert.deepEqual(seams.map((d) => d.key), ['term|review']);
  assert.match(seams[0].css, /top:calc\(calc\(.*\) - 8px\);height:8px/);
});

test('等分时的格子与从前按格数均分的写法落在同一处', () => {
  // 三张叠一列：第二张从 1/3 处起、占 1/3
  const at = slots([['a', 'b', 'c']], {});
  assert.equal(at.b.top, 'calc((100% - 16px) * 0.333333 + 8px)');
  assert.equal(at.b.height, 'calc((100% - 16px) * 0.333333)');
  assert.equal(at.a.left, 'calc((100% - 0px) * 0.000000 + 0px)');
  assert.equal(at.a.width, 'calc((100% - 0px) * 1.000000)');
});

test('拖卡间缝：两张的权重和不变，各自不低于最小高度', () => {
  const [u, d] = resizePair(1, 1, 2, 400, 100, 120);
  assert.ok(Math.abs(u + d - 2) < 1e-9);
  assert.ok(Math.abs((u / 2) * 400 - 280) < 1e-9, '钳在 400 - 120');
  const [u2] = resizePair(1, 1, 2, 400, -50, 120);
  assert.ok(Math.abs((u2 / 2) * 400 - 150) < 1e-9);
  const [u3, d3] = resizePair(1, 1, 2, 160, 500, 120);
  assert.ok(Math.abs((u3 / 2) * 160 - 80) < 1e-9 && Math.abs((d3 / 2) * 160 - 80) < 1e-9);
});
