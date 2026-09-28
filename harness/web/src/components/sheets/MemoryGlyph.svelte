<script lang="ts">
  // 一条记忆的字形（K11）：统计卡、点阵、时间线、列表行共用同一套，形状本身就能读出状态（颜色只是第二道编码）。
  //   生效 = 实心墨点 · 待确认 = 空心圈（琥珀）· 被隔离 = 圈里一粒点（柔红：写着生效却没进提示）·
  //   已失效 = 实心小灰点 · 已被替代 = 空心小灰圈 · 已驳回 = 灰叉。
  import type { Glyph } from "./memory-viz.ts";

  let { kind, size = 12, title }: { kind: Glyph; size?: number; title?: string } = $props();
</script>

<svg
  class="g k-{kind}"
  width={size}
  height={size}
  viewBox="0 0 12 12"
  role={title ? "img" : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : "true"}
>
  {#if kind === "active"}
    <circle cx="6" cy="6" r="4" class="fill" />
  {:else if kind === "proposed"}
    <circle cx="6" cy="6" r="3.6" class="ring" />
  {:else if kind === "held"}
    <circle cx="6" cy="6" r="3.6" class="ring" />
    <circle cx="6" cy="6" r="1.4" class="fill" />
  {:else if kind === "stale"}
    <circle cx="6" cy="6" r="2.8" class="fill" />
  {:else if kind === "superseded"}
    <circle cx="6" cy="6" r="2.6" class="ring thin" />
  {:else}
    <path d="M3.6 3.6 8.4 8.4 M8.4 3.6 3.6 8.4" class="ring" />
  {/if}
</svg>

<style>
  .g {
    --c: var(--text3);
    display: block;
    flex: none;
    overflow: visible;
  }
  .g:global(.k-active) {
    --c: var(--accent);
  }
  .g:global(.k-proposed) {
    --c: var(--warn);
  }
  .g:global(.k-held) {
    --c: var(--err);
  }
  .fill {
    fill: var(--c);
  }
  .ring {
    fill: none;
    stroke: var(--c);
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  .ring.thin {
    stroke-width: 1.3;
  }
</style>
