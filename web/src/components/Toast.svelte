<script>
  // lib/toast.svelte.js 的渲染层：底部居中一条胶囊，不拦点击。
  import { fade, fly } from 'svelte/transition';
  import { toast } from '../lib/toast.svelte.js';
  import { tr } from '../lib/i18n.js';
</script>

{#if toast.text}
  <div class="toast" class:err={toast.kind === 'err'} role="status" aria-live="polite"
    in:fly={{ y: 12, duration: 180 }} out:fade={{ duration: 160 }}>{tr(toast.text)}</div>
{/if}

<style>
  .toast {
    position: fixed; left: 50%; bottom: calc(var(--sab, 0px) + 96px); transform: translateX(-50%);
    z-index: 200; pointer-events: none; max-width: min(88vw, 420px);
    padding: 9px 16px; border-radius: 999px; font-size: 13.5px; line-height: 1.35; text-align: center;
    background: var(--surface, #2b2a27); color: var(--text, #f4f2ec);
    box-shadow: 0 6px 24px rgba(0, 0, 0, .28), inset 0 0 0 .5px var(--divider, rgba(255, 255, 255, .08));
  }
  .toast.err { color: #f0a494; }
</style>
