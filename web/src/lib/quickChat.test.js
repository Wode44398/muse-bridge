import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, daysLeft, expiryWarn, quickPolicy, newChatTarget, isNewChatKey, newChatKbd, landingFor } from './quickChat.js';

test('daysLeft / expiryWarn：向上取整、过期算 0、只在最后 warnDays 天提示', () => {
  const now = 1_800_000_000_000;
  assert.equal(daysLeft(now + 2.5 * DAY, now), 3);
  assert.equal(daysLeft(now - DAY, now), 0);
  assert.equal(daysLeft(0, now), null);
  assert.equal(daysLeft(undefined, now), null);
  assert.equal(expiryWarn(now + 3 * DAY, null, now), true);
  assert.equal(expiryWarn(now + 3 * DAY + 1, null, now), false, '还剩 3 天多一点 = 4 天');
  assert.equal(expiryWarn(now + 5 * DAY, { warnDays: 7 }, now), true, '服务端给的提示天数为准');
  assert.equal(expiryWarn(undefined, null, now), false);
  assert.deepEqual(quickPolicy({ ttlDays: 14 }), { ttlDays: 14, warnDays: 3, trashDays: 30 });
});

test('newChatTarget：真实项目里留在原地；临时对话里落到最近用过的真实项目；都没有落默认工作空间', () => {
  const projects = [
    { id: 'def', def: true }, { id: 'p1' }, { id: 'p2' },
    { id: 'q-cur', quick: true, current: true }, { id: 'q-old', quick: true },
  ];
  const sessions = [{ id: 's0', projectId: 'q-old' }, { id: 's1', projectId: 'p2' }, { id: 's2', projectId: 'p1' }];
  assert.equal(newChatTarget({ currentProjectId: 'p1', projects, sessions }), 'p1');
  assert.equal(newChatTarget({ currentProjectId: 'q-old', projects, sessions }), 'p2');
  assert.equal(newChatTarget({ currentProjectId: null, projects, sessions }), 'p2');
  assert.equal(newChatTarget({ currentProjectId: 'gone', projects, sessions: [] }), 'def');
  assert.equal(newChatTarget({ currentProjectId: 'q-cur', projects: [{ id: 'q-cur', quick: true }], sessions: [] }), null);
});

test('isNewChatKey：网页认 Ctrl/⌘+Shift+O，桌面壳另认 Ctrl/⌘+N；Alt 组合不认', () => {
  const k = (o) => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.ok(isNewChatKey(k({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })));
  assert.ok(isNewChatKey(k({ key: 'o', code: 'KeyO', metaKey: true, shiftKey: true })));
  assert.ok(!isNewChatKey(k({ key: 'n', code: 'KeyN', ctrlKey: true })), '网页里 Ctrl+N 是浏览器的');
  assert.ok(isNewChatKey(k({ key: 'n', code: 'KeyN', ctrlKey: true }), { desktop: true }));
  assert.ok(isNewChatKey(k({ key: 'N', code: 'KeyN', metaKey: true }), { desktop: true }));
  assert.ok(!isNewChatKey(k({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }), { desktop: true }), 'Ctrl+Alt+N 是桌面壳的全局快捷键');
  assert.ok(!isNewChatKey(k({ key: 'o', code: 'KeyO', shiftKey: true })));
  assert.equal(newChatKbd({ desktop: true, mac: false }), 'Ctrl N');
  assert.equal(newChatKbd({ desktop: false, mac: true }), '⇧⌘O');
});

test('landingFor：设置优先；默认管理员落临时对话、其他成员落工作空间（D10 b）', () => {
  assert.equal(landingFor({ kind: 'admin' }), 'temp');
  assert.equal(landingFor({ kind: 'user' }), 'workspace');
  assert.equal(landingFor({ kind: 'user', setting: 'temp' }), 'temp');
  assert.equal(landingFor({ kind: 'admin', setting: 'workspace' }), 'workspace');
  assert.equal(landingFor({ kind: 'admin', setting: 'auto' }), 'temp');
});
