// 「拷/移进自身」守卫的回归。
//
// 原实现用 `dst.startsWith(src + path.sep)` 判定，win32 下大小写敏感——`Foo` 与
// `foo/inner` 明明是同一棵树却被判成两处，守卫放行后 cpSync 把目录往自己里面无限
// 递归拷（实测 1 个文件 3 分钟长到 3049 个），同步调用还会把整台单线程服务钉死。
// 文件路由对普通 user 和公开快照访客都开放，所以这条是「一个请求冻服务 + 撑爆磁盘」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveWorkspaceFile, resolveTransfer, relPosition } from './file-core.mjs';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-xfer-'));
  fs.mkdirSync(path.join(root, 'Foo', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Foo', 'a.txt'), 'hello');
  fs.mkdirSync(path.join(root, 'Bar'), { recursive: true });
  return root;
}
const clean = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };

test('relPosition 用 path.relative 判定，大小写不同也认得出是同一棵树', () => {
  const base = process.platform === 'win32' ? 'C:\\ws\\Foo' : '/ws/Foo';
  const lower = process.platform === 'win32' ? 'c:\\ws\\foo\\inner' : '/ws/Foo/inner';
  assert.equal(relPosition(base, base), 'same');
  assert.equal(relPosition(base, lower), 'inside');
  assert.equal(relPosition(base, path.join(path.dirname(base), 'Bar')), 'outside');
  if (process.platform === 'win32') {
    // 这一条正是旧 startsWith 判错的形态：盘符与目录名都换了大小写。
    assert.equal(relPosition('C:\\ws\\Foo', 'c:\\WS\\FOO'), 'same');
  }
});

test('copy/move：大小写不同的「目标在源之内」被拒，不再放行成无限递归', () => {
  const root = workspace();
  try {
    const ctx = { cwd: root };
    // 目标目录字面是 foo/inner，源是 Foo——Windows 上同一棵树。
    const inside = resolveTransfer(ctx, 'Foo', 'foo/inner');
    if (process.platform === 'win32') {
      assert.equal(inside.code, 400);
      assert.match(inside.err, /自身/);
    }
    // 同大小写的自嵌套任何平台都必须拒。
    const same = resolveTransfer(ctx, 'Foo', 'Foo/inner');
    assert.equal(same.code, 400);
    assert.match(same.err, /自身/);

    // 只在 Windows 上试：大小写敏感的系统里 foo 是另一个目录，这一步会真把 Foo 移走，下一条就没有源了
    if (process.platform === 'win32') assert.match(moveWorkspaceFile(root, 'Foo', 'foo/inner/Foo').error || '', /自身/);
    assert.match(moveWorkspaceFile(root, 'Foo', 'Foo/inner/Foo').error || '', /自身/);
  } finally { clean(root); }
});

test('目标目录是指回源内部的 junction/符号链接时同样被拒', (t) => {
  const root = workspace();
  try {
    const link = path.join(root, 'Bar', 'loop');
    try {
      fs.symlinkSync(path.join(root, 'Foo', 'inner'), link, 'junction');
    } catch {
      t.skip('本机不允许建 junction/符号链接');
      return;
    }
    const r = resolveTransfer({ cwd: root }, 'Foo', 'Bar/loop');
    assert.equal(r.code, 400);
    assert.match(r.err, /自身/);
  } finally { clean(root); }
});

test('正常的同级移动/拷贝不受影响', () => {
  const root = workspace();
  try {
    const r = resolveTransfer({ cwd: root }, 'Foo', 'Bar');
    assert.equal(r.err, undefined);
    assert.equal(path.basename(r.dst), 'Foo');

    const m = moveWorkspaceFile(root, 'Foo/a.txt', 'Bar/a.txt');
    assert.equal(m.ok, true);
    assert.equal(fs.existsSync(path.join(root, 'Bar', 'a.txt')), true);
  } finally { clean(root); }
});
