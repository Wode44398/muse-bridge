import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProjectOrder, moveId, splitDropPlan, splitDropLabel, canSplitWidth, dockOverlayFor } from './claudeSplit.js';

const P = (id) => ({ id, name: id });
const ids = (l) => l.map((p) => p.id);

test('applyProjectOrder: no order = server order untouched', () => {
  const list = [P('def'), P('a'), P('b')];
  assert.deepEqual(ids(applyProjectOrder(list, [])), ['def', 'a', 'b']);
  assert.deepEqual(ids(applyProjectOrder(list, null)), ['def', 'a', 'b']);
});

test('applyProjectOrder: ranked ids follow the order, unranked (new) ones go first, stale ids ignored', () => {
  const list = [P('def'), P('new'), P('a'), P('b')];
  assert.deepEqual(ids(applyProjectOrder(list, ['b', 'gone', 'def', 'a'])), ['new', 'b', 'def', 'a']);
});

test('moveId: insert-before semantics on the pre-move list; no-op returns null', () => {
  const l = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveId(l, 'a', 3), ['b', 'c', 'a', 'd']);   // before d
  assert.deepEqual(moveId(l, 'a', 4), ['b', 'c', 'd', 'a']);   // to end
  assert.deepEqual(moveId(l, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveId(l, 'c', 1), ['a', 'c', 'b', 'd']);
  assert.equal(moveId(l, 'b', 1), null);                         // before itself
  assert.equal(moveId(l, 'b', 2), null);                         // right after itself
  assert.equal(moveId(l, 'x', 0), null);
});

test('splitDropPlan: not split', () => {
  const base = { split: false, paneSide: 'right', paneId: null, mainId: 'm', blank: false };
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'x', side: 'left' }), { kind: 'split', side: 'left' });
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'm', side: 'right' }), { kind: 'none' });
  assert.deepEqual(splitDropPlan({ ...base, blank: true, mainId: null, draggedId: 'x', side: 'right' }), { kind: 'open' });
});

test('splitDropPlan: split — replace / swap / none by which pane sits on that side', () => {
  const base = { split: true, paneSide: 'right', mainId: 'm', paneId: 'p', blank: false };
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'x', side: 'right' }), { kind: 'replace', target: 'pane', side: 'right' });
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'x', side: 'left' }), { kind: 'replace', target: 'main', side: 'left' });
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'p', side: 'right' }), { kind: 'none' });
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'p', side: 'left' }), { kind: 'swap' });
  assert.deepEqual(splitDropPlan({ ...base, draggedId: 'm', side: 'right' }), { kind: 'swap' });
  assert.deepEqual(splitDropPlan({ ...base, paneSide: 'left', draggedId: 'x', side: 'left' }), { kind: 'replace', target: 'pane', side: 'left' });
});

test('labels and width gates', () => {
  assert.equal(splitDropLabel({ kind: 'split', side: 'left' }), '在左边分屏打开');
  assert.equal(splitDropLabel({ kind: 'replace', target: 'pane', side: 'right' }), '在右格打开');
  assert.equal(splitDropLabel({ kind: 'swap' }), '左右对调');
  assert.equal(canSplitWidth(759), false);
  assert.equal(canSplitWidth(760), true);
  assert.equal(dockOverlayFor(999), true);
  assert.equal(dockOverlayFor(1000), false);
});
