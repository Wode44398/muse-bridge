<script lang="ts">
  // 思考行。在想的时候标签按已想时长分档（「思考中…」→ 15 秒「仍在思考…」→ 30 秒「深入思考中…」…，官方 /code 页同款）、
  // 走「在做」的微光，后面露最后一行（此刻在想什么）；想完收成「已思考 N 秒」（量不到时长——历史重建、整轮重放——
  // 就是「思考过程」）。点开 = 思考正文（次要字色、左侧细线）。Feed 直排与 ToolGroup（工具组）共用。
  //
  // compact = 精简模式（默认）：不上量线，纯文字折叠头（同工具行）；正文首次展开后保持挂载只切显隐。
  // 「显示全部工作过程」打开时仍在量线上：在想时节点换成权衡中的标志。
  //
  // live 是 per-item 真相（settleCursors 在块结束时掐灭），不再叠全局 activity 判断——那会让历史思考行跟着当前活动
  // 全体转圈；再与 pane.chat.running 相与：这一轮停了，还没掐灭的旗子不算在想。
  // 正文流式时新到的字渐入（lib/fade.ts 原地切开、不替换 Svelte 持有的文本节点——旧版展开后正文会冻住，spec-A ⚠2）。
  import { untrack } from "svelte";
  import { streamFade } from "../../lib/fade.ts";
  import { collapse } from "../../lib/motion.ts";
  import { morphText, reveal } from "../../lib/morph-text.ts";
  import { thinkingLabel, thoughtLabel } from "../../lib/tool-summary.ts";
  import { liveClock } from "../../lib/live-clock.ts";
  import Mark from "../brand/Mark.svelte";
  import RailRow from "./RailRow.svelte";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    item,
    compact = false,
    up = false,
    down = false,
  }: { item: { text: string; open: boolean; live: boolean }; compact?: boolean; up?: boolean; down?: boolean } = $props();

  const thinking = $derived(item.live && pane.chat.running);
  // 在想的时候每秒走一下，分档文案按它换
  let now = $state(Date.now());
  $effect(() => {
    if (!thinking) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  // 时刻在 lib/live-clock.ts（不在条目上，也不响应）：读的时候带上 item.live——思考块结束时先记用时再掐灭 live，这里跟着重算
  const clock = $derived.by(() => {
    void item.live;
    return liveClock(item);
  });
  const label = $derived(thinking ? thinkingLabel(clock ? now - clock.t0 : 0) : thoughtLabel(clock?.ms));
  // 折叠时的预览（只在想的时候露）：去掉首尾空白后最后一行的末 120 字；截断处挪到下一个标点之后、前面补省略号，
  // 不从半句话或标点起头
  const peek = $derived.by(() => {
    if (item.open || !item.text || !thinking) return "";
    const body = item.text.trim();
    let s = body.slice(body.lastIndexOf("\n") + 1);
    if (s.length > 120) {
      s = s.slice(-120);
      const cut = s.search(/[。！？；，、.!?;,]/);
      if (cut >= 0 && cut < 40) s = s.slice(cut + 1);
      s = "…" + s.trimStart();
    }
    return s;
  });

  let mounted = $state(untrack(() => item.open));
  $effect(() => {
    if (item.open) mounted = true;
  });
</script>

{#if compact}
  <RailRow bare onclick={() => (item.open = !item.open)} expanded={item.open} chev="right" open={item.open}>
    {#snippet head()}
      <span class="blabel" class:hx-shimmer={thinking} use:morphText={label}>{label}</span>
      {#if peek}<span class="peek">{peek}</span>{/if}
    {/snippet}
    {#if mounted}
      <div class="bbody" hidden={!item.open} use:reveal={item.open}>
        <div class="body sel-text" use:streamFade={{ live: item.live }}>{item.text}</div>
      </div>
    {/if}
  </RailRow>
{:else}
  <RailRow {up} {down} clear={thinking ? 10 : 7} onclick={() => (item.open = !item.open)} expanded={item.open} chev="down" open={item.open}>
    {#snippet node()}
      {#if thinking}<Mark size={15} live />{:else}<span class="ring"></span>{/if}
    {/snippet}
    {#snippet head()}
      <span class="label" class:quiet={!thinking} class:hx-shimmer={thinking}>{label}</span>
      {#if peek}<span class="peek">{peek}</span>{/if}
    {/snippet}
    {#if item.open}
      <div class="bodywrap" transition:collapse>
        <div class="body sel-text" use:streamFade={{ live: item.live }}>{item.text}</div>
      </div>
    {/if}
  </RailRow>
{/if}

<style>
  .ring {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--border2);
  }
  /* 在想时不写 color（同特异性会压掉 .hx-shimmer 的透明字） */
  .label {
    flex: none;
    font-size: var(--fs-md);
    font-weight: 500;
  }
  .label.quiet {
    color: var(--text3);
  }
  .blabel {
    flex: none;
    white-space: nowrap;
  }
  .peek {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    color: var(--text3);
    opacity: 0.8;
  }
  .bodywrap {
    padding: 2px 0 8px;
  }
  .bbody {
    padding: 2px 0 8px;
  }
  .bbody[hidden] {
    display: none;
  }
  /* pre-wrap 只挂在正文节点上 */
  .body {
    padding: 2px 0 2px 12px;
    border-left: 2px solid var(--border);
    font-size: var(--fs-base);
    line-height: 1.68;
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
</style>
