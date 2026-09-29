<script lang="ts">
  // 工作流 agent 点阵（bridge Claude 分页 AgentDots = 官方 /code 页 rD 的 dimensio 版）：6px 方格，一格一个 agent，
  // 超出容量按状态比例压缩（lib/tasks.ts dotCells）。配色：在跑 = 青、错峰呼吸 · 完成 = 墨 24% · 久无动静 = warn ·
  // 失败 = err · 排队 / 幽灵格只描边。工作流紧凑卡（maxRows 8 + 幽灵格）与任务面板的工作流详情（按阶段、cols 16）共用。
  // 状态修饰类是模板插值拼的，scoped 规则一律 :global() 写法（否则被编译器当 unused 剪掉）。
  import { dotCells, type Counts, type DotState } from "../../lib/tasks.ts";
  import { t } from "../../lib/i18n.ts";

  let {
    counts,
    labels = null,
    cols = 0,
    maxRows = 4,
    anticipate = false,
  }: {
    counts: Counts;
    // 一格一 agent 时的顺序与悬停标题（长度对不上就退回按计数压缩）
    labels?: { label: string; state: DotState }[] | null;
    // 定列数（宽度收紧）；0 = 自动换行铺满
    cols?: number;
    // 自动换行时的行数上限
    maxRows?: number;
    // 末尾一枚「还会有 agent」的幽灵格
    anticipate?: boolean;
  } = $props();

  const cap = $derived(cols ? Number.MAX_SAFE_INTEGER : 35 * maxRows);
  const oneToOne = $derived(!!labels && labels.length === counts.total && counts.total <= cap);
  const cells = $derived<DotState[]>(oneToOne && labels ? labels.map((a) => a.state) : dotCells(counts, cap));

  const WORD: Record<DotState, string> = { done: t("完成"), running: t("运行中"), stalled: t("久无动静"), error: t("失败"), pending: t("排队") };
  const summary = $derived(
    counts.total === 0
      ? t("等待 agent 启动")
      : [
          t("{done}/{total} 完成", { done: counts.done, total: counts.total }),
          counts.running - counts.stalled ? t("{n} 运行中", { n: counts.running - counts.stalled }) : "",
          counts.stalled ? t("{n} 久无动静", { n: counts.stalled }) : "",
          counts.error ? t("{n} 失败", { n: counts.error }) : "",
        ]
          .filter(Boolean)
          .join(" · "),
  );
  const cellTitle = (s: DotState, i: number) => {
    const l = oneToOne && labels ? labels[i]?.label : "";
    return l ? `${WORD[s]} — ${l}` : WORD[s];
  };
  // 每个在跑格的呼吸时长 / 相位按黄金比例散开（官方 eD）：一片格子不会齐刷刷一起闪
  const pulse = (i: number) => {
    const ph = (0.61803398875 * i) % 1;
    const n = 2.4 + ((0.7548776662 * i) % 1) * 1.4;
    return `--dur:${n.toFixed(2)}s;--delay:${(-ph * n).toFixed(2)}s`;
  };
  const gridStyle = $derived(
    cols ? `grid-template-columns:repeat(${cols},6px)` : `grid-template-columns:repeat(auto-fill,6px);max-height:${8 * maxRows - 2}px`,
  );
</script>

<span class="dots" class:fit={!!cols} role="img" aria-label={summary} title={summary} style={gridStyle}>
  {#each cells as st, i (i)}
    <span class="cell {st}" title={cellTitle(st, i)} style={st === "running" ? pulse(i) : undefined}></span>
  {/each}
  {#if anticipate}<span class="cell ghost" title={t("可能还会有更多 agent")}></span>{/if}
</span>

<style>
  .dots {
    display: grid;
    gap: 2px;
    width: 100%;
    overflow: hidden;
  }
  .dots.fit {
    width: fit-content;
  }
  .cell {
    width: 6px;
    height: 6px;
    border-radius: 1.5px;
    border: 1px solid transparent;
    transition:
      background-color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .cell:global(.done) {
    background: color-mix(in srgb, var(--text) 24%, transparent);
  }
  .cell:global(.running) {
    background: var(--live);
    animation: ad-pulse var(--dur, 2.8s) ease-in-out var(--delay, 0s) infinite;
  }
  .cell:global(.stalled) {
    background: var(--warn);
  }
  .cell:global(.error) {
    background: var(--err);
  }
  .cell:global(.pending),
  .cell.ghost {
    border-color: var(--border2);
  }
  .cell.ghost {
    animation: ad-ghost 2.2s ease-in-out infinite;
  }
  @keyframes ad-pulse {
    50% {
      opacity: 0.5;
    }
  }
  @keyframes ad-ghost {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .cell:global(.running),
    .cell.ghost {
      animation: none;
    }
  }
</style>
