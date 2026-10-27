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

export const ags = $state({
  agents: null,          // { edition, features, agents:[{id,label,multiUser,switch,runnable,authed,enabled,note}] }
  agentBusy: '',
  poolOk: false,
  accounts: [],          // [{ id, label, active, hasToken, tokenTail }]
  apiKeyMode: '',        // 'env' | 'desktop' | 'config' | 'config-unused' | ''：服务端是不是在用按量 API Key（见 adoptPool）
  usage: {},             // { [id]: { plan, five_hour, seven_day, fable, error } }
  usageBusy: false,
  router: null,          // { settings:{enabled,returnToPrimary}, blocks:{[id]:{until,type}}, log:[…] }
  routerBusy: false,
  policyOk: false,
  policy: null,          // { register, quota:{…}, maxUserTurns, timezone }
  regOpen: false,
  multiUser: false,
  err: '',               // 最近一次失败的人话（子页脚注里显示，下次成功即清）
});

const fail = (e, fallback) => { ags.err = tr(e?.body?.error || e?.message) || fallback || t('失败'); };
const ok = () => { ags.err = ''; };

// —— Agent 开关 ——
export async function loadAgents() {
  try { ags.agents = await api.get('/api/agents'); ags.multiUser = !!ags.agents?.features?.multiUser; }
  catch { ags.agents = null; }
}
export async function setAgentOn(a, next) {
  if (!a?.runnable || ags.agentBusy) return false;
  ags.agentBusy = a.id;
  try { const r = await api.post('/api/agents', { id: a.id, enabled: next }); ags.agents = { ...ags.agents, agents: r.agents }; ok(); return true; }
  catch (e) { fail(e); return false; }
  finally { ags.agentBusy = ''; }
}
export const agentById = (id) => ags.agents?.agents?.find((a) => a.id === id) || null;

// —— Claude 订阅号池 ——
// apiKeyMode（服务端 claude-account.mjs apiKeyMode()；老服务端不带 = ''）：'env' 环境变量给了 ANTHROPIC_API_KEY，
// CLI 见到它就不用订阅令牌；'desktop' 桌面安装包的本机服务端、安装向导里选了 API Key（同 env，号池令牌不生效，
// 改订阅号要去那台电脑托盘的「本机服务端 › 重新配置…」）；'config' 配置文件里的 API Key 在用（使用中的号没令牌时才注入）；
// 'config-unused' config.json 写了 anthropicApiKey 但号池里有令牌、没在用；'' 没走 API Key。
function adoptPool(r) { ags.accounts = r?.accounts || []; ags.apiKeyMode = r?.apiKeyMode || ''; }
export async function loadPool() {
  try { adoptPool(await api.get('/api/admin/claude-accounts')); ags.poolOk = true; }
  catch { ags.poolOk = false; return; }
  loadRouter();   // 逐号用量（Claude Code 真实请求带回的额度，闲置的号是上次使用时的数据）由 Claude 页打开时再拉
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
  try { ags.usage = (await api.get('/api/admin/claude-accounts/usage' + (force ? '?force=1' : '')))?.usage || {}; } catch {}
  ags.usageBusy = false;
}
export async function loadRouter() { try { ags.router = await api.get('/api/admin/claude-accounts/router'); } catch {} }
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
export async function addAccount(label, token) {
  const r = await poolPost('/api/admin/claude-account/add', { label: label.trim(), token: token.trim() });
  if (r) { await reloadAccounts(); loadUsage(true); }
  return !!r;
}
export async function updateAccount(id, label, token) {
  const r = await poolPost('/api/admin/claude-account/update', { id, label: label.trim(), token: token.trim() });
  if (r) { await reloadAccounts(); if (token.trim()) loadUsage(true); }
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
    'near:five_hour': () => t('5 小时额度快满了'), 'near:seven_day': () => t('本周额度快满了'), 'near:seven_day_opus': () => t('Opus 周额度快满了'), 'near:seven_day_sonnet': () => t('Sonnet 周额度快满了'), 'near:seven_day_overage_included': () => t('Fable 周额度快满了') };
export const whyText = (k) => (BLOCK_WHY[k] || (() => t('额度已满')))();
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
export const usageTone =(b) => (b.status === 'rejected' || b.pct >= 100 ? 'red' : b.pct >= 80 ? 'amber' : 'ok');

// —— 额度与注册 ——
export async function loadPolicy() {
  try { const r = await api.get('/api/admin/policy'); ags.policy = r.policy; ags.regOpen = !!r.registrationOpen; ags.multiUser = !!r.multiUser; ags.policyOk = true; }
  catch { ags.policyOk = false; }
}
// quota 是整体替换（policy.mjs setPolicy），改一项也要带上其余三项
export async function savePolicy(patch) {
  try {
    const r = await api.post('/api/admin/policy', patch);
    if (r?.error) throw new Error(r.error);
    ags.policy = r.policy; ags.regOpen = !!r.registrationOpen; ok();
    return true;
  } catch (e) { fail(e, t('保存失败')); return false; }
}
