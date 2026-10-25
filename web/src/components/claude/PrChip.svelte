<script>
  // 输入框上方归属状态栏里的 PR 芯片：「#123 ●」，点开会话面板并展开「拉取请求」卡（B2 §4.3 / 4.7 的落点）。
  // 圆点颜色 = 状态：检查失败 / 冲突红、检查运行中琥珀、已合并紫、其余绿；草稿、已关闭灰。
  // 只在当前会话绑定了 PR 时出现；数据与 PR 卡同一份（lib/pr.svelte.js，看得见时定时刷新）。
  import { session } from '../../lib/state.svelte.js';
  import { rail, toggleRail, railVisible } from '../../lib/sessionRail.svelte.js';
  import { prViewOf, watchPr, mainPr, prTone, ciStatus, stateLabel } from '../../lib/pr.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { untrack } from 'svelte';

  const sid = $derived(session.id || '');
  // 只依赖 sid：watchPr 里同步发起的拉取会读写 PR 状态，不能让它成为这个 effect 的依赖（否则请求一结束就重跑，死循环）
  $effect(() => { const id = sid; return untrack(() => watchPr(id)); });
  const pr = $derived(mainPr(prViewOf(sid)));
  const tone = $derived(prTone(pr));
  const CI_TXT = { failed: t('检查失败'), passed: t('检查通过'), pending: t('检查运行中'), skipped: t('检查已跳过'), none: t('尚未上报任何检查'), unavailable: '' };

  function open() {
    rail.fold.pr = false;
    if (!railVisible()) toggleRail(true);
  }
</script>

{#if pr}
  {@const ci = CI_TXT[ciStatus(pr)]}
  <button class="prchip" data-rail-toggle title={`${pr.title}\n${stateLabel(pr.state)}${ci ? ' · ' + ci : ''}`} aria-label={t('拉取请求 #{n}', { n: pr.number })} onclick={open}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/><path d="M13 4l-2 2 2 2"/></svg>
    <span class="lbl">#{pr.number}</span>
    <span class="dot {tone}" aria-hidden="true"></span>
  </button>
{/if}

<style>
  /* 形制同 WorkspaceChips 的芯片（高 24 / 圆角 6 / 不透明底） */
  .prchip { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; border: 0; border-radius: 6px;
    font-size: 13px; line-height: 19px; color: var(--serif); font-variant-numeric: tabular-nums;
    background-color: var(--bg); background-image: linear-gradient(var(--hover), var(--hover));
    --d-ok: #32d74b; --d-fail: #ff2c56; --d-warn: #db9300; --d-merged: #a371f7; }
  :global(html[data-theme="light"]) .prchip { box-shadow: inset 0 0 0 1px rgba(11, 11, 11, .1), 0 1px 2px rgba(11, 11, 11, .04);
    --d-ok: #1e9e3c; --d-fail: #cd2054; --d-warn: #734500; --d-merged: #8250df; }
  .prchip:hover { color: var(--text); }
  .prchip svg { width: 14px; height: 14px; flex: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.ok { background: var(--d-ok); }
  .dot.fail, .dot.conflict { background: var(--d-fail); }
  .dot.pending { background: var(--d-warn); animation: prcPulse 1.6s ease-in-out infinite; }
  .dot.merged { background: var(--d-merged); }
  @keyframes prcPulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .dot.pending { animation: none; } }
</style>
