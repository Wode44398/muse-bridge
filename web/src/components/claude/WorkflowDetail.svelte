<script>
  // 官方 /code 页 Tasks 侧栏的「工作流详细卡」RD（桌面端 c360a9e1c 21007-21163，规格
  // workflow-panel.md §3.4–§3.6）：标题（running 流光）/ 「Workflow · 状态 · 时长」/ 「n agents ·
  // tokens」/ 描述 / 失败·停止原因框 / Phases 进度树（OD 行 → LD 四列 agent 表）。
  // 09-02 这些先住在底部抽屉 TaskSheet 里，09-05 起搬进右侧工作台的「任务」视图（TasksPanel）。
  //
  // bridge 偏离：agent 表的行可点（onAgent(a)）→ 压上那个 agent 的转录视图——官方 FD 行不可点、只看得到
  // label/model/tokens/time。运行中、排队中的也能点（先看提示词，转录只在视图开着时懒同步），见 AgentTranscript。
  // 数据只读：tool 是 chat.messages 里的 proxy（单写者规则——只有 chat 内核改它）。
  // 秒级时钟只在「卡片挂着且工作流还在跑」时 tick——官方 cD(running) 同款，页面隐藏时冻结。
  import { deriveWorkflow, agentState, agentDotStates, reasonFromSummary, toolTaskStatus, toolTaskTitle } from '../../lib/taskModel.js';
  import { modelLabel, fmtCompact, fmtDurPanel } from '../../lib/toolVerbs.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import AgentDots from './AgentDots.svelte';

  let { tool, onAgent = undefined, focused = false } = $props();

  const STATUS_WORD = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
  // 空 phase 文案（官方 PD），按工作流终态取
  const EMPTY_PHASE = {
    running: 'No agents have started yet', completed: 'No agents ran in this phase',
    stopped: 'Stopped before any agents started', failed: 'Failed before any agents started',
  };

  const task = $derived(tool.task || null);
  const status = $derived(toolTaskStatus(tool));
  const running = $derived(status === 'running');
  const title = $derived(toolTaskTitle(tool));

  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  // 时长：running 且有起点 → 实时；否则 usage.ms → 起止差 → 工具行 tool_done 的 ms
  const timeText = $derived.by(() => {
    if (running) return task && task.startedAt ? fmtDurPanel(Math.max(0, now - task.startedAt)) : '';
    const ms = (task && task.usage && task.usage.ms) || (task && task.endedAt && task.startedAt ? task.endedAt - task.startedAt : 0) || tool.ms || 0;
    return ms > 0 ? fmtDurPanel(ms) : '';
  });

  // 官方 hD：running 时带 now（卡死判定/实时计时），结束后 settled（running 的 phase 视为 done）
  const wf = $derived(task && task.progress.length
    ? deriveWorkflow(task.progress, running ? { now, settled: false } : { settled: true })
    : undefined);
  const agentCount = $derived(wf ? wf.counts.total : 0);
  const tokens = $derived((task && task.usage && task.usage.tokens) || (wf ? wf.totalTokens : 0) || 0);
  const reason = $derived(task && (status === 'failed' || status === 'stopped')
    ? (reasonFromSummary(task.summary, task.description) || task.error || '') : '');
  // phase 展开态：用户点过才记；默认展开 = 工作流 running 且本 phase 有 agent（官方 OD）。换对象即清。
  let phaseOpen = $state({});
  $effect(() => { void tool; phaseOpen = {}; });
  const isOpen = (ph) => (ph.index in phaseOpen ? !!phaseOpen[ph.index] : (running && ph.counts.total > 0));
  const toggle = (ph) => { phaseOpen[ph.index] = !isOpen(ph); };
  const dotOpts = () => (running ? { now } : undefined);
  // agent 行的 Time 列：running 且 progress 态且有 startedAt → 实时；否则 durationMs
  const agentTime = (a) => (running && a.state === 'progress' && a.startedAt !== undefined
    ? fmtDurPanel(Math.max(0, now - a.startedAt))
    : a.durationMs !== undefined ? fmtDurPanel(a.durationMs) : '');
  const canOpen = (a) => !!(onAgent && a);
  function pick(a) { if (canOpen(a)) onAgent(a); }
  function onKey(e, a) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(a); } }
</script>

<div class="rd" class:focused>
  <div class="rd-head">
    <div class="rd-title-row">
      <span class="rd-title" class:shine={running} class:dim={!running}>{title}</span>
      {#if !running && timeText}<span class="rd-dur num">{timeText}</span>{/if}
    </div>
    <div class="rd-meta">
      <span class:t7={running}>Workflow</span>
      {#if !running}<span class:crit={status === 'failed'}>{STATUS_WORD[status] || status}</span>
      {:else if timeText}<span class="num">{timeText}</span>{/if}
    </div>
    {#if agentCount > 0 || tokens > 0}
      <div class="rd-meta">
        {#if agentCount > 0}<span><b class:t7={running}>{agentCount}</b> {agentCount === 1 ? 'agent' : 'agents'}</span>{/if}
        {#if tokens > 0}<span><b class:t7={running}>{fmtCompact(tokens)}</b> tokens</span>{/if}
      </div>
    {/if}
    {#if task && task.description && task.description !== title}<p class="rd-desc sel-text">{task.description}</p>{/if}
    {#if reason}
      <div class="rd-reason" class:failed={status === 'failed'} class:stopped={status === 'stopped'}>
        <span class="rd-reason-h" class:crit={status === 'failed'}>{status === 'failed' ? 'Error' : 'Stopped'}</span>
        <!-- 官方同款：可聚焦的滚动区（键盘也能滚 120px 的长原因） -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <span class="rd-reason-b sel-text" role="region" aria-label={status === 'failed' ? 'Error' : 'Stopped'} tabindex="0">{reason}</span>
      </div>
    {/if}
  </div>

  {#if wf && wf.phases.length}
    <div class="rd-phases">
      <span class="rd-ph-h" class:muted={!running}>Phases</span>
      <ul class="rd-ph-list" role="list">
        {#each wf.phases as ph (ph.index)}
          {@const open = isOpen(ph)}
          {@const hasAgents = ph.counts.total > 0}
          {@const anticipate = running && ph.status !== 'done'}
          <li class="ph" class:open>
            <button type="button" class="ph-btn" class:open class:pad={hasAgents || anticipate} aria-expanded={open}
              aria-label={`Phase: ${ph.title}, ${ph.status}${hasAgents ? `, ${ph.counts.done} of ${ph.counts.total} agents done` : ''}`}
              onclick={() => toggle(ph)}>
              <span class="ph-row">
                <!-- 标题色（官方 SD）：running 有卡死→warn、running→流光、error→红、展开且非 running/error→主色、done/pending→次色；工作流已结束全部 muted -->
                <span class="ph-title"
                  class:muted={!running}
                  class:crit={running && ph.status === 'error'}
                  class:warn={running && ph.status === 'running' && ph.counts.stalled > 0}
                  class:shine={running && ph.status === 'running' && ph.counts.stalled === 0}
                  class:text={running && open && ph.status !== 'running' && ph.status !== 'error'}>{ph.title}</span>
                {#if hasAgents}<span class="ph-count num">{ph.counts.done}/{ph.counts.total}</span>{/if}
                <span class="gi ph-caret" class:dim={!open} aria-hidden="true">{glyph(open ? 'CaretDown' : 'CaretRight')}</span>
              </span>
              {#if hasAgents || anticipate}
                <span class="ph-dots"><AgentDots counts={ph.counts} agents={agentDotStates(ph.agents, dotOpts())} wrap cols={16} {anticipate} /></span>
              {/if}
            </button>
            {#if open}
              {#if !ph.agents.length}
                <div class="ag-empty">{EMPTY_PHASE[status] || EMPTY_PHASE.completed}</div>
              {:else}
                <div class="ag-grid" role="table">
                  <span class="ag-h"><span class="ag-st"></span>Agent</span>
                  <span class="ag-h">Model</span>
                  <span class="ag-h">Tokens</span>
                  <span class="ag-h r">Time</span>
                  {#each ph.agents as a (a.index)}
                    {@const st = agentState(a, dotOpts())}
                    {@const dim = st === 'done' || !running}
                    {@const link = canOpen(a)}
                    <!-- bridge 偏离：行可点 → 该 agent 的提示词 + 转录视图（role/tabindex 只在可点时给） -->
                    <!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_tabindex -->
                    <span class="ag-c ag-name" class:dim class:link role={link ? 'button' : undefined} tabindex={link ? 0 : undefined}
                      title={link ? (st === 'done' || st === 'error' || !running ? `View transcript: ${a.label}` : `View prompt & live transcript: ${a.label}`) : a.label}
                      onclick={() => pick(a)} onkeydown={(e) => onKey(e, a)}>
                      <span class="ag-st">{#if st === 'done'}<span class="gi xs" role="img" aria-label="Done">{glyph('Check')}</span>{/if}</span>
                      <span class="ag-lbl">{a.label}</span>
                    </span>
                    {#if a.error}
                      <!-- 官方 FD：后三列并成一格右对齐的红字 Error，聚焦/悬停靠 title 露全文 -->
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                      <span class="ag-c ag-err" tabindex="0" title={a.error} aria-label={a.error}>Error</span>
                    {:else}
                      <span class="ag-c ag-model" class:dim title={modelLabel(a.model)}>{modelLabel(a.model)}</span>
                      <span class="ag-c num" class:dim>{a.tokens ? fmtCompact(a.tokens) : ''}</span>
                      <span class="ag-c num r" class:dim>{agentTime(a)}</span>
                    {/if}
                  {/each}
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {:else if task && task.phasesMeta.length}
    <!-- 历史回落：progress 快照拿不到（输出文件已过保留期）时用脚本 meta.phases 占位 -->
    <div class="rd-phases">
      <span class="rd-ph-h muted">Phases</span>
      <ul class="rd-ph-list" role="list">
        {#each task.phasesMeta as pm, i (i)}
          <li class="ph">
            <div class="ph-btn">
              <span class="ph-row"><span class="ph-title muted">{pm.title || `Phase ${i + 1}`}</span></span>
              {#if pm.detail}<span class="ph-detail">{pm.detail}</span>{/if}
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {:else if running}
    <div class="ag-empty">Waiting for agents to start</div>
  {/if}
  {#if task && task.result}
    <details class="rd-result"><summary>Result</summary><pre class="sel-text">{task.result}</pre></details>
  {/if}
</div>

<style>
  /* 卡片（官方 flex-col gap-24 rounded-r6 bg-t1 p-p6 pb-p8）：底 --card、圆角 8、内边距 10/12 */
  .rd { display: flex; flex-direction: column; gap: 18px; border-radius: 10px; background: var(--card); padding: 10px 10px 12px; box-shadow: var(--card-shadow);
    /* 文字流光（官方 epitaxy-text-shine）的两端/中点：暗色 = --t7 → 白 → --t7；亮色 = 墨色 → 掺 30% 白 */
    --sh-edge: var(--serif); --sh-mid: var(--text); }
  :global(html[data-theme="light"]) .rd { --sh-edge: var(--text); --sh-mid: color-mix(in srgb, var(--text) 30%, white); }
  /* 从对话里点进来定位到的那张：描一圈边，1.6s 后淡掉 */
  .rd.focused { animation: rdFocus 1.6s ease-out; }
  @keyframes rdFocus { 0%, 40% { box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--text) 45%, transparent); } 100% { box-shadow: var(--card-shadow); } }

  /* Anthropicons 字形（与状态栏芯片同轴位 opsz16/wght533；xs=12px 用更粗的 620） */
  .gi { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 16, "wght" 533;
    font-size: 16px; line-height: 1; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .gi.xs { font-size: 12px; width: 12px; height: 12px; font-variation-settings: "opsz" 12, "wght" 620; }

  .rd-head { display: flex; flex-direction: column; gap: 6px; user-select: none; }
  .rd-title-row { display: flex; align-items: flex-start; gap: 8px; }
  .rd-title { flex: 1; min-width: 0; font-size: 14px; line-height: 20px; color: var(--text); overflow-wrap: anywhere; text-wrap: balance; }
  .rd-title.dim { color: var(--serif); }
  .rd-dur { flex: none; padding-right: 2px; font-size: 12.5px; line-height: 20px; color: var(--muted); }
  .rd-meta { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; row-gap: 3px;
    font-size: 12.5px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; }
  .rd-meta b { font-weight: 400; }
  .rd-desc { font-size: 12.5px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; margin: 2px 0 0; user-select: text; }

  /* 失败 / 停止原因框（官方：failed 底 = 8% danger，stopped 底 = --t1） */
  .rd-reason { display: flex; flex-direction: column; gap: 4px; border-radius: 6px; padding: 7px 8px 8px; margin-top: 4px; }
  .rd-reason.stopped { background: var(--hover); }
  .rd-reason.failed { background: color-mix(in srgb, var(--crit) 8%, transparent); }
  .rd-reason-h { font-size: 12.5px; line-height: 16px; color: var(--muted); }
  .rd-reason-b { display: block; max-height: 120px; overflow-y: auto; border-radius: 4px; font-size: 12.5px; line-height: 16px;
    color: var(--serif); white-space: pre-wrap; overflow-wrap: anywhere; outline: none; user-select: text; }

  /* Phases 进度树（官方 OD 行 → LD 表） */
  .rd-phases { display: flex; flex-direction: column; gap: 6px; }
  .rd-ph-h { font-size: 12.5px; line-height: 16px; font-weight: 500; color: var(--text); }
  .rd-ph-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .ph { display: flex; flex-direction: column; gap: 8px; }
  .ph.open { padding-bottom: 12px; }
  .ph-btn { width: 100%; border-radius: 4px; padding: 4px 8px 6px; text-align: left; display: flex; flex-direction: column; gap: 6px;
    font-size: 12.5px; line-height: 16px; color: var(--serif); }
  .ph-btn.pad { padding-bottom: 8px; }
  .ph-btn.open { background: var(--hover); }
  @media (hover: hover) { .ph-btn:not(.open):hover { background: var(--hover); } }
  .ph-row { display: flex; align-items: flex-start; gap: 8px; width: 100%; }
  .ph-title { flex: 1; min-width: 0; min-height: 20px; display: flex; align-items: center; overflow-wrap: anywhere; text-wrap: balance; color: var(--serif); }
  .ph-title.text { color: var(--text); }
  .ph-detail { display: block; color: var(--muted); overflow-wrap: anywhere; }
  .ph-count { flex: none; min-height: 20px; display: flex; align-items: center; color: var(--muted); }
  .ph-caret { min-height: 20px; height: auto; color: var(--muted); }
  .ph-caret.dim { color: color-mix(in srgb, var(--text) 25%, transparent); }
  .ph-dots { display: block; padding-right: 22px; }
  .ag-empty { padding-left: 8px; font-size: 12.5px; line-height: 16px; color: var(--muted); }
  /* 四列表 Agent / Model / Tokens / Time；数据行 16px 高 */
  .ag-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, max-content) 60px minmax(56px, max-content);
    grid-auto-rows: 16px; align-items: center; column-gap: 12px; row-gap: 4px; padding: 0 8px; font-size: 12.5px; line-height: 16px; }
  .ag-h { color: var(--muted); display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  .ag-h.r, .ag-c.r { text-align: right; justify-self: end; }
  .ag-st { display: flex; width: 12px; flex: none; align-items: center; justify-content: center; }
  .ag-c { color: var(--serif); min-width: 0; white-space: nowrap; }
  .ag-c.dim { color: var(--muted); }
  .ag-name { display: flex; align-items: center; gap: 5px; border-radius: 4px; outline: none; }
  .ag-name.link { cursor: pointer; }
  .ag-name.link .ag-lbl { text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 2px; transition: text-decoration-color .15s ease, color .15s ease; }
  @media (hover: hover) { .ag-name.link:hover .ag-lbl, .ag-name.link:focus-visible .ag-lbl { text-decoration-color: currentColor; color: var(--text); } }
  .ag-lbl, .ag-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ag-err { grid-column: span 3; justify-self: end; color: var(--crit); cursor: default; outline: none; }

  .rd-result summary { font-size: 12.5px; color: var(--muted); cursor: pointer; }
  .rd-result pre { background: var(--userbubble); border: 1px solid var(--divider); border-radius: 10px; padding: 10px 12px; margin: 6px 0 0;
    font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }

  /* 文字流光（官方 epitaxy-text-shine 原参数：3s 循环、0–22% 停在右侧、76% 起停在左侧） */
  .shine { color: var(--text); background-image: linear-gradient(120deg, var(--sh-edge) 25%, var(--sh-mid) 50%, var(--sh-edge) 75%);
    background-size: 200% 100%; background-position: 150% 0; -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; animation: rdShine 3s infinite; }
  @keyframes rdShine { 0%, 22% { background-position: 150% 0; animation-timing-function: cubic-bezier(.5,.05,.45,.95); } 76%, 100% { background-position: -50% 0; } }
  @media (prefers-reduced-motion: reduce) { .shine { animation: none; background-position: 50% 0; } .rd.focused { animation: none; } }

  /* 色彩语义（放在最后，压过各自的默认色）：t7=次色、muted、crit/warn 只保留语义红黄——彩色只留星芒 */
  .t7 { color: var(--serif); }
  .muted { color: var(--muted); }
  .crit { color: var(--crit); }
  .warn { color: var(--warn); }
  .num { font-variant-numeric: tabular-nums; }
</style>
