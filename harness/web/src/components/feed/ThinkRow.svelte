<script lang="ts">
  // 思考行：量线上的一行。折叠 = 标签 + 最后一行的预览；展开 = 思考正文（次要字色、小一档、左侧细线）。
  // Feed 直排与 ToolGroup（工具组）共用。在想的时候节点换成权衡中的标志、标签走「在做」的微光。
  //
  // live 是 per-item 真相（settleCursors 在块结束时掐灭），不再叠全局 activity 判断——那会让历史思考行跟着当前活动
  // 全体转圈；再与 pane.chat.running 相与：这一轮停了，还没掐灭的旗子不算在想。
  // 正文流式时新到的字渐入（lib/fade.ts 原地切开、不替换 Svelte 持有的文本节点——旧版展开后正文会冻住，spec-A ⚠2）。
  import { streamFade } from "../../lib/fade.ts";
  import { collapse } from "../../lib/motion.ts";
  import Mark from "../brand/Mark.svelte";
  import RailRow from "./RailRow.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    item,
    compact = false,
    up = false,
    down = false,
  }: { item: { text: string; open: boolean; live: boolean }; compact?: boolean; up?: boolean; down?: boolean } = $props();

  const thinking = $derived(item.live && pane.chat.running);
  // 折叠时的预览：去掉首尾空白后最后一行的末 120 字；截断处挪到下一个标点之后、前面补省略号，不从半句话或标点起头。
  // 精简模式（compact）下想完了就只留「思考过程」四个字，正在想时照旧露最后一行（那就是「此刻在想什么」）
  const peek = $derived.by(() => {
    if (item.open || !item.text || (compact && !thinking)) return "";
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
</script>

<RailRow {up} {down} clear={thinking ? 10 : 7} onclick={() => (item.open = !item.open)} expanded={item.open} chev="down" open={item.open}>
  {#snippet node()}
    {#if thinking}<Mark size={15} live />{:else}<span class="ring"></span>{/if}
  {/snippet}
  {#snippet head()}
    <span class="label" class:quiet={!thinking} class:hx-shimmer={thinking}>{thinking ? t("思考中") : t("思考过程")}</span>
    {#if peek}<span class="peek">{peek}</span>{/if}
  {/snippet}
  {#if item.open}
    <div class="bodywrap" transition:collapse>
      <div class="body" use:streamFade={{ live: item.live }}>{item.text}</div>
    </div>
  {/if}
</RailRow>

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
