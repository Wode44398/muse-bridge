<script lang="ts">
  // 任务列表里的子 agent 一行：状态 + 标题（在跑 = 微光）+ 用时；第二行「子 agent · 档位 · 状态 · 模型 · tok · 工具调用」；
  // 在跑时第三行是此刻那一步（与对话流里子 agent 卡上的同一行：AgentAct）。
  // 点开 = 压上它的面板（概览、提示词、过程、结果都在那里）；时间线上没有 run 记录的老条目开不了面板，
  // 就地展开 prompt / 输出（老会话 meta 里没存 prompt，回落工具参数）。工作流走 WorkflowDetail。
  import { app, type ToolItem } from "../../lib/state.svelte.ts";
  import { STATUS_LABEL, agentDotState, agentView, fmtTokens, modelShort, runElapsed, toolTaskStatus, toolTaskTitle } from "../../lib/tasks.ts";
  import AgentAct from "../feed/AgentAct.svelte";
  import { t, tr } from "../../lib/i18n.ts";
  import TaskLine from "./TaskLine.svelte";
  import type { Glyph } from "./StatusGlyph.svelte";

  let { item, focused = false, onTranscript }: { item: ToolItem; focused?: boolean; onTranscript?: () => void } = $props();

  const run = $derived(item.agent ?? null);
  const status = $derived(toolTaskStatus(item));
  const running = $derived(status === "running");
  const title = $derived(toolTaskTitle(item));

  // 秒级时钟：只在跑着、页面可见时走
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
  const timeText = $derived(runElapsed(run ?? undefined, running, now));
  const model = $derived(modelShort(run?.model));
  const calls = $derived(run ? (run.toolCalls ?? run.steps.length) : 0);
  const view = $derived(agentView(item, { now, chatRunning: app.chat.running }));
  const stalled = $derived(running && run ? agentDotState(run, { now }) === "stalled" : false);
  const glyph = $derived<Glyph>(
    stalled ? "stalled" : running ? "running" : status === "completed" ? "done" : status === "failed" ? "failed" : "stopped",
  );

  // 没有 run 记录时的就地展开
  const prompt = $derived(run?.prompt || (typeof item.args?.prompt === "string" ? item.args.prompt : ""));
  const output = $derived.by(() => {
    if (!run) return status === "failed" ? tr(item.summary ?? "") : "";
    if (run.error && status !== "completed") return tr(run.error);
    if (run.result !== undefined) return JSON.stringify(run.result, null, 2);
    return run.text;
  });
  const outputIsError = $derived(Boolean(run?.error) && status !== "completed");
  const drill = $derived(Boolean(onTranscript));
  const expandable = $derived(!drill && Boolean(prompt || output));
  let open = $state(false);

  function activate() {
    if (onTranscript) onTranscript();
    else if (expandable) open = !open;
  }
</script>

<TaskLine
  {glyph}
  glyphLabel={stalled ? t("久无动静") : STATUS_LABEL[status]}
  {title}
  {running}
  time={timeText}
  {focused}
  {drill}
  open={expandable ? open : undefined}
  hint={drill ? t("查看子 agent：{title}", { title }) : undefined}
  onclick={activate}
>
  {#snippet meta()}
    <span>{t("子 agent")}</span>
    {#if run?.tier}<span class="tier" class:coder={run.tier === "coder"}>{run.tier}</span>{/if}
    {#if !running}<span class:bad={status === "failed"}>{STATUS_LABEL[status]}</span>{/if}
    {#if model}<span class="t2" title={run?.model}>{model}</span>{/if}
    {#if run?.tokens}<span><b>{fmtTokens(run.tokens)}</b> tok</span>{/if}
    {#if calls}<span><b>{calls}</b> {t("次工具调用", { n: calls })}</span>{/if}
  {/snippet}
  {#snippet below()}
    {#if running && run}<span class="now"><AgentAct {view} /></span>{/if}
  {/snippet}
  {#snippet children()}
    <div class="body">
      {#if prompt}<pre class="pre">{prompt}</pre>{/if}
      {#if output}
        <div class="out" class:bad={outputIsError}>{output}</div>
      {:else if running}
        <div class="note">{t("还没有输出")}</div>
      {/if}
    </div>
  {/snippet}
</TaskLine>

<style>
  b {
    font-weight: 500;
    color: var(--text2);
  }
  .t2 {
    color: var(--text2);
  }
  .tier {
    padding: 0 6px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 16px;
    color: var(--text2);
  }
  .tier.coder {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .bad {
    color: var(--err);
  }
  /* 此刻那一步：对齐到标题（状态记号 14 + 间距 10） */
  .now {
    display: block;
    min-width: 0;
    padding-left: 24px;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-left: 22px;
    user-select: text;
  }
  .pre {
    margin: 0;
    max-height: 200px;
    overflow: auto;
    padding: 9px 11px;
    border-radius: var(--r-sm);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .out {
    max-height: 240px;
    overflow: auto;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .out.bad {
    color: var(--err);
  }
  .note {
    font-size: var(--fs-md);
    color: var(--text3);
  }
</style>
