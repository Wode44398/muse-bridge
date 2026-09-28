// 服务端策略（三端拆分 P4）：注册开不开、注册用户的默认额度、全服同时最多几轮、额度按哪个时区换日。
// 存 config.json 的 policy 键（只改这一个键，其它原样保留）；管理员在控制台「额度与注册」里改，即时生效。
// 纯数据 + 读写，不 import 账号库（users.mjs 反过来要用这里的时区给用量分天）。
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, config, FEATURES } from '../config/index.mjs';

// 额度的四个维度：每天轮数 / 最近 7 天轮数 / 每天花费（美元）/ 最近 7 天花费。缺省或 0 = 不限。
export const LIMIT_KEYS = Object.freeze(['dayTurns', 'weekTurns', 'dayCostUsd', 'weekCostUsd']);
const isTurns = (k) => k.endsWith('Turns');

// 默认额度：只收正数；个人覆盖另有「0 = 这一项不限」的写法（见 normOverride）。
export function normLimits(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of LIMIT_KEYS) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) out[k] = isTurns(k) ? Math.floor(v) : Math.round(v * 100) / 100;
  }
  return out;
}
// 个人覆盖：写了的键才覆盖默认；0 = 这一项对他不限；没写 = 跟默认走。
export function normOverride(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of LIMIT_KEYS) {
    if (raw[k] === '' || raw[k] == null) continue;
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = isTurns(k) ? Math.floor(v) : Math.round(v * 100) / 100;
  }
  return out;
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// 时区默认北京时间：用的人都在国内，而云服务器的系统时区多半是 UTC——按系统时区换日，
// 「每天」会在早上 8 点重置。
function norm(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const maxUserTurns = Number(r.maxUserTurns);
  return {
    register: r.register !== false,   // true = 凭邀请码注册；false = 关闭注册（只剩管理员直接建账号）
    quota: normLimits(r.quota),
    maxUserTurns: Number.isFinite(maxUserTurns) && maxUserTurns > 0 ? Math.floor(maxUserTurns) : 0,
    timezone: validTz(r.timezone) ? r.timezone : 'Asia/Shanghai',
  };
}

let policy = norm(config.policy);

export function getPolicy() { return { ...policy, quota: { ...policy.quota } }; }

export function setPolicy(patch = {}) {
  const next = { ...policy };
  if (typeof patch.register === 'boolean') next.register = patch.register;
  if (patch.quota && typeof patch.quota === 'object') next.quota = patch.quota;
  if (patch.maxUserTurns != null) next.maxUserTurns = patch.maxUserTurns;
  if (patch.timezone != null) {
    if (!validTz(patch.timezone)) return { error: '不认识的时区：' + patch.timezone };
    next.timezone = patch.timezone;
  }
  policy = norm(next);
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  raw.policy = getPolicy();
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); }
  catch (e) { console.error('[policy] persist failed:', (e && e.message) || e); }
  return { ok: true, policy: getPolicy() };
}

// 现在能不能自助注册：多用户开着（形态 / config.features）且管理员没关注册。
export function registrationOpen() { return FEATURES.multiUser && policy.register; }

// 给用量分天用：某个时刻在策略时区里是哪一天（YYYY-MM-DD）。
export function dayKey(ts = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: policy.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}
