<script lang="ts">
  // 开关：开 = 青底，圆钮弹簧滑过去。label 给读屏器（视觉标签由外面的行负责）。
  import { haptic } from "../../lib/touch.ts";

  let { checked, onchange, label, disabled = false }: { checked: boolean; onchange: (v: boolean) => void; label: string; disabled?: boolean } = $props();
</script>

<button
  class="sw"
  class:on={checked}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => {
    haptic("light");
    onchange(!checked);
  }}
>
  <span class="knob"></span>
</button>

<style>
  .sw {
    position: relative;
    flex: none;
    width: 38px;
    height: 22px;
    border-radius: 11px;
    background: var(--surface3);
    transition: background-color var(--t-med) var(--ease);
  }
  .sw.on {
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--text) 22%, transparent);
    transition: transform var(--t-spring-pop, 500ms) var(--spring-pop, var(--ease-out));
  }
  .on .knob {
    transform: translateX(16px);
  }
  .sw:disabled {
    opacity: 0.4;
  }
</style>
