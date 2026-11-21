<script>
  // Swarm 成员清单视图：
  // 按 协调者 / 活跃中 / 待命中 / 观察者 / 已移除 分组，直出每位成员的模型与 effort、Token 消耗、
  // 步数与发帖数、独立工作区（share / branch）与订阅频道、实时动态；点击成员直接钻取完整对话转录。
  import { agentModelInfo, fmtCompactTokens as fmtTokens } from '../../../lib/agy/subagents.svelte.js';
  import { swarmStatusLabel } from '../../../lib/agy/swarm.svelte.js';
  import { shortWorkspacePath } from '../../../lib/agy/swarm-logic.js';
  import { t } from '../../../lib/i18n.js';

  const {
    vm,
    onOpenMember = () => {},
  } = $props();

  let search = $state('');
  let killedOpen = $state(false);

  function matchesQuery(m) {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const hay = `${m.name} ${m.role || ''} ${m.taskTitle || ''} ${m.model || ''} ${m.workspaceMode || ''} ${m.workspace || ''} ${m.nowText || ''}`.toLowerCase();
    return hay.includes(q);
  }

  const activeList = $derived((vm?.memberGroups?.active || []).filter(matchesQuery));
  const waitingList = $derived((vm?.memberGroups?.waiting || []).filter(matchesQuery));
  const observerList = $derived((vm?.memberGroups?.observers || []).filter(matchesQuery));
  const killedList = $derived((vm?.memberGroups?.killed || []).filter(matchesQuery));
  const coord = $derived(vm?.memberGroups?.coordinator && matchesQuery(vm.memberGroups.coordinator) ? vm.memberGroups.coordinator : null);

  function roleBadge(m) {
    if (m.role === 'coordinator') return t('协调者');
    if (m.role === 'monitor') return t('停滞监控');
    if (m.role === 'narrator') return t('摘要员');
    return '';
  }

  function stateTone(m) {
    if (m.killed) return 'muted';
    if (m.displayState === 'error' || m.displayState === 'stuck') return 'err';
    if (m.displayState === 'waiting_on' || m.displayState === 'needs_you') return 'warn';
    if (m.displayState === 'working') return 'live';
    return 'muted';
  }

  function stateText(m) {
    if (m.killed) return t('已移除');
    if (m.failure?.kind === 'quota') return t('额度不足');
    if (m.displayState === 'waiting_on' && m.waitingOn) return t('等待 @{name}', { name: m.waitingOn });
    return swarmStatusLabel(m.displayState);
  }
</script>

{#snippet memberRow(m)}
  {@const mod = agentModelInfo(m)}
  {@const tone = stateTone(m)}
  {@const canDrill = Boolean(m.conversationId && m.role !== 'coordinator')}
  {@const wsMode = m.workspaceMode && m.workspaceMode !== 'inherit' ? m.workspaceMode : ''}
  {@const wsShort = shortWorkspacePath(m.workspace)}
  {@const nonMainCh = (m.channels || []).filter((c) => c && c !== 'main')}
  <button
    type="button"
    class="sw-mrow"
    class:clickable={canDrill}
    class:killed={m.killed}
    onclick={() => onOpenMember(m)}
    title={canDrill ? t('查看 @{name} 的完整对话与工具记录', { name: m.name }) : t('在消息板筛选 @{name}', { name: m.name })}
  >
    <span class="sw-mst-slot" aria-hidden="true">
      {#if m.displayState === 'working'}
        <span class="sw-spin"></span>
      {:else if tone === 'err'}
        <span class="msr4 err">error</span>
      {:else if tone === 'warn'}
        <span class="msr4 warn">schedule</span>
      {:else if m.killed}
        <span class="msr4 muted">stop_circle</span>
      {:else}
        <span class="msr4 ok">check</span>
      {/if}
    </span>

    <span class="sw-mcol">
      <span class="sw-mhead">
        <span class="sw-mname trunc" class:agy-shine={m.displayState === 'working'}>@{m.name}</span>
        {#if roleBadge(m)}<span class="sw-role-tag">{roleBadge(m)}</span>{/if}
        <span class="sw-mstat {tone}">{stateText(m)}</span>
        {#if m.tokens?.total > 0}
          <span class="sw-mtok num">{fmtTokens(m.tokens.total)}</span>
        {/if}
      </span>

      {#if m.taskTitle}
        <span class="sw-mtask trunc">{m.taskTitle}</span>
      {/if}

      <span class="sw-mmeta num">
        {#if mod.modelName}
          <span class="sw-mmod">{mod.modelName}{#if mod.effort}{' · '}<span class="sw-meff">{mod.effort}</span>{/if}</span>
        {/if}
        {#if m.posts > 0}
          <span>{t('{n} 帖', { n: m.posts })}</span>
        {/if}
        {#if m.steps > 0}
          <span>{t('{n} 步', { n: m.steps })}</span>
        {/if}
        {#if m.unread > 0 && !m.killed}
          <span class="sw-munread">{t('{n} 未读', { n: m.unread })}</span>
        {/if}
      </span>

      {#if wsMode || wsShort || nonMainCh.length > 0}
        <span class="sw-mtags">
          {#if wsMode || wsShort}
            <span class="sw-mtag" title={[wsMode, m.workspace].filter(Boolean).join(' · ')}>
              {[wsMode, wsShort].filter(Boolean).join(' · ')}
            </span>
          {/if}
          {#if nonMainCh.length > 0}
            <span class="sw-mtag">
              {nonMainCh.includes('*') ? t('全部频道') : nonMainCh.map((c) => `#${c}`).join(' ')}
            </span>
          {/if}
        </span>
      {/if}

      {#if m.nowText}
        <span class="sw-mnow trunc" class:live={m.displayState === 'working' && m.activity} class:err={tone === 'err'} title={m.nowText}>
          {m.nowText}
        </span>
      {/if}
    </span>

    <span class="msr sw-marr" aria-hidden="true">{canDrill ? 'expand_more' : 'north_east'}</span>
  </button>
{/snippet}

<div class="sw-members">
  <label class="sw-msearch">
    <span class="msr" aria-hidden="true">search</span>
    <input
      type="search"
      bind:value={search}
      placeholder={t('搜索成员、模型或工作区…')}
      aria-label={t('搜索成员')}
      autocomplete="off"
    />
  </label>

  {#if coord}
    <section class="sw-mgroup">
      <div class="sw-mgh">{t('协调者')}</div>
      <div class="sw-mlist">{@render memberRow(coord)}</div>
    </section>
  {/if}

  {#if activeList.length > 0}
    <section class="sw-mgroup">
      <div class="sw-mgh"><span>{t('活跃中')}</span><span class="num">{activeList.length}</span></div>
      <div class="sw-mlist">
        {#each activeList as m (m.name)}{@render memberRow(m)}{/each}
      </div>
    </section>
  {/if}

  {#if waitingList.length > 0}
    <section class="sw-mgroup">
      <div class="sw-mgh"><span>{vm.finished ? t('团队成员') : t('待命中')}</span><span class="num">{waitingList.length}</span></div>
      <div class="sw-mlist">
        {#each waitingList as m (m.name)}{@render memberRow(m)}{/each}
      </div>
    </section>
  {/if}

  {#if observerList.length > 0}
    <section class="sw-mgroup">
      <div class="sw-mgh"><span>{t('系统观察者')}</span><span class="num">{observerList.length}</span></div>
      <div class="sw-mlist">
        {#each observerList as m (m.name)}{@render memberRow(m)}{/each}
      </div>
    </section>
  {/if}

  {#if killedList.length > 0}
    <section class="sw-mgroup">
      <button type="button" class="sw-mgh fold" aria-expanded={killedOpen} onclick={() => { killedOpen = !killedOpen; }}>
        <span>{t('已移除')}</span>
        <span class="num">{killedList.length}</span>
        <span class="msr sw-chev" class:closed={!killedOpen} aria-hidden="true">expand_more</span>
      </button>
      {#if killedOpen}
        <div class="sw-mlist">
          {#each killedList as m (m.name)}{@render memberRow(m)}{/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if !coord && !activeList.length && !waitingList.length && !observerList.length && !killedList.length}
    <p class="sw-mempty">{t('没有匹配的成员')}</p>
  {/if}
</div>

<style>
  .sw-members {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .sw-msearch {
    height: 32px;
    padding: 0 9px;
    border-radius: 8px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ag-on-dim);
  }
  .sw-msearch:focus-within { border-color: var(--ag-border-strong); }
  .sw-msearch .msr { font-size: 16px; flex: none; }
  .sw-msearch input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--ag-on);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }
  .sw-msearch input::placeholder { color: var(--ag-on-faint); }

  .sw-mgroup { display: flex; flex-direction: column; gap: 6px; }
  .sw-mgh {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--ag-on-faint);
    padding: 0 2px;
  }
  .sw-mgh.fold { width: fit-content; padding: 2px 4px; margin-left: -2px; border-radius: 5px; }
  .sw-mgh.fold:hover { background: var(--ag-hover); color: var(--ag-on-sub); }
  .sw-chev { font-size: 16px; transition: transform 0.16s ease; }
  .sw-chev.closed { transform: rotate(-90deg); }

  .sw-mlist { display: flex; flex-direction: column; gap: 6px; }
  .sw-mrow {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 9px 10px;
    border-radius: 10px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    text-align: left;
    transition: background 0.14s ease, border-color 0.14s ease;
  }
  .sw-mrow:hover {
    background: var(--ag-surface-2);
    border-color: var(--ag-border-strong);
  }
  .sw-mrow.killed { opacity: 0.65; }
  .sw-mst-slot {
    flex: none;
    width: 15px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .sw-mst-slot .msr4 { font-size: 14px; }
  .sw-mst-slot .msr4.ok { color: var(--ag-ok); }
  .sw-mst-slot .msr4.warn { color: var(--ag-warn); }
  .sw-mst-slot .msr4.err { color: var(--ag-err); }
  .sw-mst-slot .msr4.muted { color: var(--ag-on-faint); }

  .sw-mcol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .sw-mhead {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .sw-mname {
    font-size: 12.5px;
    font-weight: 560;
    font-family: var(--ag-mono);
    color: var(--ag-on);
  }
  .sw-role-tag {
    flex: none;
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ag-surface-2);
    color: var(--ag-on-dim);
  }
  .sw-mstat {
    flex: none;
    font-size: 11px;
    color: var(--ag-on-dim);
  }
  .sw-mstat.live { color: var(--ag-accent); }
  .sw-mstat.warn { color: var(--ag-warn); }
  .sw-mstat.err { color: var(--ag-err); }
  .sw-mtok {
    margin-left: auto;
    flex: none;
    font-size: 11px;
    color: var(--ag-on-faint);
  }
  .sw-mtask {
    font-size: 12px;
    color: var(--ag-on-sub);
    line-height: 16px;
  }
  .sw-mmeta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 9px;
    font-size: 11px;
    color: var(--ag-on-dim);
  }
  .sw-mmod { color: var(--ag-on-sub); }
  .sw-meff { font-family: var(--ag-mono); color: var(--ag-on-dim); }
  .sw-munread { color: var(--ag-accent); }
  .sw-mtags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 1px;
  }
  .sw-mtag {
    font-size: 10.5px;
    line-height: 15px;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--ag-bg);
    border: 1px solid var(--ag-border);
    color: var(--ag-on-dim);
    font-family: var(--ag-mono);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sw-mnow {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-faint);
  }
  .sw-mnow.live {
    font-family: var(--ag-mono);
    color: var(--ag-accent);
  }
  .sw-mnow.err { color: var(--ag-err); }
  .sw-marr {
    flex: none;
    font-size: 16px;
    color: var(--ag-on-faint);
    margin-top: 1px;
  }
  .sw-mrow.clickable .sw-marr { transform: rotate(-90deg); }
  .sw-spin {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.8px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: sw-mspin 0.8s linear infinite;
    display: inline-block;
  }
  @keyframes sw-mspin { to { transform: rotate(360deg); } }
  .sw-mempty {
    margin: 24px 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--ag-on-dim);
  }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .num { font-variant-numeric: tabular-nums; }
</style>
