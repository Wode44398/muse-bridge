<script>
  // 口述备注：一段自由文本（≤ 2000 字，右下角计数），原样进系统提示、优先级最高。
  // 文本框跟着内容长高（四行起），不出内滚动条：内核支持 field-sizing 就交给它，否则按 scrollHeight 量。
  import { t } from '../../../lib/i18n.js';
  import { NOTE_MAX } from './dpUtil.js';

  let { value = '', disabled = false, oninput } = $props();

  const native = (() => { try { return typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content'); } catch { return false; } })();
  let el = $state();
  function grow() {
    if (native || !el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
  $effect(() => { value; grow(); });
  // 容器变宽变窄会改折行：宽度变了再量一次
  $effect(() => {
    if (native || !el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el && el.clientWidth !== w) { w = el.clientWidth; grow(); } });
    ro.observe(el);
    return () => ro.disconnect();
  });
  const used = $derived(value.length);
</script>

<div class="dp-card nc">
  <textarea class="nc-in" class:native bind:this={el} rows="4" maxlength={NOTE_MAX} {value} readonly={disabled} spellcheck="false"
    aria-label={t('口述备注')} placeholder={disabled ? '' : t('例如：验证和最终裁决一律用最强的；读文件、检索这类机械活用最便宜的。')}
    oninput={(e) => oninput?.(e.currentTarget.value)}></textarea>
  <span class="nc-count" class:near={NOTE_MAX - used <= 100} aria-hidden="true">{used} / {NOTE_MAX}</span>
</div>

<style>
  .nc { display: flex; flex-direction: column; }
  .nc-in {
    display: block; width: 100%; box-sizing: border-box; min-height: calc(4 * 1.55em + 24px); margin: 0; padding: 12px var(--dp-px) 4px;
    border: 0; outline: 0; border-radius: inherit; background: transparent; resize: none; overflow: hidden;
    color: var(--dp-ink); caret-color: var(--dp-accent); font: inherit; font-size: var(--dp-fs); line-height: 1.55;
  }
  .nc-in.native { field-sizing: content; }
  .nc-in::placeholder { color: var(--dp-ink3); opacity: 1; }
  .nc-in:read-only { color: var(--dp-ink2); }
  .nc-count { align-self: flex-end; padding: 0 var(--dp-px) 9px; font-size: var(--dp-fs-s); line-height: 1.4; color: var(--dp-ink3); font-variant-numeric: tabular-nums;
    transition: color var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .nc-count.near { color: var(--dp-warn); }
  /* 聚焦：卡的那圈线加重（卡的描边画在 ::after 上，这里只换它的颜色） */
  .nc.dp-card:focus-within::after { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--dp-ink) 45%, transparent); }
</style>
