<script>
  // iOS 27 分段控件（kit「Segmented Control」）：底 Fills/Tertiary 胶囊、内距 2、段间距 4；
  // 选中段白色胶囊（暗色 白 27%）+ 投影 0/2/20 黑 6%（CSS 模糊 2σ=16.9）；字 13.33 Semibold（选中）/ Medium。
  // Large 高 50（段 46）、Small 高 32（段 28）。选中胶囊在段间滑动（与系统一致）。
  let { options = [], value, onchange, size = 'large', disabled = false, label = '' } = $props();
  const idx = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
  const n = $derived(Math.max(1, options.length));
</script>

<div class="seg {size}" class:dis={disabled} role="radiogroup" aria-label={label} style:--n={n}>
  <span class="pill" style:transform="translateX(calc({idx} * (100% + 4px)))"></span>
  {#each options as o (o.value)}
    <button type="button" class="opt" class:on={o.value === value} role="radio" aria-checked={o.value === value}
      {disabled} onclick={() => { if (o.value !== value) onchange?.(o.value); }}>{o.label}</button>
  {/each}
</div>

<style>
  .seg {
    position: relative; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 4px; padding: 2px;
    border-radius: 999px; background: var(--i-fill3); -webkit-tap-highlight-color: transparent;
  }
  .seg.large { height: 50px; }
  .seg.small { height: 32px; }
  .seg.dis { opacity: .45; pointer-events: none; }
  .pill {
    position: absolute; left: 2px; top: 2px; bottom: 2px; width: calc((100% - 4px - (var(--n) - 1) * 4px) / var(--n));
    border-radius: 999px; background: var(--i-seg-sel); box-shadow: 0 2px 16.9px rgba(0, 0, 0, .06);
    transition: transform 380ms cubic-bezier(.3, 1.15, .45, 1);
  }
  .opt {
    position: relative; z-index: 1; min-width: 0; border: 0; background: none; padding: 3px 6px; cursor: pointer;
    font: inherit; font-size: 13.33px; line-height: 18px; font-weight: 500; letter-spacing: -.08px; color: var(--i-label);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 999px;
  }
  .opt.on { font-weight: 600; }
</style>
