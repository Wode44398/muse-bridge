// 工作空间的「上次看到的样子」（lib/files/lastSeen.js）：
//   · 根目录列表 / 元数据 / 位置表记下能原样读回；桌面壳的缩略图 dataUrl 不进快照
//   · 根目录太大不记，并把以前记的作废（不然冷开先画一份早就对不上的旧列表）
//   · ROOT_LIST_KEY 与 FilesPanel 的 listKey 拼法对得上（两边各写一份，改一边忘了另一边快照就永远命不中）
// 用真的 lastKnown.js，依赖换成桩；localStorage 用内存版（同 lib/lastKnown.test.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
const flushTimers = () => new Promise((r) => setTimeout(r, 450));

const dir = mkdtempSync(join(tmpdir(), 'files-lastseen-test-'));
mkdirSync(join(dir, 'lib', 'files'), { recursive: true });
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(join(dir, 'lib', 'lastKnown.js'), readFileSync(join(here, '..', 'lastKnown.js'), 'utf8'));
writeFileSync(join(dir, 'lib', 'serverProfiles.js'), 'export const cacheNamespace = () => "";');
writeFileSync(join(dir, 'lib', 'accountVault.js'), 'export const bootCacheTag = () => "";');
writeFileSync(join(dir, 'lib', 'store.js'), 'export const storeGet = (k) => localStorage.getItem(k);');
writeFileSync(join(dir, 'lib', 'files', 'lastSeen.js'), readFileSync(join(here, 'lastSeen.js'), 'utf8'));
localStorage.setItem('bridge-me', JSON.stringify({ kind: 'admin', user: null, uid: null }));
const S = await import(pathToFileURL(join(dir, 'lib', 'files', 'lastSeen.js')).href);

test('根目录列表与元数据记下能读回，缩略图 dataUrl 不进快照', async () => {
  assert.equal(S.recallRoot(), null);
  S.rememberRoot([{ name: 'a', isDir: true, size: 0, mtime: 1 }, { name: 'b.png', isDir: false, size: 3, mtime: 2, nativeThumb: 'data:xx', nativeThumbW: 32 }], { truncated: false, total: 0 });
  S.rememberRootMeta({ a: { n: 4 } });
  await flushTimers();
  const r = S.recallRoot();
  assert.deepEqual(r.items, [{ name: 'a', isDir: true, size: 0, mtime: 1 }, { name: 'b.png', isDir: false, size: 3, mtime: 2 }]);
  assert.equal(r.truncated, false);
  assert.deepEqual(S.recallRootMeta(), { a: { n: 4 } });
});

test('根目录太大不记，并作废以前记的', async () => {
  S.rememberRoot(Array.from({ length: 401 }, (_, i) => ({ name: 'f' + i, isDir: false, size: 1, mtime: i })), { truncated: false, total: 0 });
  await flushTimers();
  assert.equal(S.recallRoot(), null);
  assert.equal(S.recallRootMeta(), null);
});

test('位置表只留 id / name / path；作废后读回 null', async () => {
  S.rememberLocs([{ id: 'ws', name: '工作空间', path: 'E:\\V', extra: 1 }, { id: 'home', name: '主目录', path: 'C:\\U' }]);
  await flushTimers();
  assert.deepEqual(S.recallLocs(), [{ id: 'ws', name: '工作空间', path: 'E:\\V' }, { id: 'home', name: '主目录', path: 'C:\\U' }]);
  S.forgetLocs();
  assert.equal(S.recallLocs(), null);
});

test('ROOT_LIST_KEY 与 FilesPanel 的 listKey 拼法一致', () => {
  const src = readFileSync(join(here, '..', '..', 'components', 'FilesPanel.svelte'), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes('const listKey = (p) =>'));
  assert.ok(line, 'FilesPanel 里找不到 listKey');
  assert.ok(line.includes(": 'cloud') + '\\x1f' + (cloudRoot || '') + '\\x1f' + p"), 'listKey 拼法变了，同步改 lastSeen.js 的 ROOT_LIST_KEY');
  assert.equal(S.ROOT_LIST_KEY, 'cloud' + '\x1f' + '' + '\x1f' + '');
});
