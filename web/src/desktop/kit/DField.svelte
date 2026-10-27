<script>
  // 桌面文本输入：面板底 + 发丝描边，聚焦切 accent 环；支持前置标签与占位。
  import '../tokens.css';
  let {
    value = $bindable(''),
    placeholder = '',
    type = 'text',
    disabled = false,
    width = '',
    oninput,
    onchange,
  } = $props();
</script>

<input class="fld" {type} bind:value {placeholder} {disabled} style:width={width || undefined}
       oninput={() => oninput?.(value)} onchange={() => onchange?.(value)} />

<style>
  .fld {
    height: var(--dsk-ctl-h); padding: 0 var(--dsk-s3);
    border: none; border-radius: var(--dsk-r-sm);
    background: var(--dsk-panel); box-shadow: 0 0 0 1px var(--dsk-line);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); color: var(--dsk-ink);
    transition: box-shadow var(--dsk-t-fast) var(--dsk-ease), background var(--dsk-t-fast) var(--dsk-ease);
  }
  .fld::placeholder { color: var(--dsk-ink-3); }
  .fld:hover:not(:disabled):not(:focus) { background: var(--dsk-panel-strong); }
  .fld:focus { outline: none; box-shadow: var(--dsk-focus); background: var(--dsk-panel-strong); }
  .fld:disabled { opacity: .4; }
</style>
