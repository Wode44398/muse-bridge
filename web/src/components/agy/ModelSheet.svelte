<script>
  // 输入框底栏的独立小菜单（kind）：model 模型 / effort 思考深度 / mode 运行模式 / device 这个会话连哪台电脑。
  // mode 由开口仪表（AgyGauge）打开：上半选模式，下半是上下文与额度明细（AgyUsageSection）。
  // 手机档底栏没有电脑芯片（放不下），它成了 mode 菜单里的一行「运行环境」：点开就地展开候选，选完即关。
  // 各自贴着自己的芯片弹出，选完即关，全部保持紧凑单行、不挂冗余说明字。
  import { agy, fallbackAgyCaps, changeAgyConfig, setAgyDevice } from '../../lib/agy/store.svelte.js';
  import { devices, loadDevices, thisDeviceId } from '../../lib/devices.svelte.js';
  import { groupModels, extractThoughtOptions, extractModeOptions } from '../../lib/agy/logic.js';
  import { brandLogoOfSeries } from '../../lib/agy/composer-meta.js';
  import { t } from '../../lib/i18n.js';
  import BrandLogo from '../modelhub/BrandLogo.svelte';
  import AgyModeIcon from './AgyModeIcon.svelte';
  import AgyPopover from './AgyPopover.svelte';
  import AgyUsageSection from './AgyUsageSection.svelte';
  import { slide } from 'svelte/transition';
  import { haptic } from '../../lib/dragdrop.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import { agyDeviceView, agyDeviceText } from '../../lib/agy/device-view.js';

  const { kind = 'model', onClose } = $props();

  const fb = $derived(fallbackAgyCaps());
  const modelData = $derived(groupModels(agy.configOptions, fb.models));
  const activeModel = $derived(agy.model || modelData.current);
  const thoughtData = $derived(extractThoughtOptions(agy.configOptions, fb.efforts, activeModel, fb.models));
  const activeThought = $derived(
    thoughtData.options.some((o) => o.id === agy.thoughtLevel) ? agy.thoughtLevel : thoughtData.current
  );
  const modeData = $derived(extractModeOptions(agy.configOptions, agy.modes, fb.modes));
  const activeMode = $derived(agy.mode || modeData.current);

  // 选完走弹层自己的 close()：卡片缩回芯片 / 仪表再摘掉（container transform 的后半段）
  let pop = $state(null);
  function pick(configId, value) {
    haptic('tick');
    changeAgyConfig(configId, value);
    if (pop) pop.close();
    else onClose?.();
  }

  // 电脑：打开时拉一次最新的在线状态
  // envRow：手机档的仪表菜单里带「运行环境」行（与输入框底栏那颗芯片同一个条件，二者只出现一个）
  const envRow = $derived(kind === 'mode' && layout.compact && devices.enabled && (devices.list.length > 0 || isNativeDesktop()));
  $effect(() => { if (kind === 'device' || (kind === 'mode' && layout.compact)) loadDevices(true); });
  const devSel = $derived(agy.sessionId ? (agy.deviceLink || 'auto') : agy.deviceDraft);
  const devView = $derived(agyDeviceView(devices.list, devSel === 'auto' ? '' : devSel, thisDeviceId()));
  // 行右端写当前连的那台；自动而又定不下具体哪台时就写「自动」（芯片上那句「选电脑」是招呼人去点，放在已展开候选的行里不对）
  const envText = $derived(devView.kind === 'unset' && devSel === 'auto' ? t('自动') : agyDeviceText(devView, t));
  let envOpen = $state(false);
  function pickDevice(v) {
    haptic('tick');
    setAgyDevice(v);
    if (pop) pop.close();
    else onClose?.();
  }

  const titles = $derived({ model: t('模型'), effort: t('思考深度'), mode: t('运行模式与用量'), device: t('这个对话连哪台电脑') });
  const widths = { model: 280, effort: 168, mode: 260, device: 232 };
</script>

<AgyPopover
  bind:this={pop}
  cover={kind === 'mode'}
  anchor={agy.popAnchor}
  anchorEl={agy.popAnchorEl}
  width={widths[kind] || 280}
  title={titles[kind] || t('模型')}
  {onClose}
>
  {#if kind === 'model'}
    {#each modelData.groups as grp, gi (grp.series)}
      {#if gi > 0}<div class="agy-menu-sep"></div>{/if}
      <div class="agy-menu-label ms-series">
        <BrandLogo logo={brandLogoOfSeries(grp.series)} name={grp.series} size={13} plain />
        <span>{grp.series}</span>
      </div>
      {#each grp.models as item (item.id)}
        <button
          type="button"
          class="agy-menu-row ms-compact ms-model"
          class:cur={activeModel === item.id}
          onclick={() => pick('model', item.id)}
        >
          <span class="row-main">
            <span class="row-name">{item.name}</span>
          </span>
          {#if activeModel === item.id}<span class="msr4 row-chk">check</span>{/if}
        </button>
      {/each}
    {/each}
  {:else if kind === 'effort'}
    {#if thoughtData.options.length === 0}
      <div class="ms-empty">{t('当前模型不支持调整思考深度')}</div>
    {:else}
      {#each thoughtData.options as opt (opt.id)}
        <button
          type="button"
          class="agy-menu-row ms-compact ms-effort"
          class:cur={activeThought === opt.id}
          onclick={() => pick('thought_level', opt.id)}
        >
          <!-- 档位行只有文字（维护者 11-21 定）：low / medium / high 这几个词就是全部信息，信号格 / 楔形那类图标含义是手机信号、放这儿错位 -->
          <span class="row-main">
            <span class="row-name">{opt.name}</span>
          </span>
          {#if activeThought === opt.id}<span class="msr4 row-chk">check</span>{/if}
        </button>
      {/each}
    {/if}
  {:else if kind === 'device'}
    {@render deviceRows()}
  {:else}
    {#each modeData.options as m (m.id)}
      <button
        type="button"
        class="agy-menu-row ms-compact ms-mode"
        class:cur={activeMode === m.id}
        onclick={() => pick('mode', m.id)}
      >
        <span class="row-ico mode-ico"><AgyModeIcon mode={m.id} size={18} /></span>
        <span class="row-main">
          <span class="row-name">{m.name}</span>
        </span>
        {#if activeMode === m.id}<span class="msr4 row-chk">check</span>{/if}
      </button>
    {/each}
    {#if envRow}
      <div class="agy-menu-sep"></div>
      <button
        type="button"
        class="agy-menu-row ms-compact ms-env"
        aria-expanded={envOpen}
        title={t('这个对话连哪台电脑')}
        onclick={() => { haptic('tick'); envOpen = !envOpen; }}
      >
        <span class="msr4 row-ico" aria-hidden="true">desktop_windows</span>
        <span class="row-main"><span class="row-name">{t('运行环境')}</span></span>
        <span class="ms-env-val">{envText}</span>
        {#if devView.tone !== 'idle'}<span class="ms-dot" class:on={devView.tone === 'on'} aria-hidden="true"></span>{/if}
        <span class="msr ms-env-chev" class:open={envOpen} aria-hidden="true">expand_more</span>
      </button>
      {#if envOpen}
        <div class="ms-env-list" role="group" aria-label={t('这个对话连哪台电脑')} transition:slide={{ duration: 200 }}>
          {@render deviceRows()}
        </div>
      {/if}
    {/if}
    <AgyUsageSection />
  {/if}
</AgyPopover>

{#snippet deviceRows()}
  <button type="button" class="agy-menu-row ms-compact" class:cur={devSel === 'auto'} onclick={() => pickDevice('auto')}>
    <span class="row-main"><span class="row-name">{t('自动')}</span></span>
    {#if devSel === 'auto'}<span class="msr4 row-chk">check</span>{/if}
  </button>
  {#each devices.list as d (d.id)}
    <button type="button" class="agy-menu-row ms-compact" class:cur={devSel === d.id} onclick={() => pickDevice(d.id)}>
      <span class="ms-dot" class:on={d.online} aria-hidden="true"></span>
      <span class="row-main">
        <span class="row-name">{d.name}</span>
      </span>
      {#if d.id === thisDeviceId()}<span class="ms-tag">{t('这台')}</span>{:else if !d.online}<span class="ms-tag">{t('离线')}</span>{/if}
      {#if devSel === d.id}<span class="msr4 row-chk">check</span>{/if}
    </button>
  {/each}
  <div class="agy-menu-sep"></div>
  <button type="button" class="agy-menu-row ms-compact" class:cur={devSel === 'none'} onclick={() => pickDevice('none')}>
    <span class="row-main"><span class="row-name">{t('不连电脑')}</span></span>
    {#if devSel === 'none'}<span class="msr4 row-chk">check</span>{/if}
  </button>
{/snippet}

<style>
  .ms-series {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px 2px;
  }
  .agy-menu-row.cur {
    background: var(--ag-active);
  }
  .ms-compact {
    min-height: 30px;
    padding: 4px 10px;
  }
  :global(.sheet) .ms-compact {
    min-height: 40px;
    padding: 7px 12px;
  }
  .ms-model .row-name { font-weight: 500; }
  .mode-ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ms-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--ag-on-faint); opacity: 0.5; }
  .ms-dot.on { background: var(--ag-ok); opacity: 1; }
  .ms-tag { font-size: 11.5px; color: var(--ag-on-faint); flex: none; }
  /* 运行环境：一行显示当前连的那台（淡字 + 在线点），点开在下面就地展开候选；候选缩进到与行名对齐 */
  .ms-env-val {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ag-on-faint);
  }
  .ms-env-chev {
    flex: none;
    font-size: 18px;
    margin: 0 -3px 0 -4px;
    color: var(--ag-on-faint);
    transition: transform var(--ag-dur-quick) var(--ag-ease-std);
  }
  .ms-env-chev.open { transform: rotate(180deg); }
  .ms-env-list { padding-left: 27px; overflow: hidden; }
  .ms-env-list :global(.agy-menu-sep) { margin: 3px 4px; }
  .ms-empty {
    padding: 16px 12px;
    font-size: 13px;
    color: var(--ag-on-faint);
  }
</style>
