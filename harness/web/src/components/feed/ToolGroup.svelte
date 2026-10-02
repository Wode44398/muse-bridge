<script lang="ts">
  // 工具组：时间线上连续的只读探索（含穿插的思考）收成一个组（U8：动作不进组，见 lib/feed-units.ts）。
  // 头行 = 节点 +「查看了 N 处」+ 去重的工具图标带 + 失败数；运行中折叠态只露当前这一步，展开可看全部步骤
  //（每步仍可再展开参数 / 结果）。组内各步接在同一条量线上。
  //
  // compact = 精简模式（默认；设置里「显示全部工作过程」关着）：组收的是所有连续工具调用（见 lib/feed-units.ts），头行对齐
  // bridge Claude 分页（= 官方 /code 页工具分组）——跑着时说此刻在做什么（动词微光 + 参数摘要；思考中就说思考中），
  // 做完说「读取了 3 个文件，执行了 2 条命令」（有失败的片段标红）；折叠态不再露当前这一步，点开才列出全部步骤。
  // 头行换内容有 650ms 防抖（官方同款）：连珠炮的快工具别让头行一直闪。
  import { untrack } from "svelte";
  import type { Item, ToolItem } from "../../lib/state.svelte.ts";
  import { toolMeta, type IconName } from "../../lib/icons.ts";
  import { argPreview, groupSummary, summarySep } from "../../lib/tool-summary.ts";
  import { collapse, rise } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import RailRow from "./RailRow.svelte";
  import ToolNode, { type NodeTone } from "./ToolNode.svelte";
  import ToolRow from "./ToolRow.svelte";
  import ThinkRow from "./ThinkRow.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    items,
    live,
    open,
    ontoggle,
    compact = false,
    up = false,
    down = false,
  }: { items: Item[]; live: boolean; open: boolean; ontoggle: () => void; compact?: boolean; up?: boolean; down?: boolean } = $props();

  const tools = $derived(items.filter((x) => x.kind === "tool") as ToolItem[]);
  const fails = $derived(tools.filter((x) => x.status === "fail" || x.status === "denied").length);
  const icons = $derived.by(() => {
    const seen: IconName[] = [];
    for (const tool of tools) {
      const ic = toolMeta(tool.name).icon;
      if (!seen.includes(ic)) seen.push(ic);
      if (seen.length >= 4) break;
    }
    return seen;
  });
  const tail = $derived(items[items.length - 1]);
  // spec-A ⚠10：组已经不在跑、里面却还有挂着 running 的一步（停下之后、对账之前）——不能画成完成
  const tone = $derived.by((): NodeTone => {
    if (live) return "running";
    if (fails > 0) return "fail";
    if (tools.some((x) => x.status === "running") && !pane.chat.running) return "stopped";
    return "ok";
  });
  const showTail = $derived(!compact && !open && live && Boolean(tail));

  // ── 精简模式的头行 ──
  // 此刻在做的那一步：最后一个还在跑的工具，或正在流的思考；都没有（模型在想下一步）= 汇总句
  const current = $derived.by((): Item | null => {
    if (!compact || !live || !pane.chat.running) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.kind === "tool" && it.status === "running") || (it.kind === "thinking" && it.live)) return it;
    }
    return null;
  });
  const keyOf = (it: Item) => (it.kind === "tool" ? it.id : `think:${items.indexOf(it)}`);
  const curKey = $derived(current ? keyOf(current) : "settled");
  let shownKey = $state(untrack(() => curKey));
  $effect(() => {
    const k = curKey;
    if (k === shownKey) return;
    // 回到汇总（这一组做完了）不等：只有「换一步」才防抖
    if (k === "settled" && !live) {
      shownKey = k;
      return;
    }
    const timer = setTimeout(() => (shownKey = k), 650);
    return () => clearTimeout(timer);
  });
  const shown = $derived(shownKey === "settled" ? null : (items.find((it) => keyOf(it) === shownKey) ?? null));
  const summary = $derived(compact ? groupSummary(tools) : []);

  function toggle() {
    haptic("light");
    ontoggle();
  }
</script>

<div class="grp">
  <RailRow {up} down={open || showTail || down} onclick={toggle} expanded={open} chev="down" {open}>
    {#snippet node()}<ToolNode {tone} />{/snippet}
    {#snippet head()}
      {#if compact}
        {#if shown?.kind === "tool"}
          <span class="label hx-shimmer">{toolMeta(shown.name).verb}</span>
          <span class="arg">{argPreview(shown.args)}</span>
        {:else if shown?.kind === "thinking"}
          <span class="label hx-shimmer">{t("思考中")}</span>
        {:else}
          <span class="sumline">{#each summary as s, i}{#if i > 0}{summarySep()}{/if}<span class:bad={s.bad}>{s.text}</span>{/each}</span>
        {/if}
      {:else}
        <!-- U8（X43）：组只收只读探索（看文件、搜代码、查网页），动作单独成行 -->
        <span class="label" class:hx-shimmer={live}>{live ? t("查看中 · 第 {n} 处", { n: tools.length }) : t("查看了 {n} 处", { n: tools.length })}</span>
        <span class="icons" aria-hidden="true">
          {#each icons as ic (ic)}<span class="gi"><Icon name={ic} size={13} /></span>{/each}
        </span>
        {#if fails > 0}<span class="fails">{t("{n} 失败", { n: fails })}</span>{/if}
      {/if}
    {/snippet}
  </RailRow>

  {#if open}
    <div class="bodywrap" transition:collapse>
      <div class="steps">
        {#each items as it, i (i)}
          <div class="step">
            {#if it.kind === "tool"}
              <ToolRow item={it} inGroup up down={i < items.length - 1 || down} />
            {:else if it.kind === "thinking"}
              <ThinkRow item={it} up down={i < items.length - 1 || down} />
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {:else if showTail && tail}
    <!-- 运行中折叠态：只露当前这一步，历史步骤收进头行（新的一步浮上来） -->
    {#key tail}
      <div class="steps" in:rise={{ y: 4 }}>
        <div class="step">
          {#if tail.kind === "tool"}
            <ToolRow item={tail} inGroup up {down} />
          {:else if tail.kind === "thinking"}
            <ThinkRow item={tail} up {down} />
          {/if}
        </div>
      </div>
    {/key}
  {/if}
</div>

<style>
  /* 字色继承头行（--text2）：不写 color，免得同特异性压掉 .hx-shimmer 的透明字 */
  .label {
    flex: none;
    font-size: var(--fs-base);
    font-weight: 500;
    white-space: nowrap;
  }
  /* 精简模式：跑着时动词后面的参数摘要（同工具行）；做完的汇总句（窄了就省略） */
  .arg {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .sumline {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
    font-weight: 500;
  }
  .bad {
    color: var(--err);
  }
  .icons {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
    color: var(--text3);
  }
  .gi {
    display: inline-flex;
    flex: none;
  }
  .gi + .gi {
    opacity: 0.75;
  }
  .fails {
    flex: none;
    font-size: var(--fs-sm);
    color: var(--err);
    white-space: nowrap;
  }
  /* 组内各步与头行、彼此之间的间距 = 量线的行距（上接线正好跨过它） */
  .steps {
    padding-top: var(--rail-gap);
  }
  .step + .step {
    margin-top: var(--rail-gap);
  }
</style>
