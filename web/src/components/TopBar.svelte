<script>
  // claude 页顶部：不是整栏 header，而是悬浮控件浮在对话之上——
  // 左：圆形菜单钮（medium 档才出）；右：两种形态二选一——
  //   · tools（侧列形态：电脑 / 平板 / 分屏格）＝ Claude 桌面版同款的【工具开关组】（DockToolBar）。
  //     工作台收着时挂在【这一格】的右上角；
  //     工作台一展开就交给 ClaudeDock 挂进它顶上那条带里（卡片正上方），这里不再摆。
  //   · 否则（手机底部 sheet 形态）＝ 原来的「主题 + 两点键」胶囊，两点键开 sheet。
  // 材质：无边框、无高光、纯毛玻璃（backdrop blur）；内容滚到底下时透出模糊。
  import { toggleTheme } from '../lib/state.svelte.js';
  import { dock } from '../lib/dock.svelte.js';
  import DockToolBar from './dock/DockToolBar.svelte';
  // hideMenu：侧栏【恒】常驻的最宽档隐藏汉堡（medium 档仍要它当常驻开关）
  // menuOn：汉堡的选中态（侧栏已常驻时点亮）
  // sat=false：宿主自己已经吃掉安全区（快照页在根容器加了 padding-top），别再叠一次
  // split：分屏里的一格；onClose 给了就在工具组末尾多一颗 ✕（关掉这一格）——工作台展开时宿主
  //   要把同一个 onClose 交给 ClaudeDock（toolsClose），那边的工具组照样有 ✕
  let { onMenu, onDock, hideMenu = false, menuOn = false, sat = true, split = false, onClose = null, tools = false } = $props();
  const top = $derived(sat ? 'calc(var(--sat) + 10px)' : '10px');
</script>

{#if !hideMenu}<button class="fab round" class:sm={tools} class:on={menuOn} aria-label={menuOn ? '收起侧栏' : '菜单'} aria-pressed={menuOn} style:top onclick={onMenu}>&#xe0dd;</button>{/if}
{#if tools}
  {#if !dock.open}<DockToolBar {top} {split} {onClose} />{/if}
{:else}
<div class="fab pill" style:top>
  <button class="pbtn" aria-label="切换明暗主题" onclick={toggleTheme}>
    <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
  </button>
  <button class="pbtn eyes" class:on={dock.open} aria-label="工作台" onclick={onDock}>
    <svg viewBox="0 0 20 20" fill="none"><circle cx="7" cy="9" r="1.6" fill="currentColor"/><circle cx="13" cy="9" r="1.6" fill="currentColor"/></svg>
    {#if dock.termLive && !dock.open}<span class="live-dot"></span>{/if}
  </button>
</div>
{/if}

<style>
  /* 共用毛玻璃材质：无 border、无高光描边、无投影——纯 blur + 半透底色 */
  .fab {
    position: absolute; z-index: 30;   /* top 由 sat 属性内联给（宿主吃过安全区时不叠加） */
    background: rgba(32, 32, 30, .42);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    backdrop-filter: blur(18px) saturate(1.5);
    color: var(--serif);
  }
  :global(html[data-theme="light"]) .fab { background: rgba(248, 248, 246, .5); }

  .fab.round {
    left: 10px; width: 44px; height: 44px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--icons); font-size: 21px;
  }
  /* 和右上工具组同高同中线（工具组 36px） */
  .fab.round.sm { width: 36px; height: 36px; font-size: 18px; }
  .fab.round:active { background: rgba(32,32,30,.6); }
  :global(html[data-theme="light"]) .fab.round:active { background: rgba(235,235,230,.7); }
  /* 折叠屏展开档：汉堡＝侧栏常驻开关，已常驻时点亮（与 eyes 键同款选中反馈） */
  .fab.round.on { color: var(--text); background: rgba(32,32,30,.62); }
  :global(html[data-theme="light"]) .fab.round.on { background: rgba(228,228,222,.78); }

  .fab.pill {
    right: 10px; height: 44px; border-radius: 22px;
    display: flex; align-items: center; padding: 0 4px;
  }
  .pbtn {
    width: 42px; height: 36px; border-radius: 18px;
    display: flex; align-items: center; justify-content: center; color: var(--serif);
  }
  .pbtn:active { background: var(--hover-strong); }
  .pbtn svg { width: 20px; height: 20px; }
  .pbtn.eyes { position: relative; }
  .pbtn.eyes.on { background: var(--hover-strong); color: var(--text); }
  /* agent 正在用终端且面板没开：呼吸绿点提示（点开即清） */
  .live-dot { position: absolute; top: 5px; right: 7px; width: 7px; height: 7px; border-radius: 50%;
    background: var(--ok); animation: tbPulse 1.2s ease-in-out infinite; }
  @keyframes tbPulse { 50% { opacity: .35; } }
  .pbtn .moon { display: none; }
  :global(html[data-theme="light"]) .pbtn .sun { display: none; }
  :global(html[data-theme="light"]) .pbtn .moon { display: block; }

  /* 触屏（平板 / 折叠屏展开）：和工具开关组（DockToolBar，触屏 40px）同高同中线 */
  @media (pointer: coarse) { .fab.round.sm { width: 40px; height: 40px; } }
</style>
