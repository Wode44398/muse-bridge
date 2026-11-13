<script>
  // 开关（dimensio components/ui/Switch.svelte 同款）：开 = 墨底，圆钮弹跳滑过去。label 给读屏器（视觉标签由外面的行负责）。
  let { checked = false, onchange, label = '', disabled = false } = $props();
</script>

<button type="button" class="sw" class:on={checked} role="switch" aria-checked={checked} aria-label={label} {disabled} onclick={() => onchange?.(!checked)}>
  <span class="sw-k"></span>
</button>
