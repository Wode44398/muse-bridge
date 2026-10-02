<script>
  // 右侧工作台「任务」视图 = 官方 /code 页 Tasks 侧栏（bH/kH，规格 workflow-panel.md §3.3）在 bridge
  // 里的形态：本会话的后台任务分 Running / Finished 两节（Finished 可折叠、可 Clear），每个任务按种类
  // 渲染——动态工作流 → 详细卡 WorkflowDetail（RD：Phases 树 → agent 表），Agent / 后台 shell → 通用
  // 任务行 TaskRow（hH）。点对话里的 Workflow 卡 / Agent 行进来时定位到那条（官方
  // openTasksPaneAtTask：scrollIntoView center），Agent 行还会直接压上它的子转录视图
  //（官方 pushPaneView('tasks', {kind:'subagent'}) 的对应物）；工作流详细卡里点某个 agent 同样压上
  // 那个 agent 的转录（磁盘 jsonl 轮询）。
  //
  // 数据源就是 chat.messages 里带 task 的工具行（单写者规则：只读，不改）——没有第二份任务表。
  // 快照页（/c/<token>）同样能用：只读数据 + 历史转录接口对访客 401 时面板显示 No activity。
  import { tick } from 'svelte';
  import { chat, bgHoldNow, releaseBgHold } from '../../lib/chat.svelte.js';
  import { session } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { dock, backToTaskList } from '../../lib/dock.svelte.js';
  import { toolTaskKind, toolTaskStatus, toolTaskTitle, taskNoun } from '../../lib/taskModel.js';
  import { iconSvg, glyph } from '../../lib/claudeIcons.js';
  import WorkflowDetail from '../claude/WorkflowDetail.svelte';
  import TaskRow from '../claude/TaskRow.svelte';
  import AgentTranscript from '../claude/AgentTranscript.svelte';
  import { t } from '../../lib/i18n.js';

  let { wide = false } = $props();

  // 本会话全部任务型工具行（按出现顺序编号，排序稳定）
  const items = $derived.by(() => {
    const out = [];
    let i = 0;
    // 挂起清单里点名的任务就是还在跑：挂起接力后它们挂在前几轮的工具行上，刷新后历史重建会把
    //「上一轮留下的 running」收成 stopped（normSeg），以服务端这份电平为准纠回来。
    const holdIds = new Set((bgHoldNow()?.tasks || []).map((x) => x.taskId).filter(Boolean));
    for (const m of chat.messages) {
      if (!m || m.role !== 'assistant') continue;
      for (const s of (m.segments || [])) {
        if (s.kind !== 'tools') continue;
        for (const tl of s.tools) {
          const kind = toolTaskKind(tl);
          if (!kind) continue;
          const task = tl.task;
          const status = task && task.taskId && holdIds.has(task.taskId) ? 'running' : toolTaskStatus(tl);
          out.push({ tool: tl, kind, status, running: status === 'running', startedAt: (task && task.startedAt) || 0, endedAt: (task && task.endedAt) || 0, key: tl.id || ('i' + i), index: i });
          i++;
        }
      }
    }
    return out;
  });
  // —— 本轮「挂起等后台任务」（服务端 bg_hold）——
  // 主模型已停笔，但后台任务还在跑，bridge 把输入流挂着不收轮（收轮=CLI 收尾=后台任务被杀）。
  // 横幅是这件事在 UI 上的唯一解释处：等几个、等多久、到点会怎样、怎么提前收。
  const hold = $derived(bgHoldNow());
  // 横幅标题按种类整句一键（英文要跟着数量变单复数，名词不能单拎出来拼）
  const HOLD_TITLE = {
    shell: (n) => t('本轮挂起中 · 等待 {n} 个后台命令', { n }),
    agent: (n) => t('本轮挂起中 · 等待 {n} 个子 agent', { n }),
    workflow: (n) => t('本轮挂起中 · 等待 {n} 个工作流', { n }),
    monitor: (n) => t('本轮挂起中 · 等待 {n} 个监视任务', { n }),
    task: (n) => t('本轮挂起中 · 等待 {n} 个后台任务', { n }),
  };
  const holdKind = $derived.by(() => {
    const kinds = new Set((hold?.tasks || []).map((x) => taskNoun(x.taskType)));
    return kinds.size === 1 && HOLD_TITLE[[...kinds][0]] ? [...kinds][0] : 'task';
  });
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!hold || !hold.deadline) return;
    const id = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) nowTick = Date.now(); }, 30_000);
    return () => clearInterval(id);
  });
  const holdLeft = $derived(hold && hold.deadline ? Math.max(0, Math.round((hold.deadline - nowTick) / 60_000)) : 0);
  let releasing = $state(false);
  function doRelease() { releasing = true; releaseBgHold(); }

  // —— 单条停止（官方任务卡右上角的 ⏹）——
  // 走这一轮活着的控制通道（服务端 query.stopTask）。只有【本轮正挂着等后台任务】时通道才在，
  // 所以没有 hold 就不给按钮——历史里的任务早随进程死了，给个按不动的钮是撒谎。
  // 停下来之后 CLI 会发 task_notification(stopped)，卡片自己收敛；任务清零本轮按正常路径定局。
  let stopping = $state([]);
  const canStop = $derived(!!hold && !!session.id);
  async function stopTask(taskId) {
    if (!taskId || stopping.includes(taskId)) return;
    stopping = [...stopping, taskId];
    try { await api.stopTask(session.id, taskId); }
    catch (e) {
      stopping = stopping.filter((k) => k !== taskId);
      showToast(e?.status === 409 ? t('这一轮已经结束，后台任务也跟着结束了') : t('停止失败，请重试'), 'err');
    }
  }
  // 挂起清单里【没有对应工具行】的任务（上一条命遗留、resume 回来的孤儿后台任务）：
  // 也得摆出来，否则横幅说「等 2 个」而列表只有 1 条。工具行有的照旧走真实记录。
  const holdOrphans = $derived.by(() => {
    if (!hold || !hold.tasks) return [];
    const known = new Set(items.map((x) => x.tool?.task?.taskId).filter(Boolean));
    return hold.tasks.filter((x) => x.taskId && !known.has(x.taskId)).map((x) => ({
      key: 'hold:' + x.taskId,
      tool: {
        name: x.taskType === 'local_bash' ? 'Bash' : 'Task',
        status: 'running',
        input: null,
        task: { taskId: x.taskId, taskType: x.taskType, description: x.description || x.command || '', command: x.command || '', status: 'running', startedAt: 0, progress: [] },
      },
    }));
  });

  let clearedKeys = $state([]);
  const running = $derived(items.filter((x) => x.running).sort((a, b) => (a.startedAt - b.startedAt) || (a.index - b.index)));
  const finished = $derived(items.filter((x) => !x.running && !clearedKeys.includes(x.key)).sort((a, b) => (b.endedAt - a.endedAt) || (b.index - a.index)));
  let finishedOpen = $state(true);
  function clearFinished() { clearedKeys = [...clearedKeys, ...finished.map((x) => x.key)]; }

  // —— 定位（官方 openTasksPaneAtTask）：点了对话里的卡 → 那张卡滚到可见 + 描边一闪 ——
  let listEl = $state();
  const focusTool = $derived(dock.tasksFocus ? dock.tasksFocus.tool : null);
  const focusKey = $derived.by(() => { const it = focusTool ? items.find((x) => x.tool === focusTool) : null; return it ? it.key : ''; });
  let flashKey = $state('');
  $effect(() => {
    const f = dock.tasksFocus;
    if (!f) return;
    const key = focusKey;
    if (!key) return;
    // 被 Clear 掉的任务又被点开 → 放回列表
    if (clearedKeys.includes(key)) clearedKeys = clearedKeys.filter((k) => k !== key);
    if (dock.tasksAgent) return;   // 压着转录视图时列表没挂，等回到列表再滚
    flashKey = key;
    tick().then(() => {
      if (!listEl) return;
      const el = listEl.querySelector(`[data-task-key="${CSS.escape(key)}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const tid = setTimeout(() => { flashKey = ''; }, 1700);
    return () => clearTimeout(tid);
  });

  // —— 压上的子 agent 转录视图 ——
  const av = $derived(dock.tasksAgent);
  // 工作流 agent：点开时存下的是那一刻的 workflow_agent 记录，而 workflow_progress 每帧都整份换新对象——
  // 按 index 从工具行的最新快照里现取，转录视图的状态 / tokens / 当前工具 / 结果才会跟着走
  const avWf = $derived.by(() => {
    if (!av || !av.wf) return null;
    const list = (av.tool && av.tool.task && av.tool.task.progress) || [];
    return list.find((e) => e && e.type === 'workflow_agent' && e.index === av.wf.index) || av.wf;
  });
  const avTitle = $derived(av ? (avWf ? String(avWf.label || 'Agent') : toolTaskTitle(av.tool)) : '');
  function openAgent(tool, wf) { dock.tasksAgent = { tool, wf }; }
</script>

<div class="tp">
  {#if av}
    <div class="tp-subhead">
      <button type="button" class="tp-back" aria-label={t('返回任务列表')} onclick={backToTaskList}>
        <span class="ic" aria-hidden="true">{glyph('CaretRight')}</span>
      </button>
      <span class="tp-subtitle trunc" title={avTitle}>{avTitle}</span>
      <span class="tp-subkind">Agent</span>
    </div>
    {#key (av.wf ? av.tool.id + ':' + av.wf.index : av.tool)}
      <div class="tp-scroll tp-tr"><AgentTranscript tool={av.tool} agent={avWf} /></div>
    {/key}
  {:else}
    <div class="tp-scroll" bind:this={listEl}>
      {#if hold}
        <!-- 挂起横幅（bridge 特有，官方 Tasks 侧栏没有对应物）：官方那边一轮结束后 CLI 进程还在，
             后台任务自然活着；bridge 一轮=一次 query，收轮就等于杀进程，所以「等后台任务」是一个
             用户看得见的状态，必须解释清楚并给一个提前收尾的出口。 -->
        <div class="tp-hold">
          <div class="tp-hold-top">
            <span class="tp-pulse" aria-hidden="true"></span>
            <span class="tp-hold-title">{hold.count ? HOLD_TITLE[holdKind](hold.count) : t('后台任务已完成，收尾中')}</span>
          </div>
          <p class="tp-hold-p">
            {hold.count
              ? t('主回答已经写完，但后台任务还在跑。bridge 把这一轮挂着不收尾——收尾会连同后台任务一起结束；任务完成时 Claude 会自动接着这一轮汇报结果。')
              : t('后台任务刚刚结束，正在等 Claude 接着汇报。')}
          </p>
          {#if hold.count && holdLeft > 0}
            <p class="tp-hold-sub">{t('最长再等 {n} 分钟，到点自动收尾（常驻服务不会把这一轮永远钉住）。', { n: holdLeft })}</p>
          {/if}
          {#if hold.count}
            <button type="button" class="tp-hold-btn" disabled={releasing} onclick={doRelease}>{releasing ? t('收尾中…') : t('结束等待')}</button>
          {/if}
        </div>
      {/if}
      {#if !items.length && !holdOrphans.length}
        <!-- 官方空态 aH：AgentsSimple 图标 + "Background work appears here" -->
        <div class="tp-empty">
          <span class="tp-empty-ic" aria-hidden="true">{@html iconSvg('AgentsSimple', 28)}</span>
          <p>Background work appears here</p>
        </div>
      {:else}
        {#if running.length || holdOrphans.length}
          <section class="tp-sec">
            <div class="tp-sech"><h3>Running</h3><span class="tp-n num">{running.length + holdOrphans.length}</span></div>
            <div class="tp-list">
              {#each holdOrphans as it (it.key)}
                <div class="tp-item" data-task-key={it.key}>
                  <TaskRow tool={it.tool} onStop={canStop ? () => stopTask(it.tool.task.taskId) : undefined} />
                </div>
              {/each}
              {#each running as it (it.key)}
                <div class="tp-item" data-task-key={it.key}>
                  {#if it.kind === 'workflow'}
                    <WorkflowDetail tool={it.tool} focused={flashKey === it.key} onAgent={(a) => openAgent(it.tool, a)} />
                  {:else}
                    <TaskRow tool={it.tool} focused={flashKey === it.key}
                      onTranscript={it.kind === 'agent' ? () => openAgent(it.tool, null) : undefined}
                      onStop={canStop && it.tool.task?.taskId ? () => stopTask(it.tool.task.taskId) : undefined} />
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}
        {#if finished.length}
          <section class="tp-sec">
            <div class="tp-sech">
              <button type="button" class="tp-fold" aria-expanded={finishedOpen} onclick={() => (finishedOpen = !finishedOpen)}>
                <h3>Finished</h3><span class="tp-n num">{finished.length}</span>
                <span class="ic" aria-hidden="true">{glyph(finishedOpen ? 'CaretDown' : 'CaretRight')}</span>
              </button>
              <button type="button" class="tp-clear" onclick={clearFinished}>Clear</button>
            </div>
            {#if finishedOpen}
              <div class="tp-list">
                {#each finished as it (it.key)}
                  <div class="tp-item" data-task-key={it.key}>
                    {#if it.kind === 'workflow'}
                      <WorkflowDetail tool={it.tool} focused={flashKey === it.key} onAgent={(a) => openAgent(it.tool, a)} />
                    {:else}
                      <TaskRow tool={it.tool} focused={flashKey === it.key} onTranscript={it.kind === 'agent' ? () => openAgent(it.tool, null) : undefined} />
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {:else if !running.length}
          <div class="tp-empty">
            <span class="tp-empty-ic" aria-hidden="true">{@html iconSvg('AgentsSimple', 28)}</span>
            <p>Background work appears here</p>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .tp { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .tp-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; scrollbar-gutter: stable; padding: 6px 12px 24px; display: flex; flex-direction: column; gap: 16px; }
  .tp-scroll::-webkit-scrollbar { width: 6px; }
  .tp-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 35%, transparent); border-radius: 3px; }
  .tp-tr { padding-top: 10px; }

  .tp-sec { display: flex; flex-direction: column; gap: 8px; }
  .tp-sech { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 2px; }
  .tp-sech h3 { margin: 0; font-size: 12.5px; line-height: 16px; font-weight: 400; color: var(--muted); }
  .tp-n { font-size: 12.5px; line-height: 16px; color: var(--muted); }
  .tp-fold { display: flex; align-items: center; gap: 6px; border-radius: 4px; padding: 2px 4px; margin-left: -4px; color: var(--muted); }
  @media (hover: hover) { .tp-fold:hover h3, .tp-fold:hover .tp-n { color: var(--serif); } }
  .tp-clear { margin-left: auto; font-size: 12.5px; line-height: 16px; color: var(--muted); padding: 3px 8px; border-radius: 7px; }
  .tp-clear:active { background: var(--hover); }
  @media (hover: hover) { .tp-clear:hover { background: var(--hover); color: var(--text); } }
  .tp-list { display: flex; flex-direction: column; gap: 8px; }
  .tp-item { display: contents; }

  /* 挂起横幅：卡片语言跟 TaskRow 一致（同 --card 底 + 同圆角），靠左缘一条 coral 竖线区分它是
     「状态解释」而不是又一条任务。呼吸点用 coral，与状态行菊花的慢呼吸同一语义。 */
  .tp-hold { display: flex; flex-direction: column; gap: 6px; border-radius: 10px; background: var(--card); box-shadow: var(--card-shadow);
    border-left: 2px solid var(--coral); padding: 10px 12px; }
  .tp-hold-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .tp-hold-title { font-size: 13.5px; line-height: 18px; color: var(--text); overflow-wrap: anywhere; }
  .tp-pulse { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--coral); animation: tpPulse 2.4s ease-in-out infinite; }
  @keyframes tpPulse { 0%, 100% { opacity: .35; transform: scale(.82); } 50% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { .tp-pulse { animation: none; opacity: .9; } }
  .tp-hold-p, .tp-hold-sub { margin: 0; font-size: 12.5px; line-height: 17px; color: var(--muted); overflow-wrap: anywhere; }
  .tp-hold-sub { color: color-mix(in srgb, var(--muted) 78%, transparent); }
  .tp-hold-btn { align-self: flex-start; margin-top: 2px; font-size: 12.5px; line-height: 16px; color: var(--serif);
    padding: 5px 10px; border-radius: 8px; background: var(--hover); }
  .tp-hold-btn:disabled { opacity: .55; }
  .tp-hold-btn:active { background: var(--hover-strong); }
  @media (hover: hover) { .tp-hold-btn:not(:disabled):hover { background: var(--hover-strong); color: var(--text); } }

  .ic { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 12, "wght" 620;
    font-size: 12px; line-height: 1; width: 12px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex: none; }

  /* 压上的转录视图头：返回 + 标题 + 种类词 */
  .tp-subhead { flex: none; display: flex; align-items: center; gap: 8px; padding: 4px 10px 6px 6px; border-bottom: 1px solid var(--divider); }
  .tp-back { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--serif); flex: none; }
  .tp-back .ic { transform: scaleX(-1); font-size: 16px; width: 16px; height: 16px; font-variation-settings: "opsz" 16, "wght" 533; }
  .tp-back:active { background: var(--hover); }
  @media (hover: hover) { .tp-back:hover { background: var(--hover); color: var(--text); } }
  .tp-subtitle { flex: 1; min-width: 0; font-size: 14px; color: var(--text); }
  .tp-subkind { flex: none; font-size: 12px; color: var(--muted); background: var(--hover); border-radius: 7px; padding: 2px 8px; }
  .trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .tp-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 24px; text-align: center; color: var(--text); }
  .tp-empty p { margin: 0; font-size: 14px; line-height: 20px; max-width: 36ch; overflow-wrap: anywhere; }
  .tp-empty-ic { color: color-mix(in srgb, var(--text) 35%, transparent); display: flex; }
  .tp-empty-ic :global(svg) { width: 28px; height: 28px; }
  .num { font-variant-numeric: tabular-nums; }
</style>
