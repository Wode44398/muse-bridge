<script lang="ts">
  // 一条记忆的一生（K11）：一根贯穿全宽的细线是时间（整个项目共用一把尺），走过的一段描粗，每一份旧版是一道刻痕
  // （改写 / 驳回 / 撤销驳回……），末端停着它此刻的字形——官网插图里「光点沿线走、停在末端」的同一个母题。
  // 读屏走详情里的「经历」表（同样的数据），这里整块 aria-hidden；精确指针悬停刻痕 / 末端给出日期与事件。
  import { t } from "../../lib/i18n.ts";
  import MemoryGlyph from "./MemoryGlyph.svelte";
  import { xOf, type Glyph, type Lane, type Life, type Span } from "./memory-viz.ts";
  import { fmtShortDate, HISTORY_TEXT } from "./memory-text.ts";

  let { life, span, glyph, lane }: { life: Life; span: Span; glyph: Glyph; lane: Lane } = $props();

  const ok = $derived(Number.isFinite(life.start) && Number.isFinite(life.end));
  const x0 = $derived(ok ? xOf(life.start, span) : 1);
  const x1 = $derived(ok ? xOf(life.end, span) : 1);
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  const when = (ts: number) => fmtShortDate(new Date(ts).toISOString());
</script>

<div class="ll l-{lane}" aria-hidden="true">
  <span class="base"></span>
  {#if ok}
    <span class="track">
      {#if x1 > x0}<span class="life" style="left:{pct(x0)};width:{pct(x1 - x0)}"></span>{/if}
      {#each life.events as e, i (i)}
        <span class="tick" style="left:{pct(xOf(e.t, span))}" data-tip="{when(e.t)} {HISTORY_TEXT[e.why]}"></span>
      {/each}
      <span class="end" style="left:{pct(x1)}" data-tip="{when(life.end)} {t('当前版本')}"><MemoryGlyph kind={glyph} size={12} /></span>
    </span>
  {/if}
</div>

<style>
  .ll {
    --c: var(--text3);
    position: relative;
    height: 16px;
  }
  .ll:global(.l-active) {
    --c: var(--accent);
  }
  .ll:global(.l-proposed) {
    --c: var(--warn);
  }
  .ll:global(.l-held) {
    --c: var(--err);
  }
  .base {
    position: absolute;
    left: 0;
    right: 0;
    top: 7.5px;
    height: 1px;
    background: var(--border);
  }
  /* 左右各让 6px：两端的字形不出框 */
  .track {
    position: absolute;
    inset: 0 6px;
  }
  .life {
    position: absolute;
    top: 7px;
    height: 2px;
    border-radius: 1px;
    background: var(--c);
    opacity: 0.55;
  }
  .l-retired .life {
    opacity: 0.4;
  }
  /* 刻痕：可见的是 1px，点按 / 悬停的范围是 10px */
  .tick {
    position: absolute;
    top: 2px;
    width: 10px;
    height: 12px;
    margin-left: -5px;
  }
  .tick::before {
    content: "";
    position: absolute;
    left: 4.5px;
    top: 1px;
    width: 1px;
    height: 10px;
    background: var(--c);
    opacity: 0.8;
  }
  .end {
    position: absolute;
    top: 2px;
    margin-left: -6px;
    /* 末端字形压在刻痕与线之上：一圈纸色把线让开（重叠标记的 2px 纸色环） */
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--c-paper, var(--surface2));
    background: var(--c-paper, var(--surface2));
  }
  @media (hover: hover) {
    /* 提示朝下出（分组面 overflow:hidden，朝上出第一行会被裁） */
    [data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute;
      top: calc(100% + 4px);
      left: 50%;
      z-index: 2;
      padding: 3px 7px;
      border-radius: var(--r-xs);
      font-family: var(--font-mono);
      font-size: var(--fs-xs);
      line-height: 1.4;
      white-space: nowrap;
      color: var(--bg);
      background: var(--text);
      box-shadow: var(--shadow-1);
      transform: translateX(-50%);
      pointer-events: none;
    }
    /* 末端的提示靠右对齐（它总在最右边附近，居中会出框） */
    .end[data-tip]:hover::after {
      left: auto;
      right: -4px;
      transform: none;
    }
  }
</style>
