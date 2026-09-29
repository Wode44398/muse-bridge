<script lang="ts">
  // 任务列表里的工作流一行 + 就地展开的详情（bridge Claude 分页 WorkflowDetail = 官方 /code 页 RD 的 dimensio 版）。
  //  行：状态 + 标题（在跑 = 微光）+ 用时；第二行「工作流 · 状态 · n 个 agent · tok · n 个来自日志」；
  //      多于一个阶段时下面一条阶段条（每段一个阶段，颜色 = 阶段状态）。
  //  展开：描述 / 错误·停止原因 / 阶段（节点 + 标题 + 完成数 + 点阵 → 再展开四列 agent 表：Agent / 模型 / Tokens / 时长）/
  //        日志（最后 60 行；收着且在跑时只露最新一行）/ 结果。agent 表的名字可点 → 压上那个 agent 的转录。
  // 在跑的工作流默认展开（跑完挪去「已完成」也不收）；从对话里点过来定位到它也会展开。秒级时钟只在跑着时走。
  import { untrack } from "svelte";
  import type { AgentRun, ToolItem } from "../../lib/state.svelte.ts";
  import {
    STATUS_LABEL,
    agentDotState,
    deriveWorkflow,
    fmtTokens,
    modelShort,
    runElapsed,
    toolTaskStatus,
    toolTaskTitle,
    type PhaseView,
  } from "../../lib/tasks.ts";
  import { collapse } from "../../lib/motion.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import AgentDots from "../feed/AgentDots.svelte";
  import TaskLine from "./TaskLine.svelte";
  import type { Glyph } from "./StatusGlyph.svelte";
  import { taskView } from "./tasks-view.svelte.ts";

  let { item, focused = false, onAgent }: { item: ToolItem; focused?: boolean; onAgent?: (run: AgentRun) => void } = $props();

  const wf = $derived(item.workflow ?? null);
  const status = $derived(toolTaskStatus(item));
  const running = $derived(status === "running");
  const title = $derived(toolTaskTitle(item));

  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
  const dotOpts = $derived(running ? { now } : { settled: true });
  const timeText = $derived(runElapsed(wf ?? undefined, running, now));
  const view = $derived(wf ? deriveWorkflow(wf, dotOpts) : null);
  const agentCount = $derived(view?.counts.total || wf?.agentCount || 0);
  const tokens = $derived(wf?.tokens || view?.tokens || 0);
  const reason = $derived(status === "failed" || status === "stopped" ? wf?.error || (!wf ? item.summary : "") || "" : "");
  const resultText = $derived(wf?.result === undefined ? "" : typeof wf.result === "string" ? wf.result : JSON.stringify(wf.result, null, 2));
  // 在跑的 agent 全都久无动静 → 行首给 warn
  const stalled = $derived(running && !!view && view.counts.running > 0 && view.counts.running === view.counts.stalled);
  const glyph = $derived<Glyph>(
    stalled ? "stalled" : running ? "running" : status === "completed" ? "done" : status === "failed" ? "failed" : "stopped",
  );

  // 展没展开记在 taskView.open（按工具行 id）：第一次露面记下默认（在跑 = 展开），之后跑完挪去「已完成」重挂也不收
  const key = $derived(String(item.id));
  const firstDefault = untrack(() => running);
  const open = $derived(taskView.open[key] ?? firstDefault);
  $effect(() => {
    const k = key;
    untrack(() => {
      if (!(k in taskView.open)) taskView.open[k] = firstDefault;
    });
  });
  // 从对话里点过来定位到它：展开
  $effect(() => {
    if (focused) untrack(() => (taskView.open[key] = true));
  });
  function toggle() {
    taskView.open[key] = !open;
  }

  // 阶段展开：默认 = 工作流在跑且该阶段已有 agent（官方 OD）；用户点过就按用户的
  let phaseOpen = $state<Record<number, boolean>>({});
  const isOpen = (p: PhaseView) => (p.index in phaseOpen ? phaseOpen[p.index] : running && p.counts.total > 0);
  let showLogs = $state(false);
  let showResult = $state(false);
  const agentTime = (a: AgentRun) => runElapsed(a, running && a.status === "running", now);
</script>

<TaskLine
  {glyph}
  glyphLabel={stalled ? t("久无动静") : STATUS_LABEL[status]}
  {title}
  {running}
  time={timeText}
  {focused}
  {open}
  onclick={toggle}
>
  {#snippet meta()}
    <span>{t("工作流")}</span>
    {#if !running}<span class:bad={status === "failed"}>{STATUS_LABEL[status]}</span>{/if}
    {#if agentCount}<span><b>{agentCount}</b> {t("个 agent", { n: agentCount })}</span>{/if}
    {#if tokens}<span><b>{fmtTokens(tokens)}</b> tok</span>{/if}
    {#if wf?.cached}<span>{t("{n} 个来自日志", { n: wf.cached })}</span>{/if}
  {/snippet}
  {#snippet below()}
    {#if view && view.phases.length > 1}
      <span class="pbar" aria-hidden="true">
        {#each view.phases as p (p.index)}
          <span
            class="seg"
            class:done={p.status === "done"}
            class:run={p.status === "running"}
            class:bad={p.status === "error"}
            title="{p.title || t('未分组')} {p.counts.done}/{p.counts.total}"
          ></span>
        {/each}
      </span>
    {/if}
  {/snippet}
  {#snippet children()}
    <div class="wd">
      {#if wf?.description && wf.description !== title}<p class="desc">{wf.description}</p>{/if}
      {#if reason}
        <div class="reason" class:bad={status === "failed"}>
          <span class="rh">{status === "failed" ? t("错误") : t("已停止")}</span>
          <span class="rb">{tr(reason)}</span>
        </div>
      {/if}

      {#if view && view.phases.length}
        <div class="phases">
          <span class="cap">{tc("dimensio", "阶段")}</span>
          <ul>
            {#each view.phases as p (p.index)}
              {@const po = isOpen(p)}
              {@const anticipate = running && p.status !== "done"}
              <li class="ph">
                <button class="ph-btn" class:open={po} aria-expanded={po} onclick={() => (phaseOpen[p.index] = !po)}>
                  <span class="ph-row">
                    <span class="node" class:done={p.status === "done"} class:run={p.status === "running"} class:bad={p.status === "error"}></span>
                    <span
                      class="ph-t"
                      class:hx-shimmer={running && p.status === "running" && !p.counts.stalled}
                      class:warn={running && p.counts.stalled > 0}
                      class:bad={p.status === "error"}
                      class:dim={!running || p.status === "pending"}>{p.title || t("未分组")}</span
                    >
                    {#if p.counts.total}<span class="ph-n">{p.counts.done}/{p.counts.total}</span>{/if}
                    <span class="chev" class:down={po}><Icon name="chevronR" size={12} stroke={1.9} /></span>
                  </span>
                  {#if p.detail}<span class="ph-d">{p.detail}</span>{/if}
                  {#if p.counts.total || anticipate}
                    <span class="ph-dots">
                      <AgentDots
                        counts={p.counts}
                        labels={p.agents.map((a) => ({ label: a.label, state: agentDotState(a, dotOpts) }))}
                        cols={16}
                        {anticipate}
                      />
                    </span>
                  {/if}
                </button>
                {#if po}
                  <div class="ph-more" in:collapse out:collapse>
                    {#if !p.agents.length}
                      <p class="ag-empty">{running ? t("这个阶段还没有 agent 启动") : t("这个阶段没有运行 agent")}</p>
                    {:else}
                      <div class="grid" role="table" aria-label={p.title || t("未分组")}>
                        <div class="gr head" role="row">
                          <span role="columnheader">Agent</span>
                          <span role="columnheader">{t("模型")}</span>
                          <span role="columnheader" class="r">Tokens</span>
                          <span role="columnheader" class="r">{t("时长")}</span>
                        </div>
                        {#each p.agents as a (a.id)}
                          {@const st = agentDotState(a, dotOpts)}
                          {@const dim = st === "done" || !running}
                          <div class="gr" role="row">
                            <span role="cell" class="c-name">
                              <button class="ag" class:dim onclick={() => onAgent?.(a as AgentRun)} title={t("查看转录：{name}", { name: a.label })}>
                                <span
                                  class="sq"
                                  class:done={st === "done"}
                                  class:run={st === "running"}
                                  class:warn={st === "stalled"}
                                  class:bad={st === "error"}
                                  class:wait={st === "pending"}
                                ></span>
                                <span class="lbl">{a.label}</span>
                              </button>
                            </span>
                            {#if st === "error"}
                              <span role="cell" class="c-err" title={tr(a.error ?? "")}>{a.error ? t("失败") : t("未完成")}</span>
                            {:else}
                              <span role="cell" class="c" class:dim title={(a as AgentRun).model}
                                >{modelShort((a as AgentRun).model) || ((a as AgentRun).cached ? tc("dimensio", "日志") : "—")}</span
                              >
                              <span role="cell" class="c r num" class:dim>{fmtTokens(a.tokens)}</span>
                              <span role="cell" class="c r num" class:dim>{agentTime(a as AgentRun)}</span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {:else if running}
        <p class="ag-empty">{wf ? t("等待 agent 启动") : t("等待确认，工作流尚未启动")}</p>
      {/if}

      {#if wf && wf.logs.length}
        <div class="logs">
          <button class="tog" aria-expanded={showLogs} onclick={() => (showLogs = !showLogs)}>
            <span class="chev" class:down={showLogs}><Icon name="chevronR" size={12} stroke={1.9} /></span>
            <span>{t("日志 · {n}", { n: wf.logs.length })}</span>
          </button>
          {#if showLogs}
            <div in:collapse out:collapse>
              <div class="loglist">
                {#each wf.logs.slice(-60) as l, i (i)}<div class="log">{l}</div>{/each}
              </div>
            </div>
          {:else if running}
            <div class="log tail">{wf.logs[wf.logs.length - 1]}</div>
          {/if}
        </div>
      {/if}

      {#if resultText}
        <div class="result">
          <button class="tog" aria-expanded={showResult} onclick={() => (showResult = !showResult)}>
            <span class="chev" class:down={showResult}><Icon name="chevronR" size={12} stroke={1.9} /></span>
            <span>{t("结果")}</span>
          </button>
          {#if showResult}
            <div in:collapse out:collapse><div class="rpad"><pre>{resultText}</pre></div></div>
          {/if}
        </div>
      {/if}
    </div>
  {/snippet}
</TaskLine>

<style>
  b {
    font-weight: 500;
    color: var(--text2);
  }
  .bad {
    color: var(--err);
  }

  /* 阶段条：一段一个阶段 */
  .pbar {
    display: flex;
    gap: 3px;
    height: 3px;
    margin: 5px 0 1px 24px;
  }
  .seg {
    flex: 1;
    min-width: 6px;
    border-radius: 2px;
    background: var(--border2);
  }
  .seg.done {
    background: color-mix(in srgb, var(--text) 30%, transparent);
  }
  .seg.run {
    background: var(--live);
    animation: hx-breathe 2s var(--ease-in-out) infinite;
  }
  .seg.bad {
    background: var(--err);
  }

  .wd {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 4px 0 2px 16px;
    min-width: 0;
  }
  .desc {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text2);
    overflow-wrap: anywhere;
  }
  .reason {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 10px 9px;
    border-radius: var(--r-sm);
    background: var(--surface2);
  }
  .reason.bad {
    background: color-mix(in srgb, var(--err) 9%, transparent);
  }
  .rh {
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .reason.bad .rh {
    color: var(--err);
  }
  .rb {
    max-height: 120px;
    overflow-y: auto;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .cap {
    display: block;
    margin: 0 0 4px 2px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .phases ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ph-btn {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 6px 8px 7px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .ph-btn.open {
    background: color-mix(in srgb, var(--text) 3.5%, transparent);
  }
  @media (hover: hover) {
    .ph-btn:hover {
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
  }
  .ph-btn:active {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .ph-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .node {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--border2);
  }
  .node.done {
    background: color-mix(in srgb, var(--text) 30%, transparent);
  }
  .node.run {
    background: var(--live);
    animation: hx-breathe 1.4s var(--ease-in-out) infinite;
  }
  .node.bad {
    background: var(--err);
  }
  /* 颜色由 .ph-btn 继承；只在非微光态上改色（微光自带透明字） */
  .ph-t {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-md);
    font-weight: 500;
    line-height: 18px;
    overflow-wrap: anywhere;
  }
  .ph-t.dim {
    color: var(--text2);
    font-weight: 400;
  }
  .ph-t.warn {
    color: var(--warn);
  }
  .ph-t.bad {
    color: var(--err);
  }
  .ph-n {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .chev {
    flex: none;
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .ph-d {
    padding-left: 15px;
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
    overflow-wrap: anywhere;
  }
  .ph-dots {
    display: block;
    padding-left: 15px;
  }
  .ph-more {
    min-width: 0;
  }

  .ag-empty {
    margin: 0;
    padding: 4px 8px 6px 23px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  /* 四列 agent 表（行用 subgrid 对齐，语义上是真表格） */
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, max-content) 50px minmax(48px, max-content);
    column-gap: 10px;
    row-gap: 2px;
    padding: 6px 8px 8px 23px;
    font-size: var(--fs-sm);
    line-height: 16px;
  }
  /* 行：支持 subgrid 的对齐父网格（语义上是一行）；老内核退回 display: contents（排版照旧，只是行不成盒） */
  .gr {
    display: contents;
  }
  @supports (grid-template-columns: subgrid) {
    .gr {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: subgrid;
      align-items: center;
      min-height: 22px;
    }
  }
  .gr > * {
    align-self: center;
  }
  .gr.head {
    font-size: var(--fs-xs);
    color: var(--text3);
    white-space: nowrap;
  }
  .r {
    text-align: right;
    justify-self: end;
  }
  .c-name {
    min-width: 0;
  }
  .ag {
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    min-width: 0;
    height: 22px;
    border-radius: var(--r-xs);
    text-align: left;
    color: var(--text);
  }
  .ag.dim {
    color: var(--text2);
  }
  .lbl {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-decoration-line: underline;
    text-decoration-color: transparent;
    text-underline-offset: 2px;
    transition: text-decoration-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .ag:hover .lbl {
      color: var(--text);
      text-decoration-color: currentColor;
    }
  }
  .sq {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 1.5px;
    background: var(--border2);
  }
  .sq.done {
    background: color-mix(in srgb, var(--text) 30%, transparent);
  }
  .sq.run {
    background: var(--live);
  }
  .sq.warn {
    background: var(--warn);
  }
  .sq.bad {
    background: var(--err);
  }
  .sq.wait {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border2);
  }
  .c {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text2);
  }
  .c.dim {
    color: var(--text3);
  }
  .c-err {
    grid-column: span 3;
    justify-self: end;
    color: var(--err);
    cursor: default;
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }

  .logs {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tog {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    height: 26px;
    padding: 0 8px 0 4px;
    border-radius: var(--r-xs);
    font-size: var(--fs-sm);
    color: var(--text3);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .tog:hover {
      color: var(--text2);
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .loglist {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 220px;
    overflow-y: auto;
    padding: 2px 0 2px 21px;
  }
  .log {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 16px;
    color: var(--text3);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .log.tail {
    padding-left: 21px;
  }

  .result {
    display: flex;
    flex-direction: column;
  }
  /* collapse 过渡的元素本身不带外边距：间距放在里层的内边距上 */
  .rpad {
    padding: 4px 0 0 21px;
  }
  .result pre {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: 9px 11px;
    border-radius: var(--r-sm);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }

  /* 触屏：阶段行、agent 名字、日志开关放大到能按准 */
  @media (pointer: coarse) {
    .ph-btn {
      min-height: 40px;
      justify-content: center;
    }
    .gr:not(.head) {
      min-height: 36px;
    }
    .ag {
      height: 36px;
    }
    .tog {
      height: 36px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .seg.run,
    .node.run {
      animation: none;
    }
  }
</style>
