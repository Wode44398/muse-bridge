<script>
  // claude.ai 设置里的输入框（官方实测：32px / 圆角 8 / 半透明底 + 1px 内描边，聚焦转蓝）。
  let { value = $bindable(''), placeholder = '', password = false, onkeydown, width = '', inputmode = undefined, disabled = false } = $props();
</script>

{#if password}
  <input class="sf" type="password" {placeholder} bind:value {onkeydown} {disabled} style:width={width || null}
    autocomplete="off" autocapitalize="off" spellcheck="false" />
{:else}
  <input class="sf" type="text" {placeholder} bind:value {onkeydown} {disabled} {inputmode} style:width={width || null}
    autocomplete="off" autocapitalize="off" spellcheck="false" />
{/if}

<style>
  .sf { height: 32px; min-width: 0; padding: 0 12px; border: 0; border-radius: 8px; outline: none;
    background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line);
    color: var(--text); font: inherit; font-size: 14px; transition: box-shadow .15s ease; }
  .sf::placeholder { color: var(--st-muted); }
  .sf:focus { box-shadow: inset 0 0 0 1px var(--st-accent), 0 0 0 3px color-mix(in srgb, var(--st-accent) 22%, transparent); }
  .sf:disabled { opacity: .6; }
  :global(.stg.compact) .sf { height: 40px; font-size: 16px; border-radius: 10px; }   /* 16px：iOS/部分安卓 WebView 小于 16 会自动放大页面 */
</style>
