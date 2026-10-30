// 登录 / 注册 / 令牌登录 / 退出 / 切换账号——各个外壳（手机设置页、桌面壳设置、主页账户卡）共用的那几步。
// 拿到 session token 即存为 Bearer：离线 apk 跨源不带 cookie，user 全靠它鉴权（在线壳仍有 cookie 兜底）；
// 否则紧接着的 /api/auth 会 401、回落 fallback 假登录，之后每个请求都 401。
//
// 快捷切换账号（10-30 起）：这台设备上登录过的账号各留一张会话令牌（lib/accountVault.js），切换 = 换令牌 + 整页重载，
// 不退出、不用重输密码。以前做不到是因为服务端按 cookie 优先认管理员、换成用户的 Bearer 仍是管理员——
// 现在服务端显式 Bearer 先于残留 cookie（src/auth.mjs），网页同源时再调 /api/auth/adopt 把 cookie 也对齐。
// 「添加账号」= 把当前账号收进保险箱、本页回到登录表单（不吊销）；「退出登录」才真正吊销这一张并从保险箱删掉。
// 另记最近登录过的用户名（不含凭据），保险箱里没有的号点一下就填好账号。
import { api, setToken, getToken } from './api.js';
import { apiUrl } from './server.js';
import { applyMe, me } from './state.svelte.js';
import { storeGet, storeSet } from './store.js';
import { accountKey, loadVault, upsertAccount, dropAccount, bootCacheTag } from './accountVault.js';
import { cacheMe } from './cache.js';

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

/** 当前登录的账号收进保险箱（有会话令牌才收；本机无鉴权控制台没有令牌，不收）。启动拿到身份、切换 / 添加前各调一次。 */
export function rememberCurrent() {
  if (me.kind !== 'admin' && me.kind !== 'user') return null;
  return upsertAccount(me, getToken());
}

// 登录成功后：换到的账号和页面启动时不是同一个缓存库 → 整页重载，别让上一个号的聊天缓存 / 内存状态混进来
function reloadIfOtherAccount() {
  const ent = rememberCurrent();
  if (ent && (ent.tag || '') !== bootCacheTag()) { setTimeout(() => location.reload(), 0); return true; }
  return false;
}

async function settle(r, fallback) {
  if (r?.token) setToken(r.token);
  try { applyMe(await api.auth()); }
  catch { applyMe(fallback); }
  afterSignIn();
  reloadIfOtherAccount();
}

/** 账号密码登录；失败抛错（e.body.error 是给人看的原因）。 */
export async function signIn(username, password) {
  const r = await api.login({ username, password });
  if (r.kind === 'user') remember(r.user || username);
  await settle(r, { kind: r.kind, user: r.user || username });
  return r;
}

/** 邀请码注册，注册即登录。 */
export async function signUp({ username, password, password2, invite }) {
  const r = await api.register({ username, password, password2, invite });
  remember(r.user || username);
  await settle(r, { kind: r.kind, user: r.user || username });
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

/** 退出这台设备（服务端吊销本机这张会话，其它设备不受影响），并从保险箱删掉。 */
export async function signOut() {
  const key = accountKey(me);
  try { await api.logout(); } catch {}
  if (key) dropAccount(key);
  setToken(null);
  applyMe(null);
}

// —— 快捷切换 ——

/** 保险箱里的账号（给界面用，不含令牌）。current = 此刻登录的这个。 */
export function savedAccounts() {
  rememberCurrent();
  const cur = accountKey(me);
  return loadVault().map((a) => ({ key: a.key, kind: a.kind, user: a.user, tier: a.tier, at: a.at, current: a.key === cur }));
}

/**
 * 切到保险箱里的另一个账号：先用它的令牌问一次 /api/auth（只带 Bearer）——失效了就从保险箱删掉并抛 { expired, user }，
 * 界面据此落到登录页、填好账号名；有效就换令牌、对齐 cookie、写好登录态快照，整页重载。
 */
export async function switchTo(key) {
  const ent = loadVault().find((a) => a.key === key);
  if (!ent) throw Object.assign(new Error('gone'), { expired: true, user: '' });
  if (key === accountKey(me)) return false;
  rememberCurrent();
  let res;
  try { res = await fetch(apiUrl('/api/auth'), { headers: { Authorization: 'Bearer ' + ent.token }, credentials: 'omit', cache: 'no-store' }); }
  catch (e) { throw Object.assign(new Error('network'), { network: true }); }
  const fresh = res.ok ? await res.json().catch(() => null) : null;
  if (!fresh || accountKey(fresh) !== key) {
    // 401（过期 / 被吊销 / 账号停用），或令牌认出来的已经不是这个号：作废这一条
    if (res.status === 401 || fresh) dropAccount(key);
    throw Object.assign(new Error('expired'), { expired: res.status === 401 || !!fresh, user: ent.kind === 'user' ? ent.user : '' });
  }
  setToken(ent.token);
  // 网页 / 桌面壳同源：把 cookie 换成这个号的（清掉另一种身份的残留）；离线 apk 跨源不带 cookie，失败也无妨
  try { await api.post('/api/auth/adopt', {}); } catch {}
  applyMe(fresh);
  try { cacheMe(fresh); } catch {}
  upsertAccount(fresh, ent.token);
  afterSignIn();
  setTimeout(() => location.reload(), 0);
  return true;
}

/**
 * 添加账号：当前账号留在保险箱里（不吊销），本页回到登录表单。服务端 cookie 也先摘掉（不带 Bearer 的 adopt =
 * 清掉两种 cookie），不然登录请求会被残留的管理员 cookie 认成管理员。
 */
export async function parkCurrent() {
  rememberCurrent();
  setToken(null);
  try { await fetch(apiUrl('/api/auth/adopt'), { method: 'POST', credentials: 'same-origin', cache: 'no-store' }); } catch {}
  applyMe(null);
}

/** 从这台设备上移除一个保存的账号：在服务端退出它那张会话（尽力而为），从保险箱删掉。 */
export async function forgetAccount(key) {
  const ent = loadVault().find((a) => a.key === key);
  dropAccount(key);
  if (!ent || key === accountKey(me)) return;
  try {
    await fetch(apiUrl('/api/logout'), { method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ent.token }, body: '{}' });
  } catch {}
}
