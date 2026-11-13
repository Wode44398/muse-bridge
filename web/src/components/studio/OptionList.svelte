<script>
  // 枚举参数的选项菜单（参数行的选择钮、输入框底行的值芯片都用它）：dimensio MenuItem 同族的行，选中行尾一枚墨勾；
  // 选项的 hint（§9.3 options[].hint，比如价格档）是行尾一小段 mono；超过 12 项顶上出搜索框（几十个选项也找得到），命中的那段加粗。
  import { tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { icon } from '../../modules/studio/icons.js';
  import { needsSearch, searchOptions, hitParts } from '../../modules/studio/render.js';

  // inListbox：外面的弹层本身就是 listbox（选项不再套一层 listbox）
  let { options = [], value, labelOf = (o) => String(o.label ?? o.value), onpick, autofocus = true, inListbox = false } = $props();

  let q = $state('');
  let qEl = $state();
  let listEl = $state();
  const search = $derived(needsSearch(options));
  const shown = $derived(searchOptions(options, q, labelOf));
  // 打开时把选中的那一项滚进视野（长列表里选中的常在后半截）
  $effect(() => {
    void listEl;
    tick().then(() => {
      const on = listEl?.querySelector('.op.on');
      if (on && listEl) { const sc = listEl.closest('.pv-scroll, .sh-body'); if (sc) sc.scrollTop = Math.max(0, on.offsetTop - sc.clientHeight / 2); }
      if (search && autofocus && matchMedia('(pointer: fine)').matches) qEl?.focus({ preventScroll: true });
    });
  });
</script>

{#if search}
  <label class="op-q">{@html icon('search')}<input bind:this={qEl} bind:value={q} placeholder={t('搜索')} aria-label={t('搜索')} /></label>
{/if}
<div bind:this={listEl} role={inListbox ? 'presentation' : 'listbox'}>
  {#each shown as o (String(o.value))}
    {@const hp = q ? hitParts(labelOf(o), q) : null}
    <button class="op" class:on={o.value === value} role="option" aria-selected={o.value === value} onclick={() => onpick?.(o.value)}>
      <span class="op-tx"><b><span>{#if hp}{hp[0]}<mark class="op-hit">{hp[1]}</mark>{hp[2]}{:else}{labelOf(o)}{/if}</span></b></span>
      {#if o.hint}<span class="op-hint">{tr(String(o.hint))}</span>{/if}
      <span class="op-ck">{@html icon('check')}</span>
    </button>
  {/each}
  {#if !shown.length}<p class="op-none">{t('没有匹配的选项')}</p>{/if}
</div>
