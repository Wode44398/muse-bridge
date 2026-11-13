<script>
  // Studio 的输入框（v3，方案 §9.2「输入框 = dimensio Composer」）：白纸（surface）、圆角 22、一圈细线 + 上沿高光 + 浮起投影；
  // 内部 素材条 → 正文 → 底行（tools：＋ · 模型芯片 · 基本参数的值芯片 · 「参数」，由页面给）+ 墨色圆形发送钮。
  // 输入框是 contenteditable：页面经 bind:field 读写正文（草稿预填 / 生成后清空），hasText 回传给页面判断能否发送。
  import { pastePlainText } from '../../../lib/dropPaste.js';
  import { t } from '../../../lib/i18n.js';
  import { icon } from '../../../modules/studio/icons.js';

  let {
    field = $bindable(), hasText = $bindable(false),
    placeholder = '', sendLabel = '', busy = false, disabled = false,
    onsend,
    // 回车直接发送（触屏一律不发，留给换行）；朗读文本这类长文关掉，改 Ctrl/⌘+Enter 发送
    enterSends = true,
    tall = false,
    atts = null, tools = null,
    ontext = null,   // (正文) → 每次输入后回调（宿主据此做语言等内容检查）
  } = $props();
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  function onInput() { const s = field?.textContent || ''; hasText = !!s.trim(); ontext?.(s); }
  function onKey(e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    const send = enterSends ? (!e.shiftKey && !touchUI) : (e.ctrlKey || e.metaKey);
    if (send) { e.preventDefault(); if (!disabled && !busy) onsend?.(); }
  }
  // 整卡点哪儿都能聚焦正文（同 dimensio 的 cursor:text），点到按钮上除外
  function focusField(e) { if (!e.target.closest('button, a, [contenteditable], .cp-atts, input')) field?.focus(); }
</script>

<div class="cp" role="presentation" onclick={focusField}>
  {#if atts}{@render atts()}{/if}
  <div class="cp-field" class:tall bind:this={field} contenteditable="true" role="textbox" tabindex="0" aria-multiline="true" aria-label={placeholder}
    data-ph={placeholder} oninput={onInput} onkeydown={onKey} onpaste={pastePlainText}></div>
  <div class="cp-bar">
    <div class="cp-tools">{#if tools}{@render tools()}{/if}</div>
    <button class="cp-send" class:busy disabled={disabled || busy} aria-label={sendLabel || t('生成')} title={sendLabel || t('生成')} onclick={() => onsend?.()}>
      {#if busy}<span class="cp-wait" aria-hidden="true"></span>{:else}{@html icon('up')}{/if}
    </button>
  </div>
</div>
