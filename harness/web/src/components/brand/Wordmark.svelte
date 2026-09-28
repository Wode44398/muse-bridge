<script lang="ts">
  // dimensio 字标：思源宋体 600 的字形轮廓（与 bridge 官网字标「bridge」同一款字、同一字重；几何见 lib/brand.ts）。
  // 画成路径而不是文字：不依赖字体加载，任何尺寸都是同一个形。height = 字标总高（px，升部顶到圆形字母的下冲）。
  import { WORDMARK } from "../../lib/brand.ts";

  let { height = 20, label = "dimensio" }: { height?: number; label?: string } = $props();

  const b = WORDMARK.box;
  const vb = `${b.x} ${b.y} ${b.w} ${b.h}`;
  const width = $derived(Math.round((b.w / b.h) * height * 10) / 10);
</script>

<svg class="wm" viewBox={vb} {width} {height} role="img" aria-label={label}>
  <path d={WORDMARK.d} />
</svg>

<style>
  .wm {
    display: block;
    flex: none;
    overflow: visible;
    fill: currentColor;
  }
</style>
