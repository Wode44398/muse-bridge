<script>
  // 吸底操作条：勾了模型才升起。左「已选 n · 清除」，右「添加到」+ 去向勾选片紧挨着「保存」（勾去向 → 保存是连着的两步）。
  // 去向片的初始状态、保存的语义都在 HubService 里算好传进来；这里只管排版与手感。
  // note：一行状态（连接改了要先识别、哪个去向会被跳过、片为什么点不亮）——去向片的 title 触屏上看不到，原因要写出来。
  import AgentStack from './AgentStack.svelte';
  import { CHECK } from './HsKit.js';
  import { DUR, EASE, reduced } from '../../lib/motion.js';
  import { t } from '../../lib/i18n.js';

  // dests: [{ id, name, on, disabled, title }]
  let {
    up = false, n = 0, dests = [], canSave = false, saving = false, err = '', note = '',
    ontoggle, onclear, onsave, narrow = false, barh = $bindable(0),
  } = $props();

  function toggle(e, d) {
    ontoggle?.(d.id);
    const cb = e.currentTarget.querySelector('.hs-cb');
    if (cb && !reduced()) cb.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: DUR.quick, easing: EASE.std });
  }
</script>

<div class="bar" class:up class:narrow inert={!up} aria-hidden={up ? undefined : 'true'} bind:offsetHeight={barh}>
  {#if err}
    <p class="msg err" role="alert">{err}</p>
  {:else if note}
    <p class="msg">{note}</p>
  {/if}
  <div class="main">
    <div class="sel">
      <span class="n">{t('已选 {n}', { n })}</span>
      <button type="button" class="tbtn" onclick={() => onclear?.()}>{t('清除')}</button>
    </div>
    <div class="to" role="group" aria-label={t('添加到')}>
      <span class="lab" aria-hidden="true">{t('添加到')}</span>
      {#each dests as d (d.id)}
        <button type="button" class="dest" class:on={d.on} role="checkbox" aria-checked={d.on} disabled={d.disabled} title={d.title || undefined}
          onclick={(e) => toggle(e, d)}>
          <span class="hs-cb" class:on={d.on} aria-hidden="true">{@html CHECK}</span>
          <AgentStack agents={[d.id]} size={16} quiet />
          <span class="dn">{d.name}</span>
        </button>
      {/each}
    </div>
    <button type="button" class="save" class:busy={saving} disabled={!canSave || saving} onclick={() => onsave?.()}>
      {#if saving}<span class="spin" aria-hidden="true"></span>{t('保存中…')}{:else}{t('保存')}{/if}
    </button>
  </div>
</div>

<style>
  /* 收着时整条压在面板底边以下（translateY(100%)）并 inert；升起 decel、收下 accel */
  .bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; background: var(--st-surface);
    box-shadow: 0 -1px 0 var(--st-hair), 0 -10px 28px rgba(0, 0, 0, .07);
    transform: translateY(100%); visibility: hidden;
    transition: transform var(--mo-base) var(--ea-accel), visibility 0s linear var(--mo-base); }
  .bar.up { transform: none; visibility: visible; transition: transform var(--mo-base) var(--ea-decel), visibility 0s; }
  .bar.narrow { background: var(--pm-bg); padding-bottom: var(--sab, 0px); box-shadow: 0 -1px 0 var(--st-hair), 0 -10px 28px rgba(0, 0, 0, .06); }

  /* 宽屏靠右：这一行说的是右边的去向片和保存（跳过哪些、为什么存不了），跟着它们放 */
  .msg { margin: 0; padding: 10px 16px 0 20px; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); overflow-wrap: anywhere; text-align: right; text-wrap: pretty; }
  .msg.err { color: var(--pm-red); }
  .narrow .msg { padding: 10px 16px 0; font-size: 13px; text-align: left; }

  /* 字号只有两级：13（已选、清除、添加到、去向片）与 13.5（保存）；去向片与保存同高同圆角（38 / 10） */
  .main { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 0 16px 0 20px; }
  .sel { flex: none; display: flex; align-items: center; gap: 4px; }
  .n { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* 去向片靠右、贴着保存：左边只剩「已选 n · 清除」 */
  .to { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .lab { flex: none; margin-right: 2px; font-size: 13px; color: var(--st-muted); white-space: nowrap; }

  .dest { flex: none; display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 11px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    box-shadow: inset 0 0 0 1px var(--st-line);
    transition: box-shadow var(--mo-micro) var(--ea-fade), background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .dest:hover:not(:disabled):not(.on) { background: var(--st-hover); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 22%, transparent); } }
  .dest:active:not(:disabled) { transform: scale(.96); }
  .dest.on { background: var(--st-sel); box-shadow: inset 0 0 0 1.5px var(--text); }
  .dest:disabled { opacity: .4; cursor: default; }
  .dest:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .dn { white-space: nowrap; }

  .tbtn { flex: none; display: inline-flex; align-items: center; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent;
    color: var(--st-text2); font: inherit; font-size: 13px; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .tbtn:hover { background: var(--st-hover); color: var(--text); } }
  .tbtn:active { transform: scale(.96); }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }

  .save { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 38px; min-width: 96px; padding: 0 20px; border: 0; border-radius: 10px;
    background: var(--st-primary); color: var(--st-primary-ink); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade),
      transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .save:hover:not(:disabled) { opacity: .88; } }
  .save:active:not(:disabled) { transform: scale(.96); }
  /* 点不了：中性底 + 次要字（把墨色调淡在暗色里是一块发浑的褐色，手机上反而成了全屏最重的一块）；勾上去向那一下由灰转墨 */
  .save:disabled { background: var(--st-seg); color: var(--st-muted); cursor: default; }
  /* 保存中不算禁用：转圈时还是墨色，只略淡 */
  .save.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); opacity: .72; }
  .save:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px var(--text); }

  /* 窄屏：两行——上面「添加到」+ 去向片平分余下的宽度（44 高），下面「已选 n · 清除」+ 整宽的保存；底部吃掉安全区 */
  .narrow .main { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "to to" "sel save"; gap: 10px 12px; padding: 10px 16px 10px; }
  .narrow .to { grid-area: to; justify-content: stretch; }
  .narrow .lab { margin-right: 4px; }
  .narrow .dest { flex: 1 1 0; min-width: 0; justify-content: center; gap: 7px; height: 44px; padding: 0 10px; border-radius: 13px; background: var(--st-surface); box-shadow: none; font-size: 14.5px; }
  .narrow .dest.on { background: var(--st-sel); box-shadow: inset 0 0 0 1.5px var(--text); }
  .narrow .dest:focus-visible { box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .dn { overflow: hidden; text-overflow: ellipsis; }
  .narrow .sel { grid-area: sel; }
  .narrow .n { font-size: 14.5px; }
  .narrow .tbtn { height: 44px; padding: 0 12px; font-size: 14.5px; }
  .narrow .save { grid-area: save; width: 100%; height: 46px; border-radius: 14px; font-size: 16px; }
  .narrow .save:focus-visible { box-shadow: 0 0 0 2px var(--pm-bg), 0 0 0 4px var(--text); }

  @media (prefers-reduced-motion: reduce) {
    .bar { transform: none; opacity: 0; transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s linear var(--mo-micro); }
    .bar.up { opacity: 1; transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s; }
    .dest:active:not(:disabled), .tbtn:active, .save:active:not(:disabled) { transform: none; }
  }
</style>
