// Usage + rate-limit + context state used by Claude chat + routines.
// The SDK streams `rate_limit_event` (subscription 5h/weekly buckets) and, on
// every `result`, per-model token usage incl. the context window size. We fold
// those into a small cached snapshot so the phone can render a progress panel
// and so we can turn a raw failure into a plain-Chinese notice ("5 小时额度已达
// 上限" etc). Persisted so a freshly loaded page shows last-known immediately.

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { outboundHint } from './net-proxy.mjs';
import { activeAccountId, activeToken, apiKeyMode, accountManualPlan, listAccountsWithTokens } from './claude-account.mjs';

let _statusPath = '';
// Rate limits are per SUBSCRIPTION ACCOUNT (everyone shares the bridge's account pool),
// kept per account id in `byAccount`; `statusState` is a live view of the ACTIVE
// account's slot. 号池下各号的桶必须分开记：以前混在一份快照里，A 号周限 100% 被拒后
// 切到 B 号，弹层仍显示 A 号的 100%（usage-probe 还一直拿 A 号 token 刷）。
// Context fill is PER-CONVERSATION, so it is kept per caller key (admin / u:<name>)
// in `contexts` and never served to others.
// plan：SDK usage 的 subscription_type（小写原文 'pro'/'max'/'ultra'…；OAuth token 路径下服务端常不给，留 null）。
//   'max' 分不出 5x 与 20x，单凭它不定档。
// tier：权威来源定出的套餐档（'pro' | 'max5x' | 'ultra'）——profile 接口的 rate_limit_tier，或同组织本机登录凭据
//   （overlay 用量来源经 notePlanTier 写进来）。
// topTier：响应头 upgrade-paths 出现过且不含 upgrade_plan = 已是最高档（Ultra）；这个头只在额度吃紧时才带，
//   没带不算数（看到含 upgrade_plan 才复位）。
// noFiveHour：这个号没有 5 小时限额（2026-11 起部分 Ultra 订阅只有周限额）——权威来源（响应头 / SDK usage）
// 明确只给周桶、不给 5 小时桶时置位，同时删掉残留的 five_hour 读数；再看到 5 小时桶就复位。
const byAccount = {}; // accountId -> { limits, updatedAt, plan, tier, topTier, noFiveHour }
function slot(acct) {
  const id = acct || activeAccountId() || '_';
  return byAccount[id] || (byAccount[id] = { limits: {}, updatedAt: 0, plan: null, tier: null, topTier: false, noFiveHour: false });
}

// 套餐代号 → 显示名。Ultra = 2026-11 起的新名字，原 Max 20x 一律叫 Ultra（不管有没有 5 小时限额）；
// 'max' = 只知道是 Max、分不出 5x / 20x（SDK 只报了 subscription_type:'max'）。
export const PLAN_LABEL = { pro: 'Pro', max5x: 'Max 5x', ultra: 'Ultra', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
const TIERS = new Set(['pro', 'max5x', 'ultra']);

// 订阅类型 + rate_limit_tier（凭据文件 / profile 接口的原文）→ 套餐代号。认不出 = null。
// 已知的 tier：default_claude_ai（Pro）、default_claude_max_5x、default_claude_max_20x。
export function planFromTier(subscriptionType, rateLimitTier) {
  const sub = String(subscriptionType || '').toLowerCase().replace(/^claude_/, '');
  const tier = String(rateLimitTier || '').toLowerCase();
  if (sub === 'ultra' || /max_20x|ultra/.test(tier)) return 'ultra';
  if (/max_5x/.test(tier)) return 'max5x';
  if (sub === 'pro' || (!sub && tier === 'default_claude_ai')) return 'pro';
  return null;
}

// 本机 claude login 的凭据带着 subscriptionType + rateLimitTier（权威）。按 mtime 缓存，重新登录换号会跟着变。
let loginCache = { mtime: -1, plan: null };
export function loginPlan() {
  const dir = String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
  const f = path.join(dir, '.credentials.json');
  try {
    const m = statSync(f).mtimeMs;
    if (m !== loginCache.mtime) {
      const o = JSON.parse(readFileSync(f, 'utf8')).claudeAiOauth || {};
      loginCache = { mtime: m, plan: planFromTier(o.subscriptionType, o.rateLimitTier) };
    }
  } catch { loginCache = { mtime: -1, plan: null }; }
  return loginCache.plan;
}

// 留空 token 的号 = 本机登录态（claude-account.mjs）：套餐直接看登录凭据。
function usesLogin(id) { const a = listAccountsWithTokens().find((x) => x.id === id); return !!a && !a.token; }

// 某个号的套餐代号（'pro' | 'max5x' | 'ultra' | 'max' | 'team' … | null），按可信度从高到低：
//   ① 用户在号池里手动标的；② 本机登录态的号看登录凭据；③ 权威来源记下的 tier（profile / 同组织登录凭据）；
//   ④ SDK 的 subscription_type（'max' 再看是不是最高档 / 没有 5 小时限额 → Ultra，否则只能说 Max）；
//   ⑤ 只剩启发：没有 5 小时限额或 upgrade-paths 说已到顶 → Ultra。
// 「有 Fable 周桶」不再算 Max 的证据：2026-11 起 Pro 也有体验 Fable 的活动，会带同一组 7d_oi 桶。
export function resolvePlan(id) {
  const manual = id ? accountManualPlan(id) : '';
  if (manual) return manual;
  if (id && usesLogin(id)) { const lp = loginPlan(); if (lp) return lp; }
  const st = byAccount[id];
  if (!st) return null;
  if (st.tier && TIERS.has(st.tier)) return st.tier;
  const top = st.noFiveHour || st.topTier;
  const sub = String(st.plan || '').toLowerCase();
  if (sub === 'max') return top ? 'ultra' : 'max';
  if (sub) return sub;
  return top ? 'ultra' : null;
}
const planLabel = (code) => (code ? (PLAN_LABEL[code] || (code[0].toUpperCase() + code.slice(1))) : null);

export const statusState = {
  get limits() { return slot().limits; },
  get updatedAt() { return slot().updatedAt; },
  get plan() { return planLabel(resolvePlan(activeAccountId() || '_')); },
  get noFiveHour() { return !!slot().noFiveHour; },
};
// 指定账号的额度桶快照（智能路由判断「这个号还能不能用」）；没记录过 = 空对象。
export function accountLimits(acct) { return (byAccount[acct] && byAccount[acct].limits) || {}; }
// 套餐代号（小写，见 resolvePlan）；显示名用 PLAN_LABEL。
export function accountPlan(acct) { return resolvePlan(acct); }

// 权威来源定出的套餐档（overlay 用量来源：profile 接口 / 同组织的本机登录凭据）。null = 清掉。
export function notePlanTier(acct, tier) {
  const v = TIERS.has(tier) ? tier : null;
  const st = slot(acct);
  if (st.tier === v) return;
  st.tier = v; persistStatus();
}
// 响应头 / rate_limit_event 的 upgrade-paths（'upgrade_plan,overage' 字符串或数组）：带了才判断。
export function noteUpgradePaths(acct, paths) {
  const list = Array.isArray(paths) ? paths : (typeof paths === 'string' && paths.trim() ? paths.split(',') : null);
  if (!list) return;
  const top = !list.map((x) => String(x).trim()).includes('upgrade_plan');
  const st = slot(acct);
  if (st.topTier !== top) { st.topTier = top; persistStatus(); }
}
export function accountNoFiveHour(acct) { return !!(byAccount[acct] && byAccount[acct].noFiveHour); }

// 权威来源这次是否带了 5 小时桶：带了 → 复位；明确只有周桶 → 置位并清掉旧的 five_hour 读数。
// 返回是否有变化（调用方负责落盘）。has7d 为假（这次啥都没拿到）时不动，免得一次失败把标记冲掉。
function noteFiveHour(st, has5h, has7d) {
  if (has5h) { if (st.noFiveHour) { st.noFiveHour = false; return true; } return false; }
  if (!has7d) return false;
  let changed = false;
  if (!st.noFiveHour) { st.noFiveHour = true; changed = true; }
  if (st.limits.five_hour) { delete st.limits.five_hour; changed = true; }
  return changed;
}
// 响应头读数（无缝换号上游代理 / overlay 探头）用：这次头里有没有 5h / 7d 桶。
export function noteFiveHourPresence(acct, has5h, has7d) {
  const st = slot(acct);
  if (noteFiveHour(st, !!has5h, !!has7d)) { st.updatedAt = Date.now(); persistStatus(); }
}
const contexts = new Map(); // caller key -> { used, total, pct, sessionId }
let lastRejection = null; // { type, resetsAt } — most recent hard rejection
let statusSaveTimer = null;

export function initStatus(root) {
  _statusPath = path.join(root, 'status.json');
  if (!existsSync(_statusPath)) return;
  try {
    const s = JSON.parse(readFileSync(_statusPath, 'utf8'));
    if (s && typeof s === 'object') {
      // 旧版顶层 limits 是各号混记的，分不清归属——直接丢，下一轮额度事件按号重新填。
      for (const [id, v] of Object.entries(s.accounts && typeof s.accounts === 'object' ? s.accounts : {})) {
        if (v && typeof v === 'object') byAccount[id] = { limits: v.limits || {}, updatedAt: v.updatedAt || 0, plan: v.plan ? String(v.plan).toLowerCase() : null,
          tier: TIERS.has(v.tier) ? v.tier : null, topTier: !!v.topTier, noFiveHour: !!v.noFiveHour };
      }
      // contexts persisted as a key->ctx map; tolerate the legacy single `context` (admin's).
      const saved = (s.contexts && typeof s.contexts === 'object') ? s.contexts : (s.context ? { admin: s.context } : {});
      // Drop any persisted fill where used exceeds the window — an impossible value left by
      // the old cumulative-usage bug (a multi-tool turn summed every round's cache read to
      // >window, e.g. 1.6M against 200k). A fresh turn re-populates with the real per-turn fill.
      for (const [k, v] of Object.entries(saved)) if (v && !(v.used > v.total)) contexts.set(k, v);
    }
  } catch {}
}

function persistStatus() {
  clearTimeout(statusSaveTimer);
  statusSaveTimer = setTimeout(() => {
    try { writeFileSync(_statusPath, JSON.stringify({ accounts: byAccount, contexts: Object.fromEntries(contexts) })); } catch {}
  }, 400);
}

function normResetMs(v) {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v); // accept seconds or ms epoch
}

// utilization 一律是 0–1 分数（事件 unifiedWindows / 响应头 *-utilization 都是），超限时会略大于 1。
// 以前按「≤1 当分数、>1 当百分数」自适应：超限的 1.01 被当成 1%，弹层把爆掉的 5 小时桶显示成 1%。
// 整数百分比（SDK usage）走 applyProbedLimits 的 pct 字段，不经这里。
function normPct(u) {
  if (typeof u !== 'number' || !isFinite(u)) return null;
  return Math.max(0, Math.min(100, Math.round(u * 100)));
}

// 桶名语义（CLI 2.1.257 二进制 eF 表原文）：five_hour="session limit"、seven_day="weekly limit"、
// seven_day_opus="Opus limit"、seven_day_sonnet="Sonnet limit"、seven_day_overage_included="Fable limit"、
// overage="usage credit limit"——**seven_day_overage_included 就是 Fable 周限额**，前端标签照此显示。
// acct：这一轮 query 启动时注入的账号 id（claude-account.activeAccountId()）——轮跑到一半切号，
// 事件仍记回发起它的那个号。
export function applyRateLimit(info, acct) {
  if (!info || !info.rateLimitType) return;
  const now = Date.now();
  const st = slot(acct);
  // 2026-09-05 实测：事件顶层早就不带 utilization，真实利用率在 unifiedWindows{five_hour,seven_day,
  // seven_day_overage_included}[{utilization:0–1 分数, resetsAt:秒}] 里——以前没读它，pct 一直是旧值、
  // 只有 updatedAt 在动（手机显示「刚刚 · 5 小时 1%」而官方同刻已 100%）。每帧整桶刷新。
  const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
  if (uw) {
    for (const [k, w] of Object.entries(uw)) {
      if (!w || typeof w.utilization !== 'number' || !isFinite(w.utilization)) continue;
      const prev = st.limits[k] || {};
      // 非主导桶不沿用旧的 rejected：利用率回落到 100% 以下就是放行（曾见 status 卡在 rejected、pct 12）。
      const carried = prev.status === 'rejected' && w.utilization < 1 ? 'allowed' : (prev.status || 'allowed');
      st.limits[k] = {
        status: k === info.rateLimitType ? (info.status || 'allowed') : carried,
        pct: normPct(w.utilization),
        resetsAt: normResetMs(w.resetsAt) || prev.resetsAt || 0,
        at: now,
        ...(prev.label ? { label: prev.label } : {}),
      };
    }
    // 没有 5 小时限额的号（部分 Ultra）：unifiedWindows 只有周桶。主导桶是 five_hour 的帧不算（那就是有）。
    if (info.rateLimitType !== 'five_hour') noteFiveHour(st, !!uw.five_hour, !!uw.seven_day);
    else noteFiveHour(st, true, true);
  }
  if (info.upgradePaths) noteUpgradePaths(acct, info.upgradePaths);
  // 主导桶：事件顶层 status/resetsAt/utilization（老版本才有 utilization）；被拒 = 这桶已 100%。
  const prev = st.limits[info.rateLimitType] || {};
  const pct = info.status === 'rejected' ? 100
    : typeof info.utilization === 'number' ? normPct(info.utilization) : (prev.pct ?? null);
  st.limits[info.rateLimitType] = {
    ...prev,
    status: info.status || 'allowed',
    pct,
    resetsAt: normResetMs(info.resetsAt) || prev.resetsAt || 0,
    at: (uw && uw[info.rateLimitType]) || info.status === 'rejected' || typeof info.utilization === 'number' ? now : (prev.at || 0),
  };
  st.updatedAt = now;
  if (info.status === 'rejected') lastRejection = { type: info.rateLimitType, resetsAt: normResetMs(info.resetsAt) };
  else if (lastRejection && lastRejection.type === info.rateLimitType) lastRejection = null;
  persistStatus();
}

// 从 /v1/messages 响应头直读的真实利用率（权威来源，整桶覆盖）：无缝换号上游代理逐请求记（claude-upstream.mjs）；
// 可选的 overlay 用量来源也写这里（account-usage.mjs 交给它的 core）。
// 桶字段：utilization（0–1 分数，超限可略大于 1）或 pct（已是百分数，SDK usage 给的
// 是 4/1 这种整数百分比，走 utilization 会被 ≤1 当分数放大 100 倍）；label=按模型分桶的显示名。
export function applyProbedLimits(buckets, acct) {
  const st = slot(acct);
  let changed = false;
  for (const [type, b] of Object.entries(buckets || {})) {
    if (!b) continue;
    const pct = typeof b.pct === 'number' && isFinite(b.pct) ? Math.max(0, Math.min(100, Math.round(b.pct)))
      : (typeof b.utilization === 'number' && isFinite(b.utilization) ? normPct(b.utilization) : null);
    if (pct == null) continue;
    st.limits[type] = {
      status: b.status || 'allowed',
      pct,
      resetsAt: normResetMs(b.resetsAt),
      at: Date.now(),   // 逐桶的取数时刻——前端据此标出长期没刷新的桶
      ...(b.label ? { label: String(b.label).slice(0, 40) } : {}),
    };
    changed = true;
  }
  if (changed) {
    pruneStaleLimits();
    st.updatedAt = Date.now();
    persistStatus();
  }
}

// SDK 控制接口 usage_EXPERIMENTAL 的响应（= Claude Code /usage 的数据）：五小时/每周 + 按模型的
// 每周桶（model_scoped，服务端给了才有——Fable/Opus/Sonnet 单桶就从这里来）+ 套餐类型。
// 与响应头来源（applyProbedLimits）互补：同键覆盖、缺的保留。
export function applySdkUsage(u, acct) {
  if (!u || typeof u !== 'object') return false;
  const st = slot(acct);
  const rl = u.rate_limits || {};
  const buckets = {};
  const win = (w) => (w && typeof w.utilization === 'number' && isFinite(w.utilization))
    ? { pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : 0 } : null;
  for (const k of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
    const b = win(rl[k]); if (b) buckets[k] = b;
  }
  for (const m of (Array.isArray(rl.model_scoped) ? rl.model_scoped : [])) {
    const name = String(m?.display_name || '').trim();
    const b = win(m);
    if (name && b) buckets['model_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = { ...b, label: name };
  }
  let changed = false;
  if (Object.keys(buckets).length) { applyProbedLimits(buckets, acct); changed = true; }
  // five_hour 为 null / 利用率为 null 而周桶有数 = 这个号没有 5 小时限额（部分 Ultra）。
  if (noteFiveHour(st, !!buckets.five_hour, !!buckets.seven_day)) { changed = true; persistStatus(); }
  // 原文小写存（'max' 分不出 5x / 20x，由 resolvePlan 再结合别的线索定档）。
  const sub = typeof u.subscription_type === 'string' ? u.subscription_type.trim().toLowerCase() : '';
  const plan = sub || null;
  if (plan !== st.plan) { st.plan = plan; changed = true; persistStatus(); }
  return changed;
}

// 化石清理：重置时刻已过去 1 小时以上的桶直接删——老版本 SDK 留下的过期 pct
// （如 5 月底的 seven_day 78%）曾被前端当成"唯一有数据的行"永久展示。各号的槽都清。
export function pruneStaleLimits() {
  let changed = false;
  for (const st of Object.values(byAccount)) {
    for (const [k, v] of Object.entries(st.limits)) {
      if (v && v.resetsAt && v.resetsAt < Date.now() - 3600_000) { delete st.limits[k]; changed = true; }
    }
  }
  if (changed) persistStatus();
}

export function applyContext(modelUsage, sessionId, turnUsage, key = 'admin') {
  // Total = the largest context window among the models in play. The user's selected
  // main model has the biggest window; the background Haiku helper and any spawned
  // subagents run on equal-or-smaller windows, so the max is the main conversation's.
  let total = 0;
  for (const mu of Object.values(modelUsage || {})) { if (mu && mu.contextWindow > total) total = mu.contextWindow; }
  if (!total) return null;
  // Fill = the MAIN turn's own prompt size, from the result's TOP-LEVEL `usage`
  // (input + cache read + cache creation + the reply that just became history). Do
  // NOT derive it from `modelUsage`: that AGGREGATES parallel subagents into the
  // per-model totals, so e.g. 10 subagents sweeping the vault summed to ~926k against
  // a 200k window and pinned the bar at a bogus 100%. The top-level usage is the main
  // conversation alone (verified: with 3 file-reading subagents, top-level=42k while
  // modelUsage summed 350k). Note the field casing differs: modelUsage is camelCase
  // (contextWindow), the raw turn usage is snake_case (input_tokens, …).
  const u = turnUsage || {};
  const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  if (!used) return null;
  // Context fill is per-conversation, so tag it with its session. The client only
  // shows it for the conversation actually on screen (a new/other chat has its own
  // fill), unlike the account-wide rate limits which apply everywhere.
  const ctx = { used, total, pct: Math.max(0, Math.min(100, Math.round(used / total * 100))), sessionId: sessionId || null };
  contexts.set(key, ctx);
  // 多对话并发：并行轮各自收尾会互相覆盖 per-key 槽——再按会话记一份（仅内存，
  // 有界），/api/status?session= 能拿到「正看的这个会话」自己的填充。
  if (sessionId) {
    sessionContexts.delete(key + '|' + sessionId);
    sessionContexts.set(key + '|' + sessionId, ctx);
    while (sessionContexts.size > 200) sessionContexts.delete(sessionContexts.keys().next().value);
  }
  slot().updatedAt = Date.now();
  persistStatus();
  return ctx;
}

// The caller's own last-turn context fill (per key); null if none yet. Kept separate
// from the account-wide rate limits so one user's fill never shows on another's page.
// sessionId 可选：优先回该会话自己的填充（多对话并发下 per-key 槽是「最后收尾的那轮」）。
const sessionContexts = new Map(); // 'key|sessionId' -> ctx（内存态，重启即空，够用）
export function getContext(key = 'admin', sessionId = '') {
  if (sessionId) {
    const c = sessionContexts.get(key + '|' + sessionId);
    if (c) return c;
    const legacy = contexts.get(key);
    // 会话没有专属记录时，per-key 槽只有恰好属于这个会话才可信。
    return (legacy && legacy.sessionId === sessionId) ? legacy : null;
  }
  return contexts.get(key) || null;
}

function limitLabel(type) {
  if (type === 'five_hour') return '5 小时使用额度已达上限';
  if (type === 'seven_day') return '本周使用额度已达上限';
  if (type === 'seven_day_opus') return 'Opus 本周额度已达上限';
  if (type === 'seven_day_sonnet') return 'Sonnet 本周额度已达上限';
  if (type === 'seven_day_overage_included') return 'Fable 本周额度已达上限';   // CLI 文案表：这桶 = "Fable limit"
  if (type === 'overage') return '用量信用（extra usage）额度已用尽';
  return '使用额度已达上限';
}

function resetHint(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return '';
  const d = new Date(ms);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const mins = Math.round(diff / 60000);
  const rel = mins < 60 ? (mins + ' 分钟后') : (Math.round(mins / 6) / 10 + ' 小时后');
  return '约 ' + hhmm + ' 恢复（' + rel + '）';
}

// 撞限额的那一轮：直播（claude.mjs）与历史重建（sessions.mjs）共用的同一份描述。
// info = rate_limit_info（{rateLimitType, resetsAt 秒或毫秒}）；text = CLI 的合成回答（「You've hit your session
// limit · resets 3pm (Asia/Shanghai)」），info 缺类型时按它认桶。返回 { type, resetsAt(ms), title, hint }。
// title/hint 是给老 apk 错误框看的整句；新前端的限额卡按 type/resetsAt 自己排版（官方 Session limit reached 卡）。
// live = 直播轮：帧里没带 info 时退回最近一次硬拒绝（历史重建不能用它——那是现在的状态，不是当时的）。
export function limitNotice(info, text, { live = false } = {}) {
  const i = info || (live && lastRejection ? { rateLimitType: lastRejection.type, resetsAt: lastRejection.resetsAt } : {});
  let type = i.rateLimitType || i.type || '';
  if (!type) {
    const s = String(text || '').toLowerCase();
    type = /session limit|5-hour/.test(s) ? 'five_hour' : /opus limit/.test(s) ? 'seven_day_opus' : /sonnet limit/.test(s) ? 'seven_day_sonnet'
      : /fable limit/.test(s) ? 'seven_day_overage_included' : /weekly limit/.test(s) ? 'seven_day' : '';
  }
  const resetsAt = normResetMs(i.resetsAt) || 0;
  return { type, resetsAt, title: limitLabel(type), hint: resetHint(resetsAt) || '额度恢复后即可继续。' };
}

// Turn any failure (thrown error, error result, or SDK error kind) into a
// structured, plain-Chinese notice the phone renders nicely.
export function classifyError(raw, kind) {
  // Claude Code 运行组件还没就绪（安装包不再内嵌，首次启动在下载 / 下载失败，见 runtime/claude-cli.mjs）：标题与提示是现成的人话
  if (raw && raw.code === 'CLAUDE_CLI_NOT_READY') return { kind: 'engine', title: raw.title, hint: raw.hint };
  const s = String(raw == null ? '' : (raw.message || raw)).toLowerCase();
  const k = kind || '';
  // SDK 自己找不到二进制（绕过了 claude-cli.mjs 的路径）：同一类问题，指到设置页看进度 / 重试
  if (/native cli binary .*not found/.test(s)) {
    return { kind: 'engine', title: 'Claude Code 运行组件还没就绪', hint: '服务端会自动下载它；管理员可以在「设置 › Claude」里看进度或重试。' };
  }
  if (k === 'rate_limit' || /rate.?limit|usage limit|too many requests|\b429\b/.test(s)) {
    const rej = lastRejection || {};
    return { kind: 'rate_limit', title: limitLabel(rej.type), hint: resetHint(rej.resetsAt) || '额度恢复后即可继续。', resetsAt: rej.resetsAt || 0 };
  }
  // 403 "Request not allowed" 是 Anthropic 按【出口 IP】拒绝的，SDK 会把它包成
  // "Failed to authenticate…" —— 长得像账号被封，其实是出站没走代理。必须排在 auth
  // 分支【之前】，否则会把人引去白查 token（2026-07-21 踩过）。
  if (/request not allowed/.test(s) || (/\b403\b/.test(s) && !/api key/.test(s))) {
    return { kind: 'network', title: '出海请求被网关拒绝（不是账号问题）', hint: '这是出口 IP 被拒，不是 token 失效。' + outboundHint('403 Request not allowed') };
  }
  if (k === 'authentication_failed' || /not logged in|unauthorized|\b401\b|oauth|invalid api key|authentication failed/.test(s)) {
    // 服务端从没配过认证（新装的服务器最常见）和配过但失效，是两种处理办法。
    // 号池上线后真正生效的是号池激活号的令牌（config.oauthToken 只在第一次启动时播种一次号池），所以都指到号池去改（S4）。
    const configured = Boolean(activeToken() || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
    // 正在用按量 API Key 时失效的是 key、不是令牌（CLI 见到 key 就不用 OAuth）：别再让人去更新号池令牌，指到换 key 的地方。
    const keyMode = apiKeyMode();
    // 桌面客户端托管的本机服务端（壳设 BRIDGE_SUPERVISED=desktop）：没有 Docker / 命令行那一套，指到托盘里的重新配置。
    if (String(process.env.BRIDGE_SUPERVISED || '').trim() === 'desktop') {
      if (keyMode === 'desktop' || keyMode === 'env' || keyMode === 'config') {
        return { kind: 'auth', title: 'API Key 无效', hint: 'API Key 无效或已被撤销：在托盘「本机服务端 › 重新配置…」里换一个 key，或改选订阅令牌。' };
      }
      return configured
        ? { kind: 'auth', title: '登录已失效', hint: '令牌过期或被撤销：重新运行 claude setup-token，到「设置 › Claude › 订阅号池」里更新这个号的令牌，即时生效；也可以在托盘「本机服务端 › 重新配置…」里重填。' }
        : { kind: 'auth', title: '服务端还没配置 Claude 认证', hint: '二选一：claude setup-token 生成的订阅令牌，或 Anthropic API key。在托盘「本机服务端 › 重新配置…」里填写；订阅令牌也可以直接加到「设置 › Claude › 订阅号池」里，即时生效。' };
    }
    if (keyMode === 'env') {
      return { kind: 'auth', title: 'API Key 无效', hint: 'API Key 无效或已被撤销：换一个有效的 ANTHROPIC_API_KEY（Docker 改 .env 后 docker compose up -d，直接部署改服务的环境变量）后重启服务。设着它的时候，号池里的订阅令牌不会生效。' };
    }
    if (keyMode === 'config') {
      return { kind: 'auth', title: 'API Key 无效', hint: 'config.json 里的 anthropicApiKey 无效或已被撤销：换一个 key 后重启服务；或者把订阅令牌加到「设置 › Claude › 订阅号池」里，加上就改用订阅号，即时生效。' };
    }
    if (configured && keyMode === 'config-unused') {
      return { kind: 'auth', title: '登录已失效', hint: '令牌过期或被撤销：重新运行 claude setup-token，到「设置 › Claude › 订阅号池」（或服务端控制台「Claude 账号」）里更新这个号的令牌，即时生效。config.json 里的 anthropicApiKey 没在用：号池里有订阅令牌时优先用订阅号；要改用 API Key，把它设成环境变量 ANTHROPIC_API_KEY（Docker 写进 .env）后重启服务。' };
    }
    return configured
      ? { kind: 'auth', title: '登录已失效', hint: '令牌过期或被撤销：重新运行 claude setup-token，到「设置 › Claude › 订阅号池」（或服务端控制台「Claude 账号」）里更新这个号的令牌，即时生效；也可以运行 npm run set-auth -- <新令牌> 后重启服务。' }
      : { kind: 'auth', title: '服务端还没配置 Claude 认证', hint: '二选一：claude setup-token 生成的订阅令牌，或 Anthropic API key（ANTHROPIC_API_KEY）。订阅令牌直接加到「设置 › Claude › 订阅号池」（或服务端控制台「Claude 账号」）里，即时生效；也可以 Docker 写进 .env 的 CLAUDE_CODE_OAUTH_TOKEN 后 docker compose up -d，直接部署用 npm run set-auth -- <令牌> 后重启服务。' };
  }
  if (k === 'billing_error' || /billing|payment|insufficient|out of credit/.test(s)) {
    return { kind: 'billing', title: '账户额度 / 计费异常', hint: '检查 Claude 订阅或额度状态。' };
  }
  if (k === 'server_error' || /overloaded|internal server|service unavailable|\b50\d\b|\b529\b/.test(s)) {
    return { kind: 'server', title: 'Claude 服务器暂时不可用', hint: '通常是临时过载，过一会儿再发一次。' };
  }
  if (/econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket hang|getaddrinfo|dns|timeout/.test(s)) {
    return { kind: 'network', title: '连不上 Claude 服务器', hint: '检查家里 PC 的网络 / 隧道，或当前所在地区能否访问 api.anthropic.com。' };
  }
  if (k === 'model_not_found' || /model.*not.*found|unknown model|does not exist/.test(s)) {
    return { kind: 'model', title: '所选模型不可用', hint: '在右上角换一个模型再试。' };
  }
  if (k === 'max_output_tokens' || /max_tokens|max output/.test(s)) {
    return { kind: 'maxout', title: '回答达到长度上限', hint: '让我「继续」即可接着输出。' };
  }
  return { kind: 'unknown', title: '出错了', hint: String(raw == null ? '' : (raw.message || raw)) };
}
