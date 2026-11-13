// 设置 › Claude › 对话 › 子 agent 调用策略 的前端数据面。后端：src/routes/dispatch.mjs（/api/claude/dispatch*）。
//
// dp 是两套设置外壳、子页与性价比图共用的一份状态：
//   policy   策略文件（总开关、生效范围、是否调用非 Claude 模型、多套策略、生效的那套）
//   preview  已保存的这份策略实际会怎么派：四档落点 + 候选点 + 图谱版本（口径 basis：主对话是 Claude 订阅还是自定义 API）
//   points   「显示全图」用的图谱点表 { points: [[vkey, plan, slug, family, effort, score, cost, src], …], vendors }；没导入过图谱 = null
//
// 写法上的三件事：
//   · 总开关 / 范围 / 是否用非 Claude / 切换生效策略是即点即存（setDispatch）：先改界面、失败回滚并抛。几次连点各自在路上时，
//     界面 = 服务端确认过的那份 + 还没确认的改动按顺序叠上去，哪一次失败只撤那一次。
//   · 应答有先后（带请求体的 POST 可能被后发的 GET 超车）：策略按 rev 认新旧，rev 更大的一律收、相同的看谁后发出，
//     更小的只有「在我们上次见到 rev 变大之后才发出」的请求才收（那是服务端的策略文件真被重置了），其余都是晚到的旧应答。
//   · 拖判定线时的实时预览（previewStrategy）不落盘：120ms 里只发最后一次、上一个请求没回来不发下一个，换了口径的旧应答丢掉。
//   · 换口径（setBasis）同样先改界面：新口径的落点没读出来就换回原来的口径并抛，dp.basis 与 dp.preview 的口径不会长期对不上。
// 总线 {type:'claude.dispatch'}（同账号别的设备改了策略 / 管理员换了图谱）→ 重新拉一次。
import { api } from './api.js';
import { busOn } from './bus.js';
import { caps } from './state.svelte.js';
import { splitClaudeModels } from './caps.js';
import { t, tc } from './i18n.js';
import { agentModelName, agentEffortName, isCustomModel, customModelInfo } from './claudeProviders.svelte.js';

export const dp = $state({
  loaded: false,       // 拿到过一次（policy / preview 可用）
  loading: false,
  err: '',             // 最近一次读取失败的那句话（读好了就清掉）
  policy: null,
  preview: null,
  basis: 'official',   // 落点按哪种主对话算：'official' Claude 订阅 | 'custom' 自定义 API
  canEdit: false,      // 管理员或 shell 身份：能改策略
  canImport: false,    // 管理员：能导入 / 拉取 / 清除图谱
  points: null,
  pointsLoading: false,
  chartBusy: '',       // '' | 'import' | 'fetch' | 'clear'
});

/** 图谱文件的体积上限（服务端同值，超了回 413）。 */
export const CHART_MAX_BYTES = 12 * 1024 * 1024;

// —— 四档 ——
// color 是 CSS 变量：子页根（或 PlanChart 自己兜底）给出色值，见下面的 TIER_COLORS。short 是窄屏手柄 / 档名签上的一个字。
export const TIER_META = [
  { key: 'top', title: t('最难'), short: tc('档位简称', '最'), use: t('最难的裁决、最终验证'), color: 'var(--dp-t-top)' },
  { key: 'hard', title: t('难'), short: tc('档位简称', '难'), use: t('设计取舍、难排查的问题'), color: 'var(--dp-t-hard)' },
  { key: 'normal', title: t('常规'), short: tc('档位简称', '常'), use: t('常规实现、一般审查'), color: 'var(--dp-t-normal)' },
  { key: 'light', title: t('机械'), short: tc('档位简称', '机'), use: t('检索、读文件、机械改动、格式整理'), color: 'var(--dp-t-light)' },
];
export const tierMeta = (key) => TIER_META.find((m) => m.key === key) || null;

// 四档的颜色：一个色相（青）四个明度，越难越重——四档本来就有先后，颜色跟着排；厂商点色占了蓝橙绿黄粉紫红，青是剩下最宽的空档。
// 浅色底上最难 = 最深，深色底上最难 = 最亮；相邻两档 ΔE ≥ 12（红绿色弱模拟下 ≥ 11），最淡的一档对卡片底仍有 2.2:1 / 3.2:1。
export const TIER_COLORS = {
  light: { top: '#004458', hard: '#006b7f', normal: '#3192a0', light: '#72b5b9' },
  dark: { top: '#a3eaea', hard: '#58c5d0', normal: '#329cae', light: '#287286' },
};
/** 给子页根用的内联样式：把四档颜色变量落在根上，根以下（落点表的色块、性价比图）都读它。 */
export function tierColorVars(dark) {
  const set = TIER_COLORS[dark ? 'dark' : 'light'];
  return TIER_META.map((m) => `--dp-t-${m.key}:${set[m.key]}`).join(';');
}

// —— 应答的收与不收 ——
const SCOPE_KEYS = ['workflow', 'subagent', 'session'];
const msg = (e) => (e && e.body && (e.body.error || (typeof e.body === 'string' ? e.body : ''))) || (e && e.message) || String(e);
const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

let confirmed = null;    // 服务端确认过的策略文件（普通对象）
const pending = [];      // 发出去还没确认的即点即存改动（按发起顺序）
let seq = 0;             // 一个只增的钟：每个会带回 policy / preview 的请求发起时取号，采纳到更新的 rev 时也走一格
let lastSeq = 0;         // 已采纳的应答里最大的号
let bumpedAt = 0;        // 上一次「采纳到的 rev 变了」时钟走到哪

function applyPatch(policy, patch) {
  if (!policy || !patch) return policy;
  const out = { ...policy, scope: { ...(policy.scope || {}) } };
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  if (patch.scope && typeof patch.scope === 'object') for (const k of SCOPE_KEYS) if (typeof patch.scope[k] === 'boolean') out.scope[k] = patch.scope[k];
  if (typeof patch.allowThirdParty === 'boolean') out.allowThirdParty = patch.allowThirdParty;
  if (typeof patch.activeId === 'string' && (policy.strategies || []).some((s) => s.id === patch.activeId)) out.activeId = patch.activeId;
  return out;
}
/** 界面上的策略 = 确认过的 + 路上的改动。内容没变就不换对象（子页据它判断「服务端的值变了」）。 */
function showPolicy() {
  const next = pending.reduce(applyPatch, confirmed);
  if (!same(dp.policy, next)) dp.policy = next;
}
/**
 * 收一份应答（{ policy?, preview?, canEdit?, canImport? }）。stamp = 这个请求发起时取的号。
 * 策略按文件头说的规则认新旧；预览跟着同一份应答里的策略走（策略被判成旧的，预览也不要），而且只收当前口径的。
 * 返回 { fits, took }：fits = 带回来的预览是当前口径的（不是 → 调用方重新拉）；took = 这份预览收下了
 *（没带预览、口径不对、被判成晚到的旧应答都是 false——图谱操作据此补拉，见 chartOp）。
 */
function adopt(r, stamp) {
  if (!r || typeof r !== 'object') return { fits: true, took: false };
  const newer = stamp > lastSeq;
  let fresh = newer;   // 这份应答是不是「不比手上的旧」
  if (r.policy && typeof r.policy === 'object') {
    const rev = Number(r.policy.rev) || 0, cur = confirmed ? Number(confirmed.rev) || 0 : -1;
    if (rev > cur || (rev < cur && stamp > bumpedAt)) { confirmed = r.policy; bumpedAt = ++seq; fresh = true; }
    else if (rev === cur) { if (newer) confirmed = r.policy; }
    else fresh = false;
  }
  showPolicy();
  if (typeof r.canEdit === 'boolean') dp.canEdit = r.canEdit;
  if (typeof r.canImport === 'boolean') dp.canImport = r.canImport;
  let fits = true, took = false;
  if (r.preview && typeof r.preview === 'object') {
    fits = !r.preview.basis || r.preview.basis === dp.basis;
    took = fits && fresh;
    if (took && !same(dp.preview, r.preview)) dp.preview = r.preview;
  }
  if (newer) lastSeq = stamp;
  return { fits, took };
}

// —— 读 ——
let loadP = null;        // 在路上的那次读取：resolve 成 { ok, err }
let pulled = 0;          // 读成了几次（setBasis 据此知道「我等的这段时间里有没有别的读取把新口径读回来了」）
/** 发一次读取 → { ok, err }：ok = 这份应答收下了；没收下时 err 是读取失败的那句话（等的工夫换了口径而作废的，err 为空）。 */
function pull() {
  const stamp = ++seq, basis = dp.basis;
  dp.loading = true;
  const p = api.get('/api/claude/dispatch?basis=' + encodeURIComponent(basis))
    .then((r) => {
      if (basis !== dp.basis) return { ok: false, err: '' };   // 等应答的工夫换了口径：这份不要了，换口径那次自己会拉
      adopt(r, stamp);
      dp.loaded = true;
      dp.err = '';
      pulled++;
      syncPoints();
      return { ok: true, err: '' };
    })
    .catch((e) => { const err = msg(e); if (loadP === p) dp.err = err; return { ok: false, err }; })
    .finally(() => { if (loadP === p) { loadP = null; dp.loading = false; } });
  loadP = p;
  return p;
}
/** 拉策略与预览 → 读到了没有（true / false）。已经拉过且不 force 就直接回；读不出来不抛，原因在 dp.err。 */
export function loadDispatch({ force = false } = {}) {
  if (!force && !loadP && dp.loaded) return Promise.resolve(true);
  return (!force && loadP ? loadP : pull()).then((r) => r.ok);
}

busOn((ev) => {
  // 没人看过这页就不拉：策略只在设置里用，别让每个会话都多一个请求
  if (ev && ev.type === 'claude.dispatch' && (dp.loaded || loadP)) loadDispatch({ force: true });
});

// —— 写 ——
/**
 * 写接口的统一收尾：采纳应答；带回来的预览不是当前口径的（写接口不认口径）就补拉一次。
 * needPreview = 这次操作的结果只在预览里（图谱操作的应答不带 policy）：预览没收下也补拉，不指望总线那条事件。
 */
function settle(r, stamp, { needPreview = false } = {}) {
  const { fits, took } = adopt(r, stamp);
  if (!fits || (needPreview && !took)) loadDispatch({ force: true });
  else syncPoints();
  return r;
}
async function write(path, body) {
  const stamp = ++seq;
  let r;
  try { r = await api.post(path, body); }
  catch (e) { throw new Error(msg(e)); }
  return settle(r, stamp);
}

/**
 * 即点即存：patch = { enabled?, scope?: { workflow?, subagent?, session? }, allowThirdParty?, activeId? }。
 * 界面先变；失败撤回这一次的改动并抛（Error.message 是给人看的那句话）。
 */
export async function setDispatch(patch) {
  if (!confirmed) await loadDispatch();
  if (!confirmed) throw new Error(dp.err || t('策略还没有读出来'));
  const mine = { ...patch };
  pending.push(mine);
  showPolicy();
  const done = () => { const i = pending.indexOf(mine); if (i >= 0) pending.splice(i, 1); };
  const stamp = ++seq;
  let r;
  try { r = await api.post('/api/claude/dispatch/update', { patch }); }
  catch (e) { done(); showPolicy(); throw new Error(msg(e)); }
  done();
  settle(r, stamp);
}

/** 新建（不带 id）或修改（带 id）一套策略；copyOf = 从哪一套复制。→ 存好的那一套。 */
export async function saveStrategy(strategy, { copyOf } = {}) {
  const r = await write('/api/claude/dispatch/strategy/save', copyOf ? { strategy, copyOf } : { strategy });
  return r.strategy;
}
export async function deleteStrategy(id) {
  await write('/api/claude/dispatch/strategy/delete', { id });
}

// —— 实时预览（不落盘）——
// 一次只有一个请求在路上、发出的间隔不小于 PREVIEW_WAIT，所以应答天然按发出的顺序回来：
// 回来的那份就是「目前拿得到的最新结果」，哪怕后面还排着更新的一次也照样交出去（拖动途中落点才跟得上手）。
const PREVIEW_WAIT = 120;
let pv = null;           // 排着队等发的那一次（只留最后一个）：{ body, resolve, reject }
let pvTimer = 0;
let pvBusy = false;
let pvSent = 0;          // 上一次发出的时刻
let pvGen = 0;           // 换口径时加一：按旧口径问的预览回来也不要了

function pvFlush() {
  pvTimer = 0;
  if (pvBusy || !pv) return;
  const job = pv, gen = pvGen;
  pv = null;
  pvBusy = true;
  pvSent = Date.now();
  api.post('/api/claude/dispatch/preview', job.body)
    .then((r) => job.resolve(gen === pvGen ? (r && r.preview) || null : null))
    // 后面还排着一次的话这次的失败不用报：马上会再问
    .catch((e) => { if (gen === pvGen && !pv) job.reject(new Error(msg(e))); else job.resolve(null); })
    .finally(() => {
      pvBusy = false;
      if (pv && !pvTimer) pvTimer = setTimeout(pvFlush, Math.max(0, PREVIEW_WAIT - (Date.now() - pvSent)));
    });
}
/**
 * 一套还没保存的策略会怎么派 → preview（形状同 dp.preview）。不落盘。
 * 连着调（拖判定线每一帧一次）时并不是每次都发：还没发出去就被后来的调用顶掉的那几次 resolve 成 null，
 * 调用方写 `const p = await previewStrategy(draft); if (p) …` 即可。失败只在「后面没有排着更新的一次」时才抛。
 */
export function previewStrategy(strategy, { allowThirdParty } = {}) {
  if (pv) pv.resolve(null);
  const body = { strategy, basis: dp.basis };
  if (typeof allowThirdParty === 'boolean') body.allowThirdParty = allowThirdParty;
  return new Promise((resolve, reject) => {
    pv = { body, resolve, reject };
    if (!pvTimer && !pvBusy) pvTimer = setTimeout(pvFlush, PREVIEW_WAIT);
  });
}

// 换口径没换成的那一次：{ basis, err, at }。回滚会把 dp.basis 改回去——调用方要是把「口径不对就纠正」写成响应式的
//（子页里「自定义模型全删了就退回订阅口径」那个 effect），这一改会立刻再触发它；断网时就成了一圈接一圈的请求。
// 所以同一个口径刚失败过的这一小会儿里再来要，直接按上次的原因抛，不发请求、不动 dp.basis。人手再点一次远比这慢。
const BASIS_RETRY_MS = 400;
let basisFail = null;
function swapBasis(basis) {
  dp.basis = basis;
  pvGen++;                                   // 按旧口径问的实时预览回来也不要了
  if (pv) { pv.resolve(null); pv = null; }   // 排着队的那次同理
}
/**
 * 换口径（主对话是 Claude 订阅 / 自定义 API）并按新口径重拉。界面先变；新口径的落点没读出来就换回原来的口径并抛
 *（Error.message 是给人看的那句话）——不然分段停在新口径上、落点和图还是旧口径的，再点一次又因为「已经是它了」不重试。
 */
export async function setBasis(basis) {
  if (basis !== 'official' && basis !== 'custom') return;
  if (basis === dp.basis) { await loadDispatch(); return; }
  if (basisFail && basisFail.basis === basis && Date.now() - basisFail.at < BASIS_RETRY_MS) throw new Error(basisFail.err);
  const prev = dp.basis, mark = pulled;
  swapBasis(basis);
  let r = await pull();
  // 这次没读成、但同一个口径还有更晚的一次读取在路上（总线事件、写接口的补拉）：成不成看它
  while (!r.ok && dp.basis === basis && loadP) r = await loadP;
  if (dp.basis !== basis) return;            // 等的工夫又换了口径：后来的那次自己负责
  // 读到了——自己这次，或者这期间别的哪次读取（读取只有口径和发出时一样才算数；中途换出去又换回来的，由后来那次负责）
  if (r.ok || pulled !== mark) { basisFail = null; return; }
  swapBasis(prev);
  basisFail = { basis, err: r.err || t('读不到这个口径的落点'), at: Date.now() };
  loadDispatch({ force: true });             // 等的这段时间里写接口带回来的预览因为口径对不上都没收：按原口径补一次（读不出来也无妨）
  throw new Error(basisFail.err);
}

// —— 图谱 ——
// 全图点表（两千多行）不进 dp 的深层代理：Svelte 只代理普通对象与数组，类实例原样放着——点表整份换、从不就地改，
// 用不着逐格跟踪；过一层代理的话，图上把全图拼一遍要多花近一倍的时间（拖判定线、坐标轴滑动时最明显）。
class PointTable {
  constructor(points, vendors) { this.points = points; this.vendors = vendors; }
}
let pointsFor = null;    // 现有 dp.points 对应哪一份图谱（chartKey）；null = 还没人要过全图
let pointsP = null;
const chartKey = () => { const c = dp.preview && dp.preview.chart; return c ? [c.source, c.generated, c.at, c.points].join('|') : ''; };
/** 图谱换了（导入 / 拉取 / 清除 / 别处改的）而全图的点表是旧的：有人要过就重拉。 */
function syncPoints() {
  if (pointsFor !== null && pointsFor !== chartKey()) loadAllPoints({ force: true });
}
/** 「显示全图」用的点表。同一份图谱只拉一次；没导入过图谱 → null。读不出来不抛（当作没有）。 */
export function loadAllPoints({ force = false } = {}) {
  if (!force && pointsP) return pointsP;
  const key = chartKey();
  if (!force && pointsFor === key) return Promise.resolve(dp.points);
  dp.pointsLoading = true;
  const p = api.get('/api/claude/dispatch/chart/points')
    .then((r) => {
      if (pointsP !== p) return dp.points;   // 被更晚的一次顶掉了
      dp.points = r && Array.isArray(r.points) ? new PointTable(r.points, Array.isArray(r.vendors) ? r.vendors : []) : null;
      pointsFor = key;
      return dp.points;
    })
    .catch(() => { if (pointsP === p) { dp.points = null; pointsFor = null; } return dp.points; })
    .finally(() => { if (pointsP === p) { pointsP = null; dp.pointsLoading = false; } });
  pointsP = p;
  return p;
}

async function chartOp(kind, run) {
  if (dp.chartBusy) throw new Error(t('上一个图谱操作还没结束'));
  dp.chartBusy = kind;
  const stamp = ++seq;
  try {
    const r = await run();
    // 图谱操作可以很久（在线获取最长 30 秒），这期间发起的别的请求先回来的话，这份应答按取号算是「旧的」、预览不会收——
    // 可新图谱只在这份预览里：没收下就当场补拉（needPreview），不能只指望总线的那条事件（总线正在重连时收不到）
    settle(r, stamp, { needPreview: true });
    return (r && r.chart) || null;
  } catch (e) {
    throw new Error(e && e.status === 413 ? t('文件超过 12MB，导入不了') : msg(e));
  } finally { dp.chartBusy = ''; }
}
/** 导入一份「订阅 plan 性价比图」HTML（File）→ 新的图谱信息。只读成文本交给服务端解析，页面里的脚本不会被执行。 */
export function importChartFile(file) {
  if (!file || typeof file.text !== 'function') return Promise.reject(new Error(t('没有选中文件')));
  if (file.size > CHART_MAX_BYTES) return Promise.reject(new Error(t('文件超过 12MB，导入不了')));
  return chartOp('import', async () => api.post('/api/claude/dispatch/chart/import', { html: await file.text(), name: file.name || '' }));
}
/** 从线上拉最新的图谱覆盖现有。 */
export const fetchChartOnline = () => chartOp('fetch', () => api.post('/api/claude/dispatch/chart/fetch', {}));
/** 清掉导入的图谱，回到随版本内置的那份。 */
export const clearChart = () => chartOp('clear', () => api.post('/api/claude/dispatch/chart/clear', {}));

// —— 显示名 ——
/** 生效的那套策略（没有就第一套）。 */
export function activeStrategy(policy = dp.policy) {
  const list = (policy && policy.strategies) || [];
  return list.find((s) => s.id === policy.activeId) || list[0] || null;
}
/** 预览里这个模型的显示名（候选 / 未评分 / 四档落点里找）。 */
function previewLabel(model) {
  const pvw = dp.preview;
  if (!pvw) return '';
  for (const list of [pvw.candidates, pvw.unrated]) {
    const hit = (list || []).find((c) => c && c.model === model && c.label);
    if (hit) return hit.label;
  }
  const tier = (pvw.tiers || []).find((x) => x && x.pick && x.pick.model === model && x.pick.label);
  return tier ? tier.pick.label : '';
}
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
/**
 * 策略里存的模型写法 → 给人看的名字：'opus' → 'Opus 5.5'（别名现在指向的那一版）；custom:<服务>:<型号> → 设置里的显示名。
 */
export function modelName(model) {
  const s = typeof model === 'string' ? model.trim() : '';
  if (!s) return '';
  if (isCustomModel(s)) {
    const hit = customModelInfo(s);
    return (hit && hit.name) || previewLabel(s) || agentModelName(s);
  }
  const alias = s.toLowerCase();
  if (CLAUDE_ALIASES.includes(alias)) {
    const label = previewLabel(s);
    if (label) return label;
    const cur = splitClaudeModels(caps.data).primary.find((m) => m.id.startsWith('claude-' + alias + '-'));
    if (cur && cur.name) return cur.name;
  }
  return agentModelName(s);
}
const OFF_EFFORTS = ['off', 'none', 'disabled'];
/** 推理强度的显示名：'' = 不指定 →「默认」；自定义模型用它自己档位表里的名字。 */
export function effortName(model, effort) {
  const e = typeof effort === 'string' ? effort.trim() : '';
  if (!e) return t('默认');
  if (isCustomModel(model)) {
    const hit = ((customModelInfo(model) || {}).efforts || []).find((x) => x.id === e);
    if (hit && hit.name) return hit.name;
  }
  // Claude 模型：跟输入栏拉条面板同一张档位表（面板里叫 Extra，这里就不写成 Extra high）
  const cap = (caps.data?.claude?.efforts || []).find((x) => x.id === e);
  if (!isCustomModel(model) && cap && cap.name) return cap.name;
  return OFF_EFFORTS.includes(e.toLowerCase()) ? t('不思考') : agentEffortName(e);
}

/** 测试用：回到刚加载模块时的样子。 */
export function _resetDispatchForTests() {
  confirmed = null; pending.length = 0; seq = 0; lastSeq = 0; bumpedAt = 0; loadP = null;
  if (pv) pv.resolve(null);
  pv = null; clearTimeout(pvTimer); pvTimer = 0; pvBusy = false; pvSent = 0; pvGen++;
  pointsFor = null; pointsP = null; basisFail = null; pulled = 0;
  Object.assign(dp, { loaded: false, loading: false, err: '', policy: null, preview: null, basis: 'official', canEdit: false, canImport: false, points: null, pointsLoading: false, chartBusy: '' });
}
