<script>
  // 官方 /code 页 Tasks 侧栏的通用任务行 hH（agent-tool-card.md §7，c360a9e1c 27191-27363）——Agent /
  // 后台 shell / 其它任务在「任务」视图里的形态：标题（running 流光，可点展开）+ 元信息两行
  //（种类 · 状态 · 时长 / 模型 · tokens · tool uses · 最近工具 · View transcript）+ 展开区
  //（prompt / 输出摘要 / 错误）。工作流走 WorkflowDetail（详细卡），不走这条。
  import { toolTaskStatus, toolTaskTitle, toolTaskKind, taskNoun } from '../../lib/taskModel.js';
  import { modelLabel, fmtCompact, fmtDurPanel } from '../../lib/toolVerbs.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { t, tr } from '../../lib/i18n.js';

  let { tool, focused = false, onTranscript = undefined, onStop = undefined } = $props();

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const STATUS_WORD = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
  const task = $derived(tool.task || null);
  const kind = $derived(toolTaskKind(tool));
  const status = $derived(toolTaskStatus(tool));
  const running = $derived(status === 'running');
  const title = $derived(toolTaskTitle(tool));
  // 种类词（官方 Agent / Remote agent / Bash / Monitor / Task）
  const noun = $derived.by(() => {
    const tt = task ? task.taskType : '';
    if (kind === 'agent') return tt === 'remote_agent' ? 'Remote agent' : 'Agent';
    const n = taskNoun(tt);
    return n === 'shell' ? 'Bash' : cap(n);
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  const timeText = $derived.by(() => {
    if (running) return task && task.startedAt ? fmtDurPanel(Math.max(0, now - task.startedAt)) : '';
    const ms = (task && task.usage && task.usage.ms) || (task && task.endedAt && task.startedAt ? task.endedAt - task.startedAt : 0) || tool.ms || 0;
    return ms > 0 ? fmtDurPanel(ms) : '';
  });
  const modelText = $derived(task && task.model ? (modelLabel(task.model) || task.model) : '');
  const tokens = $derived(task && task.usage ? task.usage.tokens : 0);
  const toolUses = $derived(task ? (task.usage ? task.usage.toolUses : task.toolCount) : 0);
  const lastTool = $derived(running && task ? (task.lastTool || task.latestToolName || '') : '');
  const prompt = $derived(task ? String(task.prompt || '') : '');
  // 后台 shell 的命令行（服务端 Stop hook 的 background_tasks[].command 合并进来的）——
  // description 常常只是一句概括，真正要看的是「到底在后台跑什么」。与描述重复时不再重复摆。
  const command = $derived.by(() => {
    const c = String((task && task.command) || (tool.input && tool.input.command) || '');
    return c && c !== title ? c : '';
  });
  const output = $derived.by(() => {
    if (!task) return '';
    if (status === 'failed' && task.error) return tr(task.error);
    return String(task.result || task.summary || '');
  });
  const expandable = $derived(!!(prompt || output || command));
  let open = $state(false);
  function toggle() { if (expandable) open = !open; }
</script>

<div class="tk" class:focused class:open>
  <div class="tk-top">
    <button type="button" class="tk-title-btn" aria-expanded={expandable ? open : undefined} aria-label={`Background task: ${title}`} onclick={toggle}>
      <span class="tk-title" class:shine={running} class:dim={!running}>{title}</span>
      {#if expandable}<span class="ic caret" aria-hidden="true">{glyph(open ? 'CaretDown' : 'CaretRight')}</span>{/if}
    </button>
    <!-- 单条停止（官方 Background tasks 卡右上角的 ⏹）：只有还在跑、且这一轮的控制通道还活着
         （父组件给了 onStop）才摆。停不成功由父组件出提示，不在这里吞。 -->
    {#if running && onStop}
      <button type="button" class="tk-stop" aria-label={t('停止：{title}', { title })} title={t('停止这个任务')} onclick={onStop}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7.5" y="7.5" width="9" height="9" rx="1.6"/></svg>
      </button>
    {/if}
  </div>
  <div class="tk-meta">
    <span class="tk-row">
      <span class:t7={running}>{noun}</span>
      {#if !running}<span class:crit={status === 'failed'}>{STATUS_WORD[status] || cap(status)}</span>{/if}
      {#if timeText}<span class="num">{timeText}</span>{/if}
    </span>
    {#if modelText || tokens || toolUses || lastTool || (kind === 'agent' && onTranscript)}
      <span class="tk-row">
        {#if modelText}<span class="t7">{modelText}</span>{/if}
        {#if tokens}<span><b class:t7={running}>{fmtCompact(tokens)}</b> tokens</span>{/if}
        {#if toolUses}<span><b class:t7={running}>{toolUses}</b> {toolUses === 1 ? 'tool use' : 'tool uses'}</span>{/if}
        {#if lastTool}<span class="trunc">{lastTool}</span>{/if}
        {#if kind === 'agent' && onTranscript}<button type="button" class="tk-link" aria-label={`View transcript for ${title}`} onclick={onTranscript}>View transcript</button>{/if}
      </span>
    {/if}
  </div>
  {#if open}
    <div class="tk-body">
      {#if command}<pre class="tk-pre sel-text">{command}</pre>{/if}
      {#if prompt}<pre class="tk-pre sel-text">{prompt}</pre>{/if}
      {#if output}<div class="tk-out sel-text" class:crit={status === 'failed' && !!task.error}>{output}</div>
      {:else if running}<div class="tk-note">No output yet</div>{/if}
    </div>
  {/if}
</div>

<style>
  .tk { display: flex; flex-direction: column; gap: 6px; border-radius: 10px; background: var(--card); padding: 10px 10px 8px; box-shadow: var(--card-shadow);
    --sh-edge: var(--serif); --sh-mid: var(--text); }
  :global(html[data-theme="light"]) .tk { --sh-edge: var(--text); --sh-mid: color-mix(in srgb, var(--text) 30%, white); }
  .tk.focused { animation: tkFocus 1.6s ease-out; }
  @keyframes tkFocus { 0%, 40% { box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--text) 45%, transparent); } 100% { box-shadow: var(--card-shadow); } }
  @media (hover: hover) { .tk:hover { background: var(--hover-strong); } }

  .tk-top { display: flex; align-items: flex-start; gap: 8px; }
  .tk-stop { flex: none; width: 26px; height: 26px; margin: -3px -2px 0 0; border-radius: 7px; display: flex; align-items: center; justify-content: center;
    color: var(--muted); border: 1px solid var(--divider); }
  .tk-stop svg { width: 16px; height: 16px; }
  .tk-stop:active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .tk-stop:hover { background: var(--hover-strong); color: var(--text); } }
  .tk-title-btn { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 4px; text-align: left; }
  .tk-title { flex: 1; min-width: 0; font-size: 14px; line-height: 20px; color: var(--text); overflow-wrap: anywhere; }
  .tk-title.dim { color: var(--serif); }
  .ic { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 12, "wght" 620;
    font-size: 12px; line-height: 1; width: 12px; height: 20px; display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--muted); }
  .tk-meta { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; padding-bottom: 2px; }
  .tk-row { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; row-gap: 3px; min-width: 0; }
  .tk-row b { font-weight: 400; }
  .trunc { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tk-link { color: var(--coral); font-size: 12.5px; line-height: 16px; padding: 0; border-radius: 3px; }
  @media (hover: hover) { .tk-link:hover { text-decoration: underline; text-underline-offset: 1px; } }
  .tk-body { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 6px; user-select: text; }
  .tk-pre { background: var(--userbubble); border: 1px solid var(--divider); border-radius: 8px; padding: 8px 10px; margin: 0;
    font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; color: var(--text); }
  .tk-out { font-size: 13px; line-height: 18px; color: var(--serif); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
  .tk-note { font-size: 13px; line-height: 18px; color: var(--muted); }

  .shine { color: var(--text); background-image: linear-gradient(120deg, var(--sh-edge) 25%, var(--sh-mid) 50%, var(--sh-edge) 75%);
    background-size: 200% 100%; background-position: 150% 0; -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; animation: tkShine 3s infinite; }
  @keyframes tkShine { 0%, 22% { background-position: 150% 0; animation-timing-function: cubic-bezier(.5,.05,.45,.95); } 76%, 100% { background-position: -50% 0; } }
  @media (prefers-reduced-motion: reduce) { .shine { animation: none; background-position: 50% 0; } .tk.focused { animation: none; } }
  .t7 { color: var(--serif); }
  .crit { color: var(--crit); }
  .num { font-variant-numeric: tabular-nums; }
</style>
