<script>
  // 官方 /code 页 Workflow 工具卡（c360a9e1c zD / ID / TD，规格 workflow-panel.md §3.1–§3.2、
  // §3.7–§3.8）：
  //   · 不在分组 → 318px 紧凑卡：标题（工作流名，跑时流光）/ 副行「Starting workflow | Workflow
  //     · [Completed|Failed|Stopped] · {n} agents · 时长」/ 6px agent 点阵（≤8 行，跑时带幽灵格）；
  //     秒级计时只在跑时走；点击 onOpen(tool)（右侧「任务」里带 Phases 的详细卡）。
  //     官方只在 running 时出卡、结束收成一行——bridge 偏离，跑完也留卡（见 compact 注释）。
  //   · 分组内 → 一行「Running workflow」(流光)/「Ran workflow」+ 名称 + 尾巴
  //     Stopped / Failed（title = 失败原因；触屏没有 hover，原因直接内联）。官方这一行不可点，
  //     bridge 让它也 onOpen（结束后的 Phases / agent 表在 TaskSheet 里才看得到），并补右侧
  //     CaretRight 作可点提示——与 Agent 行完成态一致。
  // 配色铁律：点阵 running 格用 var(--text)（AgentDots 内已改），不用官方 accent 蓝。
  import { openTaskDetail } from '../../lib/dock.svelte.js';
  import { deriveWorkflow, agentDotStates, workflowNameFromInput, reasonFromSummary, taskRunning, settleProgress, EMPTY_COUNTS } from '../../lib/taskModel.js';
  import { fmtDurPanel, morphText } from '../../lib/toolVerbs.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import AgentDots from './AgentDots.svelte';

  let { tool, inGroup = false, live = false, onOpen = undefined } = $props();
  // 点开 = 官方 openTasksPaneAtTask：右侧工作台切到「任务」视图并定位到这条工作流的详细卡
  function open() { if (onOpen) onOpen(tool); else openTaskDetail(tool); }
  function onKey(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }

  const task = $derived(tool.task || null);
  // 标题：task.name（task_started.workflow_name / tool_args 的 input.name / 脚本 meta）→ 再从 input 抠一次
  const name = $derived((task && (task.name || task.workflowName)) || workflowNameFromInput(tool.input) || '');
  // 未起飞（官方 m）：工具在跑、任务记录还没到 → "Starting workflow"
  const pre = $derived(!!live && !task && tool.status === 'running');
  const status = $derived.by(() => {
    if (task) return task.status;
    if (tool.status === 'error') return 'failed';
    return tool.status === 'running' ? 'running' : 'completed';
  });
  const running = $derived(!!live && (pre || taskRunning(status)));
  const stopped = $derived(status === 'stopped');
  const failed = $derived(status === 'failed');
  const reason = $derived((failed || stopped) ? (reasonFromSummary(task ? task.summary : '', task ? task.description : '') || '') : '');
  // bridge 偏离（实测后定）：官方跑完即收成一行「Ran workflow X」，和「Ran 5 commands」混在一起
  // 认不出来；这里不在分组里就一律是卡片——跑完后停在终态（状态字 + 最终点阵 + 时长），
  // 只有被并进工具分组时才退回单行。
  const compact = $derived(!inGroup);

  // 秒级时钟：只在卡片还在跑时走（官方 cD(true)：页面可见时按秒 tick，隐藏时冻结）
  let now = $state(Date.now());
  $effect(() => {
    if (!compact || !running) return;
    now = Date.now();
    const id = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  // 进度树（官方 hD）→ 计数 / 点阵；agents 按 phase 顺序一格一个。跑完后先按任务终态收尾
  //（还标着 progress 的 agent 记成失败，官方 _t），点阵停在最终状态。
  const progress = $derived(task ? (running ? task.progress : settleProgress(task.progress, status)) : []);
  const wf = $derived(compact ? deriveWorkflow(progress, running ? { now, settled: false } : { settled: true }) : undefined);
  const counts = $derived(wf ? wf.counts : EMPTY_COUNTS);
  const agents = $derived(wf ? agentDotStates(wf.phases.flatMap((p) => p.agents), running ? { now } : {}) : undefined);
  const hasAgents = $derived(!!wf && wf.counts.total > 0);
  const startedAt = $derived(task && task.startedAt ? task.startedAt : 0);
  const elapsed = $derived.by(() => {
    if (running) return startedAt ? fmtDurPanel(Math.max(0, now - startedAt)) : '';
    const ms = (task && task.usage && task.usage.ms) || (task && task.endedAt && startedAt ? task.endedAt - startedAt : 0) || tool.ms || 0;
    return ms > 0 ? fmtDurPanel(ms) : '';
  });
  const STATUS_WORD = { completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
  const statusWord = $derived(running ? '' : (STATUS_WORD[status] || ''));
</script>

{#if compact}
  <div class="wrap cardwrap">
    <button type="button" class="card" class:settled={!running} aria-label={name ? `View workflow: ${name}` : 'View workflow'} onclick={open}>
      <span class="surface" aria-hidden="true"></span>
      <span class="col">
        {#if name}<span class="ttl trunc" class:cl-shine={running}>{name}</span>{/if}
        <span class="meta" class:pb={!name}>
          <span class="kind" class:t7={!!name} class:cl-shine={running && !name}>{pre ? 'Starting workflow' : 'Workflow'}</span>
          {#if statusWord}<span class="st" class:danger={failed}>{statusWord}</span>{/if}
          {#if hasAgents}<span class="cnt"><span class="t7">{counts.total}</span>{counts.total === 1 ? ' agent' : ' agents'}</span>{/if}
          {#if elapsed}<span class="tm">{elapsed}</span>{/if}
        </span>
        {#if running || hasAgents}
          <span class="dots"><AgentDots {counts} {agents} wrap={true} maxRows={8} anticipate={running} /></span>
        {/if}
        {#if reason}<span class="why">{reason}</span>{/if}
      </span>
      <span class="ic caret" aria-hidden="true">{glyph('CaretRight')}</span>
    </button>
  </div>
{:else}
  <div class="wrap" class:ingroup={inGroup}>
    <div class="row" role="button" tabindex="0" onclick={open} onkeydown={onKey}>
      <span class="verb nowrap" class:cl-shine={running} class:danger={failed} use:morphText={running ? 'running' : 'ran'}>{running ? 'Running workflow' : 'Ran workflow'}</span>
      {#if name}<span class="name trunc">{name}</span>{/if}
      {#if stopped || failed}<span class="badge" class:danger={failed} title={reason || undefined}>{stopped ? 'Stopped' : 'Failed'}</span>{/if}
      {#if reason}<span class="reason trunc">{reason}</span>{/if}
      {#if running}<span class="sr-only">running</span>{/if}
      <span class="ic caret rowcaret" aria-hidden="true">{glyph('CaretRight')}</span>
    </div>
  </div>
{/if}

<style>
  /* 令牌只挂在组件根上（嵌入宿主 bundle 的子应用 CSS 禁裸 :root）：--t7 = 墨色 70/80% */
  .wrap { --cl-t7: rgba(255, 255, 255, .7); display: flex; flex-direction: column; width: 100%; min-width: 0; margin: 4px 0; }
  :global(html[data-theme="light"]) .wrap { --cl-t7: rgba(0, 0, 0, .8); }
  .wrap.ingroup { margin: 0; }
  .wrap.cardwrap { margin: 6px 0; }

  /* —— 紧凑卡（官方 TD：my + Cy + ky）：318px、r8、padding 10/8/10/12、gap 6、items-start —— */
  .card {
    appearance: none; background: none; border: 0; margin: 0; font: inherit; color: inherit;
    position: relative; isolation: isolate; display: flex; align-self: flex-start; align-items: flex-start; gap: 6px;
    width: 318px; max-width: 100%; box-sizing: border-box; padding: 10px 8px 10px 12px; border-radius: 8px;
    text-align: left; text-wrap: pretty; cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent;
  }
  .card:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  /* 底面层：1px 描边 + hover 底色 + 按下 scale(.99)、松手 .45s 弹簧（官方 --btn-spring 原曲线，
     不支持 linear() 的内核退到 settle 曲线）；只有底面缩，内容不动 */
  .surface {
    position: absolute; inset: 0; z-index: -1; border-radius: inherit; box-shadow: 0 0 0 1px var(--divider);
    transform-origin: 50% 50%;
    transition: transform .45s cubic-bezier(.34, 1.26, .5, 1);
    transition: transform .45s linear(0, .2459, .6526, .9468, 1.0764, 1.0915, 1.0585, 1.0219, .9993, .9914, .9921, .9957, .9988, 1.0004, 1);
  }
  @media (hover: hover) { .card:hover .surface { background: var(--hover); } }
  .card:active .surface { transform: scale(.99); transition: transform 60ms ease-out; }
  .col { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
  .ttl { font-size: 14px; line-height: 20px; }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 副行（官方 text-footnote text-muted tabular-nums，minHeight=leading-body）：gap 12px */
  .meta { display: flex; min-width: 0; align-items: center; gap: 12px; min-height: 20px; font-size: 12.5px; line-height: 16px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .meta.pb { padding-bottom: 3px; }
  .kind, .st, .cnt, .tm { flex: none; white-space: nowrap; }
  /* 跑完的卡：失败原因一行（截断，全文在右侧详情）*/
  .why { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12.5px; line-height: 16px; color: var(--crit); }
  .t7 { color: var(--cl-t7); }
  .dots { display: block; padding: 6px 0 2px; }
  /* 右侧 CaretRight（官方 Sy：muted，高度对齐标题行 20px） */
  .caret { flex: none; display: flex; align-items: center; justify-content: center; width: 1em; height: 20px; font-size: 16px; font-weight: 533; color: var(--muted); font-feature-settings: "liga" 0; }

  /* —— 单行（官方 zD 非卡态）：gap 3px、r4 —— */
  .row {
    position: relative; display: flex; align-self: flex-start; max-width: 100%; min-width: 0; align-items: center; gap: 3px;
    padding: 0; text-align: left; border-radius: 4px; outline: none; cursor: pointer; color: var(--serif); font-size: 14px; line-height: 20px;
    -webkit-tap-highlight-color: transparent; transition: color var(--mo-micro, 140ms);
  }
  .row:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  @media (hover: hover) { .row:hover { color: var(--text); } }
  .nowrap { flex: none; white-space: nowrap; }
  .danger { color: var(--crit); }
  .name { color: inherit; }
  .badge { flex: none; }
  .rowcaret { height: 1em; }
  /* 失败/停止原因：桌面靠 Failed 徽标的 title 悬停，触屏内联显示（官方 [@media(pointer:coarse)]:block） */
  .reason { display: none; }
  @media (pointer: coarse) { .reason { display: block; } }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
