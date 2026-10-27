// 桌面客户端更新分发（runtime/client-release.mjs）：上游更新源（S10）、R10 发文件时文件被换掉不挂死；
// 以及号池写入（S4）：set-auth 的 applyClaudeToken、加号时激活号没令牌就自动激活新号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-clientrel-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.BRIDGE_CLIENT_DIST;
delete process.env.BRIDGE_CLIENT_UPDATE_FEED;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// 本机登录态（~/.claude/.credentials.json）会影响「加号自动激活」：指到空目录，结果不随跑测试那台机器变
const claudeCfg = path.join(tmp, 'claude-cfg');
mkdirSync(claudeCfg, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeCfg;

const cr = await import('./runtime/client-release.mjs');
const { applyClaudeToken } = await import('./set-auth.mjs');

const SHA = 'a'.repeat(64);
const upstream = (version, extra = {}) => ({ version, file: `bridge-client-setup-${version}.exe`, size: 10, sha256: SHA, mirrors: [`https://example.com/${version}.exe`], notes: 'n', ...extra });
const fakeFetch = (obj, status = 200) => async () => ({ ok: status === 200, status, text: async () => JSON.stringify(obj) });
const dist = path.join(tmp, 'client-dist');

test('上游源：默认公开发布仓库；显式 clientDist（发版机）默认不问；env 可开可关', () => {
  assert.equal(cr.clientFeedUrl(), cr.DEFAULT_CLIENT_FEED);
  process.env.BRIDGE_CLIENT_DIST = dist;
  assert.equal(cr.clientFeedUrl(), '', '发版机本地就是源头');
  process.env.BRIDGE_CLIENT_UPDATE_FEED = 'https://mirror.example.com/latest.json';
  assert.equal(cr.clientFeedUrl(), 'https://mirror.example.com/latest.json');
  process.env.BRIDGE_CLIENT_UPDATE_FEED = '';
  assert.equal(cr.clientFeedUrl(), '');
  process.env.BRIDGE_CLIENT_UPDATE_FEED = 'http://insecure.example.com/x.json';
  assert.equal(cr.clientFeedUrl(), '', '只认 https');
  delete process.env.BRIDGE_CLIENT_UPDATE_FEED;
  delete process.env.BRIDGE_CLIENT_DIST;
});

test('上游清单只收认得出的字段：缺 sha256 / 没有 https 镜像的不发', () => {
  assert.equal(cr.sanitizeManifest({ ...upstream('2026.10.1.1'), sha256: 'x' }), null);
  assert.equal(cr.sanitizeManifest({ ...upstream('2026.10.1.1'), mirrors: ['http://x/y.exe'] }), null);
  assert.equal(cr.sanitizeManifest({ ...upstream('v1') }), null);
  const m = cr.sanitizeManifest({ ...upstream('2026.10.1.1'), evil: 1, file: '../../x.exe', modules: { vertex: { file: 'v.zip', sha256: SHA, mirrors: ['https://e/v.zip'] }, Bad: {} } });
  assert.equal(m.evil, undefined);
  assert.equal(m.file, 'x.exe');
  assert.deepEqual(Object.keys(m.modules), ['vertex']);
});

test('本地清单缺失或更旧时发上游的；一样新或更新用本地', async () => {
  rmSync(dist, { recursive: true, force: true });
  await cr.refreshClientFeed({ force: true, fetchImpl: fakeFetch(upstream('2026.10.21.1200')) });
  let r = cr.clientRelease();
  assert.equal(r.version, '2026.10.21.1200');
  assert.equal(r.source, 'upstream');
  assert.equal(r.downloadPath, '', '上游清单只给镜像，本机没有文件可兜底');
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'bridge-client-setup-2026.10.21.1111.exe'), 'x'.repeat(10));
  writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ ...upstream('2026.10.21.1111'), downloadPath: '/client/download' }));
  r = cr.clientRelease();
  assert.equal(r.version, '2026.10.21.1200', '本地更旧 → 上游');
  writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ ...upstream('2026.10.21.1200'), file: 'bridge-client-setup-2026.10.21.1111.exe' }));
  r = cr.clientRelease();
  assert.equal(r.source, undefined, '一样新 → 本地');
  assert.ok(r.file.endsWith('.exe'));
  // 上游拉失败：保留上次拿到的清单
  await cr.refreshClientFeed({ force: true, fetchImpl: fakeFetch({}, 404) });
  assert.equal(cr._feedState().manifest.version, '2026.10.21.1200');
  assert.match(cr._feedState().error, /404/);
});

test('R10：发文件时文件没了 → 503 收尾，不挂死；正常时按 Range 发', async () => {
  const f = path.join(tmp, 'pkg.bin');
  writeFileSync(f, Buffer.alloc(1000, 7));
  const srv = http.createServer((req, res) => cr.streamClientFile(req, res, { file: req.url === '/gone' ? path.join(tmp, 'nope.bin') : f, size: 1000, version: 't' }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const gone = await fetch(base + '/gone', { signal: AbortSignal.timeout(5000) });
    assert.equal(gone.status, 503);
    const part = await fetch(base + '/ok', { headers: { Range: 'bytes=10-19' }, signal: AbortSignal.timeout(5000) });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('S4：set-auth 写号池（建池 / 填空号 / 激活已有 / 追加）', () => {
  let c = applyClaudeToken({}, 'tok-1').cfg;
  assert.equal(c.claudeAccounts.length, 1);
  assert.equal(c.claudeActiveAccount, c.claudeAccounts[0].id);
  assert.equal(c.oauthToken, 'tok-1');
  // 激活号没令牌（向导跳过 Claude 播种出来的空默认账号）→ 填进去
  c = { claudeAccounts: [{ id: 'a-1', label: '默认账号', token: '' }, { id: 'a-2', label: 'B', token: 'tok-b' }], claudeActiveAccount: 'a-1' };
  let r = applyClaudeToken(c, 'tok-new');
  assert.equal(r.action, 'filled');
  assert.equal(c.claudeAccounts[0].token, 'tok-new');
  assert.equal(c.claudeActiveAccount, 'a-1');
  // 池里已有 → 激活那个号
  r = applyClaudeToken(c, 'tok-b');
  assert.equal(r.action, 'activated');
  assert.equal(c.claudeActiveAccount, 'a-2');
  // 新令牌 → 追加并激活
  r = applyClaudeToken(c, 'tok-c');
  assert.equal(r.action, 'added');
  assert.equal(c.claudeAccounts.length, 3);
  assert.equal(c.claudeActiveAccount, r.id);
});

test('S4：经软链 / 目录联接的程序根直接跑 set-auth 也会写号池（入口判定先解析真实路径）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { symlinkSync, readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const link = path.join(tmp, 'src-link');
  symlinkSync(srcDir, link, 'junction');   // Windows 建目录联接不要管理员；别的平台就是普通软链
  const data = path.join(tmp, 'setauth-data');
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, BRIDGE_DATA_ROOT: data };
  delete env.ANTHROPIC_BASE_URL;
  const r = spawnSync(process.execPath, [path.join(link, 'set-auth.mjs'), '-'], { input: 'tok-via-link\n', env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已写入 Claude 号池/);
  assert.ok(existsSync(path.join(data, 'config.json')));
  const cfg = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8'));
  assert.equal(cfg.claudeAccounts.find((a) => a.id === cfg.claudeActiveAccount)?.token, 'tok-via-link');
  rmSync(link, { force: true, recursive: false });
});

test('S4：激活号没有令牌时，加号自动激活新号；激活号有令牌时不动；空令牌但本机 claude login 过也不动', async () => {
  const acc = await import('./runtime/claude-account.mjs');
  assert.equal(acc.activeToken(), '', '播种出的默认账号没有令牌');
  // 本机 claude login 过：空令牌的号 = 沿用本机登录态、在用订阅，加第二个号不把全局激活号静默切走
  const seededId = acc.activeAccountId();
  writeFileSync(path.join(claudeCfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-tok' } }));
  try {
    const r0 = acc.addAccount({ label: 'L', token: 'tok-l' });
    assert.equal(r0.active, undefined);
    assert.equal(acc.activeAccountId(), seededId);
  } finally { rmSync(path.join(claudeCfg, '.credentials.json'), { force: true }); }
  const r1 = acc.addAccount({ label: 'A', token: 'tok-a' });
  assert.equal(r1.active, r1.id);
  assert.equal(acc.activeToken(), 'tok-a');
  const r2 = acc.addAccount({ label: 'B', token: 'tok-b' });
  assert.equal(r2.active, undefined);
  assert.equal(acc.activeToken(), 'tok-a');
});
