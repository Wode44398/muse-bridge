<script>
  // 共用文件夹标题下的状态行：「Claude 正在…」+ 走秒。行首挂在 26px 身份栏里：Claude 是官方 9 帧思考星芒（陶土色），
  // Antigravity 是液态标志的「极光行波」。点这一行跑插件给的 Target（一般是打开那个会话）。
  // 出现 / 消失都用高度 0fr ⇄ 1fr 展开收起，文字晚一拍淡入、略微下落；收起时文字先走。
  import { openTarget, useNowTick, sinceSeconds } from '../../lib/pluginUi.svelte.js';
  import { tr } from '../../lib/i18n.js';
  import { AGENT_NAME, fmtElapsed } from '../../lib/agy/decor-view.js';
  import AgyClaudeThink from './AgyClaudeThink.svelte';
  import AgyWorkingMark from './AgyWorkingMark.svelte';

  const { status = null, ctx = {} } = $props();

  // 收起时还要画上一份
  let last = $state(null);
  $effect(() => { if (status) last = status; });
  const s = $derived(status || last);
  $effect(() => {
    if (!status?.since) return;
    return useNowTick();
  });
  const el = $derived(s?.since ? fmtElapsed(sinceSeconds(s.since)) : '');
</script>

<div class="lv" class:on={!!status}>
  <div>
    {#if s}
      <button
        type="button"
        class="lvi"
        disabled={!s.open}
        title={tr(s.text)}
        onclick={() => s.open && openTarget(s.open, ctx)}
      >
        <span class="gut" class:clay={s.agent === 'claude'}>
          {#if s.agent === 'claude'}
            <AgyClaudeThink live size={14} />
          {:else if s.agent === 'agy'}
            <AgyWorkingMark mark="writing" size={15} />
          {/if}
        </span>
        <span class="tx">{#if AGENT_NAME[s.agent]}<b>{AGENT_NAME[s.agent]}</b>{' '}{/if}{tr(s.text)}</span>
        {#if el}<span class="el">{el}</span>{/if}
      </button>
    {/if}
  </div>
</div>

<style>
  .lv {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 300ms var(--ag-ease-std);
  }
  .lv.on { grid-template-rows: 1fr; }
  :global(.sb-group.leaving) .lv { grid-template-rows: 0fr; }
  .lv > div { overflow: hidden; min-height: 0; }
  .lvi {
    display: flex;
    align-items: center;
    width: 100%;
    height: 30px;
    padding-right: 10px;
    border-radius: 9px;
    font-size: 12.5px;
    color: var(--ag-on-dim);
    text-align: left;
    opacity: 0;
    transform: translateY(-3px);
    transition: opacity 120ms cubic-bezier(0.3, 0, 0.8, 0.15), transform 160ms cubic-bezier(0.3, 0, 0.8, 0.15), background var(--ag-dur-micro) var(--ag-ease-std);
  }
  .lv.on .lvi {
    opacity: 1;
    transform: none;
    transition: opacity 180ms var(--ag-ease-std) 70ms, transform 260ms var(--ag-ease-decel) 70ms, background var(--ag-dur-micro) var(--ag-ease-std);
  }
  .lvi:not(:disabled) { cursor: pointer; }
  .lvi:not(:disabled):hover { background: var(--ag-hover); }
  .gut { width: 26px; flex: none; display: grid; place-items: center; align-self: stretch; }
  .gut.clay { color: var(--ag-clay); }
  .tx { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tx b { font-weight: 500; color: var(--ag-on-sub); }
  .el { font-size: 11.5px; color: var(--ag-on-faint); margin-left: 8px; font-variant-numeric: tabular-nums; flex: none; }
  :global(.agy-root.ag-compact) .lvi { height: 36px; font-size: 13.5px; }

  @media (prefers-reduced-motion: reduce) {
    .lv, .lvi, .lv.on .lvi { transition: none; }
  }
</style>
