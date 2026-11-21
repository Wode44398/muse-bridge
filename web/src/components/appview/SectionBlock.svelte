<script>
  // section 积木：{ title?, desc?, children }——设置页的「一组」：组头（小号灰字标题 + 说明）在上，孩子在下排成一列。
  // 孩子用 Block 递归画（服务端已把深度封在 6 层）；嵌套的 section 之间多留一点空，层次靠留白分，不加边框套边框。
  import Block from './Block.svelte';
  let { block, ctx } = $props();
  const kids = $derived(Array.isArray(block.children) ? block.children : []);
</script>

{#if block.title || block.desc || kids.length}
  <section class="sec">
    {#if block.title || block.desc}
      <header class="hd">
        {#if block.title}<h3 class="av-head ttl">{block.title}</h3>{/if}
        {#if block.desc}<p class="desc">{block.desc}</p>{/if}
      </header>
    {/if}
    {#if kids.length}
      <div class="kids">
        {#each kids as child, i (i)}
          <Block block={child} {ctx} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .sec { display: flex; flex-direction: column; min-width: 0; }
  .hd { padding-bottom: 8px; }
  .ttl { padding-bottom: 0; }
  .desc {
    padding: 2px var(--av-px) 0; white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink3);
  }
  .kids { display: flex; flex-direction: column; gap: var(--av-gap-in); min-width: 0; }
  /* 组里套组：上面多空一截，读得出「这是下一组」 */
  .kids > :global(.sec) { margin-top: 10px; }
  .kids > :global(.sec:first-child) { margin-top: 0; }
</style>
