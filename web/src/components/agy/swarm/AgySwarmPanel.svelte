<script>
  // Antigravity 右侧工作区「代理」面板内的 Native Swarm 四视图容器：
  // 顶部展示协作群标题、实时状态与统计，分段切换「总览 / 消息板 / 成员 / 协作图」，
  // 并承接对话内 AgySwarmCard 发来的跳转导航（agyDock.swarmNav）与成员转录钻取（pushAgyAgentTranscript）。
  import { untrack } from 'svelte';
  import { agyDock, pushAgyAgentTranscript } from '../../../lib/dock.svelte.js';
  import { fmtCompactTokens as fmtTokens } from '../../../lib/agy/subagents.svelte.js';
  import { refreshAgySwarm } from '../../../lib/agy/swarm.svelte.js';
  import { buildSwarmViewModel } from '../../../lib/agy/swarm-logic.js';
  import { t } from '../../../lib/i18n.js';
  import AgySwarmOverview from './AgySwarmOverview.svelte';
  import AgySwarmBoard from './AgySwarmBoard.svelte';
  import AgySwarmMembers from './AgySwarmMembers.svelte';
  import AgySwarmGraph from './AgySwarmGraph.svelte';

  const {
    snap,
    sessionId = '',
  } = $props();

  let activeTab = $state('overview');
  let boardJumpSeq = $state(0);
  let boardJumpToken = $state(0);
  let refreshing = $state(false);
  let lastNavToken = 0;

  const vm = $derived(buildSwarmViewModel(snap));
  const visibleTeamCount = $derived.by(() => {
    if (!vm) return 0;
    return (vm.memberGroups.active?.length || 0) + (vm.memberGroups.waiting?.length || 0) + (vm.memberGroups.coordinator ? 1 : 0);
  });

  $effect(() => {
    const nav = agyDock.swarmNav;
    if (!nav || !nav.token || nav.token === lastNavToken) return;
    lastNavToken = nav.token;
    untrack(() => {
      if (nav.tab && ['overview', 'board', 'members', 'graph'].includes(nav.tab)) {
        activeTab = nav.tab;
      }
      if (nav.seq > 0) {
        activeTab = 'board';
        boardJumpSeq = nav.seq;
        boardJumpToken = nav.token;
      }
    });
  });

  function jumpToBoardSeq(seq) {
    if (!seq) return;
    activeTab = 'board';
    boardJumpSeq = seq;
    boardJumpToken += 1;
  }

  function handleOpenMember(member) {
    if (!member) return;
    if (member.conversationId && member.role !== 'coordinator') {
      pushAgyAgentTranscript(member.conversationId);
      return;
    }
    activeTab = 'board';
  }

  async function doRefresh() {
    if (!sessionId || refreshing) return;
    refreshing = true;
    try {
      await refreshAgySwarm(sessionId, { silent: true, force: true });
    } finally {
      refreshing = false;
    }
  }

  const stateTone = $derived.by(() => {
    if (!vm) return 'muted';
    if (vm.needsUser || vm.stall) return 'warn';
    if (vm.systemAttention.length > 0) return 'err';
    if (vm.hasActive) return 'live';
    if (vm.finished) return 'ok';
    return 'muted';
  });
  const stateLabel = $derived.by(() => {
    if (!vm) return '';
    if (vm.needsUser) return t('等你回复');
    if (vm.stall) return t('已停滞');
    if (vm.hasActive) return t('协作中');
    if (vm.finished) return t('已完成');
    if (vm.systemAttention.length > 0) return t('部分出错');
    return t('待命中');
  });
</script>

{#if vm}
  <section class="sw-panel" aria-label={t('多代理协作面板')}>
    <header class="sw-head">
      <div class="sw-head-top">
        <span class="sw-title trunc" class:agy-shine={vm.hasActive} title={vm.title || t('多代理协作')}>
          {vm.title || t('多代理协作')}
        </span>
        <span class="sw-st-pill {stateTone}">
          {#if vm.hasActive}<i class="sw-dot" aria-hidden="true"></i>{/if}
          <span>{stateLabel}</span>
        </span>
        <button
          type="button"
          class="sw-ref-btn"
          disabled={refreshing}
          onclick={doRefresh}
          title={t('刷新协作状态')}
          aria-label={t('刷新协作状态')}
        >
          <span class="msr">refresh</span>
        </button>
      </div>

      <div class="sw-head-meta num">
        <span>{t('{n} 个成员', { n: visibleTeamCount })}</span>
        <span>{t('{n} 条消息', { n: vm.postsCount })}</span>
        {#if vm.channels.length > 0}
          <span>{t('{n} 个频道', { n: vm.channels.length + 1 })}</span>
        {/if}
        {#if vm.totalTokens > 0}
          <span>{fmtTokens(vm.totalTokens)} tokens</span>
        {/if}
      </div>

      <div class="sw-tabs" role="tablist" aria-label={t('协作视图')}>
        <button
          type="button"
          role="tab"
          class="sw-tab"
          class:on={activeTab === 'overview'}
          aria-selected={activeTab === 'overview'}
          onclick={() => { activeTab = 'overview'; }}
        >
          <span>{t('总览')}</span>
          {#if vm.needsUser || vm.stall || vm.systemAttention.length > 0}
            <i class="sw-tab-dot" class:err={vm.systemAttention.length > 0 && !vm.needsUser && !vm.stall} aria-hidden="true"></i>
          {/if}
        </button>
        <button
          type="button"
          role="tab"
          class="sw-tab"
          class:on={activeTab === 'board'}
          aria-selected={activeTab === 'board'}
          onclick={() => { activeTab = 'board'; }}
        >
          <span>{t('消息板')}</span>
          {#if vm.head > 0}<span class="sw-tab-n num">{vm.head}</span>{/if}
        </button>
        <button
          type="button"
          role="tab"
          class="sw-tab"
          class:on={activeTab === 'members'}
          aria-selected={activeTab === 'members'}
          onclick={() => { activeTab = 'members'; }}
        >
          <span>{t('成员')}</span>
          {#if visibleTeamCount > 0}<span class="sw-tab-n num">{visibleTeamCount}</span>{/if}
        </button>
        <button
          type="button"
          role="tab"
          class="sw-tab"
          class:on={activeTab === 'graph'}
          aria-selected={activeTab === 'graph'}
          onclick={() => { activeTab = 'graph'; }}
        >
          <span>{t('协作图')}</span>
        </button>
      </div>
    </header>

    <div class="sw-body">
      {#if activeTab === 'overview'}
        <AgySwarmOverview {vm} {sessionId} onOpenMember={handleOpenMember} onJumpSeq={jumpToBoardSeq} />
      {:else if activeTab === 'board'}
        <AgySwarmBoard {snap} {sessionId} jumpSeq={boardJumpSeq} jumpToken={boardJumpToken} onOpenMember={handleOpenMember} />
      {:else if activeTab === 'members'}
        <AgySwarmMembers {vm} onOpenMember={handleOpenMember} />
      {:else}
        <AgySwarmGraph {snap} onOpenMember={handleOpenMember} onJumpSeq={jumpToBoardSeq} />
      {/if}
    </div>
  </section>
{/if}

<style>
  .sw-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sw-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sw-head-top {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .sw-title {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    line-height: 20px;
    font-weight: 560;
    color: var(--ag-on);
  }
  .sw-st-pill {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: var(--ag-surface-2);
    color: var(--ag-on-sub);
  }
  .sw-st-pill.live {
    background: color-mix(in srgb, var(--ag-accent) 14%, transparent);
    color: var(--ag-accent);
  }
  .sw-st-pill.warn {
    background: var(--ag-warn-bg);
    color: var(--ag-warn);
  }
  .sw-st-pill.err {
    background: var(--ag-err-bg);
    color: var(--ag-err);
  }
  .sw-st-pill.ok {
    background: var(--ag-ok-bg);
    color: var(--ag-ok);
  }
  .sw-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: sw-hd-pulse 1.4s ease-in-out infinite;
  }
  @keyframes sw-hd-pulse { 50% { opacity: 0.35; } }
  .sw-ref-btn {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .sw-ref-btn:hover:not(:disabled) { background: var(--ag-hover); color: var(--ag-on); }
  .sw-ref-btn:disabled { opacity: 0.45; }
  .sw-ref-btn .msr { font-size: 16px; }

  .sw-head-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 10px;
    font-size: 11.5px;
    color: var(--ag-on-dim);
  }

  .sw-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 3px;
    padding: 3px;
    border-radius: 9px;
    background: var(--ag-surface-2);
    margin-top: 2px;
  }
  .sw-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 28px;
    padding: 0 6px;
    border-radius: 7px;
    font-size: 12px;
    color: var(--ag-on-dim);
    white-space: nowrap;
    min-width: 0;
    transition: background 0.14s ease, color 0.14s ease;
  }
  .sw-tab:hover { color: var(--ag-on); }
  .sw-tab.on {
    background: var(--ag-bg);
    color: var(--ag-on);
    font-weight: 500;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  .sw-tab-n {
    font-size: 10.5px;
    color: var(--ag-on-faint);
  }
  .sw-tab-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ag-warn);
    flex: none;
  }
  .sw-tab-dot.err { background: var(--ag-err); }
  .sw-body {
    display: flex;
    flex-direction: column;
  }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .num { font-variant-numeric: tabular-nums; }
</style>
