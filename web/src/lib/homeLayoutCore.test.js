import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_CAP, normalizeLayout, arrangeHome, moveKey, setHidden, moreBadge } from './homeLayoutCore.js';

const BUILTIN = ['claude', 'chatgpt', 'harness', 'studio'];
const apps = (n) => Array.from({ length: n }, (_, i) => 'app:p:a' + i);
const EMPTY = { order: [], hidden: [] };

test('上限是 8', () => { assert.equal(HOME_CAP, 8); });

test('没动过布局 = 默认顺序全摆', () => {
  const r = arrangeHome(BUILTIN, EMPTY);
  assert.deepEqual(r.ordered, BUILTIN);
  assert.deepEqual(r.visible, BUILTIN);
  assert.deepEqual(r.shown, BUILTIN);
  assert.deepEqual(r.overflow, []);
  assert.deepEqual(arrangeHome(BUILTIN, undefined).shown, BUILTIN);
});

test('用户顺序：认得的按它排在前，其余按默认顺序接后面', () => {
  const r = arrangeHome(BUILTIN, { order: ['studio', 'claude'], hidden: [] });
  assert.deepEqual(r.ordered, ['studio', 'claude', 'chatgpt', 'harness']);
});

test('新增的键接在最后、不插队；消失的键不报错也不占位', () => {
  const r = arrangeHome([...BUILTIN, 'app:x:new'], { order: ['app:gone:y', 'harness', 'claude', 'chatgpt', 'studio'], hidden: ['app:gone:y'] });
  assert.deepEqual(r.ordered, ['harness', 'claude', 'chatgpt', 'studio', 'app:x:new']);
  assert.ok(!r.shown.includes('app:gone:y'));
});

test('隐藏：ordered 里还在，visible / shown 里没有', () => {
  const r = arrangeHome(BUILTIN, { order: [], hidden: ['chatgpt'] });
  assert.deepEqual(r.ordered, BUILTIN);
  assert.deepEqual(r.visible, ['claude', 'harness', 'studio']);
  assert.deepEqual(r.shown, ['claude', 'harness', 'studio']);
});

test('恰好 8 个：全摆，没有「更多」', () => {
  const all = [...BUILTIN, ...apps(4)];
  const r = arrangeHome(all, EMPTY);
  assert.equal(r.shown.length, 8);
  assert.ok(!r.shown.includes('more'));
  assert.deepEqual(r.overflow, []);
});

test('9 个：前 7 个 + more，剩 2 个收进更多', () => {
  const all = [...BUILTIN, ...apps(5)];
  const r = arrangeHome(all, EMPTY);
  assert.equal(r.shown.length, 8);
  assert.deepEqual(r.shown.slice(0, 7), all.slice(0, 7));
  assert.equal(r.shown[7], 'more');
  assert.deepEqual(r.overflow, all.slice(7));
});

test('9 个里藏掉 1 个 = 恰好 8 个，「更多」消失', () => {
  const all = [...BUILTIN, ...apps(5)];
  const r = arrangeHome(all, { order: [], hidden: ['chatgpt'] });
  assert.equal(r.shown.length, 8);
  assert.ok(!r.shown.includes('more'));
});

test('自定 cap', () => {
  const r = arrangeHome(BUILTIN, EMPTY, 3);
  assert.deepEqual(r.shown, ['claude', 'chatgpt', 'more']);
  assert.deepEqual(r.overflow, ['harness', 'studio']);
});

test('moveKey：挪位并把 order 写成完整顺序', () => {
  const l = moveKey(EMPTY, BUILTIN, 'harness', -1);
  assert.deepEqual(l.order, ['claude', 'harness', 'chatgpt', 'studio']);
  assert.deepEqual(arrangeHome(BUILTIN, l).ordered, l.order);
  assert.deepEqual(moveKey(l, BUILTIN, 'claude', 2).order, ['harness', 'chatgpt', 'claude', 'studio']);
});

test('moveKey：两端夹紧', () => {
  assert.deepEqual(moveKey(EMPTY, BUILTIN, 'claude', -1).order, BUILTIN);
  assert.deepEqual(moveKey(EMPTY, BUILTIN, 'chatgpt', -99).order, ['chatgpt', 'claude', 'harness', 'studio']);
  assert.deepEqual(moveKey(EMPTY, BUILTIN, 'studio', 1).order, BUILTIN);
  assert.deepEqual(moveKey(EMPTY, BUILTIN, 'claude', 99).order, ['chatgpt', 'harness', 'studio', 'claude']);
});

test('moveKey：不认得的键原样返回；隐藏表保留；暂时不在的旧键留在最后', () => {
  const l0 = { order: ['app:off:z', 'studio'], hidden: ['chatgpt'] };
  assert.deepEqual(moveKey(l0, BUILTIN, 'nope', 1), normalizeLayout(l0));
  const l = moveKey(l0, BUILTIN, 'studio', 1);
  assert.deepEqual(l.order, ['claude', 'studio', 'chatgpt', 'harness', 'app:off:z']);
  assert.deepEqual(l.hidden, ['chatgpt']);
});

test('setHidden：藏、再显示，重复藏不重复记', () => {
  let l = setHidden(EMPTY, 'studio', true);
  l = setHidden(l, 'studio', true);
  assert.deepEqual(l.hidden, ['studio']);
  l = setHidden(l, 'studio', false);
  assert.deepEqual(l.hidden, []);
  assert.deepEqual(setHidden(EMPTY, 'more', true).hidden, []);
});

test('normalizeLayout：清洗脏数据', () => {
  assert.deepEqual(normalizeLayout(null), EMPTY);
  assert.deepEqual(normalizeLayout('x'), EMPTY);
  assert.deepEqual(normalizeLayout([1, 2]), EMPTY);
  assert.deepEqual(normalizeLayout({ order: 'claude', hidden: { a: 1 } }), EMPTY);
  assert.deepEqual(normalizeLayout({ order: ['claude', 3, null, '', 'claude', 'more', 'x'.repeat(500), 'studio'], hidden: [true, 'chatgpt', 'chatgpt'] }),
    { order: ['claude', 'studio'], hidden: ['chatgpt'] });
  const many = Array.from({ length: 100 }, (_, i) => 'k' + i);
  const n = normalizeLayout({ order: many, hidden: many });
  assert.equal(n.order.length, 64);
  assert.equal(n.hidden.length, 64);
  assert.deepEqual(n.order, many.slice(0, 64));
});

test('「更多」角标：数字相加、非数字给圆点、都没有就空', () => {
  assert.equal(moreBadge(['7', '5', '']), '12');
  assert.equal(moreBadge(['600', 500]), '999+', '加起来超过三位写成 999+');
  assert.equal(moreBadge(['7', '999+']), '999+', '认得服务端给的 999+');
  assert.equal(moreBadge(['新', '', null]), '•');
  assert.equal(moreBadge(['3', '新']), '3');
  assert.equal(moreBadge(['0', '', undefined]), '');
  assert.equal(moreBadge([]), '');
});
