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

test('routes a file into the selected Claude chat through adapters', async () => {
  const events = [];
  await sendFileToAi({ name: 'notes.md' }, 'old-session', {
    material: async (_item, direct) => {
      events.push(['material', direct]);
      return { path: '/tmp/notes.md', name: 'notes.md' };
    },
    toast: (message) => events.push(['toast', message]),
    chat: {
      current: () => 'current-session',
      newChat: () => events.push(['new']),
      load: async (id) => events.push(['load', id]),
      attach: (attachment) => events.push(['attach', attachment.name]),
    },
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

test('starts a new chat when asked', async () => {
  const events = [];
  await sendFileToAi({ name: 'a.txt' }, 'new', {
    material: async () => ({ path: '/tmp/a.txt', name: 'a.txt' }),
    toast: () => {},
    chat: {
      current: () => 'cur',
      newChat: () => events.push('new'),
      load: async () => events.push('load'),
      attach: () => events.push('attach'),
    },
    navigate: () => events.push('nav'),
  });
  assert.deepEqual(events, ['new', 'attach', 'nav']);
});
