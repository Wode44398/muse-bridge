// Claude 号池智能路由（可选功能，默认关；控制台「Claude 订阅账号」页开关）。
//
// 号池机制本身见 claude-account.mjs：全 bridge 共用一个「激活账号」，每次 query 现注它的 token。
// 本模块只负责【自动换激活账号】，两个时机：
//   ① 开跑前（routeBeforeQuery）：激活号已知用尽（某个相关额度桶 rejected / 100% 且没过重置点，
//      或刚撞过限流的冷却期）→ 核实候选号的余量（见下面「核实余量」），换到最合适的那个；
//   ② 撞墙时（noteLimitHit）：一轮被 429 / 额度拒绝（或 token 失效）→ 给该号记冷却到重置点，
//      立刻换号；调用方据此决定要不要无缝重发这一轮（claude.mjs / routines-runner.mjs）。
// 「相关额度桶」按本轮模型挑：5 小时、每周恒算；Opus/Sonnet 周桶只对对应模型算；Fable 周限额
// （seven_day_overage_included）只对 Fable 算——Opus 跑满不该连累还有 Fable 余量的判断，反之亦然。
// Pro 号没有 Fable 额度（接口回 credits_required），Fable 轮不往 Pro 号上切。
// 「核实余量」= account-usage.refreshAccounts：配了可选的 overlay 用量来源时交给它；默认不另发请求，按已知数据
// （真实请求的响应头、SDK 的额度事件，见 account-usage.mjs 文件头）直接决策——上面两个时机照常工作。
//
// 三种策略（strategy）：
//   · 'fill'「用满再换」：当前号能用就一直用它，用尽才换（换到余量最大的号）——不打扰手动选择；
//   · 'primary'「回到首选号」：每轮都选列表里【最靠前】的可用号——主号额度一恢复就自动切回，
//     备用号只在主号用尽期间顶上。开着它时手动切号会在下一轮被改回；
//   · 'smart'「智能分派」：不再全 bridge 共用一个激活号，而是每个任务（会话主线程 / 子 agent，按模型家族分）各绑一个号，
//     按预计用量、各号剩余额度、Fable 等稀缺额度、重置时刻、并行负载挑（account-router/ 目录）。并行的任务分到不同的号，
//     一段活开跑前就挑能跑完它的号，不会一个号挤满了再一起换号。它要求 CLI 的模型请求走本机上游代理（同下面的无缝换号），
//     激活号只留给不归它管的旁路请求兜底。
//   老配置只有 returnToPrimary 布尔：true = 'primary'，否则 'fill'；新装默认 'smart'。
//
// 「会话中无缝换号」（seamless，默认关；只在 enabled 时生效）：CLI 的模型请求改走本机上游代理
// （claude-upstream.mjs），每个请求现选号、现注 token——换号发生在两次模型请求之间，正在跑的
// 会话不中断、不用重发。此时当前号相关桶到 SOFT_SWITCH_PCT 就算「快满」，提前让位（还有更空的号时）。
//
// config.json：claudeAutoSwitch: { enabled, strategy, returnToPrimary, seamless }（只改这一个键，同 claude-account.mjs 做法；
// returnToPrimary 跟着 strategy 写，给还认它的老前端）。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from '../config/index.mjs';
import { CLAUDE_MODEL_DEFAULT } from '../config/capabilities.mjs';
import { listAccounts, activeAccountId, setActive } from './claude-account.mjs';
import { accountLimits, accountPlan } from './status.mjs';
import { refreshAccounts, probedInfo } from './account-usage.mjs';
import { DATA_ROOT } from './paths.mjs';
import { relevantBucket, familyOf, DEDICATED, isShared } from './account-router/buckets.mjs';
import { createDispatch } from './account-router/dispatch.mjs';
import { createStore } from './account-router/store.mjs';

const GENERIC_COOLDOWN = 15 * 60_000;   // 429 却没带重置时刻：先躲 15 分钟
const AUTH_COOLDOWN = 30 * 60_000;      // token 失效 / 被撤销：躲 30 分钟（修好 token 后重新核实即解除）
const STALE_NO_RESET = 5 * 3600_000;    // 满额记录没有重置时刻：5 小时后不再当真
const PROBE_BUDGET = 8_000;             // 切号前核实候选号最多等这么久，超时按已有数据决策
// 无缝模式下「快满」的线：到这儿就趁两次请求之间换走。不等 100% 是因为开了 extra usage 的号
// 用满后不报 429、直接开始烧超额信用；换号的代价（新号首个请求重建提示缓存）早换晚换都一样。
const SOFT_SWITCH_PCT = 98;

const STRATEGIES = ['smart', 'fill', 'primary'];
let settings = { enabled: false, strategy: 'smart', returnToPrimary: false, seamless: false };
// accountId -> { [范围]: { until, type } }。范围 '*' = 整个号（5 小时 / 每周被拒、token 失效、分不清的）；家族名 = 只挡那个家族
//（撞的是它独占的额度，如 Fable 周限额）——11-23 一次 Fable 429 把一个号整个挡了一周，Opus 任务也全绕开它。
const cooldown = new Map();
const log = [];               // 最近的自动切换记录（内存态，控制台展示用）
let routing = null;           // 进行中的开跑前路由（并发开跑的几轮共用一次决策）

function loadRaw() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
{
  const s = loadRaw().claudeAutoSwitch;
  if (s && typeof s === 'object') {
    const strategy = STRATEGIES.includes(s.strategy) ? s.strategy : (s.returnToPrimary ? 'primary' : 'fill');
    settings = { enabled: !!s.enabled, strategy, returnToPrimary: strategy === 'primary', seamless: !!s.seamless };
  }
}

export function routerSettings() { return { ...settings }; }

// 无缝换号此刻是否生效：一段活跑到一半、当前号快满 / 撞墙时，允不允许在两次请求之间换号。
export function seamlessActive() { return settings.enabled && settings.seamless && listAccounts().length >= 2; }
// 智能分派此刻是否生效。
export function smartActive() { return settings.enabled && settings.strategy === 'smart' && listAccounts().length >= 2; }
// CLI 的模型请求要不要走本机上游代理、由代理逐请求选号（claude-upstream.mjs 据此起代理、改 CLI 的 env）。
export function proxyRouting() { return seamlessActive() || smartActive(); }

const listeners = new Set();
// 设置变了通知（上游代理据此起停）。
export function onRouterSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setRouterSettings({ enabled, strategy, returnToPrimary, seamless } = {}) {
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  if (STRATEGIES.includes(strategy)) settings.strategy = strategy;
  // 老前端只会拨 returnToPrimary：开 = 回到首选号；关 = 回到用满再换（本来就不是首选号策略的不动）
  else if (typeof returnToPrimary === 'boolean') settings.strategy = returnToPrimary ? 'primary' : (settings.strategy === 'primary' ? 'fill' : settings.strategy);
  settings.returnToPrimary = settings.strategy === 'primary';
  if (typeof seamless === 'boolean') settings.seamless = seamless;
  const raw = loadRaw();
  raw.claudeAutoSwitch = { ...settings };
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { return { error: '保存失败：' + ((e && e.message) || e) }; }
  const on = settings.enabled;
  console.log(`[account-router] ${on ? 'on' : 'off'}${on && settings.strategy === 'primary' ? ' (return to primary)' : ''}${on && settings.strategy === 'smart' ? ' (smart)' : ''}${on && settings.seamless ? ' (seamless)' : ''}`);
  for (const fn of listeners) { try { fn(routerSettings()); } catch {} }
  return { ok: true, settings: routerSettings() };
}

const isFable = (model) => /fable/i.test(String(model || CLAUDE_MODEL_DEFAULT));

// 这个号此刻对该模型是否不可用：返回 { until, type } 或 null。只看已知数据，不发请求。
// soft：把「快满」（≥ SOFT_SWITCH_PCT）也算不可用——无缝模式默认这样判，好在用满前就换走。
export function accountBlock(id, model, { soft = seamlessActive() } = {}) {
  const now = Date.now();
  const full = soft ? SOFT_SWITCH_PCT : 100;
  let until = 0, type = '';
  const fam = familyOf(model);
  for (const [scope, cd] of Object.entries(cooldown.get(id) || {})) {
    if (scope !== '*' && scope !== fam) continue;
    if (cd.until > now && cd.until > until) { until = cd.until; type = cd.type; }
  }
  for (const [k, b] of Object.entries(accountLimits(id))) {
    if (!b || !relevantBucket(k, b, model)) continue;
    if (!(b.status === 'rejected' || (typeof b.pct === 'number' && b.pct >= full))) continue;
    const end = b.resetsAt ? b.resetsAt : (b.at || 0) + STALE_NO_RESET;
    if (end > until) { until = end; type = k; }
  }
  const info = probedInfo(id);
  // 只认 401（token 无效 / 被撤销）；403 多半是出口 IP 被网关拒，不是号的问题。没配 overlay 用量来源时 info 恒为 null。
  if (info && info.error && /无效|撤销/.test(info.error) && now - info.at < AUTH_COOLDOWN) {
    if (info.at + AUTH_COOLDOWN > until) { until = info.at + AUTH_COOLDOWN; type = 'auth'; }
  }
  // Pro 本来没有 Fable 额度；参加了体验 Fable 活动的 Pro 会带 Fable 周桶（seven_day_overage_included），那就照常用。
  if (isFable(model) && planOf(id) === 'pro' && !accountLimits(id).seven_day_overage_included) return { until: Infinity, type: 'no_fable' };
  return until > now ? { until, type } : null;
}

function planOf(id) {
  const p = (probedInfo(id) || {}).plan || accountPlan(id);
  return p ? String(p).toLowerCase() : null;
}

// 余量分：相关桶里最高的占用率（越低越好）；完全没数据按 50 算，排在有余量的已知号后面。
function loadScore(id, model) {
  let worst = -1;
  for (const [k, b] of Object.entries(accountLimits(id))) {
    if (!b || !relevantBucket(k, b, model) || typeof b.pct !== 'number') continue;
    if (b.resetsAt && b.resetsAt < Date.now()) continue;   // 已过重置点的旧读数不算
    worst = Math.max(worst, b.pct);
  }
  return worst < 0 ? 50 : worst;
}

const labelOf = (id) => { const a = listAccounts().find((x) => x.id === id); return a ? a.label : id; };

// 在可用号里挑一个（不含 exclude）。priority=true 取列表顺序最靠前的，否则取余量最大的（同分按列表顺序）。
// fallback：候选号全都「快满」时，退一步只排除真用满的——只在当前号已【真】用满时才这样退
//（快满的号总比报错强）；当前号只是快满就别换到另一个快满的号，否则几个号之间来回倒、每倒一次重建一遍缓存。
function pickUsable(model, { exclude, priority, fallback = false } = {}) {
  const all = listAccounts().map((a, i) => ({ id: a.id, i })).filter((a) => a.id !== exclude);
  let usable = all.filter((a) => !accountBlock(a.id, model));
  if (!usable.length && fallback && seamlessActive()) usable = all.filter((a) => !accountBlock(a.id, model, { soft: false }));
  if (!usable.length) return null;
  if (!priority) usable.sort((x, y) => loadScore(x.id, model) - loadScore(y.id, model) || x.i - y.i);
  return usable[0].id;
}

async function verify(ids) {
  if (!ids.length) return;
  await Promise.race([refreshAccounts(ids).catch(() => {}), new Promise((r) => setTimeout(r, PROBE_BUDGET))]);
}

function doSwitch(from, to, reason, model) {
  const r = setActive(to);
  if (r && r.error) return null;
  const entry = { at: Date.now(), from, to, fromLabel: labelOf(from), toLabel: labelOf(to), reason, model: model || '' };
  log.unshift(entry);
  if (log.length > 20) log.length = 20;
  console.log(`[account-router] ${entry.fromLabel} → ${entry.toLabel} (${reason})`);
  return entry;
}

// 当前号（已判不可用）让位：核实其余号的余量再挑。
async function leave(cur, block, model) {
  await verify(listAccounts().map((a) => a.id).filter((id) => id !== cur));
  const hard = accountBlock(cur, model, { soft: false });
  const best = pickUsable(model, { exclude: cur, priority: settings.strategy === 'primary', fallback: !!hard });
  // 只是快满（还没真用满）：理由记成 near:<桶>，文案说「快满了」。
  const reason = hard ? (hard.type || 'limit') : 'near:' + (block.type || 'limit');
  return best ? doSwitch(cur, best, reason, model) : null;
}

async function decide(model) {
  const cur = activeAccountId();
  const block = accountBlock(cur, model);
  if (settings.strategy === 'primary') {
    // 回到首选号：列表里排在当前号前面的号若看着已恢复，先核实再切回去。
    const accts = listAccounts();
    const ahead = accts.slice(0, Math.max(0, accts.findIndex((a) => a.id === cur))).map((a) => a.id).filter((id) => !accountBlock(id, model));
    if (ahead.length || block) await verify(block ? accts.map((a) => a.id).filter((id) => id !== cur) : ahead);
    const best = pickUsable(model, { priority: true, fallback: !!accountBlock(cur, model, { soft: false }) });
    if (best && best !== cur) return doSwitch(cur, best, block ? (block.type || 'limit') : 'primary_back', model);
    return null;
  }
  if (!block) return null;
  // 用满再换：当前号已知用尽 → 换到余量最多的号。
  return leave(cur, block, model);
}

// 无缝模式：上游代理每个模型请求发出前调。当前号对该模型已用满 / 快满就趁这个空当换号；
// 只「走」不「回」——回首选号留给开跑前（routeBeforeQuery），别在一轮中间为了回去多重建一次缓存。
// 没号可换的结论记 60 秒，期间同一个号同一个模型的请求不再反复核实。
let leaveMiss = null;   // { cur, model, at }
export async function leaveIfBlocked(model) {
  if (!seamlessActive() || smartActive()) return null;   // 智能分派按任务各自换号，不动激活号
  while (routing) { try { await routing; } catch {} }
  const cur = activeAccountId();
  const block = accountBlock(cur, model);
  if (!block) return null;
  if (leaveMiss && leaveMiss.cur === cur && leaveMiss.model === model && Date.now() - leaveMiss.at < 60_000) return null;
  routing = leave(cur, block, model).finally(() => { routing = null; });
  try {
    const r = await routing;
    leaveMiss = r ? null : { cur, model, at: Date.now() };
    return r;
  } catch (e) { console.error('[account-router] seamless switch failed:', (e && e.message) || e); return null; }
}

// 开跑前调用（admin 对话 / 用户沙箱 / 定时路由）。返回切换记录或 null（未开启 / 不需要 / 无号可换）。
// 智能分派下这一轮用哪个号由上游代理按任务选；这里只在激活号（旁路请求的兜底）用尽时悄悄把它换到能用的号，不回切换记录
//（回了前端会弹「已换号」，可这一轮实际未必在激活号上跑）。
export async function routeBeforeQuery({ model } = {}) {
  if (!settings.enabled || listAccounts().length < 2) return null;
  while (routing) { try { await routing; } catch {} }
  routing = decide(model).finally(() => { routing = null; });
  try { const r = await routing; return smartActive() ? null : r; } catch (e) { console.error('[account-router] route failed:', (e && e.message) || e); return null; }
}

// 一轮撞了额度墙 / 认证失败后调用。acct=这一轮启动时注入的号；kind='rate_limit'|'auth'；
// resetsAt=被拒那个桶的恢复时刻（毫秒，可为 0）。给该号记冷却；它仍是激活号就立刻换到可用号。
// 返回切换记录（调用方可据此无缝重发）或 null。功能关着时什么都不做。
// sid：撞墙的会话（智能分派用：只把这个会话换走，返回它会被换到哪；不给 sid 时只记冷却）。
export async function noteLimitHit(acct, { kind = 'rate_limit', type = '', resetsAt = 0, model, sid = '' } = {}) {
  if (!settings.enabled || !acct) return null;
  // 自定义 API（custom:<服务>:<模型>）的 401 / 429 是第三方服务的事，跟官方号的额度、登录态无关——不记冷却、不换号
  if (typeof model === 'string' && model.startsWith('custom:')) return null;
  const until = kind === 'auth' ? Date.now() + AUTH_COOLDOWN
    : (resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + GENERIC_COOLDOWN);
  const scope = kind === 'auth' ? '*' : limitScope(acct, type, model);
  const cds = cooldown.get(acct) || {};
  if (!cds[scope] || cds[scope].until < until) cds[scope] = { until, type: kind === 'auth' ? 'auth' : (type || 'limit') };
  cooldown.set(acct, cds);
  if (listAccounts().length < 2) return null;
  if (smartActive()) {
    if (!sid) return null;
    await verify(listAccounts().map((a) => a.id).filter((id) => id !== acct));
    const e = dispatch.sessionLimitHit(sid, acct, model);
    return e ? { at: e.at, from: acct, to: e.to, fromLabel: labelOf(acct), toLabel: e.toLabel, reason: kind === 'auth' ? 'auth' : (type || 'limit'), model: model || '', sid } : null;
  }
  while (routing) { try { await routing; } catch {} }
  const cur = activeAccountId();
  if (cur !== acct) {
    // 别的轮已经替我们换过了：现在的激活号可用就直接算「已切到它」，调用方照样可以重发。
    return accountBlock(cur, model, { soft: false }) ? null : { at: Date.now(), from: acct, to: cur, fromLabel: labelOf(acct), toLabel: labelOf(cur), reason: kind, model: model || '', already: true };
  }
  leaveMiss = null;
  routing = (async () => {
    await verify(listAccounts().map((a) => a.id).filter((id) => id !== acct));
    const best = pickUsable(model, { exclude: acct, priority: settings.strategy === 'primary', fallback: true });
    return best ? doSwitch(acct, best, kind === 'auth' ? 'auth' : (type || 'limit'), model) : null;
  })().finally(() => { routing = null; });
  try { return await routing; } catch (e) { console.error('[account-router] failover failed:', (e && e.message) || e); return null; }
}

// 一次额度拒绝该挡多大范围：'*' 整个号，或某个家族。
// 拒绝点名的是共用桶（5 小时 / 每周）→ 整个号；点名的是家族独占桶（Fable 周限额等）→ 只挡那个家族；
// 没点名（429 不带 representative-claim、credits_required）时：请求的模型有独占桶、而这个号的共用桶看着都没满
//（noteHeaders 已经先把这次 429 的读数记进去了）→ 多半是那个家族自己的额度没了 / 根本没有，只挡它。
export function limitScope(acct, type, model) {
  if (isShared(type)) return '*';
  for (const [f, k] of Object.entries(DEDICATED)) if (type === k) return f;
  const fam = familyOf(model);
  if (!DEDICATED[fam]) return '*';
  const L = accountLimits(acct) || {};
  const full = (b) => b && (b.status === 'rejected' || (typeof b.pct === 'number' && b.pct >= 100)) && !(b.resetsAt && b.resetsAt < Date.now());
  return full(L.five_hour) || full(L.seven_day) ? '*' : fam;
}

// 号池里最早什么时候有号能接着跑这个模型（毫秒；0 = 路由关着 / 号不够两个 / 没有已知的恢复时刻）。
// 撞墙且全员用尽时，自动续跑（limit-resume.mjs）按它排——等的是「最先恢复的那个号」，不是撞墙那个号自己的重置点：
// 11-07 撞墙的号 14:30Z 才重置，另一个号 12:20Z 就恢复了，会话却一直等到 14:31（用户 12:30 手动「继续」立刻跑通）。
// 只按真用满判（soft:false）——到点续跑时 routeBeforeQuery 允许退到「快满」的号。
export function poolAvailableAt(model) {
  if (!settings.enabled || listAccounts().length < 2) return 0;
  let best = Infinity;
  for (const a of listAccounts()) {
    const b = accountBlock(a.id, model, { soft: false });
    const at = b ? b.until : Date.now();
    if (at < best) best = at;
  }
  return Number.isFinite(best) ? best : 0;
}

// 手动切到某号 = 管理员明确要用它：清掉路由给它记的冷却（额度桶里的满额记录照旧算）。
export function clearCooldown(id) { cooldown.delete(id); }

// ---- 智能分派（实现在 account-router/，这里只接线：额度判断用上面的 accountBlock，状态落数据根）----
const dispatchStore = createStore(path.join(DATA_ROOT, 'claude-pool-dispatch.json'));
const dispatch = createDispatch({
  listAccounts, accountLimits, planOf,
  blocked: (id, model, opts) => accountBlock(id, model, opts),
  midSwitch: () => seamlessActive(),
  onChange: () => dispatchStore.schedule(),
});
dispatch.load(dispatchStore.read());
dispatchStore.bind(() => dispatch.dump());
{ const gcTimer = setInterval(() => dispatch.gc(), 10 * 60_000); if (gcTimer.unref) gcTimer.unref(); }

// 换号前核实候选号的余量（overlay 用量来源）：分派要在请求路上同步做决定，这里只在后台把太旧的读数刷一下，下一次决定就用上。
let refreshing = false;
function refreshStale() {
  if (refreshing) return;
  const stale = listAccounts().map((a) => a.id).filter((id) => {
    const at = Math.max(0, ...Object.values(accountLimits(id)).map((b) => (b && b.at) || 0));
    return Date.now() - at > 30 * 60_000;
  });
  if (!stale.length) return;
  refreshing = true;
  verify(stale).finally(() => { refreshing = false; });
}

/** 上游代理：这个模型请求该用哪个号（见 dispatch.pick）。智能分派没开 / 不归它管 → null。 */
export function dispatchPick(req) {
  if (!smartActive()) return null;
  const r = dispatch.pick(req);
  if (r && r.entry) refreshStale();
  return r;
}
export const dispatchBound = (sid) => (smartActive() ? dispatch.boundAccount(sid) : '');
export const dispatchBegin = (task) => { if (task) dispatch.begin(task); };
export const dispatchEnd = (task) => { if (task) dispatch.end(task); };
// 用量与读数在代理开着时一律记（不只智能分派）：计量先学起来，切到智能分派时估计已经有了。
export const dispatchUsage = (task, acct, model, usage) => { if (acct) dispatch.usage(task, acct, model, usage); };
export const dispatchReadings = (acct, buckets) => { if (acct) dispatch.readings(acct, buckets); };
export const dispatchLimitHit = (task) => { if (task) dispatch.limitHit(task); };
/** 会话的显示名（分派记录里认得出是哪个对话）：会话首条消息的开头。 */
export const noteTaskLabel = (sid, label) => dispatch.setLabel(sid, label);

// 控制台视图：开关 + 每号当前是否被判不可用（按默认模型）+ 最近切换记录；智能分派另给每号在跑的任务与分派记录。
export function routerStatus() {
  const blocks = {};
  for (const a of listAccounts()) {
    const b = accountBlock(a.id);
    // 无缝模式下只是「快满」的号也会被让开：标成 near:<桶>，界面写「快满了」而不是「已满」。
    const near = b && !accountBlock(a.id, undefined, { soft: false });
    if (b) blocks[a.id] = { until: Number.isFinite(b.until) ? b.until : 0, type: near ? 'near:' + b.type : b.type };
  }
  if (smartActive()) {
    const d = dispatch.status();
    return { settings: routerSettings(), blocks, log: d.log, dispatch: { accounts: d.accounts, running: d.running } };
  }
  return { settings: routerSettings(), blocks, log: log.slice(0, 10) };
}

// 切换理由 → 人话（错误卡 / 日志用）。
export function reasonText(reason) {
  if (String(reason || '').startsWith('near:')) return reasonText(reason.slice(5)).replace(/已满$/, '快满了');
  if (reason === 'five_hour') return '5 小时额度已满';
  if (reason === 'seven_day') return '本周额度已满';
  if (reason === 'seven_day_opus') return 'Opus 周额度已满';
  if (reason === 'seven_day_sonnet') return 'Sonnet 周额度已满';
  if (reason === 'seven_day_overage_included') return 'Fable 周额度已满';
  if (reason === 'auth') return 'token 失效';
  if (reason === 'primary_back') return '首选号额度已恢复';
  if (reason === 'no_fable') return '该号没有 Fable 额度';
  return SMART_REASON[reason] || '额度已满';
}

// 智能分派的落位理由（placement.reasonFor）。
const SMART_REASON = {
  fit_only: '只有这个号剩的额度装得下这段任务',
  refit: '原来的号剩的额度不够跑完这一段，开跑前先换',
  room: '这个号剩的额度最多',
  fable_room: '这个号的 Fable 额度剩得最多',
  keep_fable: '放在这个号上不占 Fable 额度，留给 Fable 任务',
  keep_opus: '放在这个号上不占 Opus 额度',
  keep_sonnet: '放在这个号上不占 Sonnet 额度',
  expiring: '这个号的额度快重置了，先用掉',
  spread: '和在跑的任务分开，各用各的号',
  with_parent: '跟主任务在同一个号上',
  fallback: '各号都快满了，挑了最空的',
  only: '只有这个号能用',
};
