<script>
  // 桌面按钮：primary（品牌珊瑚）/ secondary（中性面板）/ ghost（悬停才显形）/ danger。
  // 尺寸 md=28 / sm=24；hover 增亮、按下 98% 缩放，全部走令牌时长。
  import '../tokens.css';
  let {
    variant = 'secondary',      // 'primary' | 'secondary' | 'ghost' | 'danger'
    size = 'md',                // 'md' | 'sm'
    type = 'button',            // 默认 button：置身 <form> 内不再隐式变成 submit（账户表单靠显式 type="submit"）
    disabled = false,
    onclick,
    title = '',
    children,
  } = $props();
</script>

<button class="btn {variant} {size}" {type} {disabled} {onclick} title={title || undefined}>
  {@render children?.()}
</button>

<style>
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: var(--dsk-ctl-h); padding: 0 var(--dsk-s3); border-radius: var(--dsk-r-sm);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui); font-weight: 500; line-height: 1;
    color: var(--dsk-ink); white-space: nowrap; user-select: none;
    transition: background var(--dsk-t-fast) var(--dsk-ease), color var(--dsk-t-fast) var(--dsk-ease),
                transform var(--dsk-t-fast) var(--dsk-ease), box-shadow var(--dsk-t-fast) var(--dsk-ease);
  }
  .btn.sm { height: 24px; padding: 0 var(--dsk-s2); font-size: var(--dsk-fs-sm); border-radius: var(--dsk-r-xs); }
  .btn:active:not(:disabled) { transform: scale(.97); }
  .btn:disabled { opacity: .4; cursor: default; }
  .btn:focus-visible { outline: none; box-shadow: var(--dsk-focus); }

  .primary { background: var(--dsk-accent); color: var(--dsk-accent-ink); }
  .primary:hover:not(:disabled) { background: var(--dsk-accent-hover); }

  .secondary { background: var(--dsk-panel-strong); box-shadow: 0 0 0 1px var(--dsk-line); }
  .secondary:hover:not(:disabled) { background: var(--dsk-active); }

  .ghost { background: transparent; color: var(--dsk-ink-2); }
  .ghost:hover:not(:disabled) { background: var(--dsk-hover); color: var(--dsk-ink); }

  .danger { background: color-mix(in srgb, var(--dsk-crit) 16%, transparent); color: var(--dsk-crit); }
  .danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsk-crit) 26%, transparent); }
</style>
