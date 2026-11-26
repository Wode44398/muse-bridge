<script>
  // Codex 的待办计划（plan 事件 / update_plan）：随状态逐条打勾。在跑时摊开，跑完收成一行「计划 · 4 步都完成了」，点开再看。
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { t } from '../../lib/i18n.js';
  import { rolled } from '../../lib/codex/motion.js';

  let { plan, live = false } = $props();

  const steps = $derived(plan?.steps || []);
  const doneN = $derived(steps.filter((s) => /^complete/i.test(s.status)).length);
  const cur = $derived.by(() => {
    const i = steps.findIndex((s) => /progress/i.test(s.status));
    if (i >= 0) return i;
    return steps.findIndex((s) => !/^complete/i.test(s.status));
  });
  const allDone = $derived(steps.length > 0 && doneN === steps.length);
  const stepText = $derived(t('第 {i} / {n} 步', { i: Math.min(steps.length, (cur < 0 ? doneN : cur) + 1), n: steps.length }));

  let open = $state(untrack(() => live));
  let touched = false;
  $effect(() => { if (!live && !touched) open = false; });
  const toggle = () => { touched = true; open = !open; };
</script>

{#if steps.length}
  <div class="cx-plan sq" class:open>
    <button class="pl-hd" onclick={toggle} aria-expanded={open}>
      <Icon name="plan" class="mi-ico" />
      <b>{t('计划')}</b>
      {#if allDone}<span class="pp">{t('{n} 步都完成了', { n: steps.length })}</span>{:else}<span class="pp roll" use:rolled={stepText}></span>{/if}
      <span class="segs" aria-hidden="true">{#each steps as s, i}<i class:on={/^complete/i.test(s.status)} class:cur={i === cur && live}></i>{/each}</span>
      <span class="grow"></span>
      <Icon name="chev" class="pl-chev" />
    </button>
    <div class="pl-body"><div><div class="pl-in">
      {#if plan.explanation}<p class="pl-ex">{plan.explanation}</p>{/if}
      {#each steps as s, i}
        <div class="step" class:done={/^complete/i.test(s.status)} class:cur={i === cur && live}><span class="ck"><svg viewBox="0 0 10 10"><path d="M2 5.2l2 2 4-4.4" /></svg></span><span class="st">{s.step}</span></div>
      {/each}
    </div></div></div>
  </div>
{/if}

<style>
  .cx-plan { --r: 16px; border: 1px solid var(--line2); overflow: hidden; }
  .pl-hd { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 12px; font-size: 12.5px; color: var(--fg2); font-variant-numeric: tabular-nums; border-radius: 0; }
  .pl-hd b { font-weight: 500; color: var(--fg); }
  .pl-hd:hover { background: var(--fill1); }
  .pp { white-space: nowrap; }
  .segs { display: flex; gap: 3px; }
  .segs i { width: 14px; height: 4px; border-radius: 2px; background: var(--fill4); transition: background-color var(--d-4); }
  .segs i.on { background: var(--fg); }
  .segs i.cur { background: var(--fg3); animation: cx-ball-pulse calc(var(--k) * 2s) infinite; }
  .pl-hd :global(.pl-chev) { width: 14px; height: 14px; color: var(--fg3); transform: rotate(-90deg); transition: transform var(--d-3) var(--ease-out); }
  .open .pl-hd :global(.pl-chev) { transform: none; }
  .pl-body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--d-4) var(--ease-out); }
  .pl-body > div { min-height: 0; overflow: hidden; }
  .open .pl-body { grid-template-rows: 1fr; }
  .pl-in { padding: 0 12px 8px; border-top: 1px solid var(--line1); }
  .pl-ex { margin: 8px 0 2px; color: var(--fg3); font-size: 12.5px; line-height: 1.55; }
  .step { height: auto; min-height: 28px; padding: 4px 0; }
  .step .st { min-width: 0; overflow-wrap: anywhere; line-height: 1.45; }
  .step .ck { flex: none; }
  @container cx (max-width: 640px) {
    .segs { display: none; }
  }
</style>
