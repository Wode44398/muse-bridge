<script>
  // Antigravity 分页的工作区：统一外壳（Workbench）+ 它自己的三样——
  //   专属卡「代理」「活动」，以及带非 git 目录退化视图的审阅卡；
  //   图标用 Antigravity 那套符号字；没绑工作空间文件夹时的空态带「选择文件夹」入口。
  // 手机上是整屏页（返回 + 自适应标签）。
  import { ui } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { agyHost, agyTools } from '../../lib/dock.svelte.js';
  import { toolAllowed } from '../../lib/dock/tools.js';
  import { agy } from '../../lib/agy/store.svelte.js';
  import { agySubagents } from '../../lib/agy/subagents.svelte.js';
  import { agySwarm } from '../../lib/agy/swarm.svelte.js';
  import { agyPrefs } from '../../lib/agy/settings.svelte.js';
  import { buildActivityTimeline } from '../../lib/agy/workspace-logic.js';
  import { t } from '../../lib/i18n.js';
  import Workbench from '../dock/Workbench.svelte';
  import AgySessionReview from './AgySessionReview.svelte';
  import AgyAgentsPanel from './AgyAgentsPanel.svelte';
  import AgyActivityPanel from './AgyActivityPanel.svelte';

  // leftSidebarWidth：会话侧栏此刻占的宽度——工作区再宽也要给对话留够
  const { wide = true, leftSidebarWidth = 0 } = $props();
  const MIN_CHAT_W = 380;
  const agyDock = agyHost.state;

  const agyTheme = $derived.by(() => {
    const pref = agyPrefs.settings.theme;
    if (pref === 'azure') return 'dark';
    if (pref === 'daylight') return 'light';
    return ui.theme === 'light' ? 'light' : 'dark';
  });

  const activityCounts = $derived(buildActivityTimeline(agy.messages, agy.cwd).counts);
  const subTree = $derived(agySubagents.sessionId === agy.sessionId ? agySubagents.tree : null);
  const swarmSnap = $derived(agySwarm.sessionId === agy.sessionId && agySwarm.data?.hasSwarm ? agySwarm.data : null);
  const subActive = $derived(Boolean(subTree?.hasActive || swarmSnap?.hasActive));
  const subTotal = $derived(Math.max(Number(subTree?.counts?.total) || 0, Number(swarmSnap?.summary?.totalWorkers) || 0));

  // live = 开关上的提示点（没在看时）；hot = 卡片标题行上的在跑点；badge = 计数
  const DYN = $derived({
    term: { live: agyDock.termLive, hot: agyDock.termLive },
    browser: { live: Boolean(agyDock.browserLive), hot: Boolean(agyDock.browserLive) },
    agents: { live: subActive, hot: subActive, badge: subTotal },
    activity: { live: activityCounts.running > 0, hot: activityCounts.running > 0, badge: activityCounts.total },
  });
  const tools = $derived(agyTools().filter((x) => toolAllowed(x, agyHost)).map((x) => ({ ...x, ...(DYN[x.key] || {}) })));

  const canPickFolderNow = $derived(!agy.sessionId && agy.messages.length === 0);
  function openFolderPicker() {
    agy.popAnchor = null;
    agy.popAnchorEl = null;
    agy.projectSheetOpen = true;
  }

  // 让文件卡里某个文件闪一下（agent 说「看这个文件」）：工作空间页挂上后按文件名找到那一行
  let root = $state(null);
  const filesOpen = $derived(agyDock.open && (wide ? agyDock.views.includes('files') : agyDock.view === 'files'));
  $effect(() => {
    const seq = agy.highlightSeq;
    const targetName = agy.highlightedFileName;
    if (!seq || !targetName || !filesOpen) return;
    const timers = [120, 380, 820].map((delay) => setTimeout(() => {
      const box = root?.querySelector('.wb-embed');
      if (!box) return;
      for (const node of box.querySelectorAll('[data-rel], .fn, .p-name')) {
        const relAttr = node.getAttribute?.('data-rel') || '';
        const base = relAttr ? relAttr.split('/').pop() : (node.textContent || '').trim();
        if (base === targetName) {
          const row = node.closest('[data-rel]') || node.closest('button, .row, .item') || node;
          row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
          row.classList.add('agy-file-located');
          setTimeout(() => row.classList.remove('agy-file-located'), 1600);
          break;
        }
      }
    }, delay));
    return () => timers.forEach(clearTimeout);
  });
</script>

{#snippet icon(key)}<span class="msr4" aria-hidden="true">{tools.find((x) => x.key === key)?.icon}</span>{/snippet}

{#snippet panel(view)}
  {#if view === 'agents'}<AgyAgentsPanel {wide} />
  {:else if view === 'activity'}<AgyActivityPanel {wide} />
  {:else if view === 'review'}
    {#if agyDock.ws}{#key agyDock.ws}<AgySessionReview />{/key}{:else}{@render empty()}{/if}
  {/if}
{/snippet}

{#snippet empty()}
  <div class="ws-wait">
    <span class="msr4">folder_open</span>
    <span>{t('当前对话尚未绑定工作空间文件夹')}</span>
    {#if canPickFolderNow}
      <button type="button" class="ws-pick-btn" onclick={openFolderPicker}><span>{t('选择工作空间文件夹')}</span></button>
    {/if}
  </div>
{/snippet}

<div class="agy-wb" bind:this={root}>
  <Workbench host={agyHost} {tools} {wide} multi={layout.expanded} skin="agy" mobile="page" filesFloat="always"
    reserve={leftSidebarWidth + MIN_CHAT_W} twoColHost={1020 + leftSidebarWidth} theme={agyTheme} label={t('侧边工作区')}
    {icon} {panel} {empty} keysOn={ui.screen === 'agy'} />
</div>

<style>
  /* 外壳自己是这一行里的弹性项：包一层只为拿到它的 DOM（定位文件用），不参与布局 */
  .agy-wb { display: contents; }
  .agy-wb :global(.agy-file-located) {
    outline: 2px solid var(--ag-accent);
    outline-offset: -2px;
    background: var(--ag-accent-soft) !important;
  }
  .ws-wait {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    font-size: 12.5px;
    color: var(--ag-on-dim);
  }
  .ws-wait .msr4 { font-size: 24px; color: var(--ag-on-faint); }
  .ws-pick-btn {
    margin-top: 2px;
    height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-2);
    color: var(--ag-on);
    font-size: 12.5px;
    font-weight: 500;
  }
  .ws-pick-btn:hover { background: var(--ag-hover); }
</style>
