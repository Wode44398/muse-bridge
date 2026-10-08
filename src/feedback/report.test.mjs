// 出草稿 → 发给（假的）Worker → 记录 / 进 outbox 补发；命令行入口也走一遍。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const DATA = mkdtempSync(path.join(tmpdir(), 'mb-feedback-'));
process.env.BRIDGE_DATA_ROOT = DATA;
process.env.BRIDGE_PUBLIC_ORIGIN = 'https://bridge.private-domain.test';

let server, port, mode = 'ok';
const received = [];
let R, S, E;

before(async () => {
  server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (mode === 'down') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"paused"}'); }
      if (mode === 'limit') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":"daily limit reached"}'); }
      received.push(JSON.parse(b));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, issue: { number: 40 + received.length, url: `https://github.com/o/r/issues/${40 + received.length}` } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  process.env.MUSE_FEEDBACK_URL = `http://127.0.0.1:${port}`;
  R = await import('./report.mjs');
  S = await import('./store.mjs');
  E = await import('./errors.mjs');
});
after(() => { server.close(); rmSync(DATA, { recursive: true, force: true }); });

test('草稿：带上服务端最近的报错、脱敏、抹掉自己的域名；发出去记进 sent', async () => {
  const err = new TypeError('boom at https://bridge.private-domain.test/x');
  err.stack = `TypeError: boom\n    at run (/srv/x/bridge/src/routes/chat.mjs:1:1)`;
  const e = await E.recordError('server', err);
  E.flushErrors();
  const d = R.makeDraft({ kind: 'bug', description: '在 bridge.private-domain.test 上点发送一直转圈', owner: 'admin' });
  assert.equal(d.payload.errors[0].fp, e.fp);
  assert.ok(!JSON.stringify(d.payload).includes('private-domain'));
  assert.match(d.preview.body, /<redacted>/);
  assert.match(d.preview.title, /^\[Bug\]/);
  assert.ok(S.loadDraft(d.id));

  const r = await R.sendDraft(d.id);
  assert.equal(r.status, 'sent');
  assert.equal(r.issue.number, 41);
  assert.equal(received.length, 1);
  assert.equal(received[0].install, S.installId());
  assert.equal(S.loadDraft(d.id), null, '发过的草稿就删掉');
  assert.equal(S.listSent().at(-1).owner, 'admin');
  assert.equal((await R.sendDraft(d.id)).status, 'missing');
});

test('Worker 不通 → 进 outbox，带预填链接；恢复后补发', async () => {
  mode = 'down';
  const d = R.makeDraft({ kind: 'idea', description: '希望能导出对话', withServerErrors: false });
  const r = await R.sendDraft(d.id);
  assert.equal(r.status, 'queued');
  assert.match(r.fallbackUrl, /^https:\/\/github\.com\/Wode44398\/muse-bridge\/issues\/new\?/);
  assert.equal(S.listOutbox().length, 1);
  mode = 'ok';
  const f = await R.flushOutbox();
  assert.equal(f[0].status, 'sent');
  assert.equal(S.listOutbox().length, 0);
});

test('Worker 明确拒收（限流）→ 不补发', async () => {
  mode = 'limit';
  const d = R.makeDraft({ kind: 'bug', description: 'x', withServerErrors: false });
  const r = await R.sendDraft(d.id);
  assert.equal(r.status, 'rejected');
  assert.equal(S.listOutbox().length, 0);
  mode = 'ok';
});

test('预填链接不会超长', () => {
  const d = R.makeDraft({ kind: 'bug', description: '很长的描述'.repeat(800), withServerErrors: false });
  assert.ok(R.fallbackUrl(d.payload).length <= 7600);
});

test('命令行：draft 打印预览和编号、send 发出去、auto 开关', async () => {
  // 假 Worker 跑在本进程里：子进程必须异步跑，同步等会把本进程的事件循环卡住
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const env = { ...process.env, UI_LANG: 'zh', HTTPS_PROXY: '', https_proxy: '' };
  const run = async (...a) => (await promisify(execFile)(process.execPath, [cli, ...a], { env, encoding: 'utf8' })).stdout;
  const input = path.join(DATA, 'in.json');
  writeFileSync(input, JSON.stringify({ kind: 'bug', description: '换了地址以后登录不上', services: { bridge: 'active' }, env: { tunnel: 'quick' } }));
  const out = await run('draft', input);
  assert.match(out, /问题报告草稿（还没发）/);
  assert.match(out, /换了地址以后登录不上/);
  const id = out.match(/DRAFT_ID=([a-z0-9]+)/)[1];
  const sent = await run('send', id);
  assert.match(sent, /已提交：https:\/\/github\.com\/o\/r\/issues\/\d+/);
  assert.match(await run('auto', 'on'), /自动上报：开/);
  assert.equal(S.getSettings().auto, true);
  const list = JSON.parse(await run('list', '--json'));
  assert.ok(list.sent.length >= 3);
  // 自动上报（看门狗）：不出预览，直接发
  writeFileSync(input, JSON.stringify({ kind: 'update_failed', source: 'auto', title: 'Update to v0.1.0-beta.12 failed', logs: ['Error: Cannot find module x'] }));
  const drafts = () => (existsSync(path.join(DATA, 'feedback', 'drafts')) ? readdirSync(path.join(DATA, 'feedback', 'drafts')).length : 0);
  const before = drafts();
  assert.match(await run('draft', input), /已提交/);
  assert.equal(drafts(), before, '自动上报发完不留草稿');
});
