<script>
  // 共用文件夹底板最下面一行（插件的 footer：一般是共用记忆「多少篇 · 最近谁写的」）。图标挂在 26px 身份栏里。
  // 文字变了（比如 agy 刚写回记忆）就亮一下再慢慢褪回去；进场 / 退场时由外层 .entering / .leaving 收起。
  import { openTarget } from '../../lib/pluginUi.svelte.js';
  import { pluginIcon } from '../../lib/pluginIcons.js';
  import { tr } from '../../lib/i18n.js';

  const { footer, ctx = {} } = $props();

  let bump = $state(false);
  let prev = '';
  $effect(() => {
    const txt = footer?.text || '';
    if (prev && txt && txt !== prev) {
      bump = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { bump = false; }));
    }
    prev = txt;
  });
</script>

<div class="mf">
  <div>
    <button
      type="button"
      class="mfi"
      class:bump
      disabled={!footer.open}
      title={tr(footer.text)}
      onclick={() => footer.open && openTarget(footer.open, ctx)}
    >
      <span class="gut">{@html pluginIcon(footer.icon || 'book', 1.6)}</span>
      <span class="tx">{tr(footer.text)}</span>
    </button>
  </div>
</div>

<style>
  .mf {
    display: grid;
    grid-template-rows: 1fr;
    transition: grid-template-rows 300ms var(--ag-ease-std);
  }
  :global(.sb-group.entering) .mf,
  :global(.sb-group.leaving) .mf { grid-template-rows: 0fr; }
  .mf > div { overflow: hidden; min-height: 0; }
  .mfi {
    display: flex;
    align-items: center;
    width: 100%;
    height: 28px;
    padding-right: 10px;
    margin-top: 2px;
    border-radius: 9px;
    font-size: 11.5px;
    color: var(--ag-on-faint);
    text-align: left;
    transition: opacity 200ms var(--ag-ease-std), color 600ms var(--ag-ease-std), background var(--ag-dur-micro) var(--ag-ease-std);
  }
  :global(.sb-group.entering) .mfi,
  :global(.sb-group.leaving) .mfi { opacity: 0; }
  .mfi.bump { color: var(--ag-on); transition: none; }
  .mfi:not(:disabled) { cursor: pointer; }
  .mfi:not(:disabled):hover { background: var(--ag-hover); color: var(--ag-on-dim); }
  .gut { width: 26px; flex: none; display: grid; place-items: center; align-self: stretch; }
  .gut :global(svg) { width: 14px; height: 14px; }
  .tx { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(.agy-root.ag-compact) .mfi { height: 34px; font-size: 12.5px; }

  @media (prefers-reduced-motion: reduce) {
    .mf, .mfi { transition: none; }
  }
</style>
