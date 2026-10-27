<script>
  // 桌面滑杆：原生 input[type=range]（键盘/拖动/步进白拿）+ 令牌化外观。
  // 已走轨道用 accent 渐变填充（--pct 由值实时驱动）。
  import '../tokens.css';
  let { value = $bindable(0), min = 0, max = 100, step = 1, disabled = false, oninput } = $props();
  const pct = $derived(((Number(value) - min) / (max - min || 1)) * 100 + '%');
</script>

<input class="sl" type="range" bind:value {min} {max} {step} {disabled}
       style:--pct={pct} oninput={() => oninput?.(Number(value))} />

<style>
  .sl {
    -webkit-appearance: none; appearance: none; width: 100%; height: 20px;
    background: transparent; margin: 0; cursor: pointer;
  }
  .sl:disabled { opacity: .4; cursor: default; }
  .sl::-webkit-slider-runnable-track {
    height: 4px; border-radius: var(--dsk-r-full);
    background: linear-gradient(to right, var(--dsk-accent) var(--pct), var(--dsk-ctl) var(--pct));
  }
  .sl::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; margin-top: -6px; border-radius: var(--dsk-r-full);
    background: var(--dsk-knob);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .35), 0 0 0 .5px rgba(0, 0, 0, .08);
    transition: transform var(--dsk-t-fast) var(--dsk-ease);
  }
  .sl:hover:not(:disabled)::-webkit-slider-thumb { transform: scale(1.12); }
  .sl:active:not(:disabled)::-webkit-slider-thumb { transform: scale(1.2); }
  .sl:focus-visible { outline: none; }
  .sl:focus-visible::-webkit-slider-thumb { box-shadow: var(--dsk-focus), 0 1px 3px rgba(0, 0, 0, .35); }
</style>
