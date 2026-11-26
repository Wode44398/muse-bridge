import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupSessions, matches, markParts, ago, leadToken, diffTotal, historyEnds, parseFolded, toggleFolded,
  underscoreBox, underscoreFlight, collectArtifacts, splitRoutines, pool,
} from './logic.js';

test('groupSessions：已知项目按顺序，认不出的按名字归组、无名的最后', () => {
  const projects = [{ id: 'a', name: 'web', branch: 'main' }, { id: 'b', name: 'bridge' }];
  const sessions = [
    { id: '1', projectId: 'a', mtime: 1 },
    { id: '2', projectId: 'a', mtime: 5 },
    { id: '3', projectId: 'gone', projectName: 'old', mtime: 2 },
    { id: '4', projectId: null, projectName: '', mtime: 3 },
  ];
  const g = groupSessions(projects, sessions);
  assert.deepEqual(g.map((x) => x.key), ['p:a', 'p:b', 'n:old', 'n:']);
  assert.deepEqual(g[0].sessions.map((s) => s.id), ['2', '1']);
  assert.equal(g[0].branch, 'main');
  assert.equal(g[1].sessions.length, 0);
  assert.equal(g[2].known, false);
});

test('matches / markParts：标题或项目名命中，不分大小写', () => {
  assert.equal(matches({ title: 'Fix Scrollbar' }, 'web', 'scroll'), true);
  assert.equal(matches({ title: 'x' }, 'Bridge-Web', 'web'), true);
  assert.equal(matches({ title: 'x' }, 'y', 'z'), false);
  assert.equal(matches({ title: 'x' }, 'y', '  '), true);
  assert.deepEqual(markParts('Fix Scrollbar', 'scroll'), [{ text: 'Fix ', hit: false }, { text: 'Scroll', hit: true }, { text: 'bar', hit: false }]);
  assert.deepEqual(markParts('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(markParts('abc', 'abc'), [{ text: 'abc', hit: true }]);
});

test('ago：刚刚 / 分钟 / 小时 / 昨天 / 天 / 周 / 日期', () => {
  const now = new Date(2026, 10, 25, 12, 0, 0).getTime();
  assert.deepEqual(ago(now - 10e3, now), { unit: 'now', n: 0 });
  assert.deepEqual(ago(now - 5 * 60e3, now), { unit: 'min', n: 5 });
  assert.deepEqual(ago(now - 3 * 3600e3, now), { unit: 'hour', n: 3 });
  assert.deepEqual(ago(new Date(2026, 10, 24, 9).getTime(), now), { unit: 'yesterday', n: 1 });
  assert.deepEqual(ago(new Date(2026, 10, 21, 9).getTime(), now), { unit: 'day', n: 4 });
  assert.deepEqual(ago(new Date(2026, 10, 10, 9).getTime(), now), { unit: 'week', n: 2 });
  assert.equal(ago(new Date(2026, 5, 1).getTime(), now).unit, 'date');
  assert.equal(ago(0, now), null);
});

test('leadToken：error → err，write → think，未知清空', () => {
  assert.equal(leadToken('error'), 'err');
  assert.equal(leadToken('write'), 'think');
  assert.equal(leadToken('ask'), 'ask');
  assert.equal(leadToken('nope'), '');
});

test('diffTotal：各轮相加，坏的一轮跳过', () => {
  const sum = (t) => { if (t.bad) throw new Error('x'); return { a: t.a, d: t.d }; };
  assert.deepEqual(diffTotal([{ a: 3, d: 1 }, { bad: 1 }, { a: 2, d: 0 }, null], sum), { a: 5, d: 1 });
});

test('historyEnds', () => {
  assert.deepEqual(historyEnds([], -1), { back: false, fwd: false });
  assert.deepEqual(historyEnds(['', 'a', 'b'], 1), { back: true, fwd: true });
  assert.deepEqual(historyEnds(['', 'a'], 1), { back: true, fwd: false });
});

test('parseFolded / toggleFolded', () => {
  assert.deepEqual(parseFolded('["a",1,"b"]'), ['a', 'b']);
  assert.deepEqual(parseFolded('{bad'), []);
  assert.deepEqual(toggleFolded(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleFolded(['a', 'b'], 'a'), ['b']);
});

test('underscoreBox：56px 标志里下划线的位置', () => {
  const b = underscoreBox({ left: 100, top: 200, width: 418 });
  assert.equal(Math.round(b.x), 100 + 221);
  assert.equal(Math.round(b.w), 91);
  assert.equal(b.h, 24);
  const f = underscoreFlight({ x: 0, y: 0, w: 10, h: 4 }, { x: 100, y: 300, w: 8, h: 8 });
  assert.equal(f.frames.length, 3);
  assert.match(f.frames[2].transform, /99px/);
  assert.equal(f.frames[0].opacity, '0.3');
});

test('collectArtifacts：只收助手的附件，按线程分组去重', () => {
  const g = collectArtifacts([
    { id: 't1', title: 'A', messages: [
      { role: 'user', attachments: [{ path: '/u.png' }] },
      { role: 'assistant', attachments: [{ path: '/a/x.png', name: 'x.png' }, { path: '/a/x.png' }, { path: 'C:\\b\\y.md' }] },
    ] },
    { id: 't2', title: 'B', messages: [{ role: 'assistant', attachments: [] }] },
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].items.map((x) => x.name), ['x.png', 'y.md']);
});

test('splitRoutines：工作文件夹在项目里（含子目录）的归前一组', () => {
  const projects = [{ id: 'p', path: 'C:\\Code\\web\\' }];
  const r = splitRoutines([
    { id: '1', cwd: 'c:/code/web' },
    { id: '2', cwd: 'C:\\Code\\web\\pkg' },
    { id: '3', cwd: 'C:\\Code\\webx' },
    { id: '4', cwd: '' },
  ], projects);
  assert.deepEqual(r.inProject.map((x) => x.routine.id), ['1', '2']);
  assert.deepEqual(r.other.map((x) => x.routine.id), ['3', '4']);
});

test('pool：限并发、保序、失败为 null', async () => {
  let live = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (x === 3) throw new Error('x');
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, null, 40, 50]);
  assert.equal(peak, 2);
});
