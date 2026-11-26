<script>
  // 一条真波形：120 格峰值按行宽重采样成 2px 竖条（底色一层 + 播过的墨色一层，播放头一条墨线）。
  // peaks：undefined = 还在取，null = 拿不到（画一条平线，不编装饰竖线）。
  // grow：挂上时竖条从左到右一根根从中线立起来（生成完成、换音色）；换掉时旧的压扁退场。
  import { onMount } from 'svelte';
  import { anim, quiet, ease, EIN, SPRING_POP } from './fx.js';

  let { peaks, p = 0, head = false, grow = false, ongrown = null } = $props();
  const H = 34;
  let W = $state(0), svg = $state();
  const bars = $derived.by(() => {
    if (!Array.isArray(peaks) || !peaks.length || !W) return [];
    const n = Math.max(24, Math.floor(W / 4)), bw = 2, step = W / n, out = [];
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(1, Number(peaks[Math.min(peaks.length - 1, Math.floor((i / n) * peaks.length))]) || 0));
      const h = Math.max(2, v * (H - 4));
      out.push({ x: +(i * step + (step - bw) / 2).toFixed(2), y: +((H - h) / 2).toFixed(2), h: +h.toFixed(2) });
    }
    return out;
  });

  let grown = false;
  function growNow() {
    if (grown || !svg) return;
    const rs = svg.querySelectorAll('.w-base rect, .w-play rect');
    if (!rs.length) return;
    grown = true;
    if (quiet(svg)) { ongrown?.(); return; }
    const n = rs.length / 2;
    let lastA = null;
    rs.forEach((r, i) => {
      const k = i % n;
      lastA = anim(r, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { d: SPRING_POP.ms * 0.8, e: ease(SPRING_POP), delay: k * (840 / n), fill: 'backwards' }) || lastA;
    });
    lastA?.finished.then(() => ongrown?.()).catch(() => {});
  }
  onMount(() => { if (grow) requestAnimationFrame(growNow); });
  $effect(() => { if (grow && bars.length) requestAnimationFrame(growNow); });

  // 换掉（换音色、换了一件）：旧波形往中线压扁、淡掉
  function squash(node) {
    if (quiet(node)) return { duration: 0 };
    return { duration: 140, easing: (x) => x * x, css: (t) => `opacity:${t};transform:scaleY(${(0.2 + 0.8 * t).toFixed(3)})` };
  }
</script>

<div class="sw-wave" class:head bind:clientWidth={W} style="--p:{(p * 100).toFixed(2)}%" out:squash>
  {#if bars.length}
    <div class="sw-bars" bind:this={svg}>
      <svg class="w-base" viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">{#each bars as b, i (i)}<rect x={b.x} y={b.y} width="2" height={b.h} rx="1" />{/each}</svg>
      <svg class="w-play" viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">{#each bars as b, i (i)}<rect x={b.x} y={b.y} width="2" height={b.h} rx="1" />{/each}</svg>
    </div>
  {:else}
    <i class="sw-flat" class:wait={peaks === undefined} aria-hidden="true"></i>
  {/if}
  <i class="sw-head" aria-hidden="true"></i>
</div>
