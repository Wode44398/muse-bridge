<script lang="ts">
  // 四个数（K11）：待确认 · 被隔离 · 生效 · 已退场。它们同时是整块面板的图例——字形与点阵、时间线、列表行上的一致。
  // 点一个 = 只看这一类（点阵里别的类淡下去 / 列表只留这一组），再点一次还原。0 的那一格照样占位（不跳版），数字退成辅助色。
  import { haptic } from "../../lib/touch.ts";
  import { t } from "../../lib/i18n.ts";
  import MemoryGlyph from "./MemoryGlyph.svelte";
  import { fmtCount, LANE_GLYPH, LANES, type Lane } from "./memory-viz.ts";
  import { LANE_TEXT } from "./memory-text.ts";

  let {
    counts,
    picked = null,
    onpick,
  }: { counts: Record<Lane, number>; picked?: Lane | null; onpick?: (lane: Lane | null) => void } = $props();

  function pick(lane: Lane) {
    if (!onpick) return;
    haptic("light");
    onpick(picked === lane ? null : lane);
  }
</script>

<div class="stats" class:picking={picked !== null} role="group" aria-label={t("记忆按状态计数")}>
  {#each LANES as lane (lane)}
    {@const n = counts[lane]}
    <button
      class="tile"
      class:on={picked === lane}
      class:zero={n === 0}
      aria-pressed={picked === lane}
      disabled={!onpick}
      onclick={() => pick(lane)}
    >
      <span class="lab"><MemoryGlyph kind={LANE_GLYPH[lane]} size={12} />{LANE_TEXT[lane].label}</span>
      <span class="num">{fmtCount(n)}</span>
      <span class="hint">{LANE_TEXT[lane].hint}</span>
    </button>
  {/each}
</div>

<style>
  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0 -6px 22px;
  }
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    padding: 10px 12px 11px;
    border-radius: var(--r-md);
    text-align: left;
    color: var(--text);
    transition:
      background-color var(--t-fast) var(--ease),
      opacity var(--t-med) var(--ease);
  }
  /* 格与格之间一根竖细线（纸上的分栏），选中的那格与它左边那根让开 */
  .tile + .tile::before {
    content: "";
    position: absolute;
    left: 0;
    top: 14px;
    bottom: 14px;
    width: 1px;
    background: var(--border);
    transition: opacity var(--t-fast) var(--ease);
  }
  .tile.on::before,
  .tile.on + .tile::before {
    opacity: 0;
  }
  .tile:disabled {
    cursor: default;
  }
  @media (hover: hover) {
    .tile:not(:disabled):not(.on):hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .tile:not(:disabled):active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .tile.on {
    background: var(--accent-soft);
  }
  .picking .tile:not(.on) {
    opacity: 0.55;
  }
  .lab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text2);
    white-space: nowrap;
  }
  .num {
    margin-top: 2px;
    font-size: var(--fs-2xl);
    font-weight: 500;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }
  .zero .num {
    color: var(--text3);
  }
  .hint {
    max-width: 100%;
    font-size: var(--fs-xs);
    line-height: 1.4;
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 手机：两列两行，横线补上行与行的分隔 */
  @media (max-width: 699px) {
    .stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      row-gap: 2px;
    }
    .tile:nth-child(3)::before {
      display: none;
    }
    .num {
      font-size: var(--fs-xl);
    }
  }
</style>
