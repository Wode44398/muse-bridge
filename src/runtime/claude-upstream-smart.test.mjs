// 本机上游代理 + 号池「智能分派」（strategy 'smart'）：按 X-Claude-Code-Session-Id 认任务、各会话各用各的号、
// 响应流里读出 usage 记进任务、某个号撞墙时只把撞墙的那个会话换走（另一个会话不动）、额度事件按会话记到实际服务的号。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'claude-upstream-smart-'));
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  token: 'test-token-0123456789abcdef0123456789',
  claudeAccounts: [{ id: 'a1', label: 'A', token: 'tokA' }, { id: 'a2', label: 'B', token: 'tokB' }],
  claudeActiveAccount: 'a1',
  claudeAutoSwitch: { enabled: true, strategy: 'smart', seamless: true },
}));
process.env.BRIDGE_DATA_ROOT = dir;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const seen = [];   // { token, sid }
let behave = {};
const sse = (usage) => [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":${JSON.stringify(usage)}}}\n\n`,
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi usage"}}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":${usage.output_tokens || 0}}}\n\n`,
];
const fake = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  seen.push({ token, sid: req.headers['x-claude-code-session-id'] || '' });
  const r = (behave[token] || (() => ({ status: 200, chunks: sse({ input_tokens: 2000, cache_read_input_tokens: 50_000, output_tokens: 800 }) })))();
  res.writeHead(r.status, { 'content-type': 'text/event-stream', ...(r.headers || {}) });
  for (const c of r.chunks || []) { res.write(c); await new Promise((ok) => setTimeout(ok, 3)); }
  res.end();
});
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
process.env.BRIDGE_CLAUDE_UPSTREAM = `http://127.0.0.1:${fake.address().port}`;

const { initClaudeUpstream, engineUpstream, upstreamEvents, lastServedAccount, isUpstreamEnv } = await import('./claude-upstream.mjs');
const { claudeEngineEnv, activeAccountId } = await import('./claude-account.mjs');
const router = await import('./account-router.mjs');
const { applyProbedLimits } = await import('./status.mjs');

initClaudeUpstream();
test.after(() => { fake.close(); fake.closeAllConnections(); });
test.after(() => globalThis[Symbol.for('undici.globalDispatcher.1')]?.close());
let up = null;
for (let i = 0; i < 100 && !(up = engineUpstream()); i++) await new Promise((ok) => setTimeout(ok, 20));
assert.ok(up, '代理没起来（智能分派不开无缝换号也要走代理）');

applyProbedLimits({ five_hour: { pct: 10 }, seven_day: { pct: 10 } }, 'a1');
applyProbedLimits({ five_hour: { pct: 10 }, seven_day: { pct: 10 } }, 'a2');

const call = (sid, model = 'claude-opus-5-5') => fetch(up.baseUrl + '/v1/messages?beta=true', {
  method: 'POST',
  headers: { authorization: 'Bearer from-cli', 'content-type': 'application/json', 'x-claude-code-session-id': sid },
  body: JSON.stringify({ model, max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});

test('CLI 走代理：env 指向本机代理、token 固定；isUpstreamEnv 认得出', () => {
  const env = claudeEngineEnv({});
  assert.ok(env.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tokA');
  assert.ok(isUpstreamEnv(env));
});

test('两个会话并行：各用一个号；响应流原样透传、usage 记进任务', async () => {
  seen.length = 0;
  const [r1, r2] = await Promise.all([call('sess-1'), call('sess-2')]);
  const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
  assert.match(t1, /message_delta/);
  assert.match(t2, /hi usage/);
  const tokens = new Set(seen.map((s) => s.token));
  assert.equal(tokens.size, 2, '两个会话应分到两个号：' + JSON.stringify(seen));
  assert.notEqual(lastServedAccount('sess-1'), lastServedAccount('sess-2'));
  const st = router.routerStatus();
  assert.equal(st.settings.strategy, 'smart');
  assert.ok(st.log.some((l) => l.kind === 'place' && l.sid === 'sess-1'));
  assert.equal(activeAccountId(), 'a1');   // 激活号不跟着动
});

test('同一会话下一次请求留在原号', async () => {
  const before = lastServedAccount('sess-2');
  await (await call('sess-2')).text();
  assert.equal(lastServedAccount('sess-2'), before);
});

test('一个号撞墙：只把撞墙的会话换走并原样重发，另一个会话照旧；只给被换的会话发提示', async () => {
  const a1Sid = lastServedAccount('sess-1') === 'a1' ? 'sess-1' : 'sess-2';
  const other = a1Sid === 'sess-1' ? 'sess-2' : 'sess-1';
  const otherAcct = lastServedAccount(other);
  behave.tokA = () => ({ status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600) }, chunks: ['{"type":"error","error":{"type":"rate_limit_error"}}'] });
  const events = [];
  const on = (e) => events.push(e);
  upstreamEvents.on('switch', on);
  try {
    seen.length = 0;
    const r = await call(a1Sid);
    assert.equal(r.status, 200);
    await r.text();
    assert.deepEqual(seen.map((s) => s.token), ['tokA', 'tokB']);
    assert.equal(lastServedAccount(a1Sid), 'a2');
    assert.equal(events.length, 1);
    assert.equal(events[0].sid, a1Sid);
    await (await call(other)).text();
    assert.equal(lastServedAccount(other), otherAcct === 'a1' ? 'a2' : otherAcct);
  } finally { upstreamEvents.off('switch', on); behave = {}; router.clearCooldown('a1'); }
});

test('Fable 请求被拒（没点名桶、共用额度空着）：只挡这个号的 Fable，Opus 照样能用它', async () => {
  // 11-23 实遇：一个号没有 Fable 额度，一次 Fable 429 把整个号挡到下周，Opus 任务也全绕开它
  behave.tokA = () => ({ status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 7 * 86400) }, chunks: ['{"type":"error","error":{"type":"rate_limit_error"}}'] });
  try {
    await router.noteLimitHit('a1', { kind: 'rate_limit', model: 'claude-fable-5-2', resetsAt: Date.now() + 7 * 86400_000, type: '' });
    assert.ok(router.accountBlock('a1', 'claude-fable-5-2', { soft: false }), 'Fable 应被挡');
    assert.equal(router.accountBlock('a1', 'claude-opus-5-5', { soft: false }), null, 'Opus 不该被连累');
    assert.equal(router.limitScope('a1', 'five_hour', 'claude-fable-5-2'), '*');
    assert.equal(router.limitScope('a1', 'seven_day_overage_included', 'claude-opus-5-5'), 'fable');
    assert.equal(router.limitScope('a1', '', 'claude-opus-5-5'), 'opus');
    assert.equal(router.limitScope('a1', '', 'claude-haiku-4-5'), '*');
  } finally { behave = {}; router.clearCooldown('a1'); }
});

test('分派状态落盘（续聊回原号、学到的计量）', async () => {
  await new Promise((ok) => setTimeout(ok, 3300));
  const f = path.join(dir, 'claude-pool-dispatch.json');
  assert.ok(existsSync(f));
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(j.tasks.sessions['sess-1'] && j.tasks.sessions['sess-2']);
});

test('切回「用满再换」：老路径，按激活号走、不再按会话分', async () => {
  router.setRouterSettings({ strategy: 'fill' });
  try {
    seen.length = 0;
    await Promise.all([(await call('sess-3')).text(), (await call('sess-4')).text()]);
    assert.deepEqual([...new Set(seen.map((s) => s.token))], ['tokA']);
    assert.equal(router.routerStatus().settings.returnToPrimary, false);
    router.setRouterSettings({ returnToPrimary: true });
    assert.equal(router.routerSettings().strategy, 'primary');
  } finally { router.setRouterSettings({ strategy: 'smart' }); }
});
