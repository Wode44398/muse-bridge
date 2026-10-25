import test from 'node:test';
import assert from 'node:assert/strict';
import { descendantsOf, mergeOlder, pagerFrom, serverRestOf, highlightParts, normQuery, groupHits } from './sessionArchiveView.js';

const ids = (l) => l.map((s) => s.id);

test('descendantsOf：根认 parentId，中间一层顺着 spawnedBy 往上找；自己不算', () => {
  const list = [
    { id: 'root' },
    { id: 'a', parentId: 'root', spawnedBy: 'root' },
    { id: 'b', parentId: 'root', spawnedBy: 'a' },
    { id: 'c', parentId: 'root', spawnedBy: 'b' },
    { id: 'desk', parentId: 'root' },          // Desktop 子会话：只有顶层祖先
    { id: 'other' },
  ];
  assert.deepEqual(ids(descendantsOf(list, 'root')), ['a', 'b', 'c', 'desk']);
  assert.deepEqual(ids(descendantsOf(list, 'a')), ['b', 'c']);
  assert.deepEqual(ids(descendantsOf(list, 'c')), []);
  assert.deepEqual(ids(descendantsOf(list, 'other')), []);
  // 环不死循环
  assert.deepEqual(ids(descendantsOf([{ id: 'x', spawnedBy: 'y', parentId: 'y' }, { id: 'y', spawnedBy: 'x', parentId: 'x' }], 'z')), []);
});

test('descendantsOf：移到顶层的子会话（没有 parentId）不再算父会话的后代，它名下的孙会话也不算', () => {
  const list = [
    { id: 'p' },
    { id: 'kid', spawnedBy: 'p' },                          // 已移到顶层：服务端不给 parentId
    { id: 'grand', parentId: 'kid', spawnedBy: 'kid' },     // 改挂到 kid 下
    { id: 'kid2', parentId: 'p', spawnedBy: 'p' },
  ];
  assert.deepEqual(ids(descendantsOf(list, 'p')), ['kid2']);
  assert.deepEqual(ids(descendantsOf(list, 'kid')), ['grand']);
});

test('mergeOlder：老会话接在后面、去重；没有可并的返回原数组', () => {
  const list = [{ id: 'n1' }, { id: 'n2' }];
  assert.equal(mergeOlder(list, []), list);
  assert.equal(mergeOlder(list, [{ id: 'n2' }]), list);
  assert.deepEqual(ids(mergeOlder(list, [{ id: 'o1' }, { id: 'n1' }, { id: 'o2' }])), ['n1', 'n2', 'o1', 'o2']);
});

test('pagerFrom：游标从首页截断点起；翻过的段接得上就续，首页窗口往新挪出断档就从截断点重来', () => {
  assert.deepEqual(pagerFrom(null, 500), { hi: 500, lo: 500, done: false });
  assert.deepEqual(pagerFrom(null, 0), { hi: 0, lo: 0, done: true }, '首页就是全部');
  const p = { hi: 500, lo: 200, done: false };
  assert.equal(pagerFrom(p, 500), p, '接得上：从 lo 续翻');
  assert.equal(pagerFrom(p, 450), p, '首页窗口往旧挪（有会话归档 / 删掉）：仍接得上');
  assert.deepEqual(pagerFrom(p, 520), { hi: 520, lo: 520, done: false }, '新会话把 [500,520) 挤出首页：断档，从截断点重翻');
  // 收藏 / 一家子补进来的老行不影响游标（以前取「该项目最旧一行」做 before，会把截断点到老行之间整段跳过）
  assert.equal(pagerFrom(undefined, 500).lo, 500);
});

test('serverRestOf：剩余数 = 项目总数 − 已加载', () => {
  const list = [{ id: 'a', projectId: 'p', mtime: 300 }, { id: 'b', projectId: 'p', mtime: 100 }, { id: 'c', projectId: 'q', mtime: 50 }, { id: 'd', projectId: 'p' }];
  assert.equal(serverRestOf(list, { p: 10 }, 'p'), 7);
  assert.equal(serverRestOf(list, { p: 2 }, 'p'), 0);
  assert.equal(serverRestOf(list, {}, 'p'), 0);
});

test('highlightParts：整句优先，其次各个词；大小写不敏感，原文大小写保留', () => {
  const join = (parts) => parts.map((p) => (p.hit ? `[${p.s}]` : p.s)).join('');
  assert.equal(join(highlightParts('Bridge Worktree 选项', normQuery('worktree'))), 'Bridge [Worktree] 选项');
  assert.equal(join(highlightParts('侧栏归档和全文搜索，归档', normQuery('归档'))), '侧栏[归档]和全文搜索，[归档]');
  assert.equal(join(highlightParts('a worktree in the bridge', normQuery('bridge  worktree'))), 'a [worktree] in the [bridge]');
  assert.equal(join(highlightParts('nothing here', 'zz')), 'nothing here');
  assert.deepEqual(highlightParts('abc', ''), [{ s: 'abc' }]);
});

test('groupHits：分三层、每层前 5 条，展开的层全给；已归档另收一组；空层不出', () => {
  const mk = (n, match, extra = {}) => Array.from({ length: n }, (_, i) => ({ sessionId: match + i, match, ...extra }));
  const hits = [...mk(7, 'title'), ...mk(1, 'former'), ...mk(2, 'text'), ...mk(3, 'text', { archived: true })];
  const g = groupHits(hits);
  assert.deepEqual(g.layers.map((l) => [l.key, l.hits.length, l.hidden]), [['title', 5, 3], ['text', 2, 0]]);
  assert.equal(g.archived.length, 3);
  const g2 = groupHits(hits, { open: { title: true } });
  assert.deepEqual(g2.layers[0].hits.length, 8, '曾用名并在标题层');
  assert.equal(g2.layers[0].hidden, 0);
  assert.deepEqual(groupHits([{ sessionId: 'x', match: 'loose' }]).layers.map((l) => l.key), ['loose']);
  assert.deepEqual(groupHits([]), { layers: [], archived: [] });
});
