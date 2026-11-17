// 子 agent 调用策略（Claude 页「对话」组里的一行 + 推入页 'cl-dispatch'；dimensio 页那一行 + 'dm-dispatch'），iOS 外壳的部分。
// 入口行的状态、副标题、总开关两套外壳共用（lib/settings/common.svelte.js 的 createDispatchRows）；这里是外壳自己的：
// 离开子页前的确认、子页里浮层的登记、左缘右滑的避让。
import { dispatchLeaveGuard, dispatchHasUnsaved } from '../../claude/dispatch/leaveGuard.js';
import { createDispatchRows } from '../../../lib/settings/common.svelte.js';

// 调用策略的两个推入页：Claude 那份（Claude 页里）与 dimensio 那份（dimensio 页里，'dm-dispatch'）。正文是同一个组件，离开守卫、
// 浮层登记、左缘右滑的避让都共用这一套（同一时刻栈里只会有其中一页）
export const DISPATCH_PAGES = ['cl-dispatch', 'dm-dispatch'];

export function createDispatch(S) {
  // —— 子 agent 调用策略（Claude 页「对话」组里的一行 + 推入页 'cl-dispatch'）——
  // 入口行：标题 + 随状态变的副标题，右边一个总开关，点行其余部分推入子页。能改策略的身份（管理员 / 能跑命令的）才有这一行。
  // 状态模块 lib/dispatchPolicy.svelte.js 与子页正文 components/claude/dispatch/DispatchPolicy.svelte 都懒加载：
  // Claude 页露面才取状态模块（副标题要读生效策略），推入子页才取正文——设置页首屏不带它们
  const rows = createDispatchRows();
  // 总开关即点即存（状态模块乐观更新，失败回滚并抛）：没存上时这一行的副标题换成红字说一声（开关自己会滑回去）
  function toggleDispatch() {
    if (!rows.dpm || !rows.dp?.policy) return;
    return rows.setDispatch(!rows.dp.policy.enabled);
  }
  // 子页正文：它自己的浮层开着时告诉外壳（dpModal：算进弹层总闸，Esc 让给它）；有没保存的改动时，离开子页之前由它问
  // 「保存 / 放弃 / 继续编辑」——正文挂着时把确认函数登记在 dispatch/leaveGuard.js（那个文件不带依赖，静态引它不会把正文的 chunk
  // 带进来），外壳每条离开子页的路（返回钮、安卓返回键、Esc、双栏左列换分区、关设置）都先过 dpLeave；没有改动（或子页没挂）就同步放行。
  // 左缘右滑没法停下来问：有改动时干脆不接这个手势（见 edgeSwipe 的 guard），改走返回钮
  let dpModal = $state(false), dpAsking = false;
  function dpLeave(go) {
    if (!dispatchHasUnsaved()) return go();
    if (dpAsking) return;
    dpAsking = true;
    dispatchLeaveGuard().then((ok) => { dpAsking = false; if (ok) go(); });
  }
  // 拖性价比图的判定线期间不接左缘右滑返回：手柄就贴在屏幕左缘那 40px 里。PlanChart 拖动开始 / 结束时派发 dp-drag（detail = true / false）。
  // 另起一个标志，不借 sliding——那个会给整页加 .previewing、把分组卡变透明。松手时兜底复位（正文中途被卸掉也不会卡在「拖动中」）
  let dpDrag = false;
  $effect(() => {
    const onDrag = (e) => { dpDrag = !!e.detail; };
    const onUp = () => { dpDrag = false; };
    window.addEventListener('dp-drag', onDrag);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => { window.removeEventListener('dp-drag', onDrag); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); };
  });
  // 光靠 dp-drag 不够：组件里的 onpointerdown 走 Svelte 的事件委托，比右滑手势挂在外壳上的原生监听晚触发，按下那一刻标志还没立起来。
  // 手柄声明了 touch-action:none（契约 §4.3），按在这样的元素上就认定是它的手势
  function dpOwnsTouch(e) {
    if (!DISPATCH_PAGES.includes(S.nav.stack[S.nav.stack.length - 1])) return false;
    for (let n = e?.target; n && n.nodeType === 1 && !n.classList.contains('settings'); n = n.parentElement) {
      if (getComputedStyle(n).touchAction === 'none') return true;
    }
    return false;
  }
  return {
    get dpShown() { return rows.dpShown; }, get dp() { return rows.dp; }, dpLoad: rows.dpLoad, get dpSub() { return rows.dpSub; },
    get dpRowErr() { return rows.dpRowErr; }, toggleDispatch,
    get ddp() { return rows.ddp; }, ddpLoad: rows.ddpLoad, get ddpSub() { return rows.ddpSub; }, get ddpRowErr() { return rows.ddpRowErr; },
    toggleDimDispatch: rows.toggleDimDispatch,
    get dpModal() { return dpModal; }, set dpModal(v) { dpModal = v; }, dpLeave,
    get dpDrag() { return dpDrag; }, dpOwnsTouch,
  };
}
