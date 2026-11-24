<script>
  // 插件文件夹动作的撤销小吃条（agy 的样子：反色底、强调色按钮，M3 snackbar）。数据层（pluginUi/workspace.svelte.js）管
  // 内容与计时，这里只画：头像组刚飞到侧栏的那次（设为共用）带一组小头像，等飞行落定才出来；桌面居中浮在输入框上方，手机左右贴边。
  // 进场 260ms 减速上浮淡入；退场 150ms 加速淡出。
  import { onMount } from 'svelte';
  import { workspaceUi, registerWorkspaceSnackHost, dismissWorkspaceSnack, runWorkspaceSnackUndo } from '../../lib/pluginUi.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import { flightSettled, fxLog } from '../../lib/agy/decor-flight.svelte.js';
  import AgyPeerDuo from './AgyPeerDuo.svelte';

  const { compact = false } = $props();

  onMount(() => registerWorkspaceSnackHost('agy'));

  let shown = $state(null);
  let on = $state(false);
  let withDuo = $state(false);
  let gone = 0;

  $effect(() => {
    const s = workspaceUi.snack;
    if (s && s.agent === 'agy') {
      const seq = s.seq;
      clearTimeout(gone);
      flightSettled().then(() => {
        if (workspaceUi.snack?.seq !== seq) return;
        withDuo = fxLog.flown && Date.now() - fxLog.at < 8000;
        fxLog.flown = false;
        shown = s;
        on = false;
        requestAnimationFrame(() => requestAnimationFrame(() => { on = true; }));
      });
    } else if (shown) {
      on = false;
      gone = setTimeout(() => { shown = null; }, 160);
    }
  });

  function portal(node) {
    const host = document.querySelector('.agy-root') || document.body;
    host.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

{#if shown}
  <div use:portal class="agy-snack" class:on class:compact role="status" aria-live="polite">
    {#if withDuo}<AgyPeerDuo size={18} cut="var(--ag-inv-bg)" />{/if}
    <span class="tx">{tr(shown.text)}</span>
    {#if shown.undo}
      <button type="button" onclick={() => runWorkspaceSnackUndo()}>{shown.undo.label}</button>
    {:else}
      <button type="button" class="x" aria-label={t('关闭')} onclick={() => dismissWorkspaceSnack()}>
        <span class="msr">close</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .agy-snack {
    position: fixed;
    left: 50%;
    bottom: calc(var(--sab, 0px) + 112px);
    z-index: 96;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(560px, calc(100vw - 32px));
    min-height: 48px;
    padding: 6px 8px 6px 14px;
    border-radius: 12px;
    background: var(--ag-inv-bg);
    color: var(--ag-inv-on);
    font-size: 13.5px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
    opacity: 0;
    transform: translateX(-50%) translateY(16px);
    transition: opacity 150ms cubic-bezier(0.3, 0, 0.8, 0.15), transform 150ms cubic-bezier(0.3, 0, 0.8, 0.15);
  }
  .agy-snack.on {
    opacity: 1;
    transform: translateX(-50%);
    transition: opacity 260ms var(--ag-ease-decel), transform 260ms var(--ag-ease-decel);
  }
  .agy-snack.compact {
    left: 16px;
    right: 16px;
    max-width: none;
    bottom: calc(var(--sab, 0px) + 84px);
    transform: translateY(16px);
  }
  .agy-snack.compact.on { transform: none; }
  .tx { flex: 1; min-width: 0; line-height: 1.4; }
  button {
    flex: none;
    color: var(--ag-inv-acc);
    font-weight: 500;
    padding: 8px 10px;
    border-radius: 8px;
  }
  button:hover { background: color-mix(in srgb, var(--ag-inv-acc) 12%, transparent); }
  button.x { color: var(--ag-inv-on); opacity: 0.8; display: inline-flex; padding: 6px; }
  button.x .msr { font-size: 18px; }

  @media (prefers-reduced-motion: reduce) {
    .agy-snack, .agy-snack.on { transition: opacity 1ms; }
  }
</style>
