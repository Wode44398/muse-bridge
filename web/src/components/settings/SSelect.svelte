<script>
  // 设置里的下拉（claude.ai 设置同款外形：32px 高、8px 圆角、细描边、右侧 ⌄）。选项多于分段控件放得下时用它。
  //   options: [{ value, label, disabled? }]；value 可以是字符串或数字（按原类型回传给 onchange）
  let { options = [], value, onchange, label = '', width = '', disabled = false } = $props();
  const idx = $derived(options.findIndex((o) => o.value === value));
  function pick(e) {
    const o = options[Number(e.currentTarget.value)];
    if (o && o.value !== value) onchange?.(o.value);
  }
</script>

<span class="ss" style:width={width || undefined}>
  <select value={String(idx)} {disabled} aria-label={label || undefined} onchange={pick}>
    {#if idx < 0}<option value="-1" disabled>—</option>{/if}
    {#each options as o, i (o.value)}
      <option value={String(i)} disabled={o.disabled}>{o.label}</option>
    {/each}
  </select>
  <span class="ss-chev" aria-hidden="true"></span>
</span>

<style>
  .ss { position: relative; display: inline-flex; min-width: 120px; max-width: 100%; }
  select { appearance: none; -webkit-appearance: none; width: 100%; height: 32px; padding: 0 30px 0 10px; border-radius: 8px;
    border: 1px solid var(--st-hair); background: var(--st-field, transparent); color: var(--text); font: inherit; font-size: 14px;
    cursor: pointer; text-overflow: ellipsis; }
  select:disabled { opacity: .5; cursor: default; }
  select:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 1px; }
  .ss-chev { position: absolute; right: 10px; top: 50%; width: 7px; height: 7px; margin-top: -6px; pointer-events: none;
    border-right: 1.5px solid var(--st-muted); border-bottom: 1.5px solid var(--st-muted); transform: rotate(45deg); }
  @media (hover: hover) { select:not(:disabled):hover { background: var(--st-hover); } }
</style>
