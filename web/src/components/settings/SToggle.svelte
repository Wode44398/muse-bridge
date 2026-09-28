<script>
  // claude.ai 同款开关：36×20 胶囊、开 = #2a78d6、16px 白钮，回弹 .12s cubic-bezier(.34,1.3,.64,1)（官方实测）。
  let { checked = false, onchange, disabled = false, label = '' } = $props();
</script>

<button type="button" role="switch" aria-checked={checked} aria-label={label || undefined} class="tg" class:on={checked}
  {disabled} onclick={() => onchange?.(!checked)}><span class="knob"></span></button>

<style>
  .tg { position: relative; flex: none; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; cursor: pointer;
    background: color-mix(in srgb, var(--text) 22%, transparent); transition: background-color .15s ease; }
  .tg.on { background: var(--st-accent); }
  .tg:disabled { opacity: .45; cursor: default; }
  .tg:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 2px; }
  .knob { display: block; width: 16px; height: 16px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 2px rgba(11, 11, 11, .06), 0 2px 8px rgba(11, 11, 11, .08);
    transition: transform .12s cubic-bezier(.34, 1.3, .64, 1); }
  .tg.on .knob { transform: translateX(16px); }
</style>
