<script>
  // image 积木：{ src, alt?, height?(40–600) }。src 服务端已改写成 /plugins/<插件>/web/…（只认插件 web/ 下的图片）；
  // 这里再按「只认本插件的 /plugins/<插件>/web/」守一道（别的地址一律不画），再按服务器地址补全（离线 App 跨源）。
  // 图片放进一张圆角卡里，按比例缩到列宽；给了 height 就定高、按比例裁成 contain，没给按图片自己的比例。
  import { apiUrl } from '../../lib/server.js';
  let { block, ctx } = $props();
  const src = $derived.by(() => {
    const s = typeof block.src === 'string' ? block.src : '';
    const pre = '/plugins/' + ctx.plugin + '/web/';
    return ctx.plugin && s.startsWith(pre) && !s.includes('..') ? apiUrl(s) : '';
  });
  const h = $derived(typeof block.height === 'number' ? Math.min(600, Math.max(40, block.height)) : 0);
  let broken = $state(false);
  $effect(() => { src; broken = false; });
</script>

{#if src}
  <figure class="im av-card" class:fixed={!!h} class:broken style:height={h ? h + 'px' : null}>
    {#if !broken}
      <img {src} alt={block.alt || ''} loading="lazy" decoding="async" draggable="false" onerror={() => (broken = true)} />
    {:else}
      <span class="bad" aria-label={block.alt || ''}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m4 16 4.5-4.5 3.5 3.5 2.5-2.5L20 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="15.5" cy="9" r="1.5" fill="currentColor"/></svg>
      </span>
    {/if}
  </figure>
{/if}

<style>
  .im { margin: 0; display: flex; align-items: center; justify-content: center; }
  .im img { display: block; width: 100%; height: auto; }
  .im.fixed img { height: 100%; object-fit: contain; }
  .im.broken { min-height: 96px; }
  .bad { display: grid; place-items: center; color: var(--av-ink3); }
</style>
