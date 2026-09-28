<script>
  // claude.ai 设置里的按钮（官方实测：次级 28px / 圆角 7 / 1px 描边；主按钮 32px / 圆角 8 / 深底白字 500 字重）。
  //   variant: secondary | primary | danger | ghost      size: sm(28) | md(32) | lg(40)
  let { variant = 'secondary', size = 'sm', disabled = false, onclick, type = 'button', title = '', children } = $props();
</script>

<button {type} class="sb {variant} {size}" {disabled} {onclick} title={title || undefined}>{@render children?.()}</button>

<style>
  .sb { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; cursor: pointer;
    font: inherit; font-size: 14px; line-height: 1; white-space: nowrap;
    transition: background-color .15s ease, opacity .15s ease, color .15s ease, transform var(--mo-tap) var(--ea-out); }
  .sb:active:not(:disabled) { transform: scale(.98); }
  .sb:disabled { opacity: .45; cursor: default; }
  .sb:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 2px; }
  .sm { height: 28px; padding: 0 10px; border-radius: 7px; }
  .md { height: 32px; padding: 0 12px; border-radius: 8px; }
  .lg { height: 40px; padding: 0 16px; border-radius: 10px; font-size: 15px; }
  .secondary { background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); }
  .primary { background: var(--st-primary); color: var(--st-primary-ink); font-weight: 500; }
  .danger { background: transparent; color: var(--crit); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--crit) 45%, transparent); }
  .ghost { background: transparent; color: var(--st-text2); }
  @media (hover: hover) {
    .secondary:hover:not(:disabled) { background: var(--st-hover); }
    .primary:hover:not(:disabled) { opacity: .88; }
    .danger:hover:not(:disabled) { background: color-mix(in srgb, var(--crit) 10%, transparent); }
    .ghost:hover:not(:disabled) { background: var(--st-hover); color: var(--text); }
  }
</style>
