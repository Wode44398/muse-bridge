<script>
  // buttons 积木：{ items: button[] }（最多 6 个）。一行排开、放不下就折行；手机上各颗等分撑满一行，桌面壳靠左挨着排。
  import ActButton from './ActButton.svelte';
  let { block, ctx } = $props();
  const items = $derived((Array.isArray(block.items) ? block.items : []).slice(0, 6));
</script>

{#if items.length}
  <div class="bs" class:desk={ctx.variant === 'desktop'}>
    {#each items as b, i (i)}
      <ActButton label={b.label} act={b.action} confirm={b.confirm || ''} style={b.style} {ctx} full={ctx.variant !== 'desktop'} />
    {/each}
  </div>
{/if}

<style>
  .bs { display: flex; flex-wrap: wrap; gap: 10px; }
  .bs > :global(*) { flex: 1 1 120px; }
  .bs.desk { gap: 8px; padding: 0 var(--av-px); }
  .bs.desk > :global(*) { flex: 0 0 auto; }
</style>
