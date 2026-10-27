// 服务器身份与地址簿（runtime/server-address.mjs）：身份跨重启不变、私钥只在 0600 文件里、hello 签名可验、
// 地址种类判定、最近地址去重、地址变化事件（同一地址不重复推；先接后拆的 next 照推）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-srvaddr-'));
process.env.BRIDGE_DATA_ROOT = tmp;
const sa = await import('./server-address.mjs');

test('纯函数：地址种类、随机数、最近地址', () => {
  assert.equal(sa.classifyOrigin('https://abc-def.trycloudflare.com'), 'temporary');
  assert.equal(sa.classifyOrigin('https://bridge.example.com'), 'fixed');
  assert.equal(sa.classifyOrigin('https://bridge.example.com', 'quick'), 'temporary');
  assert.equal(sa.classifyOrigin(''), 'none');
  assert.equal(sa.cleanNonce('short'), '');
  assert.equal(sa.cleanNonce('a'.repeat(16)), 'a'.repeat(16));
  assert.equal(sa.cleanNonce('a'.repeat(15) + '/'), '');
  assert.deepEqual(sa.pushRecent(['b', 'a'], 'a'), ['a', 'b']);
  assert.deepEqual(sa.pushRecent(['1', '2', '3'], '4', 3), ['4', '1', '2']);
});

test('身份：首次生成并落 0600 文件；换个实例读回同一个 id 与公钥；hello 签名用公钥验得过', () => {
  const dataRoot = path.join(tmp, 'a');
  const a = sa.createServerAddress({ dataRoot });
  const s1 = a.snapshot({ publicOrigin: 'https://x.trycloudflare.com' });
  assert.match(s1.id, /^srv_[0-9a-f]{20}$/);
  assert.equal(s1.kind, 'temporary');
  assert.equal(s1.pub.d, undefined, '快照里只有公钥');
  const raw = JSON.parse(readFileSync(a.file, 'utf8'));
  assert.match(raw.privateKey, /BEGIN PRIVATE KEY/);
  if (process.platform !== 'win32') assert.equal(statSync(a.file).mode & 0o777, 0o600);
  const b = sa.createServerAddress({ dataRoot });
  const s2 = b.snapshot({});
  assert.equal(s2.id, s1.id);
  assert.deepEqual(s2.pub, s1.pub);
  const nonce = 'Zz' + 'q'.repeat(30);
  const h = b.hello(nonce, '192.168.1.5:8787');
  const key = createPublicKey({ key: s1.pub, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(sa.helloMessage(nonce, s1.id, '192.168.1.5:8787')), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(h.sig, 'base64url')), true);
  // 签名绑着 Host：同一个随机数换个地址验不过（经别的地址转发过来的 hello 拿去冒充不了）
  assert.equal(verify('sha256', Buffer.from(sa.helloMessage(nonce, s1.id, '192.168.1.9:8787')), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(h.sig, 'base64url')), false);
  // 别的服务器（另一份身份）签的过不了这把公钥
  const other = sa.createServerAddress({ dataRoot: path.join(tmp, 'b') }).hello(nonce, '192.168.1.5:8787');
  assert.equal(verify('sha256', Buffer.from(sa.helloMessage(nonce, s1.id, '192.168.1.5:8787')), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(other.sig, 'base64url')), false);
});

test('Host 规范写法：小写、去末尾的点和默认端口；签名原文带版本号 v2', () => {
  assert.equal(sa.normalizeHelloHost('ABC.TryCloudflare.com.'), 'abc.trycloudflare.com');
  assert.equal(sa.normalizeHelloHost('bridge.example.com:443'), 'bridge.example.com');
  assert.equal(sa.normalizeHelloHost('192.168.1.5:80'), '192.168.1.5');
  assert.equal(sa.normalizeHelloHost('192.168.1.5:8787'), '192.168.1.5:8787');
  assert.equal(sa.normalizeHelloHost('[::1]:8787'), '[::1]:8787');
  assert.equal(sa.helloMessage('n', 'srv_x', 'A.com:443'), 'bridge-hello:v2:n:srv_x:a.com');
});

test('地址变化事件：同一地址不重复推；next（先接后拆）照推且记进最近地址；最近地址跨实例保留', () => {
  const dataRoot = path.join(tmp, 'c');
  const a = sa.createServerAddress({ dataRoot });
  const e1 = a.noteOrigin('https://one.trycloudflare.com', { mode: 'quick' });
  assert.equal(e1.type, 'server.address');
  assert.equal(e1.publicOrigin, 'https://one.trycloudflare.com');
  assert.equal(e1.kind, 'temporary');
  assert.equal(a.noteOrigin('https://one.trycloudflare.com'), null, '同一地址不重复推');
  const e2 = a.noteOrigin('https://two.trycloudflare.com', { mode: 'quick', next: true });
  assert.equal(e2.next, 'https://two.trycloudflare.com');
  assert.equal(e2.publicOrigin, '');
  const e3 = a.noteOrigin('https://two.trycloudflare.com', { mode: 'quick' });
  assert.equal(e3.publicOrigin, 'https://two.trycloudflare.com', '转正时照样推一次');
  const snap = sa.createServerAddress({ dataRoot }).snapshot({ publicOrigin: 'https://two.trycloudflare.com' });
  assert.deepEqual(snap.recent, ['https://one.trycloudflare.com'], '最近地址里不含当前地址');
  assert.equal(a.noteOrigin(''), null);
});
