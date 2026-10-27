// 登录 / 注册 / 令牌登录 / 退出 / 切换账号——各个外壳（手机设置页、桌面壳设置、主页账户卡）共用的那几步。
// 拿到 session token 即存为 Bearer：离线 apk 跨源不带 cookie，user 全靠它鉴权（在线壳仍有 cookie 兜底）；
// 否则紧接着的 /api/auth 会 401、回落 fallback 假登录，之后每个请求都 401。
//
// 切换账号＝退出这台设备上的当前会话，再用别的账号登录。不在本机囤多张会话令牌：服务端按
// Bearer → cookie 顺序认人、管理员 cookie 优先于用户，囤着的令牌一换就会和残留 cookie 打架（换成用户却仍是管理员）。
// 只记最近登录过的用户名（不含任何凭据），登录页点一下就填好账号。
import { api, setToken } from './api.js';
import { applyMe } from './state.svelte.js';
import { storeGet, storeSet } from './store.js';

const RECENT_KEY = 'bridge-recent-users';
const RECENT_MAX = 5;

export function recentUsers() {
  try { const v = JSON.parse(storeGet(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []; }
  catch { return []; }
}
function remember(name) {
  if (!name) return;
  const key = name.toLowerCase();
  storeSet(RECENT_KEY, JSON.stringify([name, ...recentUsers().filter((n) => n.toLowerCase() !== key)].slice(0, RECENT_MAX)));
}
export function forgetUser(name) {
  storeSet(RECENT_KEY, JSON.stringify(recentUsers().filter((n) => n !== name)));
}

/**
 * 刚刚真登录成功（账号密码 / 注册 / 令牌 / 扫码）之后调：桌面客户端据此解除「设备被吊销后暂停登记」并立刻按新登录重新登记
 * （不调的话最多要等 10 分钟）。只在登录动作之后调，不在每次启动时调——吊销的设备不该自己登记回来。不在桌面壳里是空操作。
 */
export function afterSignIn() {
  try { globalThis.BridgeDesktop?.device?.refresh?.()?.catch?.(() => {}); } catch {}
}

async function settle(r, fallback) {
  if (r?.token) setToken(r.token);
  try { applyMe(await api.auth()); }
  catch { applyMe(fallback); }
  afterSignIn();
}

/** 账号密码登录；失败抛错（e.body.error 是给人看的原因）。 */
export async function signIn(username, password) {
  const r = await api.login({ username, password });
  await settle(r, { kind: r.kind, user: r.user || username });
  if (r.kind === 'user') remember(r.user || username);
  return r;
}

/** 邀请码注册，注册即登录。 */
export async function signUp({ username, password, password2, invite }) {
  const r = await api.register({ username, password, password2, invite });
  await settle(r, { kind: r.kind, user: r.user || username });
  remember(r.user || username);
  return r;
}

/** 管理员访问令牌登录：先当 Bearer 试一次，换回管理员会话令牌存下。 */
export async function signInToken(tok) {
  setToken(String(tok || '').trim());
  try {
    const r = await api.login({});
    await settle(r, { kind: r.kind, user: r.user || null });
    return r;
  } catch (e) { setToken(null); throw e; }
}

/** 退出这台设备（服务端吊销本机这张会话，其它设备不受影响）。 */
export async function signOut() {
  try { await api.logout(); } catch {}
  setToken(null);
  applyMe(null);
}
