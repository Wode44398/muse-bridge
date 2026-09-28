<script lang="ts">
  // 工作区「任务」：前台会话的子 agent / 工作流 / 后台命令，分「进行中 / 已完成」两节，列表式——一条一行：
  // 状态记号 + 名称 + 用时，第二行是元信息。点开进详情：子 agent → 压上转录视图；工作流 → 就地展开阶段与 agent 表；
  // 后台命令 → 就地展开尾行输出。从对话里的卡片点进来会定位到那一条（滚到中间 + 闪一下，1.7 秒）。
  //
  // 数据源就是前台会话时间线上的 Agent / Workflow 工具行（+ 服务端的 job 表），没有第二份任务表。
  // 定位与转录视图按 id 找条目：断线对账会把时间线条目换成记录重建版，id 不变、对象会变。
  // 「清除」与「已完成」的折叠态放在 tasks-view.svelte.ts，跨重挂保留（以前切个工具就全回来了，§17-5）。
  import { tick, untrack } from "svelte";
  import { taskView as view } from "./tasks-view.svelte.ts";
  import { app, backToTaskList, openTaskAgent, type AgentRun, type ToolItem } from "../../lib/state.svelte.ts";
  import { collectTasks, splitTasks, toolTaskStatus, toolTaskTitle, type TaskEntry } from "../../lib/tasks.ts";
  import { currentJobs, refreshJobs } from "../../lib/jobs.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse, fade, rise } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import Empty from "../ui/Empty.svelte";
  import TaskRow from "./TaskRow.svelte";
  import WorkflowDetail from "./WorkflowDetail.svelte";
  import JobRow from "./JobRow.svelte";
  import AgentTranscript from "./AgentTranscript.svelte";

  const coarse = matchMedia("(pointer: coarse)").matches; // 触屏：顶条按钮放大到 40
  const tasks = $derived(collectTasks(app.chat.timeline));
  const split = $derived(splitTasks(tasks));
  // U11：后台命令在服务端的 job 表里（Dock 按需拉）；打开面板时先拉一次
  const jobList = $derived(currentJobs());
  $effect(() => {
    untrack(() => void refreshJobs());
  });

  const chatKey = $derived(app.chat.id ?? "");
  const hidden = $derived(view.cleared[chatKey] ?? []);
  const running = $derived(split.running);
  const finished = $derived(split.finished.filter((t) => !hidden.includes(t.key)));
  const runningJobs = $derived(jobList.filter((j) => j.state === "running"));
  // 已完成的按结束时刻倒序（同子 agent / 工作流：刚结束的在上）
  const finishedJobs = $derived(
    jobList
      .filter((j) => j.state !== "running" && !hidden.includes(`job:${j.id}`))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
  );
  const nRunning = $derived(running.length + runningJobs.length);
  const nFinished = $derived(finished.length + finishedJobs.length);

  function clearFinished() {
    haptic("light");
    view.cleared[chatKey] = [...hidden, ...finished.map((t) => t.key), ...finishedJobs.map((j) => `job:${j.id}`)];
  }
  function toggleFinished() {
    view.finishedOpen = !view.finishedOpen;
  }

  // —— 压上的子 agent 转录视图（按 id 找；找不到 = 切了会话 / 条目没了 → 退回列表）——
  const av = $derived.by(() => {
    const a = app.tasksAgent;
    if (!a) return null;
    const tool = app.chat.timeline.find((x) => x.kind === "tool" && (x as ToolItem).id === a.toolId) as ToolItem | undefined;
    if (!tool) return null;
    const run = tool.agent?.id === a.agentId ? tool.agent : tool.workflow?.agents.find((r) => r.id === a.agentId);
    if (!run) return null;
    const taskRunning = toolTaskStatus(tool) === "running";
    return { tool, run, inWorkflow: Boolean(tool.workflow), running: taskRunning && run.status === "running" };
  });
  $effect(() => {
    if (app.tasksAgent && !av) backToTaskList();
  });

  // —— 定位（官方 openTasksPaneAtTask）：滚到中间 + 闪一下 ——
  // 只依赖 focus 本身与「是否压着转录」：任务表每个 agent 事件都会重算，读它要 untrack，否则每来一帧都重滚重闪。
  let listEl: HTMLElement | undefined = $state();
  let flashKey = $state("");
  $effect(() => {
    const f = app.tasksFocus;
    if (!f || app.tasksAgent) return;
    void f.seq;
    const key = f.toolId;
    const known = untrack(() => tasks.some((t) => t.key === key));
    if (!known) return;
    untrack(() => {
      if (hidden.includes(key)) view.cleared[chatKey] = hidden.filter((k) => k !== key);
      if (split.finished.some((t) => t.key === key)) view.finishedOpen = true;
    });
    flashKey = key;
    tick().then(() => {
      const el = listEl?.querySelector(`[data-task-key="${CSS.escape(key)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const t = setTimeout(() => (flashKey = ""), 1700);
    return () => clearTimeout(t);
  });
</script>

{#snippet task(t: TaskEntry)}
  <div class="item" data-task-key={t.key} in:rise={{ y: 6 }}>
    {#if t.kind === "workflow"}
      <WorkflowDetail item={t.tool} focused={flashKey === t.key} onAgent={(r: AgentRun) => openTaskAgent(t.key, r.id)} />
    {:else}
      <TaskRow item={t.tool} focused={flashKey === t.key} onTranscript={t.tool.agent ? () => openTaskAgent(t.key, t.tool.agent.id) : undefined} />
    {/if}
  </div>
{/snippet}

<div class="tp">
  {#if av}
    <div class="bar back">
      <IconButton icon="arrowL" label="返回任务列表" size={coarse ? 40 : 32} onclick={backToTaskList} />
      <span class="title" title={av.run.label}>{av.run.label || toolTaskTitle(av.tool)}</span>
      <span class="tag">{av.inWorkflow ? "工作流 agent" : "子 agent"}</span>
    </div>
    {#key av.run.id}
      <div class="scroll tr" in:fade|global={{ duration: 180 }}>
        <AgentTranscript run={av.run} tool={av.tool} running={av.running} />
      </div>
    {/key}
  {:else if tasks.length || jobList.length}
    <div class="bar">
      <span class="count">{nRunning} 进行中 · {nFinished} 已完成</span>
    </div>
  {/if}

  <!-- 列表常驻（压着转录时只是藏起来）：退回列表时滚动位置还在 -->
  <div class="scroll list" class:away={!!av} bind:this={listEl}>
    {#if !nRunning && !nFinished}
      <div class="empty">
        <Empty icon="tasks" title={tasks.length || jobList.length ? "已完成的任务都清除了" : "子 agent、工作流与后台命令的进度会显示在这里"} />
      </div>
    {:else}
      {#if nRunning}
        <section class="sec">
          <div class="sech">
            <span class="sec-t">进行中</span>
            <span class="n">{nRunning}</span>
          </div>
          <div class="rows">
            {#each running as t (t.key)}{@render task(t)}{/each}
            {#each runningJobs as j (j.id)}<div class="item" in:rise={{ y: 6 }}><JobRow job={j} /></div>{/each}
          </div>
        </section>
      {/if}
      {#if nFinished}
        <section class="sec">
          <div class="sech">
            <button class="fold" aria-expanded={view.finishedOpen} onclick={toggleFinished}>
              <span class="sec-t">已完成</span>
              <span class="n">{nFinished}</span>
              <span class="chev" class:shut={!view.finishedOpen}><Icon name="chevronD" size={13} stroke={1.8} /></span>
            </button>
            <Button variant="ghost" size="sm" onclick={clearFinished}>清除</Button>
          </div>
          {#if view.finishedOpen}
            <div class="fold-body" in:collapse out:collapse>
              <div class="rows">
                {#each finished as t (t.key)}{@render task(t)}{/each}
                {#each finishedJobs as j (j.id)}<div class="item" in:rise={{ y: 6 }}><JobRow job={j} /></div>{/each}
              </div>
            </div>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
</div>

<style>
  .tp {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 calc(14px + var(--hx-pane-r, 0px)) 0 14px;
    min-width: 0;
  }
  .bar.back {
    padding-left: 6px;
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-base);
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tag {
    flex: none;
    padding: 2px 9px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    font-size: var(--fs-xs);
    color: var(--text2);
  }
  .count {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 4px 8px 28px;
  }
  .list.away {
    display: none;
  }
  .tr {
    padding: 8px 16px 28px;
  }
  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .empty > :global(*) {
    max-width: 340px;
  }

  .sec {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sech {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 0 0 8px;
  }
  .sec-t {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text2);
  }
  .n {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .fold {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    margin-left: -6px;
    padding: 0 6px;
    border-radius: var(--r-sm);
    margin-right: auto;
    transition: background-color var(--t-fast) var(--ease);
  }
  .chev {
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  @media (hover: hover) {
    .fold:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .fold:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
