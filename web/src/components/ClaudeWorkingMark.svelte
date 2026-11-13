<script module>
  let clayMod;   // clay 播放器模块：取到一次之后新挂的标记同步可用，不必再等一拍
</script>

<script>
  // Claude 运行标记（设置「思考动画」的默认档 clay）。
  // 播放器与素材、帧表都是原版资源（清单 modules.clayMark、data.marks.clay），挂上逐帧播；
  // 模块到之前先放一颗陶土色圆点（和播放器起步那颗一样）。
  // 接口：activity: default|think|search|read|code|write|compose；state: working|blocked|tile
  import { untrack } from 'svelte';
  import { ovData, ovModule } from '../lib/overlay.svelte.js';

  let { activity = 'default', state: markState = 'working', paused = false, size = 20, box = size, standalone = false } = $props();

  const pack = $derived(ovData('marks')?.clay || null);
  let mod = $state(clayMod || null);
  $effect(() => {
    if (mod) return;
    let alive = true;
    ovModule('clayMark').then((m) => {
      if (!(m && typeof m.ClayMark === 'function')) return;
      clayMod = m;
      if (alive) mod = m;
    });
    return () => { alive = false; };
  });

  let host = $state(null);
  let player = null;
  $effect(() => {
    const m = mod, el = host, p = pack, s = size, b = box;
    if (!m || !el || !p) return;
    try {
      player = new m.ClayMark(el, { pack: p, size: s, box: b, ...untrack(() => ({ standalone, activity, state: markState, paused })) });
    } catch (e) { console.error('[overlay] clayMark 挂载失败：', e?.message || e); return; }   // i18n-ignore 只进控制台
    return () => { player?.destroy(); player = null; };
  });
  $effect(() => { const a = activity, st = markState, pz = paused; player?.set({ activity: a, state: st, paused: pz }); });
</script>

{#if mod && pack}
  <span class="cwm-ov" bind:this={host} style="width:{box}px;height:{box}px" aria-hidden="true" data-cds="WorkingMark"></span>
{:else}
  <span class="cwm-wait" style="width:{box}px;height:{box}px" aria-hidden="true" data-cds="WorkingMark">
    <span class="dot" style="width:{size * 0.35}px;height:{size * 0.35}px"></span>
  </span>
{/if}

<style>
  .cwm-ov { display: inline-flex; flex: none; line-height: 0; }
  .cwm-wait { display: inline-flex; align-items: center; justify-content: center; flex: none; line-height: 0; }
  .dot { border-radius: 50%; background: #d97757; }
</style>
