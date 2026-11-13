<script>
  // claude 页顶部：不是整栏 header，而是悬浮控件浮在对话之上——
  // 左：圆形菜单钮（只在手机档出；侧列两档换成 ClaudePage 里的 claude/SidebarToggle）；右：两种形态二选一——
  //   · tools（侧列形态：电脑 / 平板 / 分屏格）＝ Claude 桌面版同款的【工具开关组】（DockToolBar）。
  //     工作台收着时挂在【这一格】的右上角（桌面壳 WCO 下坐进标题栏带、和最小化 / 关闭同一排）；
  //     工作台一展开就交给 ClaudeDock 挂进它顶上那条带里（卡片正上方），这里不再摆。
  //   · 否则（手机底部 sheet 形态）＝ 原来的「新对话 + 两点键」胶囊（明暗主题改由设置 / 单击菊花切换），两点键开 sheet。
  // 材质：Figma iOS 27 kit 的液态玻璃（Liquid Glass - Regular - Small，明暗两个变体）。图形层是构建期
  // 用 Figma 原版着色器烘焙的「与底色无关」图层（assets/figma-glass，做法与核对数据见
  // bridge build/design/figma-glass-controls/bake.html）：页面底色从下面透上来，在 --bg 上与 Figma
  // 逐像素一致；正文滚到底下时靠 backdrop 模糊透出（磨砂半径 6 → σ≈2.45，不做折射）。
  // `?oldglass` 退回原来的纯毛玻璃，方便对比。玻璃只给触屏；鼠标设备（电脑浏览器、桌面壳）走扁平实底（.flat）。
  import { dock, browserMountedNow } from '../lib/dock.svelte.js';
  import DockToolBar from './dock/DockToolBar.svelte';
  import { t, tc } from '../lib/i18n.js';
  import { liquidPress } from '../lib/liquid/press.js';
  // hideMenu：不出汉堡（侧列两档的侧栏开关由宿主另挂，快照页 / 分屏格没有侧栏）
  // sat=false：宿主自己已经吃掉安全区（快照页在根容器加了 padding-top），别再叠一次
  // split：分屏里的一格；onClose 给了就在工具组末尾多一颗 ✕（关掉这一格）——工作台展开时宿主
  //   要把同一个 onClose 交给 ClaudeDock（toolsClose），那边的工具组照样有 ✕
  // onNew：「新对话」（S1-6）。手机形态塞进右上胶囊的最前面；侧列形态那颗挨着侧栏开关的圆钮归 SidebarToggle。
  //   宿主不给就不出（快照页、分屏格）。
  let { onMenu, onDock, onNew = null, hideMenu = false, sat = true, split = false, onClose = null, tools = false } = $props();
  const top = $derived(sat ? 'calc(var(--sat) + 10px)' : '10px');
  const flat = typeof matchMedia !== 'undefined' && !matchMedia('(pointer: coarse)').matches;
  const fg = !flat && (typeof location === 'undefined' || !new URLSearchParams(location.search).has('oldglass'));
</script>

{#snippet newIcon()}
  <!-- 方框 + 笔（新对话）：自绘，不走图标字体 -->
  <svg class="nc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13"/><path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.6.9.9-3.6z"/></svg>
{/snippet}
{#if !hideMenu}<button class="fab round" class:fg class:flat use:liquidPress={{ disabled: !fg }} aria-label={t('菜单')} style:top onclick={onMenu}>&#xe0dd;</button>{/if}
{#if tools}
  {#if !dock.open}<DockToolBar {top} {split} {onClose} />{/if}
{:else}
<div class="fab pill" class:fg class:flat use:liquidPress={{ disabled: !fg }} style:top>
  {#if onNew}<button class="pbtn" aria-label={tc('claude', '新对话')} onclick={onNew}>{@render newIcon()}</button>{/if}
  <button class="pbtn eyes" class:on={dock.open} aria-label={t('工作台')} onclick={onDock}>
    <svg viewBox="0 0 20 20" fill="none"><circle cx="7" cy="9" r="1.6" fill="currentColor"/><circle cx="13" cy="9" r="1.6" fill="currentColor"/></svg>
    {#if browserMountedNow() || (dock.termLive && !dock.open)}<span class="live-dot"></span>{/if}
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
  .fab.round:active { background: rgba(32,32,30,.6); }
  :global(html[data-theme="light"]) .fab.round:active { background: rgba(235,235,230,.7); }

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
  /* agent 正在用浏览器且面板没开：呼吸绿点提示（点开即清） */
  .live-dot { position: absolute; top: 5px; right: 7px; width: 7px; height: 7px; border-radius: 50%;
    background: var(--ok); animation: tbPulse 1.2s ease-in-out infinite; }
  @keyframes tbPulse { 50% { opacity: .35; } }

  /* —— Figma 液态玻璃（默认；?oldglass 退回上面的毛玻璃）——
     ::before 盖住控件外扩 24px（投影在里面），画烘焙好的图层；控件自身只留 backdrop 模糊，底色从下面透上来。
     每张图对应一个尺寸：44 手机、36 工具组形态、40 触屏工具组、32 桌面壳 WCO；胶囊按三段切片横向拉伸
     （两端各 64px 原样、中段拉伸——中段逐列不变，核对误差 ≤3/255）。
     图标色 = Figma 的标签色按其混合模式落在玻璃上的结果：亮 #1a1a1a LINEAR_BURN → #0d0d0d；
     暗 #f5f5f5 LINEAR_DODGE（CSS 没有 linear-burn，这里统一用普通混合的等效色）。 */
  :global(html) .fab.fg {
    background: transparent; color: #f5f5f5;
    -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px);
  }
  :global(html[data-theme="light"]) .fab.fg { background: transparent; color: #0d0d0d; }
  /* 按下：在玻璃背后垫一层淡色（相当于底色变了），玻璃图层本身不动 */
  :global(html) .fab.round.fg:active { background: var(--hover-strong); }
  .fab.fg .pbtn { color: inherit; }
  .fab.fg::before {
    content: ''; position: absolute; inset: -24px; z-index: -1; pointer-events: none;
    background: center / 100% 100% no-repeat;
  }
  .fab.round.fg::before { background-image: var(--ov-figma-glass-tb-orb44-dark); }
  :global(html[data-theme="light"]) .fab.round.fg::before { background-image: var(--ov-figma-glass-tb-orb44-light); }
  .fab.pill.fg::before {
    background: none; border-style: solid; border-width: 0 64px;
    border-image: var(--ov-figma-glass-tb-cap44-dark) 0 192 fill / 0 64px / 0 stretch;
  }
  :global(html[data-theme="light"]) .fab.pill.fg::before { border-image-source: var(--ov-figma-glass-tb-cap44-light); }

  /* —— 鼠标设备：扁平实底（同 DockToolBar .flat）——页面同色实底 + 细描边，不模糊不透色 */
  :global(html) .fab.flat {
    background: var(--bg); box-shadow: inset 0 0 0 1px var(--divider);
    -webkit-backdrop-filter: none; backdrop-filter: none;
  }
  :global(html) .fab.round.flat:active { background: color-mix(in srgb, var(--text) 10%, var(--bg)); }
  @media (hover: hover) { :global(html) .fab.round.flat:hover { background: color-mix(in srgb, var(--text) 7%, var(--bg)); color: var(--text); } }
</style>
