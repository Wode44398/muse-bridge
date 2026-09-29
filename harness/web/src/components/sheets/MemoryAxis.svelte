<script lang="ts">
  // 时间线的尺（K11）：列表上方一行刻度字，与每一行的时间线同宽同位（左右同样让 6px），右端就是「现在」。
  import { locale, t } from "../../lib/i18n.ts";
  import { ticksOf, xOf, type Span } from "./memory-viz.ts";

  let { span, max = 4 }: { span: Span; max?: number } = $props();

  const ticks = $derived(ticksOf(span, max, locale()).map((tk) => ({ ...tk, x: xOf(tk.t, span) })));
  // 「现在」贴右端；最后一个刻度离得太近就不写，免得两个字挤在一起
  const showNow = $derived(!ticks.length || ticks[ticks.length - 1]!.x < 0.82);
  const edge = (x: number) => (x < 0.08 ? "start" : x > 0.92 ? "end" : "mid");
</script>

<div class="axis" aria-hidden="true">
  <span class="track">
    {#each ticks as tk (tk.t)}
      <span class="tk {edge(tk.x)}" style="left:{(tk.x * 100).toFixed(3)}%">{tk.label}</span>
    {/each}
    {#if showNow}<span class="tk end now" style="left:100%">{t("现在")}</span>{/if}
  </span>
</div>

<style>
  .axis {
    position: relative;
    height: 16px;
  }
  .track {
    position: absolute;
    inset: 0 6px;
  }
  .tk {
    position: absolute;
    top: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 16px;
    color: var(--text3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    transform: translateX(-50%);
  }
  .tk:global(.start) {
    transform: translateX(-6px);
  }
  .tk:global(.end) {
    transform: translateX(calc(-100% + 6px));
  }
  .now {
    font-family: var(--font-ui);
  }
</style>
