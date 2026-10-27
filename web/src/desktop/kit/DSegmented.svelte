<script>
  // 桌面分段控件：等宽格 + 滑动指示块（translateX 过渡），方向键左右切换。
  import '../tokens.css';
  let { options = [], value = $bindable(), disabled = false, onchange } = $props();
  const idx = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
  function pick(o) {
    if (disabled || o.value === value) return;
    value = o.value;
    onchange?.(o.value);
  }
  function onkey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = options[(idx + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
    if (next) pick(next);
  }
</script>

<div class="seg" class:disabled role="radiogroup" style:--n={options.length} style:--i={idx} onkeydown={onkey}>
  <span class="thumb" aria-hidden="true"></span>
  {#each options as o (o.value)}
    <button class="cell" class:sel={o.value === value} role="radio" aria-checked={o.value === value}
            tabindex={o.value === value ? 0 : -1} {disabled} onclick={() => pick(o)}>{o.label}</button>
  {/each}
</div>

<style>
  .seg {
    position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
    height: var(--dsk-ctl-h); padding: 2px; border-radius: var(--dsk-r-sm);
    background: var(--dsk-ctl); user-select: none;
  }
  .seg.disabled { opacity: .4; pointer-events: none; }
  .thumb {
    position: absolute; top: 2px; bottom: 2px; left: 2px;
    width: calc((100% - 4px) / var(--n));
    transform: translateX(calc(var(--i) * 100%));
    border-radius: calc(var(--dsk-r-sm) - 2px);
    background: var(--dsk-bg-raised);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .25), 0 0 0 .5px var(--dsk-line);
    transition: transform var(--dsk-t-med) var(--dsk-ease);
  }
  .cell {
    position: relative; z-index: 1; padding: 0 var(--dsk-s3);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-sm); font-weight: 500; line-height: 1;
    color: var(--dsk-ink-2); border-radius: calc(var(--dsk-r-sm) - 2px);
    transition: color var(--dsk-t-fast) var(--dsk-ease);
    white-space: nowrap;
    /* 英文标签更长：格子被外层压窄时省略号截断，不把网格撑出等宽假设（滑块宽按 1/n 算） */
    min-width: 0; overflow: hidden; text-overflow: ellipsis;
  }
  .cell:hover:not(.sel) { color: var(--dsk-ink); }
  .cell.sel { color: var(--dsk-ink); font-weight: 600; }
  .cell:focus-visible { outline: none; box-shadow: var(--dsk-focus); }
</style>
