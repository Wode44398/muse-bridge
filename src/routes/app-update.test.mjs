// 「关于与更新 / 连接」几个接口的契约（单 agent 模式的设置、App 的地址自愈在吃它们）：
//   /api/app/version     —— 登录前也能查；apk 没出包时 available=false（客户端据此不提示下载），带服务端版本与对齐策略
//   /api/app/server-info —— 只给已登录身份；公网地址 / 地址簿 / 形态 / 运行时长，绝不带任何凭据（公钥不是凭据）
//   /api/app/hello       —— 无鉴权；对随机数签名，用 server-info 给的公钥验得过
//   /download/android    —— 单人服务器免登录、多人服务器要登录；没有包时回一页人话
//   /api/app/caps        —— 无鉴权；桌面客户端能力声明，只有布尔，不带状态与凭据
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-appupdate-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_APK_FEED = '';   // 不去问公开发布页（单测不出网）

const { registerAppUpdateRoutes, lanCandidates } = await import('./app-update.mjs');
const { FEATURES } = await import('../config/index.mjs');
const { APP_VERSION_CODE } = await import('../config/versions.mjs');
const { helloMessage } = await import('../runtime/server-address.mjs');

function routes(kind, extra = {}) {
  const h = {};
  const router = { on: (method, p, fn) => { h[method + ' ' + p] = fn; } };
  registerAppUpdateRoutes(router, { authOk: () => kind === 'admin', identify: () => ({ kind }), ...extra });
  return (method, p, reqHeaders = {}) => {
    let status = 0, body = '', headers = {};
    const res = { writeHead(s, hh) { status = s; headers = hh || {}; }, end(chunk) { body = chunk || ''; }, setHeader() {}, on() {}, once() {} };
    const pathname = p.split('?')[0];
    h[method + ' ' + pathname]({ headers: reqHeaders, url: p, method }, res, new URL('http://x' + p));
    let json = null;
    try { json = body && /json/.test(headers['Content-Type'] || '') ? JSON.parse(body) : null; } catch {}
    return { status, json, body: String(body || ''), headers };
  };
}

test('server-info：没登录 401，登录了给形态 / 运行时长 / 地址簿，不带令牌类字段', () => {
  assert.equal(routes('none')('GET', '/api/app/server-info').status, 401);
  assert.equal(routes('share')('GET', '/api/app/server-info').status, 401);
  for (const kind of ['user', 'admin']) {
    const r = routes(kind)('GET', '/api/app/server-info');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.multiUser, 'boolean');
    assert.equal(typeof r.json.server.uptimeSec, 'number');
    assert.equal(typeof r.json.app.code, 'number');
    const a = r.json.address;
    assert.match(a.id, /^srv_[0-9a-f]{20}$/);
    assert.ok(['temporary', 'fixed', 'none'].includes(a.kind));
    // 公钥只有公开部分（JWK 的 d 是私钥）；它本来就是给设备验签用的，不是凭据——下面的凭据扫描把它排除在外，
    // 不然随机的坐标值里偶尔会撞出 key / token 这几个字母
    assert.deepEqual(Object.keys(a.pub).sort(), ['crv', 'kty', 'x', 'y']);
    const rest = JSON.stringify({ ...r.json, address: { ...a, pub: undefined, fp: undefined } });
    assert.doesNotMatch(rest, /token|secret|password|key|privat/i);
  }
});

test('server-info：局域网候选只给管理员', () => {
  const lanIPs = () => ['192.168.1.20'];
  const admin = routes('admin', { lanIPs })('GET', '/api/app/server-info').json.address;
  assert.ok(Array.isArray(admin.lan) && /^http:\/\/192\.168\.1\.20:\d+$/.test(admin.lan[0]));
  const user = routes('user', { lanIPs })('GET', '/api/app/server-info').json.address;
  assert.equal(user.lan, undefined);
});

test('局域网候选：只听回环 / 跑在容器里不给；听具体地址只给它；只给私网地址', () => {
  const lanIPs = () => ['192.168.1.20', '203.0.113.7', '10.0.0.5'];
  assert.deepEqual(lanCandidates(lanIPs, { bind: '0.0.0.0', port: 8787, inContainer: false }), ['http://192.168.1.20:8787', 'http://10.0.0.5:8787']);
  assert.deepEqual(lanCandidates(lanIPs, { bind: '127.0.0.1', port: 8787, inContainer: false }), [], '桌面本机服务端关了「允许局域网」');
  assert.deepEqual(lanCandidates(lanIPs, { bind: '::1', port: 8787, inContainer: false }), []);
  assert.deepEqual(lanCandidates(lanIPs, { bind: '0.0.0.0', port: 8787, inContainer: true }), [], '容器里的网卡地址手机路由不到');
  assert.deepEqual(lanCandidates(lanIPs, { bind: '192.168.1.20', port: 9000, inContainer: false }), ['http://192.168.1.20:9000']);
  assert.deepEqual(lanCandidates(() => ['203.0.113.7'], { bind: '0.0.0.0', port: 8787, inContainer: false }), [], 'VPS 的公网网卡不算局域网');
});

test('局域网候选：不传 bind 时按服务端实际监听地址（LISTEN_HOST），不是只看 BRIDGE_HOST', async () => {
  const { LISTEN_HOST } = await import('../config/index.mjs');
  const lanIPs = () => ['192.168.1.20'];
  assert.deepEqual(lanCandidates(lanIPs, { port: 8787, inContainer: false }), lanCandidates(lanIPs, { bind: LISTEN_HOST, port: 8787, inContainer: false }));
});

test('hello：无鉴权；对随机数 + id + Host 签名，用 server-info 的公钥验得过；随机数不合规只报 id', () => {
  const info = routes('admin')('GET', '/api/app/server-info').json.address;
  const nonce = 'n0nce-' + 'a'.repeat(20);
  const h = routes('none')('GET', '/api/app/hello?n=' + nonce, { host: 'ABC.trycloudflare.com' });
  assert.equal(h.status, 200);
  assert.equal(h.json.id, info.id);
  assert.equal(h.json.v, 2);
  const key = createPublicKey({ key: info.pub, format: 'jwk' });
  const ok = (msg) => verify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(h.json.sig, 'base64url'));
  assert.equal(ok(helloMessage(nonce, info.id, 'abc.trycloudflare.com')), true, '设备按自己访问的地址验（大小写不敏感）');
  assert.equal(ok(helloMessage(nonce, info.id, 'abc.trycloudflare.com:443')), true, '默认端口不算差别');
  // 换个 id 签名就对不上（签名绑着服务器 id）
  assert.equal(ok(helloMessage(nonce, 'srv_other', 'abc.trycloudflare.com')), false);
  // 经别的地址转发过来的（服务端看到的 Host 不是设备访问的那个）对不上
  assert.equal(ok(helloMessage(nonce, info.id, 'evil.example.com')), false);
  // X-Forwarded-Host 不算数（经 Cloudflare 转发时谁都能塞）
  const fw = routes('none')('GET', '/api/app/hello?n=' + nonce, { host: 'real.example.com', 'x-forwarded-host': 'evil.example.com' });
  assert.equal(fw.json.host, 'real.example.com');
  const bad = routes('none')('GET', '/api/app/hello?n=<script>');
  assert.equal(bad.json.id, info.id);
  assert.equal(bad.json.sig, undefined);
});

test('caps：登录前可查；全是布尔，客户端认的几项都在', () => {
  const r = routes('none')('GET', '/api/app/caps');
  assert.equal(r.status, 200);
  assert.equal(r.json.app, 'bridge');
  assert.equal(r.json.v, 1);
  for (const k of ['wco', 'quick', 'devices', 'pair', 'clientUpdates', 'addressFollow', 'desktopUi']) {
    assert.equal(typeof r.json.caps[k], 'boolean', k);
  }
  assert.ok(Object.values(r.json.caps).every((v) => typeof v === 'boolean'));
});

test('version：登录前可查；带 available 布尔、服务端版本与对齐策略', () => {
  const r = routes('none')('GET', '/api/app/version');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.code, 'number');
  assert.equal(typeof r.json.available, 'boolean');
  assert.equal(r.json.server.code, APP_VERSION_CODE);
  assert.equal(r.json.policy, 'same-or-older');
  assert.equal(r.json.pageUrl, '/download/android');
  assert.ok(r.json.code <= APP_VERSION_CODE, '只发版本号不超过服务端的包');
  if (!r.json.available) assert.equal(r.json.source, 'none');
});

test('/download/android：多人服务器要登录；没有包时是一页人话而不是空白', () => {
  if (FEATURES.multiUser) assert.equal(routes('none')('GET', '/download/android').status, 401);
  const v = routes('none')('GET', '/api/app/version').json;
  // 有包时走流式发送（这里的假 res 接不住）；发哪一份由 apk-source 的单测覆盖
  if (v.available) return;
  const got = routes(FEATURES.multiUser ? 'user' : 'none')('GET', '/download/android');
  assert.equal(got.status, 404);
  assert.match(got.body, /没有可发的 App 版本|no app build/);
});
