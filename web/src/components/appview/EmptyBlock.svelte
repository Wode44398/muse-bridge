<script>
  // empty 积木：{ title, desc?, icon? }。插件自己的空状态，也是服务端在 view 出错时回的那一块（「应用出错了」+ 原因）。
  // 居中一组：图标方块 + 标题 + 说明，同 AppView 的首屏空 / 出错页一个样子；没给图标画一个中性的空盒，不用彩色。
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  let { block } = $props();
</script>

<div class="em">
  <span class="ic" aria-hidden="true">
    {#if block.icon}
      {@html uiIcon(block.icon)}
    {:else}
      <svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 13.5 6.4 6a2 2 0 0 1 1.9-1.4h7.4A2 2 0 0 1 17.6 6l2.4 7.5M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5M4 13.5h4.2l1.3 2.2h5l1.3-2.2H20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    {/if}
  </span>
  {#if block.title}<p class="t">{block.title}</p>{/if}
  {#if block.desc}<p class="d">{block.desc}</p>{/if}
</div>

<style>
  .em { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 36px 24px 40px; }
  .ic {
    width: 52px; height: 52px; border-radius: 15px; display: grid; place-items: center; margin-bottom: 8px;
    background: var(--av-tile); color: var(--av-ink2);
  }
  .ic :global(svg) { width: 24px; height: 24px; }
  :global(.av-desk) .ic { width: 44px; height: 44px; border-radius: 12px; }
  :global(.av-desk) .ic :global(svg) { width: 21px; height: 21px; }
  .t { font-size: calc(var(--av-fs) + 1px); line-height: var(--av-lh); font-weight: 600; color: var(--av-ink); overflow-wrap: anywhere; }
  .d { max-width: 420px; font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
