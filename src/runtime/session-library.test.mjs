// 会话收藏 / 自定义标题落服务端（跨设备同步，2026-10-11）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getLibrary, applyLibraryOp, dropFromLibrary, _resetLibraryCache } from './session-library.mjs';

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const C = 'cccccccc-1111-2222-3333-444444444444';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lib-'));
  return { dir, ctx: { dataDir: dir } };
}

test('收藏：最近收藏在前、幂等、取消；落盘后换进程（清缓存）仍在', () => {
  const { dir, ctx } = fixture();
  try {
    assert.deepEqual(getLibrary(ctx), { rev: 0, stars: [], titles: {} });
    applyLibraryOp(ctx, { op: 'star', id: A, on: true });
    const r = applyLibraryOp(ctx, { op: 'star', id: B, on: true });
    assert.deepEqual(r.library.stars, [B, A]);
    assert.equal(applyLibraryOp(ctx, { op: 'star', id: B, on: true }).changed, false, '重复收藏不涨 rev');
    applyLibraryOp(ctx, { op: 'star', id: B, on: false });
    _resetLibraryCache();
    const lib = getLibrary(ctx);
    assert.deepEqual(lib.stars, [A]);
    assert.equal(lib.rev, 3);
    assert.ok(JSON.parse(readFileSync(path.join(dir, 'claude-session-library.json'), 'utf8')).stars.includes(A));
  } finally { _resetLibraryCache(); rmSync(dir, { recursive: true, force: true }); }
});

test('改名：去换行/截断；空标题=恢复自动标题', () => {
  const { dir, ctx } = fixture();
  try {
    applyLibraryOp(ctx, { op: 'title', id: A, title: '  研报\n草稿  ' });
    assert.equal(getLibrary(ctx).titles[A], '研报 草稿');
    applyLibraryOp(ctx, { op: 'title', id: A, title: 'x'.repeat(500) });
    assert.equal(getLibrary(ctx).titles[A].length, 200);
    applyLibraryOp(ctx, { op: 'title', id: A, title: '' });
    assert.equal(A in getLibrary(ctx).titles, false);
  } finally { _resetLibraryCache(); rmSync(dir, { recursive: true, force: true }); }
});

test('merge：旧本机数据并集上云，服务端已有标题优先，非法 id 丢弃', () => {
  const { dir, ctx } = fixture();
  try {
    applyLibraryOp(ctx, { op: 'star', id: A, on: true });
    applyLibraryOp(ctx, { op: 'title', id: A, title: '服务端名' });
    const r = applyLibraryOp(ctx, { op: 'merge', stars: [B, A, '../evil'], titles: { [A]: '本机名', [C]: '新名', '..\\x': 'bad' } });
    assert.deepEqual(r.library.stars, [A, B]);
    assert.deepEqual(r.library.titles, { [A]: '服务端名', [C]: '新名' });
    assert.equal(applyLibraryOp(ctx, { op: 'merge', stars: [A], titles: {} }).changed, false);
  } finally { _resetLibraryCache(); rmSync(dir, { recursive: true, force: true }); }
});

test('非法 op / id 抛 400；删会话时连带清掉', () => {
  const { dir, ctx } = fixture();
  try {
    assert.throws(() => applyLibraryOp(ctx, { op: 'star', id: '../x', on: true }), (e) => e.status === 400);
    assert.throws(() => applyLibraryOp(ctx, { op: 'nuke' }), (e) => e.status === 400);
    applyLibraryOp(ctx, { op: 'star', id: A, on: true });
    applyLibraryOp(ctx, { op: 'title', id: A, title: 't' });
    const lib = dropFromLibrary(ctx, A);
    assert.deepEqual([lib.stars, lib.titles], [[], {}]);
    assert.equal(dropFromLibrary(ctx, A), null, '没有条目时不写盘、不广播');
  } finally { _resetLibraryCache(); rmSync(dir, { recursive: true, force: true }); }
});

test('按身份 dataDir 隔离：另一个账号看不到', () => {
  const a = fixture(), b = fixture();
  try {
    applyLibraryOp(a.ctx, { op: 'star', id: A, on: true });
    assert.deepEqual(getLibrary(b.ctx).stars, []);
  } finally { _resetLibraryCache(); rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true }); }
});
