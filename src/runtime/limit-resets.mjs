// 订阅号的「重置卡」：Anthropic 偶尔发给订阅号的限额重置（官方在 claude.ai 设置 › 用量 › Resets 里用）。
// 设置 › Claude › 订阅号池里逐号查看、使用。
//
// 公开版不带实现（开源路线 2.3：公开仓不放拿订阅令牌直连 Anthropic 接口的代码）：由 overlay 钩子
// claudeLimitResets(core) 提供（接口见 runtime/overlay-hooks.mjs 文件头与下面的 core）。没配这个钩子时
// resetsOverview 回 available:false，界面不出现重置卡入口。
//
// 钩子实例要给的东西：
//   overview({ force, only }) → { [accountId]: { login:{ email, source }|null, needLogin, error, at,
//                                 eligible?, atLimit?, exhausted?, cooldownUntil?, weeklyResetsAt?,
//                                 grants?:[{ id, label, total, left, startsAt, endsAt, clears:[桶], paused, usable,
//                                            requiresLimit, percentUsed:{桶:0-100}, givesBackWeekly, unavailable }] } }
//   use(id, grantId)          → { ok, cleared:[桶], left, percentUsed, status } | { error, status? }
//   loginStart(id)            → { ok, url } | { error }      完整登录（读账号级信息要 user:profile，setup-token 没有）
//   loginFinish(id, code)     → { ok, email } | { error }
//   loginClear(id)            → { ok } | { error }

import { overlayHook } from './overlay-hooks.mjs';
import { listAccountsWithTokens, accountLogin, setAccountLogin } from './claude-account.mjs';
import { loginCredential, refreshAccounts } from './account-usage.mjs';
import { applyProbedLimits } from './status.mjs';
import { clearCooldown } from './account-router.mjs';
import { sdkInfo } from './claude-cli.mjs';

let inst;
function impl() {
  if (inst !== undefined) return inst;
  const make = overlayHook('claudeLimitResets');
  inst = null;
  if (typeof make === 'function') {
    // cliVersion：随 SDK 带的 Claude Code 版本号（钩子据此标明自己是哪一版客户端）
    const cliVersion = () => { const s = sdkInfo(); return (s && s.cliVersion) || ''; };
    try { inst = make({ listAccountsWithTokens, accountLogin, setAccountLogin, localLogin: loginCredential, cliVersion }) || null; }
    catch (e) { console.error('[limit-resets] overlay 重置卡来源初始化失败：', (e && e.message) || e); inst = null; }
  }
  return inst;
}

export function resetsAvailable() { return !!impl(); }

const NONE = { error: '这个版本不支持重置卡' };

export async function resetsOverview({ force = false, only = '' } = {}) {
  const p = impl();
  if (!p) return { available: false, accounts: {} };
  try { return { available: true, accounts: (await p.overview({ force, only })) || {} }; }
  catch (e) { return { available: true, accounts: {}, error: '读取重置卡失败：' + ((e && e.message) || e) }; }
}

// 用掉一张重置卡。成功后把这个号被清掉的额度桶按新读数记回按号分槽（额度环、号池用量、智能路由都读它），
// 撤掉路由给它记的冷却，再让用量来源核实一遍（没配就算了）。
export async function useReset(id, grantId) {
  const p = impl();
  if (!p) return NONE;
  let r;
  try { r = await p.use(String(id || ''), String(grantId || '')); }
  catch (e) { return { error: '使用重置卡失败：' + ((e && e.message) || e) }; }
  if (r && r.ok) {
    const fresh = {};
    for (const k of Array.isArray(r.cleared) ? r.cleared : []) {
      const pct = r.percentUsed && typeof r.percentUsed[k] === 'number' ? r.percentUsed[k] : 0;
      fresh[k] = { status: 'allowed', pct };
    }
    if (Object.keys(fresh).length) applyProbedLimits(fresh, id);
    clearCooldown(id);
    refreshAccounts([id], 0).catch(() => {});
  }
  return r || { error: '使用重置卡失败' };
}

export async function resetsLoginStart(id) { const p = impl(); return p ? p.loginStart(String(id || '')) : NONE; }
export async function resetsLoginFinish(id, code) { const p = impl(); return p ? p.loginFinish(String(id || ''), String(code || '')) : NONE; }
export async function resetsLoginClear(id) { const p = impl(); return p ? p.loginClear(String(id || '')) : NONE; }
