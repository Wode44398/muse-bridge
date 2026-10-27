<script>
  // 桌面开关（iOS 质感 + 桌面尺寸 38×22）：按下 knob 拉长、松手弹回；
  // role=switch + 空格/回车切换 + 统一焦点环。
  import '../tokens.css';
  let { checked = $bindable(false), disabled = false, onchange } = $props();
  function toggle() {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button class="sw" class:on={checked} {disabled} role="switch" aria-checked={checked} onclick={toggle}>
  <span class="knob"></span>
</button>

<style>
  .sw {
    width: 38px; height: 22px; border-radius: var(--dsk-r-full); position: relative; flex: none;
    background: var(--dsk-ctl); padding: 0;
    transition: background var(--dsk-t-med) var(--dsk-ease);
  }
  .sw.on { background: var(--dsk-accent); }
  .sw:disabled { opacity: .4; cursor: default; }
  .sw:focus-visible { outline: none; box-shadow: var(--dsk-focus); }
  .knob {
    position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: var(--dsk-r-full);
    background: var(--dsk-knob); box-shadow: 0 1px 2.5px rgba(0, 0, 0, .35), 0 0 0 .5px rgba(0, 0, 0, .06);
    transition: transform var(--dsk-t-med) var(--dsk-ease-spring), width var(--dsk-t-fast) var(--dsk-ease);
  }
  .sw.on .knob { transform: translateX(16px); background: var(--dsk-knob-on, var(--dsk-knob)); }
  /* 按住时 knob 拉长（iOS 手感）；开态从右侧拉长，位移同步左移保持贴边 */
  .sw:active:not(:disabled) .knob { width: 22px; }
  .sw.on:active:not(:disabled) .knob { transform: translateX(12px); }
</style>
