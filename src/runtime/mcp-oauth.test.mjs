import test from 'node:test';
import assert from 'node:assert/strict';
import { startMcpAuth, submitMcpCallback, confirmMcpAuth, flowByState, flowFor, noteLiveQuery, checkCallbackUrl, _resetMcpOAuth } from './mcp-oauth.mjs';
import { publicOriginOf } from '../routes/mcp-oauth.mjs';

const STATE = 'st_' + 'x'.repeat(30);

// 假 Query：按场景回 mcpAuthenticate，记录调用
function fakeQ({ auth, submitErr, status = 'connected' } = {}) {
  const calls = [];
  let st = 'needs-auth';
  const q = {
    calls,
    async mcpAuthenticate(name, redirectUri) { calls.push(['auth', name, redirectUri]); return typeof auth === 'function' ? auth(redirectUri) : auth; },
    async mcpSubmitOAuthCallbackUrl(name, url) { calls.push(['submit', name, url]); if (submitErr) throw new Error(submitErr); st = status; return {}; },
    async reconnectMcpServer(name) { calls.push(['reconnect', name]); },
    async mcpServerStatus() { calls.push(['status']); return [{ name: 'figma', status: st }]; },
    setStatus(s) { st = s; },
  };
  return q;
}
const custom = { requiresUserAction: true, callbackExpected: true, redirectScheme: 'custom', state: STATE, authUrl: 'https://auth.example/authorize?x=1' };
const local = { requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost', state: STATE, authUrl: 'https://auth.example/authorize?y=1', callbackPort: 51234 };

test.beforeEach(() => _resetMcpOAuth());

test('custom：借会话活着的 CLI，按 state 回调交回后重连并推结局', async () => {
  const q = fakeQ({ auth: custom });
  noteLiveQuery('admin', 'sess-1234', q);
  const settled = [];
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b.example/api/mcp-oauth/callback', onSettled: (x) => settled.push(x) });
  assert.equal(v.status, 'waiting');
  assert.equal(v.scheme, 'custom');
  assert.equal(v.authUrl, custom.authUrl);
  assert.deepEqual(q.calls[0], ['auth', 'figma', 'https://b.example/api/mcp-oauth/callback']);
  const f = flowByState(STATE);
  assert.ok(f);
  const r = await submitMcpCallback(f, `https://b.example/api/mcp-oauth/callback?code=abc&state=${STATE}`);
  assert.equal(r.ok, true);
  assert.equal(r.flow.status, 'done');
  assert.ok(q.calls.some((c) => c[0] === 'reconnect'));
  assert.equal(settled.length, 1);
  assert.equal(settled[0].servers[0].status, 'connected');
  // 一次性：同一个 state 不能再用
  assert.equal(flowByState(STATE), null);
  const again = await submitMcpCallback(f, `https://b.example/api/mcp-oauth/callback?code=abc&state=${STATE}`);
  assert.equal(again.ok, false);
});

test('state 校验：对不上 / 太短 / 没有 code 一律不交给 CLI，流程还在', async () => {
  const q = fakeQ({ auth: custom });
  noteLiveQuery('admin', 'sess-1234', q);
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b/cb' });
  assert.equal(flowByState('short'), null);
  assert.equal(flowByState('st_' + 'y'.repeat(30)), null);
  const f = flowFor('admin', v.id);
  assert.equal(flowFor('user:bob', v.id), null);   // 别的身份拿不到
  let r = await submitMcpCallback(f, `https://b/cb?code=abc&state=${'z'.repeat(20)}`);
  assert.equal(r.ok, false);
  r = await submitMcpCallback(f, `https://b/cb?state=${STATE}`);
  assert.equal(r.ok, false);
  r = await submitMcpCallback(f, 'not a url');
  assert.equal(r.ok, false);
  assert.ok(!q.calls.some((c) => c[0] === 'submit'));
  assert.equal(flowFor('admin', v.id).status, 'waiting');
});

test('localhost：退回 localhost 时给出端口，粘贴完整地址后完成', async () => {
  const q = fakeQ({ auth: local });
  noteLiveQuery('admin', 'sess-1234', q);
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b/cb', pollMs: 60_000 });
  assert.equal(v.scheme, 'localhost');
  assert.equal(v.callbackPort, 51234);
  const r = await submitMcpCallback(flowFor('admin', v.id), `http://localhost:51234/callback?code=abc&state=${STATE}`);
  assert.equal(r.ok, true);
  assert.equal(q.calls.find((c) => c[0] === 'submit')[2], `http://localhost:51234/callback?code=abc&state=${STATE}`);
});

test('localhost：同机浏览器直接打到 CLI 监听，轮询发现已连上即完成', async () => {
  const q = fakeQ({ auth: local });
  noteLiveQuery('admin', 'sess-1234', q);
  const settled = [];
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b/cb', pollMs: 10, onSettled: (x) => settled.push(x) });
  q.setStatus('connected');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flowFor('admin', v.id).status, 'done');
  assert.equal(settled.length, 1);
});

test('CLI 拒绝回调：流程记错误并收掉临时进程', async () => {
  const q = fakeQ({ auth: custom, submitErr: 'OAuth state mismatch' });
  let released = 0;
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b/cb', spawn: async () => ({ q, release: () => { released++; } }) });
  const r = await submitMcpCallback(flowFor('admin', v.id), `https://b/cb?code=abc&state=${STATE}`);
  assert.equal(r.ok, false);
  assert.match(r.error, /mismatch/);
  assert.equal(flowFor('admin', v.id).status, 'error');
  assert.equal(released, 1);
});

test('会话空闲：起临时进程，成功后也让刚出现的会话 CLI 重连，并收掉临时进程', async () => {
  const tmp = fakeQ({ auth: custom });
  const sess = fakeQ({ auth: custom });
  let released = 0;
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b/cb', spawn: async () => ({ q: tmp, release: () => { released++; } }) });
  noteLiveQuery('admin', 'sess-1234', sess);
  await submitMcpCallback(flowFor('admin', v.id), `https://b/cb?code=abc&state=${STATE}`);
  assert.equal(released, 1);
  assert.ok(sess.calls.some((c) => c[0] === 'reconnect'));
});

test('超时：过期后回调不认、临时进程收掉', async () => {
  const q = fakeQ({ auth: custom });
  let released = 0;
  const settled = [];
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', redirectUri: 'https://b/cb', ttlMs: 30, spawn: async () => ({ q, release: () => { released++; } }), onSettled: (x) => settled.push(x) });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(flowFor('admin', v.id).status, 'expired');
  assert.equal(flowByState(STATE), null);
  assert.equal(released, 1);
  assert.equal(settled[0].status, 'expired');
});

test('发起授权失败（服务器不存在等）：直接报错收掉', async () => {
  const q = { async mcpAuthenticate() { throw new Error('Server not found: x'); } };
  let released = 0;
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'x', spawn: async () => ({ q, release: () => { released++; } }) });
  assert.equal(v.status, 'error');
  assert.match(v.error, /not found/);
  assert.equal(released, 1);
});

test('不需要回调（claude.ai 代理类）：「我已完成」重连后连上即完成', async () => {
  const q = fakeQ({ auth: { requiresUserAction: true, callbackExpected: false, authUrl: 'https://claude.ai/x' } });
  noteLiveQuery('admin', 'sess-1234', q);
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma', pollMs: 60_000 });
  assert.equal(v.scheme, 'web');
  assert.equal(flowByState(STATE), null);
  assert.equal((await confirmMcpAuth(flowFor('admin', v.id))).status, 'waiting');
  q.setStatus('connected');
  assert.equal((await confirmMcpAuth(flowFor('admin', v.id))).status, 'done');
});

test('已有可用令牌（不需要用户操作）：直接重连完成', async () => {
  const q = fakeQ({ auth: { requiresUserAction: false, callbackExpected: false } });
  q.setStatus('connected');
  noteLiveQuery('admin', 'sess-1234', q);
  const v = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma' });
  assert.equal(v.status, 'done');
});

test('同一连接器再点一次授权：旧流程作废', async () => {
  const q = fakeQ({ auth: custom });
  noteLiveQuery('admin', 'sess-1234', q);
  const a = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma' });
  const b = await startMcpAuth({ key: 'admin', sid: 'sess-1234', server: 'figma' });
  assert.equal(flowFor('admin', a.id).status, 'cancelled');
  assert.equal(flowFor('admin', b.id).status, 'waiting');
});

test('checkCallbackUrl', () => {
  assert.equal(checkCallbackUrl('http://localhost:1/callback?code=1&state=s', 's').ok, true);
  assert.equal(checkCallbackUrl('http://localhost:1/callback?error=access_denied&state=s', 's').ok, true);
  assert.equal(checkCallbackUrl('javascript:alert(1)?code=1', '').ok, false);
});

test('publicOriginOf：反代头优先，回环退到配置的公网地址', () => {
  const req = (headers, encrypted = false) => ({ headers, socket: { encrypted } });
  assert.equal(publicOriginOf(req({ host: '127.0.0.1:8787', 'x-forwarded-host': 'bridge.example.com', 'x-forwarded-proto': 'https' }), ''), 'https://bridge.example.com');
  assert.equal(publicOriginOf(req({ host: 'bridge.example.com', 'cf-visitor': '{"scheme":"https"}' }), ''), 'https://bridge.example.com');
  assert.equal(publicOriginOf(req({ host: 'x', forwarded: 'for=1.2.3.4;host=a.example;proto=https' }), ''), 'https://a.example');
  assert.equal(publicOriginOf(req({ host: '127.0.0.1:8787' }), 'https://pub.example/'), 'https://pub.example');
  assert.equal(publicOriginOf(req({ host: 'localhost:8787' }), ''), 'http://localhost:8787');
  assert.equal(publicOriginOf(req({ host: '192.168.1.5:8787' }), 'https://pub.example'), 'http://192.168.1.5:8787');
});
