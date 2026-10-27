// 设备注册表：哪些电脑能被 bridge 上的 agent 操作、各自归谁、凭什么令牌连进来。
//
// 「设备」= 一台跑着设备服务的电脑：桌面客户端（登录即登记），
// 以及从老中继迁过来的客户端。服务端只认令牌的 sha256——明文只在铸造那一刻返回一次，
// devices.json 被读走也拿不到能用的令牌（与原中继 client/host/lib/devices.mjs 同一哈希方案，
// 所以老中继的 devices.json 可以原样并进来，已配对的被控端不用重配）。
//
// owner = 身份 key（'admin' | 'u:<账号 id>'），设备只给它的主人用；管理员看得见、管得了所有设备。
// kind  = desktop（桌面客户端）| legacy（老中继迁来的；远程协助已下线，老记录也按 legacy 显示）。
//
// 账号生命周期（S2-4）：
//   login     = 登记它的那次登录 { kind:'user'|'admin', sid } / { kind:'master', gen }。那次登录退出、过期、被踢，
//               令牌随之不认（判定在 runtime/account-lifecycle.mjs deviceLoginState）。这一版之前登记的没有它：
//               管理员名下的行为不变；成员名下的鉴权时回一次 signed-out，客户端自动重新登记、就此绑上当前这次登录。
//   loginless = 这一版之后登记、却没有可绑的登录的成员设备（登记时间）：不再要求重新登记（免得来回重登）。
//   suspended = 账号停用期间挂起（令牌留着，启用后照常）。
//   tombstones = 删掉的设备留下的 { owner, machineId, tokenHash, revokedAt }：老令牌再来报「已吊销」而不是「不认识」，
//               同一次登录也不能把这台电脑自动登记回来（只有之后重新登录才行）。90 天后清掉（登录会话最长也就活 90 天）。

import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

export const DEVICES_PATH = path.join(DATA_ROOT, 'devices.json');

const KINDS = new Set(['desktop', 'legacy']);

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

const TOMBSTONE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const tsOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

function load() {
  if (!existsSync(DEVICES_PATH)) return { devices: [], tombstones: [] };
  try {
    const j = JSON.parse(readFileSync(DEVICES_PATH, 'utf8').replace(/^﻿/, ''));
    return { devices: Array.isArray(j.devices) ? j.devices : [], tombstones: Array.isArray(j.tombstones) ? j.tombstones : [] };
  } catch {
    return { devices: [], tombstones: [] };
  }
}

// 只读缓存（10-21）：listDevices / deviceById / 令牌索引都走它。以前每次现读现解析 devices.json——终端每个按键、
// 端口转发每个请求都要读两遍，每遍 0.3–2ms 同步 IO，一个 dev server 页面拉上百个模块就是几百毫秒的事件循环阻塞。
// 跟着文件 mtime 走（别的进程——迁移脚本——改了文件也认得出来），mtime 最多每秒查一次；本进程的写（save）当场作废。
// 写路径（登记 / 改名 / 吊销 / 元数据 / lastSeen / 迁移）照旧现读现改，不碰这份缓存对象；对外一律经 publicShape 拷贝。
const RECHECK_MS = 1000;
let cached = null;
let cachedMtime = -1;
let checkedAt = 0;
function loadCached() {
  const now = Date.now();
  if (cached && now - checkedAt < RECHECK_MS) return cached;
  checkedAt = now;
  const mtime = mtimeOf(DEVICES_PATH);
  if (cached && mtime === cachedMtime) return cached;
  cached = load();
  cachedMtime = mtime;
  return cached;
}

// 原子落盘：先写临时档再改名，防中途断电留下半截 JSON 把所有设备锁在门外。
function save(state) {
  const tmp = DEVICES_PATH + '.tmp';
  const cut = Date.now() - TOMBSTONE_KEEP_MS;
  const tombstones = (state.tombstones || []).filter((t) => t && tsOf(t.revokedAt) > cut);
  // 没有墓碑时不写这个键：文件形状与这一版之前逐字一致（回退旧版本也读得懂）。
  const out = tombstones.length ? { ...state, tombstones } : { ...state, tombstones: undefined };
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  renameSync(tmp, DEVICES_PATH);
  invalidate();
}

const newId = () => 'd-' + randomBytes(6).toString('hex');
const newToken = () => randomBytes(32).toString('base64url');

// 对外的设备形状：去掉 tokenHash，补上缺省字段（老中继迁来的记录没有 owner/kind）。
function publicShape(d) {
  const { tokenHash, ...rest } = d;
  return { ...rest, owner: d.owner || 'admin', kind: KINDS.has(d.kind) ? d.kind : 'legacy' };
}

// ── 铸造 ──────────────────────────────────────────────────────────────────

// 登记它的那次登录：只收白名单形状（来自服务端自己算的身份，不来自请求体）。
function normLogin(login) {
  if (!login || typeof login !== 'object') return null;
  if ((login.kind === 'user' || login.kind === 'admin') && login.sid) return { kind: login.kind, sid: clip(login.sid, 32) };
  if (login.kind === 'master' && login.gen) return { kind: 'master', gen: clip(login.gen, 32) };
  return null;
}

/**
 * 已登录的桌面客户端直接登记（不用配对码——身份已经由登录态证明）。
 * 同一主人、同一台机器（machineId）重装/重登时复用原设备 id、只换令牌：会话里「连接的设备」不会因此失联。
 * login / loginAt：这次登记凭的是哪次登录、那次登录从什么时候开始（毫秒；0 = 不知道，比如主令牌 / 本机无鉴权）。
 * 这台电脑在这次登录开始之后被吊销过（含已删除留下的墓碑）→ 拒绝（code:'revoked'）：吊销不能被客户端几秒后自动登记回来，
 * 要么重新登录、要么管理员那边不吊销。
 */
export function registerDevice({ owner, name = '', platform = '', hostname = '', machineId = '', kind = 'desktop', login = null, loginAt = 0 } = {}) {
  if (!owner) return { error: '缺少设备主人' };
  const state = load();
  const mid = clip(machineId, 80);
  let d = mid ? state.devices.find((x) => !x.revoked && (x.owner || 'admin') === owner && x.machineId === mid) : null;
  // 这台电脑眼下还有一条在用的登记（比如吊销之后又正常登记回来过）：只是换令牌，不拦。
  if (!d && mid && loginAt > 0) {
    const revokedAfter = [...state.devices.filter((x) => x.revoked), ...state.tombstones]
      .some((x) => x && (x.owner || 'admin') === owner && x.machineId === mid && tsOf(x.revokedAt) >= loginAt);
    if (revokedAfter) return { error: '这台电脑已被吊销：重新登录后才能再登记', code: 'revoked' };
  }
  const token = newToken();
  const lg = normLogin(login);
  // 成员设备登记时没有可绑的登录（正常不会发生：成员身份总带着会话）：标 loginless，与「这一版之前登记的」区分开。
  const loginless = !lg && String(owner).startsWith('u:') ? new Date().toISOString() : '';
  if (d) {
    d.tokenHash = sha256(token);
    if (name) d.name = clip(name, 60);
    if (platform) d.platform = clip(platform, 40);
    if (hostname) d.hostname = clip(hostname, 80);
    d.reissuedAt = new Date().toISOString();
    if (lg) d.login = lg; else delete d.login;
    if (loginless) d.loginless = loginless; else delete d.loginless;
    delete d.suspended;
  } else {
    d = {
      id: newId(),
      name: clip(name, 60) || clip(hostname, 60) || '未命名设备',
      owner,
      kind: KINDS.has(kind) ? kind : 'desktop',
      platform: clip(platform, 40),
      hostname: clip(hostname, 80),
      machineId: mid,
      tokenHash: sha256(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: '',
      revoked: false,
      ...(lg ? { login: lg } : {}),
      ...(loginless ? { loginless } : {}),
    };
    state.devices.push(d);
  }
  save(state);
  return { token, device: publicShape(d) };
}

// ── 鉴权 ──────────────────────────────────────────────────────────────────

// 令牌→设备 的内存索引，跟着只读缓存（loadCached，按 devices.json 的 mtime）走：别的进程（迁移脚本）改了文件，
// 吊销最迟一秒内生效；本进程里的吊销 save() 当场作废，立即生效。
let index = null;
let revokedIndex = null;   // 吊销过的令牌哈希（在册的已吊销设备 + 墓碑）：回 401 时据此说「已吊销」而不是「不认识」
let indexOf = null;
function ensureIndex() {
  const state = loadCached();
  if (index && indexOf === state) return index;
  index = new Map();
  revokedIndex = new Set();
  for (const d of state.devices) {
    if (!d.tokenHash) continue;
    if (d.revoked) revokedIndex.add(d.tokenHash); else index.set(d.tokenHash, d);
  }
  for (const t of state.tombstones || []) if (t && t.tokenHash) revokedIndex.add(t.tokenHash);
  indexOf = state;
  return index;
}
function invalidate() { index = null; revokedIndex = null; indexOf = null; cached = null; cachedMtime = -1; checkedAt = 0; }

/** 校验设备令牌，命中返回设备（对外形状），否则 null。 */
export function authDevice(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const hash = sha256(token);
  const hit = ensureIndex().get(hash);
  if (!hit) return null;
  const a = Buffer.from(hash), b = Buffer.from(hit.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return publicShape(hit);
}

/**
 * 令牌的状态：{ state:'ok', device } | { state:'revoked' } | { state:'unknown' }。
 * 客户端只在「不认识」时自动重新登记；「已吊销」就停下（S2-4：以前两种都回同一句 401，客户端 5 秒后自己登记回来）。
 */
export function deviceTokenState(token) {
  const d = authDevice(token);
  if (d) return { state: 'ok', device: d };
  if (typeof token === 'string' && token.length >= 20) {
    ensureIndex();
    if (revokedIndex && revokedIndex.has(sha256(token))) return { state: 'revoked' };
  }
  return { state: 'unknown' };
}

// lastSeen 每分钟最多落盘一次——每个请求都写会把 devices.json 拍成热点。
const lastSeenWrite = new Map();
export function touchDevice(id) {
  const now = Date.now();
  if (now - (lastSeenWrite.get(id) || 0) < 60_000) return;
  lastSeenWrite.set(id, now);
  const state = load();
  const d = state.devices.find((x) => x.id === id);
  if (!d) return;
  d.lastSeenAt = new Date().toISOString();
  save(state);
}

// ── 查询与管理 ────────────────────────────────────────────────────────────

/** owner 为空 = 全部（管理员视角）；否则只回这个主人的。默认不含已吊销的。 */
export function listDevices({ owner = null, includeRevoked = false } = {}) {
  return loadCached().devices
    .filter((d) => (includeRevoked || !d.revoked) && (!owner || (d.owner || 'admin') === owner))
    .map(publicShape);
}

export function deviceById(id) {
  const d = loadCached().devices.find((x) => x.id === id);
  return d ? publicShape(d) : null;
}

function mutate(id, fn) {
  const state = load();
  const d = state.devices.find((x) => x.id === id);
  if (!d) return { error: '无此设备' };
  const r = fn(d, state);
  if (r && r.error) return r;
  save(state);
  return { ok: true, device: state.devices.includes(d) ? publicShape(d) : null };
}

export function renameDevice(id, name) {
  const next = clip(String(name || '').trim(), 60);
  if (!next) return { error: '名字不能为空' };
  return mutate(id, (d) => { d.name = next; });
}

export function revokeDevice(id) {
  return mutate(id, (d) => { d.revoked = true; d.revokedAt = new Date().toISOString(); });
}

/** 彻底删掉一条记录。只收已吊销的——在用的设备先吊销，免得一键误删把人踢下线还不留痕。留一块墓碑（见文件头）。 */
export function deleteDevice(id) {
  return mutate(id, (d, state) => {
    if (!d.revoked) return { error: '先吊销再删除' };
    state.devices = state.devices.filter((x) => x.id !== id);
    if (d.tokenHash || d.machineId) {
      state.tombstones = [...(state.tombstones || []), { owner: d.owner || 'admin', machineId: d.machineId || '', tokenHash: d.tokenHash || '', revokedAt: d.revokedAt || new Date().toISOString() }];
    }
  });
}

/** 账号停用 / 启用：把这个主人名下（未吊销的）设备挂起或恢复。返回动到的设备 id。 */
export function setDevicesSuspended(owner, on) {
  if (!owner) return [];
  const state = load();
  const ids = [];
  for (const d of state.devices) {
    if (d.revoked || (d.owner || 'admin') !== owner) continue;
    if (on && !d.suspended) { d.suspended = new Date().toISOString(); ids.push(d.id); }
    else if (!on && d.suspended) { delete d.suspended; ids.push(d.id); }
  }
  if (ids.length) save(state);
  return ids;
}

/**
 * 并入设备自报的元数据（版本、主机名、权限档……）与上下线时间。
 * 只接受白名单字段、值一律截短——这些字段来自被控端，不可信。
 */
const META_KEYS = new Set(['client', 'lastOnlineAt', 'lastOfflineAt']);
export function updateDeviceMeta(id, patch) {
  const state = load();
  const d = state.devices.find((x) => x.id === id);
  if (!d) return false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!META_KEYS.has(k)) continue;
    if (k === 'client') d.client = { ...(d.client || {}), ...v };
    else d[k] = clip(v, 40);
  }
  save(state);
  return true;
}

// ── 迁移：并入老中继的 devices.json ────────────────────────────────────────

/**
 * 把原中继（client/host/devices.json）里的设备并进来：令牌哈希原样保留，所以已配对的被控端
 * （老客户端）把地址换成 bridge 之后直接能连，不用重新配对。
 * 已存在的 id 跳过；配对码不搬（远程协助已下线）。
 */
export function importRelayDevices(file, { owner = 'admin' } = {}) {
  let src;
  try { src = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { return { error: '读不了 ' + file + '：' + (e?.message || e) }; }
  const incoming = Array.isArray(src?.devices) ? src.devices : [];
  const state = load();
  const have = new Set(state.devices.map((d) => d.id));
  let added = 0, skipped = 0;
  for (const d of incoming) {
    if (!d || !d.id || !d.tokenHash || have.has(d.id)) { skipped++; continue; }
    state.devices.push({
      ...d,
      owner: d.owner || owner,
      kind: KINDS.has(d.kind) ? d.kind : 'legacy',
      importedAt: new Date().toISOString(),
    });
    have.add(d.id);
    added++;
  }
  if (added) save(state);
  return { ok: true, added, skipped };
}
