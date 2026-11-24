<script>
  // Antigravity 右侧工作区「代理」面板（对标 Claude WorkflowDetail + TasksPanel）：
  //   · 列表态：按运行中 / 已完成分组；每张团队卡以四列结构化表（代理 | 模型 · 强度 | Tokens | 时长）
  //     直接展示整棵多层子代理树的实时运行状态、模型名、思考强度（effort）、token 消耗、耗时与当前步骤/报错；
  //   · 转录态：点击任意代理（含总协调器、项目编排器或任意叶子子代理）压入 agentStack，查看完整对话与工具调用记录。
  import { tick, untrack } from 'svelte';
  import { agyDock, pushAgyAgentTranscript, popAgyAgentTranscript } from '../../lib/dock.svelte.js';
  import { agy } from '../../lib/agy/store.svelte.js';
  import { fmtElapsed } from '../../lib/format.js';
  import {
    agySubagents,
    refreshAgySubagents,
    syncAgySubagents,
    findSubagentInStore,
    flattenSubtree,
    agentModelInfo,
    fmtCompactTokens as fmtTokens,
    subagentStatusLabel,
    subagentKindLabel,
  } from '../../lib/agy/subagents.svelte.js';
  import {
    agySwarm,
    refreshAgySwarm,
    findSwarmMemberByConvId,
  } from '../../lib/agy/swarm.svelte.js';
  import { t, tc } from '../../lib/i18n.js';
  import { cronLabel, timerMs, fmtSpan, fmtLeft, BG_STALL_MS } from '../../lib/agy/run-status.js';
  import AgyAgentDots from './AgyAgentDots.svelte';
  import AgyAgentTranscript from './AgyAgentTranscript.svelte';
  import AgySwarmPanel from './swarm/AgySwarmPanel.svelte';

  const { wide = true } = $props();

  const tree = $derived(agySubagents.tree);
  const swarmSnap = $derived(
    agySwarm.sessionId === agy.sessionId && agySwarm.data?.hasSwarm ? agySwarm.data : null
  );
  const swarmMemberConvIds = $derived(
    new Set((swarmSnap?.members || []).map((m) => m.conversationId).filter(Boolean))
  );
  // 若 agy 同时把 Swarm 成员登记在 subagents/ 中，过滤掉已由 Swarm 面板承载的成员，避免同一代理上下重复显示
  const agents = $derived(
    (Array.isArray(tree?.agents) ? tree.agents : []).filter((a) => !swarmMemberConvIds.has(a.id))
  );
  const parentTasks = $derived(Array.isArray(tree?.parentTasks) ? tree.parentTasks : []);
  // 主会话自己挂着的后台任务：在跑的摆前面，结束了的收进「已结束 N」
  const runningTasks = $derived(parentTasks.filter((x) => x.status === 'running').sort((a, b) => (b.at || 0) - (a.at || 0)));
  const endedTasks = $derived(parentTasks.filter((x) => x.status !== 'running').sort((a, b) => (b.at || 0) - (a.at || 0)));
  let endedTasksOpen = $state(false);
  const hasActive = $derived(Boolean(tree?.hasActive || swarmSnap?.hasActive));
  const activeCount = $derived((Number(tree?.counts?.active) || 0) + (Number(swarmSnap?.summary?.workingCount) || 0));

  const runningGroups = $derived(agents.filter((a) => a.status === 'running' || a.status === 'waiting' || (a.subtreeCounts?.active || 0) > 0));
  const finishedGroups = $derived(agents.filter((a) => !(a.status === 'running' || a.status === 'waiting' || (a.subtreeCounts?.active || 0) > 0)));

  let finishedOpen = $state(true);
  let collapsed = $state({});
  let listEl = $state(null);
  let flashId = $state('');

  const topAgentId = $derived(agyDock.agentStack.length ? agyDock.agentStack[agyDock.agentStack.length - 1] : '');
  const topSwarmMember = $derived(topAgentId ? findSwarmMemberByConvId(topAgentId) : null);
  const topAgent = $derived(topAgentId ? findSubagentInStore(topAgentId) : null);

  // 面板初次打开或切换会话时拉取一次（用 untrack 隔开对 agySubagents.tree 的读取，防赋值触发死循环）
  $effect(() => {
    const sid = agy.sessionId;
    if (!sid) return;
    untrack(() => {
      refreshAgySubagents(sid, { silent: Boolean(agySubagents.tree) });
      refreshAgySwarm(sid, { silent: Boolean(agySwarm.data) });
    });
  });

  // 面板打开期间、有活跃代理或未结束 Swarm 时每 2.5s 静默刷新（页面隐藏时暂停）
  $effect(() => {
    const sid = agy.sessionId;
    const keepPolling = hasActive || agy.busy || Boolean(swarmSnap && !swarmSnap.finished && swarmSnap.hasLiveWorkers);
    if (!sid || !keepPolling) return;
    const isVisible = () => typeof document === 'undefined' || !document.hidden;
    const tid = setInterval(() => {
      if (isVisible()) {
        untrack(() => {
          refreshAgySubagents(sid, { silent: true });
          refreshAgySwarm(sid, { silent: true });
        });
      }
    }, 2500);
    return () => clearInterval(tid);
  });

  // 实时计时时钟（仅活跃态走）
  let now = $state(Date.now());
  $effect(() => {
    if (!hasActive) return;
    now = Date.now();
    const tid = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(tid);
  });

  // 从对话卡片点进来定位高亮
  $effect(() => {
    const focus = agyDock.agentsFocus;
    if (!focus?.agentId || topAgentId) return;
    const targetId = focus.agentId;
    flashId = targetId;
    tick().then(() => {
      const el = listEl?.querySelector?.(`[data-agent-id="${CSS.escape(targetId)}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const tid = setTimeout(() => { flashId = ''; }, 1700);
    return () => clearTimeout(tid);
  });

  function isExpanded(node) {
    if (node.id in collapsed) return !collapsed[node.id];
    return true;
  }
  function toggleExpand(node) {
    collapsed[node.id] = isExpanded(node);
  }
  function durOf(node) {
    if (!node) return '';
    if ((node.status === 'running' || node.status === 'waiting') && node.spawnedAt > 0) {
      return fmtElapsed(Math.max(0, now - node.spawnedAt));
    }
    return node.durationMs > 0 ? fmtElapsed(node.durationMs) : '';
  }

  // 把递归树按 DFS 摊平为带缩进层级的行列表，方便在四列表格里一眼看完所有层级代理的状态、模型与 effort
  function tableRowsOf(root) {
    const out = [];
    const walk = (n, depth) => {
      out.push({ node: n, depth });
      if (Array.isArray(n.children) && n.children.length) {
        for (const ch of n.children) walk(ch, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }

  function cardStatusOf(node) {
    const active = node.status === 'running' || node.status === 'waiting' || (node.subtreeCounts?.active || 0) > 0;
    if (active) return { text: subagentStatusLabel(node.status === 'waiting' ? 'waiting' : 'running'), tone: node.status === 'waiting' ? 'warn' : 'live' };
    if (node.status === 'error') return { text: subagentStatusLabel('error'), tone: 'err' };
    if ((node.subtreeCounts?.error || 0) > 0) return { text: t('部分出错'), tone: 'err' };
    return { text: subagentStatusLabel(node.status), tone: 'muted' };
  }

  function rowActivityOf(a) {
    const active = a.status === 'running' || a.status === 'waiting';
    if (active && a.lastTool?.name) {
      return { text: [a.lastTool.name, a.lastTool.summary].filter(Boolean).join(' · '), tone: 'live' };
    }
    if (a.status === 'error' && a.lastError) {
      return { text: a.lastError, tone: 'err' };
    }
    if (a.toolCallsCount > 0) {
      return { text: t('{n} 次调用', { n: a.toolCallsCount }), tone: 'muted' };
    }
    return null;
  }

  async function doSync(wake = false) {
    if (!agy.sessionId) return;
    await Promise.all([
      syncAgySubagents(agy.sessionId, { wake }),
      refreshAgySwarm(agy.sessionId, { silent: true, force: true }),
    ]);
  }
</script>

{#snippet agentCard(node)}
  {@const subtree = flattenSubtree(node)}
  {@const nodeActive = node.status === 'running' || node.status === 'waiting' || (node.subtreeCounts?.active || 0) > 0}
  {@const hasChildren = Array.isArray(node.children) && node.children.length > 0}
  {@const open = isExpanded(node)}
  {@const stInfo = cardStatusOf(node)}
  {@const rows = tableRowsOf(node)}
  {@const teamTokens = node.subtreeTokens || node.tokens?.total || 0}
  {@const rootModel = agentModelInfo(node)}
  <article
    class="ag-card"
    class:focused={flashId === node.id}
    data-agent-id={node.id}
  >
    <div class="ag-card-head">
      <div class="ag-card-top">
        <button type="button" class="ag-card-title-btn" onclick={() => pushAgyAgentTranscript(node.id)}>
          <span class="ag-card-title trunc" class:agy-shine={nodeActive}>{node.role}</span>
        </button>
        {#if durOf(node)}<span class="ag-card-dur num">{durOf(node)}</span>{/if}
      </div>

      <div class="ag-card-meta num">
        <span class="ag-kind">{subagentKindLabel(node.kind)}</span>
        <span class="ag-st {stInfo.tone}">{stInfo.text}</span>
        {#if (node.subtreeCounts?.total || 1) > 1}
          <span>{t('{n} 个代理', { n: node.subtreeCounts.total })}</span>
        {/if}
        {#if teamTokens > 0}
          <span>{fmtTokens(teamTokens)} tokens</span>
        {/if}
      </div>

      {#if !hasChildren && rootModel.modelName}
        <div class="ag-card-meta">
          <span class="ag-model-inline">{rootModel.modelName}{#if rootModel.effort}<span class="ag-eff-dot"> · </span><span class="ag-eff-val">{rootModel.effort}</span>{/if}</span>
          {#if node.toolCallsCount > 0}
            <span class="num">{t('{n} 次调用', { n: node.toolCallsCount })}</span>
          {/if}
        </div>
      {/if}

      {#if hasChildren || nodeActive}
        <div class="ag-card-dots-row">
          <AgyAgentDots counts={node.subtreeCounts} agents={subtree} wrap maxRows={4} cols={16} anticipate={nodeActive} />
          <button type="button" class="ag-open-root" onclick={() => pushAgyAgentTranscript(node.id)}>
            <span>{hasChildren ? t('查看协调器对话') : t('查看对话')}</span>
            <span class="msr" aria-hidden="true">expand_more</span>
          </button>
        </div>
      {:else}
        <div class="ag-card-dots-row">
          {#if node.lastMessage}
            <span class="ag-leaf-msg trunc">{node.lastMessage}</span>
          {/if}
          <button type="button" class="ag-open-root" onclick={() => pushAgyAgentTranscript(node.id)}>
            <span>{t('查看对话')}</span>
            <span class="msr" aria-hidden="true">expand_more</span>
          </button>
        </div>
      {/if}

      {#if node.status === 'error' && node.lastError}
        <div class="ag-card-err sel-text">{node.lastError}</div>
      {/if}
    </div>

    {#if hasChildren}
      <div class="ag-tree-sec">
        <button type="button" class="ag-tree-toggle" aria-expanded={open} onclick={() => toggleExpand(node)}>
          <span class="ag-tree-lbl">
            {t('子代理（{done}/{total}）', {
              done: node.subtreeCounts?.done || 0,
              total: node.subtreeCounts?.total || rows.length,
            })}
          </span>
          <span class="msr tr-chev" class:closed={!open} aria-hidden="true">expand_more</span>
        </button>

        {#if open}
          <div class="ag-table-wrap">
            <div class="ag-grid" role="table">
              <span class="ag-h"><span class="ag-st-slot"></span>{tc('agy', '代理')}</span>
              <span class="ag-h ag-model-h">{t('模型')} · {t('思考强度')}</span>
              <span class="ag-h">Tokens</span>
              <span class="ag-h r">{t('时长')}</span>

              {#each rows as row (row.node.id)}
                {@const a = row.node}
                {@const aActive = a.status === 'running' || a.status === 'waiting'}
                {@const aModel = agentModelInfo(a)}
                {@const aAct = rowActivityOf(a)}
                {@const aDim = !aActive && a.status !== 'error'}
                <button
                  type="button"
                  class="ag-c ag-name"
                  class:dim={aDim}
                  style={`--d:${Math.min(row.depth, 4)}`}
                  title={t('查看对话') + ': ' + a.role}
                  onclick={() => pushAgyAgentTranscript(a.id)}
                >
                  <span class="ag-st-slot" aria-label={subagentStatusLabel(a.status)}>
                    {#if a.status === 'running'}
                      <span class="ag-spin"></span>
                    {:else if a.status === 'waiting'}
                      <span class="msr4 warn">schedule</span>
                    {:else if a.status === 'error'}
                      <span class="msr4 err">error</span>
                    {:else if a.status === 'killed'}
                      <span class="msr4 muted">stop_circle</span>
                    {:else}
                      <span class="msr4 ok">check</span>
                    {/if}
                  </span>
                  <span class="ag-nm">
                    <span class="ag-lbl trunc" class:agy-shine={aActive}>{a.role}</span>
                    {#if aModel.modelName}
                      <span class="ag-sub-model trunc">{aModel.modelName}{#if aModel.effort} · {aModel.effort}{/if}</span>
                    {/if}
                    {#if aAct}
                      <span class="ag-sub-act trunc {aAct.tone}" title={aAct.text}>{aAct.text}</span>
                    {/if}
                  </span>
                </button>

                <span class="ag-c ag-model" class:dim={aDim} title={[aModel.modelName, aModel.effort, a.model].filter(Boolean).join(' · ')}>
                  {#if aModel.modelName}
                    <span class="ag-mname">{aModel.modelName}</span>{#if aModel.effort}<span class="ag-msep" aria-hidden="true"> · </span><span class="ag-meff">{aModel.effort}</span>{/if}
                  {:else}
                    <span class="ag-meff">—</span>
                  {/if}
                </span>

                <span class="ag-c num" class:dim={aDim} title={a.tokens?.total ? t('输入 {input} · 缓存 {cache} · 输出 {output}', { input: fmtTokens(a.tokens.input || 0), cache: fmtTokens(a.tokens.cacheRead || 0), output: fmtTokens(a.tokens.output || 0) }) : ''}>
                  {a.tokens?.total > 0 ? fmtTokens(a.tokens.total) : '—'}
                </span>

                <span class="ag-c num r" class:dim={aDim}>
                  {#if a.status === 'error'}
                    <span class="ag-err-tag">{t('出错')}</span>
                  {:else if a.status === 'killed'}
                    <span class="ag-kill-tag">{t('已停止')}</span>
                  {:else}
                    {durOf(a) || '—'}
                  {/if}
                </span>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </article>
{/snippet}

{#snippet bgTaskRow(tk)}
  {@const running = tk.status === 'running'}
  {@const sched = tk.kind === 'cron' || tk.kind === 'timer'}
  {@const quietMs = running && !sched && (tk.logAt || tk.at) ? now - (tk.logAt || tk.at) : 0}
  {@const stalled = quietMs > BG_STALL_MS}
  {@const due = tk.kind === 'timer' ? (tk.at || 0) + timerMs(tk.schedule) : 0}
  <div class="ag-bg-row" class:running>
    <span class="ag-st-slot" aria-hidden="true">
      {#if running && sched}
        <span class="msr4 muted">schedule</span>
      {:else if running}
        <span class="ag-spin" class:stall={stalled}></span>
      {:else if tk.status === 'error'}
        <span class="msr4 err">error</span>
      {:else if tk.status === 'lost'}
        <span class="msr4 muted">stop_circle</span>
      {:else}
        <span class="msr4 muted">check</span>
      {/if}
    </span>
    <span class="ag-bg-main">
      <span class="ag-bg-title trunc" class:agy-shine={running && !sched && !stalled} title={tk.command || tk.title}>{tk.title || tk.id}</span>
      {#if running}
        <span class="ag-bg-sub trunc" class:warn={stalled}>
          {#if tk.kind === 'cron'}
            {t('周期任务')} · {cronLabel(tk.schedule)}
          {:else if tk.kind === 'timer'}
            {t('定时唤醒')} · {due > now ? t('约 {d}后', { d: fmtLeft(due - now) }) : t('马上就到')}
          {:else if stalled}
            {t('{d}没有新输出', { d: fmtLeft(quietMs) })}
          {:else}
            {t('已跑 {d}', { d: fmtSpan(now - (tk.at || now)) })}
          {/if}
        </span>
        {#if tk.logTail}
          <span class="ag-bg-tail trunc" title={tk.logTail}>{tk.logTail}</span>
        {/if}
      {/if}
    </span>
    {#if !running}
      <span class="ag-bg-st" title={tk.status === 'lost' ? t('bridge 或 Antigravity 重启时这个任务还没跑完') : ''}>{tk.status === 'error' ? t('出错') : tk.status === 'lost' ? t('已中断') : t('已结束')}</span>
    {/if}
  </div>
{/snippet}

<div class="ag-ap" class:wide>
  {#if topAgentId}
    <div class="ag-ap-subhead">
      <button
        type="button"
        class="ag-back-btn"
        onclick={popAgyAgentTranscript}
        aria-label={agyDock.agentStack.length > 1 ? t('返回上一级代理') : t('返回代理列表')}
      >
        <span class="msr4">arrow_back</span>
      </button>
      <div class="ag-sub-titles">
        <span class="ag-sub-title trunc" title={topSwarmMember ? `@${topSwarmMember.name}` : (topAgent?.role || topAgentId)}>
          {topSwarmMember ? `@${topSwarmMember.name}` : (topAgent?.role || topAgentId.slice(0, 8))}
        </span>
        {#if agyDock.agentStack.length > 1}
          <span class="ag-sub-depth">{t('第 {n} 层', { n: agyDock.agentStack.length })}</span>
        {/if}
      </div>
      {#if topSwarmMember}
        <span class="ag-sub-kind">{t('多代理协作')}</span>
      {:else if topAgent?.kind}
        <span class="ag-sub-kind">{subagentKindLabel(topAgent.kind)}</span>
      {/if}
    </div>
    {#key topAgentId}
      <div class="ag-ap-scroll tr-pad">
        <AgyAgentTranscript agentId={topAgentId} />
      </div>
    {/key}
  {:else}
    <div class="ag-ap-scroll" bind:this={listEl}>
      {#if swarmSnap}
        <AgySwarmPanel snap={swarmSnap} sessionId={agy.sessionId || ''} />
      {/if}

      {#if hasActive && !swarmSnap}
        <div class="ag-live-band" role="status" aria-live="polite">
          <span class="ag-live-ic" aria-hidden="true"><span class="ag-spin"></span></span>
          <div class="ag-live-main">
            <span class="ag-live-title">
              {activeCount > 0
                ? t('{n} 个后台子代理运行中', { n: activeCount })
                : runningTasks.length > 0
                  ? t('{n} 个后台任务在跑', { n: runningTasks.length })
                  : t('后台任务同步中')}
            </span>
            <p class="ag-live-desc">
              {activeCount > 0
                ? t('子代理汇报到达后会自动推送回对话，无需手动追问。')
                : t('任务结束或定时到点后，Antigravity 会自己接着干，不用手动追问。')}
            </p>
            <div class="ag-live-acts">
              <button type="button" class="ag-sync-btn" disabled={agySubagents.syncing} onclick={() => doSync(true)}>
                <span class="msr">refresh</span>
                <span>{agySubagents.syncing ? t('同步中…') : t('立即检查同步')}</span>
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if (agySubagents.loading || agySwarm.loading) && !swarmSnap && !agents.length && !parentTasks.length}
        <div class="ag-empty">
          <span class="ag-spin"></span>
          <span>{t('正在加载子代理状态…')}</span>
        </div>
      {:else if !swarmSnap && !agents.length && !parentTasks.length}
        <div class="ag-empty">
          <span class="msr4 empty-ic">smart_toy</span>
          <p>{t('多代理任务和后台子代理会显示在这里')}</p>
        </div>
      {:else}
        {#if runningGroups.length > 0}
          <section class="ag-sec">
            <div class="ag-sech">
              <h3>{t('运行中')}</h3>
              <span class="ag-n num">{runningGroups.length}</span>
              <button
                type="button"
                class="ag-mini-refresh"
                disabled={agySubagents.syncing}
                onclick={() => doSync(false)}
                title={t('刷新状态')}
                aria-label={t('刷新状态')}
              >
                <span class="msr">refresh</span>
              </button>
            </div>
            <div class="ag-list">
              {#each runningGroups as node (node.id)}
                {@render agentCard(node)}
              {/each}
            </div>
          </section>
        {/if}

        {#if finishedGroups.length > 0}
          <section class="ag-sec">
            <div class="ag-sech">
              <button type="button" class="ag-fold-sec" aria-expanded={finishedOpen} onclick={() => { finishedOpen = !finishedOpen; }}>
                <h3>{t('已完成')}</h3>
                <span class="ag-n num">{finishedGroups.length}</span>
                <span class="msr" class:closed={!finishedOpen}>expand_more</span>
              </button>
              {#if !runningGroups.length}
                <button
                  type="button"
                  class="ag-mini-refresh"
                  disabled={agySubagents.syncing}
                  onclick={() => doSync(false)}
                  title={t('刷新状态')}
                  aria-label={t('刷新状态')}
                >
                  <span class="msr">refresh</span>
                </button>
              {/if}
            </div>
            {#if finishedOpen}
              <div class="ag-list">
                {#each finishedGroups as node (node.id)}
                  {@render agentCard(node)}
                {/each}
              </div>
            {/if}
          </section>
        {/if}

        {#if parentTasks.length > 0}
          <section class="ag-sec">
            <div class="ag-sech">
              <h3>{t('后台任务')}</h3>
              <span class="ag-n num">{runningTasks.length || parentTasks.length}</span>
            </div>
            <div class="ag-bg-list">
              {#each runningTasks as tk (tk.id)}
                {@render bgTaskRow(tk)}
              {/each}
              {#if endedTasks.length > 0}
                <button type="button" class="ag-bg-fold" aria-expanded={endedTasksOpen} onclick={() => { endedTasksOpen = !endedTasksOpen; }}>
                  <span class="msr" class:closed={!endedTasksOpen} aria-hidden="true">expand_more</span>
                  <span>{t('已结束 {n}', { n: endedTasks.length })}</span>
                </button>
                {#if endedTasksOpen}
                  {#each endedTasks as tk (tk.id)}
                    {@render bgTaskRow(tk)}
                  {/each}
                {/if}
              {/if}
            </div>
          </section>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .ag-ap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--ag-on);
  }
  .ag-ap-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-gutter: stable;
    padding: 8px 12px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ag-ap-scroll.tr-pad {
    padding-top: 10px;
  }

  /* 钻取转录子顶栏 */
  .ag-ap-subhead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 4px 10px 4px 6px;
    border-bottom: 1px solid var(--ag-border);
  }
  .ag-back-btn {
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-sub);
  }
  .ag-back-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .ag-back-btn .msr4 { font-size: 18px; }
  .ag-sub-titles {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .ag-sub-title {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--ag-on);
  }
  .ag-sub-depth {
    flex: none;
    font-size: 11px;
    color: var(--ag-on-faint);
  }
  .ag-sub-kind {
    flex: none;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--ag-surface-2);
    color: var(--ag-on-dim);
  }

  /* 活跃后台横幅 */
  .ag-live-band {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    column-gap: 10px;
    align-items: start;
    padding: 11px 12px;
    border-radius: 12px;
    background: var(--ag-surface-2);
  }
  .ag-live-ic {
    width: 18px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ag-live-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ag-live-title {
    font-size: 13.5px;
    line-height: 20px;
    font-weight: 500;
    color: var(--ag-on);
  }
  .ag-live-desc {
    margin: 0;
    font-size: 12px;
    line-height: 17px;
    color: var(--ag-on-dim);
  }
  .ag-live-acts {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 7px;
  }
  .ag-sync-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    padding: 4px 10px;
    border-radius: 8px;
    font-size: 12px;
    color: var(--ag-on);
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    transition: background 0.14s ease;
  }
  .ag-sync-btn:hover:not(:disabled) { background: var(--ag-hover); }
  .ag-sync-btn:disabled { opacity: 0.55; cursor: default; }
  .ag-sync-btn .msr { font-size: 16px; }

  /* 空态 */
  .ag-empty {
    flex: 1;
    min-height: 180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--ag-on-dim);
    font-size: 13px;
    text-align: center;
  }
  .ag-empty .empty-ic { font-size: 24px; color: var(--ag-on-faint); }
  .ag-empty p { margin: 0; }

  /* 分组 */
  .ag-sec { display: flex; flex-direction: column; gap: 8px; }
  .ag-sech {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 0 2px;
  }
  .ag-sech h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--ag-on-dim);
  }
  .ag-n { font-size: 12px; color: var(--ag-on-faint); }
  .ag-fold-sec {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: 5px;
    color: var(--ag-on-dim);
  }
  .ag-fold-sec:hover { background: var(--ag-hover); color: var(--ag-on); }
  .ag-fold-sec .msr { font-size: 16px; transition: transform 0.16s ease; }
  .ag-fold-sec .msr.closed { transform: rotate(-90deg); }
  .ag-mini-refresh {
    margin-left: auto;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .ag-mini-refresh:hover:not(:disabled) { background: var(--ag-hover); color: var(--ag-on); }
  .ag-mini-refresh .msr { font-size: 16px; }

  /* 团队详细卡（对标 Claude WorkflowDetail） */
  .ag-list { display: flex; flex-direction: column; gap: 10px; }
  .ag-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 11px 11px 12px;
    border-radius: 12px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
  }
  .ag-card.focused {
    animation: agy-card-flash 1.6s ease-out;
  }
  @keyframes agy-card-flash {
    0%, 35% { box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ag-accent) 55%, transparent); }
    100% { box-shadow: none; }
  }
  .ag-card-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ag-card-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .ag-card-title-btn {
    flex: 1;
    min-width: 0;
    text-align: left;
    padding: 0;
    color: inherit;
    display: flex;
  }
  .ag-card-title {
    font-size: 14px;
    line-height: 20px;
    font-weight: 500;
    color: var(--ag-on);
  }
  .ag-card-title-btn:hover .ag-card-title {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .ag-card-dur {
    flex: none;
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .ag-card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    font-size: 12px;
    line-height: 16px;
    color: var(--ag-on-dim);
  }
  .ag-kind { color: var(--ag-on-sub); }
  .ag-st.live { color: var(--ag-accent); }
  .ag-st.warn { color: var(--ag-warn); }
  .ag-st.err { color: var(--ag-err); }
  .ag-model-inline { color: var(--ag-on-sub); }
  .ag-eff-dot { color: var(--ag-on-faint); }
  .ag-eff-val { color: var(--ag-on-dim); }

  .ag-card-dots-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 2px;
  }
  .ag-leaf-msg {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .ag-open-root {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px 8px;
    border-radius: 7px;
    font-size: 11.5px;
    color: var(--ag-accent);
    background: color-mix(in srgb, var(--ag-accent) 10%, transparent);
    transition: background 0.14s ease;
  }
  .ag-open-root:hover {
    background: color-mix(in srgb, var(--ag-accent) 18%, transparent);
  }
  .ag-open-root .msr {
    font-size: 14px;
    transform: rotate(-90deg);
  }

  .ag-card-err {
    font-size: 12px;
    line-height: 16px;
    color: var(--ag-err);
    padding: 6px 8px;
    border-radius: 7px;
    background: var(--ag-err-bg);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* 四列子代理表（对标 Claude WorkflowDetail .ag-grid + container queries） */
  .ag-tree-sec {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--ag-border);
    container-type: inline-size;
  }
  .ag-tree-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 4px;
    border-radius: 6px;
    color: var(--ag-on-sub);
    font-size: 12px;
  }
  .ag-tree-toggle:hover { background: var(--ag-hover); color: var(--ag-on); }
  .ag-tree-lbl { font-weight: 500; }
  .tr-chev {
    font-size: 16px;
    color: var(--ag-on-faint);
    transition: transform 0.16s ease;
  }
  .tr-chev.closed { transform: rotate(-90deg); }

  .ag-table-wrap {
    display: flex;
    flex-direction: column;
  }
  .ag-grid {
    display: grid;
    grid-template-columns: minmax(96px, 1fr) minmax(0, max-content) 54px minmax(48px, max-content);
    align-items: start;
    column-gap: 10px;
    row-gap: 8px;
    padding: 2px 4px 0;
    font-size: 12px;
    line-height: 16px;
  }
  .ag-h {
    color: var(--ag-on-faint);
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--ag-border);
  }
  .ag-h.r, .ag-c.r { text-align: right; justify-self: end; }
  .ag-c {
    color: var(--ag-on-sub);
    min-width: 0;
    white-space: nowrap;
  }
  .ag-c.dim { color: var(--ag-on-dim); }

  .ag-name {
    appearance: none;
    background: none;
    border: 0;
    margin: 0;
    padding: 1px 4px 1px calc(var(--d, 0) * 11px);
    font: inherit;
    text-align: left;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--ag-on);
    width: 100%;
    min-width: 0;
  }
  .ag-name.dim { color: var(--ag-on-sub); }
  @media (hover: hover) {
    .ag-name:hover { background: var(--ag-hover); }
    .ag-name:hover .ag-lbl {
      text-decoration: underline;
      text-underline-offset: 2px;
      color: var(--ag-on);
    }
  }
  .ag-st-slot {
    flex: none;
    width: 14px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ag-st-slot .msr4 { font-size: 14px; }
  .ag-st-slot .msr4.ok { color: var(--ag-ok); }
  .ag-st-slot .msr4.warn { color: var(--ag-warn); }
  .ag-st-slot .msr4.err { color: var(--ag-err); }
  .ag-st-slot .msr4.muted { color: var(--ag-on-faint); }

  .ag-nm {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .ag-lbl {
    font-size: 12.5px;
    line-height: 16px;
    font-weight: 500;
    color: inherit;
  }
  .ag-sub-model {
    display: none;
    font-size: 11px;
    line-height: 15px;
    color: var(--ag-on-dim);
  }
  .ag-sub-act {
    font-size: 11px;
    line-height: 15px;
    color: var(--ag-on-faint);
  }
  .ag-sub-act.live {
    color: var(--ag-accent);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  }
  .ag-sub-act.err {
    color: var(--ag-err);
  }

  .ag-model {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ag-mname { color: var(--ag-on-sub); }
  .ag-msep { color: var(--ag-on-faint); }
  .ag-meff {
    color: var(--ag-on-dim);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11px;
  }
  .ag-err-tag { color: var(--ag-err); font-weight: 500; }
  .ag-kill-tag { color: var(--ag-on-faint); }

  @container (max-width: 440px) {
    .ag-grid {
      grid-template-columns: minmax(110px, 1fr) minmax(0, max-content) 44px minmax(46px, max-content);
      column-gap: 8px;
    }
    .ag-model { white-space: normal; overflow-wrap: anywhere; }
    .ag-msep { display: none; }
    .ag-meff { display: block; }
  }
  @container (max-width: 380px) {
    .ag-grid {
      grid-template-columns: minmax(0, 1fr) max-content max-content;
      column-gap: 8px;
    }
    .ag-model-h, .ag-model { display: none; }
    .ag-sub-model { display: block; }
  }

  /* 后台任务行 */
  .ag-bg-list { display: flex; flex-direction: column; gap: 6px; }
  .ag-bg-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 9px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    font-size: 12px;
    line-height: 16px;
  }
  .ag-bg-row:not(.running) { background: transparent; border-color: transparent; padding-top: 4px; padding-bottom: 4px; }
  .ag-bg-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ag-bg-title { color: var(--ag-on-sub); }
  .ag-bg-row.running .ag-bg-title { color: var(--ag-on); font-weight: 500; }
  .ag-bg-row:not(.running) .ag-bg-title { color: var(--ag-on-dim); }
  .ag-bg-sub { font-size: 11.5px; color: var(--ag-on-dim); font-variant-numeric: tabular-nums; }
  .ag-bg-sub.warn { color: var(--ag-warn); }
  .ag-bg-tail {
    font-family: var(--ag-mono, ui-monospace, Consolas, monospace);
    font-size: 11px;
    color: var(--ag-on-faint);
  }
  .ag-bg-st { flex: none; color: var(--ag-on-faint); font-size: 11px; }
  .ag-bg-fold {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px 0 4px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .ag-bg-fold:hover { background: var(--ag-hover); color: var(--ag-on); }
  .ag-bg-fold .msr { font-size: 16px; transition: transform 0.16s ease; }
  .ag-bg-fold .msr.closed { transform: rotate(-90deg); }
  .ag-spin.stall { animation: none; border-top-color: var(--ag-warn); }

  .ag-spin {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.8px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: agy-ap-spin 0.8s linear infinite;
    display: inline-block;
    flex: none;
  }
  @keyframes agy-ap-spin { to { transform: rotate(360deg); } }

  .trunc {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .num { font-variant-numeric: tabular-nums; }
</style>
