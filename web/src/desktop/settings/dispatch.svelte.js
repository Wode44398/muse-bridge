// 桌面设置：子 agent 调用策略（「对话」组里的一行 + 就地子页 clSub='dispatch'；dimensio 分区里那一行进的是同一个子页，传 dimensio 那份状态）。
import { untrack } from 'svelte';
import { dispatchLeaveGuard, dispatchHasUnsaved } from '../../components/claude/dispatch/leaveGuard.js';
import { createDispatchRows } from '../../lib/settings/common.svelte.js';

export function createDeskDispatch(D) {
  // —— 子 agent 调用策略（「对话」组里的一行 + 就地子页 clSub='dispatch'）——
  // 入口行：标题 + 随状态变的副标题，右边一个总开关，点行其余部分进子页。能改策略的身份（管理员 / 能跑命令的）才有这一行。
  // 状态模块 lib/dispatchPolicy.svelte.js 与子页正文 components/claude/dispatch/DispatchPolicy.svelte 都懒加载：
  // 进 Claude 分区才取状态模块（副标题要读生效策略），点进子页才取正文——设置页首屏不带它们
  const rows = createDispatchRows();   // 入口行的状态、副标题、总开关两套外壳共用（lib/settings/common.svelte.js）
  const dpSubOn = $derived(D.sec === 'ag-claude' && D.clSub === 'dispatch' && rows.dpShown);
  // dimensio 那份调用策略的就地子页（DimensioSection 里那一行点进来，ag-dimensio#dispatch）：同一份正文，传 dimensio 的状态
  const dmSubOn = $derived(D.sec === 'ag-dimensio' && D.clSub === 'dispatch');
  const subOn = $derived(dpSubOn || dmSubOn);
  $effect(() => { if (D.sec === 'ag-claude' && rows.dpShown) untrack(rows.dpLoad); });
  // 总开关即点即存（状态模块乐观更新，失败回滚并抛）：没存上时这一行的副标题换成红字说一声，开关弹回去
  let dpSwKey = $state(0);   // 没存上时 +1：{#key} 让开关弹回原位
  function toggleDispatch(v) { return rows.setDispatch(v, () => { dpSwKey++; }); }
  // 子页正文：它自己的浮层开着时告诉外壳（dpModal，Esc 让给它）；有没保存的改动时，离开子页之前由它问「保存 / 放弃 / 继续编辑」——
  // 正文挂着时把确认函数登记在 dispatch/leaveGuard.js（那个文件不带依赖，静态引它不会把正文的 chunk 带进来），
  // 外壳每条离开子页的路（返回头、Esc、工具栏 ‹ ›、侧栏换分区、搜索跳走、关设置）都先过 dpLeave。没有改动就同步放行
  let dpModal = $state(false), dpAsking = false;
  $effect(() => { if (!subOn) dpModal = false; });
  function dpLeave(go) {
    if (!subOn || !dispatchHasUnsaved()) return go();
    if (dpAsking) return;
    dpAsking = true;
    dispatchLeaveGuard().then((ok) => { dpAsking = false; if (ok) go(); });
  }
  return {
    get dpShown() { return rows.dpShown; }, get dpSubOn() { return dpSubOn; }, get dmSubOn() { return dmSubOn; }, get subOn() { return subOn; },
    get dp() { return rows.dp; }, get dpSub() { return rows.dpSub; }, get dpRowErr() { return rows.dpRowErr; }, get dpSwKey() { return dpSwKey; }, toggleDispatch,
    get dpModal() { return dpModal; }, set dpModal(v) { dpModal = v; }, dpLeave,
  };
}
