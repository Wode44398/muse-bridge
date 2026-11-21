// 「从哪来回哪去」返回记录的接线（逻辑与规则见 screenReturn.js）：lib/pageNav.js 跳之前 setScreenReturn，
// lib/nav.js 的系统返回 takeScreenReturn。屏变化由一个常驻的 $effect.root 喂给记录——第一次记的时候才挂上，
// 之后一直挂着（只读 ui.screen 一个值，喂进去的逻辑在 untrack 里，不读写任何被跟踪的 state）。
// 同一个 effect 也喂「原生返回」（来处是手机 App 里的插件页面）：lib/pluginHostRelay.js 落地后 setNativeReturn，
// nav.js 的系统返回 takeNativeReturn 后调 AndroidStore.resumePluginPage()。
import { untrack } from 'svelte';
import { ui } from './state.svelte.js';
import { createScreenReturn, createNativeReturn } from './screenReturn.js';

const core = createScreenReturn();
// 「原生返回」（来处是手机 App 里压在后面的插件页面）：lib/pluginHostRelay.js 落地后记，nav.js 的系统返回取
const native = createNativeReturn();
let fed = false;
function feed() {
  if (fed) return;
  fed = true;
  $effect.root(() => {
    $effect(() => {
      const s = ui.screen;
      untrack(() => { core.screen(s); native.screen(s); });
    });
  });
  // 主界面整个切到后台（原生把插件页切回前台、人回了桌面）= 回了来处：原生返回的记录作废
  try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') native.hidden(); }); } catch {}
}

// 插件页面还压在后面活着没：新版 apk 才有 hasPluginPage；旧版跳转时已经把插件页关了，问不到就当没有
function pluginPageAlive() {
  const st = typeof window !== 'undefined' ? window.AndroidStore : null;
  return typeof st?.hasPluginPage === 'function' && !!st.hasPluginPage();
}

/** 页面要替人从 from 跳到 to 了（跳之前调）；valid() 在返回那一刻判来处还能不能回（应用被撤、分页被关就不回）。 */
export function setScreenReturn(from, to, opts) {
  feed();
  return core.set(from, to, opts);
}

/** 系统返回：有该回去的页就回它的键（只认一次），否则 null。 */
export function takeScreenReturn() {
  return core.take(ui.screen);
}

/** 插件页面经宿主中转替人跳过来、落地之后调：to = 目标屏；layer = 目标是层时那一层（'preview' / 'settings'）。 */
export function setNativeReturn(to, { layer = null } = {}) {
  feed();
  return native.set(to, { layer, valid: pluginPageAlive, current: ui.screen });
}

/** 系统返回：该切回插件页就回 { layer }（要连带收掉的层，可能为 null），只认一次；否则 null。isOpen(name) 判那一层开着没。 */
export function takeNativeReturn(isOpen) {
  return native.take(ui.screen, isOpen);
}

/** 已经切回插件页（中转 resumePage）/ 另有去处：作废 */
export function clearNativeReturn() {
  native.clear();
}
