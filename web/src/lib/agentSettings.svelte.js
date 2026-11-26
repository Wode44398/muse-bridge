// 手机设置「按 agent 分页」的数据面（2026-10-18）：设置根页的 Agent 分组、各 agent 子页、额度与注册页共用。
//
//   agents   —— /api/agents（admin 门，可远程）：开关 / 能不能跑 / 认证了没。普通用户拿不到 → null。
//   pool     —— Claude 订阅号池：账号列表、逐号用量、智能换号（/api/admin/claude-account* ）。
//   policy   —— 额度与注册（/api/admin/policy，只在多用户形态有意义）。
//
// 后两组原先只在服务端控制台里，走本机管理员门；现在服务端给它们单开了 settingsGate（admin 身份远程可达）——
// 这几样改坏了也断不了手机与电脑的连接。服务控制 / 隧道 / 客户端配对 / 管理员会话仍只在控制台。
// 旧后端回 404 → 对应的 ok 位保持 false，设置页不出现那一节（绝不给一个点了报错的入口）。
import { api } from './api.js';
import { t, tr } from './i18n.js';
import { recall, remember } from './lastKnown.js';

// 记进快照的只有「拉到的数据」，忙闲与报错不记
const SNAP_KEYS = ['agents', 'multiUser', 'poolOk', 'accounts', 'apiKeyMode', 'usage', 'router', 'resetsOk', 'resets', 'policyOk', 'policy', 'regOpen'];
export const ags = $state({
  agents: null,          // { edition, features, agents:[{id,label,multiUser,switch,runnable,authed,enabled,note}] }
  agentBusy: '',
  poolOk: false,
  accounts: [],          // [{ id, label, active, hasToken, tokenTail }]
  apiKeyMode: '',        // 'env' | 'desktop' | 'config' | 'config-unused' | ''：服务端是不是在用按量 API Key（见 adoptPool）
  usage: {},             // { [id]: { plan, five_hour, seven_day, fable, error } }
  usageBusy: false,
  router: null,          // { settings:{enabled,strategy,returnToPrimary,seamless}, blocks:{[id]:{until,type}}, log:[…], dispatch?:{accounts:{[id]:{tasks,subs}}, running:[…]} }
  resetsOk: false,       // 服务端有没有「重置卡」能力（overlay 钩子）；没有就不出现入口
  resets: {},            // { [id]: { login:{email,source}|null, needLogin, error, at, atLimit, grants:[…] } }（见服务端 limit-resets.mjs）
  resetsBusy: false,
  routerBusy: false,
  policyOk: false,
  policy: null,          // { register, quota:{…}, maxUserTurns, timezone }
  regOpen: false,
  multiUser: false,
  err: '',               // 最近一次失败的人话（子页脚注里显示，下次成功即清）
  // 上次拉到的那份（lib/lastKnown）：冷开设置第一帧就是完整的 agent 列表、号池与用量，网络回来再原地换
  ...pickSnap(recall('ags')),
});

function pickSnap(o) {
  if (!o || typeof o !== 'object') return {};
  const r = {};
  for (const k of SNAP_KEYS) if (k in o) r[k] = o[k];
  return r;
}
function keep() { remember('ags', pickSnap(ags)); }
// 401 / 403 / 404 = 这个身份没有这个接口（换了人、老服务端）：那份快照作废；别的失败（断网、超时）留着上次的，别让界面退回空白
const gone = (e) => [401, 403, 404].includes(e?.status);
// 同一个请求在路上就别再发一份：账户卡一打开就预取（warmSettings），紧接着打开设置时各控制器又各拉一次
const inflight = {};
const once = (key, fn) => (inflight[key] ||= fn().finally(() => { delete inflight[key]; }));

const fail = (e, fallback) => { ags.err = tr(e?.body?.error || e?.message) || fallback || t('失败'); };
const ok = () => { ags.err = ''; };

// —— Agent 开关 ——
export function loadAgents() {
  return once('agents', async () => {
    try { ags.agents = await api.get('/api/agents'); ags.multiUser = !!ags.agents?.features?.multiUser; keep(); }
    catch (e) { if (gone(e) || !ags.agents) { ags.agents = null; if (gone(e)) keep(); } }
  });
}
export async function setAgentOn(a, next) {
  if (!a?.runnable || ags.agentBusy) return false;
  ags.agentBusy = a.id;
  try { const r = await api.post('/api/agents', { id: a.id, enabled: next }); ags.agents = { ...ags.agents, agents: r.agents }; ok(); keep(); return true; }
  catch (e) { fail(e); return false; }
  finally { ags.agentBusy = ''; }
}
export const agentById = (id) => ags.agents?.agents?.find((a) => a.id === id) || null;

// —— Claude 订阅号池 ——
// apiKeyMode（服务端 claude-account.mjs apiKeyMode()；老服务端不带 = ''）：'env' 环境变量给了 ANTHROPIC_API_KEY，
// CLI 见到它就不用订阅令牌；'desktop' 桌面安装包的本机服务端、安装向导里选了 API Key（同 env，号池令牌不生效，
// 改订阅号要去那台电脑托盘的「本机服务端 › 重新配置…」）；'config' 配置文件里的 API Key 在用（使用中的号没令牌时才注入）；
// 'config-unused' config.json 写了 anthropicApiKey 但号池里有令牌、没在用；'' 没走 API Key。
function adoptPool(r) { ags.accounts = r?.accounts || []; ags.apiKeyMode = r?.apiKeyMode || ''; keep(); }
export function loadPool() {
  return once('pool', async () => {
    try { adoptPool(await api.get('/api/admin/claude-accounts')); ags.poolOk = true; keep(); }
    catch (e) { if (gone(e) || !ags.accounts.length) { ags.poolOk = false; keep(); } return; }
    loadRouter();   // 逐号用量（Claude Code 真实请求带回的额度，闲置的号是上次使用时的数据）由 Claude 页打开时再拉
  });
}
/** 号池区的提示：服务端在用 API Key 时说清楚号池令牌生不生效；不用 API Key 时回空串。 */
export function apiKeyNote() {
  if (ags.apiKeyMode === 'env') return t('现在用的是 API Key（环境变量 ANTHROPIC_API_KEY），号池里的令牌不会生效。');
  if (ags.apiKeyMode === 'desktop') return t('现在用的是安装向导里填的 API Key，号池里的令牌不会生效；要改用订阅号，在那台电脑的托盘「本机服务端 › 重新配置…」里改选订阅令牌。');
  if (ags.apiKeyMode === 'config') return t('现在用的是配置文件里的 API Key（按量计费）；给使用中的账号填上令牌，就改用订阅号。');
  if (ags.apiKeyMode === 'config-unused') return t('config.json 里的 anthropicApiKey 没在用：号池里有订阅令牌时优先用订阅号。要改用 API Key，把它设成环境变量 ANTHROPIC_API_KEY 后重启服务。');
  return '';
}
export async function loadUsage(force = false) {
  if (ags.usageBusy) return;
  ags.usageBusy = true;
  try { ags.usage = (await api.get('/api/admin/claude-accounts/usage' + (force ? '?force=1' : '')))?.usage || {}; keep(); } catch {}
  ags.usageBusy = false;
}
export async function loadRouter() { try { ags.router = await api.get('/api/admin/claude-accounts/router'); keep(); } catch {} }
// —— 重置卡（Anthropic 偶尔发给订阅号的限额重置；官方在 claude.ai 设置 › 用量 › Resets 里用）——
// 读账号级信息要给这个号做一次「完整登录」（号池里的 setup-token 权限不够）；没登录的号服务端不发请求、回 needLogin。
export async function loadResets({ force = false, id = '' } = {}) {
  if (ags.resetsBusy && !id) return;
  ags.resetsBusy = true;
  try {
    const q = [force ? 'force=1' : '', id ? 'id=' + encodeURIComponent(id) : ''].filter(Boolean).join('&');
    const r = await api.get('/api/admin/claude-accounts/resets' + (q ? '?' + q : ''));
    ags.resetsOk = !!r?.available;
    ags.resets = id ? { ...ags.resets, ...(r?.accounts || {}) } : (r?.accounts || {});
    keep();
  } catch (e) { if (!id && gone(e)) ags.resetsOk = false; }
  ags.resetsBusy = false;
}
// 这几个动作的错误交给调用方就地显示（重置卡面板自己有错误行），不写进 ags.err。
async function resetsPost(path, body) {
  try { const r = await api.post(path, body); return r?.error ? { error: tr(r.error) } : (r || { ok: true }); }
  catch (e) { return { error: tr(e?.body?.error || e?.message) || t('失败') }; }
}
export async function useResetCard(id, grantId) {
  const r = await resetsPost('/api/admin/claude-account/reset/use', { id, grantId });
  if (r.status) ags.resets = { ...ags.resets, [id]: r.status };
  if (r.ok) loadUsage(true);
  return r;
}
export const resetsLoginStart = (id) => resetsPost('/api/admin/claude-account/login/start', { id });
export async function resetsLoginFinish(id, code) {
  const r = await resetsPost('/api/admin/claude-account/login/finish', { id, code: code.trim() });
  if (r.ok) await loadResets({ force: true, id });
  return r;
}
export async function resetsLoginClear(id) {
  const r = await resetsPost('/api/admin/claude-account/login/clear', { id });
  if (r.ok) await loadResets({ id });
  return r;
}
// 还能用的卡（剩余次数 > 0、没暂停、没过期）；张数按剩余次数算。
export const liveGrants = (v) => (v?.grants || []).filter((g) => g.left > 0 && !g.paused && (!g.endsAt || g.endsAt > Date.now()));
export const resetsLeft = (v) => liveGrants(v).reduce((n, g) => n + g.left, 0);
const BUCKET_NAME = { five_hour: () => t('5 小时'), seven_day: () => t('每周'), seven_day_overage_included: () => 'Fable', seven_day_opus: () => 'Opus', seven_day_sonnet: () => 'Sonnet' };
/** 这张卡清哪些限额：['5 小时', '每周', 'Fable']（不认识的桶不列）。 */
export const grantClears = (g) => (g?.clears || []).map((k) => BUCKET_NAME[k]?.()).filter(Boolean);
/** 卡名：按清的范围起（官方给的 label 是英文活动名，另起一行原样显示）。 */
export function grantTitle(g) {
  const c = g?.clears || [];
  const s = c.includes('five_hour'), w = c.includes('seven_day');
  if (s && w) return t('完整重置');
  if (s && c.length === 1) return t('5 小时限额重置');
  if (c.includes('seven_day_overage_included') && !w) return t('Fable 限额重置');
  if (w) return t('每周限额重置');
  return t('限额重置');
}
/** 有效期：「12月10日到期」；24 小时内给钟点。 */
export function grantExpiry(g) {
  if (!g?.endsAt) return '';
  const d = new Date(g.endsAt);
  if (g.endsAt - Date.now() < 24 * 3600000) return t('{time} 到期', { time: hhmm(g.endsAt) });
  return t('{month}月{day}日到期', { month: d.getMonth() + 1, day: d.getDate() });
}

async function poolPost(path, body, fallback) {
  try { const r = await api.post(path, body); if (r?.error) throw new Error(r.error); ok(); return r || { ok: true }; }
  catch (e) { fail(e, fallback); return null; }
}
async function reloadAccounts() { try { adoptPool(await api.get('/api/admin/claude-accounts')); } catch {} }
export async function setRouter(patch) {
  if (ags.routerBusy) return;
  ags.routerBusy = true;
  if (await poolPost('/api/admin/claude-account/router', patch)) await loadRouter();
  ags.routerBusy = false;
}
export async function activateAccount(a) {
  // 乐观翻转：切号接口很快，但弱网下一行勾号等半秒才动看着像没点上
  const prev = ags.accounts.map((x) => ({ ...x }));
  ags.accounts = ags.accounts.map((x) => ({ ...x, active: x.id === a.id }));
  const r = await poolPost('/api/admin/claude-account/active', { id: a.id }, t('切换失败'));
  if (!r) ags.accounts = prev;
  reloadAccounts(); loadRouter();
  return !!r;
}
export async function moveAccount(a, delta) { if (await poolPost('/api/admin/claude-account/move', { id: a.id, delta })) await reloadAccounts(); }
export async function addAccount(label, token, plan = '') {
  const r = await poolPost('/api/admin/claude-account/add', { label: label.trim(), token: token.trim(), plan });
  if (r) { await reloadAccounts(); loadUsage(true); }
  return !!r;
}
export async function updateAccount(id, label, token, plan) {
  const body = { id, label: label.trim(), token: token.trim(), ...(typeof plan === 'string' ? { plan } : {}) };
  const r = await poolPost('/api/admin/claude-account/update', body);
  if (r) { await reloadAccounts(); if (token.trim() || typeof plan === 'string') loadUsage(true); }
  return !!r;
}
export async function deleteAccount(id) {
  const r = await poolPost('/api/admin/claude-account/delete', { id });
  if (r) await reloadAccounts();
  return !!r;
}

// 服务端自动起的账号名（「默认账号」「账号 N」）跟着界面语言显示；管理员自己起的名字原样（同控制台 SaAccounts）
const AUTO_LABEL = /^(?:默认账号|账号 (\d+))$/;   // i18n-ignore 匹配服务端数据
export function accLabel(l) {
  const m = AUTO_LABEL.exec(l || '');
  return !m ? l : m[1] ? t('账号 {n}', { n: m[1] }) : t('默认账号');
}
const BLOCK_WHY = { five_hour: () => t('5 小时额度已满'), seven_day: () => t('本周额度已满'), seven_day_opus: () => t('Opus 周额度已满'), seven_day_sonnet: () => t('Sonnet 周额度已满'), seven_day_overage_included: () => t('Fable 周额度已满'), auth: () => t('token 失效'), primary_back: () => t('首选号额度已恢复'),
    // 会话中无缝换号：还没真用满、提前让位（account-router 的 near:<桶>）
    'near:five_hour': () => t('5 小时额度快满了'), 'near:seven_day': () => t('本周额度快满了'), 'near:seven_day_opus': () => t('Opus 周额度快满了'), 'near:seven_day_sonnet': () => t('Sonnet 周额度快满了'), 'near:seven_day_overage_included': () => t('Fable 周额度快满了'),
    // 智能分派的落位理由（account-router/placement.mjs reasonFor）
    fit_only: () => t('只有这个号剩的额度装得下这段任务'), refit: () => t('原来的号剩的额度不够跑完这一段，开跑前先换'), room: () => t('这个号剩的额度最多'),
    fable_room: () => t('这个号的 Fable 额度剩得最多'), keep_fable: () => t('放在这个号上不占 Fable 额度，留给 Fable 任务'), keep_opus: () => t('放在这个号上不占 Opus 额度'),
    keep_sonnet: () => t('放在这个号上不占 Sonnet 额度'), expiring: () => t('这个号的额度快重置了，先用掉'), spread: () => t('和在跑的任务分开，各用各的号'),
    with_parent: () => t('跟主任务在同一个号上'), fallback: () => t('各号都快满了，挑了最空的'), only: () => t('只有这个号能用'), limit: () => t('额度已满') };
export const whyText = (k) => (BLOCK_WHY[k] || (() => t('额度已满')))();

// —— 号池智能路由的分派方式（account-router.mjs 的 strategy）——
export const routeStrategies = () => [
  { value: 'smart', label: t('智能分派'), desc: t('每个任务各用一个号：按预计用量、剩余额度、Fable 余量和重置时间挑，并行的任务分到不同的号，一段活不拆到两个号上跑') },
  { value: 'fill', label: t('用满再换'), desc: t('所有对话共用当前号，用满才一起换到余量最多的号') },
  { value: 'primary', label: t('回到首选号'), desc: t('所有对话共用列表里最靠前的可用号：主号一恢复就切回，备用号只在主号用满时顶上') },
];
export const routerStrategy = () => ags.router?.settings?.strategy || (ags.router?.settings?.returnToPrimary ? 'primary' : 'fill');
/** 智能分派在生效：号池行不再标「使用中」，改标这个号上在跑几个任务。 */
export const smartRouting = () => !!ags.router?.settings?.enabled && routerStrategy() === 'smart';
export const runningOn = (id) => ags.router?.dispatch?.accounts?.[id]?.tasks || 0;
const FAMILY_NAME = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
/** 分派记录一行的标题：哪个对话（子 agent 另说一句）；老策略的切换记录回空串，照旧显示「A → B」。 */
export function routeLogTitle(l) {
  if (!l?.kind) return '';
  const name = l.label || t('对话 {id}', { id: String(l.sid || '').slice(0, 8) });
  return l.agent ? t('{name}的子 agent', { name }) : name;
}
/** 分派记录一行的说明：模型 · 去了哪个号（换号的带上原号）· 理由。labelOf(id, 兜底名) 由调用方给（各皮肤认号名的办法不同）。 */
export function routeLogSub(l, labelOf) {
  const fam = FAMILY_NAME[l.family] || '';
  const to = labelOf(l.to, l.toLabel);
  const where = l.from ? `${labelOf(l.from, l.fromLabel)} → ${to}` : `→ ${to}`;
  return [fam, where, whyText(l.reason)].filter(Boolean).join(' · ');
}
export const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
export function poolResetIn(ms) {
  const d = (ms || 0) - Date.now();
  if (d <= 0) return '';
  const m = Math.round(d / 60000);
  if (m < 60) return t('{n} 分钟后重置', { n: Math.max(1, m) });
  if (m < 48 * 60) return t('{n} 小时后重置', { n: Math.round(m / 60) });
  return t('{n} 天后重置', { n: Math.round(m / 1440) });
}
// 号池小表盘的重置时刻：24h 内给钟点、更远给星期+钟点（对齐官方「Resets Wed 2:00 AM」），窄列放得下
const WEEKDAY = () => [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')];
export function poolResetAt(ms) {
  const d = (ms || 0) - Date.now();
  if (d <= 0) return '';
  if (d < 60 * 60000) return t('{n} 分钟后重置', { n: Math.max(1, Math.round(d / 60000)) });
  if (d < 24 * 3600000) return t('{time} 重置', { time: hhmm(ms) });
  return t('{day} {time} 重置', { day: WEEKDAY()[new Date(ms).getDay()], time: hhmm(ms) });
}
// 号池套餐小标：ultra（2026-11 新出，原 Max 20x）/ max / pro；不认识的不标。
// 套餐徽标：Ultra = 原 Max 20x（不管有没有 5 小时限额）；'max' = 只知道是 Max、分不出 5x / 20x。
export const planPill = (p) => ({ ultra: 'Ultra', max5x: 'Max 5x', max: 'Max', pro: 'Pro' })[p] || '';
// 号池编辑表单的「套餐」选项：'' = 自动识别（setup-token 读不到档位，自动识别常常定不了档，就手动标一下）。
export const PLAN_CHOICES = () => [{ value: '', label: t('自动') }, { value: 'pro', label: 'Pro' }, { value: 'max5x', label: 'Max 5x' }, { value: 'ultra', label: 'Ultra' }];
export const usageTone =(b) => (b.status === 'rejected' || b.pct >= 100 ? 'red' : b.pct >= 80 ? 'amber' : 'ok');

// —— 额度与注册 ——
export function loadPolicy() {
  return once('policy', async () => {
    try { const r = await api.get('/api/admin/policy'); ags.policy = r.policy; ags.regOpen = !!r.registrationOpen; ags.multiUser = !!r.multiUser; ags.policyOk = true; keep(); }
    catch (e) { if (gone(e) || !ags.policy) { ags.policyOk = false; keep(); } }
  });
}
// quota 是整体替换（policy.mjs setPolicy），改一项也要带上其余三项
export async function savePolicy(patch) {
  try {
    const r = await api.post('/api/admin/policy', patch);
    if (r?.error) throw new Error(r.error);
    ags.policy = r.policy; ags.regOpen = !!r.registrationOpen; ok(); keep();
    return true;
  } catch (e) { fail(e, t('保存失败')); return false; }
}
