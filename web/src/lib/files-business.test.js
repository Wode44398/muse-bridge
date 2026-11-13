import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterFilesByName,
  sendFileToAi,
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
