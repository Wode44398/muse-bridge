// 本机账号保险箱：这台设备上登录过、还没退出的账号各留一张会话令牌，切换账号 = 换一张令牌重载，不用重新输密码。
// 只管存取（不碰网络），lib/account.js 管登录 / 切换流程，lib/cache.js 拿 bootCacheTag() 给聊天缓存分库。
//
// 令牌和当前令牌（bridge-token）放在同一个存放处（离线壳是原生 SharedPreferences），没有降低保护；
// 离线壳的多服务器档案（serverProfiles.js）把这把键一起收进档案，所以每台服务器各有自己的一份。
// 服务端认人时显式 Bearer 先于残留 cookie（src/auth.mjs），换令牌即换人；网页同源时切换后再调 /api/auth/adopt 把 cookie 也对齐。
import { storeGet, storeSet } from './store.js';

export const VAULT_KEY = 'bridge-accounts';
const MAX = 8;

/** 账号的稳定键：管理员只有一个；普通账号用账号 id（/api/auth 的 uid，不随改名变），旧后端 / 旧快照没有就用登录名 */
export function accountKey(me) {
  if (!me || !me.kind) return '';
  if (me.kind === 'admin') return 'admin';
  if (me.kind === 'user' && (me.uid || me.user)) return 'u:' + (me.uid || me.user);
  return '';
}

export function loadVault() {
  try {
    const v = JSON.parse(storeGet(VAULT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((a) => a && a.key && a.token) : [];
  } catch { return []; }
}
function saveVault(list) { storeSet(VAULT_KEY, list.length ? JSON.stringify(list.slice(0, MAX)) : null); }

// 聊天缓存分库标签：保险箱里第一个账号沿用老库（''），之后加进来的各用自己的标签——切到别的号不会先冒出上一个号的会话列表。
const tagFor = (key) => {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 'a' + h.toString(36);
};

/** 记下（或刷新）一个已登录账号。返回它的条目。 */
export function upsertAccount(me, token) {
  const key = accountKey(me);
  if (!key || !token) return null;
  // 同一个号先按登录名、后按 id 记过两条（旧快照没有 uid）：并成一条
  const same = (a) => a.key === key || (a.kind === 'user' && me.kind === 'user' && a.user && a.user === me.user && (!a.uid || !me.uid));
  const list = loadVault();
  const old = list.find(same);
  const ent = {
    key, kind: me.kind, user: me.user || (me.kind === 'admin' ? 'Admin' : ''), uid: me.uid || null, tier: me.tier || null,
    token, at: Date.now(),
    tag: old ? old.tag : (list.length ? tagFor(key) : ''),
  };
  saveVault([ent, ...list.filter((a) => !same(a))]);
  return ent;
}

export function dropAccount(key) { saveVault(loadVault().filter((a) => a.key !== key)); }

// 页面启动那一刻的账号（bridge-me 快照）对应的缓存标签——模块求值时读一次（切换账号是整页重载，中途不变）。
let bootTag = null;
export function bootCacheTag() {
  if (bootTag != null) return bootTag;
  let me = null;
  try { me = JSON.parse(storeGet('bridge-me') || 'null'); } catch {}
  const key = accountKey(me);
  bootTag = (key && loadVault().find((a) => a.key === key)?.tag) || '';
  return bootTag;
}
