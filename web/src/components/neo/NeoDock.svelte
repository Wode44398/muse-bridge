<script>
  // vmx 四媒体模块共用的输入岛：参数摘要 chips（移动端）+ 素材条 + 「＋ / 输入框 / 发送」一行 + 一行提示。
  // 移动端钉在画布底部（.st-sticky），桌面 studio 落在画布下方那一行；chips 在桌面隐藏（右栏常驻参数）。
  // 输入框是 contenteditable：面板经 bind:field 读写正文（草稿预填 / 生成后清空），hasText 回传给面板判断能否发送。
  import { pastePlainText } from '../../lib/dropPaste.js';
  import { icon } from '../../lib/neoUi.js';
  import { t } from '../../lib/i18n.js';
  let {
    field = $bindable(), hasText = $bindable(false),
    placeholder = '', sendLabel = '', busy = false, disabled = false, hint = '',
    onsend, onplus = null, plusLabel = '',
    // 回车直接发送（触屏一律不发，留给换行）；朗读文本这类长文关掉，改 Ctrl/⌘+Enter 发送
    enterSends = true,
    tall = false,
    chips = null, atts = null,
  } = $props();
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  function onInput() { hasText = !!(field?.textContent || '').trim(); }
  function onKey(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    const send = enterSends ? (!e.shiftKey && !touchUI) : (e.ctrlKey || e.metaKey);
    if (send) { e.preventDefault(); if (!disabled && !busy) onsend?.(); }
  }
</script>

<div class="dock">
  {#if chips}<div class="dock-chips">{@render chips()}</div>{/if}
  <div class="dock-in">
    {#if atts}{@render atts()}{/if}
    <div class="dock-row">
      {#if onplus}
        <button class="dock-plus ic" aria-label={plusLabel || t('添加图片')} onclick={onplus}>{@html icon('plus', 24)}</button>
      {/if}
      <div class="dock-field" class:tall bind:this={field} contenteditable="true" role="textbox" tabindex="0" aria-multiline="true"
        data-ph={placeholder} oninput={onInput} onkeydown={onKey} onpaste={pastePlainText}></div>
      <button class="dock-send ic" class:busy disabled={disabled || busy} aria-label={sendLabel || t('生成')} onclick={() => onsend?.()}>
        {@html icon('send', 24)}
      </button>
    </div>
  </div>
  {#if hint}<div class="dock-hint"><span class="ic">{@html icon('warn', 16)}</span>{hint}</div>{/if}
</div>
