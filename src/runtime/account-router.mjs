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
// 两种策略：
//   · 默认「用满再换」：当前号能用就一直用它，用尽才换（换到余量最大的号）——不打扰手动选择；
//   · returnToPrimary「回到首选号」：每轮都选列表里【最靠前】的可用号——主号额度一恢复就自动切回，
//     备用号只在主号用尽期间顶上。开着它时手动切号会在下一轮被改回。
//
// 「会话中无缝换号」（seamless，默认关；只在 enabled 时生效）：CLI 的模型请求改走本机上游代理
// （claude-upstream.mjs），每个请求现选号、现注 token——换号发生在两次模型请求之间，正在跑的
// 会话不中断、不用重发。此时当前号相关桶到 SOFT_SWITCH_PCT 就算「快满」，提前让位（还有更空的号时）。
//
// config.json：claudeAutoSwitch: { enabled, returnToPrimary, seamless }（只改这一个键，同 claude-account.mjs 做法）。

import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH } from '../config/index.mjs';
import { CLAUDE_MODEL_DEFAULT } from '../config/capabilities.mjs';
import { listAccounts, activeAccountId, setActive } from './claude-account.mjs';
import { accountLimits, accountPlan } from './status.mjs';
import { refreshAccounts, probedInfo } from './account-usage.mjs';

const GENERIC_COOLDOWN = 15 * 60_000;   // 429 却没带重置时刻：先躲 15 分钟
const AUTH_COOLDOWN = 30 * 60_000;      // token 失效 / 被撤销：躲 30 分钟（修好 token 后重新核实即解除）
const STALE_NO_RESET = 5 * 3600_000;    // 满额记录没有重置时刻：5 小时后不再当真
const PROBE_BUDGET = 8_000;             // 切号前核实候选号最多等这么久，超时按已有数据决策
// 无缝模式下「快满」的线：到这儿就趁两次请求之间换走。不等 100% 是因为开了 extra usage 的号
// 用满后不报 429、直接开始烧超额信用；换号的代价（新号首个请求重建提示缓存）早换晚换都一样。
const SOFT_SWITCH_PCT = 98;

let settings = { enabled: false, returnToPrimary: false, seamless: false };
const cooldown = new Map();   // accountId -> { until, type }
const log = [];               // 最近的自动切换记录（内存态，控制台展示用）
let routing = null;           // 进行中的开跑前路由（并发开跑的几轮共用一次决策）

function loadRaw() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
{
  const s = loadRaw().claudeAutoSwitch;
  if (s && typeof s === 'object') settings = { enabled: !!s.enabled, returnToPrimary: !!s.returnToPrimary, seamless: !!s.seamless };
}

export function routerSettings() { return { ...settings }; }

// 无缝换号此刻是否生效（claude-upstream.mjs 据此决定 CLI 走不走本机代理）。
export function seamlessActive() { return settings.enabled && settings.seamless && listAccounts().length >= 2; }

const listeners = new Set();
// 设置变了通知（上游代理据此起停）。
export function onRouterSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setRouterSettings({ enabled, returnToPrimary, seamless } = {}) {
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  if (typeof returnToPrimary === 'boolean') settings.returnToPrimary = returnToPrimary;
  if (typeof seamless === 'boolean') settings.seamless = seamless;
  const raw = loadRaw();
  raw.claudeAutoSwitch = { ...settings };
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { return { error: '保存失败：' + ((e && e.message) || e) }; }
  console.log(`[account-router] ${settings.enabled ? 'on' : 'off'}${settings.enabled && settings.returnToPrimary ? ' (return to primary)' : ''}${settings.enabled && settings.seamless ? ' (seamless)' : ''}`);
  for (const fn of listeners) { try { fn(routerSettings()); } catch {} }
  return { ok: true, settings: routerSettings() };
}

const isFable = (model) => /fable/i.test(String(model || CLAUDE_MODEL_DEFAULT));

// 本轮模型相关的额度桶。
function relevantBucket(k, b, model) {
  const m = String(model || CLAUDE_MODEL_DEFAULT).toLowerCase();
  if (k === 'five_hour' || k === 'seven_day') return true;
  if (k === 'seven_day_opus') return m.includes('opus');
  if (k === 'seven_day_sonnet') return m.includes('sonnet');
  if (k === 'seven_day_overage_included') return m.includes('fable');
  if (k.startsWith('model_')) return !!(b && b.label && m.includes(String(b.label).toLowerCase()));
  return false;   // overage（extra usage 信用）等：不决定号能不能用
}

// 这个号此刻对该模型是否不可用：返回 { until, type } 或 null。只看已知数据，不发请求。
// soft：把「快满」（≥ SOFT_SWITCH_PCT）也算不可用——无缝模式默认这样判，好在用满前就换走。
export function accountBlock(id, model, { soft = seamlessActive() } = {}) {
  const now = Date.now();
  const full = soft ? SOFT_SWITCH_PCT : 100;
  let until = 0, type = '';
  const cd = cooldown.get(id);
  if (cd && cd.until > now) { until = cd.until; type = cd.type; }
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
  if (isFable(model) && planOf(id) === 'pro') return { until: Infinity, type: 'no_fable' };
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
  const best = pickUsable(model, { exclude: cur, priority: settings.returnToPrimary, fallback: !!hard });
  // 只是快满（还没真用满）：理由记成 near:<桶>，文案说「快满了」。
  const reason = hard ? (hard.type || 'limit') : 'near:' + (block.type || 'limit');
  return best ? doSwitch(cur, best, reason, model) : null;
}

async function decide(model) {
  const cur = activeAccountId();
  const block = accountBlock(cur, model);
  if (settings.returnToPrimary) {
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
  if (!seamlessActive()) return null;
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
export async function routeBeforeQuery({ model } = {}) {
  if (!settings.enabled || listAccounts().length < 2) return null;
  while (routing) { try { await routing; } catch {} }
  routing = decide(model).finally(() => { routing = null; });
  try { return await routing; } catch (e) { console.error('[account-router] route failed:', (e && e.message) || e); return null; }
}

// 一轮撞了额度墙 / 认证失败后调用。acct=这一轮启动时注入的号；kind='rate_limit'|'auth'；
// resetsAt=被拒那个桶的恢复时刻（毫秒，可为 0）。给该号记冷却；它仍是激活号就立刻换到可用号。
// 返回切换记录（调用方可据此无缝重发）或 null。功能关着时什么都不做。
export async function noteLimitHit(acct, { kind = 'rate_limit', type = '', resetsAt = 0, model } = {}) {
  if (!settings.enabled || !acct) return null;
  // 自定义 API（custom:<服务>:<模型>）的 401 / 429 是第三方服务的事，跟官方号的额度、登录态无关——不记冷却、不换号
  if (typeof model === 'string' && model.startsWith('custom:')) return null;
  const until = kind === 'auth' ? Date.now() + AUTH_COOLDOWN
    : (resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + GENERIC_COOLDOWN);
  const prev = cooldown.get(acct);
  if (!prev || prev.until < until) cooldown.set(acct, { until, type: kind === 'auth' ? 'auth' : (type || 'limit') });
  if (listAccounts().length < 2) return null;
  while (routing) { try { await routing; } catch {} }
  const cur = activeAccountId();
  if (cur !== acct) {
    // 别的轮已经替我们换过了：现在的激活号可用就直接算「已切到它」，调用方照样可以重发。
    return accountBlock(cur, model, { soft: false }) ? null : { at: Date.now(), from: acct, to: cur, fromLabel: labelOf(acct), toLabel: labelOf(cur), reason: kind, model: model || '', already: true };
  }
  leaveMiss = null;
  routing = (async () => {
    await verify(listAccounts().map((a) => a.id).filter((id) => id !== acct));
    const best = pickUsable(model, { exclude: acct, priority: settings.returnToPrimary, fallback: true });
    return best ? doSwitch(acct, best, kind === 'auth' ? 'auth' : (type || 'limit'), model) : null;
  })().finally(() => { routing = null; });
  try { return await routing; } catch (e) { console.error('[account-router] failover failed:', (e && e.message) || e); return null; }
}

// 手动切到某号 = 管理员明确要用它：清掉路由给它记的冷却（额度桶里的满额记录照旧算）。
export function clearCooldown(id) { cooldown.delete(id); }

// 控制台视图：开关 + 每号当前是否被判不可用（按默认模型）+ 最近切换记录。
export function routerStatus() {
  const blocks = {};
  for (const a of listAccounts()) {
    const b = accountBlock(a.id);
    // 无缝模式下只是「快满」的号也会被让开：标成 near:<桶>，界面写「快满了」而不是「已满」。
    const near = b && !accountBlock(a.id, undefined, { soft: false });
    if (b) blocks[a.id] = { until: Number.isFinite(b.until) ? b.until : 0, type: near ? 'near:' + b.type : b.type };
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
  return '额度已满';
}
