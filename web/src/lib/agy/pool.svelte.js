// Antigravity 多号池响应式状态与动作（Svelte 5 runes，供桌面设置、iOS 设置共用）。

import { t, tr } from '../i18n.js';
import { agyApi } from './api.js';
import { recall, remember, forget } from '../lastKnown.js';
import {
  agyAccLabel,
  agyPlanPill,
  agyPlanChoices,
  agyUsageTone,
  agyHhmm,
  agyPoolResetIn,
  agyPoolResetAt,
  agyRouteStrategies,
  agyWhyText,
  agyRouteLogTitle,
  agyRouteLogSub,
} from './pool-logic.js';

export {
  agyPlanPill,
  agyUsageTone,
  agyHhmm,
  agyAccLabel as accLabel,
  agyPlanChoices as planChoices,
  agyPoolResetIn as poolResetIn,
  agyPoolResetAt as poolResetAt,
  agyRouteStrategies as routeStrategies,
  agyWhyText as whyText,
  agyRouteLogTitle as routeLogTitle,
  agyRouteLogSub as routeLogSub,
};

// 记进快照的只有拉到的数据（lib/lastKnown），忙闲与报错不记。要声明在 $state 之前（下面展开时就要用）
const SNAP_KEYS = ['accounts', 'usage', 'router', 'upstream', 'localAuthed', 'authMode', 'manualTokenSupported'];
function pickSnap(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.accounts)) return {};
  const r = {};
  for (const k of SNAP_KEYS) if (k in o) r[k] = o[k];
  return r;
}
const SNAP = pickSnap(recall('agyPool'));
const HAS_SNAP = 'accounts' in SNAP;

export const agyPool = $state({
  ok: false,
  loading: false,
  loaded: false,
  accounts: [],
  usage: {},
  usageBusy: false,
  router: null,
  routerBusy: false,
  upstream: null,
  localAuthed: false,
  authMode: 'oauth',
  manualTokenSupported: true,
  err: '',
  // 上次看到的号池与用量：冷开设置第一帧就是带用量表盘的账号行，网络回来原地换。
  // snap 表示「现在画的是快照」；loaded 仍只在这次真拉到后才置真（子页据它决定要不要补拉）
  snap: HAS_SNAP,
  usageLoaded: HAS_SNAP && !!SNAP.usage,
  ...SNAP,
});
function keep() { remember('agyPool', pickSnap($state.snapshot(agyPool))); }
// 401 / 403 / 404 = 这个身份没有号池接口：快照作废；断网、超时留着上次的，别让界面退回空白
const gone = (e) => [401, 403, 404].includes(e?.status);

const setErr = (e, fallback) => {
  agyPool.err = tr(e?.body?.error || e?.message) || fallback || t('操作失败');
};
const clearErr = () => { agyPool.err = ''; };

function adoptPool(res) {
  if (!res) return;
  if (Array.isArray(res.accounts)) agyPool.accounts = res.accounts;
  if (res.router) agyPool.router = res.router;
  if (res.upstream) agyPool.upstream = res.upstream;
  if (typeof res.localAuthed === 'boolean') agyPool.localAuthed = res.localAuthed;
  if (typeof res.authMode === 'string' && res.authMode) agyPool.authMode = res.authMode;
  if (typeof res.manualTokenSupported === 'boolean') agyPool.manualTokenSupported = res.manualTokenSupported;
  keep();
}

export const routerStrategy = () => agyPool.router?.settings?.strategy || 'smart';
export const smartRouting = () => !!agyPool.router?.settings?.enabled && routerStrategy() === 'smart';
export const routerEnabled = () => !!agyPool.router?.settings?.enabled;
export const runningOn = (id) => agyPool.router?.dispatch?.accounts?.[id]?.tasks || 0;
export const acctById = (id) => agyPool.accounts.find((x) => x.id === id) || null;

export async function loadAgyPoolUsage(force = false) {
  if (agyPool.usageBusy && !force) return;
  agyPool.usageBusy = true;
  try {
    const res = await agyApi.poolUsage(force);
    if (res?.usage && typeof res.usage === 'object') { agyPool.usage = res.usage; keep(); }
  } catch {} finally {
    agyPool.usageBusy = false;
    agyPool.usageLoaded = true;
  }
}

// 同一个读在路上就别再发一份：设置页一挂上就预取（AgySettingsPages 的 warmAgySettings），紧接着点进来页面又拉一次
let poolInflight = null;
export function loadAgyPool({ usage = true, forceUsage = false } = {}) {
  if (poolInflight && !forceUsage) return poolInflight;
  const p = (async () => {
    agyPool.loading = true;
    try {
      const res = await agyApi.pool();
      adoptPool(res);
      agyPool.ok = true;
      agyPool.loaded = true;
      agyPool.snap = false;
      clearErr();
      if (usage) loadAgyPoolUsage(forceUsage);
    } catch (e) {
      if (gone(e)) {
        forget('agyPool');
        agyPool.snap = false;
        agyPool.accounts = [];
        agyPool.usage = {};
        agyPool.router = null;
      }
      if (!agyPool.loaded) agyPool.ok = false;
      setErr(e, t('读取号池状态失败'));
    } finally {
      agyPool.loading = false;
    }
  })();
  poolInflight = p;
  p.finally(() => { if (poolInflight === p) poolInflight = null; });
  return p;
}

export async function activateAgyAccount(acc) {
  if (!acc?.id) return false;
  const prev = agyPool.accounts.map((x) => ({ ...x }));
  agyPool.accounts = agyPool.accounts.map((x) => ({ ...x, active: x.id === acc.id }));
  try {
    const res = await agyApi.poolSetActive(acc.id);
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    clearErr();
    return true;
  } catch (e) {
    agyPool.accounts = prev;
    setErr(e, t('切换失败'));
    return false;
  }
}

export async function moveAgyAccount(acc, delta) {
  if (!acc?.id) return false;
  try {
    const res = await agyApi.poolMove(acc.id, delta);
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    clearErr();
    return true;
  } catch (e) {
    setErr(e, t('调整顺序失败'));
    return false;
  }
}

export async function addAgyAccountManual({ label = '', refreshToken = '', plan = '' } = {}) {
  try {
    const res = await agyApi.poolAdd({
      label: String(label || '').trim(),
      refreshToken: String(refreshToken || '').trim(),
      plan: String(plan || '').trim(),
    });
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    clearErr();
    loadAgyPoolUsage(true);
    return { ok: true, id: res.id, account: res.account };
  } catch (e) {
    const msg = tr(e?.body?.error || e?.message) || t('添加账号失败');
    return { ok: false, error: msg };
  }
}

export async function updateAgyAccount(id, { label, refreshToken, plan } = {}) {
  try {
    const body = { id };
    if (typeof label === 'string') body.label = label.trim();
    if (typeof refreshToken === 'string' && refreshToken.trim()) body.refreshToken = refreshToken.trim();
    if (typeof plan === 'string') body.plan = plan;
    const res = await agyApi.poolUpdate(body);
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    clearErr();
    if (body.refreshToken || typeof plan === 'string') loadAgyPoolUsage(true);
    return { ok: true, account: res.account };
  } catch (e) {
    const msg = tr(e?.body?.error || e?.message) || t('保存账号失败');
    return { ok: false, error: msg };
  }
}

export async function deleteAgyAccount(id) {
  try {
    const res = await agyApi.poolDelete(id);
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    if (agyPool.usage[id]) {
      const next = { ...agyPool.usage };
      delete next[id];
      agyPool.usage = next;
    }
    clearErr();
    return true;
  } catch (e) {
    setErr(e, t('删除账号失败'));
    return false;
  }
}

export async function setAgyRouter(patch) {
  if (agyPool.routerBusy) return false;
  agyPool.routerBusy = true;
  try {
    const res = await agyApi.poolSetRouter(patch);
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    clearErr();
    return true;
  } catch (e) {
    setErr(e, t('保存换号设置失败'));
    return false;
  } finally {
    agyPool.routerBusy = false;
  }
}

export async function startAgyOAuth({ label = '', accountId = '', plan = '' } = {}) {
  try {
    const res = await agyApi.poolOAuthStart({ label, accountId, plan });
    if (res?.error) throw new Error(res.error);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: tr(e?.body?.error || e?.message) || t('无法发起 Google 授权') };
  }
}

export async function pollAgyOAuth(flowId) {
  try {
    const res = await agyApi.poolOAuthStatus(flowId);
    if (res?.status === 'done') {
      adoptPool(res);
      loadAgyPoolUsage(true);
    }
    return res;
  } catch (e) {
    return { status: 'error', error: tr(e?.body?.error || e?.message) || t('查询授权状态失败') };
  }
}

export async function finishAgyOAuth({ flowId, input, label = '', plan = '' } = {}) {
  try {
    const res = await agyApi.poolOAuthFinish({ flowId, input, label, plan });
    if (res?.error) throw new Error(res.error);
    adoptPool(res);
    loadAgyPoolUsage(true);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: tr(e?.body?.error || e?.message) || t('完成授权失败') };
  }
}

export async function cancelAgyOAuth(flowId) {
  if (!flowId) return;
  try { await agyApi.poolOAuthCancel(flowId); } catch {}
}
