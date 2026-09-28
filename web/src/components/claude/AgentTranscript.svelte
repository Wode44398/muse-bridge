<script>
  // 官方 /code 页侧栏「Agent」转录面板 DH（规格 agent-tool-card.md §3）：Model 行 / prompt 气泡 /
  // 逐条 entries（正文 markdown、工具组、思考占位）/ 运行中菊花 / 最终回复 /
  // 「Agent · Completed · tokens · tool uses · 时长」状态行。
  //
  // 两种宿主：
  //   · Agent 工具的子 agent（agent = null）：直播 entries 来自 chat 内核挂在工具行 task.entries 上的
  //     agent_msg；历史（重开会话）没有这些事件，任务结束后按 task.taskId 拉磁盘转录一次。
  //   · 动态工作流里的 agent（agent = workflow_progress 里那条 workflow_agent 记录）：SDK 帧分不出是哪个
  //     agent 的，一律走磁盘转录 /api/claude/agent-transcript?agentId=<agentId>（服务端会到
  //     subagents/workflows/<wf>/ 下找），agent 还在跑时每 5s 轮询（官方 teleport 回填同款节拍）。
  // 拉到的结果留在组件本地 fetched 里，不回写 task（单写者规则）。
  import { untrack } from 'svelte';
  import { session } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { onMdClick } from '../../lib/linkNav.js';
  import { toolTaskStatus } from '../../lib/taskModel.js';
  import { modelLabel, mcpDisplayName, fmtCompact, fmtDurPanel } from '../../lib/toolVerbs.js';
  import ClaudeLogo from '../ClaudeLogo.svelte';

  let { tool, agent = null } = $props();

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const STATUS_WORD = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', pending: 'Queued' };

  const task = $derived(tool.task || null);
  const isWf = $derived(!!agent);
  const taskStatus = $derived(toolTaskStatus(tool));
  // 工作流 agent 的状态：done→completed、error→failed、start→pending（排队）、progress→running；
  // 工作流本身已结束而 agent 还没落定 → 按工作流终态（chat 内核 settleProgress 通常已把它改成 error）
  const status = $derived.by(() => {
    if (!isWf) return taskStatus;
    if (agent.state === 'done') return 'completed';
    if (agent.state === 'error') return 'failed';
    if (taskStatus !== 'running') return taskStatus === 'completed' ? 'completed' : taskStatus;
    return agent.state === 'start' ? 'pending' : 'running';
  });
  const running = $derived(status === 'running' || status === 'pending');
  const agentId = $derived(isWf ? String(agent.agentId || '') : (task ? String(task.taskId || '') : ''));
  const liveEntries = $derived(!isWf && task && Array.isArray(task.entries) ? task.entries : []);

  // —— 磁盘转录 ——
  let fetched = $state({ key: '', state: 'idle', entries: [], model: '', prompt: '', mtime: 0 });
  let reqSeq = 0;
  const fkey = $derived(agentId && session.id ? session.id + ':' + agentId : '');
  const wantFetch = $derived(!!fkey && (isWf || (!running && !liveEntries.length)));
  async function load(key, id) {
    const seq = ++reqSeq;
    const url = '/api/claude/agent-transcript?session=' + encodeURIComponent(session.id) + '&agentId=' + encodeURIComponent(id);
    try {
      const r = await api.get(url);
      if (seq !== reqSeq) return;
      const next = { key, state: 'ok', entries: Array.isArray(r && r.entries) ? r.entries : [], model: (r && r.model) || '', prompt: (r && r.prompt) || '', mtime: (r && r.mtime) || 0 };
      // 轮询：文件没动就别换对象（免得列表白重渲染、滚动位置跳）
      if (fetched.key === key && fetched.state === 'ok' && fetched.mtime && fetched.mtime === next.mtime) return;
      fetched = next;
    } catch (e) {
      if (seq !== reqSeq) return;
      if (fetched.key === key && fetched.state === 'ok') return;   // 轮询失败一次：留着上次拉到的
      fetched = { key, state: e && e.status === 404 ? 'none' : 'error', entries: [], model: '', prompt: '', mtime: 0 };
    }
  }
  $effect(() => {
    if (!wantFetch) return;
    const key = fkey, id = agentId, poll = isWf && running;
    if (untrack(() => fetched.key) !== key) fetched = { key, state: 'loading', entries: [], model: '', prompt: '', mtime: 0 };
    load(key, id);   // 首拉；running 翻成 false 时 effect 重跑，顺手补最后一拉把尾巴收全
    if (!poll) return;
    const t = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) load(key, id); }, 5000);
    return () => clearInterval(t);
  });
  const fx = $derived(fkey && fetched.key === fkey ? fetched : null);
  const entries = $derived(liveEntries.length ? liveEntries : (fx && fx.state === 'ok' ? fx.entries : []));
  const model = $derived(isWf ? (agent.model || (fx ? fx.model : '')) : (task ? (task.model || (fx ? fx.model : '')) : ''));
  const prompt = $derived(isWf ? ((fx && fx.prompt) || agent.promptPreview || '') : (task ? (task.prompt || (fx ? fx.prompt : '')) : ''));

  // 最终回复：Agent = task.result（历史同步 Agent 的 tool_result）或完成通知的 summary；工作流 agent = resultPreview。
  // 官方 Sr：若转录最后一段正文是它的前缀就替换、它是最后一段的前缀（截断版）就不重复。
  const finalText = $derived.by(() => {
    if (isWf) return agent.state === 'done' ? String(agent.resultPreview || '').trim() : '';
    if (!task) return '';
    return String(task.result || (status === 'completed' ? task.summary : '') || '').trim();
  });
  const shown = $derived.by(() => {
    const list = entries.slice();
    if (!finalText) return list;
    const last = list[list.length - 1];
    if (last && last.kind === 'text') {
      const lt = String(last.text || '').trim();
      if (lt.startsWith(finalText)) return list;
      if (finalText.startsWith(lt)) { list[list.length - 1] = { kind: 'text', text: finalText }; return list; }
    }
    list.push({ kind: 'text', text: finalText });
    return list;
  });
  const errorText = $derived(isWf ? String(agent.error || '') : (task && status === 'failed' ? String(task.error || '') : ''));
  const noResultText = $derived(status === 'failed' ? 'No result — task failed' : status === 'stopped' ? 'No result — task stopped' : 'No result — task ended');

  // 秒级时钟：只在 running 时走
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  const timeText = $derived.by(() => {
    if (isWf) {
      if (running) return agent.startedAt ? fmtDurPanel(Math.max(0, now - agent.startedAt)) : '';
      return agent.durationMs ? fmtDurPanel(agent.durationMs) : '';
    }
    if (running) return task && task.startedAt ? fmtDurPanel(Math.max(0, now - task.startedAt)) : '';
    const ms = (task && task.usage && task.usage.ms) || (task && task.endedAt && task.startedAt ? task.endedAt - task.startedAt : 0) || tool.ms || 0;
    return ms > 0 ? fmtDurPanel(ms) : '';
  });
  const agentLine = $derived.by(() => {
    const parts = ['Agent', STATUS_WORD[status] || cap(status)];
    const tokens = isWf ? (agent.tokens || 0) : (task && task.usage ? task.usage.tokens : 0);
    if (tokens) parts.push(fmtCompact(tokens) + ' tokens');
    const tu = isWf ? (agent.toolCalls || 0) : (task ? (task.usage ? task.usage.toolUses : task.toolCount) : 0);
    if (tu) parts.push(tu + (tu === 1 ? ' tool use' : ' tool uses'));
    if (timeText) parts.push(timeText);
    return parts.join(' · ');
  });
</script>

<div class="tr">
  {#if model}<p class="tr-model">Model <span class="t7">{modelLabel(model) || model}</span></p>{/if}
  {#if prompt}<div class="tr-user"><div class="bubble sel-text">{prompt}</div></div>{/if}
  {#each shown as en, i (i)}
    {#if en.kind === 'text'}
      <!-- 点击只做链接分流（linkNav：外链走系统浏览器、路径式链接不许整页跳走），非交互容器 -->
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="tr-md sel-text" onclick={onMdClick}>{@html renderMarkdown(en.text)}</div>
    {:else if en.kind === 'tools'}
      <div class="tr-tools">
        {#each en.tools as t, j (j)}
          <div class="tr-tool"><span class="tr-tname">{mcpDisplayName(t.name) || t.name || 'Tool'}</span>{#if t.summary}<span class="tr-tsum">{t.summary}</span>{/if}</div>
        {/each}
      </div>
    {:else if en.kind === 'thinking'}
      <div class="tr-think">Thinking…</div>
    {/if}
  {/each}
  {#if errorText}<p class="tr-err sel-text">{errorText}</p>{/if}
  {#if running}
    <div class="tr-star" role="status"><ClaudeLogo anim="thinking" size={18} /><span class="sr">{status === 'pending' ? 'Queued…' : 'Thinking…'}</span></div>
  {:else if fx && fx.state === 'loading'}
    <div class="tr-note">Loading transcript…</div>
  {:else if !shown.length}
    <!-- 官方 DH：有 prompt 却没正文/结果 → "No result — task {failed|stopped|ended}"；什么都没有（含转录 404）→ 空态 "No activity yet" -->
    <div class="tr-note">{(fx && fx.state === 'none') || !prompt ? 'No activity yet' : noResultText}</div>
  {/if}
  <p class="tr-status num">{agentLine}</p>
</div>

<style>
  .tr { display: flex; flex-direction: column; gap: 10px; overflow-wrap: anywhere; }
  .tr-model { font-size: 12.5px; line-height: 16px; color: var(--muted); margin: 0; }
  .tr-user { display: flex; justify-content: flex-end; }
  /* prompt 气泡：复用 Thread 用户气泡视觉（--userbubble 底、r14） */
  .bubble { background: var(--userbubble); color: var(--text); border-radius: 14px; padding: 10px 15px; font-size: 14px; line-height: 1.5;
    max-width: 100%; word-break: break-word; white-space: pre-wrap; }
  /* 紧凑 markdown（官方 xd size="sm"）：14px、段距 8 */
  .tr-md { font-size: 14px; line-height: 1.55; color: var(--text); min-width: 0; overflow-wrap: break-word; }
  .tr-md :global(p) { margin: 0 0 8px; }
  .tr-md :global(p:last-child) { margin-bottom: 0; }
  .tr-md :global(h1), .tr-md :global(h2), .tr-md :global(h3) { font-size: 15px; margin: 10px 0 6px; line-height: 1.3; }
  .tr-md :global(ul), .tr-md :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .tr-md :global(li) { margin: 2px 0; }
  .tr-md :global(pre) { background: var(--userbubble); border: 1px solid var(--divider); border-radius: 10px; padding: 10px 12px; overflow-x: auto; margin: 0 0 8px; font-size: 12.5px; }
  .tr-md :global(code) { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: .9em; }
  .tr-md :global(:not(pre) > code) { background: var(--hover); padding: 1px 5px; border-radius: 5px; }
  .tr-md :global(a) { color: var(--coral); }
  .tr-md :global(img) { max-width: 100%; border-radius: 8px; }
  .tr-md :global(table) { border-collapse: collapse; font-size: 12.5px; margin: 0; }
  .tr-md :global(th), .tr-md :global(td) { border: 1px solid var(--divider); padding: 4px 8px; }
  /* 子 agent 的工具调用：小行列表（名 + 摘要），描边卡 + 分隔线 */
  .tr-tools { display: flex; flex-direction: column; border-radius: 8px; box-shadow: 0 0 0 1px var(--divider); overflow: hidden; }
  .tr-tool { display: flex; align-items: baseline; gap: 6px; padding: 6px 10px; font-size: 13px; line-height: 18px; min-width: 0; }
  .tr-tool + .tr-tool { border-top: 1px solid var(--divider); }
  .tr-tname { flex: none; color: var(--serif); }
  .tr-tsum { flex: 1; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tr-think { font-size: 13px; line-height: 18px; color: var(--muted); font-style: italic; }
  .tr-err { font-size: 13px; line-height: 18px; color: var(--crit); white-space: pre-wrap; margin: 0; }
  .tr-star { display: flex; align-items: center; height: 20px; }
  .tr-note { font-size: 13px; line-height: 18px; color: var(--muted); }
  .tr-status { font-size: 12.5px; line-height: 16px; color: var(--muted); padding-top: 8px; border-top: 1px solid var(--divider); margin: 0; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .t7 { color: var(--serif); }
  .num { font-variant-numeric: tabular-nums; }
</style>
