import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filterAttachmentPaths } from './runtime/attachment-guard.mjs';

test('attachment guard: sandbox stays rooted, admin may reference anywhere', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'att-guard-'));
  try {
    const uploads = path.join(base, 'uploads');
    const cwd = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    for (const d of [uploads, cwd, outside]) mkdirSync(d, { recursive: true });
    const inUploads = path.join(uploads, 'a.txt');
    const inCwd = path.join(cwd, 'b.txt');
    const outsideFile = path.join(outside, 'c.txt');
    for (const f of [inUploads, inCwd, outsideFile]) writeFileSync(f, 'x');

    const roots = [uploads, cwd];
    // 沙箱：uploads/cwd 内收，外面的拒，不存在的拒
    assert.deepEqual(
      filterAttachmentPaths([inUploads, inCwd, outsideFile, path.join(cwd, 'missing.txt')], { roots }),
      [inUploads, inCwd],
    );
    // admin：任意存在的绝对路径放行；不存在仍拒
    assert.deepEqual(
      filterAttachmentPaths([outsideFile, path.join(outside, 'missing.txt')], { allowAnywhere: true }),
      [outsideFile],
    );
    // 目录本身（挂载文件夹）同样放行
    assert.deepEqual(filterAttachmentPaths([outside], { allowAnywhere: true }), [outside]);
    // 非法输入：相对路径 / 非字符串 / 前缀伪装（/ws-evil 不在 /ws 内）
    const evil = path.join(base, 'ws-evil');
    mkdirSync(evil); writeFileSync(path.join(evil, 'd.txt'), 'x');
    assert.deepEqual(filterAttachmentPaths(['rel/nope.txt', 42, null, path.join(evil, 'd.txt')], { roots }), []);
    // roots 里的空值被忽略（codexProject/claudeProject 缺席时传 undefined）
    assert.deepEqual(filterAttachmentPaths([inCwd], { roots: [undefined, '', cwd] }), [inCwd]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
