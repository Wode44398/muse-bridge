import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFTS_KEY, SESSIONS_KEY, NEW_DRAFT, draftKeyOf, cleanAtts, loadDrafts, saveDrafts, putDraft,
  saveSessionsCache, loadSessionsCache, mergeReturned,
} from './persist.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}

test('草稿：只存文字与传完的附件，不存预览地址；空草稿即删除', () => {
  const st = fakeStorage();
  const map = loadDrafts(st);
  assert.equal(draftKeyOf(''), NEW_DRAFT);
  assert.equal(putDraft(map, 's1', '写到一半', [
    { path: 'C:/up/a.png', name: 'a.png', kind: 'image', url: 'blob:xyz', pending: false },
    { path: '', name: 'b.png', kind: 'image', url: 'blob:abc', pending: true },
  ], 100), true);
  assert.equal(putDraft(map, 's1', '写到一半', [{ path: 'C:/up/a.png', name: 'a.png', kind: 'image' }], 200), false, '内容没变不算改动');
  saveDrafts(map, st);
  const back = loadDrafts(st);
  assert.deepEqual(back.get('s1'), { text: '写到一半', atts: [{ path: 'C:/up/a.png', name: 'a.png', kind: 'image' }], at: 100 });
  assert.equal(JSON.stringify(st._m.get(DRAFTS_KEY)).includes('blob:'), false);

  assert.equal(putDraft(back, 's1', '', []), true);
  saveDrafts(back, st);
  assert.equal(st.getItem(DRAFTS_KEY), null, '全空时整项删掉');
  assert.deepEqual(cleanAtts(null), []);
});

test('草稿：超出上限按最近改动保留；坏数据不炸', () => {
  const st = fakeStorage();
  const map = new Map();
  for (let i = 0; i < 40; i++) putDraft(map, 's' + i, 't' + i, [], i + 1);
  saveDrafts(map, st);
  const back = loadDrafts(st);
  assert.equal(back.size, 30);
  assert.ok(back.has('s39') && !back.has('s0'));
  st.setItem(DRAFTS_KEY, '{oops');
  assert.equal(loadDrafts(st).size, 0);
  st.setItem(DRAFTS_KEY, JSON.stringify({ a: null, b: { text: 3 }, c: { text: 'ok' } }));
  assert.deepEqual([...loadDrafts(st).keys()], ['c']);
  assert.equal(loadDrafts(null).size, 0);
});

test('会话列表缓存：只留列表要用的字段，隐藏的不回放', () => {
  const st = fakeStorage();
  saveSessionsCache([
    { sessionId: 'a', title: 'A', cwd: 'C:/p', config: { model: 'x' }, updatedMs: 5 },
    { sessionId: 'b', title: 'B', hidden: true },
    { title: '没有 id' },
  ], st);
  const rows = loadSessionsCache(st);
  assert.deepEqual(rows, [{ sessionId: 'a', cwd: 'C:/p', title: 'A', updatedMs: 5 }]);
  st.setItem(SESSIONS_KEY, 'not json');
  assert.deepEqual(loadSessionsCache(st), []);
});

test('退回的排队消息并回输入框：文字用空行相接，附件按路径去重', () => {
  const out = mergeReturned('  已有的  ', [{ path: 'p1', name: '1' }], [
    { text: '第一条', atts: [{ path: 'p1', name: '1' }, { path: 'p2', name: '2', kind: 'image' }] },
    { text: '', atts: [] },
    { text: '第二条' },
  ]);
  assert.equal(out.text, '已有的\n\n第一条\n\n第二条');
  assert.deepEqual(out.atts.map((a) => a.path), ['p1', 'p2']);
  assert.deepEqual(mergeReturned('', [], []), { text: '', atts: [] });
});

test('cleanAtts 保留引用对话的 kind / quoteId / count', () => {
  const cleaned = cleanAtts([
    { path: 'C:/up/1795-chatref-s1--hello.md', name: 'hello', kind: 'chat', quoteId: 's1', count: 6, pending: false },
    { path: '', name: 'loading', kind: 'chat', quoteId: 's2', pending: true },
  ]);
  assert.deepEqual(cleaned, [
    { path: 'C:/up/1795-chatref-s1--hello.md', name: 'hello', kind: 'chat', quoteId: 's1', count: 6 },
  ]);
});
