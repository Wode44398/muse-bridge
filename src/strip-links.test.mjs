// S3 解压逃逸清扫：压缩包里塞 symlink/junction 落地后，/api/file 读、delete 删都会
// 顺着链接越出沙箱。stripLinks 必须剔掉一切链接、保住普通文件，且不得顺着链接把
// 目标目录的真实内容删掉。junction 在 Windows 上无需管理员权限即可创建（文件 symlink
// 需要 Developer Mode，测试里造不出来就跳过那一支）。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { stripLinks } from './runtime/paths.mjs';

test('stripLinks removes junctions/symlinks, keeps files, never follows into targets', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'striplinks-'));
  try {
    const outside = path.join(root, 'outside-secret');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret');

    const dest = path.join(root, 'extracted');
    mkdirSync(path.join(dest, 'sub'), { recursive: true });
    writeFileSync(path.join(dest, 'keep.txt'), 'ok');
    writeFileSync(path.join(dest, 'sub', 'keep2.txt'), 'ok');
    symlinkSync(outside, path.join(dest, 'sub', 'evil'), 'junction');
    let fileLinkMade = true;
    try { symlinkSync(path.join(outside, 'secret.txt'), path.join(dest, 'evil.txt'), 'file'); }
    catch { fileLinkMade = false; }

    const removed = stripLinks(dest);

    assert.ok(removed >= 1, 'junction must be counted as removed');
    assert.ok(!existsSync(path.join(dest, 'sub', 'evil')), 'junction must be gone');
    if (fileLinkMade) assert.ok(!existsSync(path.join(dest, 'evil.txt')), 'file symlink must be gone');
    assert.ok(existsSync(path.join(dest, 'keep.txt')), 'regular file survives');
    assert.ok(existsSync(path.join(dest, 'sub', 'keep2.txt')), 'nested regular file survives');
    assert.ok(existsSync(path.join(outside, 'secret.txt')), 'link target content must NOT be deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
