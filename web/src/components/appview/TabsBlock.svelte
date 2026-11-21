<script>
  // tabs 积木：{ value, items: [{ id, label }]（最多 8 个）, action }。切换 → ctx.run(action, { tab: 新 id })，插件回新树。
  //   手机：四个以内用设置页的分段控件（ios27 Segmented），多了换成能横滑的一排胶囊（分段塞八格字就看不清了）；
  //   桌面壳：五个以内桌面 kit 的 DSegmented，多了同样一排胶囊（桌面配色）。
  // 先按新选中画（乐观），动作回来以新树的 value 为准；动作没成功就回到原来那格。
  import Segmented from '../ios27/Segmented.svelte';
  import DSegmented from '../../desktop/kit/DSegmented.svelte';
  let { block, ctx } = $props();

  const items = $derived((Array.isArray(block.items) ? block.items : []).slice(0, 8));
  const desk = $derived(ctx.variant === 'desktop');
  let pending = $state(null);
  const cur = $derived(pending ?? block.value);
  const options = $derived(items.map((x) => ({ value: x.id, label: x.label })));
  const seg = $derived(items.length >= 2 && items.length <= (desk ? 5 : 4));

  async function pick(id) {
    if (id === cur || pending !== null) return;
    pending = id;
    try { await ctx.run(block.action, { tab: id }); } finally { pending = null; }
  }
</script>

{#if items.length}
  {#if seg && desk}
    <div class="tb desk"><DSegmented {options} value={cur} onchange={pick} /></div>
  {:else if seg}
    <div class="tb"><Segmented {options} value={cur} onchange={pick} size="small" /></div>
  {:else}
    <div class="chips" class:desk role="tablist">
      {#each items as x (x.id)}
        <button type="button" class="chip" class:on={x.id === cur} role="tab" aria-selected={x.id === cur} onclick={() => pick(x.id)}>{x.label}</button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .tb.desk { display: flex; padding: 0 var(--av-px); }
  .tb.desk > :global(*) { flex: 0 1 auto; min-width: min(100%, 320px); }
  /* 胶囊一排：放不下就横滑，左右各留到列边，滑动时不出滚动条 */
  .chips {
    display: flex; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none;
    margin: 0 -16px; padding: 0 16px;
  }
  .chips::-webkit-scrollbar { display: none; }
  .chip {
    flex: none; height: 32px; padding: 0 14px; border: 0; border-radius: 16px; cursor: pointer;
    font: inherit; font-size: 14px; line-height: 1; font-weight: 500; white-space: nowrap;
    background: var(--av-fill2); color: var(--av-ink);
    transition: background var(--av-t), color var(--av-t), transform var(--mo-tap, .09s) var(--ea-out, ease-out);
  }
  .chip:active { transform: scale(.96); }
  .chip.on { background: var(--av-accent); color: var(--av-on-accent); font-weight: 600; }
  .chip:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .chips.desk { margin: 0; padding: 0 var(--av-px); gap: 6px; }
  .chips.desk .chip { height: var(--av-btn-h); padding: 0 12px; border-radius: var(--av-btn-r); font-size: var(--av-fs-sm); }
  @media (hover: hover) { .chips.desk .chip:not(.on):hover { background: var(--av-press); } }
</style>
