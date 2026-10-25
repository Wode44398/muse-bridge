// 服务端策略（三端拆分 P4；开源路线 S2-6 扩充）：注册开不开、注册用户的默认额度、全服 / 每人同时最多几轮、
// 成员能不能用高消耗功能、额度按哪个时区换日。
// 存 config.json 的 policy 键（只改这一个键，其它原样保留）；管理员在控制台「额度与注册」里改，即时生效。
// 纯数据 + 读写，不 import 账号库（users.mjs 反过来要用这里的时区给用量分天）。
//
// 默认值怎么来（S2-6「不再默认不限」，同时对已有部署零破坏）：
//   · 启动时 config.json 的 policy 缺哪一项就补哪一项，并写回 config.json，以后改代码默认值不会悄悄改到已有部署头上；
//   · 补什么取决于这台服务器升级前有没有账号（_system/users.json 里有人）：
//       有 → 老部署：补成升级前的行为（不限额、不限每人并发、成员能用 fast / Ultracode / 1M / 媒体 / 视频）；
//       没有 → 新部署：补推荐值（recommendedPolicy，按这台机器的内存定全服并发）。
//   · 回退旧版本：旧代码只认 register / quota / maxUserTurns / timezone，多出来的键与额度维度它会忽略。
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, config, FEATURES, SYSTEM_DIR } from '../config/index.mjs';

// 额度的维度。缺省或 0 = 不限。
//   dayTurns / weekTurns     每天 / 最近 7 天的对话轮数（Claude、Gemini 对话、定时任务都算一轮）
//   dayCostUsd / weekCostUsd 每天 / 最近 7 天的花费（美元，按 API 价估算；Claude 每轮结束时报的金额，按轮取差入账）
//   dayMedia                 每天生成图片 / 语音 / 音乐的次数（媒体页与 Claude 的媒体工具合计）
//   dayVideo                 每天生成视频的条数
// 已下线的维度（如旧版全局助手的 dayAssist）留在 config.json 里也无妨：读时只认 LIMIT_KEYS，下次写回时自然丢掉。
export const LIMIT_KEYS = Object.freeze(['dayTurns', 'weekTurns', 'dayCostUsd', 'weekCostUsd', 'dayMedia', 'dayVideo']);
const isMoney = (k) => k.endsWith('CostUsd');

// 成员（注册用户，服务账号除外）能不能用这些高消耗功能。关着时：fast 不开、Ultracode 降到 xhigh、不用 1M 上下文、
// 不能生成图片 / 语音 / 音乐（media）或视频（video）。管理员与服务账号不受限。
export const MEMBER_FEATURES = Object.freeze(['fast', 'ultracode', 'ctx1m', 'media', 'video']);

// 默认额度：只收正数；个人覆盖另有「0 = 这一项不限」的写法（见 normOverride）。
export function normLimits(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of LIMIT_KEYS) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v > 0) out[k] = isMoney(k) ? Math.round(v * 100) / 100 : Math.floor(v);
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
    if (Number.isFinite(v) && v >= 0) out[k] = isMoney(k) ? Math.round(v * 100) / 100 : Math.floor(v);
  }
  return out;
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const posInt = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
function normMember(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(MEMBER_FEATURES.map((f) => [f, m[f] === true]));
}

// 推荐值：新部署的默认，也是控制台「用推荐值」那一下。全服同时在跑的轮数按内存给（每个 Claude CLI 常驻约 300MB，
// 再给系统和别的进程留余量）：每 2GB 一轮，2–8 之间。
export function recommendedPolicy(totalMem = os.totalmem()) {
  const gb = Number(totalMem) / 2 ** 30;
  return {
    quota: { dayTurns: 100, weekTurns: 400, dayCostUsd: 20, weekCostUsd: 80, dayMedia: 20, dayVideo: 2 },
    maxUserTurns: Math.max(2, Math.min(8, Math.floor(gb / 2) || 2)),
    maxParallelPerUser: 2,
    maxRoutinesPerUser: 10,
    member: { fast: false, ultracode: false, ctx1m: false, media: false, video: false },
  };
}
// 老部署补齐用：升级前的实际行为。
const LEGACY = Object.freeze({
  quota: {},
  maxUserTurns: 0,
  maxParallelPerUser: 0,
  maxRoutinesPerUser: 0,
  member: { fast: true, ultracode: true, ctx1m: true, media: true, video: true },
});

// 这台服务器升级前有没有账号（有 = 老部署，按旧行为补齐）。
function hadAccounts() {
  try {
    const u = JSON.parse(readFileSync(path.join(SYSTEM_DIR, 'users.json'), 'utf8').replace(/^\uFEFF/, ''));
    return !!u && typeof u === 'object' && Object.keys(u).length > 0;
  } catch { return false; }
}

// 缺哪项补哪项（纯函数，单测直接调）。返回 { raw, changed }。
export function fillPolicyDefaults(raw, { legacy, totalMem } = {}) {
  const r = raw && typeof raw === 'object' ? { ...raw } : {};
  const base = legacy ? LEGACY : recommendedPolicy(totalMem);
  let changed = false;
  for (const k of ['quota', 'maxUserTurns', 'maxParallelPerUser', 'maxRoutinesPerUser']) {
    if (!(k in r)) { r[k] = typeof base[k] === 'object' ? { ...base[k] } : base[k]; changed = true; }
  }
  const m = r.member && typeof r.member === 'object' ? { ...r.member } : {};
  for (const f of MEMBER_FEATURES) if (typeof m[f] !== 'boolean') { m[f] = base.member[f]; changed = true; }
  r.member = m;
  return { raw: r, changed };
}

// 时区默认北京时间：用的人都在国内，而云服务器的系统时区多半是 UTC——按系统时区换日，
// 「每天」会在早上 8 点重置。
function norm(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    register: r.register !== false,   // true = 凭邀请码注册；false = 关闭注册（只剩管理员直接建账号）
    quota: normLimits(r.quota),
    maxUserTurns: posInt(r.maxUserTurns),             // 全服注册用户合计同时在跑的轮数，0 = 不限
    maxParallelPerUser: posInt(r.maxParallelPerUser), // 每个成员同时在跑的轮数，0 = 不限
    maxRoutinesPerUser: posInt(r.maxRoutinesPerUser), // 每个成员最多几条启用中的定时任务，0 = 不限
    member: normMember(r.member),
    timezone: validTz(r.timezone) ? r.timezone : 'Asia/Shanghai',
  };
}

let policy;

export function getPolicy() { return { ...policy, quota: { ...policy.quota }, member: { ...policy.member } }; }

function persist() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  raw.policy = getPolicy();
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); }
  catch (e) { console.error('[policy] persist failed:', (e && e.message) || e); }
}

{
  const legacy = hadAccounts();
  const filled = fillPolicyDefaults(config.policy, { legacy });
  policy = norm(filled.raw);
  if (filled.changed) {
    persist();
    console.log(`[policy] 补齐额度策略默认值（${legacy ? '已有账号，沿用升级前的行为' : '新部署，用推荐值'}），已写回 config.json`);
  }
}

export function setPolicy(patch = {}) {
  const next = { ...policy, member: { ...policy.member } };
  if (patch.preset === 'recommended') {
    const rec = recommendedPolicy();
    Object.assign(next, { quota: rec.quota, maxUserTurns: rec.maxUserTurns, maxParallelPerUser: rec.maxParallelPerUser, maxRoutinesPerUser: rec.maxRoutinesPerUser, member: rec.member });
  }
  if (typeof patch.register === 'boolean') next.register = patch.register;
  if (patch.quota && typeof patch.quota === 'object') next.quota = patch.quota;
  if (patch.maxUserTurns != null) next.maxUserTurns = patch.maxUserTurns;
  if (patch.maxParallelPerUser != null) next.maxParallelPerUser = patch.maxParallelPerUser;
  if (patch.maxRoutinesPerUser != null) next.maxRoutinesPerUser = patch.maxRoutinesPerUser;
  if (patch.member && typeof patch.member === 'object') {
    for (const f of MEMBER_FEATURES) if (typeof patch.member[f] === 'boolean') next.member[f] = patch.member[f];
  }
  if (patch.timezone != null) {
    if (!validTz(patch.timezone)) return { error: '不认识的时区：' + patch.timezone };
    next.timezone = patch.timezone;
  }
  policy = norm(next);
  persist();
  return { ok: true, policy: getPolicy() };
}

// 现在能不能自助注册：多用户开着（形态 / config.features）且管理员没关注册。
export function registrationOpen() { return FEATURES.multiUser && policy.register; }

// 给用量分天用：某个时刻在策略时区里是哪一天（YYYY-MM-DD）。
export function dayKey(ts = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: policy.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}
