<script>
  // Claude 运行标记的「sprite」档（设置「运行标记」三选一之一）。phase：pending（等首字）| working（干活中）| blocked（等你操作）
  // 播放模块与素材是原版资源（清单 modules.spriteMark：SpritePlayer / preloadSprite）；模块到之前先放一颗圆点。
  import { onMount, untrack } from 'svelte';
  import { ovModule } from '../lib/overlay.svelte.js';

  let { phase = 'pending', box = 20 } = $props();
  let host = $state(null);
  let mod = $state(null);
  let player = null;

  onMount(() => {
    let alive = true;
    ovModule('spriteMark').then((m) => { if (alive && m && typeof m.SpritePlayer === 'function') mod = m; });
    return () => { alive = false; player?.destroy(); player = null; };
  });

  $effect(() => {
    const m = mod, el = host;
    if (!m || !el) return;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    player = new m.SpritePlayer(el, box, still);
    player.set(untrack(() => phase));
    m.preloadSprite?.('nodes');   // spark 播着的时候把 nodes 也拉好，转场才能按帧接上
    return () => { player?.destroy(); player = null; };
  });
  $effect(() => { const p = phase; player?.set(p); });
</script>

{#if mod}
  <span class="csm" bind:this={host} style="width:{box}px;height:{box}px" aria-hidden="true" data-testid="TurnStatusLeftMark"></span>
{:else}
  <span class="csm-wait" style="width:{box}px;height:{box}px" aria-hidden="true" data-testid="TurnStatusLeftMark"><span class="dot"></span></span>
{/if}

<style>
  .csm { position: relative; display: inline-block; flex: none; line-height: 0; color: #d97757; user-select: none; }
  .csm-wait { display: inline-flex; align-items: center; justify-content: center; flex: none; line-height: 0; color: #d97757; user-select: none; }
  .dot { width: 35%; height: 35%; border-radius: 50%; background: currentColor; }
  .csm :global(.sm-clip) { position: absolute; display: block; overflow: clip; }
  .csm :global(.sm-strip) { display: block; }
  .csm :global(.sm-strip > svg) { display: block; width: 100%; height: auto; fill: currentColor; }
  @media (max-resolution: 1.99dppx) { .csm :global(.sm-clip) { clip-path: inset(1px 0); } }
</style>
