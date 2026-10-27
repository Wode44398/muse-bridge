<script>
  // 设置行首的彩色图标方块：30×30、Figma 平滑圆角（r 7 / smoothing 60%，路径取自 Figma fillGeometry），
  // 白色符号居中（Medium 字重，默认 17pt；宽字形按墨迹最长边 ≤ 21px 收小，同系统里符号「适配容器」）。
  // 颜色用 iOS 风格的强调色变量（调用方传 var(--i-…)）。
  import Sym from './Sym.svelte';
  import { symTable } from '../../lib/symbolTable.svelte.js';
  let { name, color, glyph = 17, img = null } = $props();
  const fit = $derived.by(() => {
    const g = symTable()[`${name}@500`];
    return g ? Math.min(glyph, 2100 / Math.max(g[0], g[1])) : glyph;
  });
</script>

<span class="tile" style:--c={color}>
  {#if img}<img src={img} alt="" draggable="false" />{:else}<Sym {name} weight={500} size={fit} />{/if}
</span>

<style>
  .tile {
    width: 30px; height: 30px; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--c, #8e8e93); color: #fff;
    clip-path: path('M0 11.2C0 7.28 0 5.32 .76 3.82C1.43 2.5 2.5 1.43 3.82 .76C5.32 0 7.28 0 11.2 0L18.8 0C22.72 0 24.68 0 26.18 .76C27.5 1.43 28.57 2.5 29.24 3.82C30 5.32 30 7.28 30 11.2L30 18.8C30 22.72 30 24.68 29.24 26.18C28.57 27.5 27.5 28.57 26.18 29.24C24.68 30 22.72 30 18.8 30L11.2 30C7.28 30 5.32 30 3.82 29.24C2.5 28.57 1.43 27.5 .76 26.18C0 24.68 0 22.72 0 18.8L0 11.2Z');
  }
  .tile img { width: 100%; height: 100%; object-fit: cover; }
</style>
