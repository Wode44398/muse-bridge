import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathInside, mimeType, parseByteRange, safeJoin } from './http-file.mjs';

test('safeJoin keeps rebuilt paths inside the root on both separator styles', () => {
  const root = path.resolve('C:\\workspace');
  assert.equal(safeJoin(root, 'docs/readme.md'), path.join(root, 'docs', 'readme.md'));
  assert.equal(safeJoin(root, '../../Windows/system.ini'), path.join(root, 'Windows', 'system.ini'));
  assert.equal(safeJoin(root, 'D:\\outside\\file.txt'), path.join(root, 'outside', 'file.txt'));
});

test('isPathInside resolves symlinks before authorizing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-http-file-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'inside.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'no');
  try {
    assert.equal(isPathInside(path.join(root, 'inside.txt'), root), true);
    assert.equal(isPathInside(path.join(outside, 'outside.txt'), root), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimeType shares real metadata types but neutralizes active inline content', () => {
  assert.equal(mimeType('clip.mp4'), 'video/mp4');
  assert.equal(mimeType('note.md'), 'text/markdown; charset=utf-8');
  assert.equal(mimeType('page.html', { safe: true }), 'text/plain; charset=utf-8');
  assert.equal(mimeType('shape.svg', { safe: true }), 'text/plain; charset=utf-8');
});

test('parseByteRange handles bounded, open and suffix ranges consistently', () => {
  assert.deepEqual(parseByteRange(undefined, 100), null);
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-500', 100), { start: 0, end: 99 });
});

test('parseByteRange rejects malformed, multi and unsatisfiable ranges', () => {
  for (const value of ['bytes=-', 'bytes=100-', 'bytes=20-10', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.deepEqual(parseByteRange(value, 100), { unsatisfiable: true });
  }
  assert.deepEqual(parseByteRange('bytes=0-0', 0), { unsatisfiable: true });
});
