<script>
  // 模型菜单（逆向 claude.ai/code 实测规格，2026-07-29）：紧凑 popover——
  // "Models" 小节标题 + 主力四模型（当前项右侧 ✓）+ More models 子列表；
  // 行高 28/字号 13.5/圆角 8 卡片。Effort 已拆去 EffortPanel（拉条面板）。
  // 自定义 API 的模型（设置 › Claude › 模型服务，custom:<服务>:<模型>）一律收进 More models、按服务分组（2026-10-21）；
  // 服务关了「显示在模型列表」就不列。当前模型不在主列表里时（自定义 / 官方次要 / 已隐藏的服务），照官方做法
  // 在 Models 下第一行插一个打勾行，切走后就消失。
  import { caps, settings } from '../lib/state.svelte.js';
  import { splitClaudeModels, claudeDefaultModel } from '../lib/caps.js';
  import { rememberCurrentPrefs } from '../lib/chat.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { clampX } from '../lib/clampx.js';
  import { t } from '../lib/i18n.js';
  import { cp, ensureCustomModels, isCustomModel, effortsFor, modelSupportsFast } from '../lib/claudeProviders.svelte.js';
  let { onClose, dir = 'up' } = $props();

  let view = $state('main');
  let q = $state('');

  // 安卓系统返回：子视图先回上一层，再关闭；卸载自动出栈。
  $effect(() => pushBackLayer(() => {
    if (view.startsWith('prov:')) { view = 'more'; return; }
    if (view !== 'main') { view = 'main'; q = ''; return; }
    onClose?.();
  }));
  ensureCustomModels();   // 清单平时由总线 hello 带来；没到（老服务端 / 同源跟随页）才补拉一次
  const split = $derived(splitClaudeModels(caps.data));
  const curModelId = $derived(settings.model || claudeDefaultModel(caps.data));
  const kfmt = (n) => (!n ? '' : n >= 1_000_000 ? (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n));
  // 自定义模型的上下文徽章：内置型号表 / 按名字猜 / 兜底默认的值前面加「≈」（同模型服务编辑器），别让 200K 兜底看着像实测值
  const ctxBadge = (m) => { const k = kfmt(m.contextWindow); return k && ['table', 'guess', 'default'].includes(m.ctxSource) ? '≈' + k : k; };
  // 自定义模型按服务分组（只列显示在模型列表里的服务）；★ 默认模型排本组第一
  const groups = $derived.by(() => {
    const g = new Map();
    for (const m of cp.models) {
      if (m.hidden) continue;
      if (!g.has(m.provider)) g.set(m.provider, { id: m.provider, name: m.providerName, models: [] });
      g.get(m.provider).models.push(m);
    }
    for (const x of g.values()) x.models.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    return [...g.values()];
  });
  const GROUP_INLINE = 8;   // 一个服务超过这么多模型就收成一行，点进第三层
  const moreCount = $derived(split.rest.length + groups.reduce((n, g) => n + g.models.length, 0));
  const inPrimary = $derived(split.primary.some((m) => m.id === curModelId));
  // 当前模型的显示信息（不在主列表里时插在最前面）
  const curInfo = $derived.by(() => {
    if (inPrimary) return null;
    if (isCustomModel(curModelId)) {
      const m = cp.models.find((x) => x.id === curModelId);
      return m ? { id: m.id, name: m.name, sub: m.hidden ? t('已隐藏') : m.providerName, hidden: !!m.hidden } : null;
    }
    const m = split.rest.find((x) => x.id === curModelId);
    return m ? { id: m.id, name: m.name, sub: '' } : null;
  });
  // More models 行的副文字：当前模型在里面 → 它的名字；否则 → 条目数
  const moreSub = $derived(curInfo && !curInfo.hidden ? curInfo.name : moreCount ? String(moreCount) : '');
  // 搜索（条目多时才出现）：同时匹配型号名与服务名
  const searchable = $derived(moreCount > 15);
  const ql = $derived(q.trim().toLowerCase());
  const hit = (m, gname = '') => !ql || (m.name + ' ' + m.id + ' ' + gname).toLowerCase().includes(ql);
  const restShown = $derived(split.rest.filter((m) => hit(m)));
  const groupsShown = $derived(groups.map((g) => ({ ...g, shown: g.models.filter((m) => hit(m, g.name)) })).filter((g) => g.shown.length));
  const subGroup = $derived(view.startsWith('prov:') ? groups.find((g) => 'prov:' + g.id === view) : null);
  // fast mode（官方同款：菜单底部「Fast mode」小节 + Enable fast mode 开关行）。
  // 仅支持的模型显示（官方模型按 caps.claude.fast；官方 API 地址的自定义服务按服务端真探测的结果 m.fast）；开关状态粘性——
  // 切去不支持的模型时不清除，只是不显示也不随请求发送（Composer 芯片与服务端都按同一判定门控）。
  const fastOk = $derived(modelSupportsFast(curModelId, caps.data));

  // 改即记（chatPrefs）：没发送就杀后台，选择也不丢。推理强度跟着合法化：新模型的档位表里没有这一档
  //（官方 xhigh 带到只有开 / 关的自定义模型，或反过来）就清掉，回到新模型的默认档。
  function pickModel(id) {
    settings.model = id;
    if (settings.effort && !effortsFor(id, caps.data).some((e) => e.id === settings.effort)) { settings.effort = null; settings.effortAt = Date.now(); }
    rememberCurrentPrefs();
    onClose && onClose();
  }
  function toggleFast() { settings.fast = !settings.fast; rememberCurrentPrefs(); }
</script>

{#snippet check()}<svg class="mp-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>{/snippet}
{#snippet chevR()}<svg class="mp-chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 5l5 5-5 5"/></svg>{/snippet}
{#snippet backRow(label, to)}
  <button class="mp-row mp-back" onclick={() => { view = to; if (to === 'main') q = ''; }}>
    <svg class="mp-chev back" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 5l-5 5 5 5"/></svg>
    <span class="mp-name">{label}</span>
  </button>
{/snippet}
{#snippet modelRow(m, sub)}
  <button class="mp-row" role="menuitemradio" aria-checked={m.id === curModelId} onclick={() => pickModel(m.id)}>
    <span class="mp-name">{m.name}{#if sub}<span class="mp-sub">{sub}</span>{/if}</span>
    {#if m.id === curModelId}{@render check()}{/if}
  </button>
{/snippet}

<button class="mp-backdrop" aria-label={t('关闭')} onclick={() => onClose && onClose()}></button>
<div class="mp" class:down={dir === 'down'} role="menu" use:clampX>
  {#if view === 'main'}
    <div class="mp-label">Models</div>
    {#if curInfo}
      <button class="mp-row" role="menuitemradio" aria-checked="true" title={curInfo.hidden ? t('此服务已在模型菜单中隐藏') : ''} onclick={() => onClose && onClose()}>
        <span class="mp-name">{curInfo.name}{#if curInfo.sub}<span class="mp-sub">{curInfo.sub}</span>{/if}</span>
        {@render check()}
      </button>
    {/if}
    {#each split.primary as m (m.id)}{@render modelRow(m, '')}{/each}
    {#if moreCount}
      <div class="mp-div"></div>
      <button class="mp-row" onclick={() => (view = 'more')}>
        <span class="mp-name">More models{#if moreSub}<span class="mp-sub">{moreSub}</span>{/if}</span>
        {@render chevR()}
      </button>
    {/if}
    {#if fastOk}
      <div class="mp-div"></div>
      <div class="mp-label">Fast mode</div>
      <button class="mp-row" role="menuitemcheckbox" aria-checked={settings.fast} onclick={toggleFast}>
        <span class="mp-name">Enable fast mode</span>
        <span class="mp-switch" class:on={settings.fast} aria-hidden="true"><span class="mp-knob"></span></span>
      </button>
    {/if}
  {:else if subGroup}
    {@render backRow(subGroup.name, 'more')}
    <div class="mp-div"></div>
    {#each subGroup.models as m (m.id)}{@render modelRow(m, ctxBadge(m))}{/each}
  {:else}
    {@render backRow('Models', 'main')}
    {#if searchable}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="mp-search" placeholder={t('搜索模型')} bind:value={q} autofocus={matchMedia('(hover: hover)').matches} />
    {/if}
    <div class="mp-div"></div>
    {#each restShown as m (m.id)}{@render modelRow(m, '')}{/each}
    {#each groupsShown as g, gi (g.id)}
      {#if restShown.length || gi > 0}<div class="mp-div"></div>{/if}
      {#if g.models.length > GROUP_INLINE && !ql}
        <button class="mp-row" onclick={() => (view = 'prov:' + g.id)}>
          <span class="mp-name">{g.name}<span class="mp-sub">{g.models.length}</span></span>
          {@render chevR()}
        </button>
      {:else}
        <div class="mp-label">{g.name}</div>
        {#each g.shown as m (m.id)}{@render modelRow(m, ctxBadge(m))}{/each}
      {/if}
    {/each}
    {#if ql && !restShown.length && !groupsShown.length}<div class="mp-empty">{t('没有匹配的模型')}</div>{/if}
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
  .mp-label { padding: 4px 12px 2px; font-size: 12px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 官方行规格：min-h 28（官方 24，触屏放宽）/px 12/13.5px */
  .mp-row { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 8px; padding: 5px 12px; text-align: left; }
  .mp-row:active { background: var(--hover); }
  @media (hover: hover) { .mp-row:hover { background: var(--hover); } }
  .mp-name { flex: 1; min-width: 0; font-size: 13.5px; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mp-back .mp-name { color: var(--muted); }
  .mp-sub { margin-left: 7px; font-size: 12px; color: var(--muted); }   /* 服务名 / 上下文窗口 / 子菜单里的个数 */
  .mp-check { flex: none; width: 15px; height: 15px; color: var(--text); }
  .mp-chev { flex: none; width: 14px; height: 14px; color: var(--muted); }
  .mp-chev.back { margin-left: -4px; }
  .mp-div { height: 1px; background: var(--divider); margin: 5px 0; }
  .mp-search { display: block; width: calc(100% - 16px); margin: 4px 8px 2px; height: 28px; padding: 0 8px; box-sizing: border-box;
    border: 1px solid var(--divider); border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 13px; outline: 0; }
  .mp-search:focus { border-color: var(--muted); }
  .mp-empty { padding: 6px 12px; font-size: 12.5px; color: var(--muted); }
  /* Fast mode 开关（官方 claude.ai/code 同款：iOS 式蓝色 toggle，32×18 / knob 14） */
  .mp-switch { flex: none; width: 32px; height: 18px; border-radius: 999px; background: var(--hover-strong, var(--hover));
    position: relative; transition: background var(--mo-micro) var(--ea-fade); }
  .mp-switch.on { background: #2f80ed; }
  .mp-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: left var(--mo-quick) var(--ea-std); }
  .mp-switch.on .mp-knob { left: 16px; }
</style>
