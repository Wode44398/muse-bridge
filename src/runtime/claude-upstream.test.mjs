// 号池「会话中无缝换号」的本机上游代理（claude-upstream.mjs）。
// 数据根指到临时目录、上游换成本地假 Anthropic（按 token 决定回什么），验证：流式原样透传并按号记余量、
// 额度被拒的 429 / 401 当场换号重发（CLI 只看到 200）、瞬时 429 原样回、快满的号在请求前就让位、
// CLI 的 env（地址 + 固定 token）、开关关着不注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'claude-upstream-'));
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  token: 'test-token-0123456789abcdef0123456789',
  claudeAccounts: [{ id: 'a1', label: 'A', token: 'tokA' }, { id: 'a2', label: 'B', token: 'tokB' }],
  claudeActiveAccount: 'a1',
  claudeAutoSwitch: { enabled: true, returnToPrimary: false, seamless: true },
}));
process.env.BRIDGE_DATA_ROOT = dir;
// 测试不吃进程环境：从 Claude Code 会话的 shell 里跑时会继承 ANTHROPIC_BASE_URL / AUTH_TOKEN，
// 「开关关掉不注入代理地址」那条就会拿到继承来的地址而失败（10-21，R7）
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;

// 假上游：behave[token](body) → { status, headers, chunks }。
const seen = [];   // { path, token, model }
let behave = {};
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  seen.push({ path: req.url, token, model: body.model });
  const r = (behave[token] || (() => ({ status: 200, chunks: ['ok'] })))(body);
  res.writeHead(r.status, { 'content-type': 'text/event-stream', ...(r.headers || {}) });
  for (const c of r.chunks || []) { res.write(c); await new Promise((ok) => setTimeout(ok, 5)); }
  res.end();
});
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
process.env.BRIDGE_CLAUDE_UPSTREAM = `http://127.0.0.1:${fake.address().port}`;

const { initClaudeUpstream, engineUpstream, upstreamEvents, lastServedAccount } = await import('./claude-upstream.mjs');
const { claudeEngineEnv, setActive, activeAccountId } = await import('./claude-account.mjs');
const router = await import('./account-router.mjs');
const { accountLimits, applyProbedLimits } = await import('./status.mjs');

initClaudeUpstream();
// 假上游放在 after 里关：写在某条用例的断言之后，那条一失败它就不关，整个 node --test 挂住到超时
test.after(() => { fake.close(); fake.closeAllConnections(); });
// fetch（undici 全局连接池）照代理回的 Keep-Alive: timeout=65 把空闲连接留约一分钟，进程得挂到那时才退：跑完关掉它
test.after(() => globalThis[Symbol.for('undici.globalDispatcher.1')]?.close());
let up = null;
for (let i = 0; i < 100 && !(up = engineUpstream()); i++) await new Promise((ok) => setTimeout(ok, 20));
assert.ok(up, '代理没起来');

const reset = () => {
  setActive('a1'); router.clearCooldown('a1'); router.clearCooldown('a2');
  applyProbedLimits({ five_hour: { pct: 10 }, seven_day: { pct: 10 } }, 'a1');
  applyProbedLimits({ five_hour: { pct: 10 }, seven_day: { pct: 10 } }, 'a2');
  behave = {}; seen.length = 0;
};
const call = (model = 'claude-opus-5-5') => fetch(up.baseUrl + '/v1/messages?beta=true', {
  method: 'POST',
  headers: { authorization: 'Bearer from-cli', 'content-type': 'application/json', 'anthropic-beta': 'test-beta-2026' },
  body: JSON.stringify({ model, max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});
const rejected = { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.02', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 7200) }, chunks: ['{"type":"error","error":{"type":"rate_limit_error"}}'] };

test('CLI env：指向本机代理、声明按官方地址对待、token 固定为号池第一个号', () => {
  setActive('a2');
  const env = claudeEngineEnv({});
  assert.equal(env.ANTHROPIC_BASE_URL, up.baseUrl);
  assert.equal(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tokA');   // 激活的是 B，env 里仍是 A：换号不让停放的 CLI 冷起
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  setActive('a1');
});

test('流式回答原样透传；鉴权换成激活号；响应头余量记到该号名下', async () => {
  reset();
  behave.tokA = () => ({ status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) }, chunks: ['event: a\n\n', 'event: b\n\n'] });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'event: a\n\nevent: b\n\n');
  assert.deepEqual(seen.map((s) => s.token), ['tokA']);
  assert.equal(seen[0].path, '/v1/messages?beta=true');
  assert.equal(accountLimits('a1').five_hour.pct, 42);
  assert.equal(lastServedAccount(), 'a1');
});

test('额度被拒的 429：给该号记冷却、换号、原样重发——CLI 只看到 200', async () => {
  reset();
  behave.tokA = () => rejected;
  behave.tokB = () => ({ status: 200, chunks: ['fromB'] });
  const switches = [];
  const on = (sw) => switches.push(sw);
  upstreamEvents.on('switch', on);
  const r = await call();
  upstreamEvents.off('switch', on);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'fromB');
  assert.deepEqual(seen.map((s) => s.token), ['tokA', 'tokB']);
  assert.equal(activeAccountId(), 'a2');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].from, 'a1');
  assert.equal(lastServedAccount(), 'a2');
  // 下一个请求直接走 B，不再先撞 A
  seen.length = 0;
  await (await call()).text();
  assert.deepEqual(seen.map((s) => s.token), ['tokB']);
});

test('瞬时 429（不是额度被拒）原样回给 CLI，由它自己退避，不换号', async () => {
  reset();
  behave.tokA = () => ({ status: 429, headers: { 'retry-after': '1' }, chunks: ['{"type":"error"}'] });
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(await r.text(), '{"type":"error"}');
  assert.equal(activeAccountId(), 'a1');
  assert.equal(seen.length, 1);
});

test('401（token 失效）同样换号重发', async () => {
  reset();
  behave.tokA = () => ({ status: 401, chunks: ['{"type":"error","error":{"type":"authentication_error"}}'] });
  behave.tokB = () => ({ status: 200, chunks: ['ok'] });
  const r = await call();
  assert.equal(r.status, 200);
  assert.equal(activeAccountId(), 'a2');
});

test('快满（≥98%）的号在请求发出前就让位给更空的号', async () => {
  reset();
  applyProbedLimits({ five_hour: { pct: 99, resetsAt: Date.now() + 3600_000 } }, 'a1');
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(seen.map((s) => s.token), ['tokB']);
  assert.equal(router.routerStatus().log[0].reason, 'near:five_hour');
  assert.equal(router.reasonText('near:five_hour'), '5 小时额度快满了');
});

test('当前号只是快满、别的号也快满：不来回倒（每倒一次要重建提示缓存）', async () => {
  reset();
  applyProbedLimits({ five_hour: { pct: 99, resetsAt: Date.now() + 3600_000 } }, 'a1');
  applyProbedLimits({ five_hour: { pct: 99, resetsAt: Date.now() + 3600_000 } }, 'a2');
  await (await call('claude-sonnet-5-5')).text();
  assert.deepEqual(seen.map((s) => s.token), ['tokA']);
  assert.equal(activeAccountId(), 'a1');
});

test('全员用尽：429 原样回给 CLI（走原来的限额卡 / 到点续跑）', async () => {
  reset();
  behave.tokA = () => rejected;
  behave.tokB = () => rejected;
  const r = await call('claude-haiku-5-5');
  assert.equal(r.status, 429);
  assert.match(await r.text(), /rate_limit_error/);
  assert.ok(seen.length <= 2);
});

test('开关关掉：新起的 CLI 不再注入代理地址', () => {
  router.setRouterSettings({ seamless: false });
  const env = claudeEngineEnv({});
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, undefined);
  router.setRouterSettings({ seamless: true });
});
