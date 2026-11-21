// Claude 页·侧栏「应用」组：插件用 ctx.ui.app 声明 pin: 'sidebar' 的应用，排在「定时触发」后面。
// 点开的形态照定时任务：侧栏常驻（电脑）铺在正文区、侧栏照旧可点；手机是全屏页。与定时任务互斥（同一块地方只放一个）。
// 手机 App 里的页面型应用不内嵌（App 的 JS 桥对所有帧可见，第三方 iframe 不安全）：交给 openApp 走原生干净页，上下文同样给当前会话。
// 切会话、开新对话就收起：它跟着的是「这一段对话」的上下文，换了对话还挂着会让人以为它在看新会话。

import { untrack } from 'svelte';
import { ui, session } from '../state.svelte.js';
import { IS_CSNAP } from '../csnap.js';
import { pluginUi } from '../pluginUi.svelte.js';
import { openApp, appKey as appKeyOf } from '../pluginApps.svelte.js';
import { inAndroidApp } from '../pluginPanels.svelte.js';
import { dockContext } from '../dock.svelte.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createSideApps(pc) {
  const sideApps = $derived(IS_CSNAP ? [] : pluginUi.apps.filter((a) => a && a.pin === 'sidebar'));
  let sideApp = $state(null);   // 正开着的应用键；null = 没开
  let sideIconBad = $state({});  // 应用键 → 图标图片加载失败（退回内置字形）
  function openSideApp(a) {
    pc.closeDrawer();
    const key = a.key || appKeyOf(a);
    if (inAndroidApp() && (a.kind || 'page') === 'page') { openApp(a, { context: dockContext() }); return; }
    ui.routinesOpen = false;
    sideApp = key;
  }
  function closeSideApp() { sideApp = null; }
  // 定时任务开了（侧栏点 / 别处 ui.routinesOpen = true）就让位；只在 routinesOpen 变真时写，不读 sideApp 本身
  $effect(() => { if (ui.routinesOpen) untrack(() => { if (sideApp) sideApp = null; }); });
  let sideAppSid = session.id;
  $effect(() => { const sid = session.id; if (sid !== sideAppSid) { sideAppSid = sid; untrack(() => { if (sideApp) sideApp = null; }); } });

  return {
    get sideApps() { return sideApps; },
    get sideApp() { return sideApp; }, set sideApp(v) { sideApp = v; },
    get sideIconBad() { return sideIconBad; }, set sideIconBad(v) { sideIconBad = v; },
    openSideApp,
    closeSideApp,
  };
}
