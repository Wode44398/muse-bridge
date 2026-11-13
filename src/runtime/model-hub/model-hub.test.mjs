// 模型中心（2026-11-10）：注册表增删改与 Key 落密文、发布到 model-services（Claude / dimensio 各拿到什么）、
// 网关路由、API 池换线路与冷却、Vertex 的思维签名补回。上游全是本机假服务，不联网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-model-hub-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.VERTEX_PROJECT;

const S = await import('../model-services.mjs');
const R = await import('./registry.mjs');
const G = await import('./gateway.mjs');
const Pool = await import('./pool.mjs');
const V = await import('./vertex.mjs');
const Probe = await import('./probe.mjs');

// 假上游：按 Authorization / x-api-key 里的 Key 决定回什么；记下每次请求
const hits = [];
const behavior = new Map();   // key → (req, body) => { status, json, headers }
const upstream = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '';
    hits.push({ url: req.url, key, body: buf });
    const r = (behavior.get(key) || (() => ({ status: 200, json: { ok: true, key } })))(req, buf);
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
    res.end(JSON.stringify(r.json ?? {}));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${upstream.address().port}`;
after(async () => { upstream.close(); await G._stopGatewayForTests(); });

R._resetHubForTests(path.join(tmp, 'hub'));
await R.initModelHub();

const svcInput = (over = {}) => ({
  name: '中转站', kind: 'openai', baseUrl: UP + '/v1', useProxy: false,
  models: [{ id: 'gpt-x', label: 'GPT X', contextWindow: 400000 }, 'deepseek-v4-pro'],
  lines: [{ label: '甲', key: 'k-a' }, { label: '乙', key: 'k-b' }, { label: '丙', key: 'k-c', baseUrl: UP + '/alt/v1' }],
  ...over,
});
const call = (sid, proto, rest, body) => fetch(G.gatewayUrl(sid, proto) + rest, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer should-be-dropped' }, body: JSON.stringify(body || {}) });

test('注册表：建服务、Key 进密文不进 services.json、视图只给尾巴', () => {
  const s = R.createHubService(svcInput());
  assert.match(s.id, /^h-[0-9a-f]{8}$/);
  assert.deepEqual(s.agents, ['claude', 'dimensio']);
  assert.equal(s.lines.length, 3);
  assert.ok(s.lines.every((l) => l.hasKey && !('key' in l)));
  const disk = readFileSync(path.join(tmp, 'hub', 'services.json'), 'utf8');
  assert.ok(!disk.includes('k-a') && !disk.includes('k-b'));
  assert.ok(existsSync(path.join(tmp, 'hub', 'connector-secrets.json')));
  assert.ok(!readFileSync(path.join(tmp, 'hub', 'connector-secrets.json'), 'utf8').includes('k-a'));
  assert.equal(R._hubKeyForTests(s.id, s.lines[0].id), 'k-a');
  assert.throws(() => R.createHubService(svcInput({ lines: [] })), /线路/);
  assert.throws(() => R.createHubService(svcInput({ baseUrl: 'ftp://x' })), /地址/);
  assert.throws(() => R.createHubService(svcInput({ models: [] })), /型号/);
});

test('发布：两个 agent 都拿到指向网关的服务；型号能力 = 用户填的 > 知识层', () => {
  const s = R.listHubServices()[0];
  const pub = S.modelServices().find((x) => x.sid === s.id);
  assert.ok(pub && pub.plugin === R.HUB_PLUGIN);
  assert.deepEqual(pub.agents, ['claude', 'dimensio']);
  assert.equal(pub.baseUrl, G.gatewayUrl(s.id, 'openai'));
  assert.equal(pub.apiKey, '');            // Key 不出网关
  assert.equal(pub.models[0].contextWindow, 400000);
  assert.equal(pub.models[0].label, 'GPT X');
  // 停用 / 没有启用的线路 → 撤掉
  R.updateHubService(s.id, { enabled: false });
  assert.ok(!S.modelServices().some((x) => x.sid === s.id));
  R.updateHubService(s.id, { enabled: true });
  assert.ok(S.modelServices().some((x) => x.sid === s.id));
});

test('Gemini 协议的服务只给 dimensio', () => {
  const s = R.createHubService(svcInput({ name: 'G', kind: 'gemini', baseUrl: UP + '/v1beta', agents: ['claude', 'dimensio'], models: ['gemini-4-argon'], lines: [{ key: 'g-1' }] }));
  assert.deepEqual(s.agents, ['dimensio']);
  const pub = S.modelServices().find((x) => x.sid === s.id);
  assert.equal(pub.protocol, 'gemini');
  assert.deepEqual(pub.agents, ['dimensio']);
  assert.ok(pub.models[0].efforts.length >= 3);   // 思考档位来自知识层
  R.deleteHubService(s.id);
  assert.ok(!S.modelServices().some((x) => x.sid === s.id));
});

test('网关：换上线路的 Key、丢掉调用方带来的鉴权头；键不对 / 服务不在 = 404', async () => {
  const s = R.listHubServices()[0];
  hits.length = 0;
  const r = await call(s.id, 'openai', '/chat/completions', { model: 'gpt-x' });
  assert.equal(r.status, 200);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, '/v1/chat/completions');
  assert.equal(hits[0].key, 'k-a');
  assert.equal((await call('h-00000000', 'openai', '/chat/completions')).status, 404);
  assert.equal((await call(s.id, 'anthropic', '/v1/messages')).status, 404);   // 协议对不上
  const badKey = G.gatewayUrl(s.id, 'openai').replace(/\/[0-9a-f]{36}\//, '/' + 'f'.repeat(36) + '/');
  assert.equal((await fetch(badKey + '/chat/completions', { method: 'POST', body: '{}' })).status, 404);
});

test('API 池：401 / 402 / 429 当场换下一条线路，坏线路冷却；400 不换', async () => {
  const s = R.listHubServices()[0];
  Pool._resetPoolForTests();
  behavior.set('k-a', () => ({ status: 401, json: { error: { message: 'invalid key' } } }));
  behavior.set('k-b', () => ({ status: 429, json: { error: 'slow down' }, headers: { 'retry-after': '120' } }));
  hits.length = 0;
  let r = await call(s.id, 'openai', '/chat/completions', { model: 'gpt-x' });
  assert.equal(r.status, 200);
  assert.deepEqual(hits.map((h) => h.key), ['k-a', 'k-b', 'k-c']);
  assert.equal(hits[2].url, '/alt/v1/chat/completions');   // 线路自己的地址
  let view = R.getHubService(s.id);
  assert.equal(view.lines[0].state.coolWhy, 'Key 无效');
  assert.equal(view.lines[1].state.coolWhy, '限额');
  assert.ok(view.lines[1].state.coolUntil - Date.now() > 100_000);   // 听 retry-after
  assert.equal(view.lines[2].state.ok, 1);
  // 冷却中的线路下一次直接跳过
  hits.length = 0;
  await call(s.id, 'openai', '/chat/completions', {});
  assert.deepEqual(hits.map((h) => h.key), ['k-c']);
  // 手动清冷却
  R.resetHubLine(s.id, view.lines[0].id);
  behavior.delete('k-a');
  hits.length = 0;
  await call(s.id, 'openai', '/chat/completions', {});
  assert.deepEqual(hits.map((h) => h.key), ['k-a']);
  // 400 是请求自己的问题：原样交回，不换线路、不冷却
  behavior.set('k-a', () => ({ status: 400, json: { error: 'bad request' } }));
  hits.length = 0;
  r = await call(s.id, 'openai', '/chat/completions', {});
  assert.equal(r.status, 400);
  assert.equal(hits.length, 1);
  assert.equal(R.getHubService(s.id).lines[0].state.coolUntil, 0);
  // 全部线路都不行：把最后一个应答交回去
  behavior.set('k-a', () => ({ status: 402, json: {} }));
  behavior.set('k-c', () => ({ status: 403, json: { error: 'denied' } }));
  Pool._resetPoolForTests();
  r = await call(s.id, 'openai', '/chat/completions', {});
  assert.equal(r.status, 403);
  // 全在冷却：硬试最快恢复的那条
  hits.length = 0;
  await call(s.id, 'openai', '/chat/completions', {});
  assert.equal(hits.length, 1);
  behavior.clear();
  Pool._resetPoolForTests();
});

test('API 池：round-robin 在没冷却的线路里轮流', async () => {
  const s = R.listHubServices()[0];
  R.updateHubService(s.id, { strategy: 'round-robin' });
  hits.length = 0;
  for (let i = 0; i < 4; i++) await call(s.id, 'openai', '/chat/completions', {});
  assert.deepEqual(hits.map((h) => h.key), ['k-a', 'k-b', 'k-c', 'k-a']);
  R.updateHubService(s.id, { strategy: 'failover' });
});

test('改线路：没带 key 的沿用旧 Key，删掉的线路连 Key 一起删', () => {
  const s = R.listHubServices()[0];
  const [a, b] = s.lines;
  const next = R.updateHubService(s.id, { lines: [{ id: a.id, label: '甲改', enabled: false }, { id: b.id, key: 'k-b2' }, { label: '新', key: 'k-n' }] });
  assert.equal(next.lines.length, 3);
  assert.equal(next.lines[0].label, '甲改');
  assert.equal(R._hubKeyForTests(s.id, a.id), 'k-a');
  assert.equal(R._hubKeyForTests(s.id, b.id), 'k-b2');
  assert.equal(R._hubKeyForTests(s.id, s.lines[2].id), '');
  assert.equal(R._hubKeyForTests(s.id, next.lines[2].id), 'k-n');
  assert.equal(next.kind, 'openai');
  assert.equal(R.updateHubService(s.id, { kind: 'anthropic' }).kind, 'openai');   // 协议定了不改
});

test('测试线路 / 拉模型：钉在一条线路上，不动线路状态', async () => {
  const s = R.listHubServices()[0];
  behavior.set('k-b2', (req) => (req.url.endsWith('/models') ? { status: 200, json: { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }] } } : { status: 200, json: {} }));
  const ctx = R.lineContext({ id: s.id, lineId: s.lines[1].id });
  assert.deepEqual(await Probe.fetchLineModels(ctx.service, ctx.line, ctx.key), ['m1', 'm2']);
  const t = await Probe.testLine(ctx.service, ctx.line, ctx.key, 'm1');
  assert.equal(t.ok, true);
  // 草稿：还没保存的地址 + 新填的 Key
  behavior.set('k-draft', () => ({ status: 401, json: { error: { message: 'nope' } } }));
  const d = R.lineContext({ draft: { kind: 'openai', baseUrl: UP + '/v1', useProxy: false, line: { key: 'k-draft' } } });
  const t2 = await Probe.testLine(d.service, d.line, d.key, 'm1');
  assert.equal(t2.ok, false);
  assert.equal(t2.status, 401);
  assert.match(t2.error, /nope/);
  // 草稿线路没填 Key、指着已存的线路 → 用存着的
  assert.equal(R.lineContext({ id: s.id, draft: { baseUrl: UP + '/v1', line: { id: s.lines[1].id } } }).key, 'k-b2');
  behavior.clear();
});

test('Vertex：没配项目不发布；思维签名按 tool_call id 记、回放时补回，记不到填占位值', () => {
  assert.equal(V.vertexConfigured(), false);
  assert.ok(!S.modelServices().some((x) => x.sid.startsWith('vertex')));
  const sig = (c) => c.extra_content?.google?.thought_signature;
  V.noteOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: 'call_1', extra_content: { google: { thought_signature: 'SIG1' } }, function: { name: 'f', arguments: '{}' } }] } }] });
  const body = V.prepareOpenAIBody({
    model: 'gemini-4-carbon',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }, { id: 'toolu_x', type: 'function', function: { name: 'g', arguments: '{}' } }] },
      { role: 'assistant', tool_calls: [{ id: 'call_9', extra_content: { google: { thought_signature: 'KEEP' } }, function: { name: 'h', arguments: '{}' } }] },
    ],
  });
  assert.equal(body.model, 'google/gemini-4-carbon');
  assert.equal(sig(body.messages[1].tool_calls[0]), 'SIG1');
  assert.equal(sig(body.messages[1].tool_calls[1]), V.SKIP_SIGNATURE);
  assert.equal(sig(body.messages[2].tool_calls[0]), 'KEEP');
  assert.equal(V.prepareOpenAIBody({ model: 'google/x', messages: [] }).model, 'google/x');
});

test('Vertex：流式应答边转发边记签名（跨块的行也认）', async () => {
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', extra_content: { google: { thought_signature: 'SIGS' } }, function: { name: 'f', arguments: '' } }] } }] }) + '\n\n';
  const enc = new TextEncoder();
  const cut = Math.floor(line.length / 2);
  const src = new ReadableStream({ start(c) { c.enqueue(enc.encode(line.slice(0, cut))); c.enqueue(enc.encode(line.slice(cut) + 'data: [DONE]\n\n')); c.close(); } });
  const out = await new Response(src.pipeThrough(V.signatureTap())).text();
  assert.equal(out, line + 'data: [DONE]\n\n');   // 内容原样
  const b = V.prepareOpenAIBody({ model: 'm', messages: [{ role: 'assistant', tool_calls: [{ id: 'call_s', function: { name: 'f', arguments: '{}' } }] }] });
  assert.equal(b.messages[0].tool_calls[0].extra_content.google.thought_signature, 'SIGS');
});

test('删服务：Key、线路状态、发布一起清', () => {
  const s = R.listHubServices()[0];
  const lid = s.lines[0].id;
  assert.equal(R.deleteHubService(s.id), true);
  assert.equal(R._hubKeyForTests(s.id, lid), '');
  assert.equal(R.listHubServices().length, 0);
  assert.ok(!S.modelServices().some((x) => x.plugin === R.HUB_PLUGIN));
});
