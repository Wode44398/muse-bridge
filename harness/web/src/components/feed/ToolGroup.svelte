<script lang="ts">
  // 工具组：时间线上连续的只读探索（含穿插的思考）收成一个组（U8：动作不进组，见 lib/feed-units.ts）。
  // 头行 = 节点 +「查看了 N 处」+ 去重的工具图标带 + 失败数；运行中折叠态只露当前这一步，展开可看全部步骤
  //（每步仍可再展开参数 / 结果）。组内各步接在同一条量线上。
  import type { Item, ToolItem } from "../../lib/state.svelte.ts";
  import { toolMeta, type IconName } from "../../lib/icons.ts";
  import { collapse, rise } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import RailRow from "./RailRow.svelte";
  import ToolNode, { type NodeTone } from "./ToolNode.svelte";
  import ToolRow from "./ToolRow.svelte";
  import ThinkRow from "./ThinkRow.svelte";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    items,
    live,
    open,
    ontoggle,
    up = false,
    down = false,
  }: { items: Item[]; live: boolean; open: boolean; ontoggle: () => void; up?: boolean; down?: boolean } = $props();

  const tools = $derived(items.filter((x) => x.kind === "tool") as ToolItem[]);
  const fails = $derived(tools.filter((t) => t.status === "fail" || t.status === "denied").length);
  const icons = $derived.by(() => {
    const seen: IconName[] = [];
    for (const t of tools) {
      const ic = toolMeta(t.name).icon;
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
    if (tools.some((t) => t.status === "running") && !pane.chat.running) return "stopped";
    return "ok";
  });
  const showTail = $derived(!open && live && Boolean(tail));

  function toggle() {
    haptic("light");
    ontoggle();
  }
</script>

<div class="grp">
  <RailRow {up} down={open || showTail || down} onclick={toggle} expanded={open} chev="down" {open}>
    {#snippet node()}<ToolNode {tone} />{/snippet}
    {#snippet head()}
      <!-- U8（X43）：组只收只读探索（看文件、搜代码、查网页），动作单独成行 -->
      <span class="label" class:hx-shimmer={live}>{live ? `查看中 · 第 ${tools.length} 处` : `查看了 ${tools.length} 处`}</span>
      <span class="icons" aria-hidden="true">
        {#each icons as ic (ic)}<span class="gi"><Icon name={ic} size={13} /></span>{/each}
      </span>
      {#if fails > 0}<span class="fails">{fails} 失败</span>{/if}
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
