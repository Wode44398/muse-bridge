<script lang="ts">
  // 空态：说清楚为什么空、去哪看（DESIGN.md「空态」）。图形默认是一枚安静的标志。
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "./Icon.svelte";
  import Mark from "../brand/Mark.svelte";

  let { title, text, icon, compact = false, children }: { title: string; text?: string; icon?: IconName; compact?: boolean; children?: Snippet } = $props();
</script>

<div class="empty" class:compact>
  <div class="glyph">
    {#if icon}<Icon name={icon} size={compact ? 20 : 24} stroke={1.4} />{:else}<Mark size={compact ? 22 : 28} />{/if}
  </div>
  <p class="t">{title}</p>
  {#if text}<p class="x">{text}</p>{/if}
  {#if children}<div class="act">{@render children()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 44px 24px;
    color: var(--text2);
  }
  .compact {
    padding: 22px 16px;
  }
  .glyph {
    display: inline-flex;
    color: var(--text3);
    opacity: 0.8;
    margin-bottom: 14px;
  }
  .compact .glyph {
    margin-bottom: 10px;
  }
  .t {
    margin: 0;
    max-width: 340px;
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 1.5;
    color: var(--text);
    text-wrap: balance;
  }
  .x {
    margin: 6px 0 0;
    max-width: 320px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text3);
    text-wrap: balance;
  }
  .act {
    margin-top: 16px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>
