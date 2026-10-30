// 多服务器档案：同一个手机 App（离线壳）在几台 bridge 服务器之间一键切换（比如自己电脑上的主机端、Muse 上的 Muse Bridge）。
//
// App 的「连着哪台服务器」本来就只是几把持久键（地址、局域网候选、地址簿、会话令牌、登录态快照、发行版声明），
// 全套代码都按「只有一台」写的。所以这里不去改那些模块，只做两件事：
//   · 档案：每台服务器一份上面那几把键的快照，存在 bridge-servers；当前这台的「活」值仍在原来的键里。
//   · 切换：把当前活值存回它自己的档案 → 目标档案的快照写回那几把键 → 整页重载（品牌、语言、地址簿都在启动时定死）。
// 本地聊天缓存（IndexedDB）按档案分库（cacheNamespace）：不然切过去那一瞬会先冒出上一台的会话列表。
// 第一份档案（从升级前的单服务器状态迁移来的）沿用老库名，升级不丢缓存。
//
// 只在离线壳里启用（网页 / 桌面壳的服务器就是页面同源，换服务器 = 换网址）。localStorage 里放 bridge-servers-dev=1 可在 dev 里调界面。
// 档案里有别的服务器的会话令牌：和当前令牌同一个存放处（原生 SharedPreferences），没有降低保护。

import { storeGet, storeSet } from './store.js';
import { DISTRO, BRIDGE_BRAND } from './distro.js';

const KEY = 'bridge-servers';
// 档案字段 ↔ 持久键（与 server.js / api.js / state.svelte.js / distro.js 里的键逐字一致）
const LIVE = {
  base: 'bridge-server',
  lan: 'bridge-server-lan',
  book: 'bridge-server-book',
  token: 'bridge-token',
  me: 'bridge-me',
  distro: 'bridge-distro',
};
const CACHE_ME = 'bridge-cache-me';   // lib/cache.js 的离线登录态（只在 localStorage）
const PALETTE = ['#d97757', '#5b8def', '#3fb68b', '#b07cf0', '#e0a43a', '#e2667f', '#3fb3c6'];

const isApkPage = () => { try { return location.hostname === 'appassets.androidplatform.net'; } catch { return false; } };
const devOn = () => { try { return localStorage.getItem('bridge-servers-dev') === '1'; } catch { return false; } };
export const canSwitchServers = () => isApkPage() || devOn();

function load() {
  try {
    const s = JSON.parse(storeGet(KEY) || 'null');
    if (s && Array.isArray(s.list)) return { active: typeof s.active === 'string' ? s.active : '', list: s.list.filter((p) => p && p.id) };
  } catch {}
  return { active: '', list: [] };
}
function save(s) { storeSet(KEY, JSON.stringify({ v: 1, active: s.active, list: s.list })); }

const rid = () => {
  const u = new Uint8Array(6);
  try { crypto.getRandomValues(u); } catch { for (let i = 0; i < u.length; i++) u[i] = Math.random() * 256; }
  return [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
};
function colorFor(id, used) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < PALETTE.length; i++) {
    const c = PALETTE[(h + i) % PALETTE.length];
    if (!used.includes(c)) return c;
  }
  return PALETTE[h % PALETTE.length];
}
export function hostLabel(base) {
  try { return new URL(base).host.replace(/^www\./, ''); } catch { return String(base || ''); }
}
function parse(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }

/** 档案的默认名：发行版有自己的品牌就用品牌（「Muse Bridge」），否则用地址里的主机名。用户改过名（named）不动。 */
function defaultName(p) {
  const brand = p.distro?.brand;
  if (brand && brand !== BRIDGE_BRAND) return brand;
  return hostLabel(p.base) || BRIDGE_BRAND;
}

/** 首字（单个汉字或大写字母），给档案的圆章用 */
export function monogram(name) {
  const s = String(name || '').trim();
  const ch = [...s][0] || 'B';
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/** 品牌两行字（与 distro.brandWords 同规则，但按档案自己的品牌算——切换动画要显示「下一台」的品牌） */
export function brandWordsOf(brand) {
  const parts = String(brand || BRIDGE_BRAND).trim().toUpperCase().split(/\s+/);
  return parts.length > 1 ? [parts.slice(0, -1).join(' '), parts[parts.length - 1]] : ['', parts[0] || ''];
}

function readLive() {
  const o = {};
  for (const [f, k] of Object.entries(LIVE)) o[f] = storeGet(k) || '';
  try { o.cacheMe = localStorage.getItem(CACHE_ME) || ''; } catch { o.cacheMe = ''; }
  return o;
}
function writeLive(p) {
  for (const [f, k] of Object.entries(LIVE)) storeSet(k, p && p[f] ? p[f] : null);
  try { if (p && p.cacheMe) localStorage.setItem(CACHE_ME, p.cacheMe); else localStorage.removeItem(CACHE_ME); } catch {}
}

// 把活值收进当前档案（没有就建一份）。启动拿到登录态后、切走之前各调一次。
function captureInto(s) {
  const live = readLive();
  let p = s.list.find((x) => x.id === s.active);
  if (!live.base) return p || null;          // 「添加服务器」刚建、还没连上的空档案：什么都不收
  if (!p) {
    const id = rid();
    // 第一份档案 = 升级前就在用的那台：沿用老的聊天缓存库（ns 空）
    p = { id, ns: s.list.length ? id : '', color: colorFor(id, s.list.map((x) => x.color)), at: Date.now() };
    s.list.push(p);
    s.active = id;
  }
  const book = parse(live.book);
  Object.assign(p, live);
  p.serverId = (book && book.id) || p.serverId || '';
  const d = parse(live.distro);
  p.brand = (d && d.brand) || (DISTRO && DISTRO.brand) || BRIDGE_BRAND;
  if (!p.named) p.name = defaultName({ base: live.base, distro: { brand: p.brand } });
  p.at = Date.now();
  // 同一台服务器存了两份（用「更换服务器地址」改连到了另一份档案那台，或者重复添加）：留当前这份
  if (p.serverId) s.list = s.list.filter((x) => x === p || x.serverId !== p.serverId);
  return p;
}

/** 启动后（auth 回来）调：把当前连着的服务器记进档案。非离线壳什么都不做。 */
export function syncActiveProfile() {
  if (!canSwitchServers()) return;
  const s = load();
  const before = JSON.stringify(s);
  captureInto(s);
  if (JSON.stringify(s) !== before) save(s);
}

/** 给界面用的档案列表（不含令牌等快照）。当前那台排第一。 */
export function listProfiles() {
  const s = load();
  const out = s.list.filter((p) => p.base || p.id === s.active).map((p) => ({
    id: p.id, name: p.name || defaultName(p), color: p.color || PALETTE[0], base: p.base || '', lan: p.lan || '',
    brand: p.brand || BRIDGE_BRAND, active: p.id === s.active, pending: !p.base,
  }));
  return out.sort((a, b) => (b.active - a.active));
}

export function activeProfile() { return listProfiles().find((p) => p.active) || null; }

/** 当前档案的聊天缓存命名空间（lib/cache.js 拿它拼库名）。模块求值时读一次——切换是整页重载，不会中途变。 */
export function cacheNamespace() {
  if (!canSwitchServers()) return '';
  const s = load();
  const p = s.list.find((x) => x.id === s.active);
  return (p && p.ns) || '';
}

export function renameProfile(id, name) {
  const s = load();
  const p = s.list.find((x) => x.id === id);
  if (!p) return;
  const n = String(name || '').trim().slice(0, 24);
  if (n) { p.name = n; p.named = true; } else { p.named = false; p.name = defaultName(p); }
  save(s);
}

/** 删掉一份不在用的档案：顺手在那台服务器上退出它的会话（尽力而为），删掉它的聊天缓存库。 */
export function removeProfile(id) {
  const s = load();
  const p = s.list.find((x) => x.id === id);
  if (!p || p.id === s.active) return false;
  s.list = s.list.filter((x) => x !== p);
  save(s);
  if (p.base && p.token) {
    try {
      fetch(p.base + '/api/logout', { method: 'POST', keepalive: true, cache: 'no-store', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.token }, body: '{}' }).catch(() => {});
    } catch {}
  }
  if (p.ns) { try { indexedDB.deleteDatabase('bridge-chat-cache@' + p.ns); } catch {} }
  return true;
}

// 切换的「落地」：收好当前 → 写入目标 → 冻结持久键（重载前还在路上的回调别把目标的键又写回旧值）。调用方随后整页重载。
// target = 档案 id，或 null = 新建一份空档案（重载后落到「连接你的 bridge 服务器」）。
export function commitSwitch(target) {
  const s = load();
  const cur = captureInto(s);
  // 没连上过的空档案（添加到一半又切回去）：直接扔掉
  if (cur && !cur.base) s.list = s.list.filter((x) => x !== cur);
  let next;
  if (target) {
    next = s.list.find((x) => x.id === target);
    if (!next) return false;
  } else {
    const id = rid();
    next = { id, ns: id, color: colorFor(id, s.list.map((x) => x.color)), name: '', at: Date.now() };
    s.list.push(next);
  }
  s.active = next.id;
  save(s);
  writeLive(next);
  try { sessionStorage.removeItem('bridge-distro:reloaded'); } catch {}   // distro.js 的「本会话已刷新过一次」闸：换了服务器要重新认品牌
  freezeStore();
  return true;
}

// 冻结期间 store.js 的写入一律丢弃（commitSwitch 之后到页面卸载之间）
function freezeStore() { try { window.__bridgeStoreFrozen = true; } catch {} }
