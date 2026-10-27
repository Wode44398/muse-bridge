<script>
  // Claude 分页左上角的「Claude Code」名称（高 height px，颜色跟 currentColor）。
  // 公开版：纯文字（品牌衬线字体，平实写明「Claude Code」）。
  // 维护者的私有 overlay 提供字标图形时（overlay 的 brand/claude-code-wordmark.svg，viewBox 123×16）
  // 用它做遮罩、填 currentColor，观感与内联 SVG 相同。
  import { ovHas, ovUrl } from '../../lib/overlay.svelte.js';
  let { height = 14 } = $props();
  const REL = 'brand/claude-code-wordmark.svg';
  const svg = $derived(ovHas(REL) ? ovUrl(REL) : '');
</script>

{#if svg}
  <span class="wm-img" role="img" aria-label="Claude Code"
    style:height="{height}px" style:width="{(height * 123) / 16}px" style:--wm={`url("${svg}")`}></span>
{:else}
  <span class="wm-text" style="font-size:{height * 1.22}px;line-height:{height}px;height:{height}px">Claude Code</span>
{/if}

<style>
  .wm-img { display: block; flex: none; background: currentColor;
    -webkit-mask: var(--wm) center / contain no-repeat; mask: var(--wm) center / contain no-repeat; }
  .wm-text { display: block; flex: none; white-space: nowrap; font-family: var(--font-brand-serif), Georgia, serif;
    font-weight: 600; letter-spacing: -.02em; }
</style>
