<script>
  // 模型列表上方：搜索 + 厂商筛选（下拉弹层，支持鼠轮竖滚与搜索厂商）+ 「已添加 n」，再下面一行是列表头（三态全选、数量、上次识别 + 重新识别）。
  // 宽屏一行排开工具，窄屏搜索独占一行；「已添加 n」固定在最右、描边不填底，与厂商筛选分开。
  // nudge：连接改过、目录可能是旧的——「重新识别」垫一层底色提醒。
  import HsVendorPicker from './HsVendorPicker.svelte';
  import { G, svg, CHECK, ago } from './HsKit.js';
  import { DUR, EASE, reduced } from '../../lib/motion.js';
  import { t, tc } from '../../lib/i18n.js';

  let {
    qIn = $bindable(''), searchEl = $bindable(null),
    vendors = [], vf = '', allN = 0, onvendor,
    onlyAdded = false, addedN = 0, onadded,
    total = 0, allState = 'none', selectableN = 0, onall,
    catAt = 0, now = Date.now(), detecting = false, canDetect = true, ondetect, nudge = false,
    narrow = false,
  } = $props();

  let allBox = $state();
  function clickAll() {
    onall?.();
    // 勾上 / 取消的短促缩放（只在用户点的那一下播，挂载时已勾着的不播）
    if (allBox && !reduced()) allBox.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: DUR.quick, easing: EASE.std });
  }
  function searchKey(e) {
    // 有字时 Esc 先清空搜索，不往外传（外框的 Esc 是「逐层后退」）
    if (e.key === 'Escape' && !e.isComposing && qIn) { e.preventDefault(); e.stopPropagation(); qIn = ''; }
  }
  const when = $derived(catAt ? ago(catAt, now) : '');
  // 只有一家厂商且覆盖全部模型时，筛与不筛结果相同，隐藏厂商选择器避免占位
  const showVendor = $derived(vendors.length > 1 || (vendors.length === 1 && allN > vendors[0].n) || !!vf);
</script>

<div class="tools" class:narrow>
  <label class="search">
    <span class="sic" aria-hidden="true">{@html svg(G.search)}</span>
    <input bind:this={searchEl} bind:value={qIn} type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" autocapitalize="off"
      placeholder={t('搜索模型')} aria-label={t('搜索模型')} onkeydown={searchKey} />
    {#if qIn}
      <button type="button" class="sx" aria-label={t('清除搜索')} title={t('清除搜索')} onclick={() => { qIn = ''; searchEl?.focus(); }}>{@html svg(G.clear, 1.8)}</button>
    {/if}
  </label>
  <div class="frow">
    {#if showVendor}
      <HsVendorPicker {vendors} {vf} {allN} {onvendor} {narrow} />
    {/if}
    <button type="button" class="fbtn added" class:on={onlyAdded} aria-pressed={onlyAdded} disabled={!addedN && !onlyAdded} onclick={() => onadded?.(!onlyAdded)}>
      {t('已添加 {n}', { n: addedN })}
    </button>
  </div>
</div>

<div class="head" class:narrow>
  <button type="button" class="all" role="checkbox" aria-checked={allState === 'all' ? 'true' : allState === 'some' ? 'mixed' : 'false'}
    disabled={!selectableN} onclick={clickAll}>
    <span class="hs-cb" class:on={allState === 'all'} class:mixed={allState === 'some'} bind:this={allBox}>{@html CHECK}</span>
    <span>{t('全选')}</span>
  </button>
  <span class="cnt">{tc('列表', '{n} 个模型', { n: total })}</span>
  <span class="sp"></span>
  {#if when}<span class="when">{t('上次识别 {when}', { when })}</span>{/if}
  <button type="button" class="tbtn" class:hot={nudge && !detecting} disabled={detecting || !canDetect} onclick={() => ondetect?.()}>
    {#if detecting}<span class="spin" aria-hidden="true"></span>{t('识别中')}{:else}{t('重新识别')}{/if}
  </button>
</div>

<style>
  .tools { display: flex; align-items: center; gap: 8px; padding: 12px 0 8px; }
  .tools.narrow { flex-direction: column; align-items: stretch; gap: 8px; padding: 12px 0 6px; }
  .search { position: relative; flex: 1; min-width: 180px; display: flex; align-items: center; height: 34px; border-radius: 10px; background: var(--st-field);
    box-shadow: inset 0 0 0 1px var(--st-line); transition: box-shadow var(--mo-micro) var(--ea-fade); cursor: text; }
  .search:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 50%, transparent); }
  .narrow .search { flex: none; min-width: 0; width: auto; height: 44px; border-radius: 13px; background: var(--st-surface); box-shadow: none; }
  .narrow .search:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 40%, transparent); }
  .sic { flex: none; display: grid; place-items: center; width: 34px; color: var(--st-muted); }
  .sic :global(svg) { width: 16px; height: 16px; }
  .narrow .sic { width: 40px; }
  .narrow .sic :global(svg) { width: 18px; height: 18px; }
  .search input { flex: 1; min-width: 0; height: 100%; padding: 0 4px 0 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; outline: none; }
  .search input::placeholder { color: var(--st-muted); }
  .search input::-webkit-search-cancel-button { display: none; }
  .narrow .search input { font-size: 16px; }
  .sx { flex: none; display: grid; place-items: center; width: 28px; height: 28px; margin-right: 3px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade); }
  .sx :global(svg) { width: 14px; height: 14px; }
  @media (hover: hover) { .sx:hover { background: var(--st-hover); color: var(--text); } }
  .sx:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .sx { width: 44px; height: 44px; margin-right: 0; border-radius: 13px; }

  /* 筛选区：厂商下拉在左，「已添加 n」固定在最右——与搜索框同高同圆角 */
  .frow { flex: none; display: flex; align-items: center; gap: 8px; }
  .narrow .frow { flex: none; width: 100%; }
  .fbtn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: 0; border-radius: 10px;
    background: var(--st-seg); color: var(--st-text2); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std), opacity var(--mo-micro) var(--ea-fade); }
  @media (hover: hover) { .fbtn:hover:not(.on):not(:disabled) { background: color-mix(in srgb, var(--text) 11%, transparent); color: var(--text); } }
  .fbtn:active:not(:disabled) { transform: scale(.96); }
  .fbtn.on { background: var(--st-primary); color: var(--st-primary-ink); }
  .fbtn:disabled { opacity: .4; cursor: default; }
  /* 「已添加 n」：描边、不填底——与厂商筛选区分维度；选中才填 */
  .added { font-variant-numeric: tabular-nums; background: transparent; box-shadow: inset 0 0 0 1px var(--st-line); }
  .added.on { background: var(--st-primary); box-shadow: none; }
  .narrow .fbtn { height: 38px; padding: 0 14px; border-radius: 11px; font-size: 13.5px; }
  .narrow .added:not(.on) { background: transparent; }
  /* 窄屏：墨色实心只留给上面的种类胶囊（上一级）和保存；这一级的选中用浅一档底色区分主次 */
  .narrow .fbtn.on { background: color-mix(in srgb, var(--text) 16%, transparent); color: var(--text); }
  .fbtn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px var(--text); }
  .narrow .fbtn:focus-visible { box-shadow: 0 0 0 2px var(--pm-bg), 0 0 0 4px var(--text); }
  @media (pointer: coarse) { .fbtn { position: relative; } .fbtn::after { content: ''; position: absolute; inset: -3px 0; } }

  /* 左内距与列表行一致（宽 14、窄 16）：「全选」的勾选框和下面一列勾选框对齐 */
  .head { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 12px 0 14px; font-size: 12.5px; color: var(--st-muted); }
  .head.narrow { height: 44px; padding: 0 4px 0 16px; }
  .head.narrow .when { display: none; }
  .all, .cnt { white-space: nowrap; flex: none; }
  .all { display: inline-flex; align-items: center; gap: 10px; height: 28px; margin-left: -4px; padding: 0 8px 0 4px; border: 0; border-radius: 8px; background: transparent;
    color: var(--st-text2); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .all:active:not(:disabled) { transform: scale(.96); }
  .narrow .all { height: 44px; font-size: 13.5px; }
  @media (hover: hover) { .all:hover:not(:disabled) { background: var(--st-hover); color: var(--text); } }
  .all:disabled { opacity: .45; cursor: default; }
  .all:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .cnt { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sp { flex: 1; }
  .when { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .tbtn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; margin-right: -8px; border: 0; border-radius: 8px; background: transparent;
    color: var(--text); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .narrow .tbtn { height: 44px; padding: 0 12px; margin-right: 0; font-size: 13.5px; }
  @media (hover: hover) { .tbtn:hover:not(:disabled) { background: var(--st-hover); } }
  .tbtn:active:not(:disabled) { transform: scale(.96); }
  .tbtn:disabled { opacity: .5; cursor: default; }
  /* 连接改过、目录可能是旧的：垫一层底色提醒（不用墨色实心——那是主操作的）。窄屏按钮 44 高是命中区，底色只画中间 32 高 */
  .tbtn.hot { background: var(--st-sel); }
  @media (hover: hover) { .head:not(.narrow) .tbtn.hot:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 13%, transparent); } }
  .narrow .tbtn.hot { position: relative; isolation: isolate; background: transparent; }
  .narrow .tbtn.hot::before { content: ''; position: absolute; inset: 6px 0; z-index: -1; border-radius: 9px; background: var(--st-sel); }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  @media (prefers-reduced-motion: reduce) { .fbtn, .tbtn { transition: none; } .fbtn:active:not(:disabled), .tbtn:active:not(:disabled) { transform: none; } }
</style>
