// 设置 › dimensio 的数据面（2026-11-02）：桌面 SettingsDesktop 与手机 Settings 两套外壳共用，排版各管各的。
// 全部经反代 /api/harness/api/* 读写 dimensio 自己的接口，设置页不另存一份：
//   config  —— /api/config：默认厂商 / 型号 / 思考档 / fast、默认运行档位、访问范围、权限规则、工作空间
//   info    —— /api/info：厂商目录（型号与档位）、各家有没有 key、租户信息、版本、能力位
//   prefs   —— /api/prefs：偏好注册表（dimensio 各功能登记的项，按分组通用渲染；每项带英文 en）
//   mem     —— /api/memory/overview 的一句话现状
//   local   —— 本机模型两台引擎的状态与启动参数（管理员、目录里有「本机」这家时）
// 进 dimensio 分区才拉：打 /api/harness 会把没在跑的 harness 拉起来，别在打开设置时就打。
// dimensio 关着 / 起不来 / 没权限：phase = 'down'，why 是给人看的原因，各组据此降级（不报错、不白屏）。
// 厂商面板（自定义服务）、记忆面板、本机模型面板不在设置里另做一套：openInDimensio(intent) 关掉设置、切到 dimensio 页，
// 由 HarnessPage 接住 ds.intent 打开 dimensio 自己的那张面板。这里改过配置就 ds.rev + 1，dimensio 页开着时据此重拉。
import { api } from './api.js';
import { ui, me } from './state.svelte.js';
import { goto } from './pageMorph.js';
import { openPreview } from './preview.svelte.js';
import { t, tc, tr, isEn } from './i18n.js';

const H = '/api/harness/api';

export const ds = $state({
  phase: 'idle',      // 'idle' 没拉过 | 'loading' | 'ready' | 'down'
  why: '',            // down 时的原因（人话）
  config: null,
  info: null,
  prefs: null,        // { groups, items } | null（旧 harness 没有这个接口）
  mem: null,          // { active, waiting, places } | null
  local: {},          // { qwen?: status, strata?: status }
  sessions: [],       // 最近的对话（导出诊断包用）
  busy: '',           // 正在写的那一项（tag）
  err: '',            // 最近一次写失败的人话
  errAt: '',          // 失败的是哪一项（tag），外壳把报错摆在那一组下面
  diagMsg: '',
  rev: 0,
  intent: null,       // 'vendors' | 'vendor:<自定义服务 id>' | 'memory' | 'local:qwen' | 'local:strata'
});

const caps = () => ds.info?.protocol?.capabilities || [];
export const hasCap = (c) => caps().includes(c);
export const isTenant = () => !!ds.info?.tenant?.tenant;
export const dimReady = () => ds.phase === 'ready' && !!ds.config;

function downWhy(e) {
  const s = e?.status || 0;
  const raw = typeof e?.body === 'object' ? e?.body?.error : typeof e?.body === 'string' ? e.body : '';
  if (s === 401) return t('登录已失效，重新登录后再看');
  if (s === 403) return tr(raw) || t('你的账号不能用 dimensio');
  if (s === 502 || s === 504) return t('dimensio 服务没有响应，稍后再试');
  if (s === 503) return tr(raw) || t('dimensio 服务没起来，稍后再试');
  if (!s) return t('连不上服务器');
  return tr(raw) || t('读取失败（HTTP {status}）', { status: s });
}

let seq = 0;
/** 拉一遍（进分区、重试时调）。quiet：已经有数据时静默刷新，不闪「读取中」。 */
export async function loadDimensio({ quiet = false } = {}) {
  const my = ++seq;
  if (!quiet || !ds.config) ds.phase = 'loading';
  try {
    const [config, info] = await Promise.all([api.get(H + '/config'), api.get(H + '/info')]);
    if (my !== seq) return;
    ds.config = config; ds.info = info; ds.phase = 'ready'; ds.why = '';
  } catch (e) {
    if (my !== seq) return;
    ds.phase = 'down'; ds.why = downWhy(e);
    return;
  }
  // 其余各取各的：哪一样失败只是那一组不出
  loadPrefs(); loadMemoryLine(); loadSessions(); loadLocal();
}

// —— 写配置：序号守卫（连着改两项，后发的赢）；失败把服务端原话摆出来 ——
let cfgSeq = 0;
function fail(tag, e, fallback) {
  const raw = typeof e?.body === 'object' ? e?.body?.error : typeof e?.body === 'string' ? e.body : e?.message;
  ds.err = tr(raw) || fallback || t('保存失败'); ds.errAt = tag;
}
export const errOf = (tag) => (ds.errAt === tag ? ds.err : '');
export const errIn = (prefix) => (ds.errAt.startsWith(prefix) ? ds.err : '');
function clearErr() { ds.err = ''; ds.errAt = ''; }
/** 外壳自己判出来的错（输入不合法、没发请求）也摆在同一个位置。 */
export function setErr(tag, msg) { ds.err = msg || ''; ds.errAt = msg ? tag : ''; }

export async function setDimConfig(patch, tag = 'config') {
  const my = ++cfgSeq;
  ds.busy = tag; clearErr();
  try {
    const r = await api.post(H + '/config', patch);
    // POST 回的配置不带 accessLocked（只在 GET 里），沿用读到的
    if (my === cfgSeq) ds.config = { ...r, accessLocked: ds.config?.accessLocked ?? r?.accessLocked };
    ds.rev++;
    return true;
  } catch (e) { fail(tag, e); return false; }
  finally { if (ds.busy === tag) ds.busy = ''; }
}

// —— 模型：厂商 / 型号 / 思考深度 / fast ——
// 显示名与 dimensio 的厂商面板一致（目录里的 name 是公司名：Anthropic、Zhipu GLM……）
const VENDOR_NAME = { anthropic: 'Claude', openai: 'DeepSeek', gemini: 'Gemini', qwen: 'Qwen', zhipu: 'GLM', kimi: 'Kimi', mimo: 'MiMo' };
export function vendorName(p) {
  if (!p) return '';
  if (p.id === 'local') return tc('dimensio', '本机');
  return VENDOR_NAME[p.id] || tr(p.name) || p.id;
}
export const catalog = () => (Array.isArray(ds.info?.catalog) ? ds.info.catalog : []);
export const providerSpec = (id) => catalog().find((p) => p.id === id) || null;
export const curSpec = () => providerSpec(ds.config?.provider);
export const curModel = () => curSpec()?.models?.find((m) => m.id === ds.config?.model) || null;
export const hasKeyFor = (id) => !!ds.info?.providers?.[id];

/** 默认服务的下拉：内置几家 + 自定义服务（缺 key 的照列，标一句）。 */
export function providerOptions() {
  return catalog().map((p) => {
    const custom = !!p.custom;
    const need = !custom && p.id !== 'local' && !hasKeyFor(p.id);
    return { value: p.id, label: vendorName(p), desc: need ? t('缺 Key') : custom ? (p.custom.managed ? t('管理员提供') : t('自定义服务')) : '' };
  });
}
export function modelOptions() {
  return (curSpec()?.models || []).map((m) => ({ value: m.id, label: tr(m.label || m.id), desc: m.note ? tr(m.note) : '' }));
}
// 目录里开关式档位写「关闭 / 开启」——那是开关的值，不能走 tr() 的普通键（关闭 = Close），同 dimensio 型号菜单
function effortText(label) {
  if (label === '开启') return tc('开关', '开启');   // i18n-ignore（左边比对服务端数据）
  if (label === '关闭') return tc('开关', '关闭');   // i18n-ignore（左边比对服务端数据）
  return tr(label);
}
export function effortOptions() {
  const m = curModel();
  const labels = m?.effortLabels || {};
  return (m?.efforts || []).map((lv) => ({ value: lv, label: labels[lv] !== undefined ? effortText(labels[lv]) : lv }));
}
export const fastOk = () => curModel()?.fast === true;
export const setProvider = (id) => setDimConfig({ provider: id }, 'provider');
export const setModel = (id) => setDimConfig({ model: id }, 'model');
export const setThinking = (lv) => setDimConfig({ thinking: lv }, 'thinking');
export const setFast = (on) => setDimConfig({ fast: !!on }, 'fast');

// —— 各厂商 API Key ——
/** 「API Key」那一组列哪几家：目录里的内置厂商，本机不用 key、自定义服务的 key 在它自己的编辑器里。 */
export function keyVendors() {
  // 自带厂商已经交给模型中心（harness /api/info 的 hostBuiltins）：Key 在模型中心的服务里，这里不再逐家列
  if (ds.info?.hostBuiltins === true) return [];
  return catalog().filter((p) => !p.custom && p.id !== 'local').map((p) => ({ id: p.id, name: vendorName(p), hasKey: hasKeyFor(p.id), current: p.id === ds.config?.provider }));
}
/** 能不能在这里给这家填 key：新 harness 逐家都能填；老的只能填当前那家（POST /api/config 带 apiKey 存给当前厂商）。 */
export const canSetKey = (id) => hasCap('provider-keys') || id === ds.config?.provider;
export async function setVendorKey(id, key) {
  const k = String(key || '').trim();
  const tag = 'key:' + id;
  if (!k) { ds.err = t('Key 不能为空'); ds.errAt = tag; return false; }
  ds.busy = tag; clearErr();
  try {
    if (hasCap('provider-keys')) {
      const r = await api.post(H + '/provider-keys', { provider: id, apiKey: k });
      if (r?.providers && ds.info) ds.info = { ...ds.info, providers: r.providers };
    } else {
      const r = await api.post(H + '/config', { apiKey: k });
      if (ds.info) ds.info = { ...ds.info, providers: { ...(ds.info.providers || {}), [id]: !!r?.hasKey } };
    }
    ds.rev++;
    return true;
  } catch (e) { fail(tag, e); return false; }
  finally { if (ds.busy === tag) ds.busy = ''; }
}
/** 自定义服务的摘要：N 个服务（管理员共享的另计）。 */
export function customSummary() {
  const list = catalog().filter((p) => p.custom);
  if (!list.length) return t('接 OpenAI / Anthropic / Gemini 兼容的服务');
  const own = list.filter((p) => !p.custom.managed).length;
  const shared = list.length - own;
  if (!shared) return t('{n} 个服务', { n: own });
  if (!own) return t('{n} 个管理员提供的服务', { n: shared });
  return t('{n} 个服务，另有 {m} 个管理员提供', { n: own, m: shared });
}

// —— 权限与安全 ——
export const MODES = () => [
  { value: 'auto', label: t('自主执行'), desc: t('直接执行。规则可把个别高危调用改成每次问我。') },
  { value: 'read-only', label: t('只读'), desc: t('只放行读取类工具，写文件与执行命令一律拒绝。') },
  { value: 'plan', label: t('先出计划'), desc: t('只读研究 → 提交计划 → 你批准后当场转自主并开工。') },
];
export const ACCESS = () => [
  { value: 'full', label: t('整机可访问'), desc: t('可用绝对路径读写工作空间以外的文件（密钥文件始终封锁）。') },
  { value: 'workspace', label: t('仅工作空间'), desc: t('路径一越界就拦下，防误操作。') },
];
export const accessLocked = () => !!ds.config?.accessLocked;
export const setMode = (v) => setDimConfig({ permissionMode: v }, 'mode');
export const setAccess = (v) => setDimConfig({ access: v }, 'access');
export const rulesOf = (kind) => (Array.isArray(ds.config?.permissionRules?.[kind]) ? ds.config.permissionRules[kind] : []);
// 规则整份写回（allow 界面上不编辑，照原样带回）；写法不对由 harness 的规则自查报回来（400 + 哪条错在哪）
function saveRules(kind, list) {
  const r = ds.config?.permissionRules || {};
  return setDimConfig({ permissionRules: { allow: r.allow || [], ask: r.ask || [], deny: r.deny || [], [kind]: list } }, 'rules:' + kind);
}
/** 加规则：一行一条（粘一段多行也行），去重。 */
export function addRules(kind, text) {
  const add = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!add.length) return Promise.resolve(false);
  return saveRules(kind, [...new Set([...rulesOf(kind), ...add])]);
}
export const removeRule = (kind, rule) => saveRules(kind, rulesOf(kind).filter((x) => x !== rule));

// —— 工作空间 ——
export const setWorkspace = (p) => setDimConfig({ workspace: String(p || '').trim() }, 'workspace');

// —— 偏好注册表（通用渲染）——
export async function loadPrefs() {
  try { ds.prefs = await api.get(H + '/prefs'); } catch { ds.prefs = null; }
}
const en = () => isEn();
export const prefGroups = () => (ds.prefs?.groups || []).filter((g) => (ds.prefs?.items || []).some((p) => p.group === g.id));
export const prefItems = (gid) => (ds.prefs?.items || []).filter((p) => p.group === gid);
export const prefGroupLabel = (g) => (en() && g.en ? g.en : tr(g.label));
export const prefLabel = (p) => (en() && p.en?.label ? p.en.label : tr(p.label));
export const prefDesc = (p) => (!p.desc ? '' : en() && p.en?.desc ? p.en.desc : tr(p.desc));
export const prefOptions = (p) => (p.options || []).map((o) => ({ value: o.value, label: en() && p.en?.options?.[o.value] ? p.en.options[o.value] : tr(o.label) }));
export const prefChanged = (p) => p.value !== p.default;
export function prefValueLabel(p) {
  if (p.type === 'enum') return prefOptions(p).find((o) => o.value === p.value)?.label || String(p.value ?? '');
  if (p.type === 'bool') return p.value ? tc('开关', '开启') : tc('开关', '关闭');
  return String(p.value ?? '');
}
/** 写一项（null = 恢复默认）。乐观先改，失败回滚、报错摆在那一行。 */
export async function setPref(key, v) {
  const item = ds.prefs?.items?.find((p) => p.key === key);
  if (!item) return false;
  const tag = 'pref:' + key;
  const prev = item.value;
  item.value = v === null ? item.default : v;
  ds.busy = tag; clearErr();
  try {
    const r = await api.post(H + '/prefs', { values: { [key]: v } });
    if (r?.items) ds.prefs = r;
    ds.rev++;
    return true;
  } catch (e) { item.value = prev; fail(tag, e); return false; }
  finally { if (ds.busy === tag) ds.busy = ''; }
}
/** 数字项的输入：空 = 恢复默认；不是数 / 超范围给一句人话，不发请求。 */
export function parsePrefNumber(p, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { v: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { err: t('要填一个数字') };
  if (p.min !== undefined && n < p.min) return { err: t('不能小于 {n}', { n: p.min }) };
  if (p.max !== undefined && n > p.max) return { err: t('不能大于 {n}', { n: p.max }) };
  return { v: n };
}

// —— 记忆：一句话现状 ——
// 四类的判定同 dimensio 记忆面板（harness/web/src/components/sheets/memory-viz.ts 的 laneOf）：
// 生效 = status active；待处理 = 提议中 + 声明生效但还没核实
function lane(m) {
  if (m.status === 'rejected' || m.declaredStatus === 'rejected') return 'retired';
  if (m.declaredStatus === 'proposed' || m.status === 'proposed') return 'proposed';
  if (m.status === 'active') return 'active';
  if (m.declaredStatus === 'active') return 'held';
  return 'retired';
}
export async function loadMemoryLine() {
  if (!hasCap('memory-overview')) { ds.mem = null; return; }
  try {
    const ov = await api.get(H + '/memory/overview');
    const items = (ov?.buckets || []).flatMap((b) => b.items || []);
    let active = 0, waiting = 0;
    for (const m of items) { const l = lane(m); if (l === 'active') active++; else if (l === 'proposed' || l === 'held') waiting++; }
    ds.mem = { active, waiting, places: (ov?.buckets || []).length };
  } catch { ds.mem = null; }
}
export const memoryOk = () => hasCap('memory');
export function memLine() {
  const m = ds.mem;
  if (!m) return t('模型跨对话记住的事：看、确认、驳回、清理');
  if (!m.active && !m.waiting) return t('还没有记忆');
  return m.places > 1 ? t('{n} 条生效，分布在 {places} 处', { n: m.active, places: m.places }) : t('{n} 条生效', { n: m.active });
}

// —— 本机模型（管理员、目录里有「本机」这家；租户实例没有）——
export const LOCAL_ENGINES = [{ id: 'qwen', name: 'Qwen 27B' }, { id: 'strata', name: 'Strata 125B' }];
export const localOk = () => me.kind === 'admin' && !isTenant() && catalog().some((p) => p.id === 'local');
export async function loadLocal() {
  if (!localOk()) { ds.local = {}; return; }
  const out = {};
  await Promise.all(LOCAL_ENGINES.map(async (e) => {
    try { out[e.id] = await api.get(H + '/localai/status?engine=' + e.id); } catch { out[e.id] = null; }
  }));
  ds.local = out;
}
const kfmt = (n) => Math.round(Number(n) / 1024) + 'k';
const KV_NAME = { q8_0: 'q8', q8q4: 'K8 · V4', q4_0: 'q4', int8: 'int8', k8v4: 'K8 · V4' };
/** 一行状态 + 启动参数摘要：「运行中 · 128k · q8 · 识图」。 */
export function localLine(id) {
  const st = ds.local[id];
  if (st === undefined) return '';
  if (!st) return t('状态不可用');
  if (!st.installed) return t('这台机器上没有找到启动脚本');
  const head = st.state === 'on' ? t('运行中') : st.state === 'starting' ? t('加载中') : st.missing?.length ? t('模型文件不全') : t('未运行');
  const s = st.settings;
  if (!s) return head;
  const parts = [head, kfmt(s.ctx), KV_NAME[s.kv] || s.kv];
  if (s.vision) parts.push(t('识图'));
  if (s.mtp) parts.push('MTP');
  if (s.stream) parts.push(t('KV 流式'));
  return parts.join(' · ');
}

// —— 诊断包 ——
export async function loadSessions() {
  if (!hasCap('diagnostics')) { ds.sessions = []; return; }
  try {
    const list = await api.get(H + '/sessions?offset=0&limit=8');
    ds.sessions = (Array.isArray(list) ? list : []).map((s) => ({ id: s.id, title: s.title || '', updatedAt: s.updatedAt || '' }));
  } catch { ds.sessions = []; }
}
export const sessionTitle = (s) => s?.title || t('未命名对话');
/** 导出某个对话的诊断包，生成后用文件查看器打开（能分享 / 另存）。 */
export async function exportDiag(id) {
  if (!id) return false;
  const tag = 'diag';
  ds.busy = tag; clearErr(); ds.diagMsg = '';
  try {
    const made = await api.post(H + '/sessions/' + encodeURIComponent(id) + '/diagnostics', {});
    openPreview({ origin: 'harness', id, path: made.path, name: made.name, kind: made.kind });
    ds.diagMsg = t('诊断包已生成：{name}', { name: made.name });
    return true;
  } catch (e) { fail(tag, e, t('导出失败')); return false; }
  finally { if (ds.busy === tag) ds.busy = ''; }
}

// —— 版本（安静的一行）——
export function versionLine() {
  const b = ds.info?.build;
  const sha = b?.codeSha ? String(b.codeSha).slice(0, 7) + (b.dirty ? '*' : '') : '';
  const proto = ds.info?.protocol?.version || 0;
  const parts = ['dimensio'];
  if (sha) parts.push(t('服务端 {sha}', { sha }));
  if (proto) parts.push(t('协议 {n}', { n: proto }));
  return parts.join(' · ');
}

// —— 去 dimensio 里打开它自己的面板 ——
// 「显示全部工作过程」：只存本机（与 dimensio 同源，同一个 localStorage 键 harness.feedDetail），不进服务端偏好。
// 改了发 harness-feed-detail 事件，dimensio 页开着就即时跟上（它的左下角设置嵌在 bridge 里时已改成跳到这里）。
const FEED_KEY = 'harness.feedDetail';
const readFeed = () => { try { return localStorage.getItem(FEED_KEY) === '1'; } catch { return false; } };
export const feed = $state({ detail: readFeed() });
export function setFeedDetail(on) {
  feed.detail = !!on;
  try { if (on) localStorage.setItem(FEED_KEY, '1'); else localStorage.removeItem(FEED_KEY); } catch { /* 写不进去：本次照样生效 */ }
  try { window.dispatchEvent(new CustomEvent('harness-feed-detail', { detail: !!on })); } catch {}
}
export const FEED_DESC = () => t('关着时，连续的工具调用收成一行：在跑说正在做什么，做完说做了哪些，点开再看每一步。打开后每一步都平铺参数、结果和实时输出。只存在这台设备上。');

export function openInDimensio(intent) {
  ds.intent = intent;
  ui.settingsOpen = false;
  goto('harness');
}
