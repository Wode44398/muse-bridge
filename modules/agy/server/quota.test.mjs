import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeQuota, getAgyQuota, _resetAgyQuotaForTest } from './quota.mjs';

const SAMPLE = { response: { groups: [
  { displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.891, resetTime: '2026-11-25T08:40:34Z' },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.905, resetTime: '2026-11-19T07:45:49Z' },
  ] },
  { displayName: 'Claude and GPT models', buckets: [
    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.9975, resetTime: '2026-11-25T18:56:32Z' },
    { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-19T10:11:11Z' },   // 满额时 remainingFraction 缺省
  ] },
] } };

test('normalizeQuota：已用 = 1 − 剩余、分组简称、缺省剩余按满额', () => {
  const b = normalizeQuota(SAMPLE);
  assert.equal(b.length, 4);
  assert.deepEqual(b[0], { id: 'gemini-weekly', group: 'Gemini', window: 'weekly', usedPct: 10.9, resetAt: Date.parse('2026-11-25T08:40:34Z') });
  assert.equal(b[2].group, 'Claude / GPT');
  assert.equal(b[3].usedPct, 0);
  assert.deepEqual(normalizeQuota(null), []);
});

test('getAgyQuota：从 acp 日志取最后一次 HTTP 端口并请求；没跑时回 unavailable', async () => {
  _resetAgyQuotaForTest();
  let body = null;
  const srv = createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => {
      body = { url: req.url, json: JSON.parse(s || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(SAMPLE));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-quota-'));
  const log = path.join(dir, 'acp.log');
  writeFileSync(log, `I1 Language server listening on random port at 1 for HTTP\nI2 Language server listening on random port at 2 for HTTPS\nI3 Language server listening on random port at ${port} for HTTP\n`);
  try {
    const idle = await getAgyQuota({ status: () => ({ running: false, pid: null, logFile: log }) });
    assert.equal(idle.error, 'unavailable');
    const client = { status: () => ({ running: true, pid: 4242, logFile: log }) };
    const q = await getAgyQuota(client);
    assert.equal(q.error, null);
    assert.equal(q.buckets.length, 4);
    assert.match(body.url, /RetrieveUserQuotaSummary$/);
    assert.deepEqual(body.json, {});
    await getAgyQuota(client, { force: true });
    assert.deepEqual(body.json, { forceRefresh: true });
    await getAgyQuota(client, { force: true });   // 30s 内再强刷 → 降级为读缓存
    assert.deepEqual(body.json, {});
  } finally {
    srv.close();
  }
});
