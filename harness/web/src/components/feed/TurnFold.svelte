<script lang="ts">
  // U8（ZCode E3）：做完的一轮，过程（工具、思考、中间的叙述）收成一行「处理过程 · N 次工具 · 用时 …」；点开照原样展开，
  // 过程接在这一行后面的量线上。节点就是 chevron：收着朝右，展开转下。
  import type { RunTiming } from "../../lib/timeline-types.ts";
  import { foldTiming } from "../../lib/feed-units.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import RailRow from "./RailRow.svelte";
  import { t } from "../../lib/i18n.ts";

  let {
    tools,
    run,
    open,
    ontoggle,
    up = false,
    down = false,
  }: { tools: number; run?: RunTiming; open: boolean; ontoggle: () => void; up?: boolean; down?: boolean } = $props();

  function toggle() {
    haptic("light");
    ontoggle();
  }
</script>

<RailRow {up} {down} clear={9} onclick={toggle} expanded={open}>
  {#snippet node()}
    <span class="nchev" class:open><Icon name="chevronR" size={13} stroke={2} /></span>
  {/snippet}
  {#snippet head()}
    <span class="t">{open ? t("收起处理过程") : t("处理过程 · {n} 次工具", { n: tools })}</span>
    {#if run}<span class="time">{foldTiming(run)}</span>{/if}
  {/snippet}
</RailRow>

<style>
  .nchev {
    display: grid;
    place-items: center;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .nchev.open {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .nchev {
      transition: none;
    }
  }
  .t {
    flex: none;
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text2);
  }
  .time {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    color: var(--text3);
  }
</style>
