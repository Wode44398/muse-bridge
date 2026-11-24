<script>
  // Claude 官方星芒（lib/claudeSpark.js 的共享矢量原件）：think = 官方「思考」9 帧逐帧翻（全页共用一个翻帧时钟，
  // 减少动态效果时停在第 0 帧）；否则是单色规整星芒。颜色跟 currentColor，由外层给（在跑 = 陶土色，菜单 = 文字色）。
  import { CLAUDE_SPARK_PATH, CLAUDE_SPARK_VIEWBOX, CLAUDE_THINK_FRAMES, CLAUDE_THINK_VIEWBOX, onThinkFrame } from '../../../lib/claudeSpark.js';

  let { size = 15, think = false } = $props();
  let frame = $state(0);
  $effect(() => { if (think) return onThinkFrame((f) => (frame = f)); });
</script>

{#if think}
  <svg class="csp" width={size} height={size} viewBox={CLAUDE_THINK_VIEWBOX} fill="currentColor" aria-hidden="true"><path d={CLAUDE_THINK_FRAMES[frame]} /></svg>
{:else}
  <svg class="csp" width={size} height={size} viewBox={CLAUDE_SPARK_VIEWBOX} fill="currentColor" aria-hidden="true"><path d={CLAUDE_SPARK_PATH} /></svg>
{/if}

<style>
  .csp { display: block; flex: none; }
</style>
