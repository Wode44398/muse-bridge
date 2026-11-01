// 自备 OAuth 应用（mcp-oauth-app.mjs）+ bridge 自己授权的流程（mcp-oauth.mjs startExternalFlow）。
// 本地起一个不开放动态注册的授权服务器 + 要令牌的 MCP 服务，走 发现 → 授权地址 → 换令牌 → 流程结局。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { discoverAuth, buildAuthRequest, exchangeCode, humanTokenError, providerOf, _resetOAuthApp } from './mcp-oauth-app.mjs';
import { startExternalFlow, submitMcpCallback, flowByState, _resetMcpOAuth } from './mcp-oauth.mjs';

const CID = 'cid-1', SEC = 'se/c+=';

async function mockServer({ methods = ['client_secret_basic'], dcr = false } = {}) {
  const codes = new Map(), seen = [];
  let base = '';
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const J = (code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/mcp') return J(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return J(200, { resource: base + '/mcp', authorization_servers: [base + '/'], scopes_supported: ['a', 'b'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return J(200, {
      issuer: base + '/', authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: methods, ...(dcr ? { registration_endpoint: base + '/register' } : {}),
    });
    if (u.pathname === '/authorize') {
      const code = crypto.randomBytes(6).toString('hex');
      codes.set(code, u.searchParams.get('code_challenge'));
      res.writeHead(302, { location: u.searchParams.get('redirect_uri') + '?code=' + code + '&state=' + u.searchParams.get('state') });
      return res.end();
    }
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body);
      const basic = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
      const [id, sec] = req.headers.authorization ? basic : [p.get('client_id'), p.get('client_secret')];
      seen.push({ how: req.headers.authorization ? 'basic' : 'post', resource: p.get('resource') });
      if (id !== CID || sec !== SEC) return J(401, { error: 'invalid_client' });
      const ch = codes.get(p.get('code'));
      if (!ch || crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url') !== ch) return J(400, { error: 'invalid_grant' });
      return J(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
  return { base, url: base + '/mcp', seen, close: () => srv.close() };
}

const APP = { clientId: CID, clientSecret: SEC, redirectUri: 'https://bridge.example/api/mcp-oauth/callback' };
const follow = async (authUrl) => (await fetch(authUrl, { redirect: 'manual' })).headers.get('location');

test('发现：WWW-Authenticate → 资源元数据 → 授权服务器，认出不开放动态注册', async () => {
  _resetOAuthApp();
  const m = await mockServer();
  try {
    const d = await discoverAuth(m.url);
    assert.equal(d.oauth, true);
    assert.equal(d.dcr, false);
    assert.equal(d.issuer, m.base);
    assert.deepEqual(d.scopes, ['a', 'b']);
    assert.equal(d.resourceMetadataUrl, m.base + '/.well-known/oauth-protected-resource/mcp');
  } finally { m.close(); }
});

test('发现：开放动态注册的标出来（照旧交给 CLI）', async () => {
  _resetOAuthApp();
  const m = await mockServer({ dcr: true });
  try { assert.equal((await discoverAuth(m.url)).dcr, true); } finally { m.close(); }
});

test('授权地址：PKCE + resource + scope；Google 额外要 access_type=offline、prompt=consent', () => {
  const d = { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', scopes: ['x', 'y'], resource: 'https://gmailmcp.googleapis.com/mcp/v1', provider: 'google' };
  const { authUrl, state, verifier } = buildAuthRequest(d, APP);
  const q = new URL(authUrl).searchParams;
  assert.equal(q.get('client_id'), CID);
  assert.equal(q.get('redirect_uri'), APP.redirectUri);
  assert.equal(q.get('scope'), 'x y');
  assert.equal(q.get('resource'), d.resource);
  assert.equal(q.get('code_challenge'), crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('state'), state);
  assert.ok(state.length >= 16);
  const z = new URL(buildAuthRequest({ ...d, provider: 'zoom' }, APP).authUrl).searchParams;
  assert.equal(z.get('access_type'), null);
});

test('平台按授权服务器主机认', () => {
  assert.equal(providerOf('https://accounts.google.com'), 'google');
  assert.equal(providerOf('https://zoom.us'), 'zoom');
  assert.equal(providerOf('https://clerk.context7.com'), '');
});

for (const methods of [['client_secret_basic'], ['client_secret_post']]) {
  test('换令牌：' + methods[0], async () => {
    _resetOAuthApp();
    const m = await mockServer({ methods });
    try {
      const d = await discoverAuth(m.url);
      const { authUrl, verifier } = buildAuthRequest(d, APP);
      const tok = await exchangeCode(d, APP, verifier, await follow(authUrl));
      assert.equal(tok.access_token, 'at');
      assert.equal(m.seen[0].how, methods[0] === 'client_secret_basic' ? 'basic' : 'post');
      assert.equal(m.seen[0].resource, m.url);
    } finally { m.close(); }
  });
}

test('换令牌：密钥不对 / 用户拒绝 → 人话', async () => {
  _resetOAuthApp();
  const m = await mockServer();
  try {
    const d = await discoverAuth(m.url);
    const { authUrl, verifier } = buildAuthRequest(d, APP);
    await assert.rejects(exchangeCode(d, { ...APP, clientSecret: 'nope' }, verifier, await follow(authUrl)), /客户端 ID 或密钥不对/);
    await assert.rejects(exchangeCode(d, APP, verifier, APP.redirectUri + '?error=access_denied&state=s'), /拒绝/);
  } finally { m.close(); }
  assert.match(humanTokenError('redirect_uri_mismatch'), /回调地址/);
  assert.match(humanTokenError('', 'Invalid scope'), /权限/);
});

test('外部流程：回调交回 → exchange + verify → done；state 一次性', async () => {
  _resetMcpOAuth();
  let got = '', settled = null;
  const v = startExternalFlow({
    key: 'k', sid: 'ext:x', server: 'zoom', authUrl: 'https://zoom.us/oauth/authorize?x=1', state: 'S'.repeat(32), redirectUri: APP.redirectUri,
    exchange: async (u) => { got = u; }, verify: async () => [{ name: 'zoom', status: 'connected', tools: [] }],
    onSettled: (x) => { settled = x; },
  });
  assert.equal(v.status, 'waiting');
  assert.equal(v.scheme, 'custom');
  const f = flowByState('S'.repeat(32));
  assert.ok(f);
  const r = await submitMcpCallback(f, APP.redirectUri + '?code=c&state=' + 'S'.repeat(32));
  assert.equal(r.ok, true);
  assert.match(got, /code=c/);
  assert.equal(settled.status, 'done');
  assert.equal(settled.servers[0].status, 'connected');
  assert.equal(flowByState('S'.repeat(32)), null);
});

test('外部流程：换令牌失败 → error，带原因', async () => {
  _resetMcpOAuth();
  let settled = null;
  startExternalFlow({
    key: 'k', sid: 'ext:x', server: 'zoom', authUrl: 'https://zoom.us/a', state: 'T'.repeat(32), redirectUri: APP.redirectUri,
    exchange: async () => { throw new Error('客户端 ID 或密钥不对'); }, verify: async () => null, onSettled: (x) => { settled = x; },
  });
  const r = await submitMcpCallback(flowByState('T'.repeat(32)), APP.redirectUri + '?code=c&state=' + 'T'.repeat(32));
  assert.equal(r.ok, false);
  assert.equal(settled.status, 'error');
  assert.match(settled.error, /密钥不对/);
});
