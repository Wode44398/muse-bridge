<script lang="ts">
  // 输入框上方状态区里的一格：出现 = 高度从 0 长出来 + 内容浮起，消失 = 收拢 + 退隐。
  // 状态区贴着输入框、往上长：某一格长高 / 收起时，它上面的格子与对话流跟着平滑地让位，下面的（停靠卡、输入框）纹丝不动。
  // 间距放在内层 padding 里（collapse 量的是整格，外层自己不能有 margin / padding，否则收到最后一帧会跳）。
  import type { Snippet } from "svelte";
  import { collapse, rise } from "../../lib/motion.ts";

  let { children, gap = 8 }: { children: Snippet; gap?: number } = $props();
</script>

<div class="slot" transition:collapse|global>
  <div class="pad" style="padding-bottom:{gap}px" in:rise|global={{ y: 6 }}>
    {@render children()}
  </div>
</div>

<style>
  .slot {
    flex: none;
    min-width: 0;
  }
  .pad {
    min-width: 0;
  }
</style>
