// Usage + rate-limit + context state used by Claude chat + routines.
// The SDK streams `rate_limit_event` (subscription 5h/weekly buckets) and, on
// every `result`, per-model token usage incl. the context window size. We fold
// those into a small cached snapshot so the phone can render a progress panel
// and so we can turn a raw failure into a plain-Chinese notice ("5 小时额度已达
// 上限" etc). Persisted so a freshly loaded page shows last-known immediately.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outboundHint } from './net-proxy.mjs';
import { activeToken } from './claude-account.mjs';

let _statusPath = '';
// Rate limits are account-wide (everyone shares one upstream Claude subscription),
// so they live on this shared snapshot. Context fill is PER-CONVERSATION, so it is
// kept per caller key (admin / u:<name>) in `contexts` and never served to others.
// plan：套餐名（SDK usage 的 subscription_type → "Max"/"Pro"…；OAuth token 路径下服务端常不给，留 null）。
export let statusState = { limits: {}, updatedAt: 0, plan: null };
const contexts = new Map(); // caller key -> { used, total, pct, sessionId }
let lastRejection = null; // { type, resetsAt } — most recent hard rejection
let statusSaveTimer = null;

export function initStatus(root) {
  _statusPath = path.join(root, 'status.json');
  if (!existsSync(_statusPath)) return;
  try {
    const s = JSON.parse(readFileSync(_statusPath, 'utf8'));
    if (s && typeof s === 'object') {
      statusState = { limits: s.limits || {}, updatedAt: s.updatedAt || 0, plan: s.plan || null };
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
    try { writeFileSync(_statusPath, JSON.stringify({ limits: statusState.limits, updatedAt: statusState.updatedAt, plan: statusState.plan || null, contexts: Object.fromEntries(contexts) })); } catch {}
  }, 400);
}

function normResetMs(v) {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v); // accept seconds or ms epoch
}

function normPct(u) {
  if (typeof u !== 'number' || !isFinite(u)) return null;
  const p = u <= 1 ? u * 100 : u; // accept fraction or percent
  return Math.max(0, Math.min(100, Math.round(p)));
}

// 桶名语义（CLI 2.1.257 二进制 eF 表原文）：five_hour="session limit"、seven_day="weekly limit"、
// seven_day_opus="Opus limit"、seven_day_sonnet="Sonnet limit"、seven_day_overage_included="Fable limit"、
// overage="usage credit limit"——**seven_day_overage_included 就是 Fable 周限额**，前端标签照此显示。
export function applyRateLimit(info) {
  if (!info || !info.rateLimitType) return;
  const now = Date.now();
  // 2026-09-05 实测：事件顶层早就不带 utilization，真实利用率在 unifiedWindows{five_hour,seven_day,
  // seven_day_overage_included}[{utilization:0–1 分数, resetsAt:秒}] 里——以前没读它，pct 一直是旧探针值、
  // 只有 updatedAt 在动（手机显示「刚刚 · 5 小时 1%」而官方同刻已 100%）。每帧整桶刷新。
  const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
  if (uw) {
    for (const [k, w] of Object.entries(uw)) {
      if (!w || typeof w.utilization !== 'number' || !isFinite(w.utilization)) continue;
      const prev = statusState.limits[k] || {};
      statusState.limits[k] = {
        status: k === info.rateLimitType ? (info.status || 'allowed') : (prev.status || 'allowed'),
        pct: normPct(w.utilization),
        resetsAt: normResetMs(w.resetsAt) || prev.resetsAt || 0,
        at: now,
        ...(prev.label ? { label: prev.label } : {}),
      };
    }
  }
  // 主导桶：事件顶层 status/resetsAt/utilization（老版本才有 utilization）；被拒 = 这桶已 100%。
  const prev = statusState.limits[info.rateLimitType] || {};
  const pct = info.status === 'rejected' ? 100
    : typeof info.utilization === 'number' ? normPct(info.utilization) : (prev.pct ?? null);
  statusState.limits[info.rateLimitType] = {
    ...prev,
    status: info.status || 'allowed',
    pct,
    resetsAt: normResetMs(info.resetsAt) || prev.resetsAt || 0,
    at: (uw && uw[info.rateLimitType]) || info.status === 'rejected' || typeof info.utilization === 'number' ? now : (prev.at || 0),
  };
  statusState.updatedAt = now;
  if (info.status === 'rejected') lastRejection = { type: info.rateLimitType, resetsAt: normResetMs(info.resetsAt) };
  else if (lastRejection && lastRejection.type === info.rateLimitType) lastRejection = null;
  persistStatus();
}

// usage-probe 从 /v1/messages 响应头直读的双桶真实利用率（权威来源，整桶覆盖）。
// 桶字段：utilization（0–1 分数或百分数，normPct 自适应）或 pct（已是百分数，SDK usage 给的
// 是 4/1 这种整数百分比，走 utilization 会被 ≤1 当分数放大 100 倍）；label=按模型分桶的显示名。
export function applyProbedLimits(buckets) {
  let changed = false;
  for (const [type, b] of Object.entries(buckets || {})) {
    if (!b) continue;
    const pct = typeof b.pct === 'number' && isFinite(b.pct) ? Math.max(0, Math.min(100, Math.round(b.pct)))
      : (typeof b.utilization === 'number' && isFinite(b.utilization) ? normPct(b.utilization) : null);
    if (pct == null) continue;
    statusState.limits[type] = {
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
    statusState.updatedAt = Date.now();
    persistStatus();
  }
}

// SDK 控制接口 usage_EXPERIMENTAL 的响应（= Claude Code /usage 的数据）：五小时/每周 + 按模型的
// 每周桶（model_scoped，服务端给了才有——Fable/Opus/Sonnet 单桶就从这里来）+ 套餐类型。
// 与 usage-probe 的响应头来源互补：同键覆盖、缺的保留。
const PLAN_NAMES = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
export function applySdkUsage(u) {
  if (!u || typeof u !== 'object') return false;
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
  if (Object.keys(buckets).length) { applyProbedLimits(buckets); changed = true; }
  const sub = typeof u.subscription_type === 'string' ? u.subscription_type.toLowerCase() : '';
  const plan = sub ? (PLAN_NAMES[sub] || (sub[0].toUpperCase() + sub.slice(1))) : null;
  if (plan !== statusState.plan) { statusState.plan = plan; changed = true; persistStatus(); }
  return changed;
}

// 化石清理：重置时刻已过去 1 小时以上的桶直接删——老版本 SDK 留下的过期 pct
// （如 5 月底的 seven_day 78%）曾被前端当成"唯一有数据的行"永久展示。
export function pruneStaleLimits() {
  let changed = false;
  for (const [k, v] of Object.entries(statusState.limits)) {
    if (v && v.resetsAt && v.resetsAt < Date.now() - 3600_000) { delete statusState.limits[k]; changed = true; }
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
  statusState.updatedAt = Date.now();
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

// Turn any failure (thrown error, error result, or SDK error kind) into a
// structured, plain-Chinese notice the phone renders nicely.
export function classifyError(raw, kind) {
  const s = String(raw == null ? '' : (raw.message || raw)).toLowerCase();
  const k = kind || '';
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
    // 控制台「Claude 账号」里加的令牌不进环境变量（每次 query 现注），也要算「配过」——否则令牌被撤销时会误报「还没配置」
    const configured = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || activeToken());
    return configured
      ? { kind: 'auth', title: '登录已失效', hint: '令牌过期或被撤销：在你自己的电脑上重新运行 claude setup-token，把新令牌更新到「设置 → 连接 → 服务端控制台 → Claude 账号」（在 Muse 上部署的，也可以让 Muse 运行 set-claude-token）。' }
      : { kind: 'auth', title: '服务端还没配置 Claude 认证', hint: '在你自己的电脑上运行 claude setup-token 生成订阅令牌，然后在「设置 → 连接 → 服务端控制台 → Claude 账号」里添加；在 Muse 上部署的，也可以把令牌发给 Muse，让它运行 set-claude-token。' };
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
