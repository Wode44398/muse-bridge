// Media Studio 的媒体服务注册表（方案 §3.1）：一个「服务」= 一种方言（决定用哪个适配器）+ 连接参数 + 一组模型。
// 写法照 src/runtime/claude-providers.mjs（Claude 的自定义 API），按身份各一份：
//
//   <数据根>/studio-providers/providers.json            主机管理员（owner 'admin'）
//   <数据根>/studio-providers/users/<账号>/providers.json 成员（owner 'u:<账号>'），在主机数据根里、不在成员工作空间
//   同目录 connector-secrets.*                          API Key 与服务账号 JSON：AES-256-GCM + DPAPI（extension-secrets.mjs），不进明文 json
//
// 成员的限制照 Claude：最多 10 个、只许公网地址（路由层 assertPublicUrl）、不能用本机模型、不能共享、vertex 只能用自己的服务账号。
// 管理员的服务可标 shared：成员解析模型 / 列目录时并进来（findProvider / usableProviders），拿到的是管理员那份对象
// （owner = 'admin'，适配器据此取管理员的 Key）；成员看得到名字和模型，看不到地址和 Key，改 / 删 / 测试都够不着（getProvider 只认自己的）。
// 用共享服务花的是管理员的钱：计成员的媒体额度（jobs.mjs），自己的 Key 不计。

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { readSecrets, writeSecrets } from '@bridge/core/extension-secrets.mjs';
import { HOST_OWNER } from '@bridge/core/runtime/principal.mjs';
import { studioOwnerDir } from '@bridge/core/runtime/studio-settings.mjs';
import { DIALECTS, KINDS, AUTH_STYLES, DIALECT_AUTH, DIALECT_KINDS, NO_BASEURL, PRESET_BY_ID } from './presets.mjs';
import { syncView, dismissModels, dropSyncState } from './discovery/store.mjs';

export { HOST_OWNER };
export const MEMBER_MAX_PROVIDERS = 10;
// 一个服务最多多少个模型：聚合服务（OpenRouter / fal / Replicate）巡检会带回上百个备选
export const MAX_MODELS = 1500;
// 方言能不能自动发现模型（设置页据此显示「自动发现」开关；没有列表接口的不发现）
export const DISCOVERABLE = Object.freeze(['vertex', 'gemini', 'openrouter', 'replicate', 'fal', 'openai', 'elevenlabs']);
export const HOST_MAX_PROVIDERS = 40;

/** 这个身份能不能用 / 管 Media Studio，能的话回它的 owner 键（快照、分享、没开 Studio 的成员回 null）。 */
export function studioOwner(ctx) {
  if (!ctx || ctx.snap) return null;
  if (ctx.kind === 'admin') return HOST_OWNER;
  if (ctx.kind === 'user' && ctx.key && ctx.allowStudio) return ctx.key;
  return null;
}
export const isMemberOwner = (owner) => !!owner && owner !== HOST_OWNER;
const ownerOf = (owner) => owner || HOST_OWNER;

// —— 规范化（所有入口都过这里：坏值一律抛 400，给人看的中文）——
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const int = (v, lo, hi, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${what}要是 ${lo}–${hi} 之间的整数`);
  return n;
};
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const str = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export const ID_RE = /^p-[0-9a-f]{6,12}$/;
export const MODEL_ID_RE = /^[\w.:/@+-]{1,200}$/;
// 模型中心服务的 id（src/runtime/model-hub/registry.mjs 的 'h-' + 8 位十六进制）
export const HUB_REF_RE = /^h-[0-9a-f]{8}$/;
/** 这个服务归模型中心管（设置页的改 / 删 / 立即检查都不让碰，见方案 §3.8）。 */
export const isManaged = (p) => !!p && p.managedBy === 'hub';
export const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
export const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'authorization', 'x-api-key', 'x-goog-api-key', 'xi-api-key', 'content-type', 'accept-encoding']);
const LOC_RE = /^[a-z0-9-]{2,40}$/;
const PROJECT_RE = /^[a-z0-9-]{3,63}$/i;

export function normalizeBaseUrl(v, { required = true } = {}) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) { if (required) throw bad('接口地址不能为空'); return ''; }
  let u;
  try { u = new URL(s); } catch { throw bad('接口地址不是合法网址'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('接口地址只支持 http / https');
  if (u.username || u.password) throw bad('接口地址里别带账号密码，API Key 单独填');
  if (u.search || u.hash) throw bad('接口地址里别带 ? 参数或 #');
  return s;
}

// 请求头：对象 { 名: 值 } 或 [{ name, value }] 都收，存成对象
function normalizeHeaders(h) {
  const list = Array.isArray(h) ? h : (h && typeof h === 'object' ? Object.entries(h).map(([name, value]) => ({ name, value })) : []);
  const out = {};
  for (const x of list.slice(0, 16)) {
    const name = String(x?.name ?? '').trim();
    if (!name) continue;
    if (!HEADER_RE.test(name)) throw bad(`请求头名「${name.slice(0, 40)}」不合法`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw bad(`请求头「${name}」由 bridge 自己管，不能自定义`);
    out[name] = String(x?.value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
  }
  return out;
}

// 额外请求体 / 模型默认参数：JSON 对象（字符串也收），上限 8000 字符
function normalizeObj(v, what) {
  if (v === undefined || v === null || v === '') return {};
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { throw bad(`${what}不是合法 JSON：${(e && e.message) || ''}`); } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad(`${what}要是 JSON 对象（{…}）`);
  const s = JSON.stringify(o);
  if (s.length > 8000) throw bad(`${what}太长（上限 8000 字符）`);
  if (/"(__proto__|constructor|prototype)"\s*:/.test(s)) throw bad(`${what}里有不允许的键`);
  return JSON.parse(s);
}

function normalizeModel(x, i, dialect) {
  const id = String(x?.id ?? '').trim();
  if (!MODEL_ID_RE.test(id)) throw bad(`第 ${i + 1} 个模型的 ID 不合法（字母数字与 . _ - / : @ +，最长 200）`);
  const kind = oneOf(x.kind, KINDS, '');
  if (!kind) throw bad(`模型「${id}」要选种类（图像 / 视频 / 配音 / 音乐）`);
  if (!DIALECT_KINDS[dialect].includes(kind)) throw bad(`这个方言不能做「${kind}」（模型「${id}」）`);
  return {
    id,
    label: str(x.label, 80) || id,
    kind,
    enabled: x.enabled !== false,
    source: oneOf(x.source, ['builtin', 'remote', 'manual'], 'manual'),
    ...(x.card && typeof x.card === 'string' && x.card.length <= 120 ? { card: x.card } : {}),
    defaults: normalizeObj(x.defaults, `模型「${id}」的默认参数`),
    // 自动识别（§9.3）：发现时间、备选（聚合服务第一次巡检建底的）、上游已下架、厂商前缀
    ...(Number.isFinite(Number(x.discoveredAt)) && Number(x.discoveredAt) > 0 ? { discoveredAt: Number(x.discoveredAt) } : {}),
    ...(x.shelf === true ? { shelf: true } : {}),
    ...(x.gone === true ? { gone: true } : {}),
    ...(typeof x.vendor === 'string' && /^[\w.-]{1,40}$/.test(x.vendor) ? { vendor: x.vendor } : {}),
  };
}

function normalizeGoogle(g, prev) {
  g = { ...(prev || {}), ...(g && typeof g === 'object' ? g : {}) };
  const project = str(g.project, 63);
  if (project && !PROJECT_RE.test(project)) throw bad('Google 项目 ID 不合法');
  const location = str(g.location, 40) || 'global';
  const mediaLocation = str(g.mediaLocation, 40) || 'us-central1';
  if (!LOC_RE.test(location) || !LOC_RE.test(mediaLocation)) throw bad('区域名不合法（如 global、us-central1）');
  return { project, location, mediaLocation, credMode: oneOf(g.credMode, ['adc', 'json'], 'adc') };
}

export function normalizeProvider(input, prev = null) {
  const p = { ...(prev || {}), ...(input || {}) };
  const preset = PRESET_BY_ID[str(p.preset, 24)] ? str(p.preset, 24) : 'custom';
  const dialect = oneOf(p.dialect, DIALECTS, PRESET_BY_ID[preset]?.dialect || '');
  if (!dialect) throw bad('要选一种方言（决定怎么调这个服务）');
  const models = (Array.isArray(p.models) ? p.models : []).slice(0, MAX_MODELS).map((x, i) => normalizeModel(x, i, dialect));
  const seen = new Set();
  for (const x of models) { if (seen.has(x.id)) throw bad(`模型「${x.id}」重复了`); seen.add(x.id); }
  const out = {
    id: prev?.id || p.id,
    name: str(p.name, 40) || PRESET_BY_ID[preset]?.name || '未命名服务',
    note: str(p.note, 80),
    preset,
    dialect,
    enabled: p.enabled !== false,
    shared: p.shared === true,
    autoSync: p.autoSync !== false,
    baseUrl: NO_BASEURL.has(dialect) ? '' : normalizeBaseUrl(p.baseUrl),
    authStyle: oneOf(p.authStyle, AUTH_STYLES, DIALECT_AUTH[dialect]),
    headers: normalizeHeaders(p.headers),
    timeoutSec: int(p.timeoutSec, 10, 3600, '超时') ?? 600,
    retries: int(p.retries, 0, 5, '重试次数') ?? 1,
    models,
    params: normalizeObj(p.params, '额外请求体'),
    ...(dialect === 'vertex' ? { google: normalizeGoogle(input?.google, prev?.google) } : {}),
    ...(p.importedFrom === 'vertex' ? { importedFrom: 'vertex', importedAt: Number(p.importedAt) || Date.now() } : {}),
    // 模型中心托管（方案 §3.8）：两个字段同进同出，只有桥接对象（hub-bridge.mjs）写；给 managedBy:'' 就是取消托管
    ...(p.managedBy === 'hub' && HUB_REF_RE.test(String(p.hubRef || '')) ? { managedBy: 'hub', hubRef: String(p.hubRef) } : {}),
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  return out;
}

// —— 存储（按 owner 一份）——
const regs = new Map();   // owner → { rev, providers }
function load(owner) {
  owner = ownerOf(owner);
  const hit = regs.get(owner);
  if (hit) return hit;
  const raw = readJson(path.join(studioOwnerDir(owner), 'providers.json'), {});
  const list = [];
  for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
    if (!p || !ID_RE.test(String(p.id || ''))) continue;
    try { list.push({ ...normalizeProvider(p, p), updatedAt: p.updatedAt || Date.now(), owner }); }
    catch (e) { console.error('[studio] 跳过坏掉的服务', p.id, e && e.message); }
  }
  const d = { rev: Number.isFinite(raw.rev) ? raw.rev : 0, providers: list };
  regs.set(owner, d);
  return d;
}
const withoutOwner = ({ owner, ...p }) => p;
function save(owner) {
  const d = load(owner);
  d.rev += 1;
  writeJson(path.join(studioOwnerDir(owner), 'providers.json'), { rev: d.rev, providers: d.providers.map(withoutOwner) }, 2);
}

const listeners = new Set();
/** 注册表变了：fn(owner)。路由层据此推总线、catalog 换新。 */
export function onProvidersChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(owner) { for (const fn of listeners) { try { fn(owner); } catch {} } }

export const loadedOwners = () => [...regs.keys()];
export function providersRev(owner) {
  const own = load(owner).rev;
  return isMemberOwner(owner) ? `${own}+${load(HOST_OWNER).rev}` : own;
}
/** 只认自己那份（改 / 删 / 测试 / 拉列表 / 日志都用它）。 */
export function getProvider(id, owner) { return load(owner).providers.find((p) => p.id === id) || null; }
/** 管理员共享给这个成员的（管理员自己的本来就在他那份里）。 */
export function sharedProviders(owner) { return isMemberOwner(owner) ? load(HOST_OWNER).providers.filter((p) => p.shared) : []; }
/** 解析模型、列目录用：先找自己的，成员再找管理员共享的。 */
export function findProvider(id, owner) { return getProvider(id, owner) || sharedProviders(owner).find((p) => p.id === id) || null; }
/** 自己的在前、管理员共享的其次（id 撞了算自己的）。 */
export function usableProviders(owner) {
  const own = load(owner).providers;
  const extra = sharedProviders(owner);
  if (!extra.length) return own;
  const seen = new Set(own.map((p) => p.id));
  return [...own, ...extra.filter((p) => !seen.has(p.id))];
}
export function hostProviders() { return load(HOST_OWNER).providers; }

// —— 密钥：{ <服务 id>: { key?, sa? } }——
function secrets(owner) {
  try { return readSecrets(studioOwnerDir(owner)); } catch (e) { console.error('[studio] 密钥读不出来：', e && e.message); return {}; }
}
/** 服务的 Key 与服务账号 JSON（适配器用；按服务对象的 owner 取——共享服务取的是管理员那份）。 */
export function providerSecret(p) {
  const s = secrets(p.owner)[p.id] || {};
  return { key: typeof s.key === 'string' ? s.key : '', sa: typeof s.sa === 'string' ? s.sa : '' };
}
function setSecret(id, owner, patch) {
  const map = { ...secrets(owner) };
  const cur = { ...(map[id] || {}) };
  for (const [k, v] of Object.entries(patch)) { if (v) cur[k] = v; else delete cur[k]; }
  if (Object.keys(cur).length) map[id] = cur; else delete map[id];
  writeSecrets(studioOwnerDir(owner), map);   // 失败就抛——绝不退回明文
}

// 服务账号 JSON：只认 service_account（有 client_email + private_key）；存原文
export function parseServiceAccount(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (s.length > 20_000) throw bad('服务账号 JSON 太大');
  let o; try { o = JSON.parse(s); } catch { throw bad('服务账号不是合法 JSON'); }
  if (!o || o.type !== 'service_account' || !o.client_email || !o.private_key) throw bad('要的是服务账号密钥（type 为 service_account，含 client_email 与 private_key）');
  return o;
}
const saInfo = (sa) => { try { const o = JSON.parse(sa); return { saEmail: String(o.client_email || ''), saProject: String(o.project_id || '') }; } catch { return { saEmail: '', saProject: '' }; } };

/** 给前端的视图：不带完整密钥，只给尾 4 位；vertex 方言另给服务账号的邮箱与项目；托管服务带 managed / hubRef（§3.8）。 */
export function publicProvider(p) {
  const { key, sa } = providerSecret(p);
  return {
    ...withoutOwner(p), hasKey: !!key, keyTail: key ? key.slice(-4) : '',
    managed: isManaged(p), hubRef: isManaged(p) ? p.hubRef : '',
    ...(DISCOVERABLE.includes(p.dialect) ? { sync: syncView(p.owner, p.id) } : {}),
    ...(p.dialect === 'vertex' ? { hasServiceAccount: !!sa, ...(sa ? saInfo(sa) : { saEmail: '', saProject: '' }) } : {}),
  };
}
export function listProviders(owner) { return load(owner).providers.map(publicProvider); }
/** 成员设置页看的共享服务：名字、预设、方言、模型，不给地址、请求头、Key。 */
export function sharedProvidersView(owner) {
  return sharedProviders(owner).map((p) => ({
    id: p.id, name: p.name, note: p.note, preset: p.preset, dialect: p.dialect, enabled: p.enabled,
    models: p.models.filter((x) => x.enabled).map((x) => ({ id: x.id, label: x.label, kind: x.kind })),
  }));
}

function memberChecks(p, owner) {
  if (!isMemberOwner(owner)) return;
  if (p.dialect === 'local') throw bad('本机模型只有主机管理员能接');
  if (p.dialect === 'vertex' && p.google?.credMode !== 'json') throw bad('成员接 Vertex 要用自己的服务账号 JSON');
}
function takeSecrets(input) {
  const out = {};
  if (typeof input?.apiKey === 'string') {
    const key = input.apiKey.trim();
    if (key.length > 4000) throw bad('API Key 太长');
    out.key = key;
  }
  if (typeof input?.serviceAccount === 'string') {
    const sa = input.serviceAccount.trim();
    if (sa) parseServiceAccount(sa);
    out.sa = sa;
  }
  return out;
}

export function createProvider(input, owner) {
  owner = ownerOf(owner);
  const d = load(owner);
  const max = isMemberOwner(owner) ? MEMBER_MAX_PROVIDERS : HOST_MAX_PROVIDERS;
  if (d.providers.length >= max) throw bad(`媒体服务最多 ${max} 个`);
  const taken = new Set(usableProviders(owner).map((x) => x.id));
  let id;
  do id = 'p-' + randomBytes(4).toString('hex'); while (taken.has(id));
  const p = { ...normalizeProvider({ ...input, id, ...(isMemberOwner(owner) ? { shared: false } : {}) }), owner };
  memberChecks(p, owner);
  const sec = takeSecrets(input);
  if (Object.keys(sec).length) setSecret(id, owner, sec);
  d.providers.push(p);
  save(owner); changed(owner);
  return publicProvider(p);
}

export function updateProvider(id, patch, owner) {
  owner = ownerOf(owner);
  const d = load(owner);
  const i = d.providers.findIndex((p) => p.id === id);
  if (i < 0) throw Object.assign(new Error('没有这个媒体服务'), { status: 404 });
  const prev = d.providers[i];
  // 设置页回传的模型条目不带发现元数据（discoveredAt / shelf / gone / vendor）：按 id 从旧条目补回；显式给了的以给的为准
  if (patch && Array.isArray(patch.models)) {
    const old = new Map(prev.models.map((m) => [m.id, m]));
    patch = { ...patch, models: patch.models.map((m) => {
      const o = m && old.get(String(m.id ?? '').trim());
      if (!o) return m;
      const keep = {};
      for (const k of ['discoveredAt', 'shelf', 'gone', 'vendor']) if (o[k] !== undefined && !(k in m)) keep[k] = o[k];
      return { ...keep, ...m };
    }) };
  }
  const next = { ...normalizeProvider({ ...patch, id, ...(isMemberOwner(owner) ? { shared: false } : {}) }, prev), owner };
  memberChecks(next, owner);
  // apiKey / serviceAccount：字符串 = 换新；空串 = 清掉；不传 = 不动
  const sec = takeSecrets(patch);
  if (Object.keys(sec).length) setSecret(id, owner, sec);
  // 在设置里删掉的模型记下来，巡检别再从上游目录把它加回来；重新加回的移出
  if (patch && Array.isArray(patch.models)) {
    const ids = new Set(next.models.map((m) => m.id));
    const removed = prev.models.filter((m) => !ids.has(m.id)).map((m) => m.id);
    dismissModels(owner, id, removed, [...ids]);
  }
  d.providers[i] = next;
  save(owner); changed(owner);
  return publicProvider(next);
}

/**
 * 巡检写模型（discovery 用）：fn(models 的副本) → 新 models 或 null（不变）。规范化后有变化才落盘、推总线。回 true = 改了。
 */
export function patchModels(id, owner, fn) {
  owner = ownerOf(owner);
  const d = load(owner);
  const i = d.providers.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const cur = d.providers[i];
  const out = fn(cur.models.map((m) => ({ ...m })));
  if (!out) return false;
  const models = out.slice(0, MAX_MODELS).map((x, k) => normalizeModel(x, k, cur.dialect));
  if (JSON.stringify(models) === JSON.stringify(cur.models)) return false;
  d.providers[i] = { ...cur, models, updatedAt: Date.now() };
  save(owner); changed(owner);
  return true;
}
/** 只推一次总线（巡检状态变了、模型没变：设置页要看到「上次检查」）。 */
export function touchProviders(owner) { changed(ownerOf(owner)); }

export function deleteProvider(id, owner) {
  owner = ownerOf(owner);
  const d = load(owner);
  const i = d.providers.findIndex((p) => p.id === id);
  if (i < 0) return false;
  d.providers.splice(i, 1);
  try { setSecret(id, owner, { key: '', sa: '' }); } catch {}
  try { dropSyncState(owner, id); } catch {}
  save(owner); changed(owner);
  return true;
}

// —— 模型键：'<服务 id>/<模型 id>'（模型 id 自己可以带斜杠，按第一个斜杠切）——
export const modelKey = (pid, mid) => `${pid}/${mid}`;
export function parseModelKey(key) {
  const s = String(key || '');
  const i = s.indexOf('/');
  if (i < 0) return null;
  const pid = s.slice(0, i), mid = s.slice(i + 1);
  return ID_RE.test(pid) && MODEL_ID_RE.test(mid) ? { pid, mid } : null;
}

export function _resetProvidersForTests() { regs.clear(); }
