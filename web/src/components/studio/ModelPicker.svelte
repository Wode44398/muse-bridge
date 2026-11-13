<script>
  // 模型选择器（v3，方案 §9.2「模型选择器」+ §9.3）：dimensio Popover（手机 Sheet）。
  //   分组 = 服务（灰度品牌标 + 服务名，+ 成员自带的「我的」）；聚合服务（OpenRouter / fal / Replicate）组内再按厂商分小组。
  //   这一类模型多于 8 个时顶上有搜索框，搜索范围包括「备选」（shelf：巡检建底时收下、不进主列表的模型）。
  //   新发现的模型名后一枚墨色细线框「新」（7 天内且没用过）；参数沿用别的模型 / 用通用参数时，名字下一行小字「沿用 X / 通用参数」（状态，不是解释）。
  //   选 shelf 模型时按需取完整卡（GET /api/studio/models/resolve），取的那一会儿行尾是一段朱色量度条。
  import { tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { providerLogo } from '../../lib/providerLogos.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { studio, groupsOf, pickModel, labelForId } from '../../modules/studio/media.svelte.js';
  import { pickerGroups, modelCount, paramSource, isFresh, shelfHits, vendorOf, vendorName } from '../../modules/studio/picker.js';
  import { icon } from '../../modules/studio/icons.js';
  import { sourceText } from '../../modules/studio/words.js';
  import Layer from './ui/Layer.svelte';
  import Measure from './ui/Measure.svelte';

  let { page, current = '', anchor = null, trigger = null, onclose } = $props();

  let q = $state('');
  let qEl = $state();
  const all = $derived(groupsOf(page));
  const total = $derived(modelCount(all));
  const searchable = $derived(total > 8);
  const groups = $derived(pickerGroups(all, { q: q.trim(), current }));
  const hits = $derived(shelfHits(all, q.trim(), current));
  const many = $derived(all.filter((g) => (g.models || []).length || (g.shelf || []).length).length > 1);
  // 「我的」只在有别人共享来的服务时才有区分意义
  const mixed = $derived(all.some((g) => !g.provider.mine) && all.some((g) => g.provider.mine));
  const initial = (s) => String(s || '?').trim().slice(0, 1).toUpperCase();
  const srcLine = (m) => sourceText(paramSource(m), labelForId);
  async function pick(m) {
    const ok = await pickModel(page, m);
    if (ok) onclose?.();
  }
  $effect(() => { if (searchable) tick().then(() => { if (matchMedia('(pointer: fine)').matches) qEl?.focus({ preventScroll: true }); }); });
</script>

<Layer title={t('选择模型')} {anchor} {trigger} avoid={anchor} width={360} align="start" prefer="up" role="dialog" {onclose}>
  {#snippet head()}
    {#if searchable}
      <div class="mp-q"><label class="op-q">{@html icon('search')}<input bind:this={qEl} bind:value={q} placeholder={t('搜索模型')} aria-label={t('搜索模型')} /></label></div>
    {/if}
  {/snippet}
  {#if !total}
    <div class="op-empty">
      <p>{t('没有可用模型')}</p>
      <button class="op-go" onclick={() => { onclose?.(); openSettings('studio'); }}>{t('打开 Media Studio 设置')}</button>
    </div>
  {:else if !groups.length && !hits.length}
    <p class="op-none">{t('没有匹配的模型')}</p>
  {/if}
  <div class="mp" class:grouped={many || groups.some((g) => g.sections.some((s) => s.label))}>
  {#each groups as g (g.provider.id)}
    {#if many || g.sections.some((s) => s.label)}
      <div class="op-gh">
        {#if providerLogo(g.provider)}<span class="op-logo">{@html providerLogo(g.provider)}</span>{:else}<span class="op-logo op-ini">{initial(g.provider.name)}</span>{/if}
        <b>{tr(g.provider.name)}</b>
        {#if mixed && g.provider.mine}<small>{t('我的')}</small>{/if}
      </div>
    {/if}
    {#each g.sections as sec (sec.vendor)}
      <div class="mp-sec" class:sub={!!sec.label}>
        {#if sec.label}<div class="op-sub">{sec.label}</div>{/if}
        {#each sec.models as m (m.key)}
          {@const line = srcLine(m)}
          <button class="op mp-op" class:on={m.key === current} role="option" aria-selected={m.key === current} onclick={() => pick(m)}>
            <span class="op-tx">
              <b><span>{tr(m.label || m.id)}</span>{#if isFresh(m, studio.seen)}<span class="op-new">{t('新')}</span>{/if}</b>
              {#if line}<small>{line}</small>{/if}
            </span>
            {#if studio.resolving === m.key}<span class="mp-wait"><Measure tone="live" /></span>{/if}
            <span class="op-ck">{@html icon('check')}</span>
          </button>
        {/each}
      </div>
    {/each}
  {/each}
  {#if hits.length}
    <!-- 搜到的备选（巡检建底时收下、不进主列表的）：单独一组，组名说一次；行里第二行是服务 · 厂商 -->
    <div class="op-gh"><b>{t('备选')}</b></div>
    {#each hits as h (h.model.key)}
      {@const m = h.model}
      <button class="op mp-op" role="option" aria-selected="false" onclick={() => pick(m)}>
        <span class="op-tx">
          <b><span>{tr(m.label || m.id)}</span></b>
          <small>{[tr(h.provider?.name || ''), vendorName(vendorOf(m))].filter(Boolean).join(' · ')}</small>
        </span>
        {#if studio.resolving === m.key}<span class="mp-wait"><Measure tone="live" /></span>{/if}
      </button>
    {/each}
  {/if}
  </div>
</Layer>
