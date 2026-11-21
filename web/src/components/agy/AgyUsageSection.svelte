<script>
  // 开口仪表弹层的下半：上下文窗口（仪表中间的数字）+ 额度各桶（仪表画最吃紧那一组：周限 = 环的填充段、
  // 5 小时 = 指示点；这两行标题前各带一枚小图例，对得上仪表上的哪一笔）。
  // 上半是运行模式五档（ModelSheet kind=mode），这里只出数据、不放按钮。
  import { agy, refreshAgyQuota } from '../../lib/agy/store.svelte.js';
  import { agyContextPct, quotaBuckets, gaugeQuota, fmtTokens, fmtResetIn, usageLevel } from '../../lib/agy/usage.js';
  import { agyAccLabel, agyPlanPill } from '../../lib/agy/pool-logic.js';
  import { t } from '../../lib/i18n.js';

  const ctxPct = $derived(agyContextPct(agy.contextUsage));
  const buckets = $derived(quotaBuckets(agy.quota));
  const gq = $derived(gaugeQuota(agy.quota));
  const acct = $derived(agy.quota?.account || null);
  const acctTag = $derived(acct?.label ? [agyAccLabel(acct.label), agyPlanPill(acct.plan)].filter(Boolean).join(' · ') : '');
  const groups = $derived([...new Set(buckets.map((b) => b.group))]);
  const windowName = (b) => (b.window === '5h' ? t('5 小时') : b.window === 'weekly' ? t('每周') : b.window);
  const mark = (b) => (!gq || buckets.length < 2 ? '' : b.id === gq.weekly?.id ? 'arc' : b.id === gq.fiveH?.id ? 'dot' : '');
  let now = $state(Date.now());

  $effect(() => {
    refreshAgyQuota({ force: true });
    const iv = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(iv);
  });
</script>

<div class="us">
  <div class="us-sec">
    <div class="us-head">
      <span class="us-name">{t('上下文窗口')}</span>
      {#if ctxPct != null}
        <span class="us-val {usageLevel(ctxPct)}">{ctxPct}%</span>
      {/if}
    </div>
    {#if ctxPct != null}
      <div class="us-bar {usageLevel(ctxPct)}"><span style:width="{Math.max(ctxPct, 1.5)}%"></span></div>
      <div class="us-sub">{fmtTokens(agy.contextUsage.used)} / {fmtTokens(agy.contextUsage.size)} tokens</div>
    {:else}
      <div class="us-sub">{t('发一条消息后显示')}</div>
    {/if}
  </div>

  <div class="us-sec">
    <div class="us-head">
      <span class="us-name">{t('额度')}</span>
      {#if acctTag}<span class="us-acct">{acctTag}</span>{/if}
    </div>
    {#if buckets.length}
      {#each groups as g (g)}
        <div class="us-group">{g}</div>
        {#each buckets.filter((b) => b.group === g) as b (b.id)}
          <div class="us-row" class:tight={!!mark(b)}>
            <div class="us-head">
              <span class="us-label">
                {#if mark(b) === 'arc'}
                  <svg class="us-mark" viewBox="0 0 12 12" aria-label={t('仪表填充段')}><path d="M2.2 8.6A4.6 4.6 0 0 1 9.8 3.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
                {:else if mark(b) === 'dot'}
                  <svg class="us-mark" viewBox="0 0 12 12" aria-label={t('仪表指示点')}><circle cx="6" cy="6" r="2.6" fill="currentColor" /></svg>
                {/if}
                {windowName(b)}
                {#if b.resetAt}<span class="us-reset">· {fmtResetIn(b.resetAt, now)}</span>{/if}
              </span>
              <span class="us-val {usageLevel(b.usedPct)}">{Math.round(b.usedPct)}%</span>
            </div>
            <div class="us-bar {usageLevel(b.usedPct)}"><span style:width="{Math.max(b.usedPct, 1.5)}%"></span></div>
          </div>
        {/each}
      {/each}
    {:else if agy.quota?.error}
      <div class="us-sub">{t('额度暂时取不到')}</div>
    {:else}
      <div class="us-sub">{t('正在读取…')}</div>
    {/if}
  </div>
</div>

<style>
  .us {
    padding: 2px 0 4px;
  }
  .us-sec {
    padding: 9px 12px 8px;
    border-top: 1px solid var(--ag-divider);
  }
  .us-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .us-name {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--ag-on-faint);
    letter-spacing: 0.01em;
  }
  .us-acct {
    font-size: 11.5px;
    color: var(--ag-on-faint);
    max-width: 170px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .us-label {
    font-size: 12px;
    color: var(--ag-on-sub);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .us-val {
    font-size: 12px;
    color: var(--ag-on-sub);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .us-val.warn { color: var(--ag-warn); }
  .us-val.err { color: var(--ag-err); }
  .us-group {
    margin-top: 9px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ag-on-sub);
  }
  .us-row { margin-top: 6px; }
  .us-reset { color: var(--ag-on-faint); margin-left: 2px; }
  .us-sec > .us-head + .us-bar { margin-top: 7px; }
  .us-bar {
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--ag-on) 10%, transparent);
    overflow: hidden;
    margin-top: 5px;
  }
  .us-bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: color-mix(in srgb, var(--ag-on) 55%, transparent);
  }
  .us-bar.warn > span { background: var(--ag-warn); }
  .us-bar.err > span { background: var(--ag-err); }
  .us-sub {
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--ag-on-faint);
    font-variant-numeric: tabular-nums;
  }
  .us-mark { width: 11px; height: 11px; display: inline-block; vertical-align: -1px; margin-right: 4px; color: var(--ag-on-dim); }
</style>
