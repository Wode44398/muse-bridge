// 访问令牌：一小时过期，快到期就用刷新令牌换新的。同一个账号的刷新排队只跑一次（刷新令牌每次都会换新，
// 两个请求同时拿旧的去刷，后到的那个会被当成重用、整组作废）。
import { getCred, patchCred, allCreds } from './store.mjs';
import { refreshCred } from './oauth.mjs';
import { REFRESH_AHEAD_MS, KEEPALIVE_AFTER_MS } from './const.mjs';

const inflight = new Map();   // 'sid/lid' → Promise<accessToken>

export class AccountError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function doRefresh(sid, lid) {
  const cred = getCred(sid, lid);
  if (!cred) throw new AccountError('这个账号的登录凭据不见了，请重新登录', 'missing');
  try {
    const patch = await refreshCred(cred);
    patchCred(sid, lid, patch);
    return patch.accessToken;
  } catch (e) {
    if (e?.dead) {
      // 刷新令牌已经不能用：清掉令牌、标「要重新登录」（client_id、邮箱、ID 令牌留着，重新登录时用来跳过选账号）
      patchCred(sid, lid, { accessToken: '', refreshToken: '', needsLogin: true, needsLoginWhy: String(e.message || '登录已失效，请重新登录') });
      throw new AccountError(e.message, 'relogin');
    }
    throw new AccountError(String(e?.message || e), 'transient');
  }
}

/**
 * 这个账号现在能用的访问令牌。force = 上游刚回了 401：不管还有多久过期都刷一次。
 * 刷新暂时失败（网络）而旧令牌还没过期：先用旧的。
 */
export async function accessTokenFor(sid, lid, { force = false, now = Date.now() } = {}) {
  const cred = getCred(sid, lid);
  if (!cred) throw new AccountError('这个账号的登录凭据不见了，请重新登录', 'missing');
  if (cred.needsLogin || !cred.refreshToken) throw new AccountError(cred.needsLoginWhy || '登录已失效，请重新登录', 'relogin');
  if (cred.planOk === false) throw new AccountError('这个账号没有授权使用 ChatGPT 套餐额度，请重新登录并同意', 'no_plan');
  const left = (cred.expiresAt || 0) - now;
  // 官方给了「最早什么时候能刷」就别抢在它前面刷（令牌还没过期的话）
  const tooEarly = cred.earliestRefreshAt && now < cred.earliestRefreshAt && left > 0;
  if (cred.accessToken && !force && (left > REFRESH_AHEAD_MS || tooEarly)) return cred.accessToken;
  const key = `${sid}/${lid}`;
  if (!inflight.has(key)) inflight.set(key, doRefresh(sid, lid).finally(() => inflight.delete(key)));
  try { return await inflight.get(key); }
  catch (e) {
    if (e?.code === 'transient' && cred.accessToken && left > 30_000 && !force) return cred.accessToken;
    throw e;
  }
}

/** 长期没用的账号主动刷一次（刷新令牌 30 天过期，每次刷新换新的）。只刷没在要求重新登录的。 */
export async function keepAlive(now = Date.now()) {
  for (const { sid, lid, cred } of allCreds()) {
    if (cred.needsLogin || !cred.refreshToken) continue;
    if (now - (cred.refreshedAt || cred.savedAt || 0) < KEEPALIVE_AFTER_MS) continue;
    try { await accessTokenFor(sid, lid, { force: true, now }); }
    catch (e) { console.error('[model-hub/chatgpt] 保活刷新失败：', e?.message || e); }
  }
}

let keepTimer = null;
export function startKeepAlive() {
  if (keepTimer) return;
  keepTimer = setInterval(() => { keepAlive().catch(() => {}); }, 12 * 3600_000);
  keepTimer.unref?.();
  setTimeout(() => { keepAlive().catch(() => {}); }, 60_000).unref?.();
}
export function _stopKeepAliveForTests() { clearInterval(keepTimer); keepTimer = null; inflight.clear(); }
