// ChatGPT 订阅：登录（动态注册、PKCE、ID 令牌验签、回调与粘贴两条路）、建服务、网关翻译（Chat Completions ↔ Responses、推理回放）、
// Codex 透传的清洗、令牌刷新、额度用完换账号、删账号吊销。OpenAI 的登录服务与订阅接口全是本机假服务，不联网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-chatgpt-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const S = await import('../../model-services.mjs');
const R = await import('../registry.mjs');
const G = await import('../gateway.mjs');
const Pool = await import('../pool.mjs');
const K = await import('./const.mjs');
const C = await import('./service.mjs');
const Store = await import('./store.mjs');
const T = await import('./tokens.mjs');
const O = await import('./oauth.mjs');
const J = await import('./jwt.mjs');
const { chatToResponses } = await import('./chat-in.mjs');
const { ChatFromResponses } = await import('./chat-out.mjs');
const { sanitizeResponses, classify } = await import('./upstream.mjs');

// —— 假的 OpenAI 登录服务 ——
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const ACCOUNTS = { A: { sub: 'user-A', email: 'a@example.com' }, B: { sub: 'user-B', email: 'b@example.com' } };
const codes = new Map();      // code → { account, nonce, challenge, clientId }
const tokenHits = [];
const revoked = [];
const refreshN = { A: 1, B: 1 };
const deadRefresh = new Set();
let AUTH = '';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(acct, clientId, nonce) {
  const h = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const p = b64u({ iss: AUTH, aud: clientId, sub: ACCOUNTS[acct].sub, email: ACCOUNTS[acct].email, iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) });
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const SCOPE = K.SCOPES.join(' ');
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const auth = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
  if (req.url === '/.well-known/openid-configuration') return send(200, { issuer: AUTH, jwks_uri: `${AUTH}/jwks`, revocation_endpoint: `${AUTH}/revoke` });
  if (req.url === '/jwks') return send(200, { keys: [jwk] });
  if (req.url === '/revoke') { revoked.push(Object.fromEntries(new URLSearchParams(body))); res.writeHead(200); return res.end(); }
  if (req.url === '/token') {
    const f = Object.fromEntries(new URLSearchParams(body));
    tokenHits.push(f);
    if (f.resource !== K.RESOURCE) return send(400, { error: 'invalid_target' });
    if (f.grant_type === 'authorization_code') {
      const c = codes.get(f.code);
      if (!c) return send(400, { error: 'invalid_grant' });
      if (createHash('sha256').update(f.code_verifier).digest('base64url') !== c.challenge) return send(400, { error: 'invalid_grant', error_description: 'pkce' });
      if (f.client_id !== c.clientId) return send(400, { error: 'invalid_client' });
      codes.delete(f.code);
      const a = c.account;
      return send(200, { access_token: `at-${a}-1`, refresh_token: `rt-${a}-1`, id_token: idToken(a, c.clientId, c.nonce), token_type: 'Bearer', expires_in: 3600, scope: c.scope ?? SCOPE });
    }
    if (f.grant_type === 'refresh_token') {
      const a = /^rt-([AB])-/.exec(f.refresh_token)?.[1];
      if (!a || deadRefresh.has(a)) return send(400, { error: 'invalid_grant' });
      const n = ++refreshN[a];
      return send(200, { access_token: `at-${a}-${n}`, refresh_token: `rt-${a}-${n}`, token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
    }
  }
  send(404, {});
});
await new Promise((r) => auth.listen(0, '127.0.0.1', r));
AUTH = `http://127.0.0.1:${auth.address().port}`;

// —— 假的订阅接口 ——
const planHits = [];
const planBehavior = new Map();   // 'A' | 'B' → (body) => 'limit' | 'stream-fail' | null
const sse = (res, evs) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const plan = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const acct = /^at-([AB])-/.exec(tok)?.[1] || '';
  const j = (status, x) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
  if (!acct) return j(401, { detail: 'bad token' });
  if (req.method === 'GET' && req.url === '/v1/models') {
    return j(200, { models: [{ slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' }, { slug: 'internal-x', display_name: 'x', visibility: 'hide' }] });
  }
  if (req.method === 'POST' && req.url === '/v1/responses') {
    const b = JSON.parse(body);
    planHits.push({ tok, body: b });
    const how = planBehavior.get(acct)?.(b);
    if (how === 'limit') return j(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit', type: 'usage' } });
    if (how === 'stream-fail') return sse(res, [{ type: 'response.created', response: { id: 'r0' } }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]);
    const last = b.input[b.input.length - 1];
    const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 129 };
    if (last.type === 'function_call_output') {
      return sse(res, [
        { type: 'response.created', response: { id: 'r2' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
        { type: 'response.output_text.delta', item_id: 'msg_2', output_index: 0, delta: 'do' },
        { type: 'response.output_text.delta', item_id: 'msg_2', output_index: 0, delta: 'ne' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2', content: [{ type: 'output_text', text: 'done' }] } },
        { type: 'response.completed', response: { id: 'r2', usage } },
      ]);
    }
    return sse(res, [
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: '想一想' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '想一想' }], encrypted_content: `ENC-${acct}` } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"cmd":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"ls"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"ls"}' } },
      { type: 'response.completed', response: { id: 'r1', usage } },
    ]);
  }
  j(404, {});
});
await new Promise((r) => plan.listen(0, '127.0.0.1', r));
const PLAN = `http://127.0.0.1:${plan.address().port}/v1`;

K._setEndpointsForTests({ issuer: AUTH, authorize: `${AUTH}/authorize`, token: `${AUTH}/token`, oidcConfig: `${AUTH}/.well-known/openid-configuration`, plan: PLAN });
J._resetJwtCacheForTests();
R._resetHubForTests(path.join(tmp, 'hub'));
await R.initModelHub();
after(async () => {
  auth.close(); plan.close(); O._resetLoginsForTests(); T._stopKeepAliveForTests();
  K._setEndpointsForTests(null); await G._stopGatewayForTests();
});

/** 假装浏览器：读出授权地址里的参数，登记一个授权码，访问回调（或返回要粘贴的那段地址）。 */
function authorize(login, account, { clientId, scope, paste = false } = {}) {
  const q = new URL(login.authUrl).searchParams;
  const code = `code-${account}-${Math.random().toString(36).slice(2, 8)}`;
  const issued = clientId || (q.get('client_id') === K.DYNAMIC_CLIENT ? `oaiapp_${account}` : q.get('client_id'));
  codes.set(code, { account, nonce: q.get('nonce'), challenge: q.get('code_challenge'), clientId: issued, scope });
  const cb = new URLSearchParams({ code, state: q.get('state'), scope: scope ?? SCOPE });
  if (q.get('client_id') === K.DYNAMIC_CLIENT) cb.set('client_id', issued);
  const url = `${q.get('redirect_uri')}?${cb}`;
  return paste ? url : fetch(url);
}

const gw = (sid, proto, rest, body) => fetch(G.gatewayUrl(sid, proto) + rest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function sseChunks(res) {
  const text = await res.text();
  return text.split('\n\n').map((b) => b.replace(/^data: /, '').trim()).filter(Boolean);
}
const TOOLS = [{ type: 'function', function: { name: 'exec', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];

let sid = '', lineA = '', lineB = '';

test('新登录：授权地址按动态注册的规矩拼，回调到本机监听后换好令牌、拉到模型', async () => {
  const v = await C.startChatgptLogin({});
  assert.equal(v.status, 'pending');
  assert.equal(v.mode, 'new');
  const q = new URL(v.authUrl).searchParams;
  assert.equal(q.get('client_id'), K.DYNAMIC_CLIENT);
  assert.equal(q.get('agent_name_hint'), K.AGENT_NAME);
  assert.match(q.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(q.get('resource'), K.RESOURCE);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('scope').split(' ').includes(K.PLAN_SCOPE));
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(v.redirectUri, q.get('redirect_uri'));
  const page = await authorize(v, 'A');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /已连接 ChatGPT/);
  const s = C.chatgptLoginStatus(v.id);
  assert.equal(s.status, 'done');
  assert.deepEqual(s.account, { email: 'a@example.com', planOk: true });
  assert.deepEqual(s.models.map((m) => m.id), ['gpt-6.2-sol']);   // visibility 不是 list 的不列
  assert.ok(!JSON.stringify(s).includes('at-A-1'));
  // 主机标识每次都一样
  const v2 = await C.startChatgptLogin({});
  assert.equal(new URL(v2.authUrl).searchParams.get('ext_agent_host_id'), q.get('ext_agent_host_id'));
  C.cancelChatgptLogin(v2.id);
  // 建服务
  const r = C.createFromLogin({ loginId: v.id, assign: [{ id: 'gpt-6.2-sol', agents: ['claude', 'dimensio', 'codex'] }] });
  sid = r.service.id;
  lineA = r.service.lines[0].id;
  assert.equal(r.service.kind, 'chatgpt');
  assert.equal(r.service.members, false);
  assert.equal(r.service.media, null);
  assert.equal(r.service.chatgpt.accounts[0].email, 'a@example.com');
  assert.equal(r.service.chatgpt.accounts[0].status, 'ok');
  assert.equal(r.service.lines[0].label, 'a@example.com');
  const disk = readFileSync(path.join(tmp, 'hub', 'services.json'), 'utf8');
  assert.ok(!disk.includes('at-A') && !disk.includes('rt-A'));
  assert.ok(!readFileSync(path.join(tmp, 'hub', 'chatgpt', 'connector-secrets.json'), 'utf8').includes('rt-A'));
  assert.throws(() => C.chatgptLoginStatus(v.id), /过期/);   // 建完就收掉
  // 发布：两边看到的是 OpenAI 协议、地址是网关、GPT 的思考档位按 OpenAI 协议算
  const pub = S.modelServices('claude').find((x) => x.sid === sid);
  assert.equal(pub.protocol, 'openai');
  assert.match(pub.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/h-[0-9a-f]{8}\/openai$/);
  assert.ok(pub.models[0].efforts.length > 0);
  assert.ok(S.modelServices('codex').some((x) => x.sid === sid && x.responsesUrl));
});

test('网关：Chat Completions 翻成订阅通道的 Responses（不支持的字段不带），流式翻回来', async () => {
  planHits.length = 0;
  const res = await gw(sid, 'openai', '/chat/completions', {
    model: 'gpt-6.2-sol', stream: true, stream_options: { include_usage: true }, max_tokens: 100, temperature: 0.2, reasoning_effort: 'high',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    tools: TOOLS, tool_choice: 'auto',
  });
  assert.equal(res.status, 200);
  const chunks = await sseChunks(res);
  assert.equal(chunks.at(-1), '[DONE]');
  const js = chunks.slice(0, -1).map((x) => JSON.parse(x));
  const deltas = js.flatMap((x) => x.choices?.map((c) => c.delta) || []);
  assert.equal(deltas.map((d) => d.reasoning_content || '').join(''), '想一想');
  const tc = deltas.flatMap((d) => d.tool_calls || []);
  assert.equal(tc[0].id, 'call_1');
  assert.equal(tc[0].function.name, 'exec');
  assert.equal(tc.map((t) => t.function?.arguments || '').join(''), '{"cmd":"ls"}');
  assert.equal(js.find((x) => x.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(js.find((x) => x.usage)?.usage.prompt_tokens_details, { cached_tokens: 100 });
  const b = planHits[0].body;
  assert.equal(planHits[0].tok, 'at-A-1');
  assert.equal(b.instructions, 'SYS');
  assert.equal(b.store, false);
  assert.equal(b.stream, true);
  for (const k of ['max_tokens', 'max_output_tokens', 'temperature', 'messages', 'stream_options']) assert.ok(!(k in b), k);
  assert.deepEqual(b.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(b.include, ['reasoning.encrypted_content']);
  assert.deepEqual(b.tools[0], { type: 'function', name: 'exec', description: 'run', parameters: TOOLS[0].function.parameters, strict: false });
  assert.deepEqual(b.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' });
  assert.ok(!b.input.some((x) => x.role === 'system'));
  assert.match(b.prompt_cache_key, /^bridge-[0-9a-f]{32}$/);
});

test('网关：下一轮把上一步的加密推理塞回调用前面；非流式回整段', async () => {
  planHits.length = 0;
  const res = await gw(sid, 'openai', '/chat/completions', {
    model: 'gpt-6.2-sol', stream: false,
    messages: [
      { role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
      { role: 'system', content: '中途的提示' },
    ],
    tools: TOOLS,
  });
  // 最后一条是 developer 提示，不是 function_call_output：假服务会走「先想再调用」那支，这里只看请求体
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.object, 'chat.completion');
  const inp = planHits[0].body.input;
  const i = inp.findIndex((x) => x.type === 'function_call');
  assert.equal(inp[i - 1].type, 'reasoning');
  assert.equal(inp[i - 1].encrypted_content, 'ENC-A');
  assert.deepEqual(inp[i + 1], { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' });
  assert.equal(inp.at(-1).role, 'developer');
  // 真正接着工具结果的那一轮：回复正文
  const res2 = await gw(sid, 'openai', '/chat/completions', {
    model: 'gpt-6.2-sol',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }],
  });
  const j2 = await res2.json();
  assert.equal(j2.choices[0].message.content, 'done');
  assert.equal(j2.choices[0].finish_reason, 'stop');
  assert.equal(j2.usage.prompt_tokens, 120);
});

test('令牌快过期：先用刷新令牌换一组新的（带签发的 client_id 与 resource），新的刷新令牌存回去', async () => {
  Store.patchCred(sid, lineA, { expiresAt: Date.now() + 1000 });
  tokenHits.length = 0; planHits.length = 0;
  const res = await gw(sid, 'openai', '/chat/completions', { model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200);
  const rf = tokenHits.find((x) => x.grant_type === 'refresh_token');
  assert.equal(rf.client_id, 'oaiapp_A');
  assert.equal(rf.refresh_token, 'rt-A-1');
  assert.equal(rf.resource, K.RESOURCE);
  assert.equal(planHits[0].tok, 'at-A-2');
  assert.equal(Store.getCred(sid, lineA).refreshToken, 'rt-A-2');
});

test('加第二个账号；一个账号额度用完（含流里才报的失败）就冷却它、换下一个；都用完回 429 和管理用量的地址', async () => {
  const v = await C.startChatgptLogin({ serviceId: sid });
  assert.equal(v.mode, 'add');
  const url = authorize(v, 'B', { paste: true });
  const done = await C.finishChatgptLogin(v.id, `地址是 ${url}`.replace('地址是 ', ''));
  assert.equal(done.status, 'done');
  assert.equal(done.service.chatgpt.accounts.length, 2);
  lineB = done.service.lines.find((l) => l.id !== lineA).id;
  assert.equal(done.service.lines.find((l) => l.id === lineB).label, 'b@example.com');

  planBehavior.set('A', () => 'limit');
  planHits.length = 0;
  let res = await gw(sid, 'openai', '/chat/completions', { model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(planHits.map((h) => h.tok[3]), ['A', 'B']);
  const st = Pool.lineState(sid, lineA);
  assert.equal(st.coolWhy, '额度用完');
  assert.ok(st.coolUntil > Date.now() + 10 * 60_000);

  Pool.clearCooldown(sid, lineA);
  planBehavior.set('A', () => 'stream-fail');
  planHits.length = 0;
  res = await gw(sid, 'openai', '/chat/completions', { model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'x' }], stream: true });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('想一想'));
  assert.deepEqual(planHits.map((h) => h.tok[3]), ['A', 'B']);

  planBehavior.set('B', () => 'limit');
  Pool.clearCooldown(sid, lineA); Pool.clearCooldown(sid, lineB);
  planBehavior.set('A', () => 'limit');
  res = await gw(sid, 'openai', '/chat/completions', { model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error.message, /chatgpt\.com\/settings\/usage/);
  planBehavior.clear(); Pool.clearCooldown(sid, lineA); Pool.clearCooldown(sid, lineB);
});

test('Codex 的 Responses 透传：去掉不支持的字段与托管工具、system 改 developer', async () => {
  planHits.length = 0;
  const res = await gw(sid, 'responses', '/responses', {
    model: 'gpt-6.2-sol', stream: true, temperature: 1, max_output_tokens: 5, previous_response_id: 'x', store: true,
    input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 's' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u' }] }],
    tools: [{ type: 'function', name: 'exec', parameters: {} }, { type: 'image_generation' }, { type: 'web_search' }],
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: response\.completed/);
  const b = planHits[0].body;
  for (const k of ['temperature', 'max_output_tokens', 'previous_response_id']) assert.ok(!(k in b), k);
  assert.equal(b.store, false);
  assert.equal(b.input[0].role, 'developer');
  assert.deepEqual(b.tools.map((t) => t.type), ['function', 'web_search']);
});

test('重新登录必须是原来那个账号；拒绝授权、state 不对都不动凭据', async () => {
  const v = await C.startChatgptLogin({ serviceId: sid, lineId: lineA });
  assert.equal(v.mode, 'relogin');
  const q = new URL(v.authUrl).searchParams;
  assert.equal(q.get('client_id'), 'oaiapp_A');
  assert.ok(q.get('id_token_hint'));
  assert.equal(q.get('login_hint'), 'a@example.com');
  assert.ok(!q.has('agent_name_hint'));
  await authorize(v, 'B', { clientId: 'oaiapp_A' });
  const s = C.chatgptLoginStatus(v.id);
  assert.equal(s.status, 'error');
  assert.equal(s.errorCode, 'mismatch');
  assert.equal(Store.getCred(sid, lineA).subject, 'user-A');

  const v2 = await C.startChatgptLogin({});
  await assert.rejects(C.finishChatgptLogin(v2.id, `${v2.redirectUri}?code=x&state=wrong`), /不是这一次登录/);
  await assert.rejects(C.finishChatgptLogin(v2.id, 'hello'), /没有登录结果/);
  const q2 = new URL(v2.authUrl).searchParams;
  const d = await C.finishChatgptLogin(v2.id, `${v2.redirectUri}?error=access_denied&state=${q2.get('state')}`);
  assert.equal(d.status, 'error');
  assert.equal(d.errorCode, 'denied');

  // 同意页上没给套餐额度的授权
  const v3 = await C.startChatgptLogin({});
  await authorize(v3, 'A', { scope: 'openid profile email offline_access' });
  assert.equal(C.chatgptLoginStatus(v3.id).errorCode, 'no_plan');
});

test('刷新令牌失效：账号标成要重新登录，请求换到别的账号', async () => {
  deadRefresh.add('B');
  Store.patchCred(sid, lineB, { expiresAt: Date.now() + 1000 });
  Pool.clearCooldown(sid, lineA);
  planBehavior.set('A', () => 'limit');
  const res = await gw(sid, 'openai', '/chat/completions', { model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 429);
  const view = R.getHubService(sid);
  const b = view.chatgpt.accounts.find((a) => a.lineId === lineB);
  assert.equal(b.status, 'relogin');
  assert.equal(Store.getCred(sid, lineB).refreshToken, '');
  planBehavior.clear(); deadRefresh.clear(); Pool.clearCooldown(sid, lineA); Pool.clearCooldown(sid, lineB);
});

test('删账号：本地清凭据并吊销刷新令牌；最后一个账号不能删；删服务清全部', async () => {
  const keep = R.getHubService(sid).lines.filter((l) => l.id === lineA);
  R.updateHubV2(sid, { lines: keep });
  assert.equal(Store.getCred(sid, lineB), null);
  assert.throws(() => R.updateHubV2(sid, { lines: [] }), /至少要留一个 ChatGPT 账号/);
  await new Promise((r) => setTimeout(r, 200));
  R.deleteHubV2(sid);
  assert.deepEqual(Store.credsOf(sid), {});
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(revoked.some((x) => /^rt-A-/.test(x.token) && x.client_id === 'oaiapp_A' && x.token_type_hint === 'refresh_token'));
  assert.ok(!S.modelServices('claude').some((x) => x.sid === sid));
});

test('单元：翻译与错误分类', () => {
  const b = chatToResponses({ model: 'm', reasoning_effort: 'none', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tool_choice: { type: 'function', function: { name: 'exec' } } });
  assert.deepEqual(b.reasoning, { effort: 'none' });
  assert.deepEqual(b.tool_choice, { type: 'function', name: 'exec' });
  const tr = new ChatFromResponses({ model: 'm' });
  tr.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } });
  tr.push({ type: 'response.output_text.delta', delta: 'hi' });
  tr.push({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } });
  assert.equal(tr.message().choices[0].finish_reason, 'length');
  assert.deepEqual(sanitizeResponses({ input: 'x', tools: [{ type: 'mcp' }], tool_choice: 'auto' }), { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }], store: false, stream: true });
  assert.equal(classify(403, 'subscription_sharing_user_not_eligible').failover, true);
  assert.equal(classify(400, 'subscription_sharing_unsupported_capability').failover, false);
});
