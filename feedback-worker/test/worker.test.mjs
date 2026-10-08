// 反馈 Worker：用假的 GitHub 接口 + 内存 KV 跑一遍（真的 RSA 私钥签 JWT，用公钥验签）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createHandler, appJwt } from '../src/worker.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },   // GitHub 下载下来的就是 PKCS#1
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function memKV() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); } };
}

function fakeGitHub({ dropLabels = false } = {}) {
  const issues = new Map();   // number -> { number, state, body, html_url, comments: [] }
  const calls = [];
  let next = 1;
  const advisories = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname + u.search, auth: init.headers?.Authorization });
    const res = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/app/installations/169122168/access_tokens' && method === 'POST') {
      // 验 JWT：RS256、公钥验签、iss = App ID
      const [h, p, s] = init.headers.Authorization.replace('Bearer ', '').split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      if (!ok || claims.iss !== '5233123') return res(401, { message: 'bad jwt' });
      return res(201, { token: 'ghs_installtoken', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (init.headers?.Authorization !== 'Bearer ghs_installtoken') return res(401, { message: 'no token' });
    let m;
    if (u.pathname === '/repos/o/r/issues' && method === 'POST') {
      const n = next++;
      const it = { number: n, state: 'open', title: body.title, body: body.body, labels: dropLabels ? [] : body.labels, html_url: `https://github.com/o/r/issues/${n}`, comments: [] };
      issues.set(n, it);
      return res(201, it);
    }
    if ((m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/)) && method === 'GET') {
      const it = issues.get(+m[1]);
      return it ? res(200, it) : res(404, {});
    }
    if ((m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/)) && method === 'POST') {
      issues.get(+m[1]).labels.push(...body.labels);
      return res(200, []);
    }
    if ((m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/)) && method === 'POST') {
      issues.get(+m[1]).comments.push(body.body);
      return res(201, { id: 1 });
    }
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q');
      const fp = (q.match(/"([0-9a-f]{12})"/) || [])[1];
      return res(200, { items: [...issues.values()].filter((it) => fp && it.body.includes(fp)) });
    }
    if (u.pathname === '/repos/o/r/security-advisories/reports' && method === 'POST') {
      advisories.push(body);
      return res(201, { ghsa_id: 'GHSA-xxxx' });
    }
    return res(404, { message: 'unhandled ' + method + ' ' + u.pathname });
  };
  return { fetch, issues, calls, advisories };
}

const env = (kv, extra = {}) => ({
  GITHUB_REPO: 'o/r', GITHUB_APP_ID: '5233123', GITHUB_INSTALLATION_ID: '169122168',
  GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_API: 'https://gh.test', FEEDBACK_KV: kv, ...extra,
});
const post = (body) => new Request('https://w.test/v1/report', { method: 'POST', body: JSON.stringify(body) });
const base = (o = {}) => ({ install: 'install-aaaa-1111', kind: 'bug', source: 'web', description: '上传卡在 0%', env: { version: 'abc1234 2026-10-08' }, ...o });

test('JWT：PKCS#1 私钥能签、公钥能验', async () => {
  const jwt = await appJwt('5233123', privateKey, 1_800_000_000);
  const [h, p, s] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, '5233123');
});

test('新问题 → 开 Issue；同指纹别的装机 → +1 一次；同一台再报不重复 +1', async () => {
  const gh = fakeGitHub(); const kv = memKV();
  const handle = createHandler({ fetch: gh.fetch });
  const crash = (install) => base({ install, kind: 'crash', fp: '0123456789ab', description: '',
    errors: [{ fp: '0123456789ab', type: 'TypeError', message: 'x is not a function', frames: ['f (src/a.mjs)'] }] });

  let r = await handle(post(crash('install-aaaa-1111')), env(kv));
  let j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j, { ok: true, issue: { number: 1, url: 'https://github.com/o/r/issues/1' } });
  assert.match(gh.issues.get(1).title, /^\[Crash\] TypeError/);
  assert.deepEqual(gh.issues.get(1).labels, ['from-muse', 'bug']);

  r = await handle(post(crash('install-bbbb-2222')), env(kv));
  j = await r.json();
  assert.equal(j.duplicate, true);
  assert.equal(j.issue.number, 1);
  assert.equal(gh.issues.get(1).comments.length, 1);
  assert.match(gh.issues.get(1).comments[0], /^\+1/);

  await handle(post(crash('install-bbbb-2222')), env(kv));
  assert.equal(gh.issues.get(1).comments.length, 1, '同一台装机只 +1 一次');
  assert.equal(gh.issues.size, 1);
});

test('KV 里没有映射时，靠搜索找回已有 Issue', async () => {
  const gh = fakeGitHub();
  const handle = createHandler({ fetch: gh.fetch });
  const rep = base({ fp: 'aaaaaaaaaaaa', errors: [{ fp: 'aaaaaaaaaaaa', type: 'Error', message: 'boom' }] });
  await handle(post(rep), env(memKV()));
  const j = await (await handle(post({ ...rep, install: 'install-cccc-3333' }), env(memKV()))).json();
  assert.equal(j.duplicate, true);
});

test('原 Issue 已关闭 → 开新的，注明可能是回归', async () => {
  const gh = fakeGitHub(); const kv = memKV();
  const handle = createHandler({ fetch: gh.fetch });
  const rep = base({ fp: 'bbbbbbbbbbbb', errors: [{ fp: 'bbbbbbbbbbbb', type: 'Error', message: 'boom' }] });
  await handle(post(rep), env(kv));
  gh.issues.get(1).state = 'closed';
  const j = await (await handle(post({ ...rep, install: 'install-dddd-4444' }), env(kv))).json();
  assert.equal(j.issue.number, 2);
  assert.match(gh.issues.get(2).body, /regression of #1/);
});

test('安全问题 → 私密漏洞报告，不开公开 Issue', async () => {
  const gh = fakeGitHub();
  const handle = createHandler({ fetch: gh.fetch });
  const j = await (await handle(post(base({ kind: 'security', description: '普通账号能读到别人的文件' })), env(memKV()))).json();
  assert.deepEqual(j, { ok: true, private: true });
  assert.equal(gh.issues.size, 0);
  assert.equal(gh.advisories.length, 1);
});

test('白名单与脱敏在 Worker 这边再过一遍', async () => {
  const gh = fakeGitHub();
  const handle = createHandler({ fetch: gh.fetch });
  await handle(post(base({ description: '我的 key sk-ant-api03-ABCDEFGHIJKLMNOPQRST123 用不了', chats: ['不该出现'] })), env(memKV()));
  const body = gh.issues.get(1).body;
  assert.ok(!body.includes('ABCDEFGHIJ'));
  assert.ok(!body.includes('不该出现'));
});

test('坏请求、限流、停收', async () => {
  const gh = fakeGitHub(); const kv = memKV();
  const handle = createHandler({ fetch: gh.fetch });
  assert.equal((await handle(post({ kind: 'nope' }), env(kv))).status, 400);
  assert.equal((await handle(new Request('https://w.test/v1/report', { method: 'POST', body: 'x'.repeat(70_000) }), env(kv))).status, 413);
  assert.equal((await handle(new Request('https://w.test/v1/report'), env(kv))).status, 405);
  // 每台装机每天 2 份
  const e = env(kv, { PER_INSTALL_DAILY: '2' });
  for (let i = 0; i < 2; i++) assert.equal((await handle(post(base({ description: `问题 ${i}` })), e)).status, 200);
  assert.equal((await handle(post(base({ description: '第三份' })), e)).status, 429);
  // 停收：503（客户端存着之后补发）
  assert.equal((await handle(post(base()), env(memKV(), { PAUSED: '1' }))).status, 503);
  const kv2 = memKV(); await kv2.put('cfg:paused', '1');
  assert.equal((await handle(post(base()), env(kv2))).status, 503);
  const h = await (await handle(new Request('https://w.test/v1/health'), env(memKV()))).json();
  assert.equal(h.ok, true);
});

test('GitHub 出错 → 502（客户端会存着补发）', async () => {
  const handle = createHandler({ fetch: async () => new Response('{}', { status: 500 }) });
  assert.equal((await handle(post(base()), env(memKV()))).status, 502);
});

test('建 Issue 时 labels 被 GitHub 丢掉 → 单独补上', async () => {
  const gh = fakeGitHub({ dropLabels: true });
  const handle = createHandler({ fetch: gh.fetch });
  await handle(post(base()), env(memKV()));
  assert.deepEqual(gh.issues.get(1).labels, ['from-muse', 'bug']);
});
