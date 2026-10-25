<script>
  // 会话信息面板里的「建议的任务」卡（官方 Session rail 的 “{count} suggested tasks”，B3 §2.3）：
  // 这个会话里 Claude 提议了、还没开的卡（own_initiative 的 pending / 没开成）——对话流里那张卡滚走了，在这里照样能开。
  // 每行：标题（悬停看任务说明开头）+ 忽略 / 开始；两张以上组头有「全部开始」。数据与对话流里的卡同一份
  //（sessionFamily.collab，接口 + 总线同步），点了两边一起变。样式照 SessionRail 的卡片（变量从 .rail 继承）。
  import { untrack } from 'svelte';
  import { session } from '../../lib/state.svelte.js';
  import { collab, loadProposals, startProposals, dismissProposal } from '../../lib/sessionFamily.svelte.js';
  import { isFolded, toggleFold } from '../../lib/sessionRail.svelte.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { t, tr } from '../../lib/i18n.js';

  const sid = $derived(session.id || '');
  $effect(() => { const id = sid; if (id) untrack(() => loadProposals(id)); });

  const OPEN = new Set(['pending', 'start_failed']);
  const rows = $derived(Object.values(collab.proposals)
    .filter((p) => p.parent === sid && p.kind === 'own' && OPEN.has(p.status))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
  const folded = $derived(isFolded('suggested'));

  let busyAll = $state(false);
  async function startAll() {
    if (busyAll || rows.length < 2) return;
    busyAll = true;
    try { await startProposals(rows.map((p) => p.id)); } finally { busyAll = false; }
  }
  const hint = (p) => (p.status === 'start_failed' && p.reason ? tr(p.reason) : String(p.tldr || p.prompt || p.title || '').slice(0, 300));
</script>

{#if rows.length && sid && !IS_CSNAP}
  <section class="rc">
    <div class="rc-head">
      <button class="rc-title" onclick={(e) => toggleFold('suggested', e.altKey)}>
        {t('建议的任务')}<svg class="rc-caret" class:open={!folded} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      {#if folded}<span class="rc-sum">{t('{n} 个', { n: rows.length })}</span>
      {:else if rows.length >= 2}<button class="rbtn push" disabled={busyAll} onclick={startAll}>{t('全部开始')}</button>{/if}
    </div>
    {#if !folded}
      <div class="rc-body">
        {#each rows as p (p.id)}
          <div class="rr" title={hint(p)}>
            <span class="rr-txt">{p.title || t('未命名任务')}</span>
            <span class="rr-grow"></span>
            {#if p.status === 'start_failed'}<span class="rr-st warn">{t('没能开始')}</span>{/if}
            <button class="rbtn ghost" disabled={p.busy} aria-label={t('忽略建议「{title}」', { title: p.title })} onclick={() => dismissProposal(p.id)}>{t('忽略')}</button>
            <button class="rbtn" disabled={p.busy || busyAll} onclick={() => startProposals([p.id])}>{p.status === 'start_failed' ? t('重试') : t('开始')}</button>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  /* 同 SessionRail 的 .rc 卡片（--r-* 变量由外层 .rail 提供） */
  .rc { display: flex; flex-direction: column; flex-shrink: 0; padding: 8px 0; border-radius: 10px; box-shadow: var(--r-ring); background: var(--bg); }
  .rc-head { display: flex; align-items: center; min-height: 26px; padding: 0 8px; gap: 6px; }
  .rc-title { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 4px; font-size: 12px; font-weight: 500; color: var(--text); border-radius: 6px; }
  .rc-title:hover { background: var(--r-ghost); }
  .rc-caret { width: 13px; height: 13px; color: var(--muted); transition: transform .15s ease; }
  .rc-caret.open { transform: rotate(90deg); }
  .rc-sum { margin-left: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-left: 6px; font-size: 12px; color: var(--muted); }
  .rc-body { display: flex; flex-direction: column; padding: 2px 8px 0; }
  .rr { display: flex; align-items: center; gap: 6px; min-height: 28px; width: 100%; padding: 0 4px; font-size: 13px; color: var(--text); border-radius: 6px; min-width: 0; box-sizing: border-box; }
  .rr-txt { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .rr-grow { flex: 1; }
  .rr-st { flex: none; font-size: 12px; color: var(--muted); }
  .rr-st.warn { color: var(--r-warn); }
  .rbtn { flex: none; font-size: 12px; padding: 3px 9px; border-radius: 7px; background: var(--r-a2); color: var(--text); }
  .rbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .rbtn:disabled { opacity: .45; }
  .rbtn.ghost { background: none; color: var(--muted); }
  .rbtn.ghost:hover:not(:disabled) { background: var(--r-ghost); color: var(--text); }
  .push { margin-left: auto; }
</style>
