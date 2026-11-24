// 发布用的 GitHub 账号。三种来源，按这个顺序取：
//   1. 在这里登录过的（设备码登录 / 粘贴令牌）——加密存在 plugins/.market/publisher/（extension-secrets：Windows 上 DPAPI 包数据密钥）；
//   2. 这台电脑上 gh 已登录的账号（gh auth token 现取，runtime/github.mjs）；
//   都没有就要先登录。令牌只在服务端用，不下发给前端。
import path from 'node:path';
import { readSecrets, writeSecrets } from '../../../extension-secrets.mjs';
import { ghToken } from '../../../runtime/github.mjs';
import { MARKET_DIR, communitySettings } from '../channels.mjs';
import { api, oauthPost, webBase, GithubError } from './github.mjs';
import { PluginError } from '../../discover.mjs';

export const PUBLISHER_DIR = path.join(MARKET_DIR, 'publisher');
const KEY = 'github';

const hooks = { gh: null };
export function _setAccountHooks({ gh = null } = {}) { hooks.gh = gh; }

function stored() {
  try { const r = readSecrets(PUBLISHER_DIR)[KEY]; return r && r.token ? r : null; } catch (e) { console.error('[community-publish] 读不出保存的 GitHub 令牌：' + (e?.message || e)); return null; }
}
function store(rec) {
  let all = {};
  try { all = { ...readSecrets(PUBLISHER_DIR) }; } catch {}
  if (rec) all[KEY] = rec; else delete all[KEY];
  writeSecrets(PUBLISHER_DIR, all);
}

async function ghFallback() {
  try { return await (hooks.gh || ghToken)('github.com'); } catch { return ''; }
}

const loginCache = new Map();   // 令牌尾巴 → { login, at }
async function whoami(token) {
  const k = token.slice(-12);
  const c = loginCache.get(k);
  if (c && Date.now() - c.at < 10 * 60_000) return c.login;
  const u = await api(token, 'GET', '/user');
  const login = String(u?.login || '');
  if (!login) throw new GithubError(401, 'GitHub 没告诉我们这个令牌是谁的');
  loginCache.set(k, { login, at: Date.now() });
  return login;
}

// 拿一个能用的令牌：{ token, login, via }；没有就抛 401
export async function publisherToken() {
  const s = stored();
  if (s) {
    try { return { token: s.token, login: await whoami(s.token), via: s.via || 'token' }; }
    catch (e) { if (e instanceof GithubError && e.status === 401) throw new PluginError(401, '保存的 GitHub 登录已失效，重新登录一下'); throw new PluginError(502, e.message); }
  }
  const t = await ghFallback();
  if (t) {
    try { return { token: t, login: await whoami(t), via: 'gh' }; }
    catch (e) { throw new PluginError(e instanceof GithubError && e.status === 401 ? 401 : 502, e.message); }
  }
  throw new PluginError(401, '还没登录 GitHub：发布到社区要用你自己的 GitHub 账号');
}

// 给界面看：现在用哪个账号、能用哪些登录方式
export async function accountView() {
  const deviceLogin = !!communitySettings().githubClientId;
  try {
    const a = await publisherToken();
    return { ok: true, login: a.login, via: a.via, deviceLogin, canLogout: a.via !== 'gh' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), deviceLogin };
  }
}

// ── 设备码登录 ─────────────────────────────────────────────────────────
let pending = null;   // { deviceCode, interval, expiresAt, clientId }

export async function startDeviceLogin() {
  const clientId = communitySettings().githubClientId;
  if (!clientId) throw new PluginError(400, '这台 bridge 没配 GitHub 登录应用：用这台电脑的 gh 登录，或粘贴一个令牌');
  const r = await oauthPost('/login/device/code', { client_id: clientId, scope: 'public_repo' });
  if (!r.device_code || !r.user_code) throw new PluginError(502, 'GitHub 没给登录码');
  pending = { deviceCode: r.device_code, interval: Math.max(5, Number(r.interval) || 5), expiresAt: Date.now() + (Number(r.expires_in) || 900) * 1000, clientId };
  return { userCode: r.user_code, verificationUri: r.verification_uri || webBase() + '/login/device', expiresIn: Number(r.expires_in) || 900, interval: pending.interval };
}

// 前端按 interval 轮询；GitHub 叫慢一点（slow_down）就把间隔加上去
export async function pollDeviceLogin() {
  if (!pending) return { status: 'none' };
  if (Date.now() > pending.expiresAt) { pending = null; return { status: 'expired' }; }
  const r = await oauthPost('/login/oauth/access_token', { client_id: pending.clientId, device_code: pending.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  if (r.access_token) {
    const login = await whoami(r.access_token);
    store({ token: r.access_token, via: 'device', login, at: Date.now() });
    pending = null;
    return { status: 'ok', login };
  }
  if (r.error === 'authorization_pending') return { status: 'pending', interval: pending.interval };
  if (r.error === 'slow_down') { pending.interval += 5; return { status: 'pending', interval: pending.interval }; }
  pending = null;
  return { status: r.error === 'expired_token' ? 'expired' : r.error === 'access_denied' ? 'denied' : 'error', error: String(r.error_description || r.error || '') };
}

export async function saveToken(token) {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new PluginError(400, '令牌格式不对');
  let login;
  try { login = await whoami(t); } catch (e) { throw new PluginError(e instanceof GithubError && e.status === 401 ? 400 : 502, e instanceof GithubError && e.status === 401 ? 'GitHub 不认这个令牌' : e.message); }
  store({ token: t, via: 'token', login, at: Date.now() });
  return { login };
}

export function logout() { store(null); pending = null; loginCache.clear(); return { ok: true }; }
