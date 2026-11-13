// 子 agent 调用策略子页的「离开前确认」登记处。
//
// 子页（DispatchPolicy.svelte）挂着时把自己的确认函数登记在这里；外壳在退出子页之前（返回按钮、Esc、
// 安卓返回键、桌面搜索跳走……）先 `await dispatchLeaveGuard()`：
//   true  = 可以走（没有未保存的改动，或用户选了保存 / 放弃）；
//   false = 别走（用户选了继续编辑，或保存失败——报错在子页的保存条里）。
// 本文件不 import 任何东西，外壳可以静态引它而不会把子页的 chunk 带进首屏。
//
// 外壳没接这一步也不会丢改动：子页卸载时发现还有未保存的改动，会用应用内对话框补问一次「保存 / 放弃」。

let guard = null;
let dirtyProbe = null;

/** 子页登记：fn() → Promise<boolean>；isDirty() → boolean。返回撤销函数。 */
export function setDispatchLeaveGuard(fn, isDirty) {
  guard = fn;
  dirtyProbe = isDirty || null;
  return () => { if (guard === fn) { guard = null; dirtyProbe = null; } };
}

/** 外壳在离开子页前调。子页没挂时恒为 true。 */
export function dispatchLeaveGuard() {
  if (!guard) return Promise.resolve(true);
  try { return Promise.resolve(guard()).then((ok) => ok !== false, () => true); } catch { return Promise.resolve(true); }
}

/** 同步查一下现在有没有未保存的改动（外壳想据此先停掉左缘右滑之类的手势时用）。 */
export function dispatchHasUnsaved() {
  try { return !!(dirtyProbe && dirtyProbe()); } catch { return false; }
}
