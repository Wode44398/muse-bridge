<script>
  // Claude 官方「思考」星芒：9 帧手绘形变逐帧翻（和 claude.ai 同一种翻书式），全页共用一个翻帧时钟（lib/claudeSpark.js）。
  // live=false 时画单色规整星芒（静止的 Claude 标志）。颜色跟 currentColor 走，调用方给陶土色。
  import { CLAUDE_SPARK_PATH, CLAUDE_SPARK_VIEWBOX, CLAUDE_THINK_FRAMES, CLAUDE_THINK_VIEWBOX, onThinkFrame } from '../../lib/claudeSpark.js';

  const { live = true, size = 14 } = $props();

  let frame = $state(0);
  $effect(() => {
    if (!live) return;
    return onThinkFrame((i) => { frame = i; });
  });
</script>

{#if live}
  <svg class="agy-cthink" viewBox={CLAUDE_THINK_VIEWBOX} width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d={CLAUDE_THINK_FRAMES[frame]} />
  </svg>
{:else}
  <svg class="agy-cthink" viewBox={CLAUDE_SPARK_VIEWBOX} width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d={CLAUDE_SPARK_PATH} />
  </svg>
{/if}

<style>
  .agy-cthink { display: block; flex: none; }
</style>
