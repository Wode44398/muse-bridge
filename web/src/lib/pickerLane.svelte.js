// 文件选择器与会话选择器共用的一条道 + 让位规则。
//
// 一条道：两个选择器同一时刻只显示一个，按发起先后轮流。它们层级相同（3400）、各自挂在 body 上，
// 同时开着时谁压在上面看挂载先后、不看发起先后；各自又有一个 focusin 焦点陷阱和一个 Esc 监听——
// 两个陷阱会在 focusin 里同步嵌套着互相把焦点拉来拉去，Esc 关掉的也可能是被压在底下、看不见的那个。
// 两个 iframe 各发一个、或手机中转和主界面各发一个时就会撞上；排成一条后，后来的等前一个结束再弹。
//
// 让位：层级从低到高是 选择器 3400 < 应用内弹窗（DialogHost）3500 < 授权框 3600，各层的焦点陷阱只往上让。
// 上面两层开着时选择器不抢焦点、不认 Esc——它们的键盘监听不一定注册在选择器的前面（看模块求值先后），所以这里自己判。
//
// 焦点：整条道从空到有时记下打开前的焦点，全部结束才还回去；中间轮换时由下一个选择器自己落焦点。
import { activeRequest } from './dialogState.svelte.js';
import { grantOpen } from './grantDialog.svelte.js';

/** 排着的选择器请求，按发起先后：'file:<id>' / 'session:<id>'。 */
export const pickerLane = $state({ order: [] });

/** 选择器之外的弹层（焦点落进去时选择器不拉回来）。另一个选择器也算，防哪天两个又同时挂出来。 */
export const OTHER_LAYERS = '[data-dialog-host], [data-grant-host], [data-picker-host]';

let restoreTo = null;

/** 选择器上面有弹层开着（授权框，或应用内弹窗正有一条在显示）。 */
export function aboveOpen() {
  return grantOpen() || !!activeRequest();
}

export function laneHead() {
  return pickerLane.order[0] || null;
}

export function laneJoin(key) {
  if (!pickerLane.order.length) {
    restoreTo = null;
    try {
      const el = document.activeElement;
      if (el && el !== document.body && !el.closest?.(OTHER_LAYERS)) restoreTo = el;
    } catch {}
  }
  pickerLane.order.push(key);
}

export function laneLeave(key) {
  const i = pickerLane.order.indexOf(key);
  if (i < 0) return;
  pickerLane.order.splice(i, 1);
  if (pickerLane.order.length) return;
  const el = restoreTo;
  restoreTo = null;
  if (!el || typeof el.focus !== 'function' || el.isConnected === false) return;
  try {
    // 只在焦点还留在选择器里（或已掉到 body）时还：结算时上面盖着应用内弹窗 / 授权框，
    // 或调用方已经自己挪了焦点，就别抢
    const now = document.activeElement;
    if (now && now !== document.body && now !== document.documentElement && !now.closest?.('[data-picker-host]')) return;
    el.focus({ preventScroll: true });
  } catch {}
}
