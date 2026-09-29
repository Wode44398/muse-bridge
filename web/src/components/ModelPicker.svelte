<script>
  // 模型菜单（逆向 claude.ai/code 实测规格，2026-07-29）：紧凑 popover——
  // "Models" 小节标题 + 主力四模型（当前项右侧 ✓）+ More models 子列表；
  // 行高 28/字号 13.5/圆角 8 卡片。Effort 已拆去 EffortPanel（拉条面板）。
  import { caps, settings } from '../lib/state.svelte.js';
  import { splitClaudeModels, claudeDefaultModel } from '../lib/caps.js';
  import { rememberCurrentPrefs } from '../lib/chat.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { clampX } from '../lib/clampx.js';
  import { t } from '../lib/i18n.js';
  let { onClose, dir = 'up' } = $props();

  let view = $state('main');

  // 安卓系统返回：子视图先回主列表，再关闭；卸载自动出栈。
  $effect(() => pushBackLayer(() => {
    if (view !== 'main') { view = 'main'; return; }
    onClose?.();
  }));
  const split = $derived(splitClaudeModels(caps.data));
  const curModelId = $derived(settings.model || claudeDefaultModel(caps.data));
  // fast mode（官方同款：菜单底部「Fast mode」小节 + Enable fast mode 开关行）。
  // 仅支持的模型（caps.claude.fast）显示；开关状态粘性——切去不支持的模型时不清除，
  // 只是不显示也不随请求发送（Composer 芯片与发送侧都按同一支持表门控）。
  const fastOk = $derived((caps.data?.claude?.fast || []).includes(curModelId));

  // 改即记（chatPrefs）：没发送就杀后台，选择也不丢。
  function pickModel(id) { settings.model = id; rememberCurrentPrefs(); onClose && onClose(); }
  function toggleFast() { settings.fast = !settings.fast; rememberCurrentPrefs(); }
</script>

<button class="mp-backdrop" aria-label={t('关闭')} onclick={() => onClose && onClose()}></button>
<div class="mp" class:down={dir === 'down'} role="menu" use:clampX>
  {#if view === 'main'}
    <div class="mp-label">Models</div>
    {#each split.primary as m (m.id)}
      <button class="mp-row" role="menuitemradio" aria-checked={m.id === curModelId} onclick={() => pickModel(m.id)}>
        <span class="mp-name">{m.name}</span>
        {#if m.id === curModelId}<svg class="mp-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>{/if}
      </button>
    {/each}
    <div class="mp-div"></div>
    <button class="mp-row" onclick={() => (view = 'more')}>
      <span class="mp-name">More models</span>
      <svg class="mp-chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 5l5 5-5 5"/></svg>
    </button>
    {#if fastOk}
      <div class="mp-div"></div>
      <div class="mp-label">Fast mode</div>
      <button class="mp-row" role="menuitemcheckbox" aria-checked={settings.fast} onclick={toggleFast}>
        <span class="mp-name">Enable fast mode</span>
        <span class="mp-switch" class:on={settings.fast} aria-hidden="true"><span class="mp-knob"></span></span>
      </button>
    {/if}
  {:else}
    <button class="mp-row mp-back" onclick={() => (view = 'main')}>
      <svg class="mp-chev back" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 5l-5 5 5 5"/></svg>
      <span class="mp-name">Models</span>
    </button>
    <div class="mp-div"></div>
    {#each split.rest as m (m.id)}
      <button class="mp-row" role="menuitemradio" aria-checked={m.id === curModelId} onclick={() => pickModel(m.id)}>
        <span class="mp-name">{m.name}</span>
        {#if m.id === curModelId}<svg class="mp-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>{/if}
      </button>
    {/each}
  {/if}
</div>

<style>
  .mp-backdrop { position: fixed; inset: 0; z-index: 60; }
  /* 官方 popover 实测：min-w 130 / 圆角 8 / py 6 / 影 0 0 0 1px 6% + 0 6px 16px 6% */
  .mp {
    position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 61;
    min-width: 172px; max-width: 88vw; padding: 6px 0;
    background: var(--q-card); border-radius: 10px; box-shadow: var(--q-shadow);
    max-height: 60vh; overflow-y: auto; animation: mpPop var(--mo-quick) var(--ea-decel);
  }
  @keyframes mpPop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
  .mp.down { bottom: auto; top: calc(100% + 8px); }
  .mp-label { padding: 4px 12px 2px; font-size: 12px; color: var(--muted); }
  /* 官方行规格：min-h 28（官方 24，触屏放宽）/px 12/13.5px */
  .mp-row { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 8px; padding: 5px 12px; text-align: left; }
  .mp-row:active { background: var(--hover); }
  @media (hover: hover) { .mp-row:hover { background: var(--hover); } }
  .mp-name { flex: 1; min-width: 0; font-size: 13.5px; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mp-back .mp-name { color: var(--muted); }
  .mp-check { flex: none; width: 15px; height: 15px; color: var(--text); }
  .mp-chev { flex: none; width: 14px; height: 14px; color: var(--muted); }
  .mp-chev.back { margin-left: -4px; }
  .mp-div { height: 1px; background: var(--divider); margin: 5px 0; }
  /* Fast mode 开关（官方 claude.ai/code 同款：iOS 式蓝色 toggle，32×18 / knob 14） */
  .mp-switch { flex: none; width: 32px; height: 18px; border-radius: 999px; background: var(--hover-strong, var(--hover));
    position: relative; transition: background var(--mo-micro) var(--ea-fade); }
  .mp-switch.on { background: #2f80ed; }
  .mp-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: left var(--mo-quick) var(--ea-std); }
  .mp-switch.on .mp-knob { left: 16px; }
</style>
