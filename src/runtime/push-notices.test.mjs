import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notePush, recentPushes } from './push-notices.mjs';

test('模型推送：按 caller 隔离、压空白、截长、空消息不记', () => {
  assert.equal(notePush('k1', { sessionId: 's', message: '   ' }), null);
  assert.equal(notePush('', { message: 'x' }), null);
  const a = notePush('k1', { sessionId: 's1', message: '  构建\n  完成了 ' });
  assert.equal(a.message, '构建 完成了');
  notePush('k1', { sessionId: 's1', message: 'x'.repeat(500) });
  const list = recentPushes('k1');
  assert.equal(list.length, 2);
  assert.equal(list[1].message.length, 300);
  assert.ok(list.every((p) => typeof p.id === 'string' && p.ageMs >= 0 && p.ageMs < 1000));
  assert.notEqual(list[0].id, list[1].id);
  assert.deepEqual(recentPushes('k2'), []);
});

test('模型推送：每个 caller 只留最近 20 条', () => {
  for (let i = 0; i < 25; i++) notePush('k3', { message: 'm' + i });
  const list = recentPushes('k3');
  assert.equal(list.length, 20);
  assert.equal(list[0].message, 'm5');
  assert.equal(list[19].message, 'm24');
});
