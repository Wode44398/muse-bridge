<script lang="ts">
  // 工作流紧凑卡（bridge Claude 分页 WorkflowCard 紧凑态 = 官方 /code 页 TD）：工作流不在工具组里时代替工具行——
  // 标题（工作流名，在做的微光）/「工作流 · n 个 agent · 当前阶段 · 计时」/ agent 点阵（≤8 行，跑着时带幽灵格）。
  // 点开 = 右侧工作区切到「任务」并定位到这条工作流的详细卡（阶段树 / agent 表都在那里）。
  // 跑完也留着卡片（同子 agent 卡；官方跑完收成一行「Ran workflow X」，和别的工具行混在一起认不出来）：停在终态——
  // 状态词（成功是默认，不写）+ 最终点阵 + 用时，失败 / 停止多一行原因。
  // 量线上的节点由 ToolRow 画（卡片第一行的中线）。status 由 ToolRow 给（这一轮停了还挂着 running = 已停止）。
  import { openTaskDetail, type ToolItem } from "../../lib/state.svelte.ts";
  import { EMPTY_COUNTS, STATUS_LABEL, agentDotState, deriveWorkflow, fmtDur, runElapsed, toolTaskTitle, type TaskStatus } from "../../lib/tasks.ts";
  import { toolMeta } from "../../lib/icons.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import AgentDots from "./AgentDots.svelte";
  import { t, tr } from "../../lib/i18n.ts";

  let { item, status = "running" }: { item: ToolItem; status?: TaskStatus } = $props();

  const wf = $derived(item.workflow ?? null);
  const title = $derived(toolTaskTitle(item));
  const running = $derived(status === "running");

  // 秒级时钟只在跑着时走，页面隐藏时冻结
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
  const view = $derived(wf ? deriveWorkflow(wf, dotOpts) : null);
  const counts = $derived(view ? view.counts : EMPTY_COUNTS);
  const total = $derived(counts.total || wf?.agentCount || 0);
  // 点阵顺序 = 阶段顺序里一格一个 agent
  const labels = $derived(
    view ? view.phases.flatMap((p) => p.agents).map((a) => ({ label: a.label, state: agentDotState(a, dotOpts) })) : null,
  );
  // startedAt 是服务端时钟：重连回放晚到的事件不会把计时清零
  const elapsed = $derived(running ? (wf?.startedAt ? fmtDur(Math.max(0, now - wf.startedAt)) : "") : runElapsed(wf ?? undefined, false, now));
  const reason = $derived(status === "failed" || status === "stopped" ? tr(String(wf?.error || (!wf ? item.summary : "") || "")).split(/\r?\n/)[0] : "");
</script>

<button class="card" onclick={() => openTaskDetail(item.id)} aria-label={t("查看工作流：{title}", { title })} use:press={{ scale: 0.985 }}>
  <span class="ic"><Icon name={toolMeta("Workflow").icon} size={15} /></span>
  <span class="col">
    <span class="title" class:hx-shimmer={running} class:dim={!running}>{title}</span>
    <span class="meta">
      <!-- 工作流对象还没到 = 等确认卡 / worker 起步中（官方 Starting workflow） -->
      <span>{wf || !running ? t("工作流") : t("正在启动工作流")}</span>
      {#if !running && status !== "completed"}<span class:bad={status === "failed"}>{STATUS_LABEL[status]}</span>{/if}
      {#if total}<span><b>{total}</b> {t("个 agent", { n: total })}</span>{/if}
      {#if running && wf?.currentPhase}<span class="ph">{wf.currentPhase}</span>{/if}
      {#if elapsed}<span class="num">{elapsed}</span>{/if}
    </span>
    {#if running || counts.total}
      <span class="dots"><AgentDots {counts} {labels} maxRows={8} anticipate={running} /></span>
    {/if}
    {#if reason}<span class="why" class:bad={status === "failed"}>{reason}</span>{/if}
  </span>
  <span class="go"><Icon name="chevronR" size={14} stroke={1.9} /></span>
</button>

<style>
  .card {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    width: 320px;
    max-width: 100%;
    padding: 10px 10px 12px 12px;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .ic,
  .go {
    display: inline-flex;
    align-items: center;
    flex: none;
    height: 20px;
    color: var(--text2);
  }
  .go {
    color: var(--text3);
  }
  .col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 20px;
  }
  .title.dim {
    color: var(--text2);
  }
  .meta {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: var(--fs-sm);
    line-height: 17px;
    color: var(--text3);
  }
  .meta > span {
    flex: none;
  }
  .meta > span + span::before {
    content: "·";
    margin: 0 6px;
    color: var(--text3);
  }
  .meta > .ph {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta b {
    font-weight: 500;
    color: var(--text2);
  }
  .bad {
    color: var(--err);
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .dots {
    display: block;
    padding-top: 7px;
  }
  /* 失败 / 停止的原因：一行，全文在任务面板里 */
  .why {
    padding-top: 5px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-sm);
    line-height: 17px;
    color: var(--text3);
  }
  .why.bad {
    color: var(--err);
  }
  .card:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .card:hover {
      background: var(--surface2);
    }
  }
</style>
