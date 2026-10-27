import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectPayload, normalizeServerAddress, isPrivateHost, looksLikeCode, looksLikeDigits } from './connectPayload.js';

const ID = 'AbCdEfGhIjKl', SEC = 'MnOpQrStUvWxYz0123456789';

test('parseConnectPayload：服务端出的码原样解开', () => {
  const p = parseConnectPayload(`https://x.trycloudflare.com/?connect=${ID}.${SEC}&lan=192.168.1.5:8787,10.0.0.2:8787&sid=srv_0123456789abcdef0123`);
  assert.deepEqual(p, { origin: 'https://x.trycloudflare.com', id: ID, secret: SEC, lan: ['http://192.168.1.5:8787', 'http://10.0.0.2:8787'], sid: 'srv_0123456789abcdef0123' });
  assert.deepEqual(parseConnectPayload(`http://192.168.1.5:8787/?connect=${ID}.${SEC}`).lan, []);
});

test('parseConnectPayload：不是配对码 / 被改过的部分不认', () => {
  assert.equal(parseConnectPayload('https://x.example/?pair=abc.def'), null, '网页登录码不是配对码');
  assert.equal(parseConnectPayload(`ftp://x/?connect=${ID}.${SEC}`), null);
  assert.equal(parseConnectPayload(`https://x/?connect=${ID}`), null);
  assert.equal(parseConnectPayload(`https://x/?connect=${ID}.short`), null);
  assert.equal(parseConnectPayload('随便一段文字'), null);
  const p = parseConnectPayload(`https://x.example/?connect=${ID}.${SEC}&lan=8.8.8.8:80,evil.com:8787,192.168.9.9:8787&sid=srv_bad`);
  assert.deepEqual(p.lan, ['http://192.168.9.9:8787'], '局域网候选只收私网 IP');
  assert.equal(p.sid, '');
});

test('normalizeServerAddress：局域网补 http（裸 IP 补 :8787），其余补 https', () => {
  assert.equal(normalizeServerAddress('192.168.1.5'), 'http://192.168.1.5:8787');
  assert.equal(normalizeServerAddress('192.168.1.5:9000/'), 'http://192.168.1.5:9000');
  assert.equal(normalizeServerAddress('10.0.0.3:8787'), 'http://10.0.0.3:8787');
  assert.equal(normalizeServerAddress('bridge.example.com'), 'https://bridge.example.com');
  assert.equal(normalizeServerAddress('8.8.8.8'), 'https://8.8.8.8');
  assert.equal(normalizeServerAddress('https://a.trycloudflare.com/'), 'https://a.trycloudflare.com');
  assert.equal(normalizeServerAddress('http://192.168.1.5:8787/app/'), 'http://192.168.1.5:8787');
  assert.equal(normalizeServerAddress('https://'), '');
  assert.equal(normalizeServerAddress(''), '');
});

test('isPrivateHost / looksLikeCode', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '100.64.1.1', 'nas.local']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['8.8.8.8', '172.32.0.1', 'example.com', '100.128.0.1']) assert.equal(isPrivateHost(h), false, h);
  assert.equal(looksLikeCode('1234 5678'), true);
  assert.equal(looksLikeCode('12345678'), true);
  assert.equal(looksLikeCode('1234-567'), false);
  assert.equal(looksLikeCode('abcDEF_-0123456789abcdefghijklmn'), false, '访问令牌不是配对码');
  assert.equal(looksLikeCode('１２３４ ５６７８'), true, '全角数字也认');
  // 只有数字但不是 8 位：是抄错了的配对码，不能当访问令牌发去登录
  assert.equal(looksLikeDigits('1234567'), true);
  assert.equal(looksLikeDigits('1234 56789'), true);
  assert.equal(looksLikeDigits('a1234567'), false);
  assert.equal(looksLikeDigits(''), false);
});
