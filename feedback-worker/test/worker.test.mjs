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

// —— Muse Bridge 网页经 bridge 反馈通道推来的（/v1/cb/report，distro: 'muse'）→ 转成 Muse 的报告开 Issue ——
const cbPost = (body) => new Request('https://w.test/v1/cb/report', { method: 'POST', body: JSON.stringify(body) });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]).toString('base64');
const cbBase = (o = {}) => ({
  v: 1, install: 'cb-install-muse-0001', text: '工作空间里重命名中文文件夹报 500\n第二行细节', screen: 'settings-desktop',
  version: '6.75 (488)', platform: 'linux', arch: 'x64', node: 'v24.22.1', os: 'Linux 6.8.0', role: 'user', lang: 'zh', distro: 'muse', ...o,
});

test('Muse 的网页反馈（distro=muse）→ 开 Issue：不进收件箱、不要 INBOX_TOKEN；图片不公开只记个数；脱敏', async () => {
  const gh = fakeGitHub(); const kv = memKV();
  const handle = createHandler({ fetch: gh.fetch });
  const r = await handle(cbPost(cbBase({
    text: '设置页打不开，我的 key sk-ant-api03-ABCDEFGHIJKLMNOPQRST123\n第二行',
    attachments: [{ type: 'image/png', data: png }], omitted: 1,
  })), env(kv));   // env 里没有 INBOX_TOKEN
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { ok: true, issue: { number: 1, url: 'https://github.com/o/r/issues/1' } });
  const it = gh.issues.get(1);
  assert.equal(it.title, '[Feedback] 设置页打不开，我的 key <secret>');
  assert.deepEqual(it.labels, ['from-muse'], '网页反馈分不出 bug / 建议，只打来源标签');
  assert.match(it.body, /reported from the web UI · Muse Bridge 6\.75 \(488\)/);
  assert.match(it.body, /Screen: settings-desktop · Submitted by a member · 2 attachments kept on that server/);
  assert.ok(!it.body.includes('ABCDEFGHIJ'), '令牌被抹掉');
  assert.ok(!it.body.includes(png.slice(0, 12)), '图片不进 Issue');
  assert.ok(![...kv.m.keys()].some((k) => k.startsWith('cbi:')), '不进 bridge 开发者的收件箱');
  assert.ok(kv.m.has(`rl:${new Date().toISOString().slice(0, 10)}:i:cb-install-muse-0001`), '限流记在 Muse 那边');
});

test('Muse 网页里 Claude 诊断后上报 → [Bug]，标题取「【经 Claude 诊断后上报】」那一行', async () => {
  const gh = fakeGitHub();
  const handle = createHandler({ fetch: gh.fetch });
  const text = '【经 Claude 诊断后上报】工作空间里重命名中文文件夹报 500\n\n用户点重命名后弹红字。\n\n相关日志 / 报错：\n```\nTypeError: x is not a function\n```';
  assert.equal((await handle(cbPost(cbBase({ text, screen: 'Claude 页 › 工作空间', role: 'admin' })), env(memKV()))).status, 200);
  const it = gh.issues.get(1);
  assert.equal(it.title, '[Bug] 工作空间里重命名中文文件夹报 500');
  assert.deepEqual(it.labels, ['from-muse', 'bug']);
  assert.match(it.body, /diagnosed by Claude in the web UI/);
  assert.match(it.body, /用户点重命名后弹红字/);
  assert.ok(!it.body.includes('【经 Claude 诊断后上报】'), '前缀不留在正文里');
  assert.match(it.body, /Submitted by the server admin/);
});

test('Muse 的同一份反馈补发 → 落回同一个 Issue，不给自己 +1；别的装机同样文字另开', async () => {
  const gh = fakeGitHub(); const kv = memKV();
  const handle = createHandler({ fetch: gh.fetch });
  const j1 = await (await handle(cbPost(cbBase()), env(kv))).json();
  const j2 = await (await handle(cbPost(cbBase()), env(kv))).json();
  assert.equal(j2.ok, true);
  assert.equal(j2.duplicate, true);
  assert.equal(j2.issue.number, j1.issue.number);
  assert.equal(gh.issues.get(1).comments.length, 0, '补发不算 +1');
  await handle(cbPost(cbBase({ install: 'cb-install-muse-0002' })), env(kv));
  assert.equal(gh.issues.size, 2, '网页反馈没有报错指纹可比，不跨装机合并');
});

test('Muse 的反馈：每台装机每天的上限按 Muse 的 PER_INSTALL_DAILY；停收 503；空报告 400', async () => {
  const gh = fakeGitHub(); const kv = memKV();
  const handle = createHandler({ fetch: gh.fetch });
  const e = env(kv, { PER_INSTALL_DAILY: '1' });
  assert.equal((await handle(cbPost(cbBase({ text: '第一份' })), e)).status, 200);
  assert.equal((await handle(cbPost(cbBase({ text: '第二份' })), e)).status, 429);
  assert.ok(![...kv.m.keys()].some((k) => k.includes(':cb:')), '不占 bridge 收件箱的计数');
  assert.equal((await handle(cbPost(cbBase()), env(memKV(), { PAUSED: '1' }))).status, 503);
  assert.equal((await handle(cbPost(cbBase({ text: '' })), env(memKV()))).status, 400);
});

test('不带 distro（bridge 本体）照旧进收件箱、不碰 GitHub；没登记的 distro 也进收件箱并带上 distro', async () => {
  const noGitHub = async () => { throw new Error('github must not be called'); };
  const handle = createHandler({ fetch: noGitHub });
  const kv = memKV();
  const e = env(kv, { INBOX_TOKEN: 'tok-0123456789' });
  const { distro: _d, ...plain } = cbBase();
  assert.equal((await handle(cbPost(plain), e)).status, 200);
  assert.equal((await handle(cbPost(cbBase({ distro: 'other-distro' })), e)).status, 200);
  const stored = [...kv.m.entries()].filter(([k]) => k.startsWith('cbi:')).map(([, v]) => JSON.parse(v).report);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((x) => x.distro || ''), ['', 'other-distro']);
  // 没配收件箱时，本体的照旧 503（对方留着补发）
  assert.equal((await handle(cbPost(plain), env(memKV()))).status, 503);
});

test('建 Issue 时 labels 被 GitHub 丢掉 → 单独补上', async () => {
  const gh = fakeGitHub({ dropLabels: true });
  const handle = createHandler({ fetch: gh.fetch });
  await handle(post(base()), env(memKV()));
  assert.deepEqual(gh.issues.get(1).labels, ['from-muse', 'bug']);
});
