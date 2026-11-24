import test from 'node:test';
import assert from 'node:assert/strict';
import { moveOrderPath, groupSessionsByProjectAndTime } from './session-groups.js';

test('moveOrderPath 调整工作空间顺序并在位置未变时返回 null', () => {
  const list = ['E:\\A', 'E:\\B', 'E:\\C'];
  assert.deepEqual(moveOrderPath(list, 'e:/a', 3), ['E:\\B', 'E:\\C', 'E:\\A']);
  assert.deepEqual(moveOrderPath(list, 'E:\\C', 0), ['E:\\C', 'E:\\A', 'E:\\B']);
  assert.equal(moveOrderPath(list, 'E:\\B', 1), null);
  assert.equal(moveOrderPath(list, 'E:\\B', 2), null);
  assert.equal(moveOrderPath(list, 'E:\\Missing', 0), null);
});

test('groupSessionsByProjectAndTime 尊重 order 并把新目录排在前面', () => {
  const now = Date.now();
  const sessions = [
    { sessionId: 's1', cwd: 'E:\\ProjA', updatedMs: now - 1000, title: 'A1' },
    { sessionId: 's2', cwd: 'E:\\ProjB', updatedMs: now - 2000, title: 'B1' },
    { sessionId: 's3', cwd: 'E:\\ProjC', updatedMs: now - 3000, title: 'C1' },
  ];
  const g1 = groupSessionsByProjectAndTime(sessions, [], '', now, { order: ['e:/projc', 'E:\\ProjA', 'E:\\ProjB'] });
  assert.deepEqual(g1.primaryProjects.map((g) => g.name), ['ProjC', 'ProjA', 'ProjB']);

  // 未出现在 order 里的新工作空间排在前面
  const sessions2 = [...sessions, { sessionId: 's4', cwd: 'E:\\ProjNew', updatedMs: now - 5000, title: 'N1' }];
  const g2 = groupSessionsByProjectAndTime(sessions2, [], '', now, { order: ['E:\\ProjC', 'E:\\ProjA', 'E:\\ProjB'] });
  assert.deepEqual(g2.primaryProjects.map((g) => g.name), ['ProjNew', 'ProjC', 'ProjA', 'ProjB']);
});
