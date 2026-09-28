// Multi-user account store (Phase 1). Pure fs under SYSTEM_DIR. Holds password
// hashes (scrypt), single-use invite codes, auth sessions (cookie token -> user),
// and per-user usage totals. NEVER written inside a user folder.
//
// Low-concurrency personal bridge: writes are tmp+rename (atomic, no corruption);
// read-modify-write races between the production and loopback-admin instances are
// possible but acceptable here. admin (access token) never touches this store.

import { mkdirSync, watch } from 'node:fs';
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
const SESSION_MAX_AGE = 90 * 24 * 60 * 60 * 1000;   // 会话绝对过期 90 天

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

// ---- account tier ----
// 'pro'  = full level (shell + everything — the original single user tier).
// 'user' = restricted: NO command line. Claude may browse the web and read/write/edit
//          code in the user's own folder, but Bash/PowerShell are denied.
// Missing/legacy value -> 'pro', so accounts created before tiers aren't downgraded.
export function normTier(t) { return t === 'user' ? 'user' : 'pro'; }

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
  return Object.values(readHotJson(USERS)).map((r) => ({ name: r.name, created: r.created, disabled: !!r.disabled, tier: normTier(r.tier), ...userGrants(r), quota: r.quota || null }));
}
export function getUser(name) { return readHotJson(USERS)[normName(name)] || null; }

export async function createUser(name, pw, tier) {
  const n = normName(name);
  if (!validName(n)) return { error: '用户名只能是 2-32 位的字母/数字/下划线/连字符' };
  if (String(pw || '').length < 8) return { error: '密码至少 8 位' };
  const { salt, hash } = await hashPw(pw);
  const u = readJson(USERS, {});   // hash 之后再读，缩短读-写窗口
  if (u[n]) return { error: '该用户名已存在' };
  // 新账号把默认名单与快照权限写成显式值：以后改默认不会悄悄改到已有的人头上。
  u[n] = { name: n, salt, hash, created: Date.now(), disabled: false, tier: normTier(tier), agents: [...USER_DEFAULT_AGENTS], snapshot: false };
  writeJson(USERS, u);
  try { mkdirSync(path.join(userRoot(n), '.bridge'), { recursive: true }); } catch {}
  return { ok: true, name: n, tier: normTier(tier) };
}

export function setTier(name, tier) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  u[n].tier = normTier(tier); writeJson(USERS, u);
  return { ok: true, tier: u[n].tier };
}

export function setAgents(name, list) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  u[n].agents = normAgentList(list); writeJson(USERS, u);
  return { ok: true, agents: u[n].agents };
}
export function setSnapshotGrant(name, on) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  u[n].snapshot = !!on; writeJson(USERS, u);
  return { ok: true, snapshot: u[n].snapshot };
}
export function setService(name, on) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  u[n].service = !!on; writeJson(USERS, u);
  return { ok: true, service: u[n].service };
}

// A throwaway salt so a login attempt for a NON-existent user still pays the same
// scrypt cost as a real one — otherwise the fast "no such user" path leaks, by
// response timing, which usernames exist.
const DUMMY_SALT = randomBytes(16).toString('hex');
export async function checkLogin(name, pw) {
  const rec = getUser(name);
  if (!rec) { try { await scryptAsync(String(pw), DUMMY_SALT, 64); } catch {} return { error: '用户名或密码错误' }; }
  if (rec.disabled) {
    // 禁用账号也付一次同等验证成本——否则"存在但被禁用"的用户名能靠响应时延枚举出来。
    try { await verifyPw(pw, rec); } catch {}
    return { error: '账号已被禁用，请联系管理员' };
  }
  if (!(await verifyPw(pw, rec))) return { error: '用户名或密码错误' };
  return { ok: true, name: rec.name };
}

export async function setPassword(name, pw) {
  const n = normName(name);
  if (String(pw || '').length < 8) return { error: '密码至少 8 位' };
  const { salt, hash } = await hashPw(pw);
  const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  u[n].salt = salt; u[n].hash = hash; writeJson(USERS, u);
  return { ok: true };
}
export function setDisabled(name, disabled) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  u[n].disabled = !!disabled; writeJson(USERS, u); return { ok: true };
}
export function deleteUser(name) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  delete u[n]; writeJson(USERS, u);
  const s = readJson(SESSIONS, {}); let changed = false;
  for (const [key, v] of Object.entries(s)) if (v.user === n) { delete s[key]; changed = true; }
  if (changed) writeJson(SESSIONS, s);
  return { ok: true }; // their folder on disk is left in place; admin removes it manually if desired
}

// ---- invite codes (single-use). Each code carries the tier the new account gets. ----
export function createInvite(tier) {
  const code = randomBytes(9).toString('base64url');
  const inv = readJson(INVITES, {});
  inv[code] = { created: Date.now(), used: false, usedBy: null, tier: normTier(tier) };
  writeJson(INVITES, inv);
  return code;
}
// Returns the granted tier ('pro'|'user') on success, or null if invalid/used.
export function consumeInvite(code, byUser) {
  const inv = readJson(INVITES, {});
  const rec = inv[String(code || '')];
  if (!rec || rec.used) return null;
  rec.used = true; rec.usedBy = byUser; rec.usedAt = Date.now();
  writeJson(INVITES, inv);
  return normTier(rec.tier);
}
// 回滚一次消费（注册流程 createUser 失败时调用），别让坏表单白烧一个码。
export function revertInvite(code) {
  const inv = readJson(INVITES, {});
  const rec = inv[String(code || '')];
  if (!rec || !rec.used) return;
  rec.used = false; rec.usedBy = null; delete rec.usedAt;
  writeJson(INVITES, inv);
}
export function listInvites() {
  return Object.entries(readJson(INVITES, {})).map(([code, r]) => ({ code, used: !!r.used, usedBy: r.usedBy || null, created: r.created, tier: normTier(r.tier) }));
}

// ---- auth sessions (cookie token -> user) ----
// 落盘只存令牌的 SHA-256（键 = 'h:' + hex）：sessions.json 被人读到也冒充不了任何人——
// 软隔离下有命令行的用户理论上够得着这个文件（三端拆分方案 5.2「收紧」第 1 条）。
// 令牌本身是 24 字节随机数，不需要加盐/慢哈希。旧格式（键就是明文令牌）在启动时就地转换，
// 大家不用重新登录；转换前的读取也兼容明文键。
const HASHED = 'h:';
const sessionKey = (token) => HASHED + createHash('sha256').update(String(token)).digest('hex');
export function createSession(user) {
  const token = randomBytes(24).toString('base64url');
  const s = readJson(SESSIONS, {});
  pruneSessionObject(s);
  s[sessionKey(token)] = { user: normName(user), created: Date.now() };
  writeJson(SESSIONS, s);
  return token;
}
export function getSession(token) {
  if (!token) return null;
  const all = readHotJson(SESSIONS);
  const rec = all[sessionKey(token)] || (String(token).startsWith(HASHED) ? null : all[token]);
  if (!rec || rec.admin) return null;   // 管理员会话不是账号会话（见下方「管理员会话」）
  if (rec.created && Date.now() - rec.created > SESSION_MAX_AGE) return null; // 绝对过期 → 强制重新登录（限缩失窃 cookie 寿命）
  const u = getUser(rec.user);
  if (!u || u.disabled) return null; // revoked the moment the account is gone/disabled
  return { user: rec.user, tier: normTier(u.tier), ...userGrants(u) };
}
export function deleteSession(token) {
  if (!token) return;
  const s = readJson(SESSIONS, {});
  const k = sessionKey(token);
  if (s[k] || s[token]) { delete s[k]; delete s[token]; writeJson(SESSIONS, s); }
}
// 这个人的所有登录会话一并作废（改 / 重置密码时）；keepToken = 发起修改的那台设备，留着它别把自己踢下线。
export function deleteUserSessions(name, keepToken = '') {
  const n = normName(name);
  const keep = keepToken ? sessionKey(keepToken) : '';
  const s = readJson(SESSIONS, {});
  let changed = false;
  for (const [key, v] of Object.entries(s)) {
    if (v && !v.admin && v.user === n && key !== keep && key !== keepToken) { delete s[key]; changed = true; }
  }
  if (changed) writeJson(SESSIONS, s);
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
    .map(([k, r]) => ({ id: sessionIdOfKey(k), label: r.label || '', ip: r.ip || '', created: r.created || 0, seen: r.seen || r.created || 0 }))
    .sort((a, b) => b.seen - a.seen);
}
export function adminSessionIdOf(token) { return token ? sessionIdOfKey(sessionKey(token)) : ''; }
// ids：会话 id 数组，或 'all'。返回吊销了几个。
export function revokeAdminSessions(ids) {
  const s = readJson(SESSIONS, {});
  let n = 0;
  for (const [k, r] of Object.entries(s)) {
    if (!r?.admin) continue;
    if (ids === 'all' || (Array.isArray(ids) && ids.includes(sessionIdOfKey(k)))) { delete s[k]; n++; }
  }
  if (n) writeJson(SESSIONS, s);
  return n;
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
export function noteTurnStart(user) {
  const n = normName(user); if (!n) return;
  const u = readJson(USAGE, {});
  const r = u[n] || { tokens: 0, calls: 0, costUsd: 0 };
  dayBucket(r, dayKey()).turns += 1;
  pruneDays(r.days);
  u[n] = r; writeJson(USAGE, u);
}
export function addUsage(user, { tokens = 0, costUsd = 0 } = {}) {
  const n = normName(user); if (!n) return;
  const u = readJson(USAGE, {});
  const r = u[n] || { tokens: 0, calls: 0, costUsd: 0 };
  r.tokens += tokens || 0; r.calls += 1; r.costUsd += costUsd || 0; r.lastAt = Date.now();
  const d = dayBucket(r, dayKey());
  d.costUsd = Math.round((d.costUsd + (costUsd || 0)) * 10000) / 10000;
  d.tokens += tokens || 0;
  pruneDays(r.days);
  u[n] = r; writeJson(USAGE, u);
}
export function getUsage(name) {
  const r = readJson(USAGE, {})[normName(name)] || { tokens: 0, calls: 0, costUsd: 0 };
  const { days, ...totals } = r;
  return totals;
}
// 今天与最近 7 天（含今天）的轮数 / 花费 / tokens。
export function usageWindow(name, now = Date.now()) {
  const days = (readJson(USAGE, {})[normName(name)] || {}).days || {};
  const today = { turns: 0, costUsd: 0, tokens: 0 };
  const week = { turns: 0, costUsd: 0, tokens: 0 };
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const k = dayKey(now - i * 86400000);
    if (seen.has(k)) continue;   // 夏令时边界上同一天可能取到两次
    seen.add(k);
    const d = days[k];
    if (!d) continue;
    for (const f of ['turns', 'costUsd', 'tokens']) {
      week[f] += d[f] || 0;
      if (i === 0) today[f] += d[f] || 0;
    }
  }
  week.costUsd = Math.round(week.costUsd * 10000) / 10000;
  return { today, week };
}
export function allUsage() { return readJson(USAGE, {}); }

// 个人额度覆盖（管理员在控制台按人设）：写了的键覆盖默认，0 = 这一项对他不限，null = 全跟默认走。
export function setQuota(name, quota) {
  const n = normName(name); const u = readJson(USERS, {});
  if (!u[n]) return { error: '用户不存在' };
  const q = normOverride(quota);
  if (quota == null || !Object.keys(q).length) delete u[n].quota; else u[n].quota = q;
  writeJson(USERS, u);
  return { ok: true, quota: u[n].quota || null };
}
