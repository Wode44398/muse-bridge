<script>
  // Claude 分页左上角的「Claude Code」字标（高 height px，颜色跟 currentColor）。
  // 原版字标图形（brand/claude-code-wordmark.svg，viewBox 123×16）做遮罩、填 currentColor，观感与内联 SVG 相同。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  let { height = 14 } = $props();
  const svg = $derived(ovUrl('brand/claude-code-wordmark.svg'));
</script>

<span class="wm-img" role="img" aria-label="Claude Code"
  style:height="{height}px" style:width="{(height * 123) / 16}px" style:--wm={`url("${svg}")`}></span>

<style>
  .wm-img { display: block; flex: none; background: currentColor;
    -webkit-mask: var(--wm) center / contain no-repeat; mask: var(--wm) center / contain no-repeat; }
</style>
