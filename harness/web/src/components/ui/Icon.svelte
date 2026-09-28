<script lang="ts">
  // 线稿图标（lib/icons.ts）。fill = 实心画法（停止键的方块、状态点）。
  import { I, type IconName } from "../../lib/icons.ts";

  let {
    name,
    size = 18,
    stroke = 1.6,
    fill = false,
    class: cls = "",
  }: { name: IconName; size?: number; stroke?: number; fill?: boolean; class?: string } = $props();
</script>

<svg
  class="hx-icon {cls}"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill={fill ? "currentColor" : "none"}
  stroke={fill ? "none" : "currentColor"}
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={I[name]} />
</svg>

<style>
  .hx-icon {
    display: block;
    flex: none;
  }
</style>
