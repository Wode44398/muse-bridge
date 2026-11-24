import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeQuota, getAgyQuota, findLanguageServerPort, _resetAgyQuotaForTest } from './quota.mjs';
import { listWorkerLogFiles, cleanupWorkerLogFiles } from './acp/binary.mjs';

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

test('getAgyQuota 与 worker 日志发现：--process-per-session 下优先读 worker 1 日志端口且启动前清理残留碎片', async () => {
  _resetAgyQuotaForTest();
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SAMPLE));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port1 = srv.address().port;
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-quota-pps-'));
  const frontLog = path.join(dir, 'acp.log');
  const w1Log = `${frontLog}.10001`;
  const w2Log = `${frontLog}.10002`;
  try {
    // 刚启动 front 还没有 worker 时返回 null，且不能锁死后续查找
    writeFileSync(frontLog, 'I1 Starting ACP front (pid 9000, isJetski=false)\n');
    const client = { status: () => ({ running: true, pid: 9000, logFile: frontLog }) };
    assert.equal(findLanguageServerPort(client), null);

    // 随后 front 派生出 worker 1（常驻 list）与 worker 2（会话），worker 1 日志优先命中
    writeFileSync(
      frontLog,
      [
        'I1 Starting ACP front (pid 9000, isJetski=false)',
        'I2 front: started worker 1 (pid 10001)',
        'I3 front: started worker 2 (pid 10002)',
      ].join('\n') + '\n',
    );
    writeFileSync(w1Log, `I1 Language server listening on random port at ${port1} for HTTP\n`);
    writeFileSync(w2Log, 'I1 Language server listening on random port at 19999 for HTTP\n');

    assert.deepEqual(listWorkerLogFiles(frontLog), [w1Log, w2Log]);
    assert.equal(findLanguageServerPort(client), port1);

    const q = await getAgyQuota(client);
    assert.equal(q.error, null);
    assert.equal(q.buckets.length, 4);

    // 清理只删 `<logBase>.<数字>`，不删主日志和无关文件
    const keepFile = path.join(dir, 'acp.log.keep');
    writeFileSync(keepFile, 'keep');
    const removed = cleanupWorkerLogFiles(frontLog);
    assert.equal(removed, 2);
    assert.equal(existsSync(w1Log), false);
    assert.equal(existsSync(w2Log), false);
    assert.equal(existsSync(frontLog), true);
    assert.equal(existsSync(keepFile), true);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
