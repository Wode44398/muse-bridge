<script lang="ts">
  // 量线上的一行（工具行、思考行、工具组头与组内各步、轮次折叠行、活动行共用）：
  //   左侧一列是「节点」（圆点 / 标志 / chevron），同一轮里相邻的这些行由节点之间 1px 的细线串起来——
  //   品牌的尺寸线母题竖过来用；线在节点上下各留一点间隙，像尺寸线的端点。
  //   右侧第一行是头行（可点就是按钮：悬停浮底、按下加深、键盘可达），下面是这一行的其余内容（结果行、实时尾行、展开的详情）。
  //
  // up / down 由调用方按邻居算好（Feed 按显示单元、工具组按组内顺序）：上一行也在量线上就接上去、下一行也在就接下来。
  // 几何全靠 Feed 列上的变量：--gutter 节点列宽、--rail-x 节点中心、--row-h 头行高、--rail-gap 相邻两行的间距（上接线
  // 要跨过这段间距，所以间距必须正好是它）。clear = 线在节点上下留的空（圆点小、标志大）。nodeY = 节点中心离行顶的距离
  //（默认头行正中；卡片按卡片第一行定）。
  import type { Snippet } from "svelte";
  import Icon from "../ui/Icon.svelte";

  let {
    up = false,
    down = false,
    clear = 6,
    nodeY,
    node,
    head,
    chev = null,
    open = false,
    onclick,
    expanded,
    title,
    children,
  }: {
    up?: boolean;
    down?: boolean;
    clear?: number;
    nodeY?: string;
    node: Snippet;
    head?: Snippet;
    chev?: "down" | "right" | null;
    open?: boolean;
    onclick?: (e: MouseEvent) => void;
    expanded?: boolean;
    title?: string;
    children?: Snippet;
  } = $props();
</script>

<div class="rr" class:up class:down style:--clear="{clear}px" style:--node-y={nodeY}>
  <span class="rnode" aria-hidden="true">{@render node()}</span>
  {#if head}
    {#if onclick}
      <button class="rhead btn" {onclick} aria-expanded={expanded} {title}>
        {@render head()}
        {#if chev}<span class="chev" class:right={chev === "right"} class:open><Icon name={chev === "right" ? "chevronR" : "chevronD"} size={13} stroke={1.9} /></span>{/if}
      </button>
    {:else}
      <div class="rhead">{@render head()}</div>
    {/if}
  {/if}
  {#if children}{@render children()}{/if}
</div>

<style>
  .rr {
    position: relative;
    min-width: 0;
    padding-left: var(--gutter);
  }
  .rnode {
    position: absolute;
    left: var(--rail-x);
    top: var(--node-y, calc(var(--row-h) / 2));
    z-index: 1;
    display: grid;
    place-items: center;
    transform: translate(-50%, -50%);
    color: var(--text3);
    pointer-events: none;
  }
  /* 量线：上接线从本行顶上跨过行距接到上一行底，停在节点上方；下接线从节点下方一直到本行底 */
  .rr.up::before,
  .rr.down::after {
    content: "";
    position: absolute;
    left: calc(var(--rail-x) - 0.5px);
    z-index: 1;
    width: 1px;
    background: var(--border2);
    pointer-events: none;
  }
  .rr.up::before {
    top: calc(-1 * var(--rail-gap));
    height: max(0px, calc(var(--rail-gap) + var(--node-y, calc(var(--row-h) / 2)) - var(--clear)));
  }
  .rr.down::after {
    top: calc(var(--node-y, calc(var(--row-h) / 2)) + var(--clear));
    bottom: 0;
  }

  /* 头行：往左盖住节点列、左右各出血 6px，悬停浮底时节点在底上（节点与线叠在上层，不挡点击） */
  .rhead {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    width: calc(100% + var(--gutter) + 12px);
    min-height: var(--row-h);
    margin-left: calc(-1 * var(--gutter) - 6px);
    padding: 0 6px 0 calc(var(--gutter) + 6px);
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--text2);
    font-size: var(--fs-base);
    line-height: var(--lh-tight);
  }
  .rhead.btn {
    transition: background-color var(--t-fast) var(--ease);
  }
  .rhead.btn:active {
    background: var(--surface3);
  }
  .chev {
    display: inline-flex;
    flex: none;
    margin-left: auto;
    padding-left: 4px;
    color: var(--text3);
    opacity: 0.5;
    transition:
      transform var(--t-med) var(--ease-out),
      opacity var(--t-fast) var(--ease);
  }
  .chev.open {
    transform: rotate(180deg);
    opacity: 0.8;
  }
  .chev.right {
    opacity: 0.55;
  }
  @media (hover: hover) {
    .rhead.btn:hover {
      background: var(--surface2);
    }
    .rhead.btn:hover .chev {
      opacity: 0.9;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: opacity var(--t-fast) var(--ease);
    }
  }
</style>
