// 号池逐号用量（设置 › Claude › 订阅号池、控制台「Claude 订阅账号」页）：5 小时 / 每周 / Fable 周限额。
//
// 公开版只用 Claude Code 自己带回来的额度信息，不另外向 Anthropic 发请求：
//   · 真实请求的响应头 anthropic-ratelimit-unified-*（「会话中无缝换号」的本机上游代理逐请求记，claude-upstream.mjs）；
//   · SDK 的 rate_limit_event 与 usage 接口（claude.mjs → status.mjs，按号分槽、落盘）。
// 所以闲置的号显示的是它「上次使用时」的数据（每个号带 source:'last-use'，界面据此加一句说明）；已过重置点的桶不显示。
// 号池智能路由（account-router.mjs）同样只按这些已知数据判断，refreshAccounts / probedInfo 在公开版里什么都不做。
//
// 可选的 overlay 钩子 claudeUsageProbe（接口见 runtime/overlay-hooks.mjs）可以提供另一个用量来源：配了它时
// poolUsage / refreshAccounts / probedInfo 与手机额度环的 maybeRefreshLimits（usage-probe.mjs）全部交给它，
// 核心把号池相关的几个函数当参数交过去（见下面的 core）；没配就按上面的已知数据。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OAUTH } from '../config/index.mjs';
import { listAccountsWithTokens, activeAccountId, activeToken } from './claude-account.mjs';
import { applyProbedLimits, accountLimits, accountPlan } from './status.mjs';
import { overlayHook } from './overlay-hooks.mjs';

// 留空 token 的号 = 本机登录态（见 claude-account.mjs）。上游代理（claude-upstream.mjs）同用。
// 位置跟 CLI 一样认 CLAUDE_CONFIG_DIR（测试服 / 隔离实例改道过），没设才是 ~/.claude（同 agent-status.mjs）。
export function loginToken() {
  const dir = String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
  try { return JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken || ''; } catch { return ''; }
}

// h：取 anthropic-ratelimit-unified-<名> 头的函数；k：桶缩写（5h / 7d / 7d_oi …）。
export function bucket(h, k) {
  const u = parseFloat(h(k + '-utilization'));
  if (!isFinite(u)) return null;
  const reset = parseInt(h(k + '-reset'), 10);
  return { status: h(k + '-status') || 'allowed', pct: Math.max(0, Math.min(100, Math.round(u * 100))), resetsAt: isFinite(reset) ? reset * 1000 : 0 };
}

// overlay 钩子给的用量来源（没配就是 null）。第一次用到时用核心函数造一份，之后复用同一份（缓存与去重在它自己里面）。
let probe;
export function overlayUsageProbe() {
  if (probe !== undefined) return probe;
  const make = overlayHook('claudeUsageProbe');
  probe = null;
  if (typeof make === 'function') {
    try {
      const core = { listAccountsWithTokens, activeAccountId, activeToken, applyProbedLimits, loginToken, bucket, oauthToken: () => OAUTH };
      probe = make(core) || null;
    } catch (e) { console.error('[account-usage] overlay 用量来源初始化失败：', (e && e.message) || e); probe = null; }
  }
  return probe;
}

// 智能路由切号前核实候选号的余量：配了 overlay 用量来源就交给它（结果写进按号分槽）；没配就按已知数据决策，不发请求。
export async function refreshAccounts(ids, maxAge) {
  const p = overlayUsageProbe();
  if (p && typeof p.refreshAccounts === 'function') return p.refreshAccounts(ids, maxAge);
}

// 用量来源对某个号的结论（只读）：{ plan, error, at } 或 null。没配 overlay 用量来源 → null（路由只看额度桶）。
export function probedInfo(id) {
  const p = overlayUsageProbe();
  return p && typeof p.probedInfo === 'function' ? p.probedInfo(id) : null;
}

// 公开版：某个号「上次使用时」的额度（status.mjs 按号分槽的快照）；已过重置点的桶不算。
function lastUse(id) {
  const lim = accountLimits(id);
  const now = Date.now();
  const pick = (k) => {
    const b = lim[k];
    if (!b || typeof b.pct !== 'number' || (b.resetsAt && b.resetsAt <= now)) return null;
    return { status: b.status || 'allowed', pct: b.pct, resetsAt: b.resetsAt || 0, at: b.at || 0 };
  };
  const out = { five_hour: pick('five_hour'), seven_day: pick('seven_day'), fable: pick('seven_day_overage_included') };
  const plan = String(accountPlan(id) || '').toLowerCase();
  const at = Math.max(0, ...Object.values(out).map((b) => (b && b.at) || 0));
  return { ...out, plan: plan === 'max' || plan === 'pro' ? plan : null, error: null, at, source: 'last-use' };
}

// { [accountId]: { five_hour, seven_day, fable, plan:'max'|'pro'|null, error, at, source? } }
export async function poolUsage({ force = false } = {}) {
  const p = overlayUsageProbe();
  if (p && typeof p.poolUsage === 'function') return p.poolUsage({ force });
  return Object.fromEntries(listAccountsWithTokens().map((a) => [a.id, lastUse(a.id)]));
}
