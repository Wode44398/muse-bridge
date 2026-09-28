<script lang="ts">
  // 三种交互卡共用的外框。同一张卡按 live 切换两种形态：
  //  · live（停在输入框上方、等你处理）：浮起的面（--surface、圆角 16、悬浮阴影），头 + 可滚动的正文 + 钉住的底栏。
  //    整张卡限高，长内容（长 diff、长计划、几道题）在正文里滚，按钮始终看得见（P11）；被裁的一侧渐隐。
  //    头部：语义图标（--warn = 需要你）+ 标题 + 一行小字（几点前没人处理会怎样）+ 右上角剩余时间的尺寸线。
  //  · 回执（落定 / 历史 / 这一轮已结束）：时间线里安静的一块（--surface2 色阶底，不加阴影）：图标 + 结论 + 谁定的。
  //    回执从时间线的占位行长出来（settleIn），落定时不跳。
  // 代码块的「复制」在卡片根上自带委托（停靠区不在 Feed 里，没有这份就点不动）。
  import type { Snippet } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "../ui/Icon.svelte";
  import Deadline from "./Deadline.svelte";
  import { copyClicks, scrollEdges, settleIn } from "./card-actions.ts";

  let {
    id,
    icon,
    title,
    where = "",
    sub = "",
    live,
    deadlineAt,
    windowMs = 0,
    aside,
    footer,
    children,
  }: {
    id: string;
    icon: IconName;
    title: string;
    where?: string;
    sub?: string;
    live: boolean;
    deadlineAt?: number;
    windowMs?: number;
    aside?: Snippet;
    footer?: Snippet;
    children?: Snippet;
  } = $props();
</script>

{#if live}
  <section class="card live" aria-label={title} use:copyClicks>
    <header class="head">
      <span class="ico"><Icon name={icon} size={17} stroke={1.8} /></span>
      <div class="tt">
        <h3 class="ttl">{title}</h3>
        {#if sub}<p class="sub">{sub}</p>{/if}
      </div>
      {#if deadlineAt}
        <span class="right"><Deadline at={deadlineAt} total={windowMs} /></span>
      {:else if aside}
        <span class="right">{@render aside()}</span>
      {/if}
    </header>
    {#if children}
      <div class="body" use:scrollEdges>
        <div class="flow">{@render children()}</div>
      </div>
    {/if}
    {#if footer}<footer class="foot">{@render footer()}</footer>{/if}
  </section>
{:else}
  <section class="card receipt" aria-label={where ? `${title} · ${where}` : title} use:copyClicks use:settleIn={id}>
    <header class="head">
      <span class="ico"><Icon name={icon} size={15} stroke={1.8} /></span>
      <div class="tt">
        <h3 class="ttl">{title}{#if where}<span class="where"> · {where}</span>{/if}</h3>
        {#if sub}<p class="sub">{sub}</p>{/if}
      </div>
      {#if aside}<span class="right">{@render aside()}</span>{/if}
    </header>
    {#if children}<div class="flow">{@render children()}</div>{/if}
    {#if footer}<div class="rfoot">{@render footer()}</div>{/if}
  </section>
{/if}

<style>
  .card {
    min-width: 0;
    color: var(--text);
    font-size: var(--fs-base);
    line-height: var(--lh-ui);
    text-align: left;
  }

  /* ── 头：图标与右侧件都对齐标题那一行（标题行高 20） ── */
  .head {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    min-width: 0;
  }
  .ico,
  .right {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 20px;
  }
  .ico {
    color: var(--text3);
  }
  .right {
    max-width: 46%;
    min-width: 0;
  }
  .tt {
    flex: 1;
    min-width: 0;
  }
  .ttl {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 20px;
    letter-spacing: 0.01em;
    overflow-wrap: anywhere;
  }
  .sub {
    margin: 1px 0 0;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }

  /* ── 停靠态 ── */
  .live {
    display: flex;
    flex-direction: column;
    max-height: min(52vh, 560px);
    max-height: min(52dvh, 560px);
    border-radius: var(--r-lg);
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-2);
  }
  .live .head {
    flex: none;
    padding: 14px 16px 8px;
  }
  .live .ico {
    color: var(--warn);
  }
  /* 横向只裁不滚：换题时让开的那道题有位移，不能撑出横向滚动 */
  .body {
    flex: 0 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 16px 6px;
  }
  /* 老 WebView 只认带前缀的 mask */
  .body:global(.fade-bottom) {
    -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 22px), transparent);
    mask-image: linear-gradient(to bottom, black calc(100% - 22px), transparent);
  }
  .body:global(.fade-top) {
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 18px);
    mask-image: linear-gradient(to bottom, transparent, black 18px);
  }
  .body:global(.fade-top.fade-bottom) {
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 18px, black calc(100% - 22px), transparent);
    mask-image: linear-gradient(to bottom, transparent, black 18px, black calc(100% - 22px), transparent);
  }
  .flow {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .foot {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 16px 14px;
  }

  /* ── 回执 ── */
  .receipt {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px 14px 12px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface2) 62%, transparent);
  }
  .receipt .ttl {
    font-size: var(--fs-md);
    font-weight: 500;
  }
  .where {
    font-weight: 400;
    color: var(--text3);
  }
  .receipt .flow {
    gap: 8px;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .rfoot {
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }

  @media (max-width: 699px) {
    .live .head {
      padding: 13px 14px 8px;
    }
    .body {
      padding: 2px 14px 6px;
    }
    .foot {
      padding: 8px 14px 12px;
    }
  }
</style>
