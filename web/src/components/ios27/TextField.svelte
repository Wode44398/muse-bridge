<script>
  // iOS 27 文本框组（kit 警告框里的「Text Field」）：组圆角 26（Figma 平滑 60%，9 宫遮罩）、行高 52、左右 16；
  // 字 17/20 Medium；底：亮 Fills/Secondary LINEAR_BURN、暗 Fills/Tertiary LINEAR_DODGE（在玻璃底上折成等效半透色）。
  // multiline 时是文本区（反馈用）。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import sq26_pub from '../../assets/ios27/squircle26.svg';
  const sq26 = $derived(ovUrl('ios27/squircle26.svg', sq26_pub));
  let { value = $bindable(''), placeholder = '', multiline = false, rows = 5, inputmode = undefined, autofocus = false, oninput, ...rest } = $props();
  let el = $state();
  $effect(() => { if (autofocus && el) setTimeout(() => { try { el.focus(); } catch {} }, 280); });
</script>

<div class="tf" style:--sq={`url("${sq26}")`}>
  {#if multiline}
    <textarea bind:this={el} bind:value {placeholder} {rows} {oninput} {...rest}></textarea>
  {:else}
    <input bind:this={el} bind:value {placeholder} {inputmode} {oninput} {...rest} />
  {/if}
</div>

<style>
  .tf { background: var(--i-field); border-radius: 26px; -webkit-mask-box-image: var(--sq) 42 / 42px; }
  input, textarea {
    display: block; width: 100%; border: 0; outline: none; background: none; margin: 0; padding: 0 16px;
    font: inherit; font-size: 17px; line-height: 20px; font-weight: 500; letter-spacing: -.43px; color: var(--i-label);
    caret-color: var(--i-accent, var(--i-blue));
  }
  input { height: 52px; }
  textarea { padding: 16px; resize: none; min-height: 132px; max-height: 36vh; line-height: 22px; font-weight: 400; }
  input::placeholder, textarea::placeholder { color: var(--i-label3); opacity: 1; }
</style>
