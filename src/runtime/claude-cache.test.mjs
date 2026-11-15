// Claude 分页的提示缓存寿命与空闲压缩（claude-cache.mjs）：订阅号 1 小时、定时公式、排 / 撤定时器、到点发 /compact 的条件。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-cache-'));
process.env.BRIDGE_DATA_ROOT = tmp;

const C = await import('./claude-cache.mjs');
const Q = await import('./claude-queue.mjs');
const U = await import('./ctx-usage.mjs');
after(() => { for (const t of C._claudeIdleTimers.values()) clearTimeout(t); C._claudeIdleTimers.clear(); });

const usage = (messages, at = Date.now() - 60_000) => ({
  total: messages + 30_000, max: 1_000_000, pct: 1, at,
  categories: [{ name: 'System prompt', tokens: 30_000, kind: 'used' }, { name: 'Messages', tokens: messages, kind: 'used' }],
});

test('订阅号（内置模型）按 CLI 默认 1 小时；自定义模型解析不到 = 不知道', () => {
  assert.deepEqual(C.claudeCacheTtl('opus'), { minutes: 60, source: 'request' });
  assert.deepEqual(C.claudeCacheTtl(''), { minutes: 60, source: 'request' });
  assert.equal(C.claudeCacheTtl('custom:p-abcdef12:gpt-x', 'host').minutes, null);
});

test('定时公式与 dimensio 一致：长缓存提前 6 分钟，短缓存在四分之三处', () => {
  assert.equal(C.idleDelay(3_600_000), 54 * 60_000);
  assert.equal(C.idleDelay(300_000), 225_000);
  assert.equal(C.messageTokens(usage(90_000)), 90_000);
  assert.equal(C.messageTokens(null), 0);
});

test('只在「自动压缩」、有身份、缓存够长时排；开新一轮撤掉', () => {
  const replay = { headers: { cookie: 'x' }, url: '/api/chat', body: {} };
  assert.equal(C.scheduleClaudeIdleCompact({ key: 'k', sid: 's1', mode: 'hint', replay, ttlMin: 60 }), false);
  assert.equal(C.scheduleClaudeIdleCompact({ key: 'k', sid: 's1', mode: 'compact', replay: null, ttlMin: 60 }), false);
  assert.equal(C.scheduleClaudeIdleCompact({ key: 'k', sid: 's1', mode: 'compact', replay, ttlMin: 2 }), false);
  assert.equal(C.scheduleClaudeIdleCompact({ key: 'k', sid: 's1', mode: 'compact', replay, ttlMin: null }), false);
  assert.equal(C.scheduleClaudeIdleCompact({ key: 'k', sid: 's1', mode: 'compact', replay, ttlMin: 60 }), true);
  assert.ok(C._claudeIdleTimers.has('k|s1'));
  C.cancelClaudeIdleCompact('k', 's1');
  assert.ok(!C._claudeIdleTimers.has('k|s1'));
});

test('到点：对话部分够大才发 /compact（标 idle-compact、不顶掉在跑的轮）；收尾后又有过一轮的不发', async () => {
  const sent = [];
  Q.setQueueReplayer(async (rq) => { sent.push(rq); return { status: 200 }; });
  const replay = { headers: { cookie: 'x' }, url: '/api/chat', body: { client: 'apk' } };
  const endedAt = Date.now() - 50 * 60_000;
  U.applyContextUsage('k', 'small', usage(10_000, endedAt - 1000));
  await C._fireClaudeIdleCompact({ key: 'k', sid: 'small', replay, endedAt });
  assert.equal(sent.length, 0, '对话太短不压');
  U.applyContextUsage('k', 'later', usage(200_000, Date.now()));
  await C._fireClaudeIdleCompact({ key: 'k', sid: 'later', replay, endedAt });
  assert.equal(sent.length, 0, '收尾之后又有过一轮');
  U.applyContextUsage('k', 'big', usage(200_000, endedAt - 1000));
  await C._fireClaudeIdleCompact({ key: 'k', sid: 'big', replay, endedAt });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.message, '/compact');
  assert.equal(sent[0].body.sessionId, 'big');
  assert.equal(sent[0].body.client, 'apk');
  assert.deepEqual(sent[0].family, { origin: { kind: 'idle-compact', from: [] }, noPreempt: true });
  Q.setQueueReplayer(null);
});
