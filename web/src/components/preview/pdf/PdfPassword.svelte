<script>
  // 加密 PDF 的密码框。触屏：ios27 警告框 + 密码输入（墨色，随文档明暗）；电脑：舞台正中一张文档皮肤的扁平卡。
  // 密码错了框不关、清空重输并提示「密码不正确」；取消交给调用方（落成「需要密码」的错误态，可再点「输入密码」）。
  // 系统返回 = 取消。wrong 是「已判错次数」：每错一次加一，框清空、重新聚焦并抖一下。
  import { getContext, untrack } from 'svelte';
  import Alert from '../../ios27/Alert.svelte';
  import TextField from '../../ios27/TextField.svelte';
  import VIcon from '../kit/VIcon.svelte';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { t } from '../../../lib/i18n.js';

  let { touch = false, wrong = 0, name = '', onsubmit, oncancel } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);

  let pw = $state('');
  let input = $state(null);

  function submit() {
    if (!pw) { focusInput(); return; }
    onsubmit?.(pw);
  }
  // 每次被判错：清空、重新聚焦
  $effect(() => { if (wrong > 0) untrack(() => { pw = ''; focusInput(); }); });
  function focusInput() {
    queueMicrotask(() => {
      const el = input || document.querySelector('.pp-alert input[type="password"]');
      try { el?.focus({ preventScroll: true }); } catch {}
    });
  }
  $effect(() => pushBackLayer(() => oncancel?.()));
  $effect(() => { if (!touch && input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch {} }, 30); });

  function key(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); oncancel?.(); }
  }
</script>

{#if touch}
  <div class="i27ink pp-alert" class:dark>
    <Alert title={t('此文档受密码保护')} message={name ? t('输入密码以打开「{name}」', { name }) : t('输入密码以打开')}
      error={wrong > 0 ? t('密码不正确，请重试') : ''}
      actions={[{ label: t('打开'), role: 'default', onclick: submit }, { label: t('取消'), role: 'cancel', onclick: () => oncancel?.() }]}
      onclose={() => oncancel?.()}>
      {#key wrong}
        <TextField bind:value={pw} type="password" placeholder={t('密码')} autofocus autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" onkeydown={key} />
      {/key}
    </Alert>
  </div>
{:else}
  <div class="pp" role="dialog" aria-modal="true" aria-labelledby="pp-t">
    <div class="pp-card">
      <VIcon name="lock" size={28} class="pp-ic" />
      <p class="pp-t" id="pp-t">{t('此文档受密码保护')}</p>
      <p class="pp-d">{t('输入密码以打开')}</p>
      {#key wrong}
        <input bind:this={input} bind:value={pw} class="pp-in" class:bad={wrong > 0} type="password" placeholder={t('密码')} autocomplete="off" spellcheck="false" onkeydown={key} aria-invalid={wrong > 0} />
      {/key}
      <p class="pp-err" aria-live="assertive">{wrong > 0 ? t('密码不正确，请重试') : ''}</p>
      <div class="pp-acts">
        <button type="button" class="vw-pbtn" onclick={() => oncancel?.()}>{t('取消')}</button>
        <button type="button" class="vw-pbtn pri" disabled={!pw} onclick={submit}>{t('打开')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pp { position: absolute; inset: 0; z-index: 7; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--md-stage); }
  .pp-card { width: 320px; max-width: 100%; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; padding: 26px 24px 20px;
    border-radius: 14px; background: var(--md-panel); color: var(--md-fg); box-shadow: 0 0 0 1px var(--vw-line), 0 10px 30px rgba(0, 0, 0, .16);
    animation: pp-in var(--mo-base) var(--ea-decel) both; }
  @keyframes pp-in { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { .pp-card { animation: none; } }
  .pp-card :global(.pp-ic) { color: var(--md-fg-3); }
  .pp-t { margin: 12px 0 0; font-size: 15px; font-weight: 600; }
  .pp-d { margin: 4px 0 16px; font-size: 13px; color: var(--md-fg-3); }
  .pp-in { width: 100%; box-sizing: border-box; height: 36px; padding: 0 12px; border: 0; border-radius: 8px; outline: none;
    background: rgba(var(--md-ink), .06); color: var(--md-fg); font: inherit; font-size: 14px; caret-color: var(--md-accent);
    box-shadow: 0 0 0 1px rgba(var(--md-ink), .1); }
  .pp-in:focus { background: var(--md-field); box-shadow: 0 0 0 1px rgba(var(--md-ink), .3); }
  .pp-in.bad { box-shadow: 0 0 0 1px var(--md-danger); animation: pp-shake var(--mo-quick) var(--ea-out); }
  @keyframes pp-shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
  @media (prefers-reduced-motion: reduce) { .pp-in.bad { animation: none; } }
  .pp-err { min-height: 18px; margin: 6px 0 0; font-size: 12.5px; line-height: 18px; color: var(--md-danger); align-self: flex-start; }
  .pp-acts { display: flex; gap: 8px; margin-top: 10px; align-self: flex-end; }
  .pp-acts .vw-pbtn:disabled { opacity: .45; cursor: default; }
</style>
