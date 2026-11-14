<script>
  // lib/toast.svelte.js 的渲染层：底部居中一条胶囊，不拦点击（红字报错右侧的「问 Claude」按钮除外）。
  // 层级 340：高于统一查看器（300）和聊天灯箱（320）——预览开着时「已保存」「下载失败」这类全局提示也看得见。
  // 查看器自己的提示走它的出口（components/preview/kit/ViewerToast.svelte，跟查看器皮肤）。
  // 进场纯 CSS 动画；退场先挂 .leaving 播完再卸载（不用 Svelte transition：后台页 RAF 不跑，浮层会卡住卸不掉）。
  import { toast, runToastAction } from '../lib/toast.svelte.js';
  import { t, tr } from '../lib/i18n.js';

  // 退场期间还要显示原文：留一份上次的内容
  let shown = $state({ text: '', kind: 'ok', action: false });
  let leaving = $state(false);
  let leaveT = 0;
  $effect(() => {
    const text = toast.text, kind = toast.kind, action = toast.action;
    clearTimeout(leaveT);
    if (text) { shown = { text, kind, action }; leaving = false; return; }
    leaving = true;
    leaveT = setTimeout(() => { shown = { text: '', kind: 'ok', action: false }; leaving = false; }, 170);
  });
</script>

{#if shown.text}
  <div class="toast" class:err={shown.kind === 'err'} class:leaving role="status" aria-live="polite"><span>{tr(shown.text)}</span>{#if shown.action && !leaving}<button
      type="button" class="ask" onclick={runToastAction}>{t('问 Claude')}</button>{/if}</div>
{/if}

<style>
  .toast {
    position: fixed; left: 50%; bottom: calc(var(--sab, 0px) + 96px); transform: translateX(-50%);
    z-index: 340; pointer-events: none; max-width: min(88vw, 420px);
    padding: 9px 16px; border-radius: 999px; font-size: 13.5px; line-height: 1.35; text-align: center;
    background: var(--surface, #2b2a27); color: var(--text, #f4f2ec);
    box-shadow: 0 6px 24px rgba(0, 0, 0, .28), inset 0 0 0 .5px var(--divider, rgba(255, 255, 255, .08));
    animation: toast-in var(--mo-quick) var(--ea-decel) both;
  }
  .toast.leaving { animation: toast-out 160ms var(--ea-accel) forwards; }
  @keyframes toast-in { from { opacity: 0; translate: 0 12px; } }
  @keyframes toast-out { to { opacity: 0; } }
  .toast.err { color: #f0a494; }
  .ask {
    pointer-events: auto; margin-left: 10px; padding: 2px 10px; border: 0; border-radius: 999px;
    font: inherit; font-size: 12.5px; color: var(--text, #f4f2ec); cursor: pointer;
    background: color-mix(in srgb, var(--text, #f4f2ec) 12%, transparent);
  }
  .ask:hover { background: color-mix(in srgb, var(--text, #f4f2ec) 20%, transparent); }
</style>
