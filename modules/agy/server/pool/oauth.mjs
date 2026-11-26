// Antigravity 多账号 Google OAuth 授权、Refresh Token 换取与 Access Token 自动续期。
// 交互登录同时支持两种完成方式：
//   1) 本机同屏打开授权页 → 临时回环服务器（127.0.0.1:<随机端口>/oauth-callback）自动接收回调并入池；
//   2) 手机 / 异机打开授权页 → 复制浏览器跳转后的回调 URL 或授权码粘贴回界面完成入池。
// 两种路径都不触碰本机系统钥匙串，不干扰同一台电脑上官方 Antigravity 客户端的登录态。

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { plainDispatcher } from '@bridge/core/runtime/net-proxy.mjs';
import { overlayHook } from '@bridge/core/runtime/overlay-hooks.mjs';
import {
  getAccountInternal,
  localAccountId,
  addAccount,
  updateAccount,
  noteAccountMeta,
} from './accounts.mjs';
import {
  slotDirFor,
  promoteSlotDir,
  startSlotLoginFlow,
  getSlotLoginStatus,
  submitSlotLoginCode,
  markSlotFlowResult,
  cancelSlotLoginFlow,
  captureSlotAccessToken,
  shutdownSlotFlows,
  _resetSlotsForTest,
} from './slots.mjs';

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

// 号池用的 Google OAuth 客户端（Antigravity CLI 官方程序自带的安装型客户端）。源码里不写死这组值：公开库会被 GitHub 推送保护按密钥拦下，
// 公开版也不该替用户分发它。取值顺序：环境变量 AGY_OAUTH_CLIENT_ID / AGY_OAUTH_CLIENT_SECRET > 私有 overlay 钩子 agyOAuthClient
// （{ clientId, clientSecret }，见 src/runtime/overlay-hooks.mjs）。都没配时，添加 Google 账号自动切换为本机 agy CLI 托管槽位模式（slots.mjs），
// 仅直接换取裸 Refresh Token 仍需配置上述客户端。
export const OAUTH_NOT_CONFIGURED = '没有配置 Antigravity 号池用的 Google OAuth 客户端：手动填写 Refresh Token 需要设置环境变量 AGY_OAUTH_CLIENT_ID 与 AGY_OAUTH_CLIENT_SECRET 后重启 bridge；普通添加多号可直接点击「使用 Google 账号授权登录」。';
function oauthClient() {
  const env = { clientId: String(process.env.AGY_OAUTH_CLIENT_ID || '').trim(), clientSecret: String(process.env.AGY_OAUTH_CLIENT_SECRET || '').trim() };
  if (env.clientId && env.clientSecret) return env;
  const hook = overlayHook('agyOAuthClient');
  const v = typeof hook === 'function' ? hook() : hook;
  const fromHook = { clientId: String(v?.clientId || '').trim(), clientSecret: String(v?.clientSecret || '').trim() };
  return fromHook.clientId && fromHook.clientSecret ? fromHook : null;
}
export const oauthClientConfigured = () => !!oauthClient();
export const poolAuthMode = () => (oauthClientConfigured() ? 'oauth' : 'cli');
function requireOAuthClient() {
  const c = oauthClient();
  if (!c) throw new Error(OAUTH_NOT_CONFIGURED);
  return c;
}
const OAUTH_CLIENT_ID = () => requireOAuthClient().clientId;
const OAUTH_CLIENT_SECRET = () => requireOAuthClient().clientSecret;
export const CCPA_UPSTREAM = () => String(process.env.BRIDGE_AGY_UPSTREAM || 'https://daily-cloudcode-pa.googleapis.com').replace(/\/+$/, '');
export const DEFAULT_AGY_UA = 'antigravity/cli/1.5.13 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)';

const FLOW_TTL_MS = 5 * 60_000;
const TOKEN_REFRESH_LEAD_MS = 120_000;

let fetchOverride = null;
function doFetch(url, init = {}) {
  if (fetchOverride) return fetchOverride(url, init);
  const plain = plainDispatcher();
  return fetch(url, { ...init, ...(plain ? { dispatcher: plain } : {}) });
}

// 本机宿主 agy acp 经代理发出的实时认证上下文（仅驻留内存、绝不落盘），用于默认账号直查额度与复用官方 UA。
const hostAuth = {
  accessToken: '',
  userAgent: '',
  project: '',
  at: 0,
};

export function noteHostAuth({ authHeader = '', userAgent = '', project = '', email = '', tierId = '', tierName = '' } = {}) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim());
  if (m && m[1]) {
    hostAuth.accessToken = m[1].trim();
    hostAuth.at = Date.now();
  }
  if (userAgent && /antigravity/i.test(String(userAgent))) {
    hostAuth.userAgent = String(userAgent).trim();
  }
  if (project && String(project).trim()) {
    hostAuth.project = String(project).trim();
  }
  const lid = localAccountId();
  if (lid && (project || email || tierId || tierName)) {
    noteAccountMeta(lid, { email, project, tierId, tierName });
  }
}

export function getHostAuth() {
  return { ...hostAuth };
}

export function effectiveAgyUserAgent() {
  return hostAuth.userAgent || DEFAULT_AGY_UA;
}

// ── Access Token 内存缓存与单飞续期 ────────────────────────────────────────────
const tokenCache = new Map();     // accountId -> { accessToken, expiresAt }
const refreshInflight = new Map(); // accountId -> Promise

export function invalidateAccessToken(accountId) {
  if (!accountId) return;
  tokenCache.delete(String(accountId));
}

export async function exchangeRefreshToken(refreshToken) {
  const rt = String(refreshToken || '').trim();
  if (!rt) throw new Error('缺少 Refresh Token');
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID(),
    client_secret: OAUTH_CLIENT_SECRET(),
    refresh_token: rt,
    grant_type: 'refresh_token',
  });
  const res = await doFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data?.access_token) {
    const code = data?.error || `HTTP ${res.status}`;
    const desc = data?.error_description || text.slice(0, 180);
    const err = new Error(code === 'invalid_grant' ? '授权已失效或被撤销，请重新登录该账号' : `刷新令牌失败（${code}）：${desc}`);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return {
    accessToken: String(data.access_token),
    expiresIn: Number(data.expires_in) || 3500,
    scope: String(data.scope || ''),
  };
}

export async function getAccessToken(accountId, { forceRefresh = false } = {}) {
  const acct = getAccountInternal(accountId);
  if (!acct) return { token: '', source: 'none', error: '账号不存在' };
  if (acct.source === 'slot') {
    const now = Date.now();
    const cached = tokenCache.get(acct.id);
    const leadMs = cached?.exactExpiry ? 15_000 : TOKEN_REFRESH_LEAD_MS;
    if (!forceRefresh && cached && cached.accessToken && cached.expiresAt - now > leadMs) {
      return { token: cached.accessToken, source: 'slot', error: null };
    }

    let p = refreshInflight.get(acct.id);
    if (!p) {
      p = captureSlotAccessToken(slotDirFor(acct.id), { retryOnNearExpiry: true }).then((r) => {
        if (r.userAgent && /antigravity/i.test(r.userAgent)) {
          noteHostAuth({ userAgent: r.userAgent });
        }
        tokenCache.set(acct.id, {
          accessToken: r.accessToken,
          expiresAt: Date.now() + Math.max(30, r.expiresIn) * 1000,
          exactExpiry: !!r.exactExpiry,
        });
        return { token: r.accessToken, source: 'slot', error: null };
      }).catch((err) => {
        if (err?.code === 'invalid_grant') tokenCache.delete(acct.id);
        return { token: '', source: 'slot', error: err?.message || String(err), code: err?.code || '' };
      }).finally(() => {
        if (refreshInflight.get(acct.id) === p) refreshInflight.delete(acct.id);
      });
      refreshInflight.set(acct.id, p);
    }
    return p;
  }

  if (!acct.refreshToken) {
    if (hostAuth.accessToken) return { token: hostAuth.accessToken, source: 'local', error: null };
    return { token: '', source: 'local', error: '' };
  }

  const now = Date.now();
  const cached = tokenCache.get(acct.id);
  if (!forceRefresh && cached && cached.accessToken && cached.expiresAt - now > TOKEN_REFRESH_LEAD_MS) {
    return { token: cached.accessToken, source: 'oauth', error: null };
  }

  let p = refreshInflight.get(acct.id);
  if (!p) {
    p = exchangeRefreshToken(acct.refreshToken).then((r) => {
      tokenCache.set(acct.id, {
        accessToken: r.accessToken,
        expiresAt: Date.now() + Math.max(60, r.expiresIn) * 1000,
      });
      return { token: r.accessToken, source: 'oauth', error: null };
    }).catch((err) => {
      if (err?.code === 'invalid_grant') tokenCache.delete(acct.id);
      return { token: '', source: 'oauth', error: err?.message || String(err), code: err?.code || '' };
    }).finally(() => {
      if (refreshInflight.get(acct.id) === p) refreshInflight.delete(acct.id);
    });
    refreshInflight.set(acct.id, p);
  }
  return p;
}

export async function fetchAccountProfile(accessToken, { userAgent } = {}) {
  const tok = String(accessToken || '').trim();
  if (!tok) return { email: '', project: '', tierId: '', tierName: '' };
  const ua = userAgent || effectiveAgyUserAgent();

  const [infoRes, lcaRes] = await Promise.all([
    doFetch(USERINFO_URL, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + tok },
      signal: AbortSignal.timeout(10_000),
    }).then(async (r) => (r.ok ? r.json().catch(() => null) : null)).catch(() => null),
    doFetch(`${CCPA_UPSTREAM()}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + tok,
        'content-type': 'application/json',
        'user-agent': ua,
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      signal: AbortSignal.timeout(12_000),
    }).then(async (r) => (r.ok ? r.json().catch(() => null) : null)).catch(() => null),
  ]);

  const email = String(infoRes?.email || '').trim();
  const project = String(lcaRes?.cloudaicompanionProject || '').trim();
  const tier = lcaRes?.paidTier || lcaRes?.currentTier || null;
  const tierId = String(tier?.id || '').trim();
  const tierName = String(tier?.name || '').trim();
  return { email, project, tierId, tierName };
}

export async function verifyAndPrepareRefreshToken(refreshToken) {
  const exchanged = await exchangeRefreshToken(refreshToken);
  const profile = await fetchAccountProfile(exchanged.accessToken);
  return { ...exchanged, ...profile };
}

// ── 交互式 Google OAuth 登录流（自动回环 + 手动粘贴兜底）───────────────────────
const flows = new Map(); // flowId -> flow

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function closeFlowServer(flow) {
  if (!flow) return;
  clearTimeout(flow.timer);
  flow.timer = null;
  if (flow.server) {
    try { flow.server.closeAllConnections?.(); } catch {}
    try { flow.server.close(); } catch {}
    flow.server = null;
  }
}

export function parseAuthCodeInput(rawInput = '') {
  const s = String(rawInput || '').trim();
  if (!s) return { code: '', state: '', error: '请粘贴回调链接或授权码' };
  if (/^https?:\/\//i.test(s) || s.includes('code=')) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `http://localhost/cb?${s.replace(/^\?/, '')}`);
      const err = url.searchParams.get('error');
      if (err) return { code: '', state: '', error: `Google 拒绝了授权：${err}` };
      const code = (url.searchParams.get('code') || '').trim();
      const state = (url.searchParams.get('state') || '').trim();
      if (!code) return { code: '', state: '', error: '链接里没有找到 code 参数，请复制完整的跳转后地址' };
      return { code, state, error: '' };
    } catch {
      return { code: '', state: '', error: '无法解析粘贴的链接，请重新复制地址栏完整链接' };
    }
  }
  // 允许用户直接粘贴裸授权码，或 code#state 形态
  const hashIdx = s.indexOf('#');
  const code = (hashIdx >= 0 ? s.slice(0, hashIdx) : s).replace(/\s+/g, '');
  const state = hashIdx >= 0 ? s.slice(hashIdx + 1).trim() : '';
  if (code.length < 8) return { code: '', state: '', error: '授权码格式不正确' };
  return { code, state, error: '' };
}

async function exchangeAuthCode({ code, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID(),
    client_secret: OAUTH_CLIENT_SECRET(),
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await doFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok || !data?.access_token) {
    const errCode = data?.error || `HTTP ${res.status}`;
    const desc = data?.error_description || text.slice(0, 180);
    throw new Error(`换取 Google 令牌失败（${errCode}）：${desc}`);
  }
  if (!data.refresh_token) {
    throw new Error('Google 未返回 Refresh Token，请重试并在授权页确认授权');
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token),
    expiresIn: Number(data.expires_in) || 3500,
  };
}

async function completeFlow(flow, code, state, overrides = {}, { deferClose = false } = {}) {
  if (flow.status === 'done') return { ok: true, account: flow.account };
  if (flow.completing) return flow.completing;
  if (state && state !== flow.state) {
    return { error: '授权状态不匹配（state 校验失败），请重新发起登录' };
  }

  flow.completing = (async () => {
    try {
      const tokens = await exchangeAuthCode({
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
      const profile = await fetchAccountProfile(tokens.accessToken);
      const label = String(overrides.label ?? flow.label ?? '').trim();
      const plan = typeof overrides.plan === 'string' ? overrides.plan : (flow.plan || '');

      let res;
      if (flow.accountId) {
        res = updateAccount(flow.accountId, {
          ...(label ? { label } : {}),
          ...(plan ? { plan } : {}),
          refreshToken: tokens.refreshToken,
          email: profile.email,
          project: profile.project,
          tierId: profile.tierId,
          tierName: profile.tierName,
        });
      } else {
        res = addAccount({
          label,
          plan,
          refreshToken: tokens.refreshToken,
          email: profile.email,
          project: profile.project,
          tierId: profile.tierId,
          tierName: profile.tierName,
          autoActivateIfOnlyEmptyLocal: !hostAuth.accessToken,
        });
      }
      if (res?.error) throw new Error(res.error);
      const targetId = res.id || flow.accountId;
      if (targetId) {
        tokenCache.set(targetId, {
          accessToken: tokens.accessToken,
          expiresAt: Date.now() + Math.max(60, tokens.expiresIn) * 1000,
        });
      }
      flow.status = 'done';
      flow.account = res.account || null;
      flow.error = '';
      if (!deferClose) closeFlowServer(flow);
      return { ok: true, id: targetId, account: flow.account };
    } catch (err) {
      flow.status = 'error';
      flow.error = err?.message || String(err);
      if (!deferClose) closeFlowServer(flow);
      return { error: flow.error };
    } finally {
      flow.completing = null;
    }
  })();

  return flow.completing;
}

function callbackHtml(ok, detail = '') {
  const title = ok ? 'Antigravity 账号已连接' : '授权未完成';
  const msg = ok ? '已成功添加到 Bridge 号池，你可以关闭此标签页并返回 Bridge。' : detail;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#131313;color:#f1ece2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}.card{max-width:420px;padding:28px 24px;border-radius:16px;background:#1e1d1b;border:1px solid rgba(241,236,226,.12);text-align:center}h1{font-size:18px;margin:0 0 10px;font-weight:600}p{font-size:14px;line-height:1.6;color:rgba(241,236,226,.72);margin:0}</style><div class="card"><h1>${title}</h1><p>${String(msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p></div></html>`;
}

export async function startOAuthLogin({ label = '', accountId = '', plan = '' } = {}) {
  // 未配置直连 OAuth 客户端时自动切到本机 agy CLI 托管槽位登录（公开版免密钥开箱即用）。
  if (!oauthClientConfigured()) {
    return startSlotLoginFlow({ label, accountId, plan });
  }
  // 控制并发挂起流数量，防止重复点按泄露监听端口
  for (const [fid, f] of flows.entries()) {
    if (f.status !== 'pending' || Date.now() > f.expiresAt) {
      closeFlowServer(f);
      flows.delete(fid);
    }
  }
  while (flows.size >= 4) {
    const oldest = flows.keys().next().value;
    closeFlowServer(flows.get(oldest));
    flows.delete(oldest);
  }

  const flowId = 'ao-' + randomBytes(6).toString('hex');
  const state = base64Url(randomBytes(16));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());

  const flow = {
    flowId,
    state,
    codeVerifier,
    redirectUri: '',
    label: String(label || '').trim(),
    accountId: String(accountId || '').trim(),
    plan: String(plan || '').trim(),
    status: 'pending',
    account: null,
    error: '',
    expiresAt: Date.now() + FLOW_TTL_MS,
    server: null,
    timer: null,
    completing: null,
  };

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://localhost');
    if (u.pathname !== '/oauth-callback') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const errParam = u.searchParams.get('error');
    if (errParam) {
      flow.status = 'error';
      flow.error = `Google 拒绝了授权：${errParam}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(callbackHtml(false, flow.error), () => closeFlowServer(flow));
      return;
    }
    const code = (u.searchParams.get('code') || '').trim();
    const st = (u.searchParams.get('state') || '').trim();
    const r = await completeFlow(flow, code, st, {}, { deferClose: true });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
    res.end(callbackHtml(!!r?.ok, r?.error || '授权失败'), () => closeFlowServer(flow));
  });

  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  srv.unref?.();

  const port = srv.address().port;
  flow.server = srv;
  flow.redirectUri = `http://localhost:${port}/oauth-callback`;
  flow.timer = setTimeout(() => {
    if (flow.status === 'pending') {
      flow.status = 'expired';
      flow.error = '授权已超时，请重新开始';
    }
    closeFlowServer(flow);
  }, FLOW_TTL_MS);
  flow.timer.unref?.();
  flows.set(flowId, flow);

  const authParams = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID(),
    redirect_uri: flow.redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'select_account consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    ok: true,
    flowId,
    mode: 'oauth',
    url: `${OAUTH_AUTH_URL}?${authParams.toString()}`,
    redirectUri: flow.redirectUri,
    expiresAt: flow.expiresAt,
  };
}

export function getOAuthStatus(flowId) {
  const id = String(flowId || '');
  if (id.startsWith('as-')) return getSlotLoginStatus(id);
  const flow = flows.get(id);
  if (!flow) return { ok: false, status: 'expired', error: '授权会话不存在或已过期' };
  if (flow.status === 'pending' && Date.now() > flow.expiresAt) {
    flow.status = 'expired';
    flow.error = '授权已超时，请重新开始';
    closeFlowServer(flow);
  }
  return {
    ok: flow.status === 'done',
    mode: 'oauth',
    status: flow.status,
    ...(flow.account ? { account: flow.account } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  };
}

async function finishSlotLoginFlow(flowId, rawInput, overrides = {}) {
  const sub = await submitSlotLoginCode(flowId, rawInput);
  if (sub.error) return { error: sub.error };
  if (sub.alreadyDone) return { ok: true, account: sub.account };
  const flow = sub.flow;
  if (flow.completing) return flow.completing;

  flow.completing = (async () => {
    try {
      const cap = await captureSlotAccessToken(flow.tmpDir, { retryOnNearExpiry: true });
      if (cap.userAgent && /antigravity/i.test(cap.userAgent)) {
        noteHostAuth({ userAgent: cap.userAgent });
      }
      const profile = await fetchAccountProfile(cap.accessToken, { userAgent: cap.userAgent || undefined });
      const label = String(overrides.label ?? flow.label ?? '').trim();
      const plan = typeof overrides.plan === 'string' ? overrides.plan : (flow.plan || '');

      let res;
      if (flow.accountId) {
        res = updateAccount(flow.accountId, {
          ...(label ? { label } : {}),
          ...(plan ? { plan } : {}),
          source: 'slot',
          email: profile.email,
          project: profile.project,
          tierId: profile.tierId,
          tierName: profile.tierName,
        });
      } else {
        res = addAccount({
          label,
          plan,
          source: 'slot',
          email: profile.email,
          project: profile.project,
          tierId: profile.tierId,
          tierName: profile.tierName,
          autoActivateIfOnlyEmptyLocal: !hostAuth.accessToken,
        });
      }
      if (res?.error) throw new Error(res.error);
      const targetId = res.id || flow.accountId;
      if (!targetId) throw new Error('未能分配账号 ID');
      promoteSlotDir(flow.tmpDir, targetId);
      tokenCache.set(targetId, {
        accessToken: cap.accessToken,
        expiresAt: Date.now() + Math.max(30, cap.expiresIn) * 1000,
        exactExpiry: !!cap.exactExpiry,
      });
      markSlotFlowResult(flowId, { ok: true, account: res.account || null, keepTmpDir: true });
      return { ok: true, id: targetId, account: res.account || null };
    } catch (err) {
      const msg = err?.message || String(err);
      markSlotFlowResult(flowId, { ok: false, error: msg });
      return { error: msg };
    } finally {
      flow.completing = null;
    }
  })();

  return flow.completing;
}

export async function finishOAuthLogin(flowId, rawInput, overrides = {}) {
  const id = String(flowId || '');
  if (id.startsWith('as-')) return finishSlotLoginFlow(id, rawInput, overrides);
  const flow = flows.get(id);
  if (!flow) return { error: '授权会话不存在或已过期，请重新生成授权链接' };
  if (flow.status === 'done') return { ok: true, account: flow.account };
  if (Date.now() > flow.expiresAt) {
    flow.status = 'expired';
    closeFlowServer(flow);
    return { error: '授权链接已过期，请重新开始' };
  }
  const parsed = parseAuthCodeInput(rawInput);
  if (parsed.error) return { error: parsed.error };
  return completeFlow(flow, parsed.code, parsed.state, overrides);
}

export function cancelOAuthLogin(flowId) {
  const id = String(flowId || '');
  if (id.startsWith('as-')) return cancelSlotLoginFlow(id);
  const flow = flows.get(id);
  if (!flow) return { ok: true };
  closeFlowServer(flow);
  flows.delete(id);
  return { ok: true };
}

export function shutdownOAuthFlows() {
  for (const flow of flows.values()) closeFlowServer(flow);
  flows.clear();
  shutdownSlotFlows();
}

export function _setOAuthFetchForTest(fn) {
  fetchOverride = fn || null;
}

export function _resetOAuthForTest() {
  shutdownOAuthFlows();
  _resetSlotsForTest();
  tokenCache.clear();
  refreshInflight.clear();
  hostAuth.accessToken = '';
  hostAuth.userAgent = '';
  hostAuth.project = '';
  hostAuth.at = 0;
  fetchOverride = null;
}

process.once('exit', () => {
  try { shutdownOAuthFlows(); } catch {}
});
