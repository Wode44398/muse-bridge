<script>
  // Claude 分页侧列形态（medium / expanded）的侧栏开关 + 侧栏收起时紧挨着它的「新对话」圆钮。
  //
  // 一颗按钮两个家：侧栏展开时坐在侧栏标题行（字标）的右端，收起时才浮到正文左上角。不是两颗按钮
  // 交叉淡化，是【同一个元素贴着侧栏右缘走】：宿主把它挂在 .panes 里（.panes 的左缘＝侧栏右缘），
  // 侧栏的宽度动画推着这条缘走、按钮天然跟着；它自己只过渡「相对右缘的偏移」——缘内（标题行右端，
  // 负值）↔ 缘外（+10px）。两条过渡同时长、同曲线（侧栏 .sb-wrap 与这里的 left 共用 open/收起两档），
  // 叠起来是一条顺滑的直线滑行，按钮和侧栏像一块东西在动。途中形态从浮钮（圆、触屏玻璃 / 鼠标描边实底）
  // 化成侧栏里的扁平图标钮（圆角方、透明底），图标里的左栏随之推满 / 收空。焦点始终在同一个元素上，
  // 键盘连按不丢焦点。
  //
  // open：侧栏此刻是否展开（宿主的 pinned）；gutter：常驻侧栏此刻的滚动条宽（列表溢出才有，
  //   缘内位置要再往里让这么多，免得压住滚动条拇指）；onNew：收起时右边那颗「新对话」，不给就不出（快照页）。
  import { t, tc } from '../../lib/i18n.js';
  import { liquidPress } from '../../lib/liquid/press.js';
  let { open = false, gutter = 0, onToggle, onNew = null } = $props();
  // 鼠标设备走扁平实底（同 TopBar / DockToolBar 的 .flat），触屏走 Figma 液态玻璃（.fg）
  const flat = typeof matchMedia !== 'undefined' && !matchMedia('(pointer: coarse)').matches;
  const label = $derived(open ? tc('claude', '收起侧栏') : tc('claude', '展开侧栏'));
</script>

<div class="sbt-root" style:--sbt-gut={gutter + 'px'}>
  <button class="sbt" class:open class:flat class:fg={!flat} use:liquidPress={{ disabled: flat }} aria-label={label} title={flat ? label : null}
    aria-expanded={open} onclick={onToggle}>
    <!-- 侧栏图标：圆角框 + 左栏分隔线；左栏里那根实条随开合推满 / 收空（悬停时先推一半，预告这一下会发生什么） -->
    <svg class="sbt-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2.25"/>
      <path d="M6.5 2.75v10.5"/>
      <rect class="pane" x="3.1" y="3.85" width="2.3" height="8.3" rx=".9" fill="currentColor" stroke="none"/>
    </svg>
  </button>
  {#if onNew}
    <button class="sbn" class:gone={open} class:flat class:fg={!flat} use:liquidPress={{ disabled: flat }} aria-label={tc('claude', '新对话')} title={flat ? tc('claude', '新对话') : null}
      inert={open} onclick={onNew}>
      <!-- 方框 + 笔（新对话）：与 TopBar 那颗同一张图 -->
      <svg class="sbn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13"/><path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.6.9.9-3.6z"/></svg>
    </button>
  {/if}
</div>

<style>
  /* 尺寸：--o 缘外浮钮直径（和右上工具开关组同高同中线），--i 缘内图标钮边长；
     缘内竖直方向对齐侧栏字标行（侧栏顶内边距 max(10px, 安全区) + 44px 行、行底 2px 留白 → 有效 42px）。 */
  .sbt-root { display: contents; --o: 36px; --i: 32px; --ic: 18px; }
  @media (pointer: coarse) { .sbt-root { --o: 40px; --i: 40px; --ic: 20px; } }
  :global(html[data-wco="1"]) .sbt-root { --o: 32px; --i: 32px; --ic: 17px; }

  .sbt, .sbn {
    position: absolute; z-index: 30;
    display: flex; align-items: center; justify-content: center;
    width: var(--o); height: var(--o);
    top: calc(var(--sat) + 10px);
    color: var(--serif);
    -webkit-tap-highlight-color: transparent;
  }
  /* 桌面壳 WCO：缘外坐进 40px 标题栏带，与工具开关组、系统窗控同一条中线。
     :not(.open) 不能省——这条带 html 前缀，优先级压过下面 .sbt.open 的 top，缘内会被拽回标题栏带。 */
  :global(html[data-wco="1"]) .sbt:not(.open), :global(html[data-wco="1"]) .sbn { top: calc((var(--wco-h, 40px) - 32px) / 2); }

  /* —— 开关本体：缘外（收起）——
     收起的这一档用「收起」节拍（--mo-base），展开那一档在 .open 里换成 --mo-page：CSS 过渡取的是【变化后】
     那一侧的声明，所以展开慢一点、从容落位，收起利落。left/top 必须与宿主 .sb-wrap 的 width 同时长同曲线。 */
  .sbt {
    left: 10px; border-radius: calc(var(--o) / 2);
    transition:
      left var(--mo-base) var(--ea-std), top var(--mo-base) var(--ea-std),
      width var(--mo-base) var(--ea-std), height var(--mo-base) var(--ea-std), border-radius var(--mo-base) var(--ea-std),
      background-color var(--mo-quick) var(--ea-fade), box-shadow var(--mo-quick) var(--ea-fade), color var(--mo-micro) var(--ea-fade);
  }
  /* —— 缘内（展开）：侧栏标题行右端，右沿与侧栏行的悬停底对齐（1px 边框 + 8px 内边距 + 滚动条）—— */
  .sbt.open {
    left: calc(-9px - var(--sbt-gut, 0px) - var(--i));
    top: calc(max(10px, var(--sat)) + (42px - var(--i)) / 2);
    width: var(--i); height: var(--i); border-radius: 8px;
    transition:
      left var(--mo-page) var(--ea-std), top var(--mo-page) var(--ea-std),
      width var(--mo-base) var(--ea-std), height var(--mo-base) var(--ea-std), border-radius var(--mo-base) var(--ea-std),
      background-color var(--mo-quick) var(--ea-fade), box-shadow var(--mo-quick) var(--ea-fade), color var(--mo-micro) var(--ea-fade);
  }
  .sbt-ic { width: var(--ic); height: var(--ic); flex: none; overflow: visible; }
  /* 左栏实条：展开＝推满、收起＝收空；起点钉在左缘（fill-box 左中），像侧栏本身一样从左边推出来 */
  .sbt-ic .pane { transform-box: fill-box; transform-origin: 0 50%; transform: scaleX(0); opacity: .55;
    transition: transform var(--mo-base) var(--ea-std); }
  .sbt.open .sbt-ic .pane { transform: scaleX(1); transition-delay: 60ms; }
  @media (hover: hover) {
    .sbt:hover .sbt-ic .pane { transform: scaleX(.5); transition-delay: 0s; }
  }

  /* —— 新对话圆钮：只在收起时露面，紧挨开关（10 + 直径 + 8）——
     展开时它往左缩进开关底下、淡出（像被一起收进侧栏）；收起时等开关滑出一段再从左边弹回原位。 */
  .sbn {
    left: calc(18px + var(--o)); border-radius: 50%;
    transition: opacity var(--mo-quick) var(--ea-fade) 120ms, transform var(--mo-base) var(--ea-decel) 120ms,
      visibility 0s linear 0s, background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade);
  }
  .sbn.gone {
    opacity: 0; transform: translateX(calc(-8px - var(--o))) scale(.6); visibility: hidden; pointer-events: none;
    transition: opacity var(--mo-micro) var(--ea-fade), transform var(--mo-quick) var(--ea-accel), visibility 0s linear var(--mo-quick);
  }
  .sbn-ic { width: 18px; height: 18px; }
  :global(html[data-wco="1"]) .sbn-ic { width: 16px; height: 16px; }

  /* —— 鼠标设备：缘外＝页面同色实底 + 1px 细描边（同 TopBar .flat），缘内＝透明底、无描边，
     悬停走侧栏行同款底色。描边用同形状的透明阴影收掉，过渡才是淡出而不是一跳。 —— */
  .flat { background: var(--bg); box-shadow: inset 0 0 0 1px var(--divider); }
  .sbt.flat.open { background: transparent; box-shadow: inset 0 0 0 1px transparent; }
  .flat:active { background: color-mix(in srgb, var(--text) 10%, var(--bg)); }
  .sbt.flat.open:active { background: var(--hover-strong); }
  @media (hover: hover) {
    .flat:hover { background: color-mix(in srgb, var(--text) 7%, var(--bg)); color: var(--text); }
    .sbt.flat.open:hover { background: var(--hover); color: var(--text); }
  }

  /* —— 触屏：Figma 液态玻璃（烘焙图层，做法见 TopBar.svelte 注释）。缘内把玻璃层淡掉、模糊撤掉，
     图标色从玻璃标签色回到侧栏图标色。 —— */
  .fg { background: transparent; color: #f5f5f5; -webkit-backdrop-filter: blur(2.45px); backdrop-filter: blur(2.45px); }
  :global(html[data-theme="light"]) .fg { color: #0d0d0d; }
  .fg::before {
    content: ''; position: absolute; inset: -24px; z-index: -1; pointer-events: none;
    background: center / 100% 100% no-repeat var(--ov-figma-glass-tb-orb40-dark);
    transition: opacity var(--mo-quick) var(--ea-fade);
  }
  :global(html[data-theme="light"]) .fg::before { background-image: var(--ov-figma-glass-tb-orb40-light); }
  :global(html[data-wco="1"]) .fg::before { background-image: var(--ov-figma-glass-tb-orb32-dark); }
  :global(html[data-theme="light"][data-wco="1"]) .fg::before { background-image: var(--ov-figma-glass-tb-orb32-light); }
  .fg:active { background: var(--hover-strong); }
  .sbt.fg.open, :global(html[data-theme="light"]) .sbt.fg.open { color: var(--serif); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .sbt.fg.open::before { opacity: 0; }
</style>
