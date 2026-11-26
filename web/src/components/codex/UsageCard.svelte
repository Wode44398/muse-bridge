<script>
  // 上下文与额度卡（锚在托盘右端的上下文环上）。环只管「看」，卡里写明白：
  //   上下文：条 + 已用 / 共多少 + 百分比（打开时条从 0 长到当前值、数字从 0 滚上来）+ 「压缩上下文」键；
  //           压的时候键原地转圈，压完被腾出来的那一截留一道淡影慢慢褪掉，键变成「已压缩」，片刻后卡片自己收起；
  //   额度：  这条线程所属号的 5 小时 / 每周窗口（剩多少、何时重置）+ 在用的号 +「换号」（管理员）。
  // 读不到额度就直说，不弹提示条。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { codex, current, loadUsage, isAdmin } from '../../lib/codex/store.svelte.js';
  import { cxPop, closePop, openPop } from '../../lib/codex/ui.svelte.js';
  import { anim, EASE, roll, reduced } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import { accLabel, planLabel } from '../../lib/codex/settings-logic.js';
  import { fmtTok, quotaRows } from '../../lib/codex/picker/format.js';
  import { compaction, startCompact, clearCompaction } from '../../lib/codex/picker/compact.svelte.js';
  import Popover from './Popover.svelte';
  import Icon from './Icon.svelte';

  const open = $derived(cxPop.id === 'usage');
  const thread = $derived(current());
  const ctx = $derived(thread.ctx);
  const pct = $derived(ctx ? Math.round(ctx.pct) : 0);
  const mine = $derived(!!thread.id && compaction.id === thread.id);
  const phase = $derived(mine ? compaction.phase : '');
  const freed = $derived(mine && phase === 'ok' && compaction.before && compaction.after
    ? Math.max(0, compaction.before.used - compaction.after.used) : 0);

  const usage = $derived(codex.usage);
  const rows = $derived(quotaRows(usage));
  const accounts = $derived(Array.isArray(codex.pool?.accounts) ? codex.pool.accounts : []);
  const acct = $derived(accounts.find((a) => a.id === codex.usageAccount) || null);
  const acctText = $derived(acct ? [accLabel(acct), planLabel(acct.plan)].filter(Boolean).join(' · ') : '');
  const canSwitch = $derived(isAdmin() && accounts.length > 1);

  let barEl = $state(null);
  let ghostEl = $state(null);
  let btnEl = $state(null);

  // 打开就刷新一次额度（这条线程所属的号）
  $effect(() => {
    if (open) untrack(() => loadUsage());
  });

  // 卡片收起后，「已压缩」不再留着
  $effect(() => {
    if (!open && phase === 'ok') clearCompaction(thread.id);
  });

  // 压完：淡影留在原来的长度，条慢慢缩到新长度，影子褪掉；片刻后卡片自己收起
  let lastPhase = '';
  $effect(() => {
    const p = phase;
    if (p === lastPhase) return;
    const was = lastPhase;
    lastPhase = p;
    if ((p === '' || p === 'err') && btnEl) btnEl.style.width = '';
    if (p !== 'ok' || was !== 'busy' || !open) return;
    haptic('done');
    const b = compaction.before;
    if (b && compaction.after && ghostEl && barEl && !reduced()) {
      ghostEl.style.setProperty('--w', Math.round(b.pct) + '%');
      anim(ghostEl, [{ opacity: 0.9 }, { opacity: 0 }], { dur: 1200, ease: EASE.out, delay: 200, fill: 'none' });
      anim(barEl, [{ width: Math.round(b.pct) + '%' }, { width: Math.round(compaction.after.pct) + '%' }], { dur: 1100, ease: EASE.soft, fill: 'none' });
    }
    const id = thread.id;
    setTimeout(() => { if (cxPop.id === 'usage' && compaction.id === id && compaction.phase === 'ok') closePop('usage'); }, 1400);
  });

  function compact() {
    if (!thread.id || phase === 'busy') return;
    // 键宽锁住，换成「正在压缩」时原地转圈，不跳宽度
    if (btnEl) btnEl.style.width = btnEl.offsetWidth + 'px';
    haptic('tick');
    startCompact(thread.id);
  }

  function switchAcct(e) {
    // 账号菜单本来锚在窄栏头像上；手机上窄栏收在抽屉里，就锚在这个键上
    const rail = document.querySelector('.cx .rl-me');
    const anchor = rail && rail.offsetParent && rail.getBoundingClientRect().width ? rail : e.currentTarget;
    openPop('acct', anchor);
  }

  /* 打开时数据跟着长出来：条从 0 长到当前值（错开一点），数字从 0 滚上来 */
  function grow(node, delay = 0) {
    if (!reduced()) anim(node, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { dur: 600, ease: EASE.soft, delay });
  }
  function rollPct(node, text) {
    roll(node, '0%', { instant: true });
    if (reduced()) roll(node, text, { instant: true });
    else roll(node, text, { stagger: 30 });
    return { update(next) { roll(node, next); } };
  }
  function rollNum(node, text) {
    roll(node, '0', { instant: true });
    if (reduced()) roll(node, text, { instant: true });
    else roll(node, text, { stagger: 30 });
    return { update(next) { roll(node, next); } };
  }
</script>

<Popover id="usage" side="top" align="end" gap={12} class="usage-pop" role="dialog" label={t('上下文与额度')}>
  <div class="up-sec">
    <div class="up-hd">
      <b>{t('上下文')}</b>
      <span class="sub">
        {#if ctx && ctx.total}
          {t('已用 {used} · 共 {total}', { used: fmtTok(ctx.used), total: fmtTok(ctx.total) })}{#if freed} · {t('刚腾出 {n}', { n: fmtTok(freed) })}{/if}
        {:else if ctx}
          {t('已用 {used}', { used: fmtTok(ctx.used) })}
        {/if}
      </span>
      {#if ctx}<span class="up-num roll" use:rollPct={pct + '%'}></span>{/if}
    </div>
    {#if ctx}
      <div class="up-bar">
        <i bind:this={barEl} style="--w:{pct}%" use:grow={40}></i>
        <i class="ghost" bind:this={ghostEl}></i>
      </div>
      {#if phase === 'err'}
        <p class="up-note err">{compaction.error || t('压缩没成功，稍后再试')}</p>
      {:else}
        <p class="up-note">{t('快满时 Codex 会自动压缩。也可以现在就压：前面的对话整理成一段摘要，腾出窗口，这条线程接着用。')}</p>
      {/if}
      {#if thread.id}
        <button
          type="button"
          class="tbtn up-compact"
          class:pri={pct >= 85 && !phase}
          class:busy={phase === 'busy'}
          class:ok={phase === 'ok'}
          bind:this={btnEl}
          onclick={compact}
          aria-busy={phase === 'busy'}
        >
          {#if phase === 'busy'}
            <svg class="spin" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.2" /></svg>
            <span class="lbl">{t('正在压缩')}</span>
          {:else if phase === 'ok'}
            <Icon name="check" class="ic" />
            <span class="lbl">{t('已压缩')}</span>
          {:else}
            <Icon name="shrink" class="ic" />
            <span class="lbl">{t('压缩上下文')}</span>
          {/if}
        </button>
      {/if}
    {:else}
      <p class="up-note none">{thread.id ? t('这条线程还没报过上下文用量，跑完一轮就有了。') : t('新线程还没开始，发出第一句话后这里会显示用了多少。')}</p>
    {/if}
  </div>

  <div class="pop-sep"></div>

  <div class="up-sec">
    <div class="up-acct">
      <b>{t('额度')}</b>
      <span>{acctText}</span>
      {#if canSwitch}<button type="button" class="lnk" onclick={switchAcct}>{t('换号')}</button>{/if}
    </div>
    {#if !usage}
      <p class="up-note none">{t('正在读取额度…')}</p>
    {:else if !usage.available || !rows.length}
      <p class="up-note none">{t('暂时读不到这个号的额度。')}{#if usage.reason === 'not-running'}{t('这个号的 Codex 还没启动，跑过一轮后再看。')}{/if}</p>
    {:else}
      {#each rows as r, i (r.key)}
        <div class="up-row">
          <span class="k">{r.label}</span>
          <span class="mini"><i style="--w:{r.left}%" use:grow={120 + i * 60}></i></span>
          <span class="v">{t('剩')} <span class="roll" use:rollNum={String(r.left)}></span>%</span>
          {#if r.reset}<span class="t">{r.reset}</span>{/if}
        </div>
      {/each}
      {#if usage.stale}<p class="up-stale">{t('这是上次读到的数，可能不是最新。')}</p>{/if}
    {/if}
  </div>
</Popover>

<style>
  .up-hd .sub { min-width: 0; }
  .up-bar i:not(.ghost) { transition: width calc(var(--k, 1) * 480ms) var(--ease-out); }
  .up-compact { transition: background-color var(--d-2, 150ms), color var(--d-2, 150ms), width var(--d-3, 220ms) var(--ease-out); }
  .up-compact :global(.ic) { width: 15px; height: 15px; }
  .up-compact.ok :global(.ic) { animation: up-pop calc(var(--k, 1) * 360ms) cubic-bezier(.34, 1.56, .64, 1) both; }
  .up-note.err { color: var(--warn); }
  .up-note.none { margin-bottom: 0; }
  .up-stale { margin: 6px 0 0; font-size: 11.5px; color: var(--fg3); }
  @keyframes up-pop { from { transform: scale(.5); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .up-compact.ok :global(.ic) { animation: none; } }
</style>
