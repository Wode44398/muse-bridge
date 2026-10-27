<script>
  // 桌面下拉选择：触发钮 + fixed 弹出列表（自动上翻），完整键盘路径
  // （Enter/Space 开、↑↓ 走高亮、Enter 选、Esc 关），点外关闭。
  // 注意：弹层是 position:fixed——放进带 transform 的祖先会被劫持定位，
  // 页面过渡场景（如设置 sheet 动画中）请等落定再开。
  import '../tokens.css';
  let { options = [], value = $bindable(), disabled = false, onchange, width = '' } = $props();

  let open = $state(false);
  let hi = $state(0);                 // 弹层内高亮下标
  let btnEl = $state(null);
  let popEl = $state(null);
  let popStyle = $state('');
  const current = $derived(options.find((o) => o.value === value) || options[0] || { label: '—' });

  function openPop() {
    if (disabled || !options.length) return;
    hi = Math.max(0, options.findIndex((o) => o.value === value));
    const r = btnEl.getBoundingClientRect();
    const h = Math.min(options.length, 9) * 30 + 8;          // 估算高度：行30 + padding
    const below = window.innerHeight - r.bottom - 8;
    const top = below >= h || below >= r.top ? r.bottom + 4 : r.top - h - 4;
    popStyle = `left:${Math.round(r.left)}px;top:${Math.round(top)}px;min-width:${Math.round(r.width)}px`;
    open = true;
  }
  function pick(o) {
    open = false;
    if (o.value === value) return;
    value = o.value;
    onchange?.(o.value);
  }
  function onkey(e) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openPop(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); open = false; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hi = (hi + 1) % options.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = (hi + options.length - 1) % options.length; }
    else if (e.key === 'Enter') { e.preventDefault(); pick(options[hi]); }
  }
  // 点在弹层里不算「点外」：否则 pointerdown 就把弹层卸掉，后续 click 落空、选项永远选不中
  function onDocDown(e) {
    if (!open) return;
    const path = e.composedPath();
    if (!path.includes(btnEl) && !path.includes(popEl)) open = false;
  }
</script>

<svelte:window onpointerdowncapture={onDocDown} onresize={() => { open = false; }} />

<button class="trg" bind:this={btnEl} {disabled} style:width={width || undefined}
        aria-haspopup="listbox" aria-expanded={open}
        onclick={() => (open ? (open = false) : openPop())} onkeydown={onkey}>
  <span class="lbl">{current.label}</span>
  <svg class="chev" class:up={open} viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</button>

{#if open}
  <div class="pop" bind:this={popEl} style={popStyle} role="listbox">
    {#each options as o, i (o.value)}
      <button class="opt" class:hi={i === hi} role="option" aria-selected={o.value === value}
              onpointerenter={() => (hi = i)} onclick={() => pick(o)}>
        <span class="tick" class:on={o.value === value} aria-hidden="true">
          <svg viewBox="0 0 12 10" width="12" height="10"><path d="M1 5.2 4.4 8.6 11 1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <span class="olbl">{o.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .trg {
    display: inline-flex; align-items: center; gap: var(--dsk-s2);
    height: var(--dsk-ctl-h); padding: 0 var(--dsk-s2) 0 var(--dsk-s3);
    border-radius: var(--dsk-r-sm); background: var(--dsk-panel-strong);
    box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); color: var(--dsk-ink);
    transition: background var(--dsk-t-fast) var(--dsk-ease);
    user-select: none;
  }
  .trg:hover:not(:disabled) { background: var(--dsk-active); }
  .trg:disabled { opacity: .4; cursor: default; }
  .trg:focus-visible { outline: none; box-shadow: var(--dsk-focus); }
  .lbl { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chev { color: var(--dsk-ink-3); transition: transform var(--dsk-t-med) var(--dsk-ease); flex: none; }
  .chev.up { transform: rotate(180deg); }

  .pop {
    position: fixed; z-index: 3000; padding: 4px;
    max-height: 278px; overflow: auto;
    border-radius: var(--dsk-r-md); background: var(--dsk-bg-raised);
    box-shadow: var(--dsk-sh-2);
    animation: pop-in var(--dsk-t-fast) var(--dsk-ease-out);
  }
  @keyframes pop-in { from { opacity: 0; transform: translateY(-3px) scale(.985); } }
  .opt {
    display: flex; align-items: center; gap: var(--dsk-s2); width: 100%;
    height: 30px; padding: 0 var(--dsk-s3) 0 var(--dsk-s2); border-radius: var(--dsk-r-xs);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); color: var(--dsk-ink);
    text-align: left; white-space: nowrap;
  }
  .opt.hi { background: var(--dsk-hover); }
  .opt:active { background: var(--dsk-active); }
  .tick { width: 12px; color: var(--dsk-accent); opacity: 0; flex: none; display: inline-flex; }
  .tick.on { opacity: 1; }
</style>
