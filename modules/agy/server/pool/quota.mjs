// Antigravity 号池逐号实时额度查询与按号分槽缓存。
// 每个号直接用自己的 Google OAuth Access Token + cloudaicompanionProject 调
// POST /v1internal:retrieveUserQuotaSummary，无需为每个号拉起独立 language_server。
// 请求必须带上 agy 同款完整 User-Agent，否则上游只会回 Claude/GPT 组而遗漏 Gemini 组。

import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { plainDispatcher } from '@bridge/core/runtime/net-proxy.mjs';
import {
  listAccountsInternal,
  getAccountInternal,
  effectivePlan,
  noteAccountMeta,
} from './accounts.mjs';
import {
  CCPA_UPSTREAM,
  effectiveAgyUserAgent,
  getAccessToken,
  fetchAccountProfile,
} from './oauth.mjs';

const FORCE_GAP_MS = 30_000;
const SOFT_CACHE_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 1_500;

let cacheFile = path.join(DATA_ROOT, 'agy', 'quota-cache.json');
let byAccount = {};       // accountId -> normalized quota entry
let lastForceAllAt = 0;
const inflightByAcct = new Map();
let persistTimer = null;
let fetchOverride = null;

function doFetch(url, init = {}) {
  if (fetchOverride) return fetchOverride(url, init);
  const plain = plainDispatcher();
  return fetch(url, { ...init, ...(plain ? { dispatcher: plain } : {}) });
}

function loadCache() {
  const raw = readJson(cacheFile, null);
  byAccount = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
loadCache();

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { writeJson(cacheFile, byAccount, 2); } catch {}
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

function groupInfo(displayName = '', bucketId = '') {
  const s = String(displayName || '').trim();
  const bid = String(bucketId || '').toLowerCase();
  if (bid.startsWith('gemini') || /^gemini/i.test(s)) return { group: 'Gemini', groupKey: 'gemini' };
  if (bid.startsWith('3p') || (/claude/i.test(s) && /gpt/i.test(s))) return { group: 'Claude / GPT', groupKey: '3p' };
  const clean = s.replace(/\s+models?$/i, '') || s || 'Other';
  return { group: clean, groupKey: clean.toLowerCase() };
}

// 兼容两种返回形状：
//   1) 直接 CCPA /v1internal:retrieveUserQuotaSummary：{ groups: [...] }
//   2) 内嵌 language server 包装：{ response: { groups: [...] } }
export function normalizeQuotaSummary(resp) {
  const groups = resp?.groups || resp?.response?.groups || [];
  const buckets = [];
  for (const g of groups) {
    for (const b of g?.buckets || []) {
      const rf = b.remainingFraction == null ? 1 : Number(b.remainingFraction);
      if (!Number.isFinite(rf)) continue;
      const resetAt = b.resetTime ? Date.parse(b.resetTime) : NaN;
      const gi = groupInfo(g.displayName, b.bucketId);
      const win = String(b.window || '');
      buckets.push({
        id: String(b.bucketId || `${gi.groupKey}-${win}`),
        group: gi.group,
        groupKey: gi.groupKey,
        window: win,
        usedPct: Math.round(Math.max(0, Math.min(1, 1 - rf)) * 1000) / 10,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
      });
    }
  }
  return buckets;
}

function pickBucket(buckets, groupKey, win) {
  const b = buckets.find((x) => x.groupKey === groupKey && x.window === win);
  if (!b) return null;
  // 已过重置点的旧读数按清零算，防止历史满额数据滞留误导路由与界面。
  if (b.resetAt && b.resetAt <= Date.now()) {
    return { id: b.id, group: b.group, groupKey: b.groupKey, window: b.window, usedPct: 0, resetAt: null };
  }
  return { ...b };
}

export function formatEntry(acct, raw) {
  const buckets = Array.isArray(raw?.buckets) ? raw.buckets.map((b) => {
    if (b.resetAt && b.resetAt <= Date.now()) return { ...b, usedPct: 0, resetAt: null };
    return { ...b };
  }) : [];
  return {
    buckets,
    gemini_5h: pickBucket(buckets, 'gemini', '5h'),
    gemini_weekly: pickBucket(buckets, 'gemini', 'weekly'),
    tp_5h: pickBucket(buckets, '3p', '5h'),
    tp_weekly: pickBucket(buckets, '3p', 'weekly'),
    plan: effectivePlan(acct),
    tierName: acct?.tierName || '',
    email: acct?.email || '',
    at: Number(raw?.at) || 0,
    error: raw?.error || null,
    stale: !!raw?.stale,
  };
}

export function noteQuotaFromUpstream(accountId, resp) {
  if (!accountId || !resp) return null;
  const buckets = normalizeQuotaSummary(resp);
  if (!buckets.length) return null;
  byAccount[accountId] = { buckets, at: Date.now(), error: null };
  schedulePersist();
  return byAccount[accountId];
}

export function noteQuotaBuckets(accountId, rawBuckets, at = Date.now()) {
  if (!accountId || !Array.isArray(rawBuckets) || !rawBuckets.length) return null;
  const buckets = rawBuckets.map((b) => {
    const gi = groupInfo(b.group, b.id);
    return { ...b, group: gi.group, groupKey: gi.groupKey };
  });
  byAccount[accountId] = { buckets, at: Number(at) || Date.now(), error: null };
  schedulePersist();
  return byAccount[accountId];
}

export function markBucketExhausted(accountId, groupKey, resetAt = null) {
  if (!accountId) return;
  const prev = byAccount[accountId];
  const buckets = Array.isArray(prev?.buckets) ? prev.buckets.map((b) => ({ ...b })) : [];
  const gName = groupKey === '3p' ? 'Claude / GPT' : 'Gemini';
  const id5h = groupKey === '3p' ? '3p-5h' : 'gemini-5h';
  const hit = buckets.find((b) => b.groupKey === groupKey && b.window === '5h');
  if (hit) {
    hit.usedPct = 100;
    if (resetAt && resetAt > Date.now()) hit.resetAt = resetAt;
  } else {
    buckets.push({
      id: id5h,
      group: gName,
      groupKey,
      window: '5h',
      usedPct: 100,
      resetAt: resetAt && resetAt > Date.now() ? resetAt : null,
    });
  }
  byAccount[accountId] = { buckets, at: Date.now(), error: null };
  schedulePersist();
}

export function accountQuotaSnapshot(accountId) {
  const acct = getAccountInternal(accountId);
  if (!acct) return null;
  return formatEntry(acct, byAccount[accountId] || null);
}

async function probeViaDirectCcpa(acct, { forceRefreshToken = false } = {}) {
  const tokRes = await getAccessToken(acct.id, { forceRefresh: forceRefreshToken });
  if (!tokRes.token) {
    return { buckets: null, error: tokRes.error || 'unavailable', needFallback: acct.source === 'local' };
  }

  let project = acct.project || '';
  if (!project) {
    const prof = await fetchAccountProfile(tokRes.token);
    if (prof.email || prof.project || prof.tierId || prof.tierName) {
      noteAccountMeta(acct.id, prof);
      project = prof.project || '';
    }
  }

  const ua = effectiveAgyUserAgent();
  const r = await doFetch(`${CCPA_UPSTREAM()}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + tokRes.token,
      'content-type': 'application/json',
      'user-agent': ua,
    },
    body: JSON.stringify(project ? { project } : {}),
    signal: AbortSignal.timeout(10_000),
  });

  if (r.status === 401 && !forceRefreshToken && (acct.refreshToken || acct.source === 'slot')) {
    return probeViaDirectCcpa(acct, { forceRefreshToken: true });
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const msg = r.status === 401 ? '登录凭据已失效，请重新授权'
      : r.status === 403 ? '该账号暂无 Antigravity 访问权限'
      : `查询额度失败（HTTP ${r.status}）`;
    return { buckets: null, error: msg, rawError: txt.slice(0, 200) };
  }
  const json = await r.json().catch(() => null);
  const buckets = normalizeQuotaSummary(json);
  return { buckets, error: null };
}

export async function fetchAccountQuota(accountId, { force = false, maxAgeMs = SOFT_CACHE_MS, fallbackFn = null } = {}) {
  const acct = getAccountInternal(accountId);
  if (!acct) return null;

  const cached = byAccount[acct.id];
  const age = cached?.at ? Date.now() - cached.at : Infinity;
  if (!force && cached && !cached.error && age < maxAgeMs && Array.isArray(cached.buckets) && cached.buckets.length) {
    return formatEntry(acct, cached);
  }

  let p = inflightByAcct.get(acct.id);
  if (!p) {
    p = (async () => {
      try {
        const res = await probeViaDirectCcpa(acct);
        if (res.needFallback && typeof fallbackFn === 'function') {
          const fb = await fallbackFn({ force });
          if (fb && Array.isArray(fb.buckets) && fb.buckets.length) {
            const norm = fb.buckets.map((b) => {
              const gi = groupInfo(b.group, b.id);
              return { ...b, group: gi.group, groupKey: gi.groupKey };
            });
            byAccount[acct.id] = { buckets: norm, at: fb.at || Date.now(), error: null };
            schedulePersist();
            return formatEntry(getAccountInternal(acct.id) || acct, byAccount[acct.id]);
          }
          if (fb?.error) {
            const fbMsg = fb.error === 'unavailable'
              ? '进程尚未启动，发一条消息后自动读取额度'
              : fb.error;
            return formatEntry(acct, { ...(cached || {}), error: fbMsg, stale: !!cached?.buckets?.length });
          }
        }
        if (!res.error && Array.isArray(res.buckets)) {
          byAccount[acct.id] = { buckets: res.buckets, at: Date.now(), error: null };
          schedulePersist();
          return formatEntry(getAccountInternal(acct.id) || acct, byAccount[acct.id]);
        }
        const errMsg = res.error === 'unavailable' ? '尚未获取到本机登录态，发一条消息或启动进程后自动读取' : res.error;
        if (!cached?.buckets?.length) {
          byAccount[acct.id] = { buckets: [], at: Date.now(), error: errMsg };
        }
        return formatEntry(acct, { ...(cached || {}), error: errMsg, stale: !!cached?.buckets?.length });
      } catch (err) {
        const msg = err?.message || String(err);
        return formatEntry(acct, { ...(cached || {}), error: msg, stale: !!cached?.buckets?.length });
      }
    })().finally(() => {
      if (inflightByAcct.get(acct.id) === p) inflightByAcct.delete(acct.id);
    });
    inflightByAcct.set(acct.id, p);
  }
  return p;
}

export async function poolUsage({ force = false, fallbackFn = null } = {}) {
  const wantForce = force && Date.now() - lastForceAllAt >= FORCE_GAP_MS;
  if (wantForce) lastForceAllAt = Date.now();
  const list = listAccountsInternal();
  const entries = await Promise.all(list.map(async (a) => {
    const q = await fetchAccountQuota(a.id, {
      force: wantForce,
      fallbackFn: a.source === 'local' ? fallbackFn : null,
    });
    return [a.id, q];
  }));
  return Object.fromEntries(entries);
}

export async function refreshAccounts(ids = [], { maxAgeMs = 120_000, fallbackFn = null } = {}) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return;
  await Promise.allSettled(uniq.map((id) => {
    const a = getAccountInternal(id);
    return fetchAccountQuota(id, {
      force: false,
      maxAgeMs,
      fallbackFn: a?.source === 'local' ? fallbackFn : null,
    });
  }));
}

export function deleteAccountQuota(accountId) {
  if (!accountId || !byAccount[accountId]) return;
  delete byAccount[accountId];
  schedulePersist();
}

export function _setQuotaCacheFileForTest(p) {
  cacheFile = p || path.join(DATA_ROOT, 'agy', 'quota-cache.json');
  loadCache();
}

export function _setQuotaFetchForTest(fn) {
  fetchOverride = fn || null;
}

export function _resetQuotaCacheForTest() {
  clearTimeout(persistTimer);
  persistTimer = null;
  byAccount = {};
  lastForceAllAt = 0;
  inflightByAcct.clear();
  fetchOverride = null;
}
