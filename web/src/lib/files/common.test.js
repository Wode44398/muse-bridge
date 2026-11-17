import test from 'node:test';
import assert from 'node:assert/strict';
// shareResult 在后端没给 url 时按当前源拼（默认参数读 location）：node 里补一个
globalThis.location ??= { origin: 'https://bridge.test' };
import { kindOf, fmtSize, baseKey, dtHasFiles, newShareDialog, mintShareLink } from './common.js';

test('短类型码：判定来自 fileKinds 词表，其余按图标大类 / 扩展名', () => {
  assert.equal(kindOf('a.png'), 'img');
  assert.equal(kindOf('a.JPG'), 'img');
  assert.equal(kindOf('a.mp4'), 'mov');
  assert.equal(kindOf('a.mp3'), 'audio');
  assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('a.md'), 'md');
  assert.equal(kindOf('a.html'), 'html');
  assert.equal(kindOf('a.txt'), 'text');
  assert.equal(kindOf('a.zip'), 'zip');
  assert.equal(kindOf('a.7z'), 'zip');
  assert.equal(kindOf('a.apk'), 'apk');
  assert.equal(kindOf('a.docx'), 'doc');
  assert.equal(kindOf('README'), 'text');
  assert.equal(kindOf('archive.bin'), 'doc');
});

test('大小：B / KB 取整 / MB 一位 / GB 两位，空值给空串', () => {
  assert.equal(fmtSize(null), '');
  assert.equal(fmtSize(undefined), '');
  assert.equal(fmtSize(0), '0 B');
  assert.equal(fmtSize(1023), '1023 B');
  assert.equal(fmtSize(1024), '1 KB');
  assert.equal(fmtSize(1536), '2 KB');
  assert.equal(fmtSize(1048576), '1.0 MB');
  assert.equal(fmtSize(5.25 * 1048576), '5.3 MB');
  assert.equal(fmtSize(1073741824), '1.00 GB');
});

test('查看器条目键：去掉末尾的 #view: 后缀', () => {
  assert.equal(baseKey('cloud:a/b.svg#view:code'), 'cloud:a/b.svg');
  assert.equal(baseKey('cloud:a/b.svg'), 'cloud:a/b.svg');
  assert.equal(baseKey(null), '');
});

test('拖入判定：dataTransfer 带 Files 才算', () => {
  assert.equal(dtHasFiles({ dataTransfer: { types: ['Files', 'text/plain'] } }), true);
  assert.equal(dtHasFiles({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(dtHasFiles({}), false);
});

test('分享链接：新弹窗的初值；铸造时只发一次、结果写回弹窗', async () => {
  const d = newShareDialog({ name: 'a.md' });
  assert.deepEqual(d, { item: { name: 'a.md' }, pwOn: false, password: '', ttl: 24, busy: false, result: null });
  const calls = [];
  const api = { shareSpaceMint: async (rels, options, root) => { calls.push({ rels, options, root }); return { url: 'https://x/w/t', expiresAt: 1 }; } };
  const toasts = [];
  await mintShareLink(api, d, 'a.md', 'C:\\ws', (m) => toasts.push(m));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].rels, ['a.md']);
  assert.equal(calls[0].root, 'C:\\ws');
  assert.equal(d.busy, false);
  assert.equal(d.result.url, 'https://x/w/t');
  assert.deepEqual(toasts, []);
  // 进行中 / 没有弹窗：什么都不做
  d.busy = true;
  await mintShareLink(api, d, 'a.md', '', () => {});
  await mintShareLink(api, null, 'a.md', '', () => {});
  assert.equal(calls.length, 1);
});

test('分享链接：失败给提示、复位 busy', async () => {
  const d = newShareDialog({ name: 'a.md' });
  const toasts = [];
  await mintShareLink({ shareSpaceMint: async () => { throw Object.assign(new Error('x'), { body: { error: 'boom' } }); } }, d, 'a.md', '', (m) => toasts.push(m));
  assert.equal(d.busy, false);
  assert.equal(d.result, null);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /boom/);
});
