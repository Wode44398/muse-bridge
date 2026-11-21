// Antigravity 号池路由与智能分派：对标 Claude 号池的三种策略（smart / fill / primary）+ 会话中无缝换号。
// agy 的模型额度分两组且正交：'gemini'（gemini-5h / gemini-weekly）与 '3p'（3p-5h / 3p-weekly，Claude & GPT）。
// 一组跑满不拖累另一组；每个请求带 requestId=agent/<acpSid>/... 和 request.sessionId，
// 因此智能分派可以按「会话 × 模型分组」各自绑号，多任务并发自动分号，快满或撞 429 时段中无缝切换。

import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import {
  listAccounts,
  activeAccountId,
  setActive,
  routerSettings,
  setRouterSettings,
  onRouterSettings,
} from './accounts.mjs';
import { accountQuotaSnapshot, markBucketExhausted, refreshAccounts } from './quota.mjs';

export { routerSettings, setRouterSettings, onRouterSettings };

const SOFT_SWITCH_PCT = 98;
const GENERIC_COOLDOWN_MS = 15 * 60_000;
const CAPACITY_COOLDOWN_MS = 2 * 60_000;
const AUTH_COOLDOWN_MS = 30 * 60_000;
const VALIDATION_COOLDOWN_MS = 30 * 60_000;
const IDLE_GAP_MS = 4 * 60_000;
const WARM_TTL_MS = 15 * 60_000;
const REFILL_SOON_MS = 30 * 60_000;
const LOG_MAX = 30;
const PROBE_BUDGET_MS = 6_000;

const TAU_5H = 1.5 * 3600_000;
const TAU_WEEKLY = 36 * 3600_000;
const W = { stickWarm: 1.0, stickCold: 0.25, urgency: 1.1, load: 0.45, weekly: 0.9, fiveH: 0.45, order: 0.02 };

let dispatchFile = path.join(DATA_ROOT, 'agy', 'pool-dispatch.json');
const cooldown = new Map();      // key: `${accountId}:${scope}` (scope = 'all' | 'gemini' | '3p') -> { until, type }
const tasks = new Map();         // key: `${sid}|${group}` -> { sid, group, acct, activeCount, lastUsed, tokens }
const innerSidMap = new Map();   // request.sessionId -> acpSid（让 checkpoint 后台请求跟主对话同号）
const sessionLabels = new Map(); // sid -> title（供分派记录展示）
const log = [];
let leaveMiss = null;
let routingLock = null;
let persistTimer = null;

function loadDispatch() {
  const raw = readJson(dispatchFile, null);
  tasks.clear();
  if (raw && Array.isArray(raw.tasks)) {
    const now = Date.now();
    for (const t of raw.tasks) {
      if (!t?.sid || !t?.group || !t?.acct) continue;
      if (now - (Number(t.lastUsed) || 0) > 6 * 3600_000) continue;
      tasks.set(`${t.sid}|${t.group}`, {
        sid: String(t.sid),
        group: String(t.group),
        acct: String(t.acct),
        activeCount: 0,
        lastUsed: Number(t.lastUsed) || now,
        tokens: Number(t.tokens) || 0,
      });
    }
  }
}
loadDispatch();

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const list = [...tasks.values()]
        .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
        .slice(0, 80)
        .map(({ sid, group, acct, lastUsed, tokens }) => ({ sid, group, acct, lastUsed, tokens }));
      writeJson(dispatchFile, { tasks: list }, 2);
    } catch {}
  }, 1_500);
  persistTimer.unref?.();
}

export function groupOfModel(model = '') {
  const m = String(model || '').toLowerCase();
  if (/(?:claude|opus|sonnet|haiku|gpt|^o[134]-)/.test(m)) return '3p';
  return 'gemini';
}

export function noteSessionLabel(sid, title) {
  if (!sid || !title) return;
  sessionLabels.delete(sid);
  sessionLabels.set(sid, String(title).slice(0, 80));
  if (sessionLabels.size > 300) sessionLabels.delete(sessionLabels.keys().next().value);
}

export function noteInnerSessionMap(innerSid, acpSid) {
  if (!innerSid || !acpSid) return;
  innerSidMap.delete(innerSid);
  innerSidMap.set(innerSid, acpSid);
  if (innerSidMap.size > 300) innerSidMap.delete(innerSidMap.keys().next().value);
}

export function resolveAcpSessionId(sid, innerSid) {
  if (sid) {
    if (innerSid) noteInnerSessionMap(innerSid, sid);
    return sid;
  }
  return innerSid ? (innerSidMap.get(innerSid) || '') : '';
}

const labelOf = (id) => {
  const a = listAccounts().find((x) => x.id === id);
  return a ? a.label : id;
};

export function routerEnabled() {
  return !!routerSettings().enabled && listAccounts().length >= 2;
}

export function smartActive() {
  const s = routerSettings();
  return !!s.enabled && s.strategy === 'smart' && listAccounts().length >= 2;
}

export function seamlessActive() {
  const s = routerSettings();
  return !!s.enabled && !!s.seamless && listAccounts().length >= 2;
}

function getCooldown(accountId, group, now = Date.now()) {
  let worst = null;
  for (const scope of ['all', group]) {
    const k = `${accountId}:${scope}`;
    const cd = cooldown.get(k);
    if (!cd) continue;
    if (cd.until <= now) { cooldown.delete(k); continue; }
    if (!worst || cd.until > worst.until) worst = cd;
  }
  return worst;
}

export function clearCooldown(accountId) {
  if (!accountId) return;
  for (const k of [...cooldown.keys()]) {
    if (k.startsWith(accountId + ':')) cooldown.delete(k);
  }
}

function groupBucketsOf(accountId, group, now = Date.now()) {
  const q = accountQuotaSnapshot(accountId);
  if (!q) return { fiveH: null, weekly: null, error: null };
  const fiveH = group === '3p' ? q.tp_5h : q.gemini_5h;
  const weekly = group === '3p' ? q.tp_weekly : q.gemini_weekly;
  const norm = (b) => {
    if (!b || typeof b.usedPct !== 'number') return null;
    if (b.resetAt && b.resetAt <= now) return { ...b, usedPct: 0, resetAt: null };
    return b;
  };
  return { fiveH: norm(fiveH), weekly: norm(weekly), error: q.error || null };
}

export function accountBlock(accountId, model, { soft = seamlessActive(), now = Date.now() } = {}) {
  const group = groupOfModel(model);
  const full = soft ? SOFT_SWITCH_PCT : 100;
  let until = 0;
  let type = '';

  const cd = getCooldown(accountId, group, now);
  if (cd && cd.until > until) {
    until = cd.until;
    type = cd.type;
  }

  const { fiveH, weekly } = groupBucketsOf(accountId, group, now);
  const b5Name = group === '3p' ? 'tp_5h' : 'gemini_5h';
  const bwName = group === '3p' ? 'tp_weekly' : 'gemini_weekly';
  for (const [name, b] of [[b5Name, fiveH], [bwName, weekly]]) {
    if (!b || typeof b.usedPct !== 'number') continue;
    if (b.usedPct < full) continue;
    const end = b.resetAt && b.resetAt > now ? b.resetAt : now + (name.endsWith('5h') ? 5 * 3600_000 : 24 * 3600_000);
    if (end > until) {
      until = end;
      type = name;
    }
  }
  return until > now ? { until, type } : null;
}

function loadScore(accountId, model, now = Date.now()) {
  const group = groupOfModel(model);
  const { fiveH, weekly } = groupBucketsOf(accountId, group, now);
  const vals = [fiveH?.usedPct, weekly?.usedPct].filter((v) => typeof v === 'number');
  return vals.length ? Math.max(...vals) : 50;
}

function pickUsable(model, { exclude = '', priority = false, fallback = false, now = Date.now() } = {}) {
  const all = listAccounts().map((a, i) => ({ id: a.id, i })).filter((a) => a.id !== exclude);
  let usable = all.filter((a) => !accountBlock(a.id, model, { soft: seamlessActive(), now }));
  if (!usable.length && fallback && seamlessActive()) {
    usable = all.filter((a) => !accountBlock(a.id, model, { soft: false, now }));
  }
  if (!usable.length) return null;
  if (!priority) {
    usable.sort((x, y) => loadScore(x.id, model, now) - loadScore(y.id, model, now) || x.i - y.i);
  }
  return usable[0].id;
}

function pushLog(entry) {
  log.unshift(entry);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
}

function doGlobalSwitch(from, to, reason, model) {
  const r = setActive(to);
  if (r?.error) return null;
  const entry = {
    at: Date.now(),
    from,
    to,
    fromLabel: labelOf(from),
    toLabel: labelOf(to),
    reason,
    model: model || '',
    group: groupOfModel(model),
  };
  pushLog(entry);
  console.log(`[agy-pool] ${entry.fromLabel} → ${entry.toLabel} (${reason})`);
  return entry;
}

function activeTasksOn(accountId, exceptKey = '') {
  let n = 0;
  for (const [k, t] of tasks.entries()) {
    if (k !== exceptKey && t.acct === accountId && t.activeCount > 0) n += 1;
  }
  return n;
}

// 纯打分：挑智能分派最合适的号。
export function rankAccountsForGroup({ accounts, group, current = '', warm = false, exceptKey = '', now = Date.now(), exclude = '' }) {
  const candidates = accounts.filter((a) => a.id !== exclude);
  let pool = candidates.filter((a) => !accountBlock(a.id, group === '3p' ? 'claude' : 'gemini', { soft: seamlessActive(), now }));
  let fallback = false;
  if (!pool.length) {
    pool = candidates.filter((a) => !accountBlock(a.id, group === '3p' ? 'claude' : 'gemini', { soft: false, now }));
    fallback = true;
  }
  if (!pool.length) return [];

  const rows = pool.map((a, idx) => {
    const { fiveH, weekly } = groupBucketsOf(a.id, group, now);
    const wPct = weekly ? weekly.usedPct : 30;
    const hPct = fiveH ? fiveH.usedPct : 10;
    const weeklyLeft = Math.max(0, 100 - wPct) / 100;
    const fiveHLeft = Math.max(0, 100 - hPct) / 100;

    let urg = 0;
    if (fiveH?.resetAt && fiveH.resetAt > now && fiveH.resetAt - now > REFILL_SOON_MS) {
      urg = Math.max(urg, fiveHLeft * Math.exp(-(fiveH.resetAt - now) / TAU_5H));
    }
    if (weekly?.resetAt && weekly.resetAt > now && weekly.resetAt - now > REFILL_SOON_MS) {
      urg = Math.max(urg, weeklyLeft * Math.exp(-(weekly.resetAt - now) / TAU_WEEKLY));
    }

    const parts = {};
    if (a.id === current) parts.stick = warm ? W.stickWarm : W.stickCold;
    if (urg > 0) parts.urgency = W.urgency * urg;
    const load = activeTasksOn(a.id, exceptKey);
    if (load > 0) parts.load = -W.load * load;
    parts.weekly = W.weekly * weeklyLeft;
    parts.fiveH = W.fiveH * fiveHLeft;
    parts.order = -W.order * idx;

    const score = Object.values(parts).reduce((s, v) => s + v, 0);
    return { id: a.id, score, parts, fallback };
  });

  rows.sort((x, y) => y.score - x.score);
  return rows;
}

function smartReason(rows, current) {
  if (rows.length === 1) return rows[0].fallback ? 'fallback' : 'only';
  const top = rows[0];
  if (top.fallback) return 'fallback';
  const cmp = (current && rows.find((r) => r.id === current)) || rows[1];
  if (!cmp || cmp.id === top.id) return 'room';
  const diff = (k) => (top.parts[k] || 0) - (cmp.parts[k] || 0);
  const factors = [
    ['spread', diff('load')],
    ['expiring', diff('urgency')],
    ['room', diff('weekly') + diff('fiveH')],
  ].sort((a, b) => b[1] - a[1]);
  return factors[0][1] > 0.05 ? factors[0][0] : 'room';
}

function getOrCreateTask(sid, group, now = Date.now()) {
  const key = `${sid}|${group}`;
  let t = tasks.get(key);
  if (!t) {
    t = { sid, group, acct: '', activeCount: 0, lastUsed: now, tokens: 0 };
    tasks.set(key, t);
  }
  return { key, task: t };
}

export function dispatchBegin(task) {
  if (!task) return;
  task.activeCount = (task.activeCount || 0) + 1;
  task.lastUsed = Date.now();
}

export function dispatchEnd(task, usageTokens = 0) {
  if (!task) return;
  task.activeCount = Math.max(0, (task.activeCount || 1) - 1);
  task.lastUsed = Date.now();
  if (usageTokens > 0) task.tokens = (task.tokens || 0) + usageTokens;
  schedulePersist();
}

export function boundAccountForSession(sid, model = '') {
  if (!sid) return '';
  const accounts = listAccounts();
  const exists = (id) => !!id && accounts.some((a) => a.id === id);
  if (model) {
    const t = tasks.get(`${sid}|${groupOfModel(model)}`);
    if (t && exists(t.acct)) return t.acct;
  }
  // 没给模型时优先返回该会话最近活跃的那个绑定号
  let latest = null;
  for (const t of tasks.values()) {
    if (t.sid === sid && exists(t.acct) && (!latest || t.lastUsed > latest.lastUsed)) latest = t;
  }
  return latest ? latest.acct : '';
}

async function verifyCandidates(ids) {
  if (!ids.length) return;
  await Promise.race([
    refreshAccounts(ids, { maxAgeMs: 120_000 }).catch(() => {}),
    new Promise((r) => setTimeout(r, PROBE_BUDGET_MS)),
  ]);
}

// 为一次上游模型请求选号（由 upstream.mjs 在每次 streamGenerateContent / generateContent / countTokens 前调用）。
export async function pickForRequest({
  sid = '',
  innerSid = '',
  model = '',
  requestType = 'agent',
  hasContinuation = false,
  isPrimaryTurnStart = false,
  now = Date.now(),
} = {}) {
  const accounts = listAccounts();
  const curActive = activeAccountId();
  if (!routerEnabled() || accounts.length < 2) {
    return { accountId: curActive, task: null, entry: null };
  }

  const group = groupOfModel(model);
  const resolvedSid = resolveAcpSessionId(sid, innerSid);
  const isBackground = requestType === 'checkpoint';

  // ── 策略 1：smart（智能分派）────────────────────────────────────────────────
  if (smartActive()) {
    // 后台小请求（checkpoint 标题生成等）直接跟随对应会话的主线程号，不单独立项也不刷日志。
    if (isBackground || !resolvedSid) {
      const bound = boundAccountForSession(resolvedSid, model) || curActive;
      const blk = accountBlock(bound, model, { soft: false, now });
      if (!blk) return { accountId: bound, task: null, entry: null };
      const alt = pickUsable(model, { exclude: bound, fallback: true, now });
      return { accountId: alt || bound, task: null, entry: null };
    }

    const { key, task } = getOrCreateTask(resolvedSid, group, now);
    const exists = (id) => !!id && accounts.some((a) => a.id === id);
    const cur = exists(task.acct) ? task.acct : '';
    const running = task.activeCount > 0 || (now - (task.lastUsed || 0) < IDLE_GAP_MS);
    const warm = !!cur && (now - (task.lastUsed || 0) < WARM_TTL_MS);

    // 续传腿（continuation_token）绝不主动软换号，避免破坏服务端续传上下文。
    if (cur && hasContinuation) {
      return { accountId: cur, task, entry: null };
    }

    if (cur && running) {
      const hard = accountBlock(cur, model, { soft: false, now });
      const soft = !hard && seamlessActive() && accountBlock(cur, model, { soft: true, now });
      if (!hard && !soft) return { accountId: cur, task, entry: null };
      if (!seamlessActive()) return { accountId: cur, task, entry: null };

      await verifyCandidates(accounts.map((a) => a.id).filter((id) => id !== cur));
      const rows = rankAccountsForGroup({ accounts, group, current: cur, warm, exceptKey: key, now, exclude: cur });
      if (!rows.length) return { accountId: cur, task, entry: null };
      const best = rows[0].id;
      task.acct = best;
      schedulePersist();
      const reason = hard ? (hard.type || 'limit') : 'near:' + (soft.type || 'limit');
      const entry = {
        at: now, kind: 'move', sid: resolvedSid, label: sessionLabels.get(resolvedSid) || '',
        group, from: cur, to: best, fromLabel: labelOf(cur), toLabel: labelOf(best), reason, model,
      };
      pushLog(entry);
      console.log(`[agy-pool] move ${resolvedSid.slice(0, 8)} ${group} ${entry.fromLabel} → ${entry.toLabel} (${reason})`);
      return { accountId: best, task, entry };
    }

    const rows = rankAccountsForGroup({ accounts, group, current: cur, warm, exceptKey: key, now });
    if (!rows.length) return { accountId: cur || curActive, task, entry: null };
    const best = rows[0].id;
    if (best === cur) return { accountId: cur, task, entry: null };
    const cb = cur ? accountBlock(cur, model, { soft: seamlessActive(), now }) : null;
    const hb = cb ? accountBlock(cur, model, { soft: false, now }) : null;
    const kind = !cur ? 'place' : cb ? 'move' : 'rebalance';
    const reason = cb ? (hb ? hb.type || 'limit' : 'near:' + (cb.type || 'limit')) : smartReason(rows, cur);
    task.acct = best;
    schedulePersist();
    const entry = {
      at: now, kind, sid: resolvedSid, label: sessionLabels.get(resolvedSid) || '',
      group, from: cur || '', to: best, fromLabel: cur ? labelOf(cur) : '', toLabel: labelOf(best), reason, model,
    };
    pushLog(entry);
    console.log(`[agy-pool] ${kind} ${resolvedSid.slice(0, 8)} ${group} ${cur ? entry.fromLabel + ' → ' : '→ '}${entry.toLabel} (${reason})`);
    return { accountId: best, task, entry: kind === 'place' ? null : entry };
  }

  // ── 策略 2 / 3：fill（用满再换）与 primary（回到首选号）────────────────────
  if (hasContinuation) return { accountId: curActive, task: null, entry: null };
  while (routingLock) { try { await routingLock; } catch {} }

  const cur = activeAccountId();
  const s = routerSettings();
  const block = accountBlock(cur, model, { soft: seamlessActive(), now });

  if (s.strategy === 'primary' && isPrimaryTurnStart) {
    const idx = accounts.findIndex((a) => a.id === cur);
    const ahead = accounts.slice(0, Math.max(0, idx)).map((a) => a.id).filter((id) => !accountBlock(id, model, { soft: seamlessActive(), now }));
    if (ahead.length || block) {
      routingLock = (async () => {
        await verifyCandidates(block ? accounts.map((a) => a.id).filter((id) => id !== cur) : ahead);
        const hard = !!accountBlock(cur, model, { soft: false, now });
        const best = pickUsable(model, { priority: true, fallback: hard, now });
        if (best && best !== cur) {
          const reason = block ? (hard ? (block.type || 'limit') : 'near:' + (block.type || 'limit')) : 'primary_back';
          return doGlobalSwitch(cur, best, reason, model);
        }
        return null;
      })().finally(() => { routingLock = null; });
      const sw = await routingLock;
      return { accountId: activeAccountId(), task: null, entry: sw };
    }
    return { accountId: cur, task: null, entry: null };
  }

  if (!block || !seamlessActive()) return { accountId: cur, task: null, entry: null };
  if (leaveMiss && leaveMiss.cur === cur && leaveMiss.group === group && now - leaveMiss.at < 60_000) {
    return { accountId: cur, task: null, entry: null };
  }

  routingLock = (async () => {
    await verifyCandidates(accounts.map((a) => a.id).filter((id) => id !== cur));
    const hard = accountBlock(cur, model, { soft: false, now });
    const best = pickUsable(model, { exclude: cur, priority: s.strategy === 'primary', fallback: !!hard, now });
    const reason = hard ? (hard.type || 'limit') : 'near:' + (block.type || 'limit');
    const sw = best ? doGlobalSwitch(cur, best, reason, model) : null;
    leaveMiss = sw ? null : { cur, group, at: now };
    return sw;
  })().finally(() => { routingLock = null; });

  const sw = await routingLock;
  return { accountId: activeAccountId(), task: null, entry: sw };
}

// 上游撞墙（429 / 401 / 403 VALIDATION_REQUIRED）后记冷却并挑选替代号。
export async function noteLimitHit(accountId, {
  kind = 'rate_limit',   // 'rate_limit' | 'capacity' | 'auth' | 'validation'
  model = '',
  resetAt = 0,
  sid = '',
  type = '',
} = {}) {
  if (!accountId) return null;
  const now = Date.now();
  const group = groupOfModel(model);
  const scope = (kind === 'auth' || kind === 'validation') ? 'all' : group;
  const fallbackMs = kind === 'auth' ? AUTH_COOLDOWN_MS
    : kind === 'validation' ? VALIDATION_COOLDOWN_MS
    : kind === 'capacity' ? CAPACITY_COOLDOWN_MS
    : GENERIC_COOLDOWN_MS;
  const until = (kind === 'rate_limit' && resetAt && resetAt > now) ? resetAt : (now + fallbackMs);
  const reason = type || (kind === 'auth' ? 'auth' : kind === 'validation' ? 'validation' : kind === 'capacity' ? 'capacity' : (group === '3p' ? 'tp_5h' : 'gemini_5h'));

  const cdKey = `${accountId}:${scope}`;
  const prev = cooldown.get(cdKey);
  if (!prev || prev.until < until) {
    cooldown.set(cdKey, { until, type: reason });
  }
  if (kind === 'rate_limit') {
    markBucketExhausted(accountId, group, resetAt);
  }

  if (!routerEnabled()) return null;
  const accounts = listAccounts();
  if (accounts.length < 2) return null;

  if (smartActive()) {
    if (!sid) return null;
    await verifyCandidates(accounts.map((a) => a.id).filter((id) => id !== accountId));
    const { key, task } = getOrCreateTask(sid, group, now);
    const rows = rankAccountsForGroup({ accounts, group, current: '', warm: false, exceptKey: key, now, exclude: accountId });
    if (!rows.length) return null;
    const best = rows[0].id;
    task.acct = best;
    schedulePersist();
    const entry = {
      at: now, kind: 'move', sid, label: sessionLabels.get(sid) || '',
      group, from: accountId, to: best, fromLabel: labelOf(accountId), toLabel: labelOf(best), reason, model,
    };
    pushLog(entry);
    console.log(`[agy-pool] hit(${kind}) ${sid.slice(0, 8)} ${group} ${entry.fromLabel} → ${entry.toLabel} (${reason})`);
    return entry;
  }

  const cur = activeAccountId();
  if (cur !== accountId) {
    return accountBlock(cur, model, { soft: false, now })
      ? null
      : { at: now, from: accountId, to: cur, fromLabel: labelOf(accountId), toLabel: labelOf(cur), reason, model, group, already: true };
  }

  leaveMiss = null;
  await verifyCandidates(accounts.map((a) => a.id).filter((id) => id !== accountId));
  const best = pickUsable(model, { exclude: accountId, priority: routerSettings().strategy === 'primary', fallback: true, now });
  return best ? doGlobalSwitch(accountId, best, reason, model) : null;
}

export function routerStatus() {
  const now = Date.now();
  const blocks = {};
  for (const a of listAccounts()) {
    const gBlk = accountBlock(a.id, 'gemini', { soft: false, now });
    const tBlk = accountBlock(a.id, 'claude', { soft: false, now });
    if (gBlk || tBlk) blocks[a.id] = { gemini: gBlk, tp: tBlk };
  }
  const perAcct = {};
  const running = [];
  for (const t of tasks.values()) {
    if (t.activeCount > 0) {
      perAcct[t.acct] = perAcct[t.acct] || { tasks: 0 };
      perAcct[t.acct].tasks += 1;
      running.push({
        sid: t.sid,
        label: sessionLabels.get(t.sid) || '',
        group: t.group,
        acct: t.acct,
        acctLabel: labelOf(t.acct),
      });
    }
  }
  return {
    settings: routerSettings(),
    blocks,
    log: log.slice(0, LOG_MAX),
    dispatch: { accounts: perAcct, running },
  };
}

export function _setDispatchFileForTest(p) {
  dispatchFile = p || path.join(DATA_ROOT, 'agy', 'pool-dispatch.json');
  loadDispatch();
}

export function _resetRouterForTest() {
  clearTimeout(persistTimer);
  persistTimer = null;
  cooldown.clear();
  tasks.clear();
  innerSidMap.clear();
  sessionLabels.clear();
  log.length = 0;
  leaveMiss = null;
  routingLock = null;
}
