<script module>
  // 合并行上次选的是哪家（同一次打开 Studio 里记着；换页、重开选择器都还在）
  const prefer = {};
</script>

<script>
  // 模型选择器（方案 §12.4）：dimensio Popover（手机 Sheet）。
  //   按厂商分组（组头灰度厂商标 + 名字）；两家服务都有的同名模型合成一行（picker.js 的 modelRows），
  //   行尾一枚小分段选走哪家（服务真标 + 短名，选中那家的标恢复彩色）；只有一家的行尾写服务名。
  //   这一类模型多于 8 个时顶上有搜索框，搜索范围包括「备选」（shelf：巡检建底时收下、不进主列表的模型），备选单独一组。
  //   新发现的模型名后一粒朱点（7 天内且没用过）；参数沿用别的模型 / 用通用参数时名字下一行小字（状态，不是解释）。
  //   选 shelf 模型时按需取完整卡（GET /api/studio/models/resolve），取的那一会儿行尾是一段朱色量度条。
  import { tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { providerLogo } from '../../lib/providerLogos.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { studio, groupsOf, pickModel, labelForId } from '../../modules/studio/media.svelte.js';
  import { modelRows, modelCount, paramSource, isFresh, shelfHits, vendorOf, vendorName } from '../../modules/studio/picker.js';
  import { SPRING_SNAP } from '../../modules/studio/motion.js';
  import { icon } from '../../modules/studio/icons.js';
  import { sourceText } from '../../modules/studio/words.js';
  import Layer from './ui/Layer.svelte';
  import Measure from './ui/Measure.svelte';
  import Segmented from './ui/Segmented.svelte';

  let { page, current = '', anchor = null, trigger = null, onclose } = $props();

  let q = $state('');
  let qEl = $state();
  let pref = $state({ ...prefer });
  let busy = false;
  const all = $derived(groupsOf(page));
  const total = $derived(modelCount(all));
  const searchable = $derived(total > 8);
  const vendors = $derived(modelRows(all, { q: q.trim(), current, prefer: pref }));
  const hits = $derived(shelfHits(all, q.trim(), current));
  const srcLine = (m) => sourceText(paramSource(m), labelForId);
  const vendorLogo = (v) => providerLogo({ preset: v }) || '';
  const initial = (s) => String(s || '?').trim().slice(0, 1).toUpperCase();

  async function pick(m) {
    if (busy) return;
    busy = true;
    try { if (await pickModel(page, m)) onclose?.(); }
    finally { busy = false; }
  }
  // 行尾点一家：墨块先滑过去（看得见选了哪家），再关
  function viaService(e, r) {
    e.stopPropagation();
    const b = e.target.closest?.('[data-v]');
    if (!b) return;
    const x = r.variants.find((v) => String(v.provider?.id) === b.dataset.v);
    if (!x) return;
    prefer[r.id] = x.provider.id;
    pref = { ...pref, [r.id]: x.provider.id };
    setTimeout(() => pick(x.model), Math.round(SPRING_SNAP.ms * 0.8));
  }
  function rowKey(e, m) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }
  $effect(() => { if (searchable) tick().then(() => { if (matchMedia('(pointer: fine)').matches) qEl?.focus({ preventScroll: true }); }); });
</script>

<Layer title={t('选择模型')} {anchor} {trigger} avoid={anchor} width={392} align="start" prefer="up" role="dialog" {onclose}>
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
  {:else if !vendors.length && !hits.length}
    <p class="op-none">{t('没有匹配的模型')}</p>
  {/if}
  <div class="mp" role="listbox" aria-label={t('模型')}>
    {#each vendors as v (v.label)}
      <div class="mp-gh" role="presentation">
        {#if vendorLogo(v.vendor)}<span class="mp-vl">{@html vendorLogo(v.vendor)}</span>{:else}<span class="mp-vl ini">{initial(v.label)}</span>{/if}
        <span>{tr(v.label)}</span>
      </div>
      {#each v.rows as r (r.id)}
        {@const sel = r.variants[r.pick]}
        {@const line = srcLine(sel.model)}
        {@const fresh = r.variants.some((x) => isFresh(x.model, studio.seen))}
        {@const waiting = r.variants.some((x) => studio.resolving === x.model.key)}
        <div class="mp-row" class:on={r.on} role="option" aria-selected={r.on} tabindex="0" title={sel.model.id}
          onclick={() => pick(sel.model)} onkeydown={(e) => rowKey(e, sel.model)}>
          <span class="mp-ck" aria-hidden="true">{@html icon('check')}</span>
          <span class="mp-tx">
            <b><span>{tr(r.label)}</span>{#if fresh}<span class="mp-new" role="img" aria-label={t('新')} title={t('新')}></span>{/if}</b>
            {#if line}<small>{line}</small>{/if}
          </span>
          {#if waiting}<span class="mp-wait"><Measure tone="live" /></span>{/if}
          {#if r.variants.length > 1}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <span class="mp-sw" onclick={(e) => viaService(e, r)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') viaService(e, r); }}>
              <Segmented size="xs" tone="paper" label={t('走哪家')} value={String(sel.provider?.id)}
                options={r.variants.map((x) => ({ value: String(x.provider?.id), label: tr(x.short), glyph: providerLogo(x.provider) || '', title: tr(x.provider?.name || '') }))} onchange={() => {}} />
            </span>
          {:else}
            <span class="mp-one" title={tr(sel.provider?.name || '')}>{#if providerLogo(sel.provider)}<span class="mp-pl">{@html providerLogo(sel.provider)}</span>{/if}<span class="mp-on">{tr(sel.provider?.name || '')}</span></span>
          {/if}
        </div>
      {/each}
    {/each}
    {#if hits.length}
      <!-- 搜到的备选（巡检建底时收下、不进主列表的）：单独一组，组名说一次；行里第二行是服务 · 厂商 -->
      <div class="mp-gh" role="presentation"><span>{t('备选')}</span></div>
      {#each hits as h (h.model.key)}
        {@const m = h.model}
        <div class="mp-row" role="option" aria-selected="false" tabindex="0" onclick={() => pick(m)} onkeydown={(e) => rowKey(e, m)}>
          <span class="mp-ck" aria-hidden="true">{@html icon('check')}</span>
          <span class="mp-tx">
            <b><span>{tr(m.label || m.id)}</span></b>
            <small>{[tr(h.provider?.name || ''), vendorName(vendorOf(m))].filter(Boolean).join(' · ')}</small>
          </span>
          {#if studio.resolving === m.key}<span class="mp-wait"><Measure tone="live" /></span>{/if}
        </div>
      {/each}
    {/if}
  </div>
</Layer>
