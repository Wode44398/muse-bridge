<script>
  // 插件文件夹动作的结果提示（带撤销）：数据层 workspaceUi.snack 的 agent 是 'claude' 时由这里画。
  // 和 Claude 页的深色说明同一种写法：深底浅字的圆角方块（8 圆角）+ 1px 细描边，「撤销」是方块里的一颗 6 圆角键；不发光。
  // 进场 200ms 上浮 8px 淡入（ease-out），退场 120ms 淡出。位置：本页输入栏（连同上方的芯片、横条）正上方、与它居中对齐；
  // 找不到输入栏时退回全局提示的位置（底部居中）。
  import { workspaceUi, registerWorkspaceSnackHost, dismissWorkspaceSnack, runWorkspaceSnackUndo } from '../../../lib/pluginUi.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';

  $effect(() => registerWorkspaceSnackHost('claude'));

  const live = $derived(workspaceUi.snack?.agent === 'claude' ? workspaceUi.snack : null);
  // 退场时还要显示原文：留一份上次的内容
  let shown = $state(null);
  let leaving = $state(false);
  let leaveT = 0;
  $effect(() => {
    const s = live;
    clearTimeout(leaveT);
    if (s) { shown = s; leaving = false; return; }
    if (!shown) return;
    leaving = true;
    leaveT = setTimeout(() => { shown = null; leaving = false; }, 120);
  });
  $effect(() => () => clearTimeout(leaveT));

  // 出现那一刻量一次输入栏：全局提示的固定位置（离底 96px）会正好压在芯片和输入框上
  function above(node) {
    const host = node.closest('.cc-tone');
    const bar = host?.querySelector('.composer-wrap, .hero-foot');
    const r = bar?.getBoundingClientRect();
    if (r && r.width) {
      node.style.bottom = Math.max(12, innerHeight - r.top + 8) + 'px';
      node.style.left = r.left + r.width / 2 + 'px';
    }
  }
</script>

{#if shown}
  {#key shown.seq}
    <div class="wsn" class:out={leaving} role="status" aria-live="polite" use:above>
      <span class="wsn-t">{tr(shown.text)}</span>
      {#if shown.undo && !leaving}<button type="button" class="wsn-b" onclick={runWorkspaceSnackUndo}>{tr(shown.undo.label) || t('撤销')}</button>{/if}
      <button type="button" class="wsn-x" aria-label={t('关闭')} onclick={dismissWorkspaceSnack}>
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>
      </button>
    </div>
  {/key}
{/if}

<style>
  .wsn { position: fixed; left: 50%; bottom: calc(var(--sab, 0px) + 96px); z-index: 340; translate: -50% 0;
    width: max-content; max-width: min(92vw, 440px); display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 12px; min-height: 36px;
    border-radius: 8px; background: var(--cc-tip, #2b2b2b); color: #f2f2f2; font-size: 13px; line-height: 18px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08), 0 6px 20px rgba(0, 0, 0, .22);
    animation: wsnIn 200ms cubic-bezier(.165, .84, .44, 1) both; }
  .wsn.out { animation: wsnOut 120ms cubic-bezier(.165, .84, .44, 1) forwards; pointer-events: none; }
  @keyframes wsnIn { from { opacity: 0; transform: translateY(8px); } }
  @keyframes wsnOut { to { opacity: 0; } }
  .wsn-t { min-width: 0; padding: 5px 6px 5px 0; overflow-wrap: anywhere; }
  .wsn-b { flex: none; height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: rgba(255, 255, 255, .1); color: #fff;
    font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: background-color 60ms cubic-bezier(.165, .84, .44, 1); }
  .wsn-x { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; background: none; color: #a8a8a8; cursor: pointer;
    transition: background-color 60ms cubic-bezier(.165, .84, .44, 1), color 60ms cubic-bezier(.165, .84, .44, 1); }
  .wsn-x svg { width: 12px; height: 12px; }
  .wsn-b:active { background: rgba(255, 255, 255, .16); }
  @media (hover: hover) {
    .wsn-b:hover { background: rgba(255, 255, 255, .16); }
    .wsn-x:hover { background: rgba(255, 255, 255, .08); color: #fff; }
  }
  @media (prefers-reduced-motion: reduce) { .wsn, .wsn.out { animation: none; } }
</style>
