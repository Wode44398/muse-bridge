<script>
  // 生效范围：三枚勾选片（工作流 / Ultracode、普通子 agent、发起新会话），每枚一行小字说它管的是什么；即点即存。
  // 宽处三枚并排，窄处（手机）竖着排。层次靠底色：勾上的那枚是卡片底、墨字、实心勾选框，没勾的退到页面底色上只剩一圈线。
  import { DUR, EASE, reduced } from '../../../lib/motion.js';
  import { t } from '../../../lib/i18n.js';

  // scope: { workflow, subagent, session }；onchange(key, on)
  let { scope = {}, enabled = true, disabled = false, onchange } = $props();

  const ITEMS = [
    { key: 'workflow', name: t('工作流 / Ultracode'), sub: t('工作流脚本里派出的 agent') },
    { key: 'subagent', name: t('普通子 agent'), sub: t('对话里用 Agent 工具派出的') },
    { key: 'session', name: t('发起新会话'), sub: t('新会话的模型可以按档位选') },
  ];
  const noneOn = $derived(enabled && !ITEMS.some((x) => scope?.[x.key]));

  function toggle(e, it) {
    if (disabled) return;
    onchange?.(it.key, !scope?.[it.key]);
    const cb = e.currentTarget.querySelector('.sc-cb');
    if (cb && !reduced()) cb.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: DUR.quick, easing: EASE.std });
  }
</script>

<div class="sc" role="group" aria-label={t('生效范围')}>
  {#each ITEMS as it (it.key)}
    {@const on = !!scope?.[it.key]}
    <button type="button" class="sc-tile" class:on role="checkbox" aria-checked={on} {disabled} onclick={(e) => toggle(e, it)}>
      <span class="sc-cb" class:on aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.6 6.2 4.9 8.4 9.4 3.6" /></svg></span>
      <span class="sc-tx">
        <span class="sc-name">{it.name}</span>
        <span class="sc-sub">{it.sub}</span>
      </span>
    </button>
  {/each}
</div>
{#if noneOn}
  <p class="sc-note">{t('三个范围都没勾：策略开着，但不会用在任何地方')}</p>
{/if}

<style>
  .sc { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  @container dp (max-width: 559px) { .sc { grid-template-columns: 1fr; gap: 8px; } }

  .sc-tile {
    position: relative; display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding: 11px var(--dp-px) 12px 12px;
    border: 0; border-radius: var(--dp-r); background: transparent; box-shadow: inset 0 0 0 1px var(--dp-line2);
    color: var(--dp-ink2); font: inherit; text-align: left; cursor: pointer;
    transition: background-color var(--mo-quick, 200ms) var(--ea-fade, ease), box-shadow var(--mo-quick, 200ms) var(--ea-fade, ease),
      color var(--mo-quick, 200ms) var(--ea-fade, ease), opacity var(--mo-micro, 140ms) var(--ea-fade, ease), transform var(--mo-tap, 90ms) var(--ea-std, ease);
  }
  .sc-tile.on { background: var(--dp-card); box-shadow: var(--dp-edge); color: var(--dp-ink); }
  .sc-tile:active:not(:disabled) { transform: scale(.985); }
  .sc-tile:disabled { cursor: default; }
  .sc-tile:disabled:not(.on) { opacity: .6; }
  .sc-tile:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dp-ink); }
  @media (hover: hover) { .sc-tile:hover:not(:disabled):not(.on) { background: var(--dp-sunk); color: var(--dp-ink); } }

  /* 勾选框：没勾 = 一圈线；勾上 = 墨底象牙勾，勾线 0.2s 描出 */
  .sc-cb { flex: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 5px; display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1.5px var(--dp-ink3); transition: background-color var(--mo-quick, 200ms) var(--ea-fade, ease), box-shadow var(--mo-quick, 200ms) var(--ea-fade, ease); }
  .sc-cb svg { width: 12px; height: 12px; fill: none; stroke: var(--dp-on); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 10; stroke-dashoffset: 10; transition: stroke-dashoffset var(--mo-quick, 200ms) var(--ea-decel, ease-out); }
  .sc-cb.on { background: var(--dp-accent); box-shadow: none; }
  .sc-cb.on svg { stroke-dashoffset: 0; }

  .sc-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sc-name { font-size: var(--dp-fs); line-height: 1.35; font-weight: 500; overflow-wrap: anywhere; }
  .sc-sub { font-size: var(--dp-fs-s); line-height: 1.4; color: var(--dp-sub); overflow-wrap: anywhere; }
  .sc-note { margin: 0; padding: 8px 12px 0; font-size: var(--dp-fs-s); line-height: 1.5; color: var(--dp-warn); }

  @media (prefers-reduced-motion: reduce) {
    .sc-tile, .sc-cb, .sc-cb svg { transition: none; }
    .sc-tile:active:not(:disabled) { transform: none; }
  }
</style>
