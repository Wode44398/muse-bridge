import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileAiCapabilities,
  filterFilesByName,
  makeFileComparator,
  nextSort,
  normalizeSort,
  sendFileToAi,
  sortFiles,
  shareClipboardText,
  shareRequest,
} from './files-business.js';

test('normalizes file search and share options', () => {
  assert.deepEqual(
    filterFilesByName([{ name: 'Report.MD' }, { name: 'photo.png' }], ' report '),
    [{ name: 'Report.MD' }],
  );
  assert.deepEqual(shareRequest({ pwOn: true, password: ' secret ', ttl: 7 }), {
    password: 'secret',
    options: { ttlHours: 7, password: 'secret' },
  });
  assert.equal(
    shareClipboardText({ url: 'https://example.test/s/x', pw: 'secret' }),
    'https://example.test/s/x\n分享密码：secret',
  );
});

test('routes a file into the selected chat through adapters', async () => {
  const events = [];
  await sendFileToAi({ name: 'notes.md' }, 'claude', undefined, 'old-session', {
    kindOf: () => 'md',
    material: async (_item, direct) => {
      events.push(['material', direct]);
      return { path: '/tmp/notes.md', name: 'notes.md' };
    },
    readText: async () => '',
    toast: (message) => events.push(['toast', message]),
    chats: {
      claude: {
        current: () => 'current-session',
        newChat: () => events.push(['new']),
        load: async (id) => events.push(['load', id]),
        attach: (attachment) => events.push(['attach', attachment.name]),
      },
    },
    studio: { push: () => events.push(['studio']) },
    navigate: (screen) => events.push(['navigate', screen]),
  });
  assert.deepEqual(events, [
    ['toast', '正在准备…'],
    ['material', true],
    ['load', 'old-session'],
    ['attach', 'notes.md'],
    ['navigate', 'claude'],
    ['toast', '已加到对话输入，去问它吧'],
  ]);
});

test('media targets go to Media Studio: image → frame input, text → prompt', async () => {
  const pushed = [], nav = [];
  const base = {
    material: async () => ({ path: 'u/cover.png', url: '/u/cover.png', name: 'cover.png' }),
    readText: async () => '台词第一行',
    toast: () => {},
    chats: {},
    studio: { push: (x) => pushed.push(x) },
    navigate: (s) => nav.push(s),
  };
  await sendFileToAi({ name: 'cover.png' }, 'video', 'last', undefined, { ...base, kindOf: () => 'img' });
  await sendFileToAi({ name: 'cover.png' }, 'image', undefined, undefined, { ...base, kindOf: () => 'img' });
  await sendFileToAi({ name: 'lines.md' }, 'audio', undefined, undefined, { ...base, kindOf: () => 'md' });
  assert.deepEqual(pushed, [
    { page: 'video', input: { role: 'last', upload: 'u/cover.png', url: '/u/cover.png', name: 'cover.png', kind: 'image' } },
    { page: 'image', input: { role: 'edit', upload: 'u/cover.png', url: '/u/cover.png', name: 'cover.png', kind: 'image' } },
    { page: 'voice', text: '台词第一行' },
  ]);
  assert.deepEqual(nav, ['studio', 'studio', 'studio']);
});

test('sorts files naturally with folders first and stable fallbacks', () => {
  const list = [
    { name: 'img10.png', size: 5, mtime: 30 },
    { name: 'B', isDir: true, mtime: 1 },
    { name: 'img2.png', size: 50, mtime: 10 },
    { name: 'a', isDir: true, mtime: 9 },
    { name: 'Img1.jpg', size: 50, mtime: 20 },
    { name: 'notes.md', size: 1, mtime: 20 },
  ];
  const names = (opts) => sortFiles(list, { locale: 'zh-CN', ...opts }).map((x) => x.name);
  assert.deepEqual(names({ key: 'name', dir: 1 }), ['a', 'B', 'Img1.jpg', 'img2.png', 'img10.png', 'notes.md']);
  // 降序只翻文件，文件夹仍在最前（组内也按名称反向）
  assert.deepEqual(names({ key: 'name', dir: -1 }), ['B', 'a', 'notes.md', 'img10.png', 'img2.png', 'Img1.jpg']);
  // 同时间按名称升序兜底
  assert.deepEqual(names({ key: 'mtime', dir: -1 }), ['a', 'B', 'img10.png', 'Img1.jpg', 'notes.md', 'img2.png']);
  assert.deepEqual(names({ key: 'size', dir: -1 }), ['a', 'B', 'Img1.jpg', 'img2.png', 'img10.png', 'notes.md']);
  assert.deepEqual(names({ key: 'type', dir: 1 }), ['a', 'B', 'Img1.jpg', 'notes.md', 'img2.png', 'img10.png']);
  // 原数组不动
  assert.equal(list[0].name, 'img10.png');
  // 自定义类型键
  const byKind = makeFileComparator({ key: 'type', dir: 1, typeOf: (it) => (it.name.endsWith('.md') ? 'a' : 'b') });
  assert.equal([...list].sort(byKind).filter((x) => !x.isDir)[0].name, 'notes.md');
});

test('sort state helpers', () => {
  assert.deepEqual(normalizeSort(null), { key: 'name', dir: 1 });
  assert.deepEqual(normalizeSort({ key: 'mtime' }), { key: 'mtime', dir: -1 });
  assert.deepEqual(normalizeSort({ key: 'bogus', dir: -1 }), { key: 'name', dir: -1 });
  assert.deepEqual(nextSort({ key: 'name', dir: 1 }, 'name'), { key: 'name', dir: -1 });
  assert.deepEqual(nextSort({ key: 'name', dir: 1 }, 'size'), { key: 'size', dir: -1 });
});

test('AI capabilities accept fileKinds codes', () => {
  assert.equal(fileAiCapabilities({ name: 'a.png' }, () => 'image').mode, 'image');
  assert.equal(fileAiCapabilities({ name: 'a.js' }, () => 'code').mode, 'text');
  assert.equal(fileAiCapabilities({ name: 'a.md' }, () => 'md').mode, 'text');
  assert.equal(fileAiCapabilities({ name: 'a.zip' }, () => 'zip').mode, 'file');
});
