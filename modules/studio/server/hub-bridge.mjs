// 模型中心 ⇄ Media Studio 的桥（方案 §3.8；模型中心 v2 契约 §6）。
//
// 模型中心（src/runtime/model-hub/）经 getModule('studio')?.hub 调这里增删改「托管服务」：数据仍存在 Studio 自己的注册表
// （providers.mjs），记录上多 managedBy:'hub' + hubRef:'h-…'。只动主机管理员（owner 'admin'）的服务——模型中心只对管理员开放。
// 托管服务的 id 永远不变（任务、作品历史、默认模型都按 '<服务 id>/<模型 id>' 引用它），收编 / 取消托管都是原地打标去标。
//
// 种类：这里进出一律用 Studio 的叫法（配音 = 'speech'）；入参 'voice' 也收（模型中心那边叫 voice），出参由调用方自己换回去。
// Key：adopt 会回明文 Key（模型中心要把它抄成自己服务的 Key），只在服务端内部流转；别的出参只有 keyTail。

import {
  HOST_OWNER, hostProviders, getProvider, createProvider, updateProvider, deleteProvider, providerSecret, normalizeProvider,
  isManaged, HUB_REF_RE, MODEL_ID_RE, MAX_MODELS, HEADER_RE, RESERVED_HEADERS,
} from './providers.mjs';
import { DIALECTS, KINDS, DIALECT_KINDS, DIALECT_AUTH, AUTH_STYLES, NO_BASEURL, PRESET_BY_ID } from './presets.mjs';
import { adapterFor } from './adapters/index.mjs';
import { dialectBuiltinModels } from './cards/dialects.mjs';
import { syncProvider } from './discovery/index.mjs';
import { SCHEMA_DIALECTS } from './discovery/sources.mjs';
import { dropLog } from './log.mjs';
import { Agent } from 'undici';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KIND_NAME = { image: '图像', video: '视频', speech: '配音', music: '音乐' };
const DETECT_MS = 45_000;
// 模型中心里关了「走出站代理」的服务（本机 / 内网 / Tailscale 端点）：识别时直连，和模型中心自己列模型同一条路
const DIRECT = new Agent({ connect: { timeout: 30_000 } });

const trimUrl = (v) => String(v ?? '').trim().replace(/\/+$/, '');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
/** 模型中心的 voice = Studio 的 speech；其余同名。 */
const studioKind = (k) => (k === 'voice' ? 'speech' : String(k ?? ''));
/** 主列表里算数的模型：启用、没下架、不是备选。 */
const activeModels = (p) => (p.models || []).filter((m) => m.enabled && !m.gone && !m.shelf);
const dialectName = (dialect, preset) => (preset === 'openai-compat' || preset === 'custom' ? (dialect === 'openai' ? 'OpenAI 兼容接口' : PRESET_BY_ID[dialect]?.name || dialect) : PRESET_BY_ID[preset]?.name || dialect);

function checkRef(hubRef) {
  const s = String(hubRef ?? '');
  if (!HUB_REF_RE.test(s)) throw bad('模型中心服务的 id 不合法');
  return s;
}
const findManaged = (hubRef) => hostProviders().find((p) => isManaged(p) && p.hubRef === hubRef) || null;

// —— 地址 → 方言 ——
// 按 host 认官方服务（媒体接口的地址跟文本接口常常不是同一个路径：OpenRouter 文本 /api/v1、fal 文本走 fal.run 等），
// 认出来的一律换成该方言的官方媒体地址；认不出 = OpenAI 兼容，地址原样（中转站、自建网关都按 OpenAI 的接口调）。
const official = (d) => PRESET_BY_ID[d]?.baseUrl || '';
const HOST_RULES = [
  { test: (h) => h === 'openrouter.ai' || h.endsWith('.openrouter.ai'), dialect: 'openrouter', base: () => official('openrouter') },
  { test: (h) => h === 'api.openai.com', dialect: 'openai', base: () => official('openai') },
  { test: (h) => h === 'generativelanguage.googleapis.com', dialect: 'gemini', base: () => official('gemini') },
  { test: (h) => /(^|\.)fal\.(run|ai)$/.test(h), dialect: 'fal', base: () => official('fal') },
  { test: (h) => h === 'api.replicate.com', dialect: 'replicate', base: () => official('replicate') },
  // ElevenLabs 有分区域的数据驻留地址（api.us. / api.eu.residency.）：保留原 host
  { test: (h) => /^api(\.[a-z0-9-]+)*\.elevenlabs\.io$/.test(h), dialect: 'elevenlabs', base: (h) => `https://${h}/v1` },
  // MiniMax 国内站 minimaxi.com、海外站 minimax.io（老地址 minimax.chat）：Key 不通用，保留原 host
  { test: (h) => /^api\.(minimaxi\.com|minimax\.io|minimax\.chat)$/.test(h), dialect: 'minimax', base: (h) => `https://${h}/v1` },
  // 火山方舟各区域（ark.cn-beijing.volces.com）与海外 BytePlus（ark.ap-southeast.bytepluses.com）
  { test: (h) => /^ark\.[a-z0-9-]+\.(volces|bytepluses)\.com$/.test(h), dialect: 'ark', base: (h) => `https://${h}/api/v3` },
];

/** 地址对应哪种方言：{ dialect, preset, kinds, baseUrl }。永不抛（地址不合法留给保存时报）。 */
export function dialectFor(baseUrl) {
  const raw = trimUrl(baseUrl);
  const h = hostOf(raw);
  const rule = h ? HOST_RULES.find((r) => r.test(h)) : null;
  if (rule) return { dialect: rule.dialect, preset: rule.dialect, kinds: [...DIALECT_KINDS[rule.dialect]], baseUrl: rule.base(h) };
  return { dialect: 'openai', preset: 'openai-compat', kinds: [...DIALECT_KINDS.openai], baseUrl: raw };
}

// 调用方指名方言时（模型中心记着上次托管成什么）：地址认得出且正是这个方言 → 官方预设；否则按「自定义 + 这个方言」，地址原样
function connFor(baseUrl, want) {
  const g = dialectFor(baseUrl);
  if (!want || want === g.dialect) return g;
  return { dialect: want, preset: 'custom', kinds: [...DIALECT_KINDS[want]], baseUrl: trimUrl(baseUrl) };
}
const wantedDialect = (d) => (DIALECTS.includes(d) && !NO_BASEURL.has(d) ? d : '');

// —— 鉴权方式：模型中心 bearer / x-api-key / goog / none ⇄ Studio 的 AUTH_STYLES ——
// 官方方言的鉴权是定死的（fal 要 'Key …'、ElevenLabs 要 xi-api-key），只有 OpenAI 兼容 / 自定义的 openai 方言才听模型中心的
function studioAuth(dialect, preset, style) {
  if (dialect !== 'openai' || preset === 'openai') return DIALECT_AUTH[dialect];
  if (style === 'goog') return 'x-goog-api-key';
  return AUTH_STYLES.includes(style) && style !== 'fal-key' && style !== 'xi-api-key' ? style : 'bearer';
}
// 模型中心没有 fal-key / xi-api-key 的说法：回空串，让它按自己的协议默认值走（这两种方言的 Key 只给 Studio 用）
function hubAuth(style) {
  if (style === 'x-goog-api-key') return 'goog';
  return ['bearer', 'x-api-key', 'none'].includes(style) ? style : '';
}

// 请求头：模型中心存 [{ name, value }]，Studio 存 { 名: 值 }。不合法的、bridge 自己管的鉴权头、Claude 协议专用的 anthropic-* 一律丢掉
// （Studio 的 normalizeHeaders 遇到这些会整单报错，模型中心那边合法的头不该因此让同步失败）
function cleanHeaders(h) {
  const list = Array.isArray(h) ? h : (h && typeof h === 'object' ? Object.entries(h).map(([name, value]) => ({ name, value })) : []);
  const out = {};
  for (const x of list) {
    const name = String(x?.name ?? '').trim();
    if (!name || !HEADER_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || /^anthropic-/i.test(name)) continue;
    out[name] = String(x?.value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
    if (Object.keys(out).length >= 16) break;
  }
  return out;
}
const headerList = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));

// —— list ——
/** 主机的全部 Studio 服务（模型中心首页「Media Studio」一栏、收编前挑服务用）。不带 Key，只有 keyTail。 */
export function list() {
  return hostProviders().map((p) => {
    const { key, sa } = providerSecret(p);
    const act = activeModels(p);
    const kinds = { image: 0, video: 0, speech: 0, music: 0 };
    for (const m of act) if (m.kind in kinds) kinds[m.kind] += 1;
    // vertex 用 Google 凭据：本机 ADC（主机的 gcloud 登录）或服务账号；本机模型不要 Key
    const hasKey = p.dialect === 'vertex' ? (p.google?.credMode !== 'json' || !!sa) : p.dialect === 'local' ? true : !!key;
    return {
      id: p.id, name: p.name, dialect: p.dialect, preset: p.preset, baseUrl: p.baseUrl, host: hostOf(p.baseUrl),
      enabled: p.enabled, shared: p.shared, hasKey, keyTail: key ? key.slice(-4) : '',
      managed: isManaged(p), hubRef: isManaged(p) ? p.hubRef : '',
      kinds, models: act.length,
    };
  });
}

// —— detect ——
const AUTH_RE = /api key not valid|api_key_invalid|permission_denied|unauthenticated|invalid api key|incorrect api key/i;
const isAuthError = (e) => !!e && (e.status === 401 || e.status === 403 || AUTH_RE.test(String(e.message || '')));
const isNetError = (e) => !!e && (['network', 'timeout', 'aborted'].includes(e.code) || e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(String(e.message || '')));
// 上游报错原文偶尔会回显 Key：拼进人话前把它抹掉
const scrub = (s, key) => (key && key.length >= 6 ? String(s).split(key).join('…') : String(s));

function detectError(e, host, key) {
  // 先抹后截：截断后的半截 Key 按整串匹配不上，就抹不掉了
  const why = scrub(String((e && e.message) || e || ''), key).slice(0, 300);
  if (isAuthError(e)) return Object.assign(new Error(`Media Studio 识别媒体模型时 ${host || '服务'} 拒绝了这个 API Key：${why}`), { status: 400, code: 'auth' });
  if (e?.code === 'timeout' || e?.name === 'TimeoutError') return Object.assign(new Error(`Media Studio 识别媒体模型时 ${host || '服务'} 超过 ${DETECT_MS / 1000} 秒没有回应`), { status: 504, code: 'timeout' });
  return Object.assign(new Error(`Media Studio 识别媒体模型时连不上 ${host || '服务'}：${why}`), { status: 502, code: 'network' });
}

function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('识别超时'), { code: 'timeout' })), ms); timer.unref?.(); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * 这个地址在 Studio 里能列出哪些媒体模型（不落盘）。同设置页「拉模型列表」：内置卡在前 + 上游列表，去重，
 * 只回有种类、且该方言能做的。上游列表拉不到（没有 /models、没填 Key、404…）不算错，只回内置卡；
 * 连不上、超时、Key 被拒抛 Error（message 是人话，status 400 / 502 / 504，code 'auth' | 'network' | 'timeout'）。
 */
export async function detect({ baseUrl, apiKey, authStyle, headers, dialect, useProxy } = {}) {
  const c = connFor(baseUrl, wantedDialect(dialect));
  const host = hostOf(c.baseUrl);
  // 走一遍规范化：地址不合法在这里就报人话（status 400）
  const draft = {
    ...normalizeProvider({ name: host || '模型中心', preset: c.preset, dialect: c.dialect, baseUrl: c.baseUrl, authStyle: studioAuth(c.dialect, c.preset, authStyle), headers: cleanHeaders(headers), models: [] }),
    id: 'p-draft000', owner: HOST_OWNER,
  };
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let remote = [];
  try {
    const got = await withTimeout(Promise.resolve().then(() => adapterFor(c.dialect).listModels(draft, { secret: { key, sa: '' }, signal: AbortSignal.timeout(DETECT_MS), ...(useProxy === false ? { dispatcher: DIRECT } : {}) })), DETECT_MS);
    remote = Array.isArray(got) ? got : [];
  } catch (e) {
    if (isAuthError(e) || isNetError(e)) throw detectError(e, host, key);
    remote = [];   // 接口不支持列模型、没填 Key、回了别的错：只回内置卡
  }
  // 内置卡只给官方预设：OpenAI 兼容 / 自定义接的是别家服务，OpenAI 官方的 gpt-image 之类不一定有
  const builtin = c.preset === c.dialect ? [...dialectBuiltinModels(c.dialect), ...(PRESET_BY_ID[c.preset]?.models || [])] : [];
  const kinds = DIALECT_KINDS[c.dialect];
  const seen = new Set();
  const models = [];
  for (const m of [...builtin, ...remote]) {
    const id = String(m?.id ?? '').trim();
    const kind = studioKind(m?.kind);
    if (!MODEL_ID_RE.test(id) || !kinds.includes(kind) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: String(m.label || id).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) || id, kind });
  }
  return { dialect: c.dialect, preset: c.preset, kinds: [...kinds], models };
}

// —— upsert ——
// 下一版的连接参数：地址没变（或没给）沿用原样；变了按地址重认方言——认不出的沿用原方言
// （中转站换地址很常见，不能因为新地址认不出就把 OpenRouter 服务降成 OpenAI 兼容、换掉驱动）
function nextConn(input, cur) {
  const want = wantedDialect(input.dialect);
  const urlGiven = input.baseUrl !== undefined;
  if (cur && (!urlGiven || trimUrl(input.baseUrl) === cur.baseUrl) && (!want || want === cur.dialect)) {
    return { dialect: cur.dialect, preset: cur.preset, baseUrl: cur.baseUrl };
  }
  const url = urlGiven ? input.baseUrl : cur?.baseUrl;
  if (want) return connFor(url, want);
  const g = dialectFor(url);
  if (cur && g.preset === 'openai-compat' && !NO_BASEURL.has(cur.dialect)) {
    return { dialect: cur.dialect, preset: cur.dialect === 'openai' && cur.preset !== 'custom' ? 'openai-compat' : 'custom', baseUrl: g.baseUrl };
  }
  return { dialect: g.dialect, preset: g.preset, baseUrl: g.baseUrl };
}

// 模型中心给的主列表全量清单 → Studio 的模型条目。同 id 的留原有 card / defaults（方言、种类都没变时——卡按 id 全局查，
// 跨方言留着会套错卡）与 discoveredAt / vendor；方言做不了的种类、不合 Studio id 规则的跳过并记进 skipped。
// 清单只管主列表：没被清单收下的停用 / 备选 / 下架条目原样留着（不删、不记 dismissed）。模型中心写进来的条目一律
// 启用、非备选、非下架，托管后巡检也不再改模型清单，所以这三种状态只可能是收编前留下的（收编时作 parked 交给模型中心）。
// 模型中心加过又移出的（启用、非备选）照旧移出。
function hubModels(listIn, cur, conn, skipped) {
  const kinds = DIALECT_KINDS[conn.dialect];
  const old = new Map((cur?.models || []).map((m) => [m.id, m]));
  const sameDialect = !!cur && cur.dialect === conn.dialect;
  const seen = new Set();
  const out = [];
  for (const x of listIn) {
    const id = String(x?.id ?? '').trim();
    const kind = studioKind(x?.kind);
    if (!MODEL_ID_RE.test(id)) { skipped.push({ id: id.slice(0, 200), kind, reason: 'Media Studio 的模型 id 只能用字母数字与 . _ - / : @ +（最长 200）' }); continue; }
    if (seen.has(id)) continue;   // 同一清单里重复的：留第一个
    if (!KINDS.includes(kind)) { skipped.push({ id, kind, reason: '不是媒体模型' }); continue; }
    if (!kinds.includes(kind)) { skipped.push({ id, kind, reason: `${dialectName(conn.dialect, conn.preset)} 做不了${KIND_NAME[kind]}` }); continue; }
    if (out.length >= MAX_MODELS) { skipped.push({ id, kind, reason: `一个媒体服务最多 ${MAX_MODELS} 个模型` }); continue; }
    seen.add(id);
    const o = old.get(id);
    const keep = o && sameDialect && o.kind === kind;
    out.push({
      id, kind,
      label: String(x?.label ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) || o?.label || id,
      // 来源同方言时照旧（内置 / 手填的收编后还是内置 / 手填：巡检不把它们当上游发现的去标下架，内置的也不去取 schema）
      enabled: true, source: o && sameDialect ? o.source : 'remote',
      ...(keep && o.card ? { card: o.card } : {}),
      defaults: keep ? o.defaults || {} : {},
      ...(o?.discoveredAt ? { discoveredAt: o.discoveredAt } : {}),
      ...(o?.vendor ? { vendor: o.vendor } : {}),
      // 显式写 false：updateProvider 只在条目里没有这两个键时才从旧条目补回，托管清单里的模型都该进主列表
      shelf: false, gone: false,
    });
  }
  // 清单之外的停用 / 备选 / 下架条目：清单里的优先占名额；换了方言的去掉卡、清空默认参数，新方言做不了的种类不留
  for (const o of cur?.models || []) {
    if (seen.has(o.id) || !(o.shelf === true || o.enabled === false || o.gone === true)) continue;
    if (!kinds.includes(o.kind) || out.length >= MAX_MODELS) continue;
    seen.add(o.id);
    if (sameDialect) out.push({ ...o });
    else { const { card, ...rest } = o; out.push({ ...rest, defaults: {} }); }
  }
  return out;
}

// 托管服务的参数 schema 后台刷新（巡检只刷 schema，见 discovery/index.mjs）；单测换成假的，免得真去连上游
const refreshesSchema = (p) => !!p && p.enabled && (p.dialect === 'openrouter' || SCHEMA_DIALECTS.has(p.dialect));
const defaultSchemaRefresh = (id) => syncProvider(HOST_OWNER, id, { reason: 'hub' });
let schemaRefresh = defaultSchemaRefresh;
export function _setSchemaRefreshForTests(fn) { schemaRefresh = typeof fn === 'function' ? fn : defaultSchemaRefresh; }
function kickSchema(id) {
  try { Promise.resolve(schemaRefresh(id)).catch(() => {}); } catch {}
}

/**
 * 按 hubRef 建 / 改托管服务 → { id, dialect, created, skipped:[{ id, kind, reason }] }。
 * 字段不传 = 不动；apiKey 不传 = 不动、'' = 清掉；shared（共享给成员）不传 = 不动，新建时缺省不共享；
 * models 是主列表的全量（列了的都启用、移出备选；没列的启用条目移出，走设置页删模型的同一条路；
 * 没列的停用 / 备选 / 下架条目原样留着，见 hubModels）。
 * 数量上限、地址不合法等校验错误原样抛（status 400）。
 */
export function upsert(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const hubRef = checkRef(input.hubRef);
  const cur = findManaged(hubRef);
  const conn = nextConn(input, cur);
  const dialectChanged = !!cur && cur.dialect !== conn.dialect;
  const connChanged = !cur || dialectChanged || cur.baseUrl !== conn.baseUrl || cur.preset !== conn.preset;
  const skipped = [];
  const patch = {};
  if (connChanged) Object.assign(patch, { preset: conn.preset, dialect: conn.dialect, baseUrl: conn.baseUrl });
  if (input.name !== undefined) patch.name = input.name;
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled;
  if (typeof input.shared === 'boolean') patch.shared = input.shared;
  if (input.headers !== undefined) patch.headers = cleanHeaders(input.headers);
  if (input.authStyle !== undefined) patch.authStyle = studioAuth(conn.dialect, conn.preset, input.authStyle);
  else if (connChanged) patch.authStyle = studioAuth(conn.dialect, conn.preset, cur ? hubAuth(cur.authStyle) : 'bearer');
  if (typeof input.apiKey === 'string') patch.apiKey = input.apiKey;
  if (Array.isArray(input.models)) patch.models = hubModels(input.models, cur, conn, skipped);
  else if (dialectChanged) {
    // 只换了方言、没给清单：留下新方言做得了的，卡与默认参数清掉（换了驱动，旧卡不适用）
    const kinds = DIALECT_KINDS[conn.dialect];
    patch.models = cur.models.filter((m) => {
      if (kinds.includes(m.kind)) return true;
      skipped.push({ id: m.id, kind: m.kind, reason: `${dialectName(conn.dialect, conn.preset)} 做不了${KIND_NAME[m.kind] || m.kind}` });
      return false;
    }).map(({ card, ...m }) => ({ ...m, defaults: {} }));
  }

  let id, created = false;
  if (!cur) {
    const p = createProvider({
      headers: {}, models: [], ...patch,
      shared: patch.shared === true, autoSync: false, managedBy: 'hub', hubRef,
    }, HOST_OWNER);
    id = p.id; created = true;
  } else {
    updateProvider(cur.id, patch, HOST_OWNER);
    id = cur.id;
  }

  // 新建、换地址 / 方言 / Key、加了新模型、重新启用时，后台补一次 schema（OpenRouter 非 GPT 的生图模型缺 schema 会退到 GPT Image 驱动）
  const next = getProvider(id, HOST_OWNER);
  const oldIds = new Set((cur?.models || []).map((m) => m.id));
  const gotNew = (next?.models || []).some((m) => !oldIds.has(m.id));
  const reEnabled = !!cur && !cur.enabled && next?.enabled;
  if (refreshesSchema(next) && (created || connChanged || typeof input.apiKey === 'string' || gotNew || reEnabled)) kickSchema(id);
  return { id, dialect: conn.dialect, created, skipped };
}

// —— adopt / release / remove ——
/**
 * 把已有的 Studio 服务原地收编成托管（id 不变；同一 hubRef 重复调用幂等）。
 * 回连接信息 + 明文 Key（模型中心抄成自己服务的 Key，只在服务端内部用）+ 主列表里的模型（models）
 * + 启用（enabled）与共享给成员（shared）的现状 + parked：停用或备选、没下架的模型 [{ id, label, kind }]
 * （模型中心记进目录当「未添加」，不进它的清单；upsert 也不会动这些条目，见 hubModels）。
 * headers 回模型中心的格式 [{ name, value }]，authStyle 回模型中心的叫法（fal / ElevenLabs 这类没有对应的回 ''）。
 */
export function adopt(id, hubRef) {
  hubRef = checkRef(hubRef);
  const p = getProvider(String(id ?? ''), HOST_OWNER);
  if (!p) throw bad('没有这个媒体服务', 404);
  if (p.dialect === 'vertex') throw bad('Vertex 服务用的是 Google 云凭据，不能收编进模型中心（在 设置 › 模型中心 的 Vertex 卡里管）');
  if (p.dialect === 'local') throw bad('本机图像模型不用地址和 Key，不能收编进模型中心');
  if (isManaged(p) && p.hubRef !== hubRef) throw bad('这个媒体服务已经由模型中心的另一个服务管理');
  const other = findManaged(hubRef);
  if (other && other.id !== p.id) throw bad(`模型中心的这个服务已经托管了媒体服务「${other.name}」`);
  if (!isManaged(p)) updateProvider(p.id, { managedBy: 'hub', hubRef }, HOST_OWNER);
  const cur = getProvider(p.id, HOST_OWNER) || p;
  return {
    id: cur.id, name: cur.name, dialect: cur.dialect, preset: cur.preset, baseUrl: cur.baseUrl,
    authStyle: hubAuth(cur.authStyle), headers: headerList(cur.headers), apiKey: providerSecret(cur).key,
    enabled: cur.enabled !== false, shared: cur.shared === true,
    models: activeModels(cur).map((m) => ({ id: m.id, label: m.label, kind: m.kind })),
    parked: (cur.models || []).filter((m) => !m.gone && (m.enabled === false || m.shelf === true))
      .map((m) => ({ id: m.id, label: m.label, kind: m.kind })),
  };
}

/** 取消托管：去掉 managedBy / hubRef，服务与模型原样留下，变回普通服务。回 { id } | null（没有这个托管服务）。 */
export function release(hubRef) {
  const p = findManaged(checkRef(hubRef));
  if (!p) return null;
  updateProvider(p.id, { managedBy: '', hubRef: '' }, HOST_OWNER);
  return { id: p.id };
}

/** 删除托管服务（同设置页删除：连 Key、巡检状态、调用日志一起清）。回 { id } | null。 */
export function remove(hubRef) {
  const p = findManaged(checkRef(hubRef));
  if (!p) return null;
  deleteProvider(p.id, HOST_OWNER);
  dropLog(HOST_OWNER, p.id);
  return { id: p.id };
}

// —— 内置媒体服务（Vertex / 本机）——
// 这两种不是「地址 + Key」，抄不成模型中心的服务；模型中心统一入口以后（2026-11-13）由模型中心的面板直接读写它们：
// Vertex 的媒体模型挂在模型中心的 Vertex 卡下面（凭据本来就是同一份），本机图像模型单独一张卡。数据仍只在 Studio 这里。
const BUILTIN_DIALECTS = new Set(['vertex', 'local']);
const builtinView = (p) => ({
  id: p.id, name: p.name, dialect: p.dialect, enabled: p.enabled !== false, shared: p.shared === true,
  models: (p.models || []).filter((m) => !m.gone).map((m) => ({ id: m.id, label: m.label || m.id, kind: m.kind, enabled: m.enabled !== false && m.shelf !== true })),
});
/** 主机的内置媒体服务（不托管的 vertex / local）。 */
export function builtins() {
  return hostProviders().filter((p) => BUILTIN_DIALECTS.has(p.dialect) && !isManaged(p)).map(builtinView);
}
/**
 * 改一个内置媒体服务 → 改后的视图。patch = { enabled?, shared?, models?: { 模型 id: 开 / 关 } }（没列的模型不动）。
 * 打开的模型同时移出备选（shelf），和设置页把它挪回主列表一样。
 */
export function setBuiltin(id, patch = {}) {
  const p = getProvider(String(id ?? ''), HOST_OWNER);
  if (!p || !BUILTIN_DIALECTS.has(p.dialect) || isManaged(p)) throw bad('没有这个内置媒体服务', 404);
  const out = {};
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  if (typeof patch.shared === 'boolean') out.shared = patch.shared;
  if (patch.models && typeof patch.models === 'object') {
    const want = patch.models;
    out.models = (p.models || []).map((m) => (typeof want[m.id] === 'boolean' && !m.gone
      ? { ...m, enabled: want[m.id], ...(want[m.id] ? { shelf: false } : {}) } : m));
  }
  if (Object.keys(out).length) updateProvider(p.id, out, HOST_OWNER);
  return builtinView(getProvider(p.id, HOST_OWNER) || p);
}

export const hub = Object.freeze({ list, dialectFor, detect, upsert, adopt, release, remove, builtins, setBuiltin });
