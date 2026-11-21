// Antigravity 订阅号池注册表与路由设置持久化。
// 数据落在数据根 agy/accounts.json，与核心 config.json 解耦，测试实例换 DATA_ROOT 天然隔离。
// 首次启动自动播种一个 source:'local' 的「默认账号」（无 refreshToken，沿用本机 agy 系统钥匙串登录态），
// 保证未添加多号时行为与原先完全一致。

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';

export const MANUAL_PLANS = Object.freeze(['free', 'pro', 'ultra']);
export const STRATEGIES = Object.freeze(['smart', 'fill', 'primary']);

const DEFAULT_ROUTER = Object.freeze({ enabled: false, strategy: 'smart', seamless: true });

let storeFile = path.join(DATA_ROOT, 'agy', 'accounts.json');
let accounts = [];
let activeId = '';
let routerCfg = { ...DEFAULT_ROUTER };
const routerListeners = new Set();

function newId() {
  return 'ag-' + randomBytes(4).toString('hex');
}

export function normPlan(p) {
  const v = String(p || '').trim().toLowerCase();
  return MANUAL_PLANS.includes(v) ? v : '';
}

export function tierToPlan(tierId = '', tierName = '') {
  const s = `${tierId || ''} ${tierName || ''}`.toLowerCase();
  if (!s.trim()) return '';
  if (s.includes('ultra')) return 'ultra';
  if (s.includes('pro') || s.includes('enterprise') || s.includes('standard-paid')) return 'pro';
  if (s.includes('free') || s.includes('legacy') || s.includes('standard')) return 'free';
  return '';
}

export function effectivePlan(acct) {
  if (!acct) return '';
  return normPlan(acct.plan) || tierToPlan(acct.tierId, acct.tierName);
}

const PLAN_RANK = { ultra: 3, pro: 2, free: 1, '': 0 };

function cleanAccount(raw) {
  const token = String(raw?.refreshToken || '').trim();
  const source = raw?.source === 'oauth' || token ? 'oauth' : 'local';
  return {
    id: String(raw?.id || newId()),
    label: String(raw?.label || '').trim() || '默认账号',
    source,
    email: String(raw?.email || '').trim(),
    plan: normPlan(raw?.plan),
    tierId: String(raw?.tierId || '').trim(),
    tierName: String(raw?.tierName || '').trim(),
    project: String(raw?.project || '').trim(),
    refreshToken: token,
    addedAt: Number(raw?.addedAt) || Date.now(),
  };
}

function persist() {
  try {
    writeJson(storeFile, {
      accounts,
      activeId,
      router: routerCfg,
    }, 2);
  } catch (err) {
    console.error('[agy-pool] 保存账号池失败：', err?.message || err);
  }
}

function loadFromDisk() {
  const raw = readJson(storeFile, null);
  if (raw && Array.isArray(raw.accounts) && raw.accounts.length > 0) {
    accounts = raw.accounts.filter((a) => a && typeof a === 'object').map(cleanAccount);
    activeId = raw.activeId && accounts.some((a) => a.id === raw.activeId)
      ? raw.activeId
      : accounts[0].id;
  } else {
    accounts = [cleanAccount({ id: newId(), label: '默认账号', source: 'local' })];
    activeId = accounts[0].id;
    persist();
  }
  const r = raw?.router;
  if (r && typeof r === 'object') {
    routerCfg = {
      enabled: !!r.enabled,
      strategy: STRATEGIES.includes(r.strategy) ? r.strategy : DEFAULT_ROUTER.strategy,
      seamless: typeof r.seamless === 'boolean' ? r.seamless : DEFAULT_ROUTER.seamless,
    };
  } else {
    routerCfg = { ...DEFAULT_ROUTER };
  }
}
loadFromDisk();

function safeView(a) {
  const autoPlan = tierToPlan(a.tierId, a.tierName);
  return {
    id: a.id,
    label: a.label,
    active: a.id === activeId,
    source: a.source,
    hasToken: !!a.refreshToken,
    tokenTail: a.refreshToken ? a.refreshToken.slice(-6) : '',
    email: a.email,
    plan: a.plan,
    autoPlan,
    effectivePlan: a.plan || autoPlan,
    tierId: a.tierId,
    tierName: a.tierName,
    hasProject: !!a.project,
    addedAt: a.addedAt,
  };
}

export function listAccounts() {
  return accounts.map(safeView);
}

export function listAccountsInternal() {
  return accounts.map((a) => ({ ...a }));
}

export function getAccountInternal(id) {
  const a = accounts.find((x) => x.id === id);
  return a ? { ...a } : null;
}

export function getActiveAccount() {
  const a = accounts.find((x) => x.id === activeId) || accounts[0] || null;
  return a ? { ...a } : null;
}

export function activeAccountId() {
  return activeId || accounts[0]?.id || '';
}

export function localAccountId() {
  const local = accounts.find((a) => a.source === 'local' && !a.refreshToken);
  return local ? local.id : '';
}

export function hasNonLocalAccounts() {
  return accounts.some((a) => !!a.refreshToken);
}

// 供宿主拉取模型目录（fetchAvailableModels）时选档位最高的号，避免低档号把高档模型从列表里隐藏掉。
export function highestTierAccountId() {
  if (!accounts.length) return '';
  let best = accounts.find((a) => a.id === activeId) || accounts[0];
  let bestRank = PLAN_RANK[effectivePlan(best)] || 0;
  for (const a of accounts) {
    const r = PLAN_RANK[effectivePlan(a)] || 0;
    if (r > bestRank) {
      best = a;
      bestRank = r;
    }
  }
  return best.id;
}

export function setActive(id) {
  const target = String(id || '').trim();
  if (!accounts.some((a) => a.id === target)) return { error: '无此账号' };
  activeId = target;
  persist();
  return { ok: true, active: activeId };
}

export function addAccount({
  label = '',
  refreshToken = '',
  email = '',
  project = '',
  tierId = '',
  tierName = '',
  plan = '',
  autoActivateIfOnlyEmptyLocal = false,
} = {}) {
  const tok = String(refreshToken || '').trim();
  if (!tok) return { error: 'Refresh Token 不能为空' };

  const cleanEmail = String(email || '').trim();
  // 同邮箱的 OAuth 号已存在时原地更新令牌，避免重复登录造出两个同邮箱条目。
  if (cleanEmail) {
    const dup = accounts.find((a) => a.source === 'oauth' && a.email && a.email.toLowerCase() === cleanEmail.toLowerCase());
    if (dup) {
      dup.refreshToken = tok;
      if (label && String(label).trim()) dup.label = String(label).trim();
      if (project) dup.project = String(project).trim();
      if (tierId) dup.tierId = String(tierId).trim();
      if (tierName) dup.tierName = String(tierName).trim();
      if (typeof plan === 'string' && plan.trim()) dup.plan = normPlan(plan);
      persist();
      return { ok: true, id: dup.id, updated: true, account: safeView(dup) };
    }
  }

  const defaultName = cleanEmail ? cleanEmail.split('@')[0] : ('账号 ' + (accounts.length + 1));
  const entry = cleanAccount({
    id: newId(),
    label: String(label || '').trim() || defaultName,
    source: 'oauth',
    email: cleanEmail,
    project: String(project || '').trim(),
    tierId: String(tierId || '').trim(),
    tierName: String(tierName || '').trim(),
    plan: normPlan(plan),
    refreshToken: tok,
    addedAt: Date.now(),
  });
  accounts.push(entry);

  let activated = false;
  if (autoActivateIfOnlyEmptyLocal) {
    const act = accounts.find((a) => a.id === activeId);
    if (!act || (act.source === 'local' && !act.refreshToken && !act.email)) {
      activeId = entry.id;
      activated = true;
    }
  }
  persist();
  return { ok: true, id: entry.id, activated, account: safeView(entry) };
}

export function updateAccount(id, { label, refreshToken, email, project, tierId, tierName, plan } = {}) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return { error: '无此账号' };
  if (typeof label === 'string' && label.trim()) a.label = label.trim().slice(0, 60);
  if (typeof refreshToken === 'string' && refreshToken.trim()) {
    a.refreshToken = refreshToken.trim();
    a.source = 'oauth';
  }
  if (typeof email === 'string' && email.trim()) a.email = email.trim();
  if (typeof project === 'string' && project.trim()) a.project = project.trim();
  if (typeof tierId === 'string' && tierId.trim()) a.tierId = tierId.trim();
  if (typeof tierName === 'string' && tierName.trim()) a.tierName = tierName.trim();
  if (typeof plan === 'string') a.plan = normPlan(plan);
  persist();
  return { ok: true, account: safeView(a) };
}

export function noteAccountMeta(id, { email, project, tierId, tierName } = {}) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return false;
  let dirty = false;
  if (email && String(email).trim() && a.email !== String(email).trim()) {
    a.email = String(email).trim();
    dirty = true;
  }
  if (project && String(project).trim() && a.project !== String(project).trim()) {
    a.project = String(project).trim();
    dirty = true;
  }
  if (tierId && String(tierId).trim() && a.tierId !== String(tierId).trim()) {
    a.tierId = String(tierId).trim();
    dirty = true;
  }
  if (tierName && String(tierName).trim() && a.tierName !== String(tierName).trim()) {
    a.tierName = String(tierName).trim();
    dirty = true;
  }
  if (dirty) persist();
  return dirty;
}

export function moveAccount(id, delta) {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0) return { error: '无此账号' };
  const j = i + (delta < 0 ? -1 : 1);
  if (!delta || j < 0 || j >= accounts.length) return { ok: true };
  [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
  persist();
  return { ok: true };
}

export function deleteAccount(id) {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0) return { error: '无此账号' };
  if (accounts.length <= 1) return { error: '至少保留一个账号' };
  const wasActive = activeId === id;
  accounts.splice(i, 1);
  if (wasActive) activeId = accounts[0].id;
  persist();
  return { ok: true, active: activeId };
}

export function routerSettings() {
  return { ...routerCfg };
}

export function onRouterSettings(fn) {
  routerListeners.add(fn);
  return () => routerListeners.delete(fn);
}

export function setRouterSettings({ enabled, strategy, seamless } = {}) {
  if (typeof enabled === 'boolean') routerCfg.enabled = enabled;
  if (typeof strategy === 'string' && STRATEGIES.includes(strategy)) routerCfg.strategy = strategy;
  if (typeof seamless === 'boolean') routerCfg.seamless = seamless;
  persist();
  const snap = routerSettings();
  for (const fn of routerListeners) {
    try { fn(snap); } catch {}
  }
  return { ok: true, settings: snap };
}

export function _setAccountsFileForTest(filePath) {
  storeFile = filePath || path.join(DATA_ROOT, 'agy', 'accounts.json');
  loadFromDisk();
}

export function _resetAccountsForTest() {
  accounts = [cleanAccount({ id: newId(), label: '默认账号', source: 'local' })];
  activeId = accounts[0].id;
  routerCfg = { ...DEFAULT_ROUTER };
  persist();
}
