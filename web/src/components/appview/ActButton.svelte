<script>
  // 积木里的「按一下跑一个动作」按钮（button / buttons 积木、列表行尾按钮共用）。
  //   act 是 Act（动作名或 { name, args?, confirm? }）；confirm = 积木上另给的确认文案（动作自己没带 confirm 时补上）；
  //   extra = 并进 args 的东西（列表行尾按钮给 { id }）。正在跑的那一个转圈；同一应用别的动作在跑时不响应（数据层挡）。
  // 样子：桌面壳 = 桌面 kit 的 DButton；手机 = 设置页那种胶囊（主按钮墨色实心、次按钮浅灰底、危险按钮红字淡红底）。
  import DButton from '../../desktop/kit/DButton.svelte';
  let { label, act, confirm = '', style = 'secondary', extra = undefined, ctx, size = 'md', full = false } = $props();

  const variant = $derived(['primary', 'secondary', 'danger'].includes(style) ? style : 'secondary');
  // 积木上的 confirm 并进 Act（动作自己写了 confirm 的以动作为准）
  // 危险按钮的确认框把「确定」画成红色（danger 只影响确认框外观，不进请求）
  const action = $derived.by(() => {
    const danger = variant === 'danger';
    if (!confirm && !danger) return act;
    const base = typeof act === 'string' ? { name: act } : act && typeof act === 'object' ? act : null;
    if (!base) return act;
    return { ...base, confirm: base.confirm || confirm || '', ...(danger ? { danger: true } : {}) };
  });
  const busy = $derived(ctx.busy(action, extra));
  function press() { ctx.run(action, extra); }
</script>

{#if ctx.variant === 'desktop'}
  <span class="dk" class:full>
    <DButton variant={variant} size={size === 'sm' ? 'sm' : 'md'} onclick={press} title={label}>
      {#if busy}<span class="av-spin" aria-hidden="true"></span>{/if}<span class="lb">{label}</span>
    </DButton>
  </span>
{:else}
  <button type="button" class="ab {variant} {size}" class:full class:busy aria-busy={busy} onclick={press}>
    {#if busy}<span class="av-spin" aria-hidden="true"></span>{/if}<span class="lb">{label}</span>
  </button>
{/if}

<style>
  .ab {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; max-width: 100%;
    height: var(--av-btn-h); padding: 0 20px; border: 0; border-radius: var(--av-btn-r); cursor: pointer;
    font: inherit; font-size: var(--av-btn-fs); line-height: 1; font-weight: 600; letter-spacing: -.1px;
    background: var(--av-fill2); color: var(--av-ink);
    -webkit-user-select: none; user-select: none;
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out), opacity var(--av-t), background var(--av-t);
  }
  .ab.sm { height: 30px; padding: 0 14px; border-radius: 15px; font-size: 14px; }
  .ab.full { width: 100%; }
  .ab.primary { background: var(--av-accent); color: var(--av-on-accent); }
  .ab.danger { background: color-mix(in srgb, var(--av-err) 13%, transparent); color: var(--av-err); }
  .ab:active { transform: scale(.97); opacity: .82; }
  .ab:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .ab.busy { cursor: progress; }
  .lb { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ab .av-spin { width: 13px; height: 13px; }
  .dk { display: inline-flex; min-width: 0; }
  .dk.full { display: flex; }
  .dk.full > :global(.btn) { flex: 1; }
  .dk :global(.av-spin) { width: 11px; height: 11px; border-width: 1.4px; }
</style>
