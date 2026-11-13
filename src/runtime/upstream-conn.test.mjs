// 连接保温：登记规则、心跳路径、死连接重发，以及对真连接池的效果（本机假上游，空闲后不重新建连接）。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Agent } from 'undici';
import { KEEPALIVE, withWarm, retireDispatcher, warmStatus, beatPath, isModelRequest, fetchReconnect, _resetWarm, _tick } from './upstream-conn.mjs';

const fakeBase = (onRequest) => ({
  compose(fn) { return { dispatch: fn(() => true), close: async () => {} }; },
  request: onRequest || (async () => ({ body: { dump: async () => {} } })),
  close: async () => {},
});

test('beatPath：模型请求路径换成同站的轻 GET', () => {
  assert.equal(beatPath('/v1/messages?beta=true'), '/v1/models/-');
  assert.equal(beatPath('/api/v1/chat/completions'), '/api/v1/models/-');
  assert.equal(beatPath('/v1/responses'), '/v1/models/-');
  assert.equal(beatPath('/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse'), '/v1beta/models/-');
  assert.equal(beatPath('/v1/projects/p/locations/global/publishers/google/models/gemini-4-carbon:generateContent'), '/v1/projects/p/locations/global/publishers/google/models/-');
  assert.equal(beatPath('/whatever'), '/');
});

test('isModelRequest：只认公网上游的模型 POST', () => {
  const ok = (origin, path, method = 'POST') => isModelRequest({ origin, path, method });
  assert.equal(ok('https://api.anthropic.com', '/v1/messages'), true);
  assert.equal(ok('https://openrouter.ai', '/api/v1/chat/completions'), true);
  assert.equal(ok('https://generativelanguage.googleapis.com', '/v1beta/models/x:streamGenerateContent?alt=sse'), true);
  assert.equal(ok('https://api.anthropic.com', '/v1/messages', 'GET'), false);
  assert.equal(ok('https://api.anthropic.com', '/v1/messages/count_tokens'), false);
  assert.equal(ok('https://example.com', '/page'), false);
  // MCP 的 SSE 传输也是 POST …/messages?sessionId=…：不是模型请求
  assert.equal(ok('https://mcp.example.com', '/messages?sessionId=abc'), false);
  assert.equal(ok('https://mcp.example.com', '/mcp/messages'), false);
  assert.equal(ok('https://api.deepseek.com', '/anthropic/v1/messages'), true);
  assert.equal(ok('https://api.kimi.com', '/coding/v1/messages?beta=true'), true);
  for (const o of ['http://127.0.0.1:8080', 'http://localhost:1234', 'http://192.168.1.5:8000', 'http://100.106.218.42:30001', 'http://10.0.0.2', 'http://[::1]:9000']) {
    assert.equal(ok(o, '/v1/chat/completions'), false, o);
  }
});

test('fetchReconnect：死连接立刻重发一次；别的错、调用方中断、不可重放的请求体不重发', async () => {
  const dead = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  let n = 0;
  const r = await fetchReconnect('http://x/', { method: 'POST', body: '{}' }, async () => { if (++n === 1) throw dead(); return 'ok'; });
  assert.equal(r, 'ok');
  assert.equal(n, 2);

  n = 0;
  await assert.rejects(fetchReconnect('http://x/', { body: '{}' }, async () => { n++; throw dead(); }));
  assert.equal(n, 2, '只重发一次');

  n = 0;
  await assert.rejects(fetchReconnect('http://x/', { body: '{}' }, async () => { n++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }));
  assert.equal(n, 1);

  n = 0;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(fetchReconnect('http://x/', { body: '{}', signal: ac.signal }, async () => { n++; throw dead(); }));
  assert.equal(n, 1);

  n = 0;
  await assert.rejects(fetchReconnect('http://x/', { body: new ReadableStream() }, async () => { n++; throw dead(); }));
  assert.equal(n, 1);
});

test('withWarm：登记、LRU 上限、弃用即停', () => {
  _resetWarm();
  const w = withWarm(fakeBase());
  for (let i = 0; i < 10; i++) w.dispatch({ origin: `https://h${i}.example.com`, path: '/v1/chat/completions', method: 'POST' }, {});
  w.dispatch({ origin: 'https://h0.example.com', path: '/v1/models', method: 'GET' }, {});
  const st = warmStatus();
  assert.equal(st.origins.length, 8);
  assert.equal(st.origins.some((o) => o.origin === 'https://h0.example.com'), false, '最旧的被挤掉');
  retireDispatcher(w);
  assert.equal(warmStatus().origins.length, 0);
  _resetWarm();
});

test('心跳：走同一个连接池、不带凭据、失败即摘、15 分钟没有真实请求就停', async () => {
  _resetWarm();
  const sent = [];
  let fail = false;
  const w = withWarm(fakeBase(async (o) => { sent.push(o); if (fail) throw new Error('down'); return { body: { dump: async () => {} } }; }));
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    w.dispatch({ origin: 'https://api.anthropic.com', path: '/v1/messages?beta=true', method: 'POST', headers: { 'x-api-key': 'secret' } }, {});
    now += 5_000; _tick();
    assert.equal(sent.length, 0, '刚有真实流量不打');
    now += 20_000; _tick(); await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].origin, 'https://api.anthropic.com');
    assert.equal(sent[0].path, '/v1/models/-');
    assert.equal(sent[0].method, 'GET');
    assert.equal(JSON.stringify(sent[0].headers).includes('secret'), false);
    fail = true;
    now += 20_000; _tick(); await settle(); await settle();
    assert.equal(warmStatus().origins.length, 0, '心跳失败摘掉');
    fail = false;
    w.dispatch({ origin: 'https://api.anthropic.com', path: '/v1/messages', method: 'POST' }, {});
    assert.equal(warmStatus().origins.length, 1, '下一次真实请求重新登记');
    now += 16 * 60_000; _tick();
    assert.equal(warmStatus().origins.length, 0, '15 分钟没有真实请求停止保温');
  } finally {
    Date.now = realNow;
    retireDispatcher(w);
    _resetWarm();
  }
});

test('真连接池：默认空闲 4 秒就丢连接，带 KEEPALIVE 后复用', async () => {
  _resetWarm();
  let conns = 0;
  // 裸 TCP 假上游：和真实的模型上游一样不回 Keep-Alive 头（Node 的 http 服务会自动带上，undici 就照它的来了）
  const socks = new Set();
  const srv = net.createServer((sock) => {
    conns++;
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    sock.on('error', () => {});
    sock.on('data', (buf) => {
      if (String(buf).endsWith('{}')) sock.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const post = (d) => d.request({ origin, path: '/v1/chat/completions', method: 'POST', body: '{}' }).then((r) => r.body.dump());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const plain = new Agent();
    await post(plain); await sleep(5200); await post(plain);
    assert.equal(conns, 2, '默认配置空闲后重新建连接');
    await plain.close();

    conns = 0;
    const warm = withWarm(new Agent(KEEPALIVE));
    await post(warm); await sleep(5200); await post(warm);
    assert.equal(conns, 1, '调大空闲保留后复用同一条');
    assert.equal(warmStatus().origins.length, 0, '回环地址不登记保温');
    retireDispatcher(warm);
  } finally {
    for (const x of socks) x.destroy();
    await new Promise((r) => srv.close(r));
    _resetWarm();
  }
});

test('fetchReconnect：等了很久才断的不重发（请求多半已被上游收下），交回调用方', async () => {
  const dead = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let n = 0;
  try {
    await assert.rejects(fetchReconnect('http://x/', { body: '{}' }, async () => { n++; now += 3000; throw dead(); }));
    assert.equal(n, 1);
    n = 0;
    const r = await fetchReconnect('http://x/', { body: '{}' }, async () => { if (++n === 1) { now += 300; throw dead(); } return 'ok'; });
    assert.equal(r, 'ok');
    assert.equal(n, 2);
  } finally { Date.now = realNow; }
});

test('textWithin：正文卡住时最多等到上限，回空串', async () => {
  const { textWithin } = await import('./upstream-conn.mjs');
  assert.equal(await textWithin(new Response('{"a":1}')), '{"a":1}');
  const stuck = new Response(new ReadableStream({ start() {} }));
  const t = Date.now();
  assert.equal(await textWithin(stuck, 80), '');
  assert.ok(Date.now() - t < 2000);
});
