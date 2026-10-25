// Multi-user account store (Phase 1). Pure fs under SYSTEM_DIR. Holds password
// hashes (scrypt), single-use invite codes, auth sessions (cookie token -> user),
// and per-user usage totals. NEVER written inside a user folder.
//
// Low-concurrency personal bridge: writes are tmp+rename (atomic, no corruption);
// read-modify-write races between the production and loopback-admin instances are
// possible but acceptable here. admin (access token) never touches this store.

import { mkdirSync, watch, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { SYSTEM_DIR, userRoot } from './config/index.mjs';
import { USER_DEFAULT_AGENTS, normAgentList } from './config/agents.mjs';
import { dayKey, normOverride } from './runtime/policy.mjs';
import { readJson as readJsonFile, writeJson as writeJsonAtomic } from './jsonfile.mjs';

// 异步 scrypt：同步版每次登录阻塞事件循环 ~50-100ms，公网上被刷 /api/login 会拖垮
// 整个单线程 server（SSE 心跳、其他用户请求全卡住）。异步版跑在 libuv 线程池。
const scryptAsync = promisify(scrypt);

const USERS = path.join(SYSTEM_DIR, 'users.json');
const INVITES = path.join(SYSTEM_DIR, 'invites.json');
const SESSIONS = path.join(SYSTEM_DIR, 'sessions.json');
const USAGE = path.join(SYSTEM_DIR, 'usage.json');
const RETIRED = path.join(SYSTEM_DIR, 'retired-accounts.json');   // 删过的账号 id（永不复用）+ 数据去向
export const SESSION_MAX_AGE = 90 * 24 * 60 * 60 * 1000;   // 会话绝对过期 90 天
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;                 // 新发的邀请码 7 天内有效

// 登录会话结束（退出 / 改密码踢下线 / 删号 / 吊销管理员会话）时发 'ended' (sids[])：设备通道据此立刻断开
// 这些会话登记的电脑（runtime/account-lifecycle.mjs 订阅；账号库本身不 import 设备模块，免得循环依赖）。
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(20);
const endedSessions = (sids) => { if (sids.length) { try { sessionEvents.emit('ended', sids); } catch {} } };

// Authentication is on every request. Keep the two hot stores in memory instead
// of synchronously parsing sessions.json + users.json every time. Directory
// watching invalidates promptly across the production/admin processes; the TTL is
// a fallback for filesystems that coalesce/miss watch events.
const hotCache = new Map();
const HOT_CACHE_MS = 5000;
function readHotJson(file) {
  const hit = hotCache.get(file);
  if (hit && Date.now() - hit.at < HOT_CACHE_MS) return hit.value;
  const value = readJsonFile(file, {});
  hotCache.set(file, { value, at: Date.now() });
  return value;
}
function invalidateHot(file) { hotCache.delete(file); }
try {
  const watcher = watch(SYSTEM_DIR, { persistent: false }, (_event, filename) => {
    const name = filename == null ? '' : String(filename).toLowerCase();
    if (!name || name === path.basename(USERS).toLowerCase()) invalidateHot(USERS);
    if (!name || name === path.basename(SESSIONS).toLowerCase()) invalidateHot(SESSIONS);
  });
  watcher.on('error', () => {});
} catch {}

// These files are human-inspectable, so keep them pretty-printed (the atomic
// tmp+rename write itself lives in jsonfile.mjs).
const writeJson = (file, obj) => {
  writeJsonAtomic(file, obj, 2);
  invalidateHot(file);
};
const readJson = readJsonFile;
// 只认自己的键：账号名 / 令牌 / 用量键都来自外部，'__proto__'、'constructor' 这类名字不能读到 Object.prototype 上去
// （否则改账号的接口会改到原型上，整个进程的对象都「长出」tier / trustAck）。
const own = (o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined);

// ---- username (becomes a folder name; ASCII only, case-insensitive unique) ----
const RESERVED = new Set(['_system', 'admin', 'con', 'nul', 'prn', 'aux', 'system']);
// Windows reserves these device names as filenames — a user folder named e.g. com1
// would be uncreatable/broken. The name IS a folder, so block them (already lowercased).
const WIN_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
export function normName(raw) { return String(raw || '').trim().toLowerCase(); }
export function validName(raw) {
  const n = normName(raw);
  return /^[a-z0-9_-]{2,32}$/.test(n) && !n.startsWith('_') && !n.startsWith('-') && !RESERVED.has(n) && !WIN_DEVICE.test(n);
}

// ---- 账号 id（S2-4 / C2）----
// users.json 仍以登录名为键（回退旧版时照常能登录）；每条记录多一个【不可变】的 id：用户目录（userRoot(id)）、
// owner 键（'u:<id>'，设备 / 端口转发 / 总线 / 并发都认它）、用量账本、登录会话都挂在 id 上。登录名只用来登录和显示，可以改。
//   老账号没有 id 字段 = id 就是它当初的用户名——老数据零迁移：目录、owner 键、用量键全都不变。
//   新账号的 id = 用户名 + '-' + 4 位随机串，且不与现存的任何 id / 用户名、删过的 id（retired-accounts.json）、
//   磁盘上已有的目录重合——同名的人删号后再注册，拿到的是全新的 id 和目录，继承不到旧人的任何东西
//   （以前 owner 键就是 'u:<名字>'，同名重新注册会接手旧人的文件、定时任务、用量、甚至电脑）。
// 两套名字不会撞：建号 / 改名时挡掉「名字等于别人的 id」，所以下面按 id 或登录名都能唯一找到一个账号。
export const accountId = (rec) => (rec ? String(rec.id || rec.name || '') : '');
let idMap = null, idMapOf = null;
function idIndex(u) {
  if (idMapOf !== u) {
    idMap = new Map();
    for (const [k, r] of Object.entries(u)) if (r && typeof r === 'object') idMap.set(accountId(r) || k, k);
    idMapOf = u;
  }
  return idMap;
}
// 按登录名或 id 找账号在 users.json 里的键；找不到 null。
function locate(u, ref) {
  const r = normName(ref);
  if (!r) return null;
  const rec = own(u, r);
  if (rec && typeof rec === 'object') return r;
  return idIndex(u).get(r) || null;
}
function nameTaken(u, n, selfKey = null) {
  if (own(u, n) && n !== selfKey) return '该用户名已存在';
  const owner = idIndex(u).get(n);
  if (owner && owner !== selfKey) return '该用户名已被占用';
  return '';
}
function retiredList() { const r = readJson(RETIRED, []); return Array.isArray(r) ? r : []; }
// data：'purged' / 'archived' / 'partial' / 'kept'，或 'pending'（还有页面连着，等断开后再按 want 删除 / 归档，见 account-lifecycle）
export function listRetired() { return retiredList().map(({ id, name, deletedAt, data, archive, want, pendingSince }) => ({ id, name, deletedAt, data, archive: archive || null, ...(data === 'pending' ? { want, pendingSince } : {}) })); }
// 账号生命周期内部用：带上待处理时存下的元数据（不含密码）
export function retiredRecord(id) { return [...retiredList()].reverse().find((x) => x && x.id === id) || null; }
export function updateRetired(id, patch) {
  const list = retiredList();
  const hit = [...list].reverse().find((x) => x && x.id === id);
  if (!hit) return false;
  Object.assign(hit, patch || {});
  writeJsonAtomic(RETIRED, list, 2);
  return true;
}
const ID_ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';   // 32 个，去掉易混的 l / o / 0 / 1
function newAccountId(n, u) {
  const retired = new Set(retiredList().map((x) => x && x.id).filter(Boolean));
  const ids = idIndex(u);
  for (let i = 0; i < 64; i++) {
    let s = '';
    for (const b of randomBytes(4)) s += ID_ALPHA[b % ID_ALPHA.length];
    const id = n + '-' + s;
    if (u[id] || ids.has(id) || retired.has(id) || existsSync(userRoot(id))) continue;
    return id;
  }
  return null;
}

// ---- account tier ----
// 'pro'  = 「完全信任」（2026-10-22 起界面上不再叫 Pro）：有命令行。在 L1 逻辑隔离下命令行没有可靠边界——
//          等同管理员：能读到服务器上所有人的对话、文件和全部凭据（号池令牌、各家 API Key）。
//          存储与接口里的值仍是 'pro'（老数据、老客户端零迁移）；传 'full' 也认（normTier 把非 'user' 一律归到这里）。
// 'user' = 普通：没有命令行。Claude 能上网、在自己的目录里读写改代码，Bash / PowerShell 一律拒绝。
// 缺省 / 老值 -> 'pro'：分档之前建的账号不被悄悄降级；保不保留由管理员在控制台逐个确认（trustPending）。
export const TIER_FULL = 'pro';
export function normTier(t) { return t === 'user' ? 'user' : 'pro'; }
// 完全信任要管理员明确确认过（trustAck = 确认时间）。没确认过的（老账号、旧版界面发的 Pro）控制台标「待确认」，
// 管理员逐个「确认保留」或「降为普通」；不自动降级。
export const trustPending = (rec) => !!rec && normTier(rec.tier) === TIER_FULL && !rec.trustAck;
export const FULL_TRUST_NEEDS_ACK = '完全信任等同管理员：有命令行，能读到服务器上所有人的数据和全部凭据。确认后再给';

// ---- password (scrypt, async) ----
async function hashPw(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(pw), salt, 64)).toString('hex');
  return { salt, hash };
}
async function verifyPw(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  let calc; try { calc = await scryptAsync(String(pw), rec.salt, 64); } catch { return false; }
  const expected = Buffer.from(rec.hash, 'hex');
  return calc.length === expected.length && timingSafeEqual(calc, expected);
}

// ---- per-user grants（管理员在控制台「用户」页按人设置）----
// agents  : 这个人能用哪些 agent（统一 id，见 config/agents.mjs）。没写 = 老账号 → USER_DEFAULT_AGENTS。
//           最终还要与「全局开关 + 该 agent 是否支持多用户」取交集（identity.mjs）。
// snapshot: 能不能铸公开聊天快照（/c/ 链接，用这台服务器的额度跑 Claude）。老账号没写 = 保留；新注册的默认没有。
// service : 服务账号（程序在用的账号）。关掉多用户后，只有服务账号还能登录。
export function userGrants(rec) {
  return {
    agents: Array.isArray(rec?.agents) ? normAgentList(rec.agents) : [...USER_DEFAULT_AGENTS],
    snapshot: rec?.snapshot !== false,
    service: rec?.service === true,
  };
}

// ---- users ----
export function listUsers() {
  return Object.values(readHotJson(USERS)).map((r) => ({
    id: accountId(r), name: r.name, created: r.created, disabled: !!r.disabled, tier: normTier(r.tier),
    trustPending: trustPending(r), trustAck: r.trustAck || null, renamedFrom: r.renamedFrom || null,
    ...userGrants(r), quota: r.quota || null,
  }));
}
// ref = 登录名或账号 id（见上面「账号 id」）。
export function getUser(ref) { const u = readHotJson(USERS); const k = locate(u, ref); return k ? u[k] : null; }
// 只按 id 找（登录会话、owner 键里存的都是 id）。
export function getUserById(id) { const u = readHotJson(USERS); const k = idIndex(u).get(normName(id)); return k ? u[k] : null; }
export const accountIdOf = (ref) => accountId(getUser(ref));

// opts.trustAck：建完全信任账号时管理员已确认过（时间戳）；没有就标「待确认」。
export async function createUser(name, pw, tier, { trustAck = 0 } = {}) {
  const n = normName(name);
  if (!validName(n)) return { error: '用户名只能是 2-32 位的字母/数字/下划线/连字符' };
  if (String(pw || '').length < 8) return { error: '密码至少 8 位' };
  const { salt, hash } = await hashPw(pw);
  const u = readJson(USERS, {});   // hash 之后再读，缩短读-写窗口
  const taken = nameTaken(u, n);
  if (taken) return { error: taken };
  const id = newAccountId(n, u);
  if (!id) return { error: '分配账号 id 失败，请重试' };
  const t = normTier(tier);
  // 新账号把默认名单与快照权限写成显式值：以后改默认不会悄悄改到已有的人头上。
  u[n] = { id, name: n, salt, hash, created: Date.now(), disabled: false, tier: t, agents: [...USER_DEFAULT_AGENTS], snapshot: false, ...(t === TIER_FULL && trustAck ? { trustAck: Number(trustAck) || Date.now() } : {}) };
  writeJson(USERS, u);
  try { mkdirSync(path.join(userRoot(id), '.bridge'), { recursive: true }); } catch {}
  return { ok: true, name: n, id, tier: t };
}

// 改成完全信任要 ack（管理员看过「等同管理员」的说明并确认）；降为普通随时可以，顺手清掉确认记录。
export function setTier(ref, tier, { ack = false } = {}) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  const t = normTier(tier);
  if (t === TIER_FULL && normTier(u[k].tier) !== TIER_FULL && !ack) return { error: FULL_TRUST_NEEDS_ACK, needAck: true };
  u[k].tier = t;
  if (t !== TIER_FULL) delete u[k].trustAck;
  else if (ack) u[k].trustAck = Date.now();
  writeJson(USERS, u);
  return { ok: true, tier: t, trustPending: trustPending(u[k]) };
}
// 「确认保留完全信任」：老账号逐个确认（N12）。普通档没什么可确认的。
export function ackTrust(ref) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  if (normTier(u[k].tier) !== TIER_FULL) return { error: '这个账号不是完全信任档' };
  u[k].tier = TIER_FULL;          // 缺 tier 的老账号顺手写成显式值
  u[k].trustAck = Date.now();
  writeJson(USERS, u);
  return { ok: true, trustAck: u[k].trustAck };
}

// 改登录名：id、目录、会话、用量、设备都不动（它们认的是 id），只有登录用的名字变。
export function renameUser(ref, newName) {
  const n = normName(newName);
  if (!validName(n)) return { error: '用户名只能是 2-32 位的字母/数字/下划线/连字符' };
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  if (k === n) return { ok: true, id: accountId(u[k]), name: n };
  const taken = nameTaken(u, n, k);
  if (taken) return { error: taken };
  const rec = u[k];
  const id = accountId(rec);
  delete u[k];
  u[n] = { ...rec, id, name: n, renamedFrom: rec.renamedFrom || k, renamedAt: Date.now() };
  writeJson(USERS, u);
  return { ok: true, id, name: n };
}

export function setAgents(ref, list) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  u[k].agents = normAgentList(list); writeJson(USERS, u);
  return { ok: true, agents: u[k].agents };
}
export function setSnapshotGrant(ref, on) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  u[k].snapshot = !!on; writeJson(USERS, u);
  return { ok: true, snapshot: u[k].snapshot };
}
export function setService(ref, on) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  u[k].service = !!on; writeJson(USERS, u);
  return { ok: true, service: u[k].service };
}

// A throwaway salt so a login attempt for a NON-existent user still pays the same
// scrypt cost as a real one — otherwise the fast "no such user" path leaks, by
// response timing, which usernames exist.
const DUMMY_SALT = randomBytes(16).toString('hex');
// ref = 登录名（id 也认：自助改密码的接口手里只有 id）。返回 { ok, name, id }。
export async function checkLogin(ref, pw) {
  const rec = getUser(ref);
  if (!rec) { try { await scryptAsync(String(pw), DUMMY_SALT, 64); } catch {} return { error: '用户名或密码错误' }; }
  if (rec.disabled) {
    // 禁用账号也付一次同等验证成本——否则"存在但被禁用"的用户名能靠响应时延枚举出来。
    try { await verifyPw(pw, rec); } catch {}
    return { error: '账号已被禁用，请联系管理员' };
  }
  if (!(await verifyPw(pw, rec))) return { error: '用户名或密码错误' };
  return { ok: true, name: rec.name, id: accountId(rec) };
}

export async function setPassword(ref, pw) {
  if (String(pw || '').length < 8) return { error: '密码至少 8 位' };
  const { salt, hash } = await hashPw(pw);
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  u[k].salt = salt; u[k].hash = hash; writeJson(USERS, u);
  return { ok: true };
}
// 只改账号行；停用连带的设备挂起、在跑的轮中止见 runtime/account-lifecycle.mjs setAccountDisabled。
export function setDisabled(ref, disabled) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  u[k].disabled = !!disabled; writeJson(USERS, u); return { ok: true, id: accountId(u[k]) };
}
// 删账号行 + 它的全部登录会话，并把 id 记进 retired-accounts.json（永不复用）。
// 数据（目录、设备、端口转发、用量、邀请记录）的收尾在 runtime/account-lifecycle.mjs deleteAccount；
// 单调这一个函数的老调用方，磁盘上的目录原样留着——反正同名重新注册拿到的是新 id，继承不到。
export function deleteUser(ref) {
  const u = readJson(USERS, {}); const k = locate(u, ref);
  if (!k) return { error: '用户不存在' };
  const rec = u[k]; const id = accountId(rec);
  delete u[k]; writeJson(USERS, u);
  const s = readJson(SESSIONS, {}); const gone = [];
  for (const [key, v] of Object.entries(s)) if (v && !v.admin && v.user === id) { delete s[key]; gone.push(sidOfStoredKey(key)); }
  if (gone.length) writeJson(SESSIONS, s);
  const list = retiredList();
  list.push({ id, name: rec.name, deletedAt: Date.now(), data: 'kept' });
  writeJsonAtomic(RETIRED, list.slice(-2000), 2);
  endedSessions(gone);
  return { ok: true, id, name: rec.name };
}

// ---- invite codes (single-use). Each code carries the tier the new account gets. ----
// 新码带有效期（默认 7 天）、可以作废；老码没有 expiresAt = 不过期（老数据行为不变，控制台里可以手动作废）。
// 完全信任的码要管理员确认过才发（ackAt，见 routes/admin.mjs），用它注册的账号直接记为已确认。
export function createInvite(tier, { ack = false, ttlMs = INVITE_TTL } = {}) {
  const code = randomBytes(9).toString('base64url');
  const inv = readJson(INVITES, {});
  const now = Date.now();
  const t = normTier(tier);
  inv[code] = { created: now, used: false, usedBy: null, tier: t, expiresAt: now + Math.max(60_000, Number(ttlMs) || INVITE_TTL), ...(t === TIER_FULL && ack ? { ackAt: now } : {}) };
  writeJson(INVITES, inv);
  return code;
}
const inviteDead = (rec, now = Date.now()) => !rec || rec.used || (rec.expiresAt && now > rec.expiresAt);
// Returns the granted tier ('pro'|'user') on success, or null if invalid/used/expired.
export function consumeInvite(code, byUser) {
  const inv = readJson(INVITES, {});
  const rec = Object.hasOwn(inv, String(code || '')) ? inv[String(code || '')] : null;
  if (inviteDead(rec)) return null;
  rec.used = true; rec.usedBy = byUser; rec.usedAt = Date.now();
  writeJson(INVITES, inv);
  return normTier(rec.tier);
}
// 注册成功后补记新账号的 id（删号时据此清掉它用过的邀请记录）；返回这张码的确认时间（完全信任码才有）。
export function noteInviteAccount(code, id) {
  const inv = readJson(INVITES, {});
  const rec = Object.hasOwn(inv, String(code || '')) ? inv[String(code || '')] : null;
  if (!rec) return 0;
  rec.usedById = String(id || '');
  writeJson(INVITES, inv);
  return Number(rec.ackAt) || 0;
}
// 回滚一次消费（注册流程 createUser 失败时调用），别让坏表单白烧一个码。
export function revertInvite(code) {
  const inv = readJson(INVITES, {});
  const rec = Object.hasOwn(inv, String(code || '')) ? inv[String(code || '')] : null;
  if (!rec || !rec.used) return;
  rec.used = false; rec.usedBy = null; delete rec.usedAt; delete rec.usedById;
  writeJson(INVITES, inv);
}
// 作废一张还没用的码（用过的留着当记录）。
export function revokeInvite(code) {
  const inv = readJson(INVITES, {});
  const c = String(code || '');
  if (!Object.hasOwn(inv, c)) return { error: '没有这个邀请码' };
  if (inv[c].used) return { error: '这个邀请码已经用过了' };
  delete inv[c];
  writeJson(INVITES, inv);
  return { ok: true };
}
// 删号时清掉这个账号用过的邀请记录；老记录只有 usedBy（= 当时的用户名 = 老账号的 id）。
export function dropInvitesOf(id) {
  const inv = readJson(INVITES, {});
  let n = 0;
  for (const [code, r] of Object.entries(inv)) {
    if (r && r.used && (r.usedById ? r.usedById === id : r.usedBy === id)) { delete inv[code]; n++; }
  }
  if (n) writeJson(INVITES, inv);
  return n;
}
export function listInvites() {
  const now = Date.now();
  return Object.entries(readJson(INVITES, {})).map(([code, r]) => ({
    code, used: !!r.used, usedBy: r.usedBy || null, created: r.created, tier: normTier(r.tier),
    expiresAt: r.expiresAt || null, expired: !r.used && !!r.expiresAt && now > r.expiresAt,
    // 升级前发的完全信任（Pro）码：没有有效期、也没经过「等同管理员」的确认，用它注册立刻就有命令行——控制台醒目标出来、能一键作废
    legacyFull: !r.used && !r.expiresAt && !r.ackAt && normTier(r.tier) === TIER_FULL,
  }));
}

// ---- auth sessions (cookie token -> user) ----
// 落盘只存令牌的 SHA-256（键 = 'h:' + hex）：sessions.json 被人读到也冒充不了任何人——
// 软隔离下有命令行的用户理论上够得着这个文件（三端拆分方案 5.2「收紧」第 1 条）。
// 令牌本身是 24 字节随机数，不需要加盐/慢哈希。旧格式（键就是明文令牌）在启动时就地转换，
// 大家不用重新登录；转换前的读取也兼容明文键。
const HASHED = 'h:';
const sessionKey = (token) => HASHED + createHash('sha256').update(String(token)).digest('hex');
// 会话 id（sid）= 哈希键的前 16 位：设备登记记它（S2-4「设备跟着登记它的那次登录走」），管理员会话列表也用它。
// 不是凭据，反推不出令牌。明文老键按它的哈希算，口径一致。
const sidOfStoredKey = (key) => (String(key).startsWith(HASHED) ? sessionIdOfKey(key) : sessionIdOfKey(sessionKey(key)));
// 落盘的 user 是账号 id（老会话里是用户名 = 老账号的 id）；ref 传登录名或 id 都行。
export function createSession(ref) {
  const token = randomBytes(24).toString('base64url');
  const s = readJson(SESSIONS, {});
  pruneSessionObject(s);
  s[sessionKey(token)] = { user: accountIdOf(ref) || normName(ref), created: Date.now() };
  writeJson(SESSIONS, s);
  return token;
}
// user = 登录名（显示用，老调用方据此认人），id = 账号 id（身份 / 目录 / owner 键用它），sid / since = 这次登录。
export function getSession(token) {
  if (!token) return null;
  const all = readHotJson(SESSIONS);
  const rec = own(all, sessionKey(token)) || (String(token).startsWith(HASHED) ? null : own(all, token));
  if (!rec || rec.admin) return null;   // 管理员会话不是账号会话（见下方「管理员会话」）
  if (rec.created && Date.now() - rec.created > SESSION_MAX_AGE) return null; // 绝对过期 → 强制重新登录（限缩失窃 cookie 寿命）
  const u = getUserById(rec.user);
  if (!u || u.disabled) return null; // revoked the moment the account is gone/disabled
  return { user: u.name, id: accountId(u), sid: sidOfStoredKey(sessionKey(token)), since: rec.created || 0, tier: normTier(u.tier), ...userGrants(u) };
}
export function deleteSession(token) {
  if (!token) return;
  const s = readJson(SESSIONS, {});
  const k = sessionKey(token);
  if (own(s, k) || own(s, token)) { delete s[k]; delete s[token]; writeJson(SESSIONS, s); endedSessions([sessionIdOfKey(k)]); }
}
// 这个人的所有登录会话一并作废（改 / 重置密码时）；keepToken = 发起修改的那台设备，留着它别把自己踢下线。
// 返回作废了的会话 id。
export function deleteUserSessions(ref, keepToken = '') {
  const id = accountIdOf(ref) || normName(ref);
  const keep = keepToken ? sessionKey(keepToken) : '';
  const s = readJson(SESSIONS, {});
  const gone = [];
  for (const [key, v] of Object.entries(s)) {
    if (v && !v.admin && v.user === id && key !== keep && key !== keepToken) { delete s[key]; gone.push(sidOfStoredKey(key)); }
  }
  if (gone.length) writeJson(SESSIONS, s);
  endedSessions(gone);
  return gone;
}
// 某次登录还在不在（设备通道鉴权用，见 runtime/account-lifecycle.mjs）：
//   'ok' 还在；'signed-out' 已退出 / 过期 / 被踢；'account' 账号已停用或删除。
let sidMap = null, sidMapOf = null;
function sidIndex(s) {
  if (sidMapOf !== s) {
    sidMap = new Map();
    for (const [k, r] of Object.entries(s)) if (r && typeof r === 'object') sidMap.set(sidOfStoredKey(k), r);
    sidMapOf = s;
  }
  return sidMap;
}
export function loginState(sid) {
  const rec = sid ? sidIndex(readHotJson(SESSIONS)).get(String(sid)) : null;
  if (!rec || rec.admin) return 'signed-out';
  if (rec.created && Date.now() - rec.created > SESSION_MAX_AGE) return 'signed-out';
  const u = getUserById(rec.user);
  return !u || u.disabled ? 'account' : 'ok';
}
// 账号这一级：'account' 账号已停用或删除；'signed-out' 一处有效的登录都没有了；'ok' 至少还有一处登录。
// 给没绑登录的成员设备用（这一版之前登记的，见 runtime/account-lifecycle.mjs deviceLoginState）。
export function accountLoginState(id) {
  const u = getUserById(id);
  if (!u || u.disabled) return 'account';
  const me = accountId(u);
  const now = Date.now();
  for (const r of Object.values(readHotJson(SESSIONS))) {
    if (r && !r.admin && r.user === me && !(r.created && now - r.created > SESSION_MAX_AGE)) return 'ok';
  }
  return 'signed-out';
}
// 管理员会话版：gen 为空（未配置）时不比主令牌指纹。
export function adminLoginAlive(sid, gen = '') {
  const rec = sid ? sidIndex(readHotJson(SESSIONS)).get(String(sid)) : null;
  if (!rec || !rec.admin) return false;
  if (gen && rec.gen !== String(gen)) return false;
  return !(rec.created && Date.now() - rec.created > SESSION_MAX_AGE);
}
// 一张令牌对应的会话：{ sid, created, admin }；不认识 null。
export function sessionInfo(token) {
  if (!token) return null;
  const all = readHotJson(SESSIONS);
  const k = sessionKey(token);
  const rec = own(all, k) || (String(token).startsWith(HASHED) ? null : own(all, token));
  return rec ? { sid: sessionIdOfKey(k), created: rec.created || 0, admin: !!rec.admin } : null;
}
// 旧格式迁移：明文键 → 哈希键。幂等；只在确有明文键时写盘。启动时跑一次（下方），导出给单测。
export function migrateSessionKeys() {
  const s = readJson(SESSIONS, {});
  let changed = false;
  for (const [key, rec] of Object.entries(s)) {
    if (key.startsWith(HASHED)) continue;
    const hk = sessionKey(key);
    if (!s[hk]) s[hk] = rec;
    delete s[key];
    changed = true;
  }
  if (changed) writeJson(SESSIONS, s);
}

// ---- 管理员会话（三端拆分 P4）----
// 以前「用访问令牌登录」和扫码确认（管理员身份）都把主令牌本身写进浏览器的 cookie / localStorage：
// 任何一台设备漏了，只能换主令牌、所有设备重登。现在主令牌只在登录那一下用，换来一张管理员会话：
// 同一个 sessions.json、同样只存哈希，记录标 admin:true，控制台里能逐个吊销。
// gen = 主令牌指纹（auth.mjs 算）：主令牌一换，旧的管理员会话全部作废——「换令牌 = 全部下线」的语义不变。
const ADMIN_SEEN_EVERY = 6 * 60 * 60 * 1000;   // 「最近使用」最多这么久落一次盘，别每个请求都写文件
const sessionIdOfKey = (key) => key.slice(HASHED.length, HASHED.length + 16);
export function createAdminSession({ gen, label = '', ip = '' } = {}) {
  const token = randomBytes(24).toString('base64url');
  const s = readJson(SESSIONS, {});
  pruneSessionObject(s);
  s[sessionKey(token)] = { admin: true, gen: String(gen || ''), created: Date.now(), label: String(label || '').slice(0, 80), ip: String(ip || '').slice(0, 64) };
  writeJson(SESSIONS, s);
  return token;
}
export function isAdminSession(token, gen) {
  if (!token || String(token).startsWith(HASHED)) return false;
  const key = sessionKey(token);
  const rec = readHotJson(SESSIONS)[key];
  if (!rec || !rec.admin || rec.gen !== String(gen || '')) return false;
  const now = Date.now();
  if (rec.created && now - rec.created > SESSION_MAX_AGE) return false;
  if (!rec.seen || now - rec.seen > ADMIN_SEEN_EVERY) {
    try { const s = readJson(SESSIONS, {}); if (s[key]) { s[key].seen = now; writeJson(SESSIONS, s); } } catch {}
  }
  return true;
}
// 控制台列表：只列当前主令牌下还有效的（换过令牌的旧会话已经不认，等 90 天过期自然清掉）。
export function listAdminSessions(gen) {
  const now = Date.now();
  return Object.entries(readHotJson(SESSIONS))
    .filter(([k, r]) => k.startsWith(HASHED) && r && r.admin && r.gen === String(gen || '') && !(r.created && now - r.created > SESSION_MAX_AGE))
    .map(([k, r]) => ({ id: sessionIdOfKey(k), label: r.label || '', ip: r.ip || '', created: r.created || 0, seen: r.seen || r.created || 0, ...(r.agent ? { agent: true } : {}) }))
    .sort((a, b) => b.seen - a.seen);
}
export function adminSessionIdOf(token) { return token ? sessionIdOfKey(sessionKey(token)) : ''; }
// ids：会话 id 数组，或 'all'。返回吊销了几个。
export function revokeAdminSessions(ids) {
  const s = readJson(SESSIONS, {});
  const gone = [];
  for (const [k, r] of Object.entries(s)) {
    if (!r?.admin) continue;
    if (ids === 'all' || (Array.isArray(ids) && ids.includes(sessionIdOfKey(k)))) { delete s[k]; gone.push(sessionIdOfKey(k)); }
  }
  if (gone.length) writeJson(SESSIONS, s);
  endedSessions(gone);
  return gone.length;
}

// ---- agent 密钥（给外部 agent 用接口的登录凭据，见 src/agent-api/）----
// 就是一张带 agent:true 与名字的登录会话：同一个 sessions.json、只存哈希、90 天绝对过期，
// 改密码 / 停用账号 / 换主令牌（主机的）都会让它失效，控制台的管理员会话列表里也能吊销——不另起台账。
// 明文以 bak_ 开头，方便人和密钥扫描器认出来；只在铸造时返回一次。
// owner：{ admin:true, gen } 是主机身份；{ user: 账号 id 或登录名 } 是账号。
export const AGENT_KEY_PREFIX = 'bak_';
const AGENT_KEY_MAX = 20;   // 每个身份最多这么多把，铸第 21 把要先吊销一把
const isAgentRecOf = (r, owner) => !!(r && r.agent && (owner.admin ? r.admin && r.gen === String(owner.gen || '') : !r.admin && r.user === (accountIdOf(owner.user) || normName(owner.user))));
export function createAgentKey(owner, { label = '' } = {}) {
  const s = readJson(SESSIONS, {});
  pruneSessionObject(s);
  const now = Date.now();
  const mine = Object.values(s).filter((r) => isAgentRecOf(r, owner) && !(r.created && now - r.created > SESSION_MAX_AGE));
  if (mine.length >= AGENT_KEY_MAX) { const e = new Error(`最多 ${AGENT_KEY_MAX} 把 agent 密钥，先吊销不用的再生成`); e.status = 409; throw e; }
  const token = AGENT_KEY_PREFIX + randomBytes(24).toString('base64url');
  const name = String(label || '').trim().slice(0, 60) || 'agent';
  s[sessionKey(token)] = owner.admin
    ? { admin: true, gen: String(owner.gen || ''), created: now, agent: true, label: name }
    : { user: accountIdOf(owner.user) || normName(owner.user), created: now, agent: true, label: name };
  writeJson(SESSIONS, s);
  return { token, id: sessionIdOfKey(sessionKey(token)), label: name, created: now, expiresAt: now + SESSION_MAX_AGE };
}
export function listAgentKeys(owner) {
  const now = Date.now();
  return Object.entries(readHotJson(SESSIONS))
    .filter(([k, r]) => k.startsWith(HASHED) && isAgentRecOf(r, owner) && !(r.created && now - r.created > SESSION_MAX_AGE))
    .map(([k, r]) => ({ id: sessionIdOfKey(k), label: r.label || '', created: r.created || 0, seen: r.seen || 0, expiresAt: (r.created || now) + SESSION_MAX_AGE }))
    .sort((a, b) => b.created - a.created);
}
export function revokeAgentKey(owner, id) {
  const s = readJson(SESSIONS, {});
  const gone = [];
  for (const [k, r] of Object.entries(s)) {
    if (k.startsWith(HASHED) && isAgentRecOf(r, owner) && (id === 'all' || sessionIdOfKey(k) === String(id))) { delete s[k]; gone.push(sessionIdOfKey(k)); }
  }
  if (gone.length) writeJson(SESSIONS, s);
  endedSessions(gone);
  return gone.length;
}
// 这张令牌是不是 agent 密钥；是的话顺手记「最近使用」（最多 6 小时落一次盘）。返回 { id, label } 或 null。
export function touchAgentKey(token) {
  if (!token || !String(token).startsWith(AGENT_KEY_PREFIX)) return null;
  const key = sessionKey(token);
  const rec = readHotJson(SESSIONS)[key];
  if (!rec || !rec.agent) return null;
  const now = Date.now();
  if (!rec.seen || now - rec.seen > ADMIN_SEEN_EVERY) {
    try { const s = readJson(SESSIONS, {}); if (s[key]) { s[key].seen = now; writeJson(SESSIONS, s); } } catch {}
  }
  return { id: sessionIdOfKey(key), label: rec.label || '' };
}

function pruneSessionObject(s, now = Date.now()) {
  let changed = false;
  for (const [token, rec] of Object.entries(s)) {
    if (rec?.created && now - rec.created > SESSION_MAX_AGE) {
      delete s[token];
      changed = true;
    }
  }
  return changed;
}
function pruneSessionsFile() {
  const s = readJson(SESSIONS, {});
  if (pruneSessionObject(s)) writeJson(SESSIONS, s);
}
const initialSessionPrune = setTimeout(() => { try { migrateSessionKeys(); } catch {} pruneSessionsFile(); }, 0);
initialSessionPrune.unref?.();
const sessionPruneTimer = setInterval(pruneSessionsFile, 6 * 60 * 60 * 1000);
sessionPruneTimer.unref?.();

// ---- per-user usage ----
// 累计（tokens / calls / costUsd，控制台看总账）+ 按天分桶 days['YYYY-MM-DD'] = { turns, costUsd, tokens }
// （策略时区的本地日期，只留最近 DAY_KEEP 天）：额度按「今天」与「最近 7 天（含今天）」算。
// 轮数在【开跑时】记（noteTurnStart——并行发几轮也绕不过去），花费与 tokens 在收轮时记（addUsage）。
const DAY_KEEP = 40;
function pruneDays(days) {
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - DAY_KEEP))) delete days[k];
}
function dayBucket(r, key) {
  r.days = r.days && typeof r.days === 'object' ? r.days : {};
  return (r.days[key] ||= { turns: 0, costUsd: 0, tokens: 0 });
}
// 账本按账号 id 记（老账号 id = 用户名，老账本原样接上）；传登录名也认。
const usageKey = (ref) => accountIdOf(ref) || normName(ref);
// 删号时把这个账号的用量记录摘下来（归档时随数据一起留底），返回摘下来的记录。
export function dropUsage(ref) {
  const n = usageKey(ref); if (!n) return null;
  const u = readJson(USAGE, {});
  if (!Object.hasOwn(u, n)) return null;
  const r = u[n]; delete u[n]; writeJson(USAGE, u);
  return r;
}
export function noteTurnStart(user) {
  const n = usageKey(user); if (!n) return;
  const u = readJson(USAGE, {});
  const r = own(u, n) || { tokens: 0, calls: 0, costUsd: 0 };
  dayBucket(r, dayKey()).turns += 1;
  pruneDays(r.days);
  u[n] = r; writeJson(USAGE, u);
}
// 对话轮以外按次计的用量（开源路线 S2-6，runtime/quota.mjs）：'media' 图片 / 语音 / 音乐，'video' 视频。只进分天桶。
// 老台账的分天桶里可能还有已下线的 'assist'（旧版全局助手）计数：不再读也不再写，随分天桶到期自然清掉。
const EVENT_KINDS = new Set(['media', 'video']);
export function noteUsageEvent(user, kind) {
  const n = usageKey(user); if (!n || !EVENT_KINDS.has(kind)) return;
  const u = readJson(USAGE, {});
  const r = own(u, n) || { tokens: 0, calls: 0, costUsd: 0 };
  const d = dayBucket(r, dayKey());
  d[kind] = (d[kind] || 0) + 1;
  pruneDays(r.days);
  u[n] = r; writeJson(USAGE, u);
}
export function addUsage(user, { tokens = 0, costUsd = 0 } = {}) {
  const n = usageKey(user); if (!n) return;
  const u = readJson(USAGE, {});
  const r = own(u, n) || { tokens: 0, calls: 0, costUsd: 0 };
  r.tokens += tokens || 0; r.calls += 1; r.costUsd += costUsd || 0; r.lastAt = Date.now();
  const d = dayBucket(r, dayKey());
  d.costUsd = Math.round((d.costUsd + (costUsd || 0)) * 10000) / 10000;
  d.tokens += tokens || 0;
  pruneDays(r.days);
  u[n] = r; writeJson(USAGE, u);
}
export function getUsage(name) {
  const r = own(readJson(USAGE, {}), usageKey(name)) || { tokens: 0, calls: 0, costUsd: 0 };
  const { days, ...totals } = r;
  return totals;
}
// 今天与最近 7 天（含今天）的轮数 / 花费 / tokens。
export function usageWindow(name, now = Date.now()) {
  const days = (own(readJson(USAGE, {}), usageKey(name)) || {}).days || {};
  const today = { turns: 0, costUsd: 0, tokens: 0, media: 0, video: 0 };
  const week = { turns: 0, costUsd: 0, tokens: 0, media: 0, video: 0 };
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const k = dayKey(now - i * 86400000);
    if (seen.has(k)) continue;   // 夏令时边界上同一天可能取到两次
    seen.add(k);
    const d = days[k];
    if (!d) continue;
    for (const f of ['turns', 'costUsd', 'tokens', 'media', 'video']) {
      week[f] += d[f] || 0;
      if (i === 0) today[f] += d[f] || 0;
    }
  }
  week.costUsd = Math.round(week.costUsd * 10000) / 10000;
  return { today, week };
}
export function allUsage() { return readJson(USAGE, {}); }

// 个人额度覆盖（管理员在控制台按人设）：写了的键覆盖默认，0 = 这一项对他不限，null = 全跟默认走。
export function setQuota(ref, quota) {
  const u = readJson(USERS, {}); const n = locate(u, ref);
  if (!n) return { error: '用户不存在' };
  const q = normOverride(quota);
  if (quota == null || !Object.keys(q).length) delete u[n].quota; else u[n].quota = q;
  writeJson(USERS, u);
  return { ok: true, quota: u[n].quota || null };
}
