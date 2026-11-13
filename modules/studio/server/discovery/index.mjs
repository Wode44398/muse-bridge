// 自动识别模型（方案 §9.3「发现与巡检」）：按服务拉上游目录 → 合并进服务的模型清单 → 缓存参数 schema。
//
// 时机：服务启动后 2 分钟一次、之后每 12 小时（只巡主机的服务）；拉目录时发现某服务上次巡检超过 6 小时就后台补一次
// （不阻塞、同服务去重；成员自己的服务只在本人拉目录时触发）；POST /api/studio/providers/sync 手动（设置页「立即检查」）。
// 失败只记状态（sync.ok=false + error），不动模型清单、不影响目录。
//
// 合并规则：
//   · 新模型写成 source:'remote' + discoveredAt；直连服务（vertex / gemini / openai / elevenlabs）直接 enabled:true；
//     聚合服务（openrouter / replicate / fal）第一次巡检是建底：全部 enabled:true + shelf:true（备选：不进主列表，搜得到、选了能用），
//     之后新出现的才进主列表（不带 shelf）。
//   · 清单是全量的（complete）时，上游不再列出的 remote 模型标 gone:true（目录里隐藏，不删条目）；再出现就去掉 gone。
//   · manual / builtin 模型永远不动；管理员关掉的（enabled:false）保持关；在设置里删掉的 remote 模型记进 dismissed，不再加回。
//
// 模型中心托管的服务（方案 §3.8）：模型清单归模型中心（upsert 全量覆盖），巡检不往里加、不标下架，只刷新参数 schema——
// OpenRouter 用目录带回的 schema，Replicate / fal 给主列表逐个取；没有 schema 的方言托管后不巡检。不看 autoSync（模型中心建的是 false）。

import { HOST_OWNER } from '@bridge/core/runtime/principal.mjs';
import { publicDispatcher } from '@bridge/core/runtime/public-net.mjs';
import { getProvider, usableProviders, patchModels, touchProviders, providerSecret, isMemberOwner, isManaged, DISCOVERABLE, MODEL_ID_RE } from '../providers.mjs';
import { DIALECT_KINDS } from '../presets.mjs';
import { getSyncState, setSyncState, putSchemas, getSchema, setReference, referenceStale } from './store.mjs';
import { SOURCES, SCHEMA_DIALECTS, fetchModelSchema, fetchOpenRouterCatalog, fetchOpenRouterImageEndpoints, OPENROUTER_PUBLIC } from './sources.mjs';
import { imagePriceHint } from './schema.mjs';

export const AGGREGATORS = new Set(['openrouter', 'replicate', 'fal']);
export const STALE_MS = 6 * 3600_000;
export const EVERY_MS = 12 * 3600_000;
export const FIRST_DELAY_MS = 2 * 60_000;
const SYNC_TIMEOUT_MS = 180_000;
const MAX_SCHEMA_FETCH = 40;
const MAX_PRICE_FETCH = 12;

export const discoverable = (p) => !!p && DISCOVERABLE.includes(p.dialect);
// 托管服务只在有 schema 可刷时才巡检（OpenRouter 目录、Replicate / fal 的 schema 接口）
const schemaSource = (p) => p.dialect === 'openrouter' || SCHEMA_DIALECTS.has(p.dialect);
/** 这个服务巡检有没有事可做：普通服务看方言能不能发现，托管服务看有没有 schema 可刷。 */
export const syncable = (p) => discoverable(p) && (!isManaged(p) || schemaSource(p));
// Windows 客户端经家里主机的中继调 Google（BRIDGE_VERTEX_RELAY / BRIDGE_GEMINI_RELAY）：自动巡检交给主机，客户端不跑（手动检查照旧）
const RELAY_CLIENT = !!(process.env.BRIDGE_VERTEX_RELAY || process.env.BRIDGE_GEMINI_RELAY);

/**
 * 把一次发现的结果合并进模型清单（纯函数，单测直接测）。
 * 回 { models, added:[id], gone:[id], baseline:bool }。now 可注入。
 */
export function mergeDiscovered(provider, found, state = {}, { now = Date.now() } = {}) {
  const dialect = provider.dialect;
  const kinds = DIALECT_KINDS[dialect] || [];
  const baseline = AGGREGATORS.has(dialect) && !state.baselineAt;
  const dismissed = new Set(state.dismissed || []);
  const models = provider.models.map((m) => ({ ...m }));
  const byId = new Map(models.map((m) => [m.id, m]));
  const seen = new Set();
  const added = [], gone = [];
  for (const f of found.models || []) {
    if (!f || !f.id || !MODEL_ID_RE.test(f.id) || !kinds.includes(f.kind) || seen.has(f.id)) continue;
    seen.add(f.id);
    const cur = byId.get(f.id);
    if (!cur) {
      if (dismissed.has(f.id)) continue;
      const m = { id: f.id, label: f.label || f.id, kind: f.kind, enabled: true, source: 'remote', discoveredAt: now, ...(baseline ? { shelf: true } : {}), ...(f.vendor ? { vendor: f.vendor } : {}), defaults: {} };
      models.push(m); byId.set(f.id, m);
      if (!baseline) added.push(f.id);
      continue;
    }
    if (cur.source !== 'remote') continue;   // 手填的、内置的：永远不动
    if (cur.gone) delete cur.gone;
    if (f.label && cur.label === cur.id && f.label !== cur.id) cur.label = f.label;   // 没改过名的跟上游显示名走
    if (f.vendor && !cur.vendor) cur.vendor = f.vendor;
  }
  if (found.complete) {
    for (const m of models) {
      if (m.source === 'remote' && !seen.has(m.id) && !m.gone) { m.gone = true; gone.push(m.id); }
    }
  }
  return { models, added, gone, baseline };
}

const inflight = new Map();   // owner|pid → Promise
const keyOf = (owner, pid) => (owner || HOST_OWNER) + '|' + pid;

/** 巡检一个服务（同服务去重）。回巡检状态。opts.sources 可替换发现源（单测用）。 */
export function syncProvider(owner, pid, opts = {}) {
  const k = keyOf(owner, pid);
  if (inflight.has(k)) return inflight.get(k);
  const run = doSync(owner || HOST_OWNER, pid, opts).finally(() => inflight.delete(k));
  inflight.set(k, run);
  return run;
}

async function doSync(owner, pid, { sources = SOURCES, fetchSchema = fetchModelSchema, fetchEndpoints = fetchOpenRouterImageEndpoints, reason = 'auto' } = {}) {
  const p = getProvider(pid, owner);
  if (!p || !syncable(p)) return null;
  const managed = isManaged(p);
  const prev = getSyncState(owner, pid) || {};
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('巡检超时')), SYNC_TIMEOUT_MS);
  timer.unref?.();
  const ctx = {
    secret: providerSecret(p), dispatcher: isMemberOwner(owner) ? publicDispatcher() : undefined, signal: ac.signal,
    probes: { ...(prev.probes || {}) }, reprobe: reason === 'manual', log: (s) => console.error('[studio]', s),
  };
  const t0 = Date.now();
  try {
    // 托管的 Replicate / fal：清单不用拉（不合并），schema 下面 fillSchemas 按主列表逐个取；OpenRouter 的 schema 就在目录里，照拉
    const found = managed && p.dialect !== 'openrouter' ? { models: [] } : await sources[p.dialect](p, ctx);
    // OpenRouter 的目录就是参照库：顺手换新（公共数据，跟 Key 无关）
    if (p.dialect === 'openrouter' && found.catalog && /(^|\.)openrouter\.ai$/.test(safeHost(p.baseUrl))) setReference(found.catalog);
    if (found.schemas) putSchemas(owner, pid, found.schemas, { replace: !!found.schemasReplace });
    let merged = null;
    if (!managed) {
      patchModels(pid, owner, (models) => {
        merged = mergeDiscovered({ ...p, models }, found, prev);
        return merged.models;
      });
    }
    merged ||= { added: [], gone: [], baseline: false };
    const fresh = getProvider(pid, owner) || p;
    await fillSchemas(owner, fresh, ctx, { fetchSchema, fetchEndpoints });
    const state = {
      ...prev, at: Date.now(), ok: true, ms: Date.now() - t0, reason, added: merged.added, gone: merged.gone,
      ...(merged.baseline ? { baselineAt: Date.now() } : {}), probes: ctx.probes,
    };
    delete state.error;
    setSyncState(owner, pid, state);
    touchProviders(owner);
    return state;
  } catch (e) {
    const state = { ...prev, at: Date.now(), ok: false, ms: Date.now() - t0, reason, error: String((e && e.message) || e).slice(0, 300), added: [], gone: [], probes: ctx.probes };
    setSyncState(owner, pid, state);
    touchProviders(owner);
    return state;
  } finally {
    clearTimeout(timer);
  }
}
const safeHost = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// 主列表里的模型（非备选、没下架、启用的；含手填的）顺带取 schema / 单价——备选的等有人选了再按需取（resolve）
async function fillSchemas(owner, p, ctx, { fetchSchema, fetchEndpoints }) {
  const main = p.models.filter((m) => m.enabled && !m.shelf && !m.gone && m.source !== 'builtin');
  if (SCHEMA_DIALECTS.has(p.dialect)) {
    const todo = main.slice(0, MAX_SCHEMA_FETCH);
    const got = {};
    await pool(todo, 3, async (m) => { const s = await fetchSchema(p, m, ctx); if (s) got[m.id] = s; });
    if (Object.keys(got).length) putSchemas(owner, p.id, got);
  }
  if (p.dialect === 'openrouter') {
    const todo = main.filter((m) => m.kind === 'image' && getSchema(owner, p.id, m.id) && !getSchema(owner, p.id, m.id).priceHint).slice(0, MAX_PRICE_FETCH);
    const got = {};
    await pool(todo, 3, async (m) => {
      const hint = imagePriceHint(await fetchEndpoints(p, m.id, ctx));
      if (hint) got[m.id] = { ...getSchema(owner, p.id, m.id), priceHint: hint };
    });
    if (Object.keys(got).length) putSchemas(owner, p.id, got);
  }
}
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const x = list[i++]; try { await fn(x); } catch {} } }));
}

/** 按需取一个模型的 schema（resolve 备选模型时）：已有缓存就不取。回 true = 新取到了。 */
export async function ensureSchema(owner, provider, entry) {
  if (!SCHEMA_DIALECTS.has(provider.dialect) && provider.dialect !== 'openrouter') return false;
  const cur = getSchema(provider.owner || owner, provider.id, entry.id);
  const ctx = { secret: providerSecret(provider), dispatcher: isMemberOwner(provider.owner) ? publicDispatcher() : undefined, signal: AbortSignal.timeout(20_000) };
  if (provider.dialect === 'openrouter') {
    if (!cur || cur.priceHint || entry.kind !== 'image') return false;
    const hint = imagePriceHint(await fetchOpenRouterImageEndpoints(provider, entry.id, ctx));
    if (hint) putSchemas(provider.owner, provider.id, { [entry.id]: { ...cur, priceHint: hint } });
    return !!hint;
  }
  if (cur) return false;
  const s = await fetchModelSchema(provider, entry, ctx);
  if (s) putSchemas(provider.owner, provider.id, { [entry.id]: s });
  return !!s;
}

/**
 * 一个身份自己的全部服务（force：手动「立即检查」，不看 autoSync）。
 * 托管服务不看 autoSync、只刷 schema；includeManaged:false 跳过它们（设置页的「立即检查」：清单归模型中心）。
 */
export async function syncOwner(owner, { force = false, reason = force ? 'manual' : 'auto', includeManaged = true } = {}) {
  const list = usableProviders(owner).filter((p) => p.owner === (owner || HOST_OWNER) && p.enabled && syncable(p)
    && (isManaged(p) ? includeManaged : (force || p.autoSync !== false)));
  const out = {};
  for (const p of list) out[p.id] = await syncProvider(owner, p.id, { reason });
  return out;
}

/** 拉目录时调：自己的服务里上次巡检超过 6 小时的，后台补一次（不等）。参照库过期也顺带换新。 */
export function maybeSyncStale(owner) {
  if (RELAY_CLIENT) return;
  owner = owner || HOST_OWNER;
  for (const p of usableProviders(owner)) {
    if (p.owner !== owner || !p.enabled || !syncable(p) || (!isManaged(p) && p.autoSync === false)) continue;
    const s = getSyncState(owner, p.id);
    if (s && s.at && Date.now() - s.at < STALE_MS) continue;
    if (inflight.has(keyOf(owner, p.id))) continue;
    syncProvider(owner, p.id, { reason: 'stale' }).catch(() => {});
  }
  if (referenceStale()) refreshReference().catch(() => {});
}

let refInflight = null;
/** 参照库（OpenRouter 公共媒体目录，12 小时）换新：不要 Key，走主机的出站代理。 */
export function refreshReference() {
  if (refInflight) return refInflight;
  refInflight = fetchOpenRouterCatalog(OPENROUTER_PUBLIC, { signal: AbortSignal.timeout(45_000) })
    .then((cat) => { if (cat.images.length || cat.videos.length) setReference(cat); return true; })
    .catch((e) => { console.error('[studio] 参照库拉取失败：', (e && e.message) || e); return false; })
    .finally(() => { refInflight = null; });
  return refInflight;
}

let timers = null;
/** 定时巡检（主机的服务）：启动后 2 分钟一次，之后每 12 小时。回撤销函数。 */
export function startSchedule({ firstDelayMs = FIRST_DELAY_MS, everyMs = EVERY_MS } = {}) {
  stopSchedule();
  if (RELAY_CLIENT) return stopSchedule;
  const tick = () => {
    refreshReference().catch(() => {});
    syncOwner(HOST_OWNER).catch((e) => console.error('[studio] 定时巡检失败：', (e && e.message) || e));
  };
  const first = setTimeout(tick, firstDelayMs);
  const every = setInterval(tick, everyMs);
  first.unref?.(); every.unref?.();
  timers = { first, every };
  return stopSchedule;
}
export function stopSchedule() {
  if (!timers) return;
  clearTimeout(timers.first); clearInterval(timers.every);
  timers = null;
}

export function _syncInflightForTests() { return inflight; }
