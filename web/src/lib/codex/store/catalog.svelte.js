// 模型、号池、额度、设置：选择器、托盘、上下文环、额度卡读这里。
//   模型：GET /api/codex/models → { accounts, merged:[号池模型], hub:[模型中心按服务] }
//   号池：GET /api/codex/pool（成员只有共享给他的号）；变化经总线 codex.pool 推来（只推管理员）
//   额度：GET /api/codex/usage?account= → { available, buckets:[{ id, name, windows:[{ id, usedPercent, durationMins, resetsAt }] }] }
//   设置：GET /api/codex/settings → effective（这个身份的默认审批 / 沙盒档与允许的范围）

import { me, caps } from '../../state.svelte.js';
import { codexCapabilities } from '../../caps.js';
import { tr } from '../../i18n.js';
import { codexApi } from '../api.js';
import { codex } from './state.svelte.js';

const SEL_KEY = 'bridge-codex-selection';

// 强度档一律用官方英文原名（桌面版 composer.mode.local.reasoning.*.label），中文界面也不译
export const EFFORT_LABEL = { none: 'None', minimal: 'Minimal', low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' };
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const effortLabel = (e) => EFFORT_LABEL[e] || (e ? e[0].toUpperCase() + e.slice(1) : '');

const sortEfforts = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));

/**
 * 选择器的分组：
 *   { key:'pool', name:'ChatGPT 账号', items:[…] }，然后模型中心每个服务一组 { key, name, logo, hub:true, items }
 * 条目：{ id, name, desc, efforts, defEffort, fast, ctx, accounts, isDefault, hub, service }
 */
export function modelGroups() {
  const m = codex.models;
  const groups = [];
  const merged = Array.isArray(m?.merged) ? m.merged.filter((x) => x?.id && !x.hidden) : [];
  const own = merged.map((x) => ({
    id: x.id, name: x.displayName || x.id, desc: x.description || '',
    efforts: sortEfforts((x.supportedReasoningEfforts || []).map((e) => e.effort)),
    defEffort: x.defaultReasoningEffort || '',
    fast: (x.serviceTiers || []).some((s) => s.id === 'priority'),
    ctx: x.contextWindow || null,
    accounts: Array.isArray(x.accounts) ? x.accounts : [],
    isDefault: !!x.isDefault, hub: false, service: '',
  })).filter((x) => x.efforts.length);
  if (own.length) groups.push({ key: 'pool', name: 'ChatGPT', items: own });
  else if (!m) {
    // 还没拉到目录（或拉失败）：用静态能力表兜底，至少能发
    const base = codexCapabilities(caps.data);
    const items = (base?.models || []).map((x) => ({
      id: x.id, name: x.name || x.id, desc: x.description || '', efforts: sortEfforts(x.efforts || []), defEffort: '',
      fast: (x.serviceTiers || []).includes('priority'), ctx: null, accounts: [], isDefault: x.id === base?.defaults?.model, hub: false, service: '',
    }));
    if (items.length) groups.push({ key: 'pool', name: 'ChatGPT', items });
  }
  for (const s of Array.isArray(m?.hub) ? m.hub : []) {
    const items = (s.models || []).map((x) => ({
      id: x.id, name: x.label || x.model, desc: '',
      efforts: sortEfforts(Array.isArray(x.efforts) && x.efforts.length ? x.efforts.map((e) => (typeof e === 'string' ? e : e?.id || e?.value)) : ['medium']),
      defEffort: '', fast: false, ctx: x.contextWindow || null, ctxGuess: !!x.contextGuess,
      accounts: [], isDefault: !!x.isDefault, hub: true, service: s.service, shared: !!s.shared,
    }));
    // 每组默认模型排第一
    items.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    if (items.length) groups.push({ key: 'hub:' + s.service, name: tr(s.name) || s.service, logo: s.logo || '', hub: true, shared: !!s.shared, items });
  }
  return groups;
}

export function findModel(id) {
  for (const g of modelGroups()) for (const x of g.items) if (x.id === id) return { ...x, group: g };
  return null;
}

/** 强度夹到模型支持的档：不支持就用模型自己的默认，再不行取最接近的那档。 */
export function clampEffort(model, effort) {
  const list = model?.efforts || [];
  if (!list.length) return effort || 'medium';
  if (list.includes(effort)) return effort;
  if (model.defEffort && list.includes(model.defEffort)) return model.defEffort;
  const want = EFFORT_ORDER.indexOf(effort || 'medium');
  return [...list].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - want) - Math.abs(EFFORT_ORDER.indexOf(b) - want))[0];
}

function saveSelection() {
  try { localStorage.setItem(SEL_KEY, JSON.stringify({ model: codex.model, effort: codex.effort, fast: codex.fast })); } catch {}
}

/** 选模型 / 强度 / Fast（选择器里点的）。会记住，下次新线程默认用它。 */
export function selectModel({ model, effort, fast } = {}) {
  if (model !== undefined) codex.model = model;
  const m = findModel(codex.model);
  if (effort !== undefined) codex.effort = effort;
  codex.effort = clampEffort(m, codex.effort);
  if (fast !== undefined) codex.fast = !!fast;
  if (!m?.fast) codex.fast = false;
  saveSelection();
}

/** 目录到了 / 换了：没选过就用上次的，上次的不在目录里就用目录默认。 */
export function settleSelection() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SEL_KEY) || '{}'); } catch {}
  const groups = modelGroups();
  const all = groups.flatMap((g) => g.items);
  if (!all.length) return;
  const pick = (id) => all.find((x) => x.id === id);
  let m = pick(codex.model) || pick(saved.model) || all.find((x) => x.isDefault && !x.hub) || all[0];
  codex.model = m.id;
  codex.effort = clampEffort(m, codex.effort || saved.effort || m.defEffort);
  codex.fast = m.fast ? (codex.fast || !!saved.fast) : false;
}

/** 打开旧线程：选择器回到这条线程上一轮实际用的（session.last）。 */
export function restoreFromLast(last) {
  if (!last?.model) return;
  const m = findModel(last.model);
  if (!m) return;
  codex.model = m.id;
  codex.effort = clampEffort(m, last.effort || codex.effort);
  codex.fast = m.fast && last.serviceTier === 'priority';
}

export async function loadModels() {
  try { codex.models = await codexApi.models(); } catch { /* 留着上一份；没有就用兜底表 */ }
  settleSelection();
}

/* ---------------- 权限档 ---------------- */

// 三档写成人话；对应发送参数 codexApproval + codexSandbox，服务端照旧夹到这个身份允许的范围
export const PERMS = {
  ask: { approval: 'untrusted', sandbox: 'read-only' },
  auto: { approval: 'on-request', sandbox: 'workspace-write' },
  full: { approval: 'never', sandbox: 'danger-full-access' },
};

/** 这个身份能选哪几档（设置里管理员给成员限定过范围）。 */
export function allowedPerms() {
  const eff = codex.settings;
  if (!eff) return ['ask', 'auto'];
  const aps = eff.approvals || [], sbs = eff.sandboxes || [];
  return Object.entries(PERMS).filter(([, v]) => (!aps.length || aps.includes(v.approval)) && (!sbs.length || sbs.includes(v.sandbox))).map(([k]) => k);
}

/** 没手动选过时，从设置里的默认档推出来。 */
export function defaultPerm() {
  const eff = codex.settings;
  if (!eff) return 'auto';
  if (eff.sandbox === 'danger-full-access' && eff.approvalPolicy === 'never') return 'full';
  if (eff.sandbox === 'read-only' || eff.approvalPolicy === 'untrusted') return 'ask';
  return 'auto';
}

export const permOf = () => codex.perm || defaultPerm();

export async function loadSettings() {
  try { codex.settings = (await codexApi.settings())?.effective || null; } catch {}
}

/* ---------------- 号池与额度 ---------------- */

export async function loadPool() {
  try { codex.pool = await codexApi.pool(); } catch { codex.pool = null; }
}

export function activeAccount() {
  const list = Array.isArray(codex.pool?.accounts) ? codex.pool.accounts : [];
  const id = codex.pool?.activeId || list[0]?.id || '';
  return list.find((a) => a.id === id) || null;
}

let usageBusy = false;
/** 拉某个号的额度（不给 = 正在看的线程所属的号，再不然是当前号）。 */
export async function loadUsage(account) {
  if (usageBusy) return;
  usageBusy = true;
  const id = account ?? (codex.threads[codex.sessionId]?.accountId || codex.pool?.activeId || '');
  try {
    codex.usage = await codexApi.usage(id);
    codex.usageAccount = codex.usage?.accountId || id;
  } catch {
    codex.usage = { available: false, buckets: [], stale: true };
  } finally { usageBusy = false; }
}

export async function switchAccount(id) {
  await codexApi.poolActive(id);
  await loadPool();
  await loadUsage(id);
}

export const isAdmin = () => me.kind === 'admin';
