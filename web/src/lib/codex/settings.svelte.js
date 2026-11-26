// 设置 › Codex 的数据面（Svelte 5 runes；桌面 desktop/settings/CodexSection 与手机 settings/ios/codex/ 共用）。
//   设置：GET/POST /api/codex/settings —— 管理员拿到 settings / choices / cli，成员只有自己的有效档（effective）
//   号池：GET /api/codex/pool/usage（带各号额度）与 POST /api/codex/pool/*（只给管理员）；变化经总线 codex.pool / codex.login 推来
//   已归档的对话：GET /api/codex/sessions 里 archived 的那些；恢复走 thread/unarchive，删除走 session/delete
// 纯文案与格式化在 settings-logic.js。

import { api } from '../api.js';
import { busOn } from '../bus.js';
import { me } from '../state.svelte.js';
import { t, tr } from '../i18n.js';
import { recall, remember, forget } from '../lastKnown.js';

// 上次看到的设置、号池（带额度）与已归档列表（lib/lastKnown）：冷开设置推进 Codex 页时第一帧就是完整的各组，
// 不先出「读取中…」再整页换掉。只记拉到的数据，忙闲、报错与登录流程不记。要声明在 $state 之前（下面展开时就要用）
const SNAP_KEYS = ['admin', 'effective', 'settings', 'choices', 'platform', 'cli', 'pool', 'archived', 'archivedLoaded'];
function pickSnap(o) {
  if (!o || typeof o !== 'object' || !(o.settings || o.effective)) return {};
  const r = {};
  for (const k of SNAP_KEYS) if (k in o) r[k] = o[k];
  if (r.pool) { const { logins, ...rest } = r.pool; r.pool = rest; }
  return r;
}
const SNAP = pickSnap(recall('codex'));

export const cx = $state({
  loaded: false,
  loading: false,
  admin: false,
  effective: null,     // 我自己的有效档 { approvalPolicy, sandbox, approvals, sandboxes, maxRuns, goalsEnabled }
  settings: null,      // 管理员：{ approval:{admin,member}, idleStopMinutes, memberMaxRuns, goalsEnabled, behavior:{webSearch,reasoningSummary,verbosity,askUser,networkAccess,instructions} }
  choices: null,       // 管理员：{ approvals, sandboxes, member:{approvals,sandboxes,approvalPolicy,sandbox}, behavior, instructionsMax }
  platform: '',
  cli: null,           // 管理员：{ file, command, source, version }
  pool: null,          // 管理员：{ accounts, activeId, router, logins }；成员：{ accounts }（共享给他的号）
  poolLoading: false,
  usageBusy: false,
  busy: '',            // 正在进行的操作（'settings:<区>' / 'acct:<id>:<动作>' / 'router' / 'login' / 'archived:<id>'），同一时刻一个
  errors: {},          // 按区的错误文案：settings / pool / router / login / archived / acct:<id>
  flows: {},           // 设备码登录流程：flowId -> flow（总线与轮询都往这里写）
  archived: [],        // 已归档的对话 [{ id, title, mtime, projectName }]
  archivedLoaded: false,
  // snap = 现在画的是快照；loaded 仍只在这次真拉到后才置真（总线与子页补拉据它判断）
  snap: 'admin' in SNAP,
  ...SNAP,
});
function keep() { if (cx.settings || cx.effective) remember('codex', pickSnap($state.snapshot(cx))); }
// 401 / 403 / 404 = 这个身份读不了（换了人、扩展卸了）：快照作废；断网、超时留着上次的，别让界面退回空白
const gone = (e) => [401, 403, 404].includes(e?.status);
// 同一个读在路上就别再发一份：设置页一挂上就预取（CodexSettingsPages 的 warmCodexSettings），紧接着点进来页面又拉一次
const inflight = {};
const once = (key, fn) => (inflight[key] ||= fn().finally(() => { delete inflight[key]; }));

const errText = (e, fallback) => tr(e?.body?.error || e?.body?.message || (typeof e?.body === 'string' ? e.body : '') || e?.message) || fallback || t('操作失败');
function setErr(area, e, fallback) { cx.errors = { ...cx.errors, [area]: e ? errText(e, fallback) : '' }; }
async function run(key, area, fn, fallback) {
  if (cx.busy && cx.busy === key) return null;
  cx.busy = key;
  setErr(area, null);
  try { return await fn(); }
  catch (e) { setErr(area, e, fallback); return null; }
  finally { if (cx.busy === key) cx.busy = ''; }
}

function applySettingsView(r) {
  if (!r) return;
  cx.effective = r.effective || null;
  cx.admin = !!r.settings;
  if (r.settings) {
    cx.settings = r.settings;
    cx.choices = r.choices || null;
    cx.platform = r.platform || '';
    cx.cli = r.cli || null;
  }
}

/** 读设置（两套外壳进 Codex 分区时调；成员也能调，只拿到自己的有效档）。 */
export function loadCodexSettings() {
  if (me.kind === 'none') return Promise.resolve();
  return once('settings', async () => {
    cx.loading = true;
    try { applySettingsView(await api.get('/api/codex/settings')); setErr('settings', null); keep(); }
    catch (e) {
      if (gone(e)) {
        forget('codex');
        Object.assign(cx, { admin: false, effective: null, settings: null, choices: null, cli: null, pool: null, archived: [], archivedLoaded: false });
      }
      setErr('settings', e, t('读不到 Codex 设置'));
    }
    finally { cx.loading = false; cx.loaded = true; cx.snap = false; }
  });
}

/**
 * 改设置。patch 照 POST /api/codex/settings：{ approval?, idleStopMinutes?, memberMaxRuns?, goalsEnabled?, behavior? }。
 * 先就地改（界面不等网络），失败退回原值并在 errors[area] 里说。
 */
export async function saveCodexSettings(patch, area = 'settings') {
  if (!cx.settings) return false;
  const before = $state.snapshot(cx.settings);
  const next = { ...before, ...patch };
  if (patch.behavior) next.behavior = { ...(before.behavior || {}), ...patch.behavior };
  if (patch.approval) {
    next.approval = { ...(before.approval || {}) };
    for (const [who, v] of Object.entries(patch.approval)) next.approval[who] = { ...(before.approval?.[who] || {}), ...v };
  }
  cx.settings = next;
  const r = await run('settings:' + area, area, () => api.post('/api/codex/settings', patch), t('没存上'));
  if (!r) { cx.settings = before; return false; }
  applySettingsView(r);
  keep();
  return true;
}
export const setBehavior = (key, value) => saveCodexSettings({ behavior: { [key]: value } }, 'behavior');
/** who：'admin' | 'member'；key：'approvalPolicy' | 'sandbox' */
export const setApproval = (who, key, value) => saveCodexSettings({ approval: { [who]: { [key]: value } } }, 'approval');

/** 管理员看自己 / 成员的默认档时用：存过的值，没存过就是那一档的出厂默认。 */
export function approvalOf(who) {
  const saved = cx.settings?.approval?.[who] || {};
  if (who === 'admin') return { approvalPolicy: saved.approvalPolicy || 'never', sandbox: saved.sandbox || 'danger-full-access' };
  const d = cx.choices?.member || {};
  return { approvalPolicy: saved.approvalPolicy || d.approvalPolicy || 'on-request', sandbox: saved.sandbox || d.sandbox || 'workspace-write' };
}
export const behavior = () => cx.settings?.behavior || {};

// ── 号池 ──────────────────────────────────────────────────────────────────────

function mergePool(next) {
  if (!next) return;
  const prev = new Map((cx.pool?.accounts || []).map((a) => [a.id, a]));
  // 总线推的快照不带额度：沿用上次读到的，别让用量条闪成空
  const accounts = (next.accounts || []).map((a) => ({ ...a, limits: a.limits !== undefined ? a.limits : prev.get(a.id)?.limits }));
  cx.pool = { ...(cx.pool || {}), ...next, accounts };
  for (const f of next.logins || []) cx.flows = { ...cx.flows, [f.flowId]: f };
  keep();
}

/** 读号池（默认带各号额度；force = 现读，不用 60 秒缓存，只有管理员能 force）。 */
export async function loadCodexPool({ usage = true, force = false } = {}) {
  if (me.kind === 'none') return;
  // 只有进页那一下的普通读才合并；force 与改完后的补拉都要现读
  if (usage && !force) return once('pool', () => readPool(true, false));
  return readPool(usage, force);
}
async function readPool(usage, force) {
  if (usage) cx.usageBusy = true; else cx.poolLoading = true;
  try {
    mergePool(await api.get(usage ? '/api/codex/pool/usage' + (force ? '?force=1' : '') : '/api/codex/pool'));
    setErr('pool', null);
  } catch (e) { setErr('pool', e, t('读不到 Codex 号池')); }
  finally { cx.usageBusy = false; cx.poolLoading = false; }
}

/** 进设置的 Codex 分区时调一次：设置 + 号池（带额度）+ 已归档的对话。 */
export async function loadCodexAll() {
  await Promise.all([loadCodexSettings(), loadCodexPool({ usage: true }), loadArchived()]);
}

export const accountById = (id) => (cx.pool?.accounts || []).find((a) => a.id === id) || null;
export const routerOn = () => !!cx.pool?.router?.enabled;

async function poolOp(key, area, path, body, fallback) {
  const r = await run(key, area, () => api.post(path, body), fallback);
  if (r) await loadCodexPool({ usage: false });
  return r;
}
export const activateAccount = (id) => poolOp('acct:' + id + ':active', 'acct:' + id, '/api/codex/pool/active', { id }, t('切换失败'));
export const updateAccount = (id, patch) => poolOp('acct:' + id + ':update', 'acct:' + id, '/api/codex/pool/update', { id, ...patch }, t('没存上'));
export const restartAccount = (id) => poolOp('acct:' + id + ':restart', 'acct:' + id, '/api/codex/pool/restart', { id }, t('重启失败'));
export const deleteAccount = (id) => poolOp('acct:' + id + ':delete', 'acct:' + id, '/api/codex/pool/delete', { id }, t('删除失败'));
/** 上移 / 下移一位（primary / fill 策略按这个顺序取号）。 */
export function moveAccount(id, delta) {
  const list = cx.pool?.accounts || [];
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return null;
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  if (j === i) return null;
  return poolOp('acct:' + id + ':move', 'acct:' + id, '/api/codex/pool/move', { id, index: j }, t('没移动成功'));
}
/** 用掉一张重置卡（不可撤回：调用方先确认）。 */
export async function useResetCredit(id) {
  const key = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2));
  const r = await run('acct:' + id + ':reset', 'acct:' + id, () => api.post('/api/codex/pool/reset-credit', { id, confirm: true, idempotencyKey: key }), t('没用上重置卡'));
  if (r) await loadCodexPool({ usage: true, force: true });
  return r;
}
export async function setRouter(patch) {
  const before = cx.pool?.router ? { ...cx.pool.router } : null;
  if (cx.pool?.router) cx.pool = { ...cx.pool, router: { ...cx.pool.router, ...patch } };
  const r = await run('router', 'router', () => api.post('/api/codex/pool/router', patch), t('没存上'));
  if (!r) { if (before) cx.pool = { ...cx.pool, router: before }; return false; }
  if (r.router) cx.pool = { ...cx.pool, router: r.router };
  return true;
}

// ── 加号：ChatGPT 设备码登录 / API 密钥 ───────────────────────────────────────

/** 发起设备码登录（accountId 给了 = 重新登录那个号）。返回流程 { flowId, verificationUrl, userCode, expiresAt, state }，失败返回 null。 */
export async function startDeviceLogin({ accountId = null, label = '' } = {}) {
  const r = await run('login', 'login', () => api.post('/api/codex/pool/login/start', { accountId: accountId || undefined, label: String(label || '').trim() || undefined }), t('没能发起登录'));
  const flow = r?.flow || null;
  if (flow) cx.flows = { ...cx.flows, [flow.flowId]: flow };
  return flow;
}
/** 轮询一次流程状态（总线断了也能走到终态）。 */
export async function pollDeviceLogin(flowId) {
  if (!flowId) return null;
  try {
    const r = await api.get('/api/codex/pool/login/status?flowId=' + encodeURIComponent(flowId));
    if (r?.flow) {
      cx.flows = { ...cx.flows, [flowId]: r.flow };
      if (['done', 'duplicate', 'failed', 'cancelled', 'expired'].includes(r.flow.state)) loadCodexPool({ usage: false });
    }
    return r?.flow || null;
  } catch { return cx.flows[flowId] || null; }
}
export async function cancelDeviceLogin(flowId) {
  if (!flowId) return;
  try { const r = await api.post('/api/codex/pool/login/cancel', { flowId }); if (r?.flow) cx.flows = { ...cx.flows, [flowId]: r.flow }; } catch {}
}
/** API 密钥号：服务端先拿密钥去 OpenAI 校验再登记。 */
export async function addApiKeyAccount({ apiKey, label = '' }) {
  const r = await run('apikey', 'login', () => api.post('/api/codex/pool/apikey', { apiKey: String(apiKey || '').trim(), label: String(label || '').trim() }), t('没加上'));
  if (r) await loadCodexPool({ usage: false });
  return !!r;
}

// ── 已归档的对话 ──────────────────────────────────────────────────────────────

export function loadArchived() {
  if (me.kind === 'none') return Promise.resolve();
  return once('archived', async () => {
    try {
      const r = await api.get('/api/codex/sessions');
      // 列表行只用这几项，别把整条会话记录塞进快照
      cx.archived = (r?.sessions || []).filter((s) => s.archived).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
        .map(({ id, title, mtime, projectName }) => ({ id, title, mtime, projectName }));
      setErr('archived', null);
      keep();
    } catch (e) { setErr('archived', e, t('读不到已归档的对话')); }
    finally { cx.archivedLoaded = true; }
  });
}
export async function unarchiveSession(id) {
  const r = await run('archived:' + id, 'archived', () => api.post('/api/codex/thread/unarchive', { session: id }), t('没恢复成功'));
  if (r) { cx.archived = cx.archived.filter((s) => s.id !== id); keep(); }
  return !!r;
}
export async function deleteArchivedSession(id) {
  const r = await run('archived:' + id, 'archived', () => api.post('/api/codex/session/delete', { id }), t('删除失败'));
  if (r) { cx.archived = cx.archived.filter((s) => s.id !== id); keep(); }
  return !!r;
}

// ── 总线：号池与登录流程的变化（只推管理员）──────────────────────────────────
busOn((ev) => {
  if (!ev || !cx.loaded) return;
  if (ev.type === 'codex.pool' && ev.pool) mergePool(ev.pool);
  else if (ev.type === 'codex.login' && ev.flow?.flowId) cx.flows = { ...cx.flows, [ev.flow.flowId]: ev.flow };
});
