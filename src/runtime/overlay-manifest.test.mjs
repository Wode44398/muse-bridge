// overlay 清单的版本戳：按内容算——原样重写（只动修改时间）不能换戳，否则每次构建都让全部 overlay 素材缓存作废。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { buildManifest } from './overlay-manifest.mjs';

test('版本戳：只改修改时间不变，改内容 / 加文件才变', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'chatgpt'));
  const f = path.join(dir, 'chatgpt', 'runtime.js');
  writeFileSync(f, 'a');
  writeFileSync(path.join(dir, 'font.woff2'), 'x');
  const v0 = buildManifest(dir).manifest.ver;
  assert.match(v0, /^[0-9a-f]{10}$/);

  writeFileSync(f, 'a');
  const later = new Date(Date.now() + 60_000);
  utimesSync(f, later, later);
  assert.equal(buildManifest(dir).manifest.ver, v0);

  writeFileSync(f, 'b');
  const v1 = buildManifest(dir).manifest.ver;
  assert.notEqual(v1, v0);

  writeFileSync(path.join(dir, 'new.png'), 'p');
  assert.notEqual(buildManifest(dir).manifest.ver, v1);
});
