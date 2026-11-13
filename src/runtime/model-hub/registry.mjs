// 模型中心的注册表（v2，2026-11-10）：加一次、各 agent 都能用的模型服务，外加内置的 Vertex。
//
// 以前同一个中转站 / 同一把 Key 要在「设置 › Claude › 模型服务」和 dimensio 的「模型服务」里各填一遍，Key 轮换、额度用尽也各管各的。
// 这里的服务只填一次，去向细到每个模型（契约 §5）：
//   · 文本模型 → claude / dimensio：经 model-services（插件供模型的那条路）注进它们的模型列表，models[i].agents 带上；
//     请求都打到本机的模型网关（gateway.mjs），线路与 Key 在网关那头统一取、统一换（pool.mjs）。
//   · 媒体模型（图像 / 视频 / 配音 / 音乐）→ studio：同步成 Media Studio 里的一个托管服务（studio-link.mjs），由 Studio 的驱动去调。
//
// 落盘：<数据根>/model-hub/services.json（地址、已添加的模型、线路；不含 Key）+ 同目录 connector-secrets.*（Key，AES-GCM + DPAPI）
//       + catalog/<服务 id>.json（识别出的模型目录，catalog.mjs）。
//   { v: 2, vertex: { enabled, agents, members, models: [型号 id], location }, services: [ 服务 ],
//     pendingStudioRemovals?: [服务 id]（删服务时 Studio 不在 / 报错、还没删掉的托管服务：Studio 回来后对账时补删）}
//   服务：{ id: 'h-<8 位>', name, kind（文本接口协议）, baseUrl, authStyle, headers, members（共享给成员，Studio 一侧同步成 shared）,
//           enabled, strategy, useProxy, timeoutSec, lines: [{ id, label, baseUrl（空 = 用服务的）, enabled }], defaultModel, createdAt, detectedAt?,
//           models: [{ id, label?, kind, agents, contextWindow?, maxOutput?, vision? }]（只存「已添加」的：没有去向 = 没添加）,
//           studio?: { id: Studio 托管服务的 id, dialect }, studioDirty?: true（媒体部分有改动没同步成：Studio 回来后补推）}
// v1 → v2：读到 v:1 时在内存里升级（v1 只有文本这一条路：原来填的型号一律按文本、去向 = 原服务级 agents——升级不改变已经发布出去的集合），
// 第一次升级时把原文件备份成 services.v1.bak.json；下次保存时写 v:2。服务级 agents 不再存，视图里给并集。
// 校验（契约 §5.4）：文本 → {claude, dimensio}（Gemini 协议去掉 claude；给 claude 的 id 要合 Claude 的规则、上下文窗口至少 4096）；
// 媒体 → {studio} 且种类在这个服务的媒体接口能做的范围内；other（向量、识别一类）不可添加。Vertex 这次不动：仍是服务级 agents。
// Studio 的桥要等扩展加载完才有：启动时 server.mjs 在 loadModules 之后调 reconcileStudio() 对一次账（补删、补推、孤儿托管服务取消托管）。
import { randomBytes } from 'node:crypto';
import { mkdirSync, copyFileSync, existsSync, constants as fsc } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../paths.mjs';
import { readJson, writeJson } from '../../jsonfile.mjs';
import { readSecrets, writeSecrets } from '../../extension-secrets.mjs';
import { provideModelService, MODEL_AGENTS } from '../model-services.mjs';
import { guessModel, routeOf, providerOf, vendorOf, MODALITIES } from '../../model-knowledge/index.mjs';
import { ensureGateway, gatewayUrl, setServiceResolver, registerUpstream } from './gateway.mjs';
import { makePoolHandler, lineState, forgetService, clearCooldown, defaultAuthStyle, BAD_KEY_RE, BAD_KEY_MSG } from './pool.mjs';
import { handleVertex, vertexConfigured, VERTEX_KNOWN_MODELS, VERTEX_DEFAULT_MODELS } from './vertex.mjs';
import {
  setCatalogRoot, readCatalog, writeCatalog, mergeCatalog, addCatalogModel, removeCatalog, catalogMeta, cleanCatalogModel, CATALOG_MAX,
  _resetCatalogCacheForTests,
} from './catalog.mjs';
import {
  NO_STUDIO, studioBridge, mediaInfo, mediaLine, studioModels, syncStudio, removeStudio, adoptStudio, releaseStudio, fromStudioKind,
  primeStudioKey,
} from './studio-link.mjs';
import { detectModels } from './detect.mjs';
import { NATIVE_VENDOR_IDS, nativeVendor, nativeVendorOf, nativeEndpoint } from '../../model-knowledge/dimensio-native.mjs';

export const HUB_PLUGIN = 'model-hub';
export const HUB_NAME = '模型中心';
export const VERTEX_ID = 'vertex';
const KINDS = ['openai', 'anthropic', 'gemini'];
const AUTH_STYLES = ['bearer', 'x-api-key', 'goog', 'none'];
const MODEL_ID_RE = /^[^\s\u0000-\u001f]{1,200}$/;
const CLAUDE_ID_RE = /^[\w.:\/@+-]{1,200}$/;   // Claude 自定义服务的模型 id 规则（claude-providers.mjs），不合的进不了它的菜单
// Claude 能用的最小上下文窗口：claude-providers.mjs normalizeModel 里 int(m.contextWindow, 4096, 4_000_000)，小于它的模型会被 Claude 那边静默跳过
const CLAUDE_MIN_CTX = 4096;
const HUB_ID_RE = /^h-[0-9a-f]{8}$/;
const MAX_PENDING = 200;
const STUDIO_ID_RE = /^p-[0-9a-f]{6,12}$/;
const MAX_SERVICES = 40, MAX_LINES = 30, MAX_TEXT = 100, MAX_MEDIA = 1500;   // 媒体上限 = Studio 一个服务的模型上限
const TEXT_AGENTS = MODEL_AGENTS;
const ALL_AGENTS = [...MODEL_AGENTS, 'studio'];   // 视图里去向的顺序固定：claude → dimensio → studio
const KIND_NAME = { text: '文本', image: '图像', video: '视频', voice: '配音', music: '音乐' };
// update 收的字段（模型与去向只走 assign：一个入口校验、一个入口同步 Studio）
const UPDATE_FIELDS = ['name', 'baseUrl', 'enabled', 'strategy', 'useProxy', 'timeoutSec', 'headers', 'lines', 'members', 'authStyle', 'defaultModel'];
// 改了这些要同步给 Studio 的托管服务（名字、地址、Key、启停、请求头、鉴权、共享给成员）
const STUDIO_FIELDS = ['name', 'baseUrl', 'enabled', 'headers', 'lines', 'authStyle', 'members'];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('没有这个服务'), { status: 404 });
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');
const newId = (p) => p + randomBytes(4).toString('hex');
const posInt = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const short = (id) => String(id).slice(0, 60);

let dirOverride = '';
const dir = () => dirOverride || path.join(DATA_ROOT, 'model-hub');
const file = () => path.join(dir(), 'services.json');
setCatalogRoot(() => dir());   // 目录跟着注册表的数据目录走（测试换目录时一起换）

let data = null;
function load() {
  if (data) return data;
  const raw = readJson(file(), null);
  const v1 = !!raw && raw.v !== 2 && Array.isArray(raw.services);
  if (v1) backupV1();
  const services = [], unreadable = [];
  for (const s0 of Array.isArray(raw?.services) ? raw.services : []) {
    try {
      const s = normalizeService(v1 ? upgradeV1(s0) : s0, null, { lenient: true });
      if (services.some((x) => x.id === s.id)) continue;
      services.push(s);
      if (v1) seedV1Catalog(s, s0);
    } catch (e) {
      if (HUB_ID_RE.test(String(s0?.id || ''))) unreadable.push(s0.id);
      console.error('[model-hub] 有个服务读不出来，跳过：', e?.message || e);
    }
  }
  data = {
    vertex: normalizeVertex(raw?.vertex && typeof raw.vertex === 'object' ? raw.vertex : {}, null), services,
    pendingStudioRemovals: cleanPending(raw?.pendingStudioRemovals),
    flags: cleanFlags(raw?.flags),
    migrated: cleanMigrated(raw?.migrated),
    // 只在内存：services.json 在却读不出（坏了）/ 有服务没读出来——对账时这些服务的 Studio 托管服务别当孤儿取消托管
    suspect: existsSync(file()) && !Array.isArray(raw?.services), unreadable,
  };
  return data;
}
function save() {
  mkdirSync(dir(), { recursive: true });
  const pending = data.pendingStudioRemovals || [];
  const flags = data.flags || {};
  const migrated = data.migrated || {};
  writeJson(file(), {
    v: 2, vertex: data.vertex, services: data.services,
    ...(pending.length ? { pendingStudioRemovals: pending } : {}),
    ...(Object.keys(flags).length ? { flags } : {}),
    ...(Object.keys(migrated).length ? { migrated } : {}),
  }, 2);
}

// 迁移台账（2026-11-13，老配置统一并进模型中心，见 legacy-migrate.mjs）：
//   { claude | dimensio | studio: { 原服务 id: 模型中心服务 id | 'vertex' | 'local' } }
// 记过的原服务不再迁、总览里不再单列；原件本身留着（Claude / dimensio 的只是从菜单里藏起来，记着它的老会话照常能跑）。
const MIGRATE_SOURCES = ['claude', 'dimensio', 'studio'];
const MIGRATED_TO_RE = /^(h-[0-9a-f]{8}|vertex|local)$/;
function cleanMigrated(v) {
  const out = {};
  for (const src of MIGRATE_SOURCES) {
    const m = v && typeof v === 'object' && v[src] && typeof v[src] === 'object' ? v[src] : null;
    if (!m) continue;
    const one = {};
    for (const [k, to] of Object.entries(m)) if (/^[\w.-]{1,80}$/.test(k) && MIGRATED_TO_RE.test(String(to))) one[k] = String(to);
    if (Object.keys(one).length) out[src] = one;
  }
  return out;
}
/** 迁移台账里这个来源的全部记录 { 原 id: 去处 }（副本）。 */
export function migratedOf(src) { return { ...(load().migrated?.[src] || {}) }; }
/** 记一笔：原服务 id 已经并到 to（模型中心服务 id / 'vertex' / 'local'）。 */
export function markMigrated(src, id, to) {
  if (!MIGRATE_SOURCES.includes(src)) throw bad('没有这个来源');
  if (!MIGRATED_TO_RE.test(String(to))) throw bad('去处不合法');
  const d = load();
  d.migrated = { ...(d.migrated || {}), [src]: { ...(d.migrated?.[src] || {}), [String(id)]: String(to) } };
  save(); notify();
}
// 一次性事项的记号（做过就不再做）。dimensioNative = dimensio 自带适配的那几家厂商已经交给模型中心（见 dimensio-native.mjs）。
const FLAG_NAMES = ['dimensioNative'];
function cleanFlags(v) {
  const out = {};
  for (const k of FLAG_NAMES) if (v && typeof v === 'object' && v[k] === true) out[k] = true;
  return out;
}
export function hubFlag(name) { return load().flags?.[name] === true; }
export function setHubFlag(name, on = true) {
  if (!FLAG_NAMES.includes(name)) throw bad('没有这个记号');
  const d = load();
  if ((d.flags?.[name] === true) === (on === true)) return;
  d.flags = { ...(d.flags || {}) };
  if (on === true) d.flags[name] = true; else delete d.flags[name];
  save(); changed();
}
/** 改动前留一份 services.json 的副本（已有同名副本就不覆盖）。读不到原文件 = 没什么可备份的。 */
export function backupHubFile(name) {
  if (!/^[a-z0-9.-]{1,40}$/.test(name)) throw bad('备份名不合法');
  try { copyFileSync(file(), path.join(dir(), name), fsc.COPYFILE_EXCL); }
  catch (e) { if (e?.code !== 'EEXIST' && e?.code !== 'ENOENT') console.error('[model-hub] services.json 没备份成：', e?.message || e); }
}
function cleanPending(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) if (HUB_ID_RE.test(String(x)) && !out.includes(x)) out.push(x);
  return out.slice(-MAX_PENDING);
}

// —— v1 升级 ——
// 原文件只备份一次（COPYFILE_EXCL：已经有备份就不覆盖——第二次读到 v1 说明上次升级后还没保存过，第一份才是真原件）
function backupV1() {
  try { copyFileSync(file(), path.join(dir(), 'services.v1.bak.json'), fsc.COPYFILE_EXCL); }
  catch (e) { if (e?.code !== 'EEXIST') console.error('[model-hub] v1 的 services.json 没备份成：', e?.message || e); }
}
function upgradeV1(s0) {
  const s = s0 && typeof s0 === 'object' ? s0 : {};
  const kind = KINDS.includes(s.kind) ? s.kind : 'openai';
  const agents = Array.isArray(s.agents) ? TEXT_AGENTS.filter((a) => s.agents.includes(a)) : [...TEXT_AGENTS];
  const { agents: _drop, ...rest } = s;
  return {
    ...rest,
    models: (Array.isArray(s.models) ? s.models : []).map((m) => {
      const o = typeof m === 'string' ? { id: m } : m && typeof m === 'object' ? m : {};
      // v1 只有文本这一条路：原来填的型号一律按文本、去向 = 原服务级 agents——升级前后发布出去的集合不变
      // （名字像生图 / 配音的也照旧：OpenRouter 上 gemini-*-image 这类本来就走对话接口，老会话还记着它；
      // 真是纯媒体的，用户在目录里改种类再加到 Media Studio）。去向照常过校验：Gemini 协议、Claude 的 id / 上下文规则不合的静默去掉 claude
      return { ...o, kind: 'text', agents };
    }),
    kind,
  };
}
// v1 的服务没有目录：把原来填的型号（含服务级去向为空、没算已添加的）当手动项种进去，重识别也不会被冲掉。
// 目录已经有了（升级后又退回过 v1 再升上来）：只补目录里没有的
function seedV1Catalog(s, s0) {
  try {
    const c = readCatalog(s.id);
    const have = new Set(c.models.map((m) => m.id));
    const list = (Array.isArray(s0?.models) ? s0.models : []).map((m) => {
      const o = typeof m === 'string' ? { id: m } : m && typeof m === 'object' ? m : {};
      const added = s.models.find((x) => x.id === str(o.id, 200));
      return { ...o, kind: added ? added.kind : undefined, source: 'manual' };
    }).filter((o) => !have.has(str(o.id, 200)));
    if (!list.length) return;
    writeCatalog(s.id, { at: c.at || Date.now(), models: [...c.models, ...list], media: c.media });
  } catch (e) { console.error('[model-hub] v1 服务的目录没种上：', e?.message || e); }
}

// —— Key ——
// 密文表读不出来（文件坏了 / 数据密钥不见了 / 解不开）回 null：读的地方当作没有 Key，写的地方（setKeys）一律拒绝——
// 拿空表去覆盖会把所有服务的 Key 一起清掉
function secretsOrNull() {
  try { return readSecrets(dir()); } catch (e) { console.error('[model-hub] Key 存储读不出来：', e?.message || e); return null; }
}
const secrets = () => secretsOrNull() || {};
const keyIn = (map, sid, lid) => { const s = map[sid + '/' + lid]; return s && typeof s.key === 'string' ? s.key : ''; };
const keyOf = (sid, lid) => keyIn(secrets(), sid, lid);
const KEYS_UNREADABLE = 'Key 存储读不出来（密钥文件损坏或解不开，详情见服务器日志）：为免把已存的 Key 一起清掉，这次没有保存';
function setKeys(changes) {   // [[服务, 线路, key | '' = 删]]
  if (!changes.length) return;
  const cur = secretsOrNull();
  if (!cur) throw Object.assign(new Error(KEYS_UNREADABLE), { status: 500 });
  const map = { ...cur };
  for (const [sid, lid, key] of changes) { if (key) map[sid + '/' + lid] = { key }; else delete map[sid + '/' + lid]; }
  writeSecrets(dir(), map);   // 失败就抛——绝不退回明文
}

// —— 规范化 ——
function normalizeAgents(v, kind, dflt) {   // 只给 Vertex 用（服务级去向）
  const list = Array.isArray(v) ? MODEL_AGENTS.filter((a) => v.includes(a)) : dflt;
  return kind === 'gemini' ? list.filter((a) => a !== 'claude') : list;
}
function modelIds(v) {   // Vertex 的型号只存 id
  const seen = new Set(), out = [];
  for (const m of Array.isArray(v) ? v : []) {
    const id = str(typeof m === 'string' ? m : m?.id, 200);
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id); out.push(id);
    if (out.length >= MAX_TEXT) break;
  }
  return out;
}
function normalizeUrl(v, what) {
  let u;
  try { u = new URL(str(v, 500)); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw 0; } catch { throw bad(`${what}要是 http(s) 地址`); }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}
// 请求头名按 RFC 7230 token（同 Studio 的 HEADER_RE：收编来的 X_Tenant、x.trace 这类不能在下次同步时被清掉；undici 也收这些名字）
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
function cleanHeaders(v) {
  return (Array.isArray(v) ? v : [])
    .filter((h) => h && HEADER_NAME_RE.test(h.name || '') && typeof h.value === 'string' && !/^(authorization|x-api-key|x-goog-api-key|host|content-length)$/i.test(h.name))
    .slice(0, 20).map((h) => ({ name: h.name, value: h.value.replace(/[\r\n]+/g, ' ').slice(0, 2000) }));   // 值里的换行同 Studio 换成空格
}
function normalizeVertex(v, prev) {
  const p = prev || { enabled: true, agents: [...MODEL_AGENTS], members: false, models: [...VERTEX_DEFAULT_MODELS], location: '' };
  const models = Array.isArray(v.models) ? modelIds(v.models) : p.models;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : p.enabled,
    agents: normalizeAgents(v.agents, 'vertex', p.agents),
    members: typeof v.members === 'boolean' ? v.members : p.members,
    models: models.length ? models : [...VERTEX_DEFAULT_MODELS],
    location: /^[a-z0-9-]{0,40}$/.test(String(v.location ?? '')) ? String(v.location ?? p.location) : p.location,
  };
}

/**
 * 一个模型的一个去向哪里不对 → 人话；没问题回 ''。
 * mediaKinds：() => 这个服务的媒体接口能做的种类（可能抛「没有启用 Media Studio」）；null = 不查（读盘、收编时）。
 * ctx：文本模型的上下文窗口（没有 = 不查）。
 */
function agentProblem(id, kind, a, protocol, mediaKinds, ctx) {
  if (!ALL_AGENTS.includes(a)) return `不认识的去向「${String(a).slice(0, 20)}」`;
  if (kind === 'text') {
    if (a === 'studio') return '文本模型不能添加到 Media Studio';
    if (a === 'claude' && protocol === 'gemini') return 'Gemini 协议的服务不能给 Claude';
    if (a === 'claude' && !CLAUDE_ID_RE.test(id)) return `「${short(id)}」里有 Claude 不认的字符（只能是字母、数字和 _ . : / @ + -），不能给 Claude`;
    if (a === 'claude' && ctx && ctx < CLAUDE_MIN_CTX) return `「${short(id)}」的上下文窗口只有 ${ctx}，Claude 至少要 ${CLAUDE_MIN_CTX}，不能给 Claude`;
    return '';
  }
  if (a !== 'studio') return `${KIND_NAME[kind]}模型只能添加到 Media Studio`;
  if (mediaKinds && !mediaKinds().includes(kind)) return `这个服务的媒体接口做不了${KIND_NAME[kind]}，「${short(id)}」不能添加到 Media Studio`;
  return '';
}
// 去向清洗：strict（用户这次明确给的）= 有一个不对就 400；否则（读盘、默认值）不对的静默去掉
function cleanAgents(id, kind, list, protocol, { strict, mediaKinds = null, ctx }) {
  const out = [];
  for (const a of list) {
    const why = agentProblem(id, kind, a, protocol, mediaKinds, ctx);
    if (why) { if (strict) throw bad(why); continue; }
    if (!out.includes(a)) out.push(a);
  }
  return ALL_AGENTS.filter((a) => out.includes(a));
}
// 不带种类 = 文本（老接口、Claude / dimensio 收编来的都是文本）；Studio 的叫法 speech = 配音
function modelKind(v) {
  if (v === undefined || v === null || v === '') return 'text';
  if (v === 'speech') return 'voice';
  return typeof v === 'string' ? v : '';
}
function caps(o) {
  const ctx = posInt(o?.contextWindow, 1024, 4_000_000), out = posInt(o?.maxOutput, 256, 1_000_000);
  return { ...(ctx ? { contextWindow: ctx } : {}), ...(out ? { maxOutput: out } : {}), ...(typeof o?.vision === 'boolean' ? { vision: o.vision } : {}) };
}
/**
 * 已添加模型的清单 → [{ id, label?, kind, agents, contextWindow?, maxOutput?, vision? }]。没有去向的不算添加（不存）。
 * dflt = 没带 agents 的模型用的去向（老接口的服务级 agents）；只有模型自己明确带了 agents 且 strict 时去向不对才报错。
 */
function normalizeModels(v, protocol, { strict = false, dflt = TEXT_AGENTS } = {}) {
  const seen = new Set(), out = [];
  let nText = 0, nMedia = 0;
  for (const m of Array.isArray(v) ? v : []) {
    const o = m && typeof m === 'object' ? m : {};
    const id = str(typeof m === 'string' ? m : o.id, 200);
    if (!MODEL_ID_RE.test(id)) { if (strict && id) throw bad(`型号 ID「${id.slice(0, 40)}」不合法（不能有空白）`); continue; }
    if (seen.has(id)) continue;
    const kind = modelKind(o.kind);
    if (kind === 'other') { if (strict) throw bad(`「${short(id)}」是向量 / 识别一类的模型，不能添加`); continue; }
    if (!MODALITIES.includes(kind)) { if (strict) throw bad(`「${short(id)}」的种类不认识`); continue; }
    const media = kind !== 'text';
    const c = media ? {} : caps(o);
    const explicit = Array.isArray(o.agents);
    // 上下文窗口不够 Claude 用的：明确给了 claude 且 strict 报 400，否则（读盘、v1 升级、老接口的默认去向）静默去掉 claude
    const agents = cleanAgents(id, kind, explicit ? o.agents : dflt, protocol, { strict: strict && explicit, ctx: c.contextWindow });
    if (!agents.length) continue;
    if (media ? nMedia >= MAX_MEDIA : nText >= MAX_TEXT) { if (strict) throw bad(media ? `媒体模型最多 ${MAX_MEDIA} 个` : `文本模型最多 ${MAX_TEXT} 个`); continue; }
    if (media) nMedia += 1; else nText += 1;
    seen.add(id);
    const label = str(o.label, 80);
    out.push({ id, ...(label && label !== id ? { label } : {}), kind, agents, ...c });
  }
  return out;
}
const pickDefault = (models, want) => {
  const texts = models.filter((m) => m.kind === 'text');
  return texts.some((m) => m.id === want) ? want : texts[0]?.id || '';
};
function cleanStudioRef(v) {
  return v && typeof v === 'object' && STUDIO_ID_RE.test(String(v.id || '')) ? { id: v.id, dialect: /^[a-z0-9-]{1,30}$/.test(String(v.dialect || '')) ? v.dialect : '' } : null;
}
function newServiceId() {
  // 等着补删的托管服务也占着 id：新服务要是撞上，对账时会把它的托管服务当成「待删」删掉
  const taken = new Set([...(data?.services || []).map((s) => s.id), ...(data?.pendingStudioRemovals || [])]);
  let id;
  do id = newId('h-'); while (taken.has(id));
  return id;
}

// 读盘（lenient）时线路没有 key 字段；用户提交的线路可带 key（新 Key）——收在 normalizeService 的返回值之外（pendingKeys）。
// 有 prev（改服务）时模型清单沿用 prev 的：模型与去向只经 assign 改。
function normalizeService(input, prev, { lenient = false, strictModels = true, id: presetId = '' } = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const kind = KINDS.includes(s.kind) ? s.kind : prev?.kind || (lenient ? 'openai' : null);
  if (!kind) throw bad('协议只能是 openai / anthropic / gemini');
  const name = str(s.name ?? prev?.name, 40);
  if (!name) throw bad('要有名字');
  const baseUrl = normalizeUrl(s.baseUrl ?? prev?.baseUrl, '接口地址');
  const dflt = Array.isArray(s.agents) ? TEXT_AGENTS.filter((a) => s.agents.includes(a)) : [...TEXT_AGENTS];
  const models = prev ? prev.models : normalizeModels(s.models, kind, { strict: !lenient && strictModels, dflt });
  const prevLines = new Map((prev?.lines || []).map((l) => [l.id, l]));
  const lines = [], pendingKeys = [];
  for (const l of Array.isArray(s.lines) ? s.lines : prev?.lines || []) {
    if (!l || typeof l !== 'object') continue;
    const old = prevLines.get(l.id);
    const id = old ? old.id : lenient && /^l-[0-9a-f]{8}$/.test(l.id || '') ? l.id : newId('l-');
    const lb = str(l.baseUrl, 500);
    lines.push({ id, label: str(l.label, 40) || `Key ${lines.length + 1}`, baseUrl: lb ? normalizeUrl(lb, '线路地址') : '', enabled: l.enabled !== false });
    if (!lenient && typeof l.key === 'string' && l.key.trim()) {
      const key = l.key.trim();
      // 中间夹换行 / 空白 / 控制字符 / 非 Latin-1 的 Key 进了请求头必炸（undici 的报错原文里还带着整段 Key）：存之前就挡
      if (BAD_KEY_RE.test(key)) throw bad(BAD_KEY_MSG);
      pendingKeys.push([id, key.slice(0, 4000)]);
    }
    if (lines.length >= MAX_LINES) break;
  }
  const studio = lenient ? cleanStudioRef(s.studio) : prev?.studio || null;
  const studioDirty = lenient ? s.studioDirty === true : prev?.studioDirty === true;
  const detectedAt = lenient ? (Number.isFinite(s.detectedAt) && s.detectedAt > 0 ? s.detectedAt : 0) : prev?.detectedAt || 0;
  // native：这个服务对应 dimensio 自带适配的哪一家（dimensio-native.mjs）。只在建服务时定（按识别建的按地址认，迁移建的直接给），
  // 之后跟着服务走；改了地址才重认。以前就有的服务没有这个记号——它们在 dimensio 里的服务 id 不能变。
  const givenNative = NATIVE_VENDOR_IDS.includes(s.native) ? s.native : '';
  const native = prev ? (prev.native ? (prev.baseUrl === baseUrl ? prev.native : nativeVendorOf(baseUrl)) : '') : givenNative;
  const out = {
    id: prev?.id || presetId || (lenient && /^h-[0-9a-f]{8}$/.test(s.id || '') ? s.id : newServiceId()),
    name, kind, baseUrl,
    authStyle: AUTH_STYLES.includes(s.authStyle) ? s.authStyle : prev?.authStyle || defaultAuthStyle(kind),
    headers: s.headers !== undefined ? cleanHeaders(s.headers) : prev?.headers || [],
    members: typeof s.members === 'boolean' ? s.members : prev?.members === true,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : prev?.enabled !== false,
    strategy: s.strategy === 'round-robin' || s.strategy === 'failover' ? s.strategy : prev?.strategy || 'failover',
    useProxy: typeof s.useProxy === 'boolean' ? s.useProxy : prev?.useProxy !== false,
    timeoutSec: posInt(s.timeoutSec, 10, 1800) || prev?.timeoutSec || 600,
    models, defaultModel: pickDefault(models, s.defaultModel ?? prev?.defaultModel), lines,
    createdAt: prev?.createdAt || (lenient && Number.isFinite(s.createdAt) ? s.createdAt : Date.now()),
    ...(detectedAt ? { detectedAt } : {}),
    ...(native ? { native } : {}),
    ...(studio ? { studio } : {}),
    ...(studioDirty ? { studioDirty: true } : {}),
  };
  if (!lenient) Object.defineProperty(out, 'pendingKeys', { value: pendingKeys, enumerable: false });
  return out;
}

// —— 给 agent 的型号规格：用户填的优先，没填的按型号知识层（思考档位只来自知识层）——
function modelSpec(m, protocol, route = '') {
  const known = VERTEX_KNOWN_MODELS.find((k) => k.id === m.id);
  const g = guessModel(m.id, { protocol, route });
  const think = g.thinking && g.thinking !== 'none' && g.efforts?.length
    ? { thinking: g.thinking, efforts: g.efforts, effortField: g.effortField, effortDefault: g.effortDefault, alwaysThinks: g.alwaysThinks }
    : {};
  return {
    id: m.id, label: m.label || known?.label || m.id,
    contextWindow: m.contextWindow || known?.contextWindow || g.contextWindow,
    maxOutput: saneMaxOutput(m, g) || known?.maxOutput || g.maxOutput,
    vision: typeof m.vision === 'boolean' ? m.vision : known?.vision ?? g.vision,
    ...think,
  };
}

// OpenRouter 的 /models 把很多型号的输出上限报成「窗口的九成」（943718 之类），不是厂商真实上限；型号表里有真值时用表里的，
// 不然两边会把 max_tokens 开到几十万。用户手填的别的数照用。
function saneMaxOutput(m, g) {
  const out = m.maxOutput, ctx = m.contextWindow;
  if (out && ctx && g.source?.maxOutput === 'table' && Math.abs(out - Math.floor(ctx * 0.9)) <= 1) return g.maxOutput;
  return out;
}

// 这个服务的请求实际发到哪台主机：所有启用线路的地址（线路自己的，没有就用服务的）是同一台才算数；混挂的回 ''。
// 两个 agent 看到的地址都是本机网关，不带上这个就认不出「上游是官方 Anthropic」（提示缓存、1 小时 TTL、beta 头、fast 全靠它）
// 和「上游是 OpenRouter」（推理参数写法、Claude 的缓存标记）。
function upstreamHostOf(s) {
  const hosts = new Set();
  for (const l of s.lines) {
    if (!l.enabled) continue;
    try { hosts.add(new URL(l.baseUrl || s.baseUrl).hostname.toLowerCase()); } catch { return ''; }
  }
  return hosts.size === 1 ? [...hosts][0] : '';
}

// —— 发布到 model-services（只有文本模型；媒体模型走 Studio）——
const handles = new Map();   // model-services 的服务 id → 句柄
const brandLogoOf = (baseUrl) => { try { return providerOf(baseUrl)?.logo || ''; } catch { return ''; } };
function desiredSpecs() {
  const d = load(), out = new Map();
  if (d.vertex.enabled && vertexConfigured()) {
    const models = d.vertex.models.map((id) => ({ id }));
    // Claude 走 OpenAI 兼容接口（网关代存思维签名），dimensio 走原生 Gemini 接口——同一个服务登记成两条
    for (const [suffix, agent, proto] of [['c', 'claude', 'openai'], ['d', 'dimensio', 'gemini']]) {
      if (!d.vertex.agents.includes(agent)) continue;
      out.set(`${VERTEX_ID}-${suffix}`, {
        id: `${VERTEX_ID}-${suffix}`, name: 'Vertex', protocol: proto, baseUrl: gatewayUrl(VERTEX_ID, proto), authStyle: 'none',
        agents: [agent], members: d.vertex.members, models: models.map((m) => modelSpec(m, proto)), defaultModel: models[0].id, timeoutSec: 900, logo: 'vertexai-color',
        compat: { promptCaching: false, stripBetas: true, stripThinkingHistory: true },
      });
    }
  }
  // dimensio 自带适配的厂商：一家只认一个服务（排在前面的那个），它勾给 dimensio 的模型落在 dimensio 原来的厂商 id 上，
  // 用这个服务第一条有 Key 的可用线路直连（不经网关：dimensio 里联网搜索等别的功能也拿这把 Key 打官方接口）。
  const sec = d.services.some((s) => s.native) ? secrets() : null;
  const nativeTaken = new Set();
  for (const s of d.services) {
    if (!s.enabled || !s.lines.some((l) => l.enabled)) continue;
    const texts = s.models.filter((m) => m.kind === 'text' && m.agents.length);
    if (!texts.length) continue;
    let native = null;
    if (s.native && !nativeTaken.has(s.native) && texts.some((m) => m.agents.includes('dimensio'))) {
      const key = s.lines.filter((l) => l.enabled).map((l) => keyIn(sec, s.id, l.id)).find(Boolean);
      if (key) { native = { vendor: s.native, key, baseUrl: nativeEndpoint(s.native, s) }; nativeTaken.add(s.native); }
    }
    const upstream = upstreamHostOf(s);
    const route = routeOf(upstream);
    // 上游就是官方 Anthropic：和官方预设一样开提示缓存、不精简请求体、转发 beta 头
    const official = s.kind === 'anthropic' && upstream === 'api.anthropic.com';
    // 服务级 agents = 各模型去向的并集（model-services 按它取交集）；模型级 agents 决定每个 agent 看到哪几个
    out.set(s.id, {
      // 这两个键每次都给全：已登记的服务是把新规格合并到旧规格上，不给就会留着旧值（改了地址、加了混挂线路之后还按官方处理）
      upstream,
      compat: official ? { promptCaching: true, slimBody: false, stripBetas: false } : {},
      id: s.id, name: s.name, protocol: s.kind, baseUrl: gatewayUrl(s.id, s.kind), authStyle: 'none',
      agents: TEXT_AGENTS.filter((a) => texts.some((m) => m.agents.includes(a))), members: s.members,
      models: texts.map((m) => ({ ...modelSpec(m, s.kind, route), agents: [...m.agents] })),   // 不带 kind：Claude 的 normalizeModel 不认它
      defaultModel: pickDefault(texts, s.defaultModel), timeoutSec: s.timeoutSec, logo: brandLogoOf(s.baseUrl),
      native,
    });
  }
  return out;
}
function publish() {
  if (!gatewayUrl('x', 'openai')) return;   // 网关还没起来：initModelHub 起好后会再发一遍
  const want = desiredSpecs();
  for (const [id, h] of handles) if (!want.has(id)) { h.dispose(); handles.delete(id); }
  for (const [id, spec] of want) {
    try {
      const h = handles.get(id);
      if (h) h.update(spec); else handles.set(id, provideModelService(HUB_PLUGIN, HUB_NAME, spec));
    } catch (e) { console.error(`[model-hub] 「${spec.name}」登记不上：`, e?.message || e); }
  }
}

const listeners = new Set();
export function onHubChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { for (const fn of listeners) { try { fn(); } catch {} } }
function changed() { publish(); notify(); }

// —— Studio 同步的收尾 ——
const mediaSig = (models) => JSON.stringify(studioModels({ models }).map((m) => [m.id, m.label || '', m.kind]));
/**
 * 把服务的媒体部分推给 Studio，按结果收尾 → [warning]。
 * 推不过去（Studio 报错）且给了 prevModels：媒体部分退回改之前的样子（Studio 那边没变，两边保持一致；文本部分照常生效）。
 * 没有桥（扩展没装 / 没加载）时不退：加媒体去向在 applyAssign 里就挡掉了，能走到这里的只有「移除」，Studio 都不在了，移除照样算数。
 * Studio 跳过的模型（方言做不了这一类、id 不合它的规则）在这边也去掉 studio 去向，免得界面上显示「已添加」其实没有。
 * 推不过去一律记 studioDirty（落盘）：Studio 回来后（启动对账 / 下一次写操作前）照当时的样子补推；推成了清掉。
 */
function finishStudioSync(s, prevModels) {
  const r = syncStudio(s, keyOf);
  const warnings = [...r.warnings];
  let dirty = false;
  if (!r.ok) {
    if (prevModels && studioBridge()) {
      const before = JSON.stringify(s.models);
      s.models = [...s.models.filter((m) => m.kind === 'text'), ...prevModels.filter((m) => m.kind !== 'text')];
      if (JSON.stringify(s.models) !== before) { dirty = true; warnings.push('媒体模型的改动已撤回'); }
    }
    if (!s.studioDirty) { s.studioDirty = true; dirty = true; }
  } else {
    if (s.studioDirty) { delete s.studioDirty; dirty = true; }
    if (r.studio && (r.studio.id !== s.studio?.id || r.studio.dialect !== s.studio?.dialect)) { s.studio = r.studio; dirty = true; }
    if (r.skipped.length) {
      const skip = new Set(r.skipped);
      s.models = s.models
        .map((m) => (m.kind !== 'text' && skip.has(m.id) ? { ...m, agents: m.agents.filter((a) => a !== 'studio') } : m))
        .filter((m) => m.agents.length);
      dirty = true;
    }
  }
  if (dirty) save();
  return warnings;
}

/**
 * 按 changes 算出新的已添加清单（不改 s）。changes: [{ id, agents }]，agents 是这个模型去向的全集，[] = 移除。
 * 新加的模型信息取自目录（catOf）；已添加的保留原字段，只改种类与去向。任何一条不对整批不生效（全算完才由调用方写）。
 * 种类以目录为准（契约：模型信息取自目录）；目录说是 other 而它早已添加（v1 升级来的）的按原种类，不让重识别把它变成「不可添加」。
 */
function applyAssign(s, changes, catOf, catMedia) {
  if (!Array.isArray(changes)) throw bad('changes 要是数组');
  if (changes.length > MAX_TEXT + MAX_MEDIA) throw bad('一次改动的模型太多');
  const cur = new Map(s.models.map((m) => [m.id, m]));
  let kinds;
  const mediaKinds = () => {   // 头一次有模型要去 Media Studio 时才查
    if (kinds === undefined) {
      const mi = mediaInfo(s, catMedia, keyOf);
      if (!mi) throw bad(`${NO_STUDIO}，媒体模型不能添加`);
      kinds = mi.kinds;
    }
    return kinds;
  };
  for (const c of changes) {
    const id = str(c?.id, 200);
    if (!MODEL_ID_RE.test(id)) throw bad(id ? `模型 ID「${id.slice(0, 40)}」不合法（不能有空白）` : '要给模型 ID');
    if (!Array.isArray(c.agents)) throw bad(`「${short(id)}」的去向要是数组`);
    if (!c.agents.length) { cur.delete(id); continue; }
    const old = cur.get(id), cat = catOf(id);
    if (!old && !cat) throw bad(`目录里没有「${short(id)}」：先识别一次，或者手动添加这个模型 ID`);
    const kind = cat && cat.kind !== 'other' ? cat.kind : old ? old.kind : 'other';
    if (kind === 'other') throw bad(`「${short(id)}」是向量 / 识别一类的模型，不能添加`);
    // 上下文窗口：已添加的按它自己记的，新加的按目录（Claude 至少要 4096）
    const ctx = kind === 'text' ? (old ? old.contextWindow : caps(cat).contextWindow) : undefined;
    const agents = cleanAgents(id, kind, c.agents.map(String), s.kind, { strict: true, mediaKinds, ctx });
    const base = old ? { ...old } : { id, ...(cat.label && cat.label !== id ? { label: cat.label } : {}), ...(kind === 'text' ? caps(cat) : {}) };
    if (kind !== 'text') { delete base.contextWindow; delete base.maxOutput; delete base.vision; }
    cur.set(id, { ...base, kind, agents });
  }
  const out = [...cur.values()];
  const nText = out.filter((m) => m.kind === 'text').length;
  if (nText > MAX_TEXT) throw bad(`文本模型最多 ${MAX_TEXT} 个`);
  if (out.length - nText > MAX_MEDIA) throw bad(`媒体模型最多 ${MAX_MEDIA} 个`);
  return out;
}

function cleanMediaHint(v) {
  if (!v || typeof v !== 'object' || !/^[a-z0-9-]{1,30}$/.test(String(v.dialect || ''))) return null;
  const kinds = (Array.isArray(v.kinds) ? v.kinds : []).map((k) => (k === 'speech' ? 'voice' : k)).filter((k) => MODALITIES.includes(k) && k !== 'text');
  return { dialect: v.dialect, kinds: [...new Set(kinds)] };
}
function cleanCatalogList(list) {
  const seen = new Set(), out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const c = cleanCatalogModel(m, 'api');
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id); out.push(c);
    if (out.length >= CATALOG_MAX) break;
  }
  return out;
}
// 已添加的模型种进目录（老接口建的、收编来的服务没识别过：不种的话移除以后就没法再加回来）
function seedCatalog(sid, models, source) {
  try { writeCatalog(sid, { at: Date.now(), models: models.map((m) => ({ ...m, source })) }); }
  catch (e) { console.error('[model-hub] 目录没种上：', e?.message || e); }
}
function findService(id) {
  const s = load().services.find((x) => x.id === id);
  if (!s) throw notFound();
  return s;
}
// 已添加过、这次移除的模型（或老接口新加的）目录里没有：当手动项补进目录，以后还能加回来
function keepInCatalog(sid, cat, list) {
  const have = new Set(cat.models.map((m) => m.id));
  const extra = list.filter((m) => !have.has(m.id));
  if (!extra.length) return;
  try { writeCatalog(sid, { at: cat.at || Date.now(), models: [...cat.models, ...extra.map((m) => ({ ...m, source: 'manual' }))], media: cat.media }); }
  catch (e) { console.error('[model-hub] 目录没写成：', e?.message || e); }
}

/**
 * 老前端（离线 apk 里内置的旧编辑器）的 update 带着服务级 agents 与型号清单（型号不带种类）：翻译成 assign，只动文本模型
 * （媒体模型不碰：老编辑器回传的条目没有种类，不能拿来覆盖）→ { models: 新的已添加清单, fresh: [新加的] } | null（没变化）。
 *   · 清单里没有的文本模型 = 移除；清单里新出现的按文本加，去向 = 给的 agents（Gemini 协议 / Claude 的规则不合的去掉 claude，一个都不剩才 400）；
 *   · 服务级 agents 比原来的并集少了的，从每个文本模型上去掉；多了的，给每个文本模型加上（同样按规则去掉给不了的）；
 *   · 老编辑器里改过的显示名 / 上下文 / 识图跟着改。
 * 最后过 applyAssign 同一套校验：不合法整次 400，什么都不改。
 */
function legacyModels(s, p, cat) {
  const texts = s.models.filter((m) => m.kind === 'text');
  const mediaIds = new Set(s.models.filter((m) => m.kind !== 'text').map((m) => m.id));
  const had = TEXT_AGENTS.filter((a) => texts.some((m) => m.agents.includes(a)));
  const want = Array.isArray(p.agents) ? TEXT_AGENTS.filter((a) => p.agents.includes(a)) : had;
  const drop = had.filter((a) => !want.includes(a)), add = want.filter((a) => !had.includes(a));
  let given = null;   // 老编辑器给的型号：id → 条目；没给 models = 型号不变、只改去向
  if (Array.isArray(p.models)) {
    given = new Map();
    for (const m of p.models) {
      const o = typeof m === 'string' ? { id: m } : m && typeof m === 'object' ? m : {};
      const id = str(o.id, 200);
      if (!id || mediaIds.has(id) || given.has(id)) continue;
      if (!MODEL_ID_RE.test(id)) throw bad(`型号 ID「${id.slice(0, 40)}」不合法（不能有空白）`);
      given.set(id, o);
    }
  }
  const base = s.models.map((m) => {
    const o = m.kind === 'text' ? given?.get(m.id) : null;
    if (!o) return m;
    const next = { ...m, ...caps(o) };
    if (typeof o.label === 'string') { const label = str(o.label, 80); if (label && label !== m.id) next.label = label; else delete next.label; }
    return next;
  });
  const changes = [], fresh = new Map();
  for (const m of base) {
    if (m.kind !== 'text') continue;
    if (given && !given.has(m.id)) { changes.push({ id: m.id, agents: [] }); continue; }
    const next = TEXT_AGENTS.filter((a) => (m.agents.includes(a) && !drop.includes(a)) || add.includes(a));
    changes.push({ id: m.id, agents: cleanAgents(m.id, 'text', next, s.kind, { strict: false, ctx: m.contextWindow }) });
  }
  for (const [id, o] of given || []) {
    if (base.some((m) => m.id === id)) continue;
    const c = caps(o);
    const agents = cleanAgents(id, 'text', want, s.kind, { strict: false, ctx: c.contextWindow });
    if (!agents.length) {
      if (want.length) cleanAgents(id, 'text', want, s.kind, { strict: true, ctx: c.contextWindow });   // 给的去向一个都给不了：报出原因
      continue;
    }
    const label = str(o.label, 80);
    fresh.set(id, { id, ...(label && label !== id ? { label } : {}), kind: 'text', ...c });
    changes.push({ id, agents });
  }
  // 种类一律按文本（老编辑器的清单就是文本清单）：目录里同 id 认成别的种类也不改它
  const next = applyAssign({ ...s, models: base }, changes, (id) => fresh.get(id) || { id, kind: 'text' }, cat.media);
  return JSON.stringify(next) === JSON.stringify(s.models) ? null : { models: next, fresh: [...fresh.values()] };
}

// —— 和 Media Studio 对账 ——
// Studio 的桥要等扩展加载完才有；没有桥是整个进程的事（扩展卸载 / 跳过 / 加载失败，重启才回来）。Studio 不在或报错期间欠下的：
//   · 删掉的服务：它的托管服务记在 pendingStudioRemovals，补删；
//   · 改了没推过去的（studioDirty）：照现在的样子补推；
//   · 启动对账（full）再看一遍 Studio 的托管清单：hubRef 指向的服务已经没了（删的时候没记上、恢复过旧的 services.json）的取消托管
//     ——变回普通服务，用户在 Studio 里能删能改，任务与作品历史不丢；名字 / 启停 / 共享 / Key 尾号和本地对不上的补推。
//     地址不比：官方方言 Studio 会换成它自己的媒体地址，比了次次都对不上。
//     services.json 坏了、或有服务没读出来时，对应的托管服务不动（不当孤儿）。
function studioCatchUp(full) {
  const out = { removed: [], released: [], synced: [], warnings: [] };
  const bridge = studioBridge();
  if (!bridge) return out;
  const d = load();
  let dirty = false, touched = false;
  if (d.pendingStudioRemovals.length) {
    const left = [];
    for (const sid of d.pendingStudioRemovals) {
      if (d.services.some((s) => s.id === sid)) continue;   // 服务又回来了（恢复了旧文件）：不删，交给下面照常对账
      try { bridge.remove(sid); out.removed.push(sid); }
      catch (e) { left.push(sid); console.error(`[model-hub] Media Studio 里 ${sid} 托管的媒体服务还是没删掉：`, e?.message || e); }
    }
    if (left.length !== d.pendingStudioRemovals.length) { d.pendingStudioRemovals = left; dirty = true; }
  }
  let managed = null;   // hubRef → Studio 的托管条目；null = 不看（写操作前的顺手补 / 读不出来）
  if (full) {
    try {
      const list = bridge.list();
      if (Array.isArray(list)) managed = new Map(list.filter((x) => x && x.managed && x.hubRef).map((x) => [String(x.hubRef), x]));
    } catch (e) { console.error('[model-hub] 对账时读不出 Media Studio 的服务：', e?.message || e); }
  }
  if (managed) {
    const ours = new Set(d.services.map((s) => s.id));
    for (const ref of managed.keys()) {
      if (ours.has(ref) || d.suspect || d.unreadable.includes(ref) || d.pendingStudioRemovals.includes(ref)) continue;
      try { bridge.release(ref); out.released.push(ref); }
      catch (e) { console.error(`[model-hub] 取消托管 ${ref} 失败：`, e?.message || e); }
    }
  }
  for (const s of d.services) {
    let need = s.studioDirty === true;
    if (managed && (s.studio || studioModels(s).length)) {
      const x = managed.get(s.id);
      if (!x) {
        // Studio 那边没有（从没推成过 / 被清掉了）：照本地重建——新建的那份没有 Key，内存里「推过」的记号作废，连 Key 一起推
        if (studioModels(s).length) { need = true; primeStudioKey(s.id, mediaLine(s, keyOf).key, ''); }
        else { delete s.studio; dirty = true; }      // 本来也没有媒体模型了：不必再建个空的
      } else {
        const on = s.enabled !== false && s.lines.some((l) => l.enabled !== false);
        // Key 尾号对得上就当推过了（不重推，免得 Studio 白刷一遍 schema）；对不上下次连 Key 推
        const keyOk = primeStudioKey(s.id, mediaLine(s, keyOf).key, x.keyTail);
        if (!keyOk || x.name !== s.name || s.studio?.id !== x.id
          || (typeof x.enabled === 'boolean' && x.enabled !== on) || (typeof x.shared === 'boolean' && x.shared !== (s.members === true))) need = true;
      }
    }
    if (!need) continue;
    touched = true;
    const w = finishStudioSync(s, null);   // 推成了清 studioDirty、推不过去记上（都会落盘）
    if (!s.studioDirty) out.synced.push(s.id);
    out.warnings.push(...w.map((x) => `「${s.name}」：${x}`));
  }
  if (dirty) save();
  if (dirty || touched || out.removed.length || out.released.length) notify();
  return out;
}
/**
 * 启动时对一次账（server.mjs 在 loadModules 之后调：那时才拿得到 Studio 的桥）→ { removed, released, synced, warnings }。
 * 没有桥什么都不做（下次带着 Studio 启动时再对）。
 */
export function reconcileStudio() {
  const r = studioCatchUp(true);
  if (r.removed.length || r.released.length || r.synced.length || r.warnings.length) {
    console.log(`[model-hub] 和 Media Studio 对账：补删 ${r.removed.length} 个、取消托管 ${r.released.length} 个、补推 ${r.synced.length} 个`
      + (r.warnings.length ? `；${r.warnings.join('；')}` : ''));
  }
  return r;
}
// 写操作前顺手补一下待删的和没推成的（不读 Studio 的清单）。失败只记日志，不挡这次写操作
function catchUpStudio() {
  try { studioCatchUp(false); } catch (e) { console.error('[model-hub] 补同步 Media Studio 失败：', e?.message || e); }
}

// —— 对外 ——
/** 启动时调一次：起网关、接上游、把存着的服务发布出去。 */
export async function initModelHub() {
  setServiceResolver((id) => {
    const d = load();
    if (id === VERTEX_ID) return d.vertex.enabled ? { id: VERTEX_ID, kind: 'vertex', name: 'Vertex', location: d.vertex.location, models: d.vertex.models.map((x) => ({ id: x })) } : null;
    const s = d.services.find((x) => x.id === id);
    return s && s.enabled ? s : null;
  });
  registerUpstream('vertex', handleVertex);
  const pool = makePoolHandler(keyOf);
  for (const k of KINDS) registerUpstream(k, pool);
  await ensureGateway();
  publish();
}

const tail = (k) => (k ? (k.length > 8 ? '…' + k.slice(-4) : '…') : '');
/** ServiceView（契约 §5.4）。sec = 已读出的密文表（列表时只解一次）。不带任何 Key，只有 keyTail。 */
function serviceView(s, sec = secrets()) {
  const k = (sid, lid) => keyIn(sec, sid, lid);
  const meta = catalogMeta(s.id);
  const counts = { text: 0, image: 0, video: 0, voice: 0, music: 0 };
  for (const m of s.models) if (m.kind in counts) counts[m.kind] += 1;
  const brand = providerOf(s.baseUrl);
  let media = null;
  try { media = mediaInfo(s, meta.media, k); } catch (e) { console.error('[model-hub] 媒体接口信息算不出来：', e?.message || e); }
  return {
    id: s.id, name: s.name, kind: s.kind, baseUrl: s.baseUrl, host: hostOf(s.baseUrl),
    brand: brand ? { key: brand.key, name: brand.name, logo: brand.logo } : null,
    authStyle: s.authStyle, headers: s.headers, enabled: s.enabled, members: s.members, strategy: s.strategy, useProxy: s.useProxy, timeoutSec: s.timeoutSec,
    lines: s.lines.map((l) => { const key = k(s.id, l.id); return { ...l, hasKey: !!key, keyTail: tail(key), state: lineState(s.id, l.id) }; }),
    models: s.models.map((m) => ({ ...m, agents: [...m.agents], vendor: vendorOf(m.id) || '' })),
    counts,
    agents: ALL_AGENTS.filter((a) => s.models.some((m) => m.agents.includes(a))),
    defaultModel: s.defaultModel, createdAt: s.createdAt,
    detectedAt: s.detectedAt || 0, catalogSize: meta.size, media,
    native: s.native || '',
    published: handles.has(s.id),
  };
}
export function listHubServices() { const sec = secrets(); return load().services.map((s) => serviceView(s, sec)); }
export function getHubService(id) { const s = load().services.find((x) => x.id === id); return s ? serviceView(s) : null; }
export function vertexView() {
  const v = load().vertex;
  return { ...v, configured: vertexConfigured(), known: VERTEX_KNOWN_MODELS.map((m) => ({ id: m.id, label: m.label })), published: handles.has(`${VERTEX_ID}-c`) || handles.has(`${VERTEX_ID}-d`) };
}

/**
 * 老接口建服务（v1 形状：服务级 agents + 型号清单，型号不带种类 = 文本）→ ServiceView。
 * 收编 Claude / dimensio 的自定义服务也走这里（型号带 agents：全部给原来那个 agent）。
 * catalogExtra：不算已添加、但要放进目录的型号（收编 Claude 服务时它那边停用着的型号）。
 */
export function createHubService(input, { catalogExtra = [], allowEmpty = false } = {}) {
  catchUpStudio();
  const d = load();
  if (d.services.length >= MAX_SERVICES) throw bad(`最多 ${MAX_SERVICES} 个服务`);
  const s = normalizeService(input, null);
  // allowEmpty：自动迁移来的服务一个启用的型号都没有（原来全停用着）也照建，停用的进目录，勾一下就能加
  if (!s.models.length && !allowEmpty) throw bad('至少要有一个型号');
  if (!s.lines.length) throw bad('至少要有一条线路（Key）');
  setKeys(s.pendingKeys.map(([lid, k]) => [s.id, lid, k]));
  d.services.push(s);
  seedCatalog(s.id, [...s.models, ...(Array.isArray(catalogExtra) ? catalogExtra : [])], 'manual');
  save(); changed();
  return serviceView(s);
}

/**
 * 按识别结果建服务（契约 POST /create）→ { service, warnings }。
 * b = { name?, baseUrl, kind, authStyle?, headers?, useProxy?, key, catalog:[CatalogModel], assign:[{ id, agents }], media?（识别结果原样）}。
 * 目录由前端把识别结果原样带回（服务端不重识别：一次识别最长 45 秒，建服务不该再等一遍）；assign 里的模型必须在目录里。
 */
export function createHubFromDetect(b) {
  catchUpStudio();
  const d = load();
  if (d.services.length >= MAX_SERVICES) throw bad(`最多 ${MAX_SERVICES} 个服务`);
  if (!KINDS.includes(b?.kind)) throw bad('协议只能是 openai / anthropic / gemini');
  const baseUrl = normalizeUrl(b.baseUrl, '接口地址');
  const brand = providerOf(baseUrl);
  const key = typeof b.key === 'string' ? b.key.trim().slice(0, 4000) : '';
  const s = normalizeService({
    name: str(b.name, 40) || brand?.name || hostOf(baseUrl) || '模型服务',
    kind: b.kind, baseUrl, authStyle: b.authStyle, headers: b.headers, useProxy: b.useProxy, timeoutSec: b.timeoutSec, members: b.members,
    lines: [{ label: 'Key 1', key }], models: [],
    native: nativeVendorOf(baseUrl),   // 地址是 dimensio 自带适配的那几家：勾给 dimensio 的模型走它的专门适配
  }, null);
  const catalog = cleanCatalogList(b.catalog);
  const catMap = new Map(catalog.map((m) => [m.id, m]));
  // 识别结果里的 media（Studio 说这个地址的媒体接口是什么方言、能做哪几类）一起带回来：自定义地址按地址认不出方言时靠它
  const media = cleanMediaHint(b.media);
  s.models = applyAssign(s, b.assign ?? [], (id) => catMap.get(id), media);
  s.defaultModel = pickDefault(s.models, b.defaultModel);
  const now = Date.now();
  if (Array.isArray(b.catalog)) s.detectedAt = now;
  setKeys(s.pendingKeys.map(([lid, k]) => [s.id, lid, k]));
  d.services.push(s);
  writeCatalog(s.id, { at: now, models: catalog, media });
  save(); publish();
  const warnings = studioModels(s).length ? finishStudioSync(s, []) : [];
  notify();
  return { service: serviceView(s), warnings };
}

/** 改模型去向（契约 POST /assign）→ { service, warnings }。文本部分当场发布；媒体部分有变化才同步 Studio。 */
export function assignHubModels(id, changes) {
  catchUpStudio();
  const s = findService(id);
  const cat = readCatalog(s.id);
  const catMap = new Map(cat.models.map((m) => [m.id, m]));
  const prev = s.models;
  const next = applyAssign(s, changes, (x) => catMap.get(x), cat.media);
  s.models = next;
  s.defaultModel = pickDefault(next, s.defaultModel);
  save(); publish();
  // 移除的模型不在目录里（老接口建的服务、目录被重识别冲掉的）→ 当手动项留进目录，以后还能加回来
  keepInCatalog(s.id, cat, prev.filter((m) => !next.some((x) => x.id === m.id)));
  const warnings = mediaSig(prev) !== mediaSig(next) ? finishStudioSync(s, prev) : [];
  notify();
  return { service: serviceView(s), warnings };
}

/**
 * 改服务（契约 POST /update）→ { service, warnings }。协议定了不改。
 * 模型与去向走 assign；新前端的 update 不带 models / agents。老前端（离线 apk 的旧编辑器）带着的：翻译成对文本模型的 assign（legacyModels），
 * 媒体模型不碰；翻译不合法整次 400，连接部分也不改。
 */
export function updateHubV2(id, patch) {
  catchUpStudio();
  const d = load();
  const i = d.services.findIndex((x) => x.id === id);
  if (i < 0) throw notFound();
  const prev = d.services[i];
  const p = patch && typeof patch === 'object' ? patch : {};
  const pick = {};
  for (const k of UPDATE_FIELDS) if (p[k] !== undefined) pick[k] = p[k];
  const s = normalizeService({ ...pick, kind: prev.kind }, prev);   // 协议定了不改（两边会话里记着的模型按协议走）
  if (!s.lines.length) throw bad('至少要留一条线路（Key）');
  let cat = null, legacy = null;
  if (Array.isArray(p.models) || Array.isArray(p.agents)) {
    cat = readCatalog(s.id);
    legacy = legacyModels(s, p, cat);   // 先校验完再动 Key
    if (legacy) { s.models = legacy.models; s.defaultModel = pickDefault(s.models, pick.defaultModel ?? s.defaultModel); }
  }
  const gone = prev.lines.filter((l) => !s.lines.some((x) => x.id === l.id));
  setKeys([...s.pendingKeys.map(([lid, k]) => [id, lid, k]), ...gone.map((l) => [id, l.id, ''])]);
  d.services[i] = s;
  save(); publish();
  if (legacy) keepInCatalog(s.id, cat, [...legacy.fresh, ...prev.models.filter((m) => !s.models.some((x) => x.id === m.id))]);
  const touched = STUDIO_FIELDS.some((k) => k in pick);
  const warnings = touched && (studioModels(s).length || s.studio) ? finishStudioSync(s, null) : [];
  notify();
  return { service: serviceView(s), warnings };
}
/** 老接口：只回 ServiceView。 */
export function updateHubService(id, patch) { return updateHubV2(id, patch).service; }

/**
 * 删服务（契约 POST /delete）→ { warnings }：Key、线路状态、目录、发布、Studio 的托管服务一起清。
 * Studio 不在 / 删失败时，托管服务记进 pendingStudioRemovals（落盘），Studio 回来后（启动对账、下一次写操作前）补删。
 */
export function deleteHubV2(id) {
  catchUpStudio();
  const d = load();
  const s = d.services.find((x) => x.id === id);
  if (!s) throw notFound();
  const key = mediaLine(s, keyOf).key;   // 清 Key 之前取：Studio 的报错里要是回显了它，抹掉
  setKeys(s.lines.map((l) => [id, l.id, '']));
  d.services = d.services.filter((x) => x.id !== id);
  forgetService(id);
  removeCatalog(id);
  const r = removeStudio(s, key);
  if (!r.done && !d.pendingStudioRemovals.includes(id)) d.pendingStudioRemovals = [...d.pendingStudioRemovals, id].slice(-MAX_PENDING);
  save(); publish();
  notify();
  return { warnings: r.warnings };
}
/** 老接口：删掉了回 true，没有这个服务回 false。 */
export function deleteHubService(id) {
  try { deleteHubV2(id); return true; }
  catch (e) { if (e?.status === 404) return false; throw e; }
}

/**
 * 原地收编 Media Studio 的一个服务（契约 POST /adopt from:'studio'）→ { service, warnings }。
 * Studio 那边打上托管标（id 不变，任务与作品历史照常引用它），地址与 Key 抄成模型中心服务，现有媒体模型去向 = studio。
 * 启停与「共享给成员」照 Studio 的现状抄（不然下一次同步会把停用的服务重新启用）；
 * 停用 / 备选的模型（parked）只进目录、不算已添加（Studio 那边原样留着，同步不动它们）。
 * 收编到一半失败：取消托管（Studio 服务原样留下）、这边建了一半的撤掉。
 */
export function adoptStudioService(studioId, { into = '' } = {}) {
  catchUpStudio();
  const d = load();
  const pid = String(studioId || '');
  if (!STUDIO_ID_RE.test(pid)) throw Object.assign(new Error('Media Studio 里没有这个服务'), { status: 404 });
  if (into) return adoptStudioInto(pid, into);
  if (d.services.length >= MAX_SERVICES) throw bad(`最多 ${MAX_SERVICES} 个服务`);
  const hubRef = newServiceId();
  const a = adoptStudio(pid, hubRef);   // 抛 404 / 400（人话）
  let pushed = false;
  try {
    const kind = a.dialect === 'gemini' ? 'gemini' : 'openai';
    let baseUrl = String(a.baseUrl || '');
    // Studio 的 Gemini 方言存的是官方根地址（不带 /v1beta）；模型中心的 Gemini 协议要带版本段
    if (kind === 'gemini') { try { const u = new URL(baseUrl); if (u.pathname === '/' || u.pathname === '') baseUrl = u.origin + '/v1beta'; } catch {} }
    // Studio 那边存的 Key 带换行 / 空白：模型中心的网关发不出去，给句能照着做的话（不说「重新粘贴」——这里没有粘贴）
    if (typeof a.apiKey === 'string' && BAD_KEY_RE.test(a.apiKey.trim())) throw bad('这个媒体服务的 Key 里有换行、空白或非法字符：先到 Media Studio 里把 Key 重新填一遍再收编');
    const s = normalizeService({
      name: a.name, kind, baseUrl, authStyle: AUTH_STYLES.includes(a.authStyle) ? a.authStyle : defaultAuthStyle(kind), headers: a.headers,
      enabled: a.enabled !== false, members: a.shared === true,
      lines: [{ label: '原 Key', key: typeof a.apiKey === 'string' ? a.apiKey : '' }],
      models: (Array.isArray(a.models) ? a.models : []).map((m) => ({ id: m?.id, label: m?.label, kind: fromStudioKind(m?.kind), agents: ['studio'] })),
    }, null, { id: hubRef, strictModels: false });
    s.studio = { id: String(a.id), dialect: String(a.dialect || '') };
    setKeys(s.pendingKeys.map(([lid, k]) => [s.id, lid, k]));
    d.services.push(s);
    pushed = true;
    const mi = mediaInfo(s, null, keyOf);
    const have = new Set(s.models.map((m) => m.id));
    const parked = (Array.isArray(a.parked) ? a.parked : [])
      .map((m) => ({ id: m?.id, label: m?.label, kind: fromStudioKind(m?.kind) }))
      .filter((m) => typeof m.id === 'string' && !have.has(m.id));
    writeCatalog(s.id, {
      at: Date.now(), models: [...s.models, ...parked].map((m) => ({ ...m, source: 'catalog' })),
      media: mi ? { dialect: mi.dialect, kinds: mi.kinds } : null,
    });
    save(); changed();
    const warnings = [];
    const lost = (Array.isArray(a.headers) ? a.headers.length : 0) - s.headers.length;
    if (lost > 0) warnings.push(`有 ${lost} 个自定义请求头模型中心收不下（名字不合规则或由模型中心自己管），下次同步时 Media Studio 那边也会去掉`);
    return { service: serviceView(s), warnings };
  } catch (e) {
    releaseStudio(hubRef);
    if (pushed) {
      d.services = d.services.filter((x) => x.id !== hubRef);
      try { setKeys(secretsOfService(hubRef)); } catch {}
      removeCatalog(hubRef);
      save();
    }
    throw e;
  }
}
const secretsOfService = (sid) => Object.keys(secrets()).filter((k) => k.startsWith(sid + '/')).map((k) => [sid, k.slice(sid.length + 1), '']);

/**
 * 原地收编一个 Studio 服务、并进已有的模型中心服务 into（同一家、同一把 Key：findTwinService({ forMedia }) 认出来的）→ { service, warnings }。
 * Studio 那边打上 into 的托管标（id 不变），它主列表里的媒体模型并进 into、去向 studio；停用 / 备选的只进目录。
 * Key 对不上（认的时候只比了模型中心这边）就取消托管、抛 code 'twin'，调用方改为另建一个服务。
 */
function adoptStudioInto(pid, into) {
  const s = findService(into);
  if (s.studio || studioModels(s).length) throw bad('这个模型中心服务已经托管了一个媒体服务');
  const a = adoptStudio(pid, into);
  const prevModels = s.models;
  try {
    const key = mediaLine(s, keyOf).key;
    if ((typeof a.apiKey === 'string' ? a.apiKey : '') !== key) throw Object.assign(bad('Key 不一样，不是同一个服务'), { code: 'twin' });
    s.studio = { id: String(a.id), dialect: String(a.dialect || '') };
    const have = new Set(s.models.map((m) => m.id));
    const media = (Array.isArray(a.models) ? a.models : [])
      .map((m) => ({ id: str(m?.id, 200), label: str(m?.label, 80), kind: fromStudioKind(m?.kind) }))
      .filter((m) => MODEL_ID_RE.test(m.id) && MODALITIES.includes(m.kind) && m.kind !== 'text' && !have.has(m.id));
    s.models = [...s.models, ...media.map((m) => ({ id: m.id, ...(m.label && m.label !== m.id ? { label: m.label } : {}), kind: m.kind, agents: ['studio'] }))];
    const cat = readCatalog(s.id);
    const inCat = new Set(cat.models.map((m) => m.id));
    const parked = (Array.isArray(a.parked) ? a.parked : [])
      .map((m) => ({ id: str(m?.id, 200), label: str(m?.label, 80), kind: fromStudioKind(m?.kind) }))
      .filter((m) => MODEL_ID_RE.test(m.id) && MODALITIES.includes(m.kind) && m.kind !== 'text');
    const extra = [...media, ...parked].filter((m) => !inCat.has(m.id) && inCat.add(m.id)).map((m) => ({ ...m, source: 'catalog' }));
    const mi = mediaInfo(s, cat.media, keyOf);
    writeCatalog(s.id, { at: cat.at || Date.now(), models: [...cat.models, ...extra], media: cat.media || (mi ? { dialect: mi.dialect, kinds: mi.kinds } : null) });
    primeStudioKey(s.id, key, key.slice(-4));   // Studio 那边就是这把 Key：不重推（推了会白刷一遍参数 schema）
    save(); changed();
    return { service: serviceView(s), warnings: [] };
  } catch (e) {
    releaseStudio(into);
    s.models = prevModels;
    if (s.studio?.id === String(a.id)) delete s.studio;
    throw e;
  }
}

// —— 老配置并进来时「其实是同一个服务」的认法与合并（legacy-migrate.mjs 用）——
const urlKey = (u) => { try { const x = new URL(u); return { host: x.host.toLowerCase(), path: x.pathname.replace(/\/+$/, '') }; } catch { return null; } };
/**
 * 找一个和给的连接其实是同一个的模型中心服务 → 服务 id | ''。
 * 要求：同主机（samePath 时路径也要一样：同一家的 /anthropic 与 /v1 是两套接口）；共享给成员、启停一致（不一致合并了会悄悄改掉
 * 成员能不能用、服务开没开）；有一条启用的线路 Key 和 key 完全一样（都不要 Key 的两边都没 Key 也算）。
 * kind 给了要协议一致；forMedia：要它还没托管媒体服务、媒体同步那条线路的 Key 就是这把（媒体只走那一条）。
 */
export function findTwinService({ baseUrl, key = '', kind = '', members = false, enabled = true, samePath = false, forMedia = false } = {}) {
  const want = urlKey(baseUrl);
  if (!want) return '';
  const sec = secrets();
  for (const s of load().services) {
    if (kind && s.kind !== kind) continue;
    const u = urlKey(s.baseUrl);
    if (!u || u.host !== want.host || (samePath && u.path !== want.path)) continue;
    if ((s.members === true) !== (members === true) || (s.enabled !== false) !== (enabled !== false)) continue;
    if (forMedia) {
      if (s.studio || studioModels(s).length) continue;
      if (mediaLine(s, (sid, lid) => keyIn(sec, sid, lid)).key !== key) continue;
      return s.id;
    }
    const keys = s.lines.filter((l) => l.enabled !== false).map((l) => keyIn(sec, s.id, l.id));
    if (key ? keys.includes(key) : keys.length && keys.every((k) => !k)) return s.id;
  }
  return '';
}

/**
 * 把一批文本型号并进已有的服务（老服务和它其实是同一个）→ ServiceView。
 * 已经在的型号补上两边能给的去向（Gemini 协议、id / 上下文不合 Claude 规则的只给 dimensio）；没有的新加，去向同上。
 * parked（原来停用着的）只进目录。超了文本模型上限等校验错误原样抛（调用方改为另建一个服务）。
 */
export function absorbTextModels(id, models, { parked = [], defaultModel } = {}) {
  catchUpStudio();
  const s = findService(id);
  const cat = readCatalog(s.id);
  const given = new Map(), changes = [];
  for (const m0 of Array.isArray(models) ? models : []) {
    const idm = str(m0?.id, 200);
    if (!MODEL_ID_RE.test(idm) || given.has(idm)) continue;
    const old = s.models.find((x) => x.id === idm);
    if (old && old.kind !== 'text') continue;
    const label = str(m0.label, 80);
    given.set(idm, { id: idm, ...(label && label !== idm ? { label } : {}), kind: 'text', ...caps(m0) });
    const want = [...new Set([...(old?.agents || []), ...TEXT_AGENTS])];
    const agents = cleanAgents(idm, 'text', want, s.kind, { strict: false, ctx: old ? old.contextWindow : caps(m0).contextWindow });
    if (agents.length) changes.push({ id: idm, agents });
  }
  const catMap = new Map(cat.models.map((m) => [m.id, m]));
  const prev = s.models;
  s.models = applyAssign(s, changes, (x) => given.get(x) || catMap.get(x), cat.media);
  s.defaultModel = pickDefault(s.models, s.defaultModel || defaultModel);
  save(); publish();
  keepInCatalog(s.id, cat, [...given.values(), ...(Array.isArray(parked) ? parked : []).map((m) => ({ id: str(m?.id, 200), kind: 'text', ...caps(m) })).filter((m) => MODEL_ID_RE.test(m.id))]);
  notify();
  return { service: serviceView(s), changed: JSON.stringify(prev) !== JSON.stringify(s.models) };
}

/**
 * 识别（契约 POST /detect）→ { conn, models, media, warnings }。
 * { id }：已存的服务，用媒体同步那条线路（第一条启用且有 Key 的）的地址与 Key、协议锁定；识别完合并进目录、记 detectedAt。
 * { draft: { baseUrl, key, kind?, authStyle?, headers?, useProxy? } }：还没建的服务，只问不存。
 */
// dimensio 自带适配的厂商：它逐个核对过的型号补进识别结果（接口没列出来的也能勾；列出来的照接口给的）
function withNativeModels(models, vendorId) {
  const v = nativeVendor(vendorId);
  if (!v) return models;
  const have = new Set(models.map((m) => m.id));
  const extra = v.models.filter((m) => !have.has(m.id)).map((m) => cleanCatalogModel({ ...m, kind: 'text', source: 'manual' }, 'manual')).filter(Boolean);
  return extra.length ? [...models, ...extra] : models;
}

export async function detectHub(b) {
  const body = b && typeof b === 'object' ? b : {};
  if (body.id) {
    const s = findService(String(body.id));
    const { key, baseUrl } = mediaLine(s, keyOf);
    // 已托管的服务按托管时 Studio 定下的方言问（收编来的「自定义地址 + 某方言」按地址认会认成 OpenAI 兼容，列出的媒体模型就不对了）
    const r = await detectModels({ baseUrl, key, kind: s.kind, lockKind: true, authStyle: s.authStyle, headers: s.headers, useProxy: s.useProxy, mediaDialect: s.studio?.dialect || '' });
    const cur = load().services.find((x) => x.id === s.id);
    if (!cur) throw Object.assign(new Error('这个服务在识别期间被删掉了'), { status: 404 });
    const cat = mergeCatalog(cur.id, withNativeModels(r.models, cur.native), { media: r.media || undefined });   // 没有 Studio 桥时 media 为空：留着以前识别到的
    cur.detectedAt = Date.now();
    save(); notify();
    return { conn: r.conn, models: cat.models, media: r.media, warnings: r.warnings, native: cur.native || '' };
  }
  const dr = body.draft && typeof body.draft === 'object' ? body.draft : null;
  if (!dr) throw bad('要给服务 id 或草稿');
  const r = await detectModels({
    baseUrl: dr.baseUrl, key: typeof dr.key === 'string' ? dr.key : '',
    kind: KINDS.includes(dr.kind) ? dr.kind : undefined,
    authStyle: AUTH_STYLES.includes(dr.authStyle) ? dr.authStyle : undefined,
    headers: cleanHeaders(dr.headers), useProxy: dr.useProxy !== false,
  });
  // native：这个地址是 dimensio 自带适配的哪一家（建服务时会记上；前端据此提示「加给 dimensio 的模型走专门适配」）
  const native = nativeVendorOf(r?.conn?.baseUrl || dr.baseUrl);
  return native ? { ...r, models: withNativeModels(Array.isArray(r.models) ? r.models : [], native), native } : r;
}

/** 目录（契约 GET /catalog）→ { at, models }：已添加但目录里没有的补在后面（source 'manual'）。 */
export function catalogView(id) {
  const s = findService(id);
  const c = readCatalog(s.id);
  const have = new Set(c.models.map((m) => m.id));
  const extra = s.models.filter((m) => !have.has(m.id)).map((m) => cleanCatalogModel({ ...m, source: 'manual' }, 'manual')).filter(Boolean);
  return { at: c.at, models: [...c.models, ...extra] };
}
/** 手动加一个模型 ID 进目录（契约 POST /catalog/add）→ { model }。只进目录，要用还得 assign。 */
export function catalogAddModel(id, model) {
  const s = findService(id);
  const m = addCatalogModel(s.id, model, { protocol: s.kind });
  notify();
  return { model: m };
}

export function resetHubLine(id, lineId) { clearCooldown(id, lineId); return getHubService(id); }
export function updateVertex(patch) {
  const d = load();
  d.vertex = normalizeVertex(patch && typeof patch === 'object' ? patch : {}, d.vertex);
  save(); changed();
  return vertexView();
}
/** Vertex 的项目 / 凭据在别处改了（设置页）：重新发布一遍。 */
export function refreshHub() { changed(); }

export function _resetHubForTests(d) {
  dirOverride = d || ''; data = null;
  for (const h of handles.values()) h.dispose();
  handles.clear();
  _resetCatalogCacheForTests();
}
export { keyOf as _hubKeyForTests };

/**
 * 测试 / 拉模型用：定位一条线路 → { service, line, key }。
 * id + lineId = 已存的线路；draft = 编辑器里还没保存的（{ kind, baseUrl, authStyle, headers, useProxy, line: { id?, baseUrl, key } }，
 * 草稿线路没填 Key 而 id / line.id 对得上已存的，就用存着的 Key）。
 */
export function lineContext({ id, lineId, draft } = {}) {
  const saved = id ? load().services.find((x) => x.id === id) : null;
  if (!draft) {
    const line = saved?.lines.find((l) => l.id === lineId) || saved?.lines.find((l) => l.enabled);
    if (!saved || !line) throw Object.assign(new Error('没有这条线路'), { status: 404 });
    return { service: saved, line, key: checkedKey(keyOf(saved.id, line.id)) };
  }
  const kind = saved?.kind || (KINDS.includes(draft.kind) ? draft.kind : null);
  if (!kind) throw bad('协议只能是 openai / anthropic / gemini');
  const dl = draft.line && typeof draft.line === 'object' ? draft.line : {};
  const service = {
    id: saved?.id || 'draft', name: str(draft.name, 40) || '草稿', kind, baseUrl: normalizeUrl(draft.baseUrl ?? saved?.baseUrl, '接口地址'),
    authStyle: AUTH_STYLES.includes(draft.authStyle) ? draft.authStyle : saved?.authStyle || defaultAuthStyle(kind),
    headers: saved?.headers || [], useProxy: typeof draft.useProxy === 'boolean' ? draft.useProxy : saved?.useProxy !== false,
  };
  const lb = str(dl.baseUrl, 500);
  const line = { id: str(dl.id, 20) || 'draft', label: '', baseUrl: lb ? normalizeUrl(lb, '线路地址') : '', enabled: true };
  const typed = typeof dl.key === 'string' ? dl.key.trim() : '';
  return { service, line, key: checkedKey(typed || (saved && dl.id ? keyOf(saved.id, dl.id) : '')) };
}
// 带换行 / 空白 / 控制字符的 Key（新填的，或以前存下的）进了请求头必炸，undici 的报错原文里还带着整段 Key：发请求之前就挡
function checkedKey(key) {
  if (key && BAD_KEY_RE.test(key)) throw bad(BAD_KEY_MSG);
  return key;
}
