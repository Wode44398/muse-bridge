<script lang="ts">
  // 任务列表的一行（子 agent / 工作流 / 后台命令共用的骨架）：
  //   第一行 = 状态记号 + 名称（在做 = 微光）+ 用时（等宽）+ 箭头；第二行 = 元信息（调用方的片段）。
  //   drill = 点开进另一个视图（子 agent 的转录），箭头朝右不转；open ≠ undefined = 就地展开（箭头转下）。
  //   aside = 行尾的独立动作（后台命令的「停止」）——不能套在行按钮里，叠放在第二行右端。
  //   focused = 从对话里点过来的定位：描边 + 淡青底闪一下（只动透明度），1.7 秒后由列表撤掉。
  import type { Snippet } from "svelte";
  import { collapse } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import StatusGlyph, { type Glyph } from "./StatusGlyph.svelte";

  let {
    glyph,
    glyphLabel,
    title,
    mono = false,
    running = false,
    time = "",
    focused = false,
    open = undefined,
    drill = false,
    hint,
    onclick,
    meta,
    below,
    aside,
    children,
  }: {
    glyph: Glyph;
    glyphLabel: string;
    title: string;
    mono?: boolean;
    running?: boolean;
    time?: string;
    focused?: boolean;
    open?: boolean;
    drill?: boolean;
    hint?: string;
    onclick?: () => void;
    meta?: Snippet;
    below?: Snippet;
    aside?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<div class="line" class:focused class:open={open === true}>
  <button class="main" class:has-aside={!!aside} aria-expanded={open} title={hint} onclick={() => onclick?.()}>
    <span class="l1">
      <StatusGlyph kind={glyph} label={glyphLabel} />
      <span class="title" class:mono class:hx-shimmer={running} title={title}>{title}</span>
      {#if time}<span class="time">{time}</span>{/if}
      {#if drill || open !== undefined}
        <span class="chev" class:down={open === true}><Icon name="chevronR" size={14} stroke={1.8} /></span>
      {/if}
    </span>
    {#if meta}<span class="l2">{@render meta()}</span>{/if}
    {#if below}{@render below()}{/if}
  </button>
  {#if aside}<div class="aside">{@render aside()}</div>{/if}
  {#if open && children}
    <div class="more" in:collapse out:collapse>
      <div class="more-in">{@render children()}</div>
    </div>
  {/if}
</div>

<style>
  .line {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    border-radius: var(--r-md);
    transition: background-color var(--t-med) var(--ease);
  }
  .line.open {
    background: color-mix(in srgb, var(--text) 3%, transparent);
  }
  /* 定位闪一下：一层描边 + 淡青底，只动透明度 */
  .line::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    opacity: 0;
    pointer-events: none;
  }
  .line.focused::after {
    animation: tl-flash 1.7s var(--ease-out);
  }
  @keyframes tl-flash {
    0%,
    30% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  .main {
    grid-area: 1 / 1 / 2 / 3;
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    min-width: 0;
    padding: 9px 10px 9px 8px;
    border-radius: var(--r-md);
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .main:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .main:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .l1 {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  /* 颜色继承自 .main：同一元素上再写 color 会和全局 .hx-shimmer 的透明字抢优先级 */
  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 20px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 命令：等宽、最多两行 */
  .title.mono {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    font-weight: 400;
    white-space: normal;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .time {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .chev {
    flex: none;
    display: inline-flex;
    margin-right: -2px;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .l2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 8px;
    row-gap: 1px;
    min-width: 0;
    padding-left: 24px;
    font-size: var(--fs-sm);
    line-height: 17px;
    color: var(--text3);
  }
  /* 给叠在右端的动作让位（最宽是「确认停止」） */
  .main.has-aside .l2 {
    padding-right: 84px;
  }
  /* 英文的上膛态「Tap again to stop」更长 */
  .main.has-aside .l2:lang(en) {
    padding-right: 128px;
  }
  .aside {
    grid-area: 1 / 2 / 2 / 3;
    align-self: end;
    margin: 0 10px 6px 0;
    z-index: 1;
  }
  .more {
    grid-area: 2 / 1 / 3 / 3;
    min-width: 0;
  }
  .more-in {
    padding: 2px 10px 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .line.focused::after {
      animation: none;
      opacity: 1;
    }
  }
</style>
