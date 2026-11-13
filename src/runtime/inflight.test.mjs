// 「被中断」标记的过期（inflight.mjs，2026-11-08）：overview 只报最近 3 天的，启动时把盘上过期的清掉；排着自动续跑的不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'inflight-'));
const { initInflight, interruptedRunsOf, interruptedRun } = await import('./inflight.mjs');

test('过期的中断标记：启动时清盘，overview 不报', () => {
  const day = 24 * 3600_000;
  const now = Date.now();
  const rec = (sessionId, at, extra = {}) => ({ key: 'admin', sessionId, at, startedAt: at, userText: sessionId, ...extra });
  writeFileSync(path.join(root, 'interrupted-runs.json'), JSON.stringify([
    rec('fresh', now - day),
    rec('stale', now - 40 * day),
    rec('stale-resuming', now - 40 * day, { resuming: true }),
    rec('other-key', now, { key: 'u:bob' }),
  ]));
  writeFileSync(path.join(root, 'inflight-runs.json'), '[]');
  initInflight(root);
  assert.deepEqual(interruptedRunsOf('admin').map((r) => r.sessionId).sort(), ['fresh', 'stale-resuming']);
  assert.equal(interruptedRun('admin', 'stale'), null);
  const onDisk = JSON.parse(readFileSync(path.join(root, 'interrupted-runs.json'), 'utf8')).map((r) => r.sessionId).sort();
  assert.deepEqual(onDisk, ['fresh', 'other-key', 'stale-resuming']);
});
