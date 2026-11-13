// 设置 › Media Studio 的数据面：媒体服务（§3.1）、Studio 设置（§3.5，主机级 + 个人级）、一键导入 Vertex、
// 默认模型选择器用的模型目录（§3.2）。只给懒加载的设置正文用——核心（Settings.svelte 等）不许静态 import 本文件，
// 否则会被 module-chunks 记进 leaks。
//
// 后端：/api/studio/providers*、/api/studio/settings、/api/studio/catalog（modules/studio/server，studio-backend）。
// 总线 {type:'studio.providers'} 推来整份替换服务列表并重拉目录；{type:'studio.settings'} 重拉设置。
// 主机管理员与成员各有一份服务（同 Claude 的自定义 API）：成员只许公网地址、有个数上限、不能共享；
// 管理员 shared 的服务成员能用，但只看得到名字、种类、模型名（sp.shared）。
//
// dev 专用 fixture：后端骨架没到时，localStorage 'bridge-studio-fixture' = '1'（或地址带 ?studioFixture）就改走
// ./settingsFixture.js 的内存实现。判断写在 import.meta.env.DEV 后面，生产构建整段剪掉、不会出 chunk。
import { api } from '../../lib/api.js';
import { busOn } from '../../lib/bus.js';
import { me } from '../../lib/state.svelte.js';
import { t, tr, isEn } from '../../lib/i18n.js';
import { providerLogo } from '../../lib/providerLogos.js';
import { STUDIO_SETTINGS, STUDIO_SETTING_BY_KEY, STUDIO_SETTING_GROUPS, studioSettingDefaults, studioSettingVisible, isPersonal } from './settingsRegistry.js';
import { KIND } from './icons.js';

export { STUDIO_SETTINGS, STUDIO_SETTING_BY_KEY, STUDIO_SETTING_GROUPS };

// —— 请求（dev fixture 分流）——
const fixtureOn = () => { try { return localStorage.getItem('bridge-studio-fixture') === '1' || new URLSearchParams(location.search).has('studioFixture'); } catch { return false; } };
let fx = null;
async function call(method, path, body) {
  if (import.meta.env.DEV && fixtureOn()) {
    fx ||= await import('./settingsFixture.js');
    return fx.handle(method, path, body, me);
  }
  return method === 'GET' ? api.get(path) : api.post(path, body);
}
const msg = (e) => trErr((e && e.body && (e.body.error || (typeof e.body === 'string' ? e.body : ''))) || (e && e.message) || String(e));

// —— 服务端报错的英文显示 ——
// 适配器的报错常是「<服务名> <HTTP 状态>：<说明>（<上游原话>）」（modules/studio/server/adapters/http.mjs）。服务名可能带空格，
// 整句模式键 '{label} {status}：…' 会在服务名的第一个空格处切开；上游原话多是英文，'{hint}（{up}）' 又不够两个汉字当不了模式键。
// 所以先拆：前缀「服务名 状态码：」单独翻服务名；句尾括号里没有汉字的（上游原话）原样留着，括号外再 tr()。中文界面原样返回。
function trTail(s) {
  const whole = tr(s);
  if (whole !== s) return whole;
  const m = /^([\s\S]*?)（([^（）]*)）$/.exec(s);
  return m && !/[\u4e00-\u9fff]/.test(m[2]) ? tr(m[1]) + ' (' + m[2] + ')' : whole;
}
export function trErr(s) {
  const str = s == null ? '' : String(s);
  if (!str || !isEn()) return tr(str);
  const m = /^([\s\S]*?) ?(\d{3})：([\s\S]*)$/.exec(str);
  if (!m) return trTail(str);
  return (m[1] ? tr(m[1]) + ' ' : '') + m[2] + ': ' + trTail(m[3]);
}
async function post(path, body) {
  try { return await call('POST', path, body); }
  catch (e) { throw new Error(msg(e)); }
}

// —— 种类 ——
export const KINDS = Object.freeze(['image', 'video', 'speech', 'music']);
const KIND_NAME = { image: () => t('图像'), video: () => t('视频'), speech: () => t('配音'), music: () => t('音乐') };
export const kindName = (k) => (KIND_NAME[k] ? KIND_NAME[k]() : String(k || ''));
// 种类的线稿字形：复用 icons.js 的 KIND（设置页的配音键叫 speech，字形是 KIND.voice）；种类不着色，靠字形和文字区分（方案 §5.2）
export const KIND_GLYPH = Object.freeze({ image: KIND.image, video: KIND.video, speech: KIND.voice, music: KIND.music });
export const kindSvg = (k) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (KIND_GLYPH[k] || '') + '</svg>';

// —— 媒体服务 ——
export const sp = $state({
  ok: false,          // 拿到过完整列表（= 当前身份能用 Studio）
  loaded: false,
  member: false,      // 成员自己的那份（只许公网地址、有个数上限）
  maxProviders: 0,
  canShare: false,    // 多用户服务器上的管理员：编辑器里出「共享给成员」开关
  shared: [],         // 成员：管理员共享给他的服务（只读：名字、预设、方言、模型名）
  providers: [],
  presets: [],
  rev: 0,
  dialects: null,     // 方言 → 能出的种类（服务端 DIALECT_KINDS）
  authStyles: null,   // 鉴权方式清单（服务端 AUTH_STYLES）
  dialectAuth: null,  // 方言 → 默认鉴权方式
  discoverable: [],   // 能自动发现模型的方言（服务端 DISCOVERABLE；编辑器据此出「自动发现」开关）
  syncing: {},        // 服务 id → true：「立即检查」进行中
  vertexImport: null, // 管理员：{ available:{google,gemini,openrouter,local}, last:{at,items}|null }
  importing: false,
  importResult: null, // 刚点完「导入」的逐项结果 { items, importedAt }
  err: '',
});
let pLoading = null;

function adoptProviders(r) {
  if (Array.isArray(r?.providers)) sp.providers = r.providers;
  if (Array.isArray(r?.presets)) sp.presets = r.presets;
  if (typeof r?.member === 'boolean') { sp.member = r.member; sp.maxProviders = r.maxProviders || 0; }
  if (typeof r?.canShare === 'boolean') sp.canShare = r.canShare;
  if (Array.isArray(r?.shared)) sp.shared = r.shared;
  if (r?.dialects && typeof r.dialects === 'object') sp.dialects = r.dialects;
  if (Array.isArray(r?.authStyles)) sp.authStyles = r.authStyles;
  if (r?.dialectAuth && typeof r.dialectAuth === 'object') sp.dialectAuth = r.dialectAuth;
  if (Array.isArray(r?.discoverable)) sp.discoverable = r.discoverable;
  if (r && 'vertexImport' in r) sp.vertexImport = r.vertexImport || null;
  if (typeof r?.rev === 'number') sp.rev = r.rev;
  sp.ok = true;
  sp.loaded = true;
}

export function loadProviders(force = false) {
  if (pLoading && !force) return pLoading;
  pLoading = call('GET', '/api/studio/providers')
    .then((r) => { adoptProviders(r); sp.err = ''; })
    .catch((e) => { sp.loaded = true; if (e && (e.status === 403 || e.status === 401)) sp.ok = false; else sp.err = msg(e); })
    .finally(() => { pLoading = null; });
  return pLoading;
}
export async function createProvider(draft) {
  const r = await post('/api/studio/providers/create', draft);
  await Promise.all([loadProviders(true), loadCatalog(true)]);
  return r.provider;
}
export async function updateProvider(id, patch) {
  const r = await post('/api/studio/providers/update', { id, patch });
  await Promise.all([loadProviders(true), loadCatalog(true)]);
  return r.provider;
}
export async function deleteProvider(id) {
  await post('/api/studio/providers/delete', { id });
  await Promise.all([loadProviders(true), loadCatalog(true)]);
}
/** 测试连接（不花钱）：{ id } 测已存的；{ draft } 测编辑中的；可带 model。 */
export async function testProvider({ id, draft, model }) {
  const r = await post('/api/studio/providers/test', { id, draft, model });
  return r.result;
}
/** 拉服务的模型列表：[{ id, label, kind|null }]。 */
export async function fetchModels({ id, draft }) {
  const r = await post('/api/studio/providers/models', { id, draft });
  return r.models || [];
}
export async function providerLog(id) {
  const r = await call('GET', '/api/studio/providers/log?id=' + encodeURIComponent(id));
  return r.log || [];
}
// —— 自动识别（方案 §9.3）：巡检状态、立即检查、新发现的模型 ——
/** 这种方言能不能自动发现模型（服务端没下发 discoverable 的老版本 = 都不能）。 */
export const canDiscover = (dialect) => !!dialect && sp.discoverable.includes(dialect);
/** 立即检查：POST /api/studio/providers/sync { id }，回这个服务的巡检状态 { at, ok, error?, added, gone }。
 *  请求本身失败（服务删了、方言不能发现）抛错；巡检失败不抛，状态里 ok:false。检查中 sp.syncing[id] = true。 */
export async function syncProvider(id) {
  if (!id || sp.syncing[id]) return null;
  sp.syncing = { ...sp.syncing, [id]: true };
  try {
    const r = await post('/api/studio/providers/sync', { id });
    if (Array.isArray(r?.providers)) sp.providers = r.providers;
    await Promise.all([loadProviders(true), loadCatalog(true)]);
    return r?.results?.[id] || null;
  } finally {
    const { [id]: _, ...rest } = sp.syncing;
    sp.syncing = rest;
  }
}
const NEW_MS = 7 * 86400_000;
/** 7 天内新发现的模型（巡检收进主列表的；备选、已下线的不算）。 */
export const isNewModel = (m, now = Date.now()) => !!m && m.source === 'remote' && !m.shelf && !m.gone && Number(m.discoveredAt) > 0 && now - Number(m.discoveredAt) < NEW_MS;
export const hasNewModels = (p) => { const now = Date.now(); return (p?.models || []).some((m) => isNewModel(m, now)); };
/** 上次检查失败（服务行标「检查失败」）。 */
export const syncFailed = (p) => !!p?.sync && p.sync.ok === false;

/** 一键导入 Vertex（幂等：再点一次就地更新）。结果逐项留在 sp.importResult。 */
export async function importVertex() {
  if (sp.importing) return null;
  sp.importing = true; sp.err = '';
  try {
    const r = await post('/api/studio/providers/import-vertex', {});
    sp.importResult = { items: r.items || [], importedAt: r.importedAt || Date.now() };
    await Promise.all([loadProviders(true), loadCatalog(true), loadSettings()]);
    return sp.importResult;
  } catch (e) {
    sp.importResult = { error: e.message || String(e), items: [] };
    return null;
  } finally { sp.importing = false; }
}

/** 服务里启用的模型覆盖了哪些种类（按 KINDS 顺序）。 */
export function providerKinds(p) {
  const on = new Set(enabledModels(p).filter((m) => m.kind).map((m) => m.kind));
  return KINDS.filter((k) => on.has(k));
}
// 备选（聚合服务巡检建底收下的，可能上百个）与已下线的不算在「启用的模型」里——目录主列表也不列它们
export const enabledModels = (p) => (p?.models || []).filter((m) => m.enabled !== false && !m.shelf && !m.gone);
/** 入口摘要：服务数 / 启用模型数（只数启用的服务）。 */
export function providerSummary() {
  const live = sp.providers.filter((p) => p.enabled !== false);
  return { p: sp.providers.length, m: live.reduce((n, p) => n + enabledModels(p).length, 0), shared: sp.shared.length };
}
/** 一个服务缺不缺凭据（列表上标「缺 Key」）。 */
export function lacksCredential(p) {
  if (!p) return false;
  if (p.dialect === 'vertex') return p.google?.credMode === 'json' && !p.hasServiceAccount;
  if (p.dialect === 'local' || p.authStyle === 'none') return false;
  return !p.hasKey;
}
// 调用日志的状态：服务端记 'ok' | 'error' | 'canceled'（老版本 / 别的实现可能给 HTTP 状态码，一并认）
export const logOk = (l) => l?.status === 'ok' || (typeof l?.status === 'number' && l.status >= 200 && l.status < 300);
export const logBad = (l) => l?.status === 'error' || (typeof l?.status === 'number' && (l.status >= 400 || l.status === 0));
const LOG_TEXT = { ok: () => t('成功'), error: () => t('失败'), canceled: () => t('已取消') };
export const logStatusText = (l) => (LOG_TEXT[l?.status] ? LOG_TEXT[l.status]() : String(l?.status ?? '—'));
export const isGoogle = (dialect) => dialect === 'vertex' || dialect === 'gemini';
/** 服务 / 预设的品牌标：本机模型用「显示器 + 画框」线稿（lib/providerLogos 里的 local 是 Ollama 的标）；
 *  「自定义」「OpenAI 兼容」不冒充任何一家，按地址猜，猜不出回空串（调用方画首字头像）。 */
export function logoFor(p) {
  if (!p) return '';
  const pre = p.dialect === 'local' || p.preset === 'local' ? 'local-image'
    : p.preset && p.preset !== 'custom' && p.preset !== 'openai-compat' ? p.preset
      : p.dialect && p.dialect !== 'openai' ? p.dialect : '';
  return providerLogo({ preset: pre, baseUrl: p.baseUrl });
}

// —— 一键导入 Vertex：四项来源 ——
export const IMPORT_ITEMS = Object.freeze([
  { id: 'google', name: () => t('Google 云凭据'), what: () => t('Vertex AI：Nano Banana 图像、Veo 视频、Gemini 配音、Lyria 音乐') },
  { id: 'gemini', name: () => t('Gemini API Key'), what: () => t('Nano Banana 2K / 4K、Omni 视频、Lyria 3 音乐') },
  { id: 'openrouter', name: () => t('OpenRouter Key'), what: () => t('GPT Image 2.5 等 OpenRouter 上的图像模型') },
  { id: 'local', name: () => t('本机图像模型'), what: () => t('这台电脑上部署的 Qwen 图像模型') },
]);
const STATUS = {
  created: () => t('已导入'), updated: () => t('已更新'), missing: () => t('未配置'), error: () => t('失败'), skipped: () => t('跳过'),
};
export const importStatusText = (s) => (STATUS[s] ? STATUS[s]() : String(s || ''));
/** 已经从 Vertex 导入过的服务（按导入时间新到旧）。 */
export const importedProviders = () => sp.providers.filter((p) => p.importedFrom === 'vertex').sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
export function lastImportAt() {
  const ps = importedProviders();
  return Math.max(sp.vertexImport?.last?.at || 0, ...ps.map((p) => p.importedAt || 0)) || 0;
}

// —— Studio 设置（主机级 + 个人级）——
export const ss = $state({
  loaded: false,
  host: null,          // { values, changed }（只有管理员拿得到）
  mine: null,          // { values, changed }
  effective: studioSettingDefaults(),
  canEditHost: false,
  busy: '',
  err: '',
});
function adoptSettings(r) {
  ss.host = r?.host ? { values: { ...studioSettingDefaults(), ...(r.host.values || {}) }, changed: r.host.changed || [] } : null;
  ss.mine = r?.mine ? { values: { ...(r.mine.values || {}) }, changed: r.mine.changed || [] } : { values: {}, changed: [] };
  ss.effective = { ...studioSettingDefaults(), ...(r?.effective || {}) };
  ss.canEditHost = !!r?.canEditHost;
  ss.loaded = true;
}
export async function loadSettings() {
  try { adoptSettings(await call('GET', '/api/studio/settings')); ss.err = ''; }
  catch (e) { ss.err = msg(e); }
}
/** 这一项改哪一层：管理员改主机（也是成员的默认）；成员只能改个人项。 */
export const scopeOf = (key) => (ss.canEditHost ? 'host' : isPersonal(key) ? 'mine' : null);
export const canEdit = (key) => !!scopeOf(key);
/** 界面上显示的值：管理员看主机层，成员看生效值（个人压过主机）。 */
export function valueOf(key) {
  const s = STUDIO_SETTING_BY_KEY[key];
  const v = ss.canEditHost && ss.host ? ss.host.values[key] : ss.effective[key];
  return v === undefined ? s?.default : v;
}
/** 改过默认值没有（行上的小点、「恢复默认」）：成员 = 自己覆盖过。 */
export const changedOf = (key) => (ss.canEditHost ? ss.host?.changed?.includes(key) : ss.mine?.changed?.includes(key)) || false;
/** 改一项；value = null 恢复默认（成员 = 回到跟随管理员）。乐观更新，失败回滚并显示原因。 */
export async function setSetting(key, value) {
  const scope = scopeOf(key);
  if (!scope || ss.busy) return false;
  const layer = scope === 'host' ? ss.host : ss.mine;
  const prevLayer = layer ? { ...layer.values } : null;
  const prevEff = { ...ss.effective };
  if (layer) layer.values = { ...layer.values, [key]: value === null ? STUDIO_SETTING_BY_KEY[key]?.default : value };
  if (value !== null) ss.effective = { ...ss.effective, [key]: value };
  ss.busy = key; ss.err = '';
  try { adoptSettings(await post('/api/studio/settings', { scope, values: { [key]: value } })); return true; }
  catch (e) { if (layer && prevLayer) layer.values = prevLayer; ss.effective = prevEff; ss.err = e.message || t('保存失败'); return false; }
  finally { ss.busy = ''; }
}
/** 某一组里要显示的键（管理员：全部；成员：个人项）。 */
export function groupKeys(gid, agentIds) {
  const values = ss.canEditHost && ss.host ? ss.host.values : ss.effective;
  return STUDIO_SETTINGS.filter((s) => s.group === gid && s.type !== 'defaults' && canEdit(s.key) && studioSettingVisible(s.key, values, agentIds, ss.canEditHost ? 'host' : 'mine')).map((s) => s.key);
}
export const settingLabel = (key) => tr(STUDIO_SETTING_BY_KEY[key]?.label || key);
export const settingDesc = (key) => (STUDIO_SETTING_BY_KEY[key]?.desc ? tr(STUDIO_SETTING_BY_KEY[key].desc) : '');
export const settingOptions = (key) => (STUDIO_SETTING_BY_KEY[key]?.options || []).map((v, i) => ({ value: v, label: tr((STUDIO_SETTING_BY_KEY[key].optionLabels || [])[i] || v) }));
export const settingValueLabel = (key) => settingOptions(key).find((o) => o.value === valueOf(key))?.label || String(valueOf(key) ?? '');
export const groupLabel = (g) => tr(g.label);
export const groupFoot = (g) => (g.foot ? tr(g.foot) : '');

// —— 默认模型（每个种类一个 { provider, model }）——
export const defaultOf = (kind) => (valueOf('defaults') || {})[kind] || null;
// 成员自己选过的默认模型。服务端 mine.values 对没改过的项给的是主机值（studio-settings 的 studioMineSnapshot），
// 真正自己改过的看 mine.changed；defaults 改过时 values.defaults 就是他自己选的那几个种类（不和主机合并）。
const mineDefaults = () => (ss.mine?.changed?.includes('defaults') ? ss.mine?.values?.defaults || {} : {});
/** 成员：这个种类是不是自己挑的（否则跟随管理员）。 */
export const defaultMine = (kind) => !ss.canEditHost && !!mineDefaults()[kind];
export async function setDefault(kind, pick) {
  // 成员只在自己选过的那几个种类上增删（别把管理员的默认抄进个人层，抄了以后管理员再改就跟不上了）
  const base = { ...((ss.canEditHost ? ss.host?.values?.defaults : mineDefaults()) || {}) };
  if (pick) base[kind] = { provider: pick.provider, model: pick.model };
  else delete base[kind];
  return setSetting('defaults', base);
}

// —— 模型目录（默认模型选择器用；成员拿到的是自己的 + 共享的）——
export const cat = $state({ loaded: false, kinds: {}, err: '' });
let cLoading = null;
export function loadCatalog(force = false) {
  if (cLoading && !force) return cLoading;
  cLoading = call('GET', '/api/studio/catalog')
    .then((r) => { cat.kinds = r?.kinds || {}; cat.loaded = true; cat.err = ''; })
    .catch((e) => { cat.loaded = true; cat.err = msg(e); })
    .finally(() => { cLoading = null; });
  return cLoading;
}
/** 某种类可选的模型，按服务分组：[{ provider:{id,name,dialect,preset,mine}, models:[{key,id,label,desc}] }]。 */
// 只给有主列表模型的组（§9.3：只有备选的服务这一种 models 是空数组——设置里选默认模型不列备选，空组不出标题）
export const catalogGroups = (kind) => (cat.kinds?.[kind]?.groups || []).filter((g) => (g.models || []).length);
/** { provider, model } → { model 显示名, provider 显示名, dialect }；目录里找不到（停用 / 删了）回 null。 */
export function resolvePick(kind, pick) {
  if (!pick?.provider || !pick?.model) return null;
  for (const g of catalogGroups(kind)) {
    if (g.provider.id !== pick.provider) continue;
    const m = g.models.find((x) => x.id === pick.model);
    if (m) return { label: m.label || m.id, provider: tr(g.provider.name), dialect: g.provider.dialect, preset: g.provider.preset };
  }
  return null;
}
/** 目录里这个模型在 Studio 里的显示名（模型卡给的，如 gemini-3-pro-image → Nano Banana Pro）；目录里没有、或显示名就是 id 回空串。
 *  主列表与备选都找；给了 kind 只找那一种。 */
export function catalogLabel(providerId, modelId, kind) {
  if (!providerId || !modelId) return '';
  for (const k of kind ? [kind] : KINDS) {
    for (const g of cat.kinds?.[k]?.groups || []) {
      if (g.provider?.id !== providerId) continue;
      const m = (g.models || []).find((x) => x.id === modelId) || (g.shelf || []).find((x) => x.id === modelId);
      if (m?.label && m.label !== m.id) return m.label;
    }
  }
  return '';
}
/** 服务编辑器里模型行的主名：自己起过名的用自己的，否则用目录（Studio 里）的显示名，再不行就是 id。 */
export const modelTitle = (m, providerId) => (!m ? '' : m.label && m.label !== m.id ? m.label : catalogLabel(providerId, m.id, m.kind) || m.id || '');

/** 默认图像服务是不是 Google 系（安全设置只对 Google 系生效：不是就标「当前服务不适用」）。 */
export function safetyApplies() {
  const pick = defaultOf('image');
  const r = resolvePick('image', pick);
  if (r) return isGoogle(r.dialect);
  const p = sp.providers.find((x) => x.id === pick?.provider) || sp.shared.find((x) => x.id === pick?.provider);
  return p ? isGoogle(p.dialect) : true;   // 还没设默认 = 跟内置（Google）走
}

// —— 总线 ——
busOn((ev) => {
  if (!ev) return;
  if (ev.type === 'studio.providers') { adoptProviders(ev); loadCatalog(true); }
  else if (ev.type === 'studio.settings') loadSettings();
});

/** 进设置页时拉一遍（三份并行）。 */
export function loadAll() {
  return Promise.all([loadProviders(true), loadSettings(), loadCatalog(true)]);
}
