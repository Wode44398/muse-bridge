// 会话协作的同机接口（family.mjs）与反代的那道闸：浏览器经反代进来带不出 x-dimensio-family-call（harness 的 /api/family/*
// 认它判「是不是 bridge 服务端自己发的」），/agent/family/* 不带同机实例凭据一律不认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// harness.mjs 经 config/index.mjs 首次加载会在数据根生成 config.json、主机密钥：数据根指到临时目录
process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'family-route-root-'));
const { upstreamRequest } = await import('./harness.mjs');
const { handleFamily } = await import('./family.mjs');

test('反代剥掉 x-dimensio-family-call：浏览器冒充不了 bridge 发给 dimensio 的会话消息', () => {
  const url = new URL('http://127.0.0.1:8787/api/harness/api/family/deliver');
  const { path, headers } = upstreamRequest({ 'x-dimensio-family-call': '1', 'content-type': 'application/json' }, url);
  assert.equal(path, '/api/family/deliver');
  assert.equal(headers['x-dimensio-family-call'], undefined);
});

function fakeReq(headers, body = '{}') {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = headers;
  req.method = 'POST';
  req.url = '/agent/family/send';
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function fakeRes() {
  const res = { code: 0, body: '' };
  res.writeHead = (c) => { res.code = c; return res; };
  res.end = (b) => { res.body = String(b || ''); };
  return res;
}

test('/agent/family/*：没带凭据 401，带了不认识的凭据也不放行', async () => {
  const r1 = fakeRes();
  await handleFamily('send', fakeReq({}), r1);
  assert.equal(r1.code, 401);
  const r2 = fakeRes();
  await handleFamily('send', fakeReq({ authorization: 'Bearer FAKE-not-a-host-secret' }), r2);
  assert.equal(r2.code, 401);
  assert.equal(JSON.parse(r2.body).ok, false);
});
