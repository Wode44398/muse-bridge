// 自备 OAuth 应用：授权服务器不开放动态注册客户端时（Google 的 Gmail / Drive、Zoom……），CLI 拿不到授权地址。
// 服主在平台后台自己注册一个 OAuth 应用，把客户端 ID / 密钥填进 bridge（全服一份，按授权服务器存，同一平台的
// 连接器共用一个应用），授权这一步由 bridge 自己做：
//   发现（受保护资源元数据 → 授权服务器元数据）→ PKCE 授权地址（回调 = bridge 自己的 /api/mcp-oauth/callback，
//   哪台设备上点都能跳回来；CLI 用预注册客户端时只肯回 localhost）→ 换令牌 → 按 CLI 的格式写进这个身份的
//   CLAUDE_CONFIG_DIR/.credentials.json（mcpOAuth[服务名|配置哈希]，带 clientId / clientSecret）。
// 之后连接、到期续令牌都是 CLI 自己的事：它先认 mcpOAuth 条目里的 clientId（不再去动态注册），续令牌用同一份密钥。
// 授权参数照抄 CLI（PKCE S256 + resource + 受保护资源元数据里的全部 scope），平台怪癖见 PROVIDERS。
// 密钥存在连接器凭据的加密存储里（extension-secrets.mjs，键 `oauth-app:<授权服务器>`），不下发前端、不进 git。
import crypto from 'node:crypto';
import { readSecrets, writeSecrets } from '../extension-secrets.mjs';
import { EXT_ROOT } from '../extensions.mjs';
import { mcpTokenKey, updateCreds } from './mcp-probe.mjs';

const FETCH_MS = 10_000;
const DISC_TTL_MS = 6 * 3600_000;
const DISC_FAIL_TTL_MS = 60_000;
const APP_PREFIX = 'oauth-app:';

// 平台：按授权服务器的主机认。authParams = 授权地址上要额外带的参数
//   Google：不带 access_type=offline 不发 refresh_token（一小时后掉线）；不带 prompt=consent 第二次授权也不发
export const PROVIDERS = {
  google: { name: 'Google', host: /(^|\.)google\.com$/i, authParams: { access_type: 'offline', prompt: 'consent' } },
  zoom: { name: 'Zoom', host: /(^|\.)zoom\.us$/i },
};
export function providerOf(issuer) {
  let host = '';
  try { host = new URL(issuer).hostname; } catch { return ''; }
  return Object.keys(PROVIDERS).find((k) => PROVIDERS[k].host.test(host)) || '';
}

const normIssuer = (s) => String(s || '').trim().replace(/\/+$/, '');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_MS) });
    if (!r.ok) { try { await r.body?.cancel(); } catch {} return null; }
    return await r.json();
  } catch { return null; }
}

function parseWwwAuth(h) {
  const out = {};
  for (const m of String(h || '').matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

// —— 发现 ——
const disc = new Map();   // 连接器地址 → { until, v } | { until, err }

/**
 * 这个远程 MCP 服务要不要 OAuth、授权服务器是谁、支不支持动态注册。网络不通就抛（调用方退回 CLI 那条路）。
 * @returns { oauth:false } | { oauth:true, resource, resourceMetadataUrl, authServerUrl, issuer, provider,
 *   authorizationEndpoint, tokenEndpoint, dcr, scopes[], authMethods[] }
 */
export async function discoverAuth(url, { force = false } = {}) {
  const hit = disc.get(url);
  if (!force && hit && Date.now() < hit.until) { if (hit.err) throw hit.err; return hit.v; }
  try {
    const v = await discover(url);
    disc.set(url, { until: Date.now() + DISC_TTL_MS, v });
    return v;
  } catch (e) {
    disc.set(url, { until: Date.now() + DISC_FAIL_TTL_MS, err: e });
    throw e;
  }
}

async function discover(url) {
  const u = new URL(url);
  // ① 不带令牌敲一下：要登录的回 401 + WWW-Authenticate（资源元数据地址、要的 scope）。
  //   Gmail 这类 initialize 不要登录（调工具才 401），就靠 ② 的约定地址
  let www = {}, reached = false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-bridge', version: '1' } } }),
      signal: AbortSignal.timeout(FETCH_MS),
    });
    reached = true;
    if (r.status === 401) www = parseWwwAuth(r.headers.get('www-authenticate'));
    try { await r.body?.cancel(); } catch {}
  } catch (e) {
    throw new Error('连不上 ' + u.host + '：' + String(e?.cause?.code || e?.message || e));
  }
  // ② 受保护资源元数据（RFC 9728）：WWW-Authenticate 给的 → 带路径的约定地址 → 根上的约定地址
  const path = u.pathname.replace(/\/+$/, '');
  const prmUrls = [www.resource_metadata, path && `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let prm = null, prmUrl = null;
  for (const p of prmUrls) {
    const j = await getJson(p);
    if (j && Array.isArray(j.authorization_servers) && j.authorization_servers.length) { prm = j; prmUrl = p; break; }
  }
  // ③ 授权服务器元数据（RFC 8414 / OIDC），没有资源元数据就按老规矩认服务本身的源
  const asUrl = String(prm ? prm.authorization_servers[0] : u.origin);
  const as = new URL(asUrl);
  const ap = as.pathname.replace(/\/+$/, '');
  const metaUrls = ap
    ? [`${as.origin}/.well-known/oauth-authorization-server${ap}`, `${as.origin}/.well-known/openid-configuration${ap}`, `${as.origin}${ap}/.well-known/openid-configuration`]
    : [`${as.origin}/.well-known/oauth-authorization-server`, `${as.origin}/.well-known/openid-configuration`];
  let meta = null;
  for (const m of metaUrls) {
    const j = await getJson(m);
    if (j && j.authorization_endpoint && j.token_endpoint) { meta = j; break; }
  }
  if (!meta || !reached) return { oauth: false };
  const issuer = normIssuer(meta.issuer || asUrl);
  const scopes = www.scope ? www.scope.split(/\s+/).filter(Boolean) : Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.map(String) : [];
  return {
    oauth: true, resource: url, resourceMetadataUrl: prmUrl, authServerUrl: asUrl, issuer, provider: providerOf(issuer),
    authorizationEndpoint: String(meta.authorization_endpoint), tokenEndpoint: String(meta.token_endpoint),
    dcr: typeof meta.registration_endpoint === 'string' || meta.client_id_metadata_document_supported === true,
    scopes, authMethods: Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.map(String) : [],
  };
}

// —— 应用（全服一份，按授权服务器）——
const appKey = (issuer) => APP_PREFIX + normIssuer(issuer);

/** 读应用（含密钥，只给服务端用）。密文解不开就抛。 */
export function getApp(issuer) {
  const a = readSecrets(EXT_ROOT)[appKey(issuer)];
  return a && a.clientId ? a : null;
}
/** 给前端看的样子：密钥只说有没有 */
export const publicApp = (a) => (a ? { clientId: a.clientId, hasSecret: !!a.clientSecret, redirectUri: a.redirectUri, updated: a.updated || 0 } : null);

/** 保存。clientSecret 留空 = 沿用旧的。 */
export function saveApp(issuer, { clientId, clientSecret, redirectUri }) {
  const id = String(clientId || '').trim(), sec = String(clientSecret || '').trim(), ru = String(redirectUri || '').trim();
  if (!id || id.length > 500) throw Object.assign(new Error('请填写客户端 ID'), { status: 400 });
  let r;
  try { r = new URL(ru); } catch { r = null; }
  if (!r || !/^https?:$/.test(r.protocol)) throw Object.assign(new Error('回调地址不是完整的网址'), { status: 400 });
  const all = { ...readSecrets(EXT_ROOT) };
  const k = appKey(issuer);
  const old = all[k] || {};
  const secret = sec || (old.clientId === id ? old.clientSecret || '' : '');
  if (!secret) throw Object.assign(new Error('请填写客户端密钥'), { status: 400 });
  all[k] = { clientId: id, clientSecret: secret, redirectUri: r.href, updated: Date.now() };
  writeSecrets(EXT_ROOT, all);
  return all[k];
}
export function removeApp(issuer) {
  const all = { ...readSecrets(EXT_ROOT) };
  const k = appKey(issuer);
  if (!(k in all)) return false;
  delete all[k];
  writeSecrets(EXT_ROOT, all);
  return true;
}

// —— 授权 ——
/** 授权地址 + PKCE。返回 { authUrl, state, verifier } */
export function buildAuthRequest(d, app) {
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(24));
  const u = new URL(d.authorizationEndpoint);
  const p = {
    response_type: 'code', client_id: app.clientId,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    redirect_uri: app.redirectUri, state,
    ...(d.scopes.length ? { scope: d.scopes.join(' ') } : {}),
    resource: d.resource,
    ...(PROVIDERS[d.provider]?.authParams || {}),
  };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return { authUrl: u.href, state, verifier };
}

// 平台回的错误 → 服主知道去后台改哪一项
export function humanTokenError(code, desc = '') {
  const c = String(code || ''), d = String(desc || '');
  if (c === 'access_denied') return '你在授权页拒绝了授权';
  if (c === 'invalid_client' || /client_id|client secret|client_secret/i.test(d)) return '客户端 ID 或密钥不对：回平台后台核对，再到这个连接器的「OAuth 应用」里重新填';
  if (c === 'redirect_uri_mismatch' || /redirect/i.test(d)) return '回调地址和平台后台登记的不一致：把「OAuth 应用」里的回调地址原样登记到后台';
  if (c === 'invalid_scope' || /scope/i.test(d)) return '平台后台没给这个应用开全权限（scope）：照「OAuth 应用」里的清单在后台补上';
  if (c === 'unauthorized_client') return '这个应用不允许这种授权方式：检查后台的应用类型（Google 选「Web 应用」，Zoom 选用户级 OAuth）';
  if (c === 'invalid_grant') return '授权码已失效（超时或已用过），请重新连接';
  return '授权失败：' + (d || c || '平台没有返回原因').slice(0, 200);
}

/** 用回调地址里的 code 换令牌。失败抛人话。 */
export async function exchangeCode(d, app, verifier, callbackUrl) {
  const cb = new URL(callbackUrl);
  const err = cb.searchParams.get('error');
  if (err) throw new Error(humanTokenError(err, cb.searchParams.get('error_description')));
  const code = cb.searchParams.get('code');
  if (!code) throw new Error('回调地址里没有授权码');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, code_verifier: verifier, resource: d.resource });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  // 与 MCP SDK 同一取法：平台列了 client_secret_basic（或没列，RFC 默认）就走 Basic，否则放进表单
  if (!d.authMethods.length || d.authMethods.includes('client_secret_basic')) {
    headers.authorization = 'Basic ' + Buffer.from(encodeURIComponent(app.clientId) + ':' + encodeURIComponent(app.clientSecret)).toString('base64');
  } else {
    body.set('client_id', app.clientId);
    body.set('client_secret', app.clientSecret);
  }
  let r;
  try { r = await fetch(d.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new Error('连不上授权服务器换令牌：' + String(e?.cause?.code || e?.message || e)); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j || !j.access_token) throw new Error(humanTokenError(j?.error, j?.error_description || j?.reason || (r.ok ? '' : 'HTTP ' + r.status)));
  return j;
}

/** 按 CLI 的格式写进这个身份的凭据文件；之后 CLI 自己用、自己续。 */
export function writeTokens(ctx, server, config, d, app, tok) {
  const key = mcpTokenKey(server, config);
  updateCreds(ctx, (data) => {
    if (!data.mcpOAuth || typeof data.mcpOAuth !== 'object') data.mcpOAuth = {};
    const prev = data.mcpOAuth[key] || {};
    const ds = { ...(prev.discoveryState || {}), authorizationServerUrl: d.authServerUrl, oauthMetadataFound: true };
    if (d.resourceMetadataUrl) ds.resourceMetadataUrl = d.resourceMetadataUrl;
    delete ds.registrationNotOfferedAt;   // CLI 记的「不开放注册」：有了 clientId 就不相干了
    data.mcpOAuth[key] = {
      ...prev,
      serverName: server, serverUrl: config.url,
      accessToken: String(tok.access_token),
      refreshToken: tok.refresh_token ? String(tok.refresh_token) : undefined,
      expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
      scope: tok.scope ? String(tok.scope) : d.scopes.join(' '),
      clientId: app.clientId, clientSecret: app.clientSecret,
      discoveryState: ds,
    };
  });
}

// 测试用
export function _resetOAuthApp() { disc.clear(); }
