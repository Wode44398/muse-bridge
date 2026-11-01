import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { parseFigmaRef, fetchSurrogate, figmaToken, figmaGet } from './figma-rest.mjs';

// 模拟 Muse 的 authd：Unix socket（Windows 上是命名管道）上的 HTTP
function fakeAuthd(handler) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\figma-rest-test-${process.pid}-${Date.now()}` : path.join(os.tmpdir(), `figma-rest-${process.pid}-${Date.now()}.sock`);
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, body: raw }); handler(req, res, raw); });
  });
  return new Promise((resolve) => srv.listen(sock, () => resolve({ sock, seen, close: () => { srv.close(); if (process.platform !== 'win32') rmSync(sock, { force: true }); } })));
}

test('parseFigmaRef：各种链接与 key', () => {
  assert.deepEqual(parseFigmaRef('https://www.figma.com/design/AbC123/My-File?node-id=12-34&t=x'), { key: 'AbC123', nodeId: '12:34' });
  assert.deepEqual(parseFigmaRef('https://figma.com/file/Key9/x'), { key: 'Key9', nodeId: '' });
  assert.deepEqual(parseFigmaRef('https://www.figma.com/design/Main1/branch/Br2/name'), { key: 'Br2', nodeId: '' });
  assert.deepEqual(parseFigmaRef('KeyOnly'), { key: 'KeyOnly', nodeId: '' });
  assert.throws(() => parseFigmaRef('https://example.com/design/x'));
  assert.throws(() => parseFigmaRef(''));
});

test('fetchSurrogate：按登记名要替身，只认 hsurr:', async () => {
  const a = await fakeAuthd((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ credentials: [{ name: 'access_token', surrogate: 'hsurr:abc', placement: { custom_header: 'X-Figma-Token' } }] })); });
  try {
    assert.equal(await fetchSurrogate('custom.figma_pat', { socketPath: a.sock }), 'hsurr:abc');
    assert.equal(a.seen[0].method, 'POST');
    assert.equal(a.seen[0].url, '/v1/credentials/surrogate');
    assert.deepEqual(JSON.parse(a.seen[0].body), { name: 'custom.figma_pat' });
  } finally { a.close(); }
});

test('fetchSurrogate：403 / 不是替身都如实报错', async () => {
  const a = await fakeAuthd((req, res) => { res.writeHead(403); res.end('this connector\'s credentials are not available to the sandbox'); });
  try { await assert.rejects(fetchSurrogate('custom.x', { socketPath: a.sock }), /403/); } finally { a.close(); }
  const b = await fakeAuthd((req, res) => { res.writeHead(200); res.end(JSON.stringify({ credentials: [{ name: 'access_token', surrogate: 'real-token' }] })); });
  try { await assert.rejects(fetchSurrogate('custom.x', { socketPath: b.sock }), /替身/); } finally { b.close(); }
});

test('figmaToken：环境变量优先级与缺省报错', async () => {
  assert.equal(await figmaToken({ FIGMA_API_KEY: 'figd_x' }), 'figd_x');
  await assert.rejects(figmaToken({}), /FIGMA_API_KEY/);
});

test('figmaGet：每次请求现取替身放进 X-Figma-Token；401 给出人话', async () => {
  let n = 0;
  const a = await fakeAuthd((req, res) => { n++; res.writeHead(200); res.end(JSON.stringify({ credentials: [{ name: 'access_token', surrogate: 'hsurr:' + n }] })); });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, token: init.headers['X-Figma-Token'] }); return { ok: true, status: 200, text: async () => '{"id":"1"}' }; };
  try {
    const env = { FIGMA_TOKEN_CREDENTIAL: 'custom.figma_pat' };
    await figmaGet('/v1/me', { env, fetchImpl, tokenOpts: { socketPath: a.sock } });
    await figmaGet('/v1/me', { env, fetchImpl, tokenOpts: { socketPath: a.sock } });
    assert.deepEqual(calls.map((c) => c.token), ['hsurr:1', 'hsurr:2']);
    assert.equal(calls[0].url, 'https://api.figma.com/v1/me');
  } finally { a.close(); }
  const bad = async () => ({ ok: false, status: 403, text: async () => '{"status":403,"err":"Invalid token"}' });
  await assert.rejects(figmaGet('/v1/me', { env: { FIGMA_API_KEY: 'x' }, fetchImpl: bad }), /Invalid token/);
});
