<script>
  // 设置页符号字形（lib/symbolTable.svelte.js：公开版是 Lucide 字形，私有 overlay 可换一套）。
  // size = 字号（pt）：字形按 100pt 墨迹盒等比缩放，颜色跟 currentColor。
  import { symTable } from '../../lib/symbolTable.svelte.js';
  let { name, weight = 600, size = 17, class: cls = '', style = '' } = $props();
  const g = $derived.by(() => { const SF = symTable(); return SF[`${name}@${weight}`] || SF[`${name}@600`] || SF[`${name}@500`] || SF[`${name}@400`]; });
</script>

{#if g}
  <svg class="sym {cls}" {style} width={+(g[0] * size / 100).toFixed(2)} height={+(g[1] * size / 100).toFixed(2)}
    viewBox="0 0 {g[0]} {g[1]}" aria-hidden="true" focusable="false"><path d={g[2]} fill="currentColor" /></svg>
{/if}

<style>
  .sym { flex: none; display: block; overflow: visible; }
</style>
