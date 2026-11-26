// 设置 › Agent 分组（iOS 外壳）：根页每个 agent 一行、开关与认证；额度与注册；Media Studio 页的外壳部分。
import { untrack } from 'svelte';
import { ui, me } from '../../../lib/state.svelte.js';
import { t, tc } from '../../../lib/i18n.js';
import { ags, loadAgents, setAgentOn, loadPool, loadPolicy, savePolicy, accLabel, smartRouting } from '../../../lib/agentSettings.svelte.js';
import { loadClaudeSettings } from '../../../lib/claudeSettings.svelte.js';
import { agentMark } from '../../../lib/settingsIcons.js';
import { POLICY_FIELDS, policyVal } from '../../../lib/settings/common.js';
import { createAgentList } from '../../../lib/settings/common.svelte.js';

export function createAgents() {
  // —— 按 agent 分页（2026-10-18）：根页「Agent」分组每个 agent 一行，各自一页堆它自己的设置——
  // 开关与认证（/api/agents）、Claude 的订阅号池与智能换号、对话偏好……
  // 号池 / 额度与注册原先只在服务端控制台（本机门），服务端给它们开了 settingsGate 后手机上也能改；
  // 会影响连接的（服务控制、隧道、客户端配对、管理员会话）仍只在控制台。数据面见 lib/agentSettings.svelte.js。
  if (me.kind === 'admin') { loadAgents(); loadPool(); loadPolicy(); }
  // 「扩展 › 功能扩展」拨了开关（或别的设备改了）：App 经总线 agents.changed 刷 me.agents，这里跟着重拉，根列表即时增减
  let agentsSeen = JSON.stringify(me.agents);
  $effect(() => { const k = JSON.stringify(me.agents); if (k !== agentsSeen && me.kind === 'admin') { agentsSeen = k; untrack(loadAgents); } });
  // Claude 设置（按身份存服务端）：总线会推，开设置页时再拉一次兜底（从主页直接进设置时 Claude 页可能没挂）
  if (me.kind !== 'none') loadClaudeSettings();
  // 管理员：服务器上全部 agent；其他人：只有 Claude（行的清单两套外壳共用，lib/settings/common.svelte.js 的 createAgentList）
  const list = createAgentList();
  // agent 的品牌标（真标）：明暗两版的随界面明暗换
  const dark = $derived(ui.theme !== 'light');
  const markSrc = (id) => agentMark(id, dark);
  // 根页行尾的短状态：Claude 有号池时显示当前号；别的只在「关着 / 跑不了 / 没认证」时出声
  const activeAcct = $derived(ags.accounts.find((x) => x.active) || null);
  function agTail(a) {
    if (a.local) return '';
    if (a.id === 'studio') return !a.runnable ? t('不可用') : !a.switch ? tc('开关', '关闭') : '';
    if (!a.runnable) return t('不可用');
    if (!a.switch) return tc('开关', '关闭');
    // 智能分派下各任务各用各的号，没有「当前号」可报
    if (a.id === 'claude' && ags.poolOk && ags.accounts.length > 1 && smartRouting()) return t('智能分派');
    if (a.id === 'claude' && ags.poolOk && activeAcct && ags.accounts.length > 1) return accLabel(activeAcct.label);
    if (!a.authed) return t('未认证');
    return '';
  }
  let agLast = $state(false);   // 关最后一个开着的 agent 前的确认
  async function toggleAgent(a) {
    if (!a?.runnable || ags.agentBusy) return;
    const next = !a.switch;
    if (!next && ags.agents.agents.filter((x) => x.enabled).length <= 1) { agLast = a; return; }
    await setAgentOn(a, next);
  }
  async function confirmAgLast() { const a = agLast; agLast = false; if (a) await setAgentOn(a, false); }
  return {
    get agentRows() { return list.agentRows; }, get studioOn() { return list.studioOn; }, get studioIds() { return list.studioIds; },
    markSrc, agTail, get agLast() { return agLast; }, set agLast(v) { agLast = v; }, toggleAgent, confirmAgLast,
  };
}

export function createPolicy() {
  // 额度与注册（多用户形态）：数字项点开一个警告框改；quota 整体替换，改一项带上其余三项
  let numEdit = $state(null);    // null | { k, label, value, tz?, busy }
  function openNum(f) { ags.err = ''; const v = policyVal(f.k); numEdit = { k: f.k, label: f.label(), value: v ? String(v) : '', busy: false }; }
  function openTz() { ags.err = ''; numEdit = { k: 'timezone', label: t('「每天」按哪个时区换日'), value: ags.policy?.timezone || 'Asia/Shanghai', tz: true, busy: false }; }
  async function saveNum() {
    const e = numEdit;
    if (!e || e.busy) return;
    e.busy = true;
    let patch;
    if (e.tz) patch = { timezone: e.value.trim() || 'Asia/Shanghai' };
    else if (e.k === 'maxUserTurns') patch = { maxUserTurns: Number(e.value) || 0 };
    else patch = { quota: { ...(ags.policy?.quota || {}), [e.k]: e.value.trim() === '' ? 0 : Number(e.value) || 0 } };
    if (await savePolicy(patch)) numEdit = null; else { e.err = ags.err; ags.err = ''; e.busy = false; }
  }
  return { POLICY_FIELDS, policyVal, get numEdit() { return numEdit; }, set numEdit(v) { numEdit = v; }, openNum, openTz, saveNum };
}

export function createStudio(S) {
  // —— 设置 › Media Studio（'studio' 页 + 'st:*' 子页；正文是懒加载的 studio 扩展组件）——
  // 显示条件：管理员看 /api/agents 里有没有 studio（关着也列出来，好在这里打开）；成员看自己的 agent 名单。
  let stModal = $state(false);       // Studio 正文的浮层（服务管理器 / 目录选择）开着
  let stTitles = $state({});         // st:* 子页的标题由正文推入时给（外壳不认识 studio 的键）
  function stPush(pid, title) { stTitles[pid] = title; S.nav.push(pid); }
  // 头图下面那一句状态：studioStatus（lib/settings/common.js）
  return { get stModal() { return stModal; }, set stModal(v) { stModal = v; }, get stTitles() { return stTitles; }, stPush };
}

export function createAgy(S) {
  // 设置 › Antigravity（'ag-agy' 页 + 'agy:*' 子页；正文经懒加载入口挂载）
  let agyModal = $state(false);
  let agyTitles = $state({});
  function agyPush(pid, title) { agyTitles[pid] = title; S.nav.push(pid); }
  return { get agyModal() { return agyModal; }, set agyModal(v) { agyModal = v; }, get agyTitles() { return agyTitles; }, agyPush };
}

export function createCodex(S) {
  // 设置 › Codex（'ag-codex' 页 + 'cx:*' 子页；正文经懒加载入口挂载，子页标题由正文推入时给）
  let cxModal = $state(false);
  let cxTitles = $state({});
  function cxPush(pid, title) { cxTitles[pid] = title; S.nav.push(pid); }
  return { get cxModal() { return cxModal; }, set cxModal(v) { cxModal = v; }, get cxTitles() { return cxTitles; }, cxPush };
}
