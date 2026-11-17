<script lang="ts">
  // 工具组：时间线上连续的一段工具调用（含穿插的思考）收成一个组（分组规则在 lib/feed-units.ts）。
  //
  // compact = 精简模式（默认；设置里「显示全部工作过程」关着）：对齐 bridge Claude 分页（= 官方 /code 页工具分组）——
  //   · 同一文件连续的读写并成一行（groupEntries）；并完只剩 1 个 run 就不套组头，直接摆那一行（夹着的思考照常一行）；
  //   · 组头是纯文字折叠头：跑着时说此刻在跑的那一步（进行时动词微光 + 目标），没有工具在跑（模型在想下一步）或做完了
  //     就是汇总句「读取了 3 个文件，执行了 2 条命令」（有失败的片段标红）；换内容 650ms 防抖（官方同款），换的那一下
  //     新文字浮上来（morphText）；组在跑满 2 秒行尾走秒；
  //   · 展开 = 一圈细线圆角卡、各步之间细线分隔；首次展开后保持挂载只切显隐（每步自己的展开态收起再开还在）。
  //   「此刻在想」不在组头说：底部活动行说（同屏同一件事只说一次）。
  //
  // 「显示全部工作过程」打开时是原来的量线样子：组只收只读探索，头行 = 节点 +「查看了 N 处」+ 去重的工具图标带 + 失败数；
  // 运行中折叠态只露当前这一步，展开可看全部步骤（每步仍可再展开参数 / 结果），组内各步接在同一条量线上。
  import { untrack } from "svelte";
  import type { Item, ToolItem } from "../../lib/state.svelte.ts";
  import { toolMeta, type IconName } from "../../lib/icons.ts";
  import { groupEntries } from "../../lib/feed-units.ts";
  import { groupSummary, summarySep, toolLine } from "../../lib/tool-summary.ts";
  import { elapsedLabel } from "../../lib/timeline-reducer.ts";
  import { liveClock } from "../../lib/live-clock.ts";
  import { collapse, rise } from "../../lib/motion.ts";
  import { morphText, reveal } from "../../lib/morph-text.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import RailRow from "./RailRow.svelte";
  import ToolNode, { type NodeTone } from "./ToolNode.svelte";
  import ToolRow from "./ToolRow.svelte";
  import ThinkRow from "./ThinkRow.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

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

  // ── 精简模式 ──
  const entries = $derived(compact ? groupEntries(items) : []);
  const runCount = $derived(entries.filter((e) => e.run).length);
  // 此刻在跑的那一步：最后一个还在跑的工具（主线程串行，最新的最贴切）；没有 = 汇总句
  const current = $derived.by((): ToolItem | null => {
    if (!compact || !live || !pane.chat.running) return null;
    for (let i = tools.length - 1; i >= 0; i--) if (tools[i].status === "running") return tools[i];
    return null;
  });
  const curKey = $derived(current ? current.id : "settled");
  let shownKey = $state(untrack(() => curKey));
  $effect(() => {
    const k = curKey;
    if (k === shownKey) return;
    // 这一轮停了：立刻落定
    if (!pane.chat.running) {
      shownKey = k;
      return;
    }
    const timer = setTimeout(() => (shownKey = k), 650);
    return () => clearTimeout(timer);
  });
  const shown = $derived(shownKey === "settled" ? null : (tools.find((x) => x.id === shownKey) ?? null));
  const shownLine = $derived(shown ? toolLine(shown.name, shown.args, tr(toolMeta(shown.name).verb)) : null);
  const summary = $derived(compact ? groupSummary(tools) : []);

  // 行尾走秒：从组里第一步开跑算起，组在跑满 2 秒才出现
  const t0 = $derived(
    tools.reduce((v, x) => {
      const s = liveClock(x)?.t0 ?? 0;
      return s && (!v || s < v) ? s : v;
    }, 0),
  );
  let now = $state(Date.now());
  $effect(() => {
    if (!compact || !live || !pane.chat.running || !t0) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const runMs = $derived(compact && live && pane.chat.running && t0 ? Math.max(0, now - t0) : 0);

  // 首次展开后保持挂载、只切显隐
  let mounted = $state(untrack(() => open));
  $effect(() => {
    if (open) mounted = true;
  });

  function toggle() {
    haptic("light");
    ontoggle();
  }
</script>

{#if compact && runCount <= 1}
  <!-- 只有一个 run：不套组头（夹着的思考照常一行） -->
  <div class="flat">
    {#each entries as e (e.key)}
      {#if e.run}
        <ToolRow item={e.tools[0]} run={e.tools} compact />
      {:else if e.item.kind === "thinking"}
        <ThinkRow item={e.item} compact />
      {/if}
    {/each}
  </div>
{:else if compact}
  <div class="grp">
    <RailRow bare onclick={toggle} expanded={open} chev="right" {open}>
      {#snippet head()}
        <span class="lbl" use:morphText={shownKey}>
          {#if shown && shownLine}
            <span class="now hx-shimmer">{shownLine.running}</span>
            {#if shownLine.meta}<span class="nmeta" class:mono={shownLine.mono}>{shownLine.meta}</span>{/if}
          {:else}
            <span class="sumline">{#each summary as s, i}{#if i > 0}{summarySep()}{/if}<span class:bad={s.bad}>{s.text}</span>{/each}</span>
          {/if}
        </span>
        {#if live && pane.chat.running}<span class="hx-sr">{t("（{code}）", { code: t("运行中") })}</span>{/if}
      {/snippet}
      {#snippet trail()}{#if runMs >= 2000}<span>{elapsedLabel(runMs)}</span>{/if}{/snippet}
    </RailRow>
    {#if mounted}
      <div class="gcard" hidden={!open} use:reveal={open}>
        {#each entries as e (e.key)}
          <div class="gitem">
            {#if e.run}
              <ToolRow item={e.tools[0]} run={e.tools} compact inGroup />
            {:else if e.item.kind === "thinking"}
              <ThinkRow item={e.item} compact />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <div class="grp">
    <RailRow {up} down={open || showTail || down} onclick={toggle} expanded={open} chev="down" {open}>
      {#snippet node()}<ToolNode {tone} />{/snippet}
      {#snippet head()}
        <!-- U8（X43）：组只收只读探索（看文件、搜代码、查网页），动作单独成行 -->
        <span class="label" class:hx-shimmer={live}>{live ? t("查看中 · 第 {n} 处", { n: tools.length }) : t("查看了 {n} 处", { n: tools.length })}</span>
        <span class="icons" aria-hidden="true">
          {#each icons as ic (ic)}<span class="gi"><Icon name={ic} size={13} /></span>{/each}
        </span>
        {#if fails > 0}<span class="fails">{t("{n} 失败", { n: fails })}</span>{/if}
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
{/if}

<style>
  /* ── 精简模式 ── */
  .flat {
    display: flow-root;
  }
  .lbl {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  /* 字色继承头行（--text2，悬停提亮）：不写 color，免得压掉 .hx-shimmer 的透明字 */
  .now {
    flex: none;
    white-space: nowrap;
  }
  .nmeta,
  .sumline {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nmeta.mono {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    color: var(--text);
  }
  .bad {
    color: var(--err);
  }
  /* 展开卡：一圈细线、圆角、各步之间细线分隔；卡里的行矮一档（卡本身给了内边距） */
  .gcard {
    --row-h: 24px;
    display: flex;
    flex-direction: column;
    margin: 4px 0 6px;
    border-radius: var(--r-sm);
    box-shadow: 0 0 0 1px var(--border);
    overflow: hidden;
    overflow: clip;
  }
  .gcard[hidden] {
    display: none;
  }
  .gitem {
    min-width: 0;
    padding: 6px 12px;
  }
  .gitem + .gitem {
    border-top: 1px solid var(--border);
  }
  @media (pointer: coarse) {
    .gcard {
      --row-h: 30px;
    }
  }

  /* ── 显示全部工作过程（量线） ── */
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
