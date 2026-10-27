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
  await sendFileToAi({ name: 'notes.md' }, 'gemini', undefined, 'old-session', {
    kindOf: () => 'md',
    material: async (_item, direct) => {
      events.push(['material', direct]);
      return { path: '/tmp/notes.md', name: 'notes.md' };
    },
    readText: async () => '',
    toast: (message) => events.push(['toast', message]),
    chats: {
      gemini: {
        current: () => 'current-session',
        newChat: () => events.push(['new']),
        load: async (id) => events.push(['load', id]),
        attach: (attachment) => events.push(['attach', attachment.name]),
      },
    },
    mediaState: {},
    ensureVideoModel: () => {},
    navigate: (screen) => events.push(['navigate', screen]),
  });
  assert.deepEqual(events, [
    ['toast', '正在准备…'],
    ['material', false],
    ['load', 'old-session'],
    ['attach', 'notes.md'],
    ['navigate', 'vertex'],
    ['toast', '已加到对话输入，去问它吧'],
  ]);
});
