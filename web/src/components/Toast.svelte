<script>
  // lib/toast.svelte.js 的渲染层：底部居中一条胶囊，不拦点击（带「报告」按钮时只有按钮可点）。
  import { fade, fly } from 'svelte/transition';
  import { toast, hideToast } from '../lib/toast.svelte.js';
  import { t, tr } from '../lib/i18n.js';

  function act() { const a = toast.action; hideToast(); a?.fn(); }
</script>

{#if toast.text}
  <div class="toast" class:err={toast.kind === 'err'} class:has-act={!!toast.action} role="status" aria-live="polite"
    in:fly={{ y: 12, duration: 180 }} out:fade={{ duration: 160 }}>
    <span>{tr(toast.text)}</span>
    {#if toast.action}<button class="act" onclick={act}>{t('报告问题')}</button>{/if}
  </div>
{/if}

<style>
  .toast {
    position: fixed; left: 50%; bottom: calc(var(--sab, 0px) + 96px); transform: translateX(-50%);
    z-index: 200; pointer-events: none; max-width: min(88vw, 420px);
    display: flex; align-items: center; gap: 12px;
    padding: 9px 16px; border-radius: 999px; font-size: 13.5px; line-height: 1.35; text-align: center;
    background: var(--surface, #2b2a27); color: var(--text, #f4f2ec);
    box-shadow: 0 6px 24px rgba(0, 0, 0, .28), inset 0 0 0 .5px var(--divider, rgba(255, 255, 255, .08));
  }
  .toast.has-act { padding-right: 6px; text-align: left; }
  .toast.err { color: #f0a494; }
  .act {
    pointer-events: auto; flex: none; height: 28px; padding: 0 12px; border: 0; border-radius: 999px; cursor: pointer;
    background: color-mix(in srgb, var(--text, #f4f2ec) 12%, transparent); color: var(--text, #f4f2ec);
    font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap;
  }
  @media (hover: hover) { .act:hover { background: color-mix(in srgb, var(--text, #f4f2ec) 20%, transparent); } }
</style>
