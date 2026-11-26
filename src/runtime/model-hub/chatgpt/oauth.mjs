// Sign in with ChatGPT（开源 / 自托管应用的动态注册通道）：登录、换令牌、刷新、吊销。
//
// 登录：每次一个 attempt（state、nonce、PKCE、回调地址都是这一次的）。回调只认 http://127.0.0.1:<端口>/auth/callback，
// 所以在 bridge 服务器本机上开登录页时浏览器会直接跳回这里的监听；从手机 / 别的电脑登录时浏览器跳到它自己的 127.0.0.1、打不开，
// 用户把地址栏整段粘回来（finishLogin）——PKCE 校验码只在服务器上，粘回来的这一段单独拿去换不出令牌。
// 每个 attempt 自带一个只听 127.0.0.1 的监听，结束（成功 / 失败 / 取消 / 过期）就关，进程退出也不留。
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {
  EP, RESOURCE, DYNAMIC_CLIENT, AGENT_NAME, PLAN_SCOPE, SCOPES, CALLBACK_PATH, LOGIN_TTL_MS, DEAD_REFRESH,
} from './const.mjs';
import { verifyIdToken, oidcConfig, decodeJwt } from './jwt.mjs';

const MAX_ATTEMPTS = 6;
const attempts = new Map();   // loginId → attempt
const rnd = (n = 32) => randomBytes(n).toString('base64url');

const err = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function scopesOf(s) { return String(s || '').split(/\s+/).filter(Boolean).sort(); }

/** 换令牌 / 刷新：表单 POST 到令牌端点。返回 { ok, status, json }（网络错误抛）。 */
async function tokenPost(form) {
  const r = await fetch(EP.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  return { ok: r.ok, status: r.status, json: json && typeof json === 'object' ? json : {} };
}
const oauthCode = (j) => String(j?.error?.code || j?.error || j?.code || '');
const oauthText = (j, status) => String(j?.error_description || j?.error?.message || j?.message || j?.detail || oauthCode(j) || `HTTP ${status}`).slice(0, 300);

/** 令牌端点的应答 → 凭据里的令牌部分。 */
function tokenFields(j, now = Date.now()) {
  const expiresIn = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
  const earliest = Number(j.earliest_refresh_at);
  return {
    accessToken: String(j.access_token || ''),
    ...(j.refresh_token ? { refreshToken: String(j.refresh_token) } : {}),
    ...(j.id_token ? { idToken: String(j.id_token) } : {}),
    ...(j.scope ? { scopes: scopesOf(j.scope) } : {}),
    expiresAt: now + expiresIn * 1000,
    // earliest_refresh_at：没写单位，按 Unix 秒读（毫秒级的值也认）
    earliestRefreshAt: Number.isFinite(earliest) && earliest > 0 ? (earliest < 1e12 ? earliest * 1000 : earliest) : 0,
  };
}

// —— 登录 ——————————————————————————————————————————————

/**
 * 开始一次登录 → attempt。
 * opts：{ mode: 'new' | 'add' | 'relogin', serviceId?, lineId?, hostId, saved?（重新登录时这个账号原来的凭据）, onDone?(attempt) }
 * onDone 在令牌换好、校验通过后调（add / relogin 由它把凭据挂到服务上；new 留在 attempt.cred 里等建服务）。
 */
export async function startLogin(opts) {
  const { mode = 'new', serviceId = '', lineId = '', hostId, saved = null, onDone = null, afterExchange = null } = opts || {};
  if (!hostId) throw err('没有主机标识', 'internal', 500);
  prune();
  const id = 'cl-' + randomBytes(6).toString('hex');
  const verifier = rnd(48);
  const a = {
    id, mode, serviceId, lineId, hostId, saved,
    state: rnd(24), nonce: rnd(24), verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    clientId: mode === 'relogin' && saved?.clientId ? saved.clientId : DYNAMIC_CLIENT,
    createdAt: Date.now(), expiresAt: Date.now() + LOGIN_TTL_MS,
    status: 'pending', error: '', errorCode: '',
    server: null, redirectUri: '', authUrl: '',
    cred: null, account: null, models: null, service: null,
    onDone, afterExchange, running: null, timer: null,
  };
  const srv = http.createServer((req, res) => onCallback(a, req, res));
  srv.on('error', () => {});
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  srv.unref();
  a.server = srv;
  a.redirectUri = `http://127.0.0.1:${srv.address().port}${CALLBACK_PATH}`;
  a.authUrl = authorizeUrl(a);
  a.timer = setTimeout(() => expire(a), LOGIN_TTL_MS);
  a.timer.unref?.();
  attempts.set(id, a);
  return a;
}

function authorizeUrl(a) {
  const q = new URLSearchParams({
    client_id: a.clientId,
    response_type: 'code',
    redirect_uri: a.redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state: a.state,
    nonce: a.nonce,
    code_challenge_method: 'S256',
    code_challenge: a.challenge,
    ext_agent_host_id: a.hostId,
  });
  // 名字只在第一次注册时带；重新登录带原来的 ID 令牌与邮箱，跳过选账号那一步
  if (a.clientId === DYNAMIC_CLIENT) q.set('agent_name_hint', AGENT_NAME);
  if (a.mode === 'relogin' && a.saved?.idToken) q.set('id_token_hint', a.saved.idToken);
  if (a.mode === 'relogin' && a.saved?.email) q.set('login_hint', a.saved.email);
  return `${EP.authorize}?${q.toString()}`;
}

// 回调请求自己还在等应答时不能掐它的连接：只停止接新连接、关掉空闲的，正在写的那条写完自己断
function closeServer(a) {
  clearTimeout(a.timer);
  if (a.server) { const s = a.server; a.server = null; try { s.close(); s.closeIdleConnections?.(); } catch {} }
}
function finish(a, status, error = '', errorCode = '') {
  a.status = status; a.error = error; a.errorCode = errorCode; a.doneAt = Date.now();
  closeServer(a);
}
function expire(a) {
  if (a.status === 'pending') finish(a, 'error', '登录已过期，请重新开始', 'expired');
}
// 结束了的 attempt 留一会儿给界面轮询拿结果，再多就删最老的；凭据（new 模式的）跟着删。
// 登录成功、还在等用户勾模型建服务的留一小时（勾模型可能慢慢挑）
const KEEP_DONE_MS = 60 * 60_000;
function prune() {
  const now = Date.now();
  for (const [id, a] of attempts) {
    if (a.status === 'pending' || a.status === 'exchanging') continue;
    const keep = a.status === 'done' && a.cred ? KEEP_DONE_MS : LOGIN_TTL_MS;
    if (now - (a.doneAt || a.createdAt) > keep) { closeServer(a); attempts.delete(id); }
  }
  while (attempts.size >= MAX_ATTEMPTS) {
    const [id, a] = attempts.entries().next().value;
    if (a.status === 'pending') finish(a, 'error', '同时进行的登录太多，这次被取消了', 'expired');
    closeServer(a); attempts.delete(id);
  }
}

const PAGE = (ok, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bridge</title>
<body style="font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f7f7f5;color:#1f1f1d">
<div style="max-width:420px;padding:24px;text-align:center"><div style="font-size:20px;font-weight:600;margin-bottom:8px">${ok ? '已连接 ChatGPT' : '没有连上 ChatGPT'}</div>
<div style="color:#5f5e5a">${text}</div></div></body>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function onCallback(a, req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
  // state 对不上的不是这一次登录的回调：不动 attempt
  if (u.searchParams.get('state') !== a.state) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(false, '这个回调不属于当前的登录，请回到 bridge 重新开始。')); return; }
  try { await complete(a, u.searchParams); } catch {}
  const ok = a.status === 'done';
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE(ok, ok ? '可以关掉这个页面，回到 bridge 继续。' : esc(a.error || '登录失败')));
}

/** 用户把浏览器停住的那段地址粘回来（整段 URL 或只是 ?code=… 那一截）。 */
export async function finishLogin(loginId, pasted) {
  const a = attempts.get(loginId);
  if (!a) throw err('没有这次登录（可能已过期），请重新开始', 'expired', 404);
  const raw = String(pasted || '').trim();
  let params;
  try {
    const i = raw.indexOf('?');
    params = new URLSearchParams(i >= 0 ? raw.slice(i + 1).split('#')[0] : raw.replace(/^#/, ''));
  } catch { params = new URLSearchParams(); }
  if (!params.get('code') && !params.get('error')) throw err('这段地址里没有登录结果：要复制登录完成后浏览器地址栏里的整段地址（http://127.0.0.1:…/auth/callback?code=…）', 'paste');
  if (params.get('state') !== a.state) throw err('这段地址不是这一次登录的（可能是上一次的），请复制最新一次登录后的地址', 'state');
  await complete(a, params);
  return a;
}

export function getLogin(loginId) { prune(); return attempts.get(loginId) || null; }
export function cancelLogin(loginId) {
  const a = attempts.get(loginId);
  if (!a) return;
  if (a.status === 'pending') finish(a, 'error', '已取消', 'cancelled');
  else closeServer(a);
  attempts.delete(loginId);
}
/** 建好服务后把 new 模式的 attempt 收掉（凭据已经挂到服务上，别留在内存里）。 */
export function consumeLogin(loginId) { const a = attempts.get(loginId); if (a) { closeServer(a); a.cred = null; attempts.delete(loginId); } }

/** 回调到了（自动或粘贴）：校验、换令牌、验 ID 令牌、查授权范围，再交给 onDone。同一次登录并发到达只跑一遍。 */
function complete(a, params) {
  if (a.running) return a.running;
  if (a.status !== 'pending') return Promise.resolve(a);
  a.running = (async () => {
    try { await completeInner(a, params); }
    catch (e) { finish(a, 'error', String(e?.message || e).slice(0, 300), e?.code && /^[a-z_]+$/.test(e.code) ? e.code : 'exchange'); }
    finally { a.running = null; }
    return a;
  })();
  return a.running;
}

async function completeInner(a, params) {
  const oerr = params.get('error');
  if (oerr) {
    if (oerr === 'access_denied') throw err('你在登录页上拒绝了授权', 'denied');
    throw err(`登录没有完成：${String(params.get('error_description') || oerr).slice(0, 200)}`, 'exchange');
  }
  const code = params.get('code');
  if (!code) throw err('回调里没有授权码', 'exchange');
  // 新注册：回调带签发的 client_id（oaiapp_…），以后都用它；重新登录：可能不带，带了就必须和原来的一样
  const cbClient = params.get('client_id') || '';
  let clientId = a.clientId;
  if (a.clientId === DYNAMIC_CLIENT) {
    if (!cbClient || cbClient === DYNAMIC_CLIENT) throw err('注册没有完成（回调里没有签发的 client_id），请重新登录', 'exchange');
    clientId = cbClient;
  } else if (cbClient && cbClient !== a.clientId) throw err('登录回来的应用标识和原来的不一致，没有替换这个账号的凭据', 'mismatch');
  a.status = 'exchanging';
  let r;
  try {
    r = await tokenPost({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: a.verifier, redirect_uri: a.redirectUri, resource: RESOURCE });
  } catch (e) { throw err(`连不上 OpenAI 的登录服务：${String(e?.cause?.code || e?.message || e).slice(0, 120)}（检查出站代理）`, 'network'); }
  if (!r.ok) {
    const c = oauthCode(r.json);
    throw err(c === 'invalid_grant' ? '授权码已失效，请重新登录' : `换令牌失败：${oauthText(r.json, r.status)}`, 'exchange');
  }
  const t = tokenFields(r.json);
  if (!t.accessToken || !t.refreshToken || !t.idToken) throw err('登录服务返回的令牌不完整，请重新登录', 'exchange');
  let claims;
  try { claims = await verifyIdToken(t.idToken, { clientId, nonce: a.nonce }); }
  catch (e) { throw err(`ID 令牌校验没过：${e?.message || e}`, 'exchange'); }
  if (a.mode === 'relogin' && a.saved?.subject && claims.sub !== a.saved.subject) {
    throw err(`登录的不是原来那个账号${a.saved.email ? `（原来是 ${a.saved.email}）` : ''}，没有替换它的凭据`, 'mismatch');
  }
  const scopes = t.scopes || scopesOf(params.get('scope'));
  const now = Date.now();
  a.cred = {
    email: String(claims.email || a.saved?.email || ''), subject: String(claims.sub), clientId,
    idToken: t.idToken, accessToken: t.accessToken, refreshToken: t.refreshToken, scopes, planOk: scopes.includes(PLAN_SCOPE),
    expiresAt: t.expiresAt, earliestRefreshAt: t.earliestRefreshAt, savedAt: now, refreshedAt: now,
  };
  a.account = { email: a.cred.email, planOk: a.cred.planOk };
  if (!a.cred.planOk) throw err('这次登录没有授权使用 ChatGPT 套餐额度（同意页上没有勾选或账号不支持），请重新登录并同意', 'no_plan');
  if (a.afterExchange) await a.afterExchange(a);   // new 模式：拉这个账号能用的模型
  if (a.onDone) await a.onDone(a);                  // add / relogin：挂到服务上
  finish(a, 'done');
}

// —— 刷新与吊销 ——————————————————————————————————————————————

/**
 * 用刷新令牌换新的一组令牌 → 要合并进凭据的字段。
 * 刷新令牌已经不能用了：抛 { dead: true }（调用方清令牌、标「要重新登录」）；网络 / 5xx：抛 { transient: true }（凭据原样留着）。
 */
export async function refreshCred(cred) {
  if (!cred?.refreshToken || !cred?.clientId) throw Object.assign(new Error('没有刷新令牌，请重新登录'), { dead: true });
  let r;
  try { r = await tokenPost({ grant_type: 'refresh_token', client_id: cred.clientId, refresh_token: cred.refreshToken, resource: RESOURCE }); }
  catch (e) { throw Object.assign(new Error(`连不上 OpenAI 的登录服务：${String(e?.cause?.code || e?.message || e).slice(0, 120)}`), { transient: true }); }
  if (!r.ok) {
    const c = oauthCode(r.json);
    if (DEAD_REFRESH.has(c)) throw Object.assign(new Error('登录已失效（刷新令牌过期或被吊销），请重新登录'), { dead: true, code: c });
    if (c === 'invalid_client') throw Object.assign(new Error('这个应用注册已失效，请重新登录'), { dead: true, code: c });
    if (r.status >= 500 || r.status === 429) throw Object.assign(new Error(`刷新令牌暂时失败：${oauthText(r.json, r.status)}`), { transient: true });
    throw Object.assign(new Error(`刷新令牌失败：${oauthText(r.json, r.status)}`), { dead: r.status === 400 || r.status === 401, code: c });
  }
  const t = tokenFields(r.json);
  if (!t.accessToken) throw Object.assign(new Error('刷新回来的令牌不完整'), { transient: true });
  const scopes = t.scopes || cred.scopes || [];
  return { ...t, scopes, planOk: scopes.includes(PLAN_SCOPE), refreshedAt: Date.now(), needsLogin: false, needsLoginWhy: '' };
}

/** 登出 / 删账号：吊销刷新令牌（尽力而为：失败只记日志，本地照样清）。 */
export async function revokeCred(cred) {
  if (!cred?.refreshToken || !cred?.clientId) return false;
  try {
    const ep = (await oidcConfig()).revocation_endpoint;
    if (!ep) return false;
    const r = await fetch(ep, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: cred.refreshToken, token_type_hint: 'refresh_token', client_id: cred.clientId }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    return r.ok;
  } catch (e) { console.error('[model-hub/chatgpt] 吊销令牌失败：', e?.message || e); return false; }
}

/** 访问令牌里的过期时间（秒）→ 毫秒；读不出回 0。 */
export const accessExp = (t) => { const p = decodeJwt(t); return Number.isFinite(p?.exp) ? p.exp * 1000 : 0; };

export function _resetLoginsForTests() { for (const a of attempts.values()) closeServer(a); attempts.clear(); }
