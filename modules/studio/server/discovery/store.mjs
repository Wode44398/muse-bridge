// 自动识别的落盘状态（方案 §9.3）。叶子模块：只依赖核心的 jsonfile 与 Studio 目录，providers / cards 都能放心 import。
//
//   <owner 目录>/sync.json                  每个服务的巡检状态 { at, ok, error?, added, gone, baselineAt?, dismissed, probes }
//   <owner 目录>/schemas/<服务 id>.json      上游参数描述缓存 { at, models: { <模型 id>: { src, kind, data, version?, hash, priceHint?, endpoints?, at } } }
//                                            endpoints（OpenRouter 图像）= { n, slug?, passthrough: [键] }，见 schema.mjs imageEndpointInfo
//   <主机目录>/schemas/_reference-openrouter.json  参照库：OpenRouter 公共媒体目录（12 小时缓存，所有身份共用）
//   <owner 目录>/seen.json                  本人用过的模型 { <key>: 时间 }（目录的 isNew 用）
// owner 目录 = studioOwnerDir(owner)：主机 <数据根>/studio-providers/，成员 …/users/<账号>/。

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { studioOwnerDir } from '@bridge/core/runtime/studio-settings.mjs';
import { HOST_OWNER } from '@bridge/core/runtime/principal.mjs';

const PID_RE = /^p-[0-9a-f]{6,12}$/;
export const hashOf = (o) => createHash('sha1').update(JSON.stringify(o ?? null)).digest('hex').slice(0, 12);

// —— 变更计数：模型卡的缓存据此失效（schema / 参照库一变就重算）——
let rev = 0;
export const discoveryRev = () => rev;
const bump = () => { rev += 1; };

// —— 巡检状态 ——
const syncs = new Map();   // owner → { providers: { pid: state } }
function syncFile(owner) { return path.join(studioOwnerDir(owner || HOST_OWNER), 'sync.json'); }
function loadSync(owner) {
  owner = owner || HOST_OWNER;
  let d = syncs.get(owner);
  if (!d) {
    const raw = readJson(syncFile(owner), {});
    d = { providers: raw && typeof raw.providers === 'object' && raw.providers ? raw.providers : {} };
    syncs.set(owner, d);
  }
  return d;
}
export function getSyncState(owner, pid) { return loadSync(owner).providers[pid] || null; }
export function setSyncState(owner, pid, state) {
  if (!PID_RE.test(String(pid))) return;
  const d = loadSync(owner);
  if (state) d.providers[pid] = state; else delete d.providers[pid];
  try { writeJson(syncFile(owner), d, 1); } catch (e) { console.error('[studio] 巡检状态写不下去：', (e && e.message) || e); }
}
// —— 上游拒收过的取值（方案 §11.4，cards/rejected.mjs）：<owner 目录>/rejected.json { '<服务 id>/<模型 id>': { <参数键>: [取值…] } } ——
const rejects = new Map();   // owner → { <服务/模型>: { key: [values] } }
function rejectFile(owner) { return path.join(studioOwnerDir(owner || HOST_OWNER), 'rejected.json'); }
function loadRejects(owner) {
  owner = owner || HOST_OWNER;
  let d = rejects.get(owner);
  if (!d) { const raw = readJson(rejectFile(owner), {}); d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; rejects.set(owner, d); }
  return d;
}
function saveRejects(owner) {
  try { writeJson(rejectFile(owner), loadRejects(owner), 1); } catch (e) { console.error('[studio] 拒收记录写不下去：', (e && e.message) || e); }
  bump();   // 目录的 rev 跟着变，前端重新拉
}
/** 这个服务的这个模型被上游拒收过哪些取值：{ <参数键>: [取值…] }（没有回 null） */
export function rejectedFor(owner, pid, modelId) { return loadRejects(owner)[pid + '/' + modelId] || null; }
/** 记一条拒收；已经记过回 false */
export function noteRejected(owner, pid, modelId, key, value) {
  if (!PID_RE.test(String(pid)) || !modelId || !key) return false;
  const d = loadRejects(owner);
  const m = (d[pid + '/' + modelId] ||= {});
  const list = (m[key] ||= []);
  if (list.includes(value)) return false;
  list.push(value);
  if (list.length > 40) list.splice(0, list.length - 40);
  saveRejects(owner);
  return true;
}
/** 这次成功用到的取值里有以前被拒的：解除（服务升级了 / 权限开了）。有解除回 true */
export function clearRejected(owner, pid, modelId, sent = {}) {
  const d = loadRejects(owner);
  const m = d[pid + '/' + modelId];
  if (!m) return false;
  let hit = false;
  for (const [k, list] of Object.entries(m)) {
    const i = list.indexOf(sent[k]);
    if (i < 0) continue;
    list.splice(i, 1); hit = true;
    if (!list.length) delete m[k];
  }
  if (!hit) return false;
  if (!Object.keys(m).length) delete d[pid + '/' + modelId];
  saveRejects(owner);
  return true;
}

/** 给前端看的那部分：{ at, ok, error?, added, gone }（没巡检过回 null）。 */
export function syncView(owner, pid) {
  const s = getSyncState(owner, pid);
  if (!s || !s.at) return null;
  return { at: s.at, ok: !!s.ok, ...(s.error ? { error: s.error } : {}), added: s.added || [], gone: s.gone || [] };
}
/** 管理员在设置里删掉了发现来的模型：记下来，下次巡检别再加回来。重新手加（或再出现在 keep 里）就移出。 */
export function dismissModels(owner, pid, removed = [], kept = []) {
  const cur = getSyncState(owner, pid) || {};
  const set = new Set(cur.dismissed || []);
  for (const id of removed) set.add(id);
  for (const id of kept) set.delete(id);
  const list = [...set].slice(-500);
  if (list.length === (cur.dismissed || []).length && list.every((x, i) => x === cur.dismissed[i])) return;
  setSyncState(owner, pid, { ...cur, dismissed: list });
}
export function dropSyncState(owner, pid) {
  setSyncState(owner, pid, null);
  dropSchemas(owner, pid);
}

// —— schema 缓存（按服务一份文件）——
const schemas = new Map();   // owner|pid → { at, models }
const schemaFile = (owner, pid) => path.join(studioOwnerDir(owner || HOST_OWNER), 'schemas', `${pid}.json`);
function loadSchemas(owner, pid) {
  const k = (owner || HOST_OWNER) + '|' + pid;
  let d = schemas.get(k);
  if (!d) {
    d = PID_RE.test(String(pid)) ? readJson(schemaFile(owner, pid), null) : null;
    if (!d || typeof d.models !== 'object' || !d.models) d = { at: 0, models: {} };
    schemas.set(k, d);
  }
  return d;
}
export function getSchema(owner, pid, modelId) { return loadSchemas(owner, pid).models[modelId] || null; }
export function schemaIds(owner, pid) { return Object.keys(loadSchemas(owner, pid).models); }
/**
 * 写入一批 schema。replace=true：这次清单就是全部（OpenRouter 目录一次全拿到），没列的删掉；否则只合并。
 * entries：{ <模型 id>: { src, kind, data, version?, priceHint? } }。内容没变不落盘。
 */
export function putSchemas(owner, pid, entries, { replace = false } = {}) {
  if (!PID_RE.test(String(pid))) return false;
  const d = loadSchemas(owner, pid);
  const next = replace ? {} : { ...d.models };
  let changed = replace && Object.keys(d.models).some((id) => !(id in entries));
  const now = Date.now();
  for (const [id, e] of Object.entries(entries || {})) {
    if (!e || !e.src || !e.data) continue;
    const prev = d.models[id];
    // 端点信息（OpenRouter 图像的服务商 slug + 透传键，巡检另取 endpoints 接口得来）：目录换新时这次没带、参数描述没变，就沿用上次的
    // （否则每次拉目录都把透传参数冲掉，要等下一轮补取）。旧缓存没有这个字段：行为同以前
    const endpoints = e.endpoints || (prev?.endpoints && prev.src === e.src && hashOf(prev.data) === hashOf(e.data) ? prev.endpoints : undefined);
    const hash = hashOf([e.src, e.kind, e.data, e.priceHint || '', ...(endpoints ? [endpoints] : [])]);
    if (prev && prev.hash === hash) { next[id] = prev; continue; }
    next[id] = { src: e.src, kind: e.kind, data: e.data, ...(e.version ? { version: e.version } : {}), ...(e.priceHint ? { priceHint: e.priceHint } : {}), ...(endpoints ? { endpoints } : {}), ...(e.vendor ? { vendor: e.vendor } : {}), hash, at: now };
    changed = true;
  }
  if (!changed) return false;
  d.models = next; d.at = now;
  try { writeJson(schemaFile(owner, pid), d, 0); } catch (e) { console.error('[studio] schema 缓存写不下去：', (e && e.message) || e); }
  bump();
  return true;
}
function dropSchemas(owner, pid) {
  schemas.delete((owner || HOST_OWNER) + '|' + pid);
  if (PID_RE.test(String(pid))) { try { writeJson(schemaFile(owner, pid), { at: 0, models: {} }, 0); } catch {} }
  bump();
}

// —— 参照库：OpenRouter 公共媒体目录（不要 Key；所有身份共用一份）——
export const REFERENCE_TTL_MS = 12 * 3600_000;
let reference = null;   // { at, images: Map, videos: Map }
const refFile = () => path.join(studioOwnerDir(HOST_OWNER), 'schemas', '_reference-openrouter.json');
function indexRef(raw) {
  const images = new Map(), videos = new Map();
  for (const m of Array.isArray(raw?.images) ? raw.images : []) if (m && m.id) images.set(m.id, m);
  for (const m of Array.isArray(raw?.videos) ? raw.videos : []) if (m && m.id) videos.set(m.id, m);
  return { at: Number(raw?.at) || 0, images, videos };
}
export function getReference() {
  if (!reference) reference = indexRef(readJson(refFile(), {}));
  return reference;
}
export const referenceStale = () => Date.now() - getReference().at > REFERENCE_TTL_MS;
/** 参照库换新（images / videos = OpenRouter /images/models、/videos/models 的 data 数组）。 */
export function setReference({ images = [], videos = [] } = {}, { persist = true } = {}) {
  const raw = { at: Date.now(), images, videos };
  const before = reference ? hashOf([[...reference.images.values()], [...reference.videos.values()]]) : '';
  reference = indexRef(raw);
  if (persist) { try { writeJson(refFile(), raw, 0); } catch (e) { console.error('[studio] 参照库写不下去：', (e && e.message) || e); } }
  if (hashOf([images, videos]) !== before) bump();
}
/** 参照库里有没有这个模型（'google/<id>' 这种全名）：{ kind:'image'|'video', model } | null。 */
export function referenceModel(fullId) {
  const r = getReference();
  if (r.videos.has(fullId)) return { kind: 'video', model: r.videos.get(fullId) };
  if (r.images.has(fullId)) return { kind: 'image', model: r.images.get(fullId) };
  return null;
}

// —— 本人用过的模型（isNew）——
const seen = new Map();
const seenFile = (owner) => path.join(studioOwnerDir(owner || HOST_OWNER), 'seen.json');
function loadSeen(owner) {
  owner = owner || HOST_OWNER;
  let d = seen.get(owner);
  if (!d) { d = readJson(seenFile(owner), {}) || {}; seen.set(owner, d); }
  return d;
}
export const usedModel = (owner, key) => !!loadSeen(owner)[key];
export function markUsed(owner, key) {
  const d = loadSeen(owner);
  if (d[key]) return;
  d[key] = Date.now();
  const keys = Object.keys(d);
  if (keys.length > 2000) for (const k of keys.sort((a, b) => d[a] - d[b]).slice(0, keys.length - 2000)) delete d[k];
  try { writeJson(seenFile(owner), d, 0); } catch {}
}

export function _resetDiscoveryStoreForTests() { syncs.clear(); schemas.clear(); seen.clear(); reference = null; bump(); }
