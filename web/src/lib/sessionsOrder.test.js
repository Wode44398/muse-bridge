import test from 'node:test';
import assert from 'node:assert/strict';
import { placeTouched, sortByMtime } from './sessionsOrder.js';

const mk = (id, mtime) => ({ id, mtime, title: id });
const ids = (l) => l.map((s) => s.id);

test('placeTouched: a touch whose mtime did not grow leaves the list untouched (same reference)', () => {
  const list = [mk('a', 300), mk('b', 200), mk('c', 100)];
  assert.equal(placeTouched(list, 'c', 100), list);   // same mtime
  assert.equal(placeTouched(list, 'c', 50), list);    // older mtime (stale / replayed event)
  assert.equal(placeTouched(list, 'b', 200), list);
});

test('placeTouched: a real write moves the row to its mtime position, not blindly to the top', () => {
  const list = [mk('a', 300), mk('b', 200), mk('c', 100)];
  assert.deepEqual(ids(placeTouched(list, 'c', 250)), ['a', 'c', 'b']);   // between a and b
  assert.deepEqual(ids(placeTouched(list, 'c', 400)), ['c', 'a', 'b']);   // newest → top
  assert.deepEqual(ids(placeTouched(list, 'a', 350)), ['a', 'b', 'c']);   // already top, stays
  assert.equal(placeTouched(list, 'c', 400)[0].mtime, 400);
});

test('placeTouched: the 09-13 scramble — old sessions touched with old mtimes stay put', () => {
  // server order (agent trading group): 2a9a(11:29) > 5270(04:23) > c51f(03:06) > 5a98 > b322
  const list = [mk('2a9a', 5), mk('5270', 4), mk('c51f', 3), mk('5a98', 2), mk('b322', 1)];
  let l = placeTouched(list, 'c51f', 3);   // spurious touch, same mtime
  l = placeTouched(l, '2a9a', 5);
  l = placeTouched(l, 'b322', 1);
  assert.deepEqual(ids(l), ['2a9a', '5270', 'c51f', '5a98', 'b322']);
});

test('placeTouched: unknown id → null (caller does a full refresh)', () => {
  assert.equal(placeTouched([mk('a', 1)], 'zzz', 9), null);
});

test('placeTouched: missing mtimes are treated as 0 and never crash', () => {
  const list = [{ id: 'a' }, mk('b', 10)];
  assert.deepEqual(ids(placeTouched(list, 'a', 20)), ['a', 'b']);
  assert.deepEqual(ids(placeTouched(list, 'a', 5)), ['b', 'a']);
});

test('sortByMtime: stable descending; sorted input returns the same reference', () => {
  const sorted = [mk('a', 3), mk('b', 2), mk('c', 1)];
  assert.equal(sortByMtime(sorted), sorted);
  const messy = [mk('c', 1), mk('a', 3), mk('b2', 2), mk('b1', 2)];
  assert.deepEqual(ids(sortByMtime(messy)), ['a', 'b2', 'b1', 'c']);   // equal mtimes keep input order
});
