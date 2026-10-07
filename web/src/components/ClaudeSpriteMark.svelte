<script>
  // 新版 claude.ai 聊天页同款运行标记（spark → nodes / 等人方块），播放逻辑在 lib/spriteMark.js。
  // phase：pending（等首字）| working（干活中）| blocked（等你操作）
  import { onMount } from 'svelte';
  import { SpritePlayer, preloadSprite } from '../lib/spriteMark.js';

  let { phase = 'pending', box = 20 } = $props();
  let host = $state(null);
  let player = null;

  onMount(() => {
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    player = new SpritePlayer(host, box, still);
    player.set(phase);
    preloadSprite('nodes');   // spark 播着的时候把 nodes 也拉好，转场才能按帧接上
    return () => { player.destroy(); player = null; };
  });
  $effect(() => { const p = phase; player?.set(p); });
</script>

<span class="csm" bind:this={host} style="width:{box}px;height:{box}px" aria-hidden="true" data-testid="TurnStatusLeftMark"></span>

<style>
  .csm { position: relative; display: inline-block; flex: none; line-height: 0; color: #d97757; user-select: none; }
  .csm :global(.sm-clip) { position: absolute; display: block; overflow: clip; }
  .csm :global(.sm-strip) { display: block; }
  .csm :global(.sm-strip > svg) { display: block; width: 100%; height: auto; fill: currentColor; }
  @media (max-resolution: 1.99dppx) { .csm :global(.sm-clip) { clip-path: inset(1px 0); } }
</style>
