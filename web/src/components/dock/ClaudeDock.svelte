<script>
  // Claude 分页的工作区：统一外壳（Workbench）+ Claude 自己的三样——
  //   顶带用官方桌面版同款的工具开关组（DockToolBar：工作区收着时它挂在这一格右上角，展开后坐进外壳的带里）；
  //   专属卡「任务」与插件的工作台标签；卡片可以拖出 app 成独立窗口（卡片窗口 = SoloPage 的 card 形态）。
  // 聊天快照页（SnapPage）、独立对话窗（SoloPage）也挂这一份。
  import { ui, session } from '../../lib/state.svelte.js';
  import { claudeHost, claudeTools, dockSnapMode, browserMountedNow } from '../../lib/dock.svelte.js';
  import { toolAllowed } from '../../lib/dock/tools.js';
  import { workbenchByKey } from '../../lib/pluginUi.svelte.js';
  import { bgHoldNow } from '../../lib/chat.svelte.js';
  import { reportUi } from '../../lib/uiReport.js';
  import { cardUrl, DOCK_CHANNEL, IS_SOLO } from '../../lib/solo.js';
  import { t } from '../../lib/i18n.js';
  import Workbench from './Workbench.svelte';
  import DockToolBar from './DockToolBar.svelte';
  import TasksPanel from './TasksPanel.svelte';
  import PluginWorkbench from './PluginWorkbench.svelte';

  // wide = 以侧列形态摆（宿主按 layout.side 传入）；false = 手机底部抽屉
  // overlay = 侧列盖在正文上（分屏的窄格）；multi = 允许几张卡同时开（主窗口单格、够宽才给）
  // toolsClose = 分屏格的「关掉这一格」：工具开关组挂进外壳顶带时 ✕ 跟着过来
  // card = 卡片窗口（工作区的一张卡被拖出 app）：整扇窗只放这一张
  let { wide = false, overlay = false, multi = false, toolsClose = null, card = '' } = $props();
  const dock = claudeHost.state;
  const snap = $derived(dockSnapMode());

  // 本轮挂起等后台任务 → 「任务」亮提示点；浏览器 = 状态灯（这个对话的浏览器里有标签就亮，看着也亮）
  const bgLive = $derived(!!bgHoldNow());
  const tools = $derived(claudeTools()
    .filter((x) => toolAllowed(x, claudeHost, { snap }))
    .map((x) => (x.key === 'browser' ? { ...x, lamp: browserMountedNow() }
      : x.key === 'term' ? { ...x, live: dock.termLive }
      : x.key === 'tasks' ? { ...x, live: bgLive } : x)));

  // 工作区协同：把工作区开没开、开着哪几张报给 agent。卡片窗口不报：它不是「这个人正看着的那一页」。
  function onShown(list) { if (!card) reportUi({ dock: { open: dock.open, view: dock.open ? list.join('+') : '' } }); }

  // 拖出 app：一扇只放这张卡的窗口；同一张卡、同一个工作空间再拖一次 = 聚焦已开的那扇
  const popOut = {
    url: (v) => cardUrl(v, { id: session.id || '', ws: dock.ws }),
    key: (v) => `card:${v}:${dock.ws}`,
  };
  // 卡片窗口点「放回工作台」：主窗口（不是分屏格、不是别的独立窗）把这张卡摆回来
  $effect(() => {
    if (card || IS_SOLO || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(DOCK_CHANNEL);
    ch.onmessage = (e) => {
      const d = e.data;
      if (d?.t === 'back' && d.view && tools.some((x) => x.key === d.view)) { claudeHost.open(d.view); try { window.focus(); } catch {} }
    };
    return () => ch.close();
  });
  function cardBack() {
    try { const ch = new BroadcastChannel(DOCK_CHANNEL); ch.postMessage({ t: 'back', view: card, ws: dock.ws }); ch.close(); } catch {}
    setTimeout(() => window.close(), 40);
  }
</script>

{#snippet band()}<DockToolBar docked onClose={toolsClose} />{/snippet}

{#snippet panel(view)}
  {#if view === 'tasks'}
    <!-- 任务读的是本会话的对话状态，不按工作空间作用域 -->
    <TasksPanel {wide} />
  {:else}
    {@const w = workbenchByKey(view)}
    {#if w}<PluginWorkbench {w} />{:else}<div class="gone">{t('这个插件页面不在了（插件被关掉或卸载了）')}</div>{/if}
  {/if}
{/snippet}

<Workbench host={claudeHost} {tools} {wide} {overlay} {multi} {card} skin="claude" mobile="sheet" {snap}
  band={wide ? band : null} {panel} popOut={snap ? null : popOut} onCardBack={cardBack}
  keysOn={ui.screen === 'claude'} {onShown} />

<style>
  .gone { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; padding: 0 24px; text-align: center; line-height: 1.7; }
</style>
