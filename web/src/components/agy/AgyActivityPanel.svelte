<script>
  // Antigravity 本会话活动时间线：按时间序列出读写、编辑、命令执行与权限审批，点击跳回对话对应卡片。
  import { closeAgyDock } from '../../lib/dock.svelte.js';
  import { agy, scrollToAgyCard } from '../../lib/agy/store.svelte.js';
  import { buildActivityTimeline, formatActivityDuration } from '../../lib/agy/workspace-logic.js';
  import { t, tr } from '../../lib/i18n.js';

  const { wide = true } = $props();

  let filter = $state('all');

  const timeline = $derived(buildActivityTimeline(agy.messages, agy.cwd));

  const filterOptions = $derived([
    { id: 'all', label: t('全部'), count: timeline.counts.total },
    { id: 'edit', label: t('修改'), count: timeline.counts.edit },
    { id: 'execute', label: t('命令'), count: timeline.counts.execute },
    { id: 'read', label: t('读取'), count: timeline.counts.read },
    ...(timeline.counts.permission > 0
      ? [{ id: 'permission', label: t('审批'), count: timeline.counts.permission }]
      : []),
  ]);

  const visibleItems = $derived.by(() => {
    if (filter === 'all') return timeline.items;
    if (filter === 'read') {
      return timeline.items.filter((x) => x.category === 'read' || x.category === 'search');
    }
    return timeline.items.filter((x) => x.category === filter);
  });

  function jumpToItem(item) {
    if (!wide) {
      closeAgyDock();
      setTimeout(() => scrollToAgyCard(item.entryType, item.targetId), 90);
      return;
    }
    scrollToAgyCard(item.entryType, item.targetId);
  }
</script>

<div class="agy-act-panel">
  {#if timeline.items.length > 0}
    <div class="act-filters">
      {#each filterOptions as opt (opt.id)}
        {#if opt.id === 'all' || opt.count > 0}
          <button
            type="button"
            class="act-chip"
            class:on={filter === opt.id}
            onclick={() => { filter = opt.id; }}
          >
            <span>{opt.label}</span>
            <span class="cnt">{opt.count}</span>
          </button>
        {/if}
      {/each}
    </div>
  {/if}

  {#if visibleItems.length === 0}
    <div class="act-empty">
      <span class="msr4">checklist</span>
      <span>{timeline.items.length === 0 ? t('本会话尚无工具调用记录') : t('该分类下暂无记录')}</span>
    </div>
  {:else}
    <div class="act-list">
      {#each visibleItems as item (item.id)}
        <button
          type="button"
          class="act-row {item.status}"
          onclick={() => jumpToItem(item)}
          title={tr(item.summary)}
        >
          <span class="act-dot" aria-hidden="true">
            {#if item.status === 'running'}
              <span class="act-spin"></span>
            {:else if item.status === 'pending'}
              <span class="msr4 warn">shield</span>
            {:else if item.status === 'failed'}
              <span class="msr4 err">error</span>
            {:else if item.status === 'cancelled'}
              <span class="msr4 cancel">stop_circle</span>
            {:else}
              <span class="msr4 ok">{item.icon}</span>
            {/if}
          </span>

          <div class="act-main">
            <div class="act-top">
              <span class="act-verb">{item.verb}</span>
              {#if item.bypassSandbox}
                <span class="act-tag warn">{t('沙盒外')}</span>
              {:else if item.status === 'pending'}
                <span class="act-tag warn">{t('待确认')}</span>
              {:else if item.status === 'cancelled'}
                <span class="act-tag muted">{t('已取消')}</span>
              {/if}
              <span class="act-spacer"></span>
              {#if item.added > 0 || item.removed > 0}
                <span class="act-diff">
                  {#if item.added > 0}<b class="add">+{item.added}</b>{/if}
                  {#if item.removed > 0}<b class="del">-{item.removed}</b>{/if}
                </span>
              {/if}
              {#if item.exitCode !== null && item.exitCode !== undefined && Number(item.exitCode) !== 0}
                <span class="act-tag err">{t('退出码 {code}', { code: item.exitCode })}</span>
              {/if}
              {#if item.durationMs !== null}
                <span class="act-dur">{formatActivityDuration(item.durationMs)}</span>
              {/if}
            </div>
            <div class="act-sum">{tr(item.summary)}</div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .agy-act-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .act-filters {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 12px 7px;
    border-bottom: 1px solid var(--ag-divider);
    overflow-x: auto;
    scrollbar-width: none;
    flex: none;
  }
  .act-filters::-webkit-scrollbar { display: none; }
  .act-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
    font-size: 11.5px;
    color: var(--ag-on-sub);
    white-space: nowrap;
    flex: none;
  }
  .act-chip:hover { background: var(--ag-hover); color: var(--ag-on); }
  .act-chip.on {
    border-color: var(--ag-accent-bd);
    background: var(--ag-accent-soft);
    color: var(--ag-on);
    font-weight: 550;
  }
  .act-chip .cnt {
    font-family: var(--ag-mono);
    font-size: 10.5px;
    opacity: 0.78;
  }

  .act-empty {
    flex: 1;
    min-height: 180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    font-size: 12.5px;
    color: var(--ag-on-faint);
    text-align: center;
  }
  .act-empty .msr4 { font-size: 24px; opacity: 0.7; }

  .act-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .act-row {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid transparent;
    text-align: left;
    transition: background 0.14s ease, border-color 0.14s ease;
  }
  .act-row:hover {
    background: var(--ag-hover);
    border-color: var(--ag-border);
  }
  .act-row.pending {
    background: var(--ag-surface-1);
    border-color: color-mix(in srgb, var(--ag-warn) 38%, var(--ag-border));
  }
  .act-dot {
    width: 18px;
    height: 18px;
    margin-top: 1px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .act-dot .msr4 { font-size: 16px; }
  .act-dot .msr4.ok { color: var(--ag-accent); }
  .act-dot .msr4.warn { color: var(--ag-warn); }
  .act-dot .msr4.err { color: var(--ag-err); }
  .act-dot .msr4.cancel { color: var(--ag-on-faint); }
  .act-spin {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.8px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: act-spin 0.8s linear infinite;
  }
  @keyframes act-spin { to { transform: rotate(360deg); } }

  .act-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .act-top {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }
  .act-verb {
    font-weight: 540;
    color: var(--ag-on);
  }
  .act-spacer { flex: 1; }
  .act-tag {
    font-size: 10.5px;
    padding: 1px 5px;
    border-radius: 5px;
    flex: none;
  }
  .act-tag.warn { background: var(--ag-warn-bg); color: var(--ag-warn); }
  .act-tag.err { background: var(--ag-err-bg); color: var(--ag-err); font-family: var(--ag-mono); }
  .act-tag.muted { background: var(--ag-surface-2); color: var(--ag-on-dim); }
  .act-diff {
    display: inline-flex;
    gap: 4px;
    font-family: var(--ag-mono);
    font-size: 11px;
  }
  .act-diff b { font-weight: 600; }
  .act-diff .add { color: var(--ag-diff-add-fg); }
  .act-diff .del { color: var(--ag-diff-del-fg); }
  .act-dur {
    font-family: var(--ag-mono);
    font-size: 11px;
    color: var(--ag-on-faint);
  }
  .act-sum {
    font-family: var(--ag-mono);
    font-size: 11.5px;
    color: var(--ag-on-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
