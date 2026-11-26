<script>
  // 墙上的一格（绝对定位 + transform，位置由 Wall 算好传进来）。同一格从「在跑的任务」一路走到「作品」：
  //   run / err → DevFrame；任务完成、这一格拿到结果作品 → reveal：作品格子先垫在底下，DevFrame 在上面显影，
  //   显完、底下那张也解码好了才撤掉 DevFrame（两张是同一档同一张图，看不出接缝）→ done：只剩作品格子。
  // 一开始就是作品的格子（翻页、刷新）直接是 done。
  import { onMount, untrack } from 'svelte';
  import DevFrame from './DevFrame.svelte';
  import Tile from './Tile.svelte';
  import { place, leaveCell, anim, quiet } from './fx.js';

  let { entry, pos, page, compact = false, paused = false, fresh = false, lifted = false, onrelease = null, onratio = null, onmenu = null } = $props();

  const startedDev = untrack(() => !entry.asset);
  let devDone = $state(false), tileReady = $state(false);
  const phase = $derived(
    !entry.asset ? (entry.job?.state === 'error' ? 'err' : 'run')
      : startedDev && entry.job && !(devDone && tileReady) ? 'reveal' : 'done',
  );
  // 底下那张万一一直加载不出来（Img 会出「重新加载」），别让显影的最后一帧永远盖在上面
  $effect(() => { if (devDone && !tileReady) { const tm = setTimeout(() => { tileReady = true; }, 2500); return () => clearTimeout(tm); } });
  onMount(() => { if (!startedDev) onrelease?.(entry.key); });
  // 落定：作品格子轻轻一沉再回来（余波），和错拍标合拍同一拍
  let el = $state();
  let landed = false;
  $effect(() => {
    if (phase !== 'done' || !startedDev || landed) return;
    landed = true;
    const tile = el?.querySelector('.sw-tile');
    if (tile && !quiet(el)) anim(tile, [{ transform: 'scale(1)' }, { transform: 'scale(1.018)', offset: 0.35 }, { transform: 'scale(1)' }], { d: 520, e: 'cubic-bezier(.3,.7,.4,1)' });
  });
</script>

<div class="sw-it" bind:this={el} class:dev={phase !== 'done'} class:lifted use:place={pos} out:leaveCell>
  {#if entry.asset}
    <Tile asset={entry.asset} w={pos?.w || 0} handoff={startedDev} {onratio} {onmenu} onready={() => (tileReady = true)} />
  {/if}
  {#if phase !== 'done' && entry.job}
    <DevFrame job={entry.job} asset={entry.asset} {phase} w={pos?.w || 0} h={pos?.h || 0} {page} {compact} {paused} {fresh}
      onmid={() => onrelease?.(entry.key)} ondone={() => { devDone = true; }} />
  {/if}
</div>
