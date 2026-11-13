// 模型中心的前端数据面。模型中心是「模型从哪来」的唯一管理入口：
//   管理员：/api/model-hub 的总览——模型中心自己的服务（文本给 Claude / dimensio、媒体给 Media Studio）、Vertex、
//           老的三套（Claude 专用服务、dimensio 自建服务、Studio 自己的服务）与插件提供的；
//           Claude 订阅号池沿用 agentSettings（ags），dimensio 内置厂商的 Key 沿用 dimensioSettings（ds）。
//   成员：  没有 /api/model-hub（hub.ok 为假），只管他自己的 Claude 服务（claudeProviders 的 cp）与看管理员共享给他的。
// v2 起首页是设置里的一个分区（model-hub，HubHome 渲染），添加 / 详情 / 老编辑器是挂在 App 根上的浮层（hubUi.sheet，
// HubOverlays 渲染）——设置、dimensio 的「模型服务」面板、Studio 的托管服务行都经 openHubSheet / openModelHub 唤起。
// 后端：src/routes/model-hub.mjs。
import { api } from './api.js';
import { me } from './state.svelte.js';
import { cpSummaryText } from './claudeProviders.svelte.js';
import { openSettingsFromChat } from './settingsNav.svelte.js';
import { t, tr } from './i18n.js';

export const hub = $state({
  ok: false,        // 拿到过总览（= 当前身份是管理员、服务端有这个功能）：设置入口与管理员视图看它
  v2: false,        // 服务端是 v2（有识别 / 目录 / 按模型分去向）。ok 而非 v2 = 新前端连着老服务端：只能看、启停，见 hubLegacy()
  loading: false,
  err: '',
  studioErr: '',    // v2 服务端读不出 Studio 的服务列表时给的一句人话（这时 studio 是空数组，不代表真的一个都没有）
  vertex: null,     // { enabled, agents, members, models: [id], location, configured, known: [{id,label}], published }
  services: [],     // 模型中心服务（ServiceView：线路带 hasKey / keyTail / state，不带 Key；models 各带 kind / agents）
  claude: [],       // 只在 Claude 的自定义服务（只读摘要，带 kinds）
  dimensio: null,   // 只在 dimensio 的自定义服务；null = 这台服务器没开 dimensio
  studio: null,     // Studio 自己的服务（StudioView）；null = 没装 studio 扩展。managed 的属于某个模型中心服务，首页不单列
  plugins: [],      // 插件提供的
  builtins: null,   // Studio 的内置媒体服务（Vertex / 本机）：[{ id, name, dialect, enabled, shared, models:[{ id, label, kind, enabled }] }]；null = 没开 Studio / 老服务端
});

/**
 * 当前打开的浮层（HubOverlays 按它渲染；null = 没开）：
 *   { type:'service', id } | { type:'service', add:true }    模型中心服务的详情 / 添加（HubService）
 *   { type:'vertex' }                                         Vertex 上游（HubVertex）
 *   { type:'claude', id } | { type:'claude', presets:true }   Claude 专用服务的编辑器 / 预设选择
 *   { type:'dkey', vendor:{ id, name, hasKey } }              dimensio 内置厂商的 Key
 *   { type:'studio', initial }                                 Studio 的服务管理器（MediaProviderManager）：只剩成员 / 老服务端用
 *   { type:'builtin', id }                                     Studio 的内置媒体服务（本机图像模型，HubBuiltin）
 */
export const hubUi = $state({ sheet: null });

const SHEET_TYPES = new Set(['service', 'vertex', 'claude', 'dkey', 'studio', 'builtin']);
// 成员只有自己的 Claude 服务可管；其余浮层背后的接口都只给服务器管理员，开了也是一屏 403
const MEMBER_SHEETS = new Set(['claude']);

/**
 * 新前端连着老服务端（离线 apk 比服务器新）：总览拿得到，但没有识别 / 目录 / 按模型分去向这些接口。
 * 这时首页只读 + 启停，添加服务与服务详情都不开（开了是一屏 404）。总览还没拉到时不算（不知道是哪一版）。
 */
export const hubLegacy = () => hub.ok && !hub.v2;

/**
 * 首页「改为共用」之后模型给谁——确认框按它措辞，必须和后端 adopt（src/routes/model-hub.mjs）实际做的一致：
 *   'both'    Claude / dimensio 的服务照抄成模型中心服务，文本模型两边都给
 *   'origin'  照抄过去仍只有原来那一边能选：Gemini 接口的服务给不了 Claude；这台服务器没开 dimensio（hub.dimensio 为 null）
 *   'studio'  Studio 的服务原地托管，媒体模型不动
 * from：'claude' | 'dimensio' | 'studio'；proto：原服务的接口协议（只有 dimensio 的服务可能是 gemini）。
 */
export function adoptReach(from, proto = '') {
  if (from === 'studio') return 'studio';
  if (from === 'dimensio') return proto === 'gemini' ? 'origin' : 'both';
  return hub.dimensio ? 'both' : 'origin';
}

/** 打开一个浮层；已开着别的就直接换过去（HubOverlays 按 type + id 换内容）。返回是否打开了。 */
export function openHubSheet(sheet) {
  if (!sheet || typeof sheet !== 'object' || !SHEET_TYPES.has(sheet.type)) return false;
  if (me.kind !== 'admin' && !(me.kind === 'user' && MEMBER_SHEETS.has(sheet.type))) return false;
  // 老服务端没有服务浮层要的接口：如实回 false，调用方各自降级（首页弹一句提示，dimensio 的「模型服务」退回它自己的表单）
  if (sheet.type === 'service' && hubLegacy()) return false;
  // 拷一份：调用方手里的对象（比如总览里的一行）以后被重拉替换时，浮层不跟着变
  hubUi.sheet = { ...sheet };
  return true;
}
export function closeHubSheet() { hubUi.sheet = null; }

/** 身份会在运行时变（切服务器、换号），所以是函数而不是常量。 */
export const canOpenModelHub = () => me.kind === 'admin' || me.kind === 'user';

/**
 * 外部入口（dimensio 的「模型服务」面板、聊天里的「去配置」等）：
 *   'add'        → 直接开添加：管理员开模型中心的添加流程，成员开 Claude 专用服务的预设选择
 *   sheet 对象   → 原样交给 openHubSheet
 *   其余 / null  → 打开设置的「模型中心」分区（分屏格里托宿主页开；独立窗口没有设置页 → 返回 false）
 */
export function openModelHub(start = null) {
  if (!canOpenModelHub()) return false;
  if (start && typeof start === 'object') return openHubSheet(start);
  if (start === 'add') return openHubSheet(me.kind === 'admin' ? { type: 'service', add: true } : { type: 'claude', presets: true });
  return openSettingsFromChat('model-hub');
}

const msg = (e) => (e && e.body && (e.body.error || (typeof e.body === 'string' ? e.body : ''))) || (e && e.message) || String(e);
// 网络层抛出来的原始错误（断网、跨域、超时）没有 status，消息是浏览器的英文——换成人话
function human(e) {
  if (e && !e.status && !e.body && (e.name === 'TypeError' || e.name === 'AbortError')) return t('连不上服务器');
  // 403 而服务端没给原因（反代拦下的、老服务端）：别把「Forbidden」原样亮给用户
  if (e && e.status === 403 && !(e.body && e.body.error)) return t('没有权限');
  // 网关（隧道 / 反代）替服务器答的 5xx 是一整页 HTML，截 200 字亮出来只会是一串标签
  if (e && typeof e.body === 'string' && /^\s*</.test(e.body)) return t('服务器没有正常响应（HTTP {s}）', { s: e.status });
  return msg(e);
}

function adopt(r) {
  hub.vertex = r.vertex || null;
  hub.services = Array.isArray(r.services) ? r.services : [];
  hub.claude = Array.isArray(r.claude) ? r.claude : [];
  hub.dimensio = Array.isArray(r.dimensio) ? r.dimensio : null;
  hub.studio = Array.isArray(r.studio) ? r.studio : null;
  hub.plugins = Array.isArray(r.plugins) ? r.plugins : [];
  hub.builtins = Array.isArray(r.builtins) ? r.builtins : null;
  // v2 的总览带 v: 2；'studio' in r 是给没带 v 的 v2 留的口子（它总会序列化 studio 键，没装扩展也是 null）。
  // 老服务端（v1）两样都没有
  hub.v2 = r.v >= 2 || 'studio' in r;
  hub.studioErr = typeof r.studioErr === 'string' ? r.studioErr : '';
  hub.ok = true;
}

let pending = null;
let queued = null;
/**
 * 拉总览。不是管理员 / 老服务端（404）→ 静默，hub.ok 保持 false，界面不出入口。
 * force：写操作之后用——正在拉的那次可能是写之前发出去的，结果是旧的，所以排一次「它完了再拉」（多个写合并成一次）。
 */
export function loadHub(force = false) {
  if (me.kind !== 'admin') return Promise.resolve();
  if (pending) {
    if (!force) return pending;
    return (queued ||= pending.then(() => { queued = null; return loadHub(); }));
  }
  hub.loading = true;
  pending = api.get('/api/model-hub')
    .then((r) => { adopt(r || {}); hub.err = ''; })
    // 401 / 403 / 404 = 没有这个入口了（换了身份、换了服务器）：上一次留下的报错也一并清掉，别让界面停在一条过期的错误上
    .catch((e) => { if (e && [401, 403, 404].includes(e.status)) { hub.ok = false; hub.err = ''; } else hub.err = human(e); })
    .finally(() => { hub.loading = false; pending = null; });
  return pending;
}

async function call(fn) {
  let r;
  try { r = await fn(); } catch (e) { throw new Error(human(e)); }
  if (r && r.error) throw new Error(r.error);
  return r || {};
}
const path = (p) => '/api/model-hub/' + String(p || '').replace(/^\/+/, '');

/** 写操作：成功后重拉总览；失败抛带人话的 Error。 */
export async function hubPost(p, body) {
  const r = await call(() => api.post(path(p), body || {}));
  await loadHub(true);
  return r;
}
/** 只问不改（识别、测试线路、拉模型列表）。 */
export const hubAsk = (p, body) => call(() => api.post(path(p), body || {}));
/** GET /api/model-hub/<path>（如 'catalog?id=h-…'）。 */
export const hubGet = (p) => call(() => api.get(path(p)));

export const KINDS = ['text', 'image', 'video', 'voice', 'music'];
/** 种类的中文名（用时套 tr()：tr(KIND_NAME[k])；要静态收词的地方直接写字面的 t('文本') 等，五个词都在字典里）。 */
export const KIND_NAME = { text: '文本', image: '图像', video: '视频', voice: '配音', music: '音乐' }; // i18n-ignore 这里是键表，显示时才翻
export const AGENT_NAME = { claude: 'Claude', dimensio: 'dimensio', studio: 'Media Studio' };
export const PROTO_NAME = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };

/**
 * 按种类数已添加的模型 → { text: n, image: n, … }（没有的种类不出键）。
 * 不带 kind 的按文本算：老服务端（v1）的模型都是文本、没有这个字段；v2 已添加的模型 kind 一定在 KINDS 里。
 */
export function kindTally(models) {
  const c = {};
  for (const m of Array.isArray(models) ? models : []) {
    if (!m) continue;
    const k = m.kind ?? 'text';
    if (KINDS.includes(k)) c[k] = (c[k] || 0) + 1;
  }
  return c;
}

/** 设置入口行的一句话摘要。 */
export function hubSummaryText() {
  if (!hub.ok) return cpSummaryText() || '';
  const own = hub.services.length + (hub.vertex && hub.vertex.configured ? 1 : 0);
  const legacy = hub.claude.length + (hub.dimensio ? hub.dimensio.length : 0)
    + (hub.studio ? hub.studio.filter((s) => !s.managed).length : 0);
  const n = own + legacy;
  if (!n) return '';
  return t('{n} 个模型服务', { n });
}

/** 线路现在的状态文字：'' = 正常。 */
export function lineNote(l, now = Date.now()) {
  if (!l.enabled) return t('已停用');
  if (!l.hasKey) return t('缺 Key');
  const st = l.state || {};
  if (st.coolUntil > now) {
    const m = Math.max(1, Math.round((st.coolUntil - now) / 60000));
    // coolWhy 是服务端写的中文短语（Key 无效 / 限额 / 连不上…），属于运行时文案：走 tr()，静态检查不收它
    return t('{why}，约 {m} 分钟后再试', { why: st.coolWhy ? tr(st.coolWhy) : t('冷却中'), m });
  }
  return '';
}
export const coolingCount = (s, now = Date.now()) => (s.lines || []).filter((l) => l.enabled && (l.state?.coolUntil || 0) > now).length;
