<script>
  // 官方 /code 页侧栏「Agent」转录面板 DH（规格 agent-tool-card.md §3）：Model 行 / prompt 气泡 /
  // 逐条 entries（正文 markdown、工具组、思考占位）/ 运行中菊花 / 最终回复 /
  // 「Agent · Completed · tokens · tool uses · 时长」状态行。
  //
  // 两种宿主：
  //   · Agent 工具的子 agent（agent = null）：直播 entries 来自 chat 内核挂在工具行 task.entries 上的
  //     agent_msg；历史（重开会话）没有这些事件，任务结束后按 task.taskId 拉磁盘转录一次。
  //   · 动态工作流里的 agent（agent = workflow_progress 里那条 workflow_agent 记录，TasksPanel 每帧按 index
  //     现取最新那份传进来）：SDK 帧分不出是哪个 agent 的，一律走磁盘转录
  //     /api/claude/agent-transcript?agentId=<agentId>（服务端会到 subagents/workflows/<wf>/ 下找）。
  //
  // 懒同步（bridge 偏离，09-30）：这个视图挂着才拉——工作流卡、agent 表都不预取。agent 还在跑时每 2s 拉一次，
  // 带上次的字节 offset 只要新追加的条目（服务端只解析新行，前端 mergeEntries 接上）；页面隐藏不拉，
  // 切回来立刻补一拉；agent 落定后再补最后一拉收尾巴、停表。结束了的 agent 打开=整读一次（历史完整记录）。
  // 排队中的 agent 还没有 agentId、磁盘上也没有转录：先显示 progress 帧里的 promptPreview（CLI 截在 400 字），
  // 一启动拿到 agentId 就自动换成磁盘上的全文。
  // 拉到的结果留在组件本地 fetched 里，不回写 task（单写者规则）。
  import { untrack, tick } from 'svelte';
  import { session, prefs } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { onMdClick } from '../../lib/linkNav.js';
  import { toolTaskStatus } from '../../lib/taskModel.js';
  import { modelLabel, mcpDisplayName, fmtCompact, fmtDurPanel } from '../../lib/toolVerbs.js';
  import { mergeEntries } from '../../lib/agentTranscript.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { t } from '../../lib/i18n.js';
  import ClaudeLogo from '../ClaudeLogo.svelte';
  import ClaudeWorkingMark from '../ClaudeWorkingMark.svelte';
  import ClaudeSpriteMark from '../ClaudeSpriteMark.svelte';
  import { toolActivity } from '../../lib/workingMark.js';

  let { tool, agent = null } = $props();

  const POLL_MS = 2000;
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const STATUS_WORD = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', pending: 'Queued' };

  const task = $derived(tool.task || null);
  const isWf = $derived(!!agent);
  const taskStatus = $derived(toolTaskStatus(tool));
  // 工作流 agent 的状态：done→completed、error→failed、progress→running；start 有 agentId = 已启动（CLI 在
  // 第一条进度前一直报 start）→ running，没有 agentId = 还在排队 → pending；
  // 工作流本身已结束而 agent 还没落定 → 按工作流终态（chat 内核 settleProgress 通常已把它改成 error）
  const status = $derived.by(() => {
    if (!isWf) return taskStatus;
    if (agent.state === 'done') return 'completed';
    if (agent.state === 'error') return 'failed';
    if (taskStatus !== 'running') return taskStatus === 'completed' ? 'completed' : taskStatus;
    return agent.state === 'start' && !agent.agentId ? 'pending' : 'running';
  });
  const running = $derived(status === 'running' || status === 'pending');
  const agentId = $derived(isWf ? String(agent.agentId || '') : (task ? String(task.taskId || '') : ''));
  const liveEntries = $derived(!isWf && task && Array.isArray(task.entries) ? task.entries : []);

  // —— 磁盘转录（懒同步）——
  const EMPTY = { key: '', state: 'idle', entries: [], model: '', prompt: '', offset: 0 };
  let fetched = $state(EMPTY);
  let reqSeq = 0, inflight = false;
  const fkey = $derived(agentId && session.id ? session.id + ':' + agentId : '');
  const wantFetch = $derived(!!fkey && (isWf || (!running && !liveEntries.length)));
  async function load(key, id) {
    if (inflight) return;   // 上一拉还没回：跳过这一拍（增量靠 offset 串行，并发会重复拼接）
    const cur = untrack(() => fetched);
    const inc = cur.key === key && cur.state === 'ok' && cur.offset > 0;
    const seq = ++reqSeq;
    inflight = true;
    const url = '/api/claude/agent-transcript?session=' + encodeURIComponent(session.id) + '&agentId=' + encodeURIComponent(id)
      + (inc ? '&from=' + cur.offset : '');
    try {
      const r = await api.get(url);
      if (seq !== reqSeq) return;
      const offset = (r && r.offset) || 0;
      if (inc && r && r.delta) {
        // 增量：没新行就什么都不换（免得列表白重渲染、滚动位置跳）
        const more = Array.isArray(r.entries) ? r.entries : [];
        if (more.length) fetched = { ...cur, entries: mergeEntries(cur.entries, more), model: cur.model || r.model || '', offset };
        else if (offset !== cur.offset) fetched = { ...cur, offset };
        return;
      }
      fetched = { key, state: 'ok', entries: Array.isArray(r && r.entries) ? r.entries : [], model: (r && r.model) || '', prompt: (r && r.prompt) || '', offset };
    } catch (e) {
      if (seq !== reqSeq) return;
      if (cur.key === key && cur.state === 'ok') return;   // 轮询失败一次：留着上次拉到的
      // agent 刚启动、转录文件还没落盘也是 404：运行中按「还没东西」处理，下一拍再来
      fetched = { ...EMPTY, key, state: e && e.status === 404 ? 'none' : 'error' };
    } finally {
      if (seq === reqSeq) inflight = false;
    }
  }
  $effect(() => {
    if (!wantFetch) return;
    const key = fkey, id = agentId, poll = isWf && running;
    if (untrack(() => fetched.key) !== key) { reqSeq++; inflight = false; fetched = { ...EMPTY, key, state: 'loading' }; }
    load(key, id);   // 首拉；running 翻成 false 时 effect 重跑，顺手补最后一拉把尾巴收全
    if (!poll) return;
    const visible = () => typeof document === 'undefined' || !document.hidden;
    const tid = setInterval(() => { if (visible()) load(key, id); }, POLL_MS);
    const onVis = () => { if (visible()) load(key, id); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(tid); document.removeEventListener('visibilitychange', onVis); };
  });
  const fx = $derived(fkey && fetched.key === fkey ? fetched : null);
  const entries = $derived(liveEntries.length ? liveEntries : (fx && fx.state === 'ok' ? fx.entries : []));
  const model = $derived(isWf ? (agent.model || (fx ? fx.model : '')) : (task ? (task.model || (fx ? fx.model : '')) : ''));
  const diskPrompt = $derived(fx && fx.state === 'ok' ? fx.prompt : '');
  const prompt = $derived(isWf ? (diskPrompt || agent.promptPreview || '') : (task ? (task.prompt || diskPrompt) : ''));
  // 只拿到 progress 帧的 400 字预览（排队中 / 转录还没拉到）且确实被截过：标出来，别让人以为这就是全文
  const promptIsPreview = $derived(isWf && !diskPrompt && /…$/.test(String(agent.promptPreview || '')));

  // —— 提示词查看块：超过 ~10 行折叠（渐隐 + 展开），可复制 ——
  let promptOpen = $state(false);
  let promptEl = $state();
  let promptOverflow = $state(false);
  $effect(() => {
    void prompt;
    const el = promptEl, open = promptOpen;
    if (!el) return;
    const measure = () => { promptOverflow = open || el.scrollHeight > el.clientHeight + 2; };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  let copied = $state(false);
  async function copyPrompt() {
    const txt = prompt;
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); }
    catch {  // WebView/旧浏览器兜底
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    copied = true;
    setTimeout(() => (copied = false), 1400);
  }

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
      if (lt.startsWith(finalText.replace(/…$/, ''))) return list;
      if (finalText.startsWith(lt)) { list[list.length - 1] = { kind: 'text', text: finalText }; return list; }
    }
    list.push({ kind: 'text', text: finalText });
    return list;
  });
  const errorText = $derived(isWf ? String(agent.error || '') : (task && status === 'failed' ? String(task.error || '') : ''));
  const noResultText = $derived(status === 'failed' ? 'No result — task failed' : status === 'stopped' ? 'No result — task stopped' : 'No result — task ended');
  // 运行中那一行：工作流 agent 的 progress 帧自带「最近一次工具」（lastToolName/lastToolSummary），不用等磁盘
  const liveLine = $derived.by(() => {
    if (status === 'pending') return t('排队中，等待启动…');
    if (isWf && agent.lastToolName) return [mcpDisplayName(agent.lastToolName) || agent.lastToolName, agent.lastToolSummary].filter(Boolean).join(' · ');
    return 'Thinking…';
  });

  // 跟随：运行中新条目进来时，如果用户本来就停在底部，就继续贴底（在读上面的提示词/旧内容时不打扰）
  let rootEl = $state();
  let stick = false;
  const scroller = () => (rootEl ? rootEl.closest('.tp-scroll') : null);
  $effect.pre(() => {
    void shown; void liveLine;
    const sc = untrack(scroller);
    stick = !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
  });
  $effect(() => {
    void shown; void liveLine;
    if (!untrack(() => running) || !stick) return;
    tick().then(() => { const sc = scroller(); if (sc) sc.scrollTop = sc.scrollHeight; });
  });

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
  // 同步中（工作流 agent 运行中、这个视图开着）：状态行前挂一个呼吸点
  const syncing = $derived(isWf && running && !!fkey);
</script>

<div class="tr" bind:this={rootEl}>
  {#if model}<p class="tr-model">Model <span class="t7">{modelLabel(model) || model}</span></p>{/if}
  {#if prompt}
    <section class="pv" aria-label={t('提示词')}>
      <div class="pv-head">
        <span class="pv-label">{t('提示词')}</span>
        {#if promptIsPreview}<span class="pv-tag" title={t('排队中的 agent 只有前 400 字预览，启动后自动载入全文')}>{t('预览')}</span>{/if}
        <span class="pv-len num">{t('{n} 字', { n: prompt.length })}</span>
        <button type="button" class="pv-btn" onclick={copyPrompt} aria-label={copied ? t('已复制') : t('复制提示词')} title={copied ? t('已复制') : t('复制提示词')}>
          <span class="gi" aria-hidden="true">{glyph(copied ? 'Check' : 'Copy')}</span>
        </button>
      </div>
      <div class="pv-body sel-text" class:clamped={!promptOpen} class:fade={!promptOpen && promptOverflow} bind:this={promptEl}>{prompt}</div>
      {#if promptOverflow}
        <button type="button" class="pv-more" aria-expanded={promptOpen} onclick={() => (promptOpen = !promptOpen)}>
          <span class="gi xs" aria-hidden="true">{glyph(promptOpen ? 'CaretDown' : 'CaretRight')}</span>{promptOpen ? t('收起') : t('展开完整提示词')}
        </button>
      {/if}
    </section>
  {/if}
  {#each shown as en, i (i)}
    {#if en.kind === 'text'}
      <!-- 点击只做链接分流（linkNav：外链走系统浏览器、路径式链接不许整页跳走），非交互容器 -->
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="tr-md sel-text" onclick={onMdClick}>{@html renderMarkdown(en.text)}</div>
    {:else if en.kind === 'tools'}
      <div class="tr-tools">
        {#each en.tools as tl, j (j)}
          <div class="tr-tool"><span class="tr-tname">{mcpDisplayName(tl.name) || tl.name || 'Tool'}</span>{#if tl.summary}<span class="tr-tsum">{tl.summary}</span>{/if}</div>
        {/each}
      </div>
    {:else if en.kind === 'thinking'}
      <div class="tr-think">Thinking…</div>
    {/if}
  {/each}
  {#if errorText}<p class="tr-err sel-text">{errorText}</p>{/if}
  {#if running}
    <div class="tr-star" role="status">{#if prefs.claudeMark === 'classic'}<ClaudeLogo anim="thinking" size={18} />{:else if prefs.claudeMark === 'sprite'}<ClaudeSpriteMark phase={status === 'pending' ? 'pending' : 'working'} box={18} />{:else}<ClaudeWorkingMark standalone size={18} activity={status === 'pending' ? 'default' : isWf && agent.lastToolName ? toolActivity(agent.lastToolName, null, true) : 'think'} />{/if}<span class="tr-live">{liveLine}</span></div>
  {:else if fx && fx.state === 'loading'}
    <div class="tr-note">Loading transcript…</div>
  {:else if !shown.length}
    <!-- 官方 DH：有 prompt 却没正文/结果 → "No result — task {failed|stopped|ended}"；什么都没有（含转录 404）→ 空态 "No activity yet" -->
    <div class="tr-note">{(fx && fx.state === 'none') || !prompt ? 'No activity yet' : noResultText}</div>
  {/if}
  <p class="tr-status num">{#if syncing}<span class="tr-sync" title={t('实时同步中（只在这个视图开着时）')}></span>{/if}{agentLine}</p>
</div>

<style>
  .tr { display: flex; flex-direction: column; gap: 10px; overflow-wrap: anywhere; }
  .tr-model { font-size: 12.5px; line-height: 16px; color: var(--muted); margin: 0; }

  /* 提示词查看块：Thread 用户气泡同底（--userbubble、r14），通栏；标题行（提示词 · 预览 · 字数 · 复制）+
     正文等宽保留换行，默认夹到 ~10 行、底部渐隐，点「展开完整提示词」放开 */
  .pv { display: flex; flex-direction: column; gap: 6px; background: var(--userbubble); border-radius: 14px; padding: 8px 12px 10px; }
  .pv-head { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: 12.5px; line-height: 16px; color: var(--muted); }
  .pv-label { color: var(--serif); font-weight: 500; }
  .pv-tag { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--divider); cursor: help; }
  .pv-len { margin-left: auto; }
  .pv-btn { width: 24px; height: 24px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  @media (hover: hover) { .pv-btn:hover { background: var(--hover); color: var(--text); } }
  .pv-body { font-size: 13.5px; line-height: 1.55; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .pv-body.clamped { max-height: calc(1.55em * 10); overflow: hidden; }
  .pv-body.fade { -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent); mask-image: linear-gradient(to bottom, #000 62%, transparent); }
  .pv-more { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; margin-left: -2px; padding: 2px 6px 2px 2px; border-radius: 6px;
    font-size: 12.5px; line-height: 16px; color: var(--muted); }
  @media (hover: hover) { .pv-more:hover { color: var(--text); background: var(--hover); } }
  /* Anthropicons 字形（与 WorkflowDetail 同轴位） */
  .gi { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 16, "wght" 533;
    font-size: 16px; line-height: 1; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .gi.xs { font-size: 12px; width: 12px; height: 12px; font-variation-settings: "opsz" 12, "wght" 620; }

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
  .tr-star { display: flex; align-items: center; gap: 8px; min-height: 20px; min-width: 0; }
  .tr-live { flex: 1; min-width: 0; font-size: 13px; line-height: 18px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tr-note { font-size: 13px; line-height: 18px; color: var(--muted); }
  .tr-status { font-size: 12.5px; line-height: 16px; color: var(--muted); padding-top: 8px; border-top: 1px solid var(--divider); margin: 0; display: flex; align-items: center; }
  /* 同步呼吸点：只在「运行中 + 视图开着」出现，关掉视图就不再同步 */
  .tr-sync { width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 7px; flex: none; animation: trSync 1.6s ease-in-out infinite; }
  @keyframes trSync { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .tr-sync { animation: none; opacity: .7; } }
  .t7 { color: var(--serif); }
  .num { font-variant-numeric: tabular-nums; }
</style>
