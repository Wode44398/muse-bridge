// 侧栏会话管理的纯逻辑：收藏组单列且不在文件夹组里重复、正文搜索的高亮切段与请求门槛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSessionsByProjectAndTime } from './session-groups.js';
import { highlightParts, contentHitsOf, contentQueryOf } from './content-search.js';

test('收藏的会话单独成组、不在文件夹组里重复；隐藏的不出；搜索时同样按标题过滤', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const sessions = [
    { sessionId: 'a', title: '收藏的那个', cwd: 'E:\\proj', updatedMs: now - 1000, favorite: true },
    { sessionId: 'b', title: '普通的', cwd: 'E:\\proj', updatedMs: now - 2000 },
    { sessionId: 'c', title: '隐藏又收藏', cwd: 'E:\\proj', updatedMs: now - 3000, favorite: true, hidden: true },
  ];
  const g = groupSessionsByProjectAndTime(sessions, [], '', now);
  assert.deepEqual(g.favorites.map((s) => s.sessionId), ['a']);
  const inGroups = g.byProject.flatMap((p) => p.timeGroups.flatMap((tg) => tg.items.map((s) => s.sessionId)));
  assert.deepEqual(inGroups, ['b']);
  assert.equal(g.total, 2);

  const q = groupSessionsByProjectAndTime(sessions, [], '普通', now);
  assert.deepEqual(q.favorites, []);
  assert.equal(q.total, 1);
  const q2 = groupSessionsByProjectAndTime(sessions, [], '收藏', now);
  assert.deepEqual(q2.favorites.map((s) => s.sessionId), ['a']);
  assert.equal(q2.byProject.length, 0);
});

test('正文搜索：片段按关键词不分大小写切段；只取正文命中；少于 2 个字不发请求', () => {
  assert.deepEqual(highlightParts('…查一下 Zebra 迁移，zebra 再查', 'zebra'), [
    { text: '…查一下 ', hit: false },
    { text: 'Zebra', hit: true },
    { text: ' 迁移，', hit: false },
    { text: 'zebra', hit: true },
    { text: ' 再查', hit: false },
  ]);
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlightParts('', 'x'), []);
  assert.deepEqual(contentHitsOf({ hits: [{ sessionId: '1', match: 'title' }, { sessionId: '2', match: 'text' }, { match: 'text' }] }).map((h) => h.sessionId), ['2']);
  assert.deepEqual(contentHitsOf(null), []);
  assert.equal(contentQueryOf(' a '), '');
  assert.equal(contentQueryOf('  迁移  脚本 '), '迁移 脚本');
});

test('已置顶工作空间排在侧栏项目组最前，且不会被挤进「其它文件夹」', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const sessions = [
    { sessionId: 's1', cwd: 'E:\\ws1', title: '一', updatedMs: now - 1000 },
    { sessionId: 's2', cwd: 'E:\\ws2', title: '二', updatedMs: now - 2000 },
    { sessionId: 's3', cwd: 'E:\\ws3', title: '三', updatedMs: now - 3000 },
    { sessionId: 's4', cwd: 'E:\\ws4', title: '四', updatedMs: now - 4000 },
    { sessionId: 's5', cwd: 'E:\\ws5', title: '五', updatedMs: now - 5000 },
    { sessionId: 's6', cwd: 'E:\\ws6', title: '六', updatedMs: now - 6000 },
    { sessionId: 's7', cwd: 'E:\\ws7', title: '七', updatedMs: now - 7000 },
  ];
  const projects = [
    { id: 'p6', name: 'ws6', path: 'E:\\ws6', pinned: true, pinnedAt: 200 },
    { id: 'p7', name: 'ws7', path: 'E:\\ws7', pinned: true, pinnedAt: 500 },
  ];
  const g = groupSessionsByProjectAndTime(sessions, projects, '', now, { primaryLimit: 5 });
  assert.deepEqual(g.primaryProjects.map((p) => p.name), ['ws7', 'ws6', 'ws1', 'ws2', 'ws3']);
  assert.equal(g.primaryProjects[0].pinned, true);
  assert.equal(g.primaryProjects[1].pinned, true);
  assert.equal(g.primaryProjects[2].pinned, false);
  assert.deepEqual(g.moreProjects.map((p) => p.name), ['ws4', 'ws5']);
});
