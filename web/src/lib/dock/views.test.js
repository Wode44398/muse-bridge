// 工作区开关卡片的状态变换：单卡 / 多卡、收起后摆回、放大态、门禁收卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPatch, closeAllPatch, closeViewPatch, multiPatch, prunePatch } from './views.js';

const KEYS = ['term', 'review', 'browser', 'files'];
const opt = { known: (v) => KEYS.includes(v), fallback: 'review' };
const S = (o = {}) => ({ views: [], view: 'review', last: [], multi: false, max: '', ...o });
const apply = (s, p) => ({ ...s, ...(p || {}) });

test('单卡形态：开一张就是换成这一张', () => {
  const s = apply(S(), openPatch(S(), 'term', opt));
  assert.deepEqual(s.views, ['term']);
  assert.equal(s.view, 'term');
  assert.deepEqual(openPatch(s, 'files', opt).views, ['files']);
});

test('多卡形态：开一张是加一张；已经开着的不重复，回报 again', () => {
  let s = S({ multi: true });
  s = apply(s, openPatch(s, 'term', opt));
  s = apply(s, openPatch(s, 'browser', opt));
  assert.deepEqual(s.views, ['term', 'browser']);
  const p = openPatch(s, 'term', opt);
  assert.deepEqual(p.views, ['term', 'browser']);
  assert.equal(p.again, true);
  assert.equal(p.view, 'term');
});

test('不带参数 / 不认识的视图：收着时摆回上次那几张，没有记录就回落最近那张、再回落默认', () => {
  assert.deepEqual(openPatch(S(), undefined, opt).views, ['review']);
  assert.deepEqual(openPatch(S({ view: 'files' }), 'menu', opt).views, ['files']);
  assert.deepEqual(openPatch(S({ view: 'gone' }), '', opt).views, ['review']);
  const closed = S({ multi: true, last: ['term', 'browser'], view: 'term' });
  const p = openPatch(closed, undefined, opt);
  assert.deepEqual(p.views, ['term', 'browser']);
  assert.equal(p.view, 'term');
  // 单卡形态只摆回最近那张
  assert.deepEqual(openPatch({ ...closed, multi: false }, undefined, opt).views, ['term']);
  // 上次那几张里有的现在不给了（门禁）：只摆回还认识的
  assert.deepEqual(openPatch({ ...closed, last: ['gone', 'browser'], view: 'gone' }, undefined, opt).views, ['browser']);
  // 已经开着时不带参数：不动上次的记录，按最近那张处理
  assert.deepEqual(openPatch(S({ multi: true, views: ['files'], view: 'files', last: ['term'] }), undefined, opt).views, ['files']);
});

test('放大着别的卡时开另一张：放大态让出来；重开放大着的那张不动', () => {
  const s = S({ multi: true, views: ['term', 'browser'], view: 'term', max: 'term' });
  assert.equal(openPatch(s, 'browser', opt).max, '');
  assert.equal(openPatch(s, 'term', opt).max, 'term');
});

test('关一张：焦点落到剩下的最后一张；关到最后一张 = 整个收起并记下', () => {
  const s = S({ multi: true, views: ['term', 'browser', 'files'], view: 'files', max: 'files' });
  const p = closeViewPatch(s, 'files');
  assert.deepEqual(p.views, ['term', 'browser']);
  assert.equal(p.view, 'browser');
  assert.equal(p.max, '');
  assert.equal(closeViewPatch(s, 'review'), null);
  const one = S({ views: ['term'], view: 'term' });
  assert.deepEqual(closeViewPatch(one, 'term'), { views: [], max: '', last: ['term'] });
});

test('整个收起：记下开着的；本来就收着时不冲掉上次的记录', () => {
  assert.deepEqual(closeAllPatch(S({ views: ['term', 'files'] })).last, ['term', 'files']);
  assert.deepEqual(closeAllPatch(S({ last: ['browser'] })).last, ['browser']);
});

test('不许多卡了：只留最近那张；允许多卡时不动开着的', () => {
  const s = S({ multi: true, views: ['term', 'browser'], view: 'term', max: 'browser' });
  assert.deepEqual(multiPatch(s, false), { multi: false, views: ['term'], view: 'term', max: '' });
  assert.deepEqual(multiPatch(S(), true), { multi: true });
  assert.equal(multiPatch(S(), false), null);
});

test('门禁收卡：藏掉的卡跟着关；一张不剩回落第一张可用的', () => {
  const s = S({ multi: true, views: ['term', 'review'], view: 'term' });
  assert.deepEqual(prunePatch(s, ['review', 'files']), { views: ['review'], view: 'review', max: '' });
  assert.deepEqual(prunePatch(S({ views: ['term'], view: 'term' }), ['files', 'review']), { views: ['files'], view: 'files', max: '' });
  assert.equal(prunePatch(s, KEYS), null);
  assert.equal(prunePatch(S(), ['files']), null);
});
