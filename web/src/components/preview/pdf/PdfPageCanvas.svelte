<script>
  // 把 PDF 的第 n 页画进 w×h 的框（等比放进去、居中）。放映用：一页一张画布，尺寸变了重画，切走时取消在途的渲染。
  // 清晰度同主视图：DPR 封顶（pdfjs.js）+ 单张像素上限，超了就按上限降分辨率（放映满屏一张，不会超多少）。
  import { onDestroy } from 'svelte';
  import { maxCanvasPixels } from './pdfjs.js';

  let { pdf, n = 1, w = 0, h = 0, rotation = 0, night = false } = $props();

  let canvas = $state(null);
  let task = null, seq = 0;

  async function draw(page, W, H, rot) {
    const my = ++seq;
    try { task?.cancel(); } catch {}
    task = null;
    if (!pdf || !W || !H || !canvas) return;
    try {
      const p = await pdf.getPage(page);
      if (my !== seq) return;
      const r = (p.rotate + rot) % 360;
      const vp1 = p.getViewport({ scale: 1, rotation: r });
      const css = Math.min(W / vp1.width, H / vp1.height);
      let dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
      const px = vp1.width * css * dpr * vp1.height * css * dpr;
      const cap = maxCanvasPixels();
      if (px > cap) dpr *= Math.sqrt(cap / px);
      const vp = p.getViewport({ scale: css * dpr, rotation: r });
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
      const ctx = off.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height);
      task = p.render({ canvasContext: ctx, viewport: vp, background: '#fff' });
      await task.promise;
      if (my !== seq || !canvas) return;
      // 画好再一次性换上：重画期间旧画面留着，不闪白
      canvas.width = off.width; canvas.height = off.height;
      canvas.getContext('2d').drawImage(off, 0, 0);
      canvas.style.width = Math.round(vp.width / dpr) + 'px';
      canvas.style.height = Math.round(vp.height / dpr) + 'px';
      off.width = off.height = 0;
    } catch { /* 取消或单页坏了：留白 */ }
  }

  $effect(() => { draw(n, w, h, rotation); });
  onDestroy(() => { seq++; try { task?.cancel(); } catch {} });
</script>

<div class="ppc" class:night style:width="{w}px" style:height="{h}px"><canvas bind:this={canvas}></canvas></div>

<style>
  .ppc { display: flex; align-items: center; justify-content: center; background: #fff; overflow: hidden; }
  canvas { display: block; }
  :global(html:not([data-theme="light"])) .ppc.night canvas { filter: invert(.88) hue-rotate(180deg); }
</style>
