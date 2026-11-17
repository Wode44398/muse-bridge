// 桌面设置：扩展探针、各 agent 的分区与开关、Claude 订阅号池、额度与注册。外壳 SettingsDesktop.svelte 按原来的先后创建（effect 与请求次序不变）；
// D 是外壳的设置上下文（当前分区等）。
import { untrack } from 'svelte';
import { me } from '../../lib/state.svelte.js';
import { ags, loadAgents, setAgentOn, loadPool, loadUsage, loadPolicy, savePolicy, deleteAccount, loadResets } from '../../lib/agentSettings.svelte.js';
import { loadClaudeSettings } from '../../lib/claudeSettings.svelte.js';
import { POLICY_FIELDS, policyVal } from '../../lib/settings/common.js';
import { createExtProbe, createHubPresence, createAgentList, createAcctForm } from '../../lib/settings/common.svelte.js';

export function createDeskAgents(D) {
  // ═══ 扩展（独立分区）═══ admin 探针过了才在侧栏出现；内容＝官方「自定义」同款面板（components/ext/Customize），
  // 直接长在设置里（2026-10-20 起不再盖一层全屏玻璃页）。搜索命中某个类型时经 extensionsNav 直达、{#key} 重挂。
  // 成员探的是自己的技能接口（/api/my-extensions：只有技能，见 ext/Customize 的成员模式）。
  const ext = createExtProbe();   // 探针两套外壳共用（lib/settings/common.svelte.js）
  let extKey = $state(0);   // 搜索直达某个类型时 +1，扩展分区 {#key} 重挂

  // ═══ Agent：每个 agent 一个分区（ag-<id>），数据面与手机共用 lib/agentSettings.svelte.js ═══
  // 各接口都是 admin 门；非管理员全部 404/403 → 对应 ok 位为 false，那一节不出现。
  loadAgents(); loadPool(); loadPolicy();
  // 模型中心分区出不出现看 hub.ok || cp.ok：两边都是开设置页才拉。直达 model-hub（openSettings('model-hub')、搜索、别的入口）
  // 时数据往往还在路上——落定之前别把它当「不认识的分区」退回通用页，落定了确实两边都没有才退（两套外壳共用）
  const hp = createHubPresence();
  // 「扩展 › 功能扩展」拨了开关（或别的设备改了）：App 经总线 agents.changed 刷 me.agents，这里跟着重拉，侧栏即时增减
  let agentsSeen = JSON.stringify(me.agents);
  $effect(() => { const k = JSON.stringify(me.agents); if (k !== agentsSeen) { agentsSeen = k; untrack(loadAgents); } });
  if (me.kind !== 'none') loadClaudeSettings();   // Claude 设置：总线会推，开设置页时再拉一次兜底
  // 管理员：服务器上全部 agent；其他人只有 Claude（对话偏好是本机的）
  // 在「扩展 › 功能扩展」里关掉的 agent 直接不列（维护者 10-21）；开着但这台机器跑不起来的仍列出、变灰，点进去看原因。
  // Claude 是核心、不在功能扩展里，关了也得留着入口才开得回来。
  // 成员拿不到 /api/agents：被授权用 dimensio 就有它的分区，里面只出他自己能改的（模型、key、规则、偏好……）
  // 2026-11-04 Gemini 对话下线：Gemini 分区删掉，原来的位置由 Media Studio（分区 'studio'）接替。服务端的 AGENTS 里有 studio 时
  // 按它的次序排；成员拿不到 /api/agents、或 dev fixture（localStorage bridge-studio-fixture=1）时补在 Claude 后面。
  const list = createAgentList({ devClaude: import.meta.env.DEV });   // 两套外壳共用（lib/settings/common.svelte.js）
  // 头图下面只在不正常时写一句状态，正常开着不写口号（同手机设置页；studioStatus 两套外壳共用）
  let stModal = $state(false);   // Studio 正文的浮层开着（Esc 交给它，外壳不抢）
  // agStatus / AG_AUTH_HINT：两套外壳共用（lib/settings/common.js）
  let agLast = $state(null);   // 关最后一个开着的 agent 前确认
  async function toggleAgent(a, next) {
    if (!a?.runnable || ags.agentBusy) return;
    if (!next && ags.agents.agents.filter((x) => x.enabled).length <= 1) { agLast = a; return; }
    await setAgentOn(a, next);
  }
  // Claude 分区：进来才拉逐号用量（每号一次真探针，服务端 5 分钟缓存）
  $effect(() => { if (D.sec === 'ag-claude' && ags.poolOk) untrack(() => { loadUsage(); loadResets(); }); });
  const routerOn = $derived(!!ags.router?.settings?.enabled);
  const acctById = (id) => ags.accounts.find((x) => x.id === id) || null;
  // 添加 / 编辑账号的表单、删除确认：两套外壳共用（lib/settings/common.svelte.js）
  const form = createAcctForm();
  let acctResets = $state(null);   // 正在看重置卡的那个号（弹窗）
  async function confirmAcctDel() { const a = form.acctDel; form.acctDel = null; if (a) await deleteAccount(a.id); }
  // 额度与注册：数字项就地编辑，失焦 / 回车保存（quota 整体替换，改一项带上其余）
  // POLICY_FIELDS / policyVal 两套外壳共用（lib/settings/common.js）
  function savePolicyField(k, raw) {
    const v = String(raw ?? '').trim();
    if (k === 'timezone') return savePolicy({ timezone: v || 'Asia/Shanghai' });
    if (k === 'maxUserTurns') return savePolicy({ maxUserTurns: Number(v) || 0 });
    return savePolicy({ quota: { ...(ags.policy?.quota || {}), [k]: v === '' ? 0 : Number(v) || 0 } });
  }
  return {
    get extOk() { return ext.ok; }, extMember: ext.member, get extKey() { return extKey; }, set extKey(v) { extKey = v; },
    get mhSettled() { return hp.settled; }, get mhOn() { return hp.on; },
    get agentRows() { return list.agentRows; }, get studioOn() { return list.studioOn; }, get studioIds() { return list.studioIds; },
    get stModal() { return stModal; }, set stModal(v) { stModal = v; },
    get agLast() { return agLast; }, set agLast(v) { agLast = v; }, toggleAgent,
    get routerOn() { return routerOn; }, acctById,
    get acctForm() { return form.acctForm; }, set acctForm(v) { form.acctForm = v; },
    get acctDel() { return form.acctDel; }, set acctDel(v) { form.acctDel = v; },
    get acctResets() { return acctResets; }, set acctResets(v) { acctResets = v; },
    openAddAcct: form.openAddAcct, openEditAcct: form.openEditAcct, saveAcctForm: form.saveAcctForm, confirmAcctDel,
    POLICY_FIELDS, policyVal, savePolicyField,
  };
}
