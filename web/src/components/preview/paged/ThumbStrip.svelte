<script>
  // 页面缩略图列表（PDF 侧栏、触屏页面网格、幻灯片缩略图条、PPT 回落共用）。
  //   layout：'column' 竖列（电脑侧栏）| 'row' 横条（幻灯片底部）| 'grid' 网格（触屏 Sheet 里三列）
  //   只把进了视口（再往外多半屏）的格子报给 want(n)，滚出去 unwant(n)：缩略图按需画，300 页也只画眼前那几张。
  //   当前页描一圈强调色、页码加粗；当前页变了且不在视口里就把它滚进来（只滚自己，不连带外层）。
  // props
  //   count · current（1 起）· onpick(n)
  //   aspect(n) → 宽/高（占位按它撑开，图片来了不跳）· src(n) → 图片地址或空
  //   want(n) / unwant(n) · size：column/grid 是格宽（grid 缺省铺满一列）、row 是格高
  //   root：滚动根（grid 放在 Sheet 里时传 Sheet 的滚动区；缺省 column/row 用自己）
  //   thumb：Snippet(n) 自定义格子内容（PPT 回落直接画缩小的幻灯片，不走图片）
  //   label(n)：格子下方的字（缺省页码）· night：图片也反色（深色页面）
  import { untrack } from 'svelte';
  import { t } from '../../../lib/i18n.js';

  let {
    count = 0, current = 1, onpick, aspect = () => 0.75, src = () => '',
    want = () => {}, unwant = () => {}, layout = 'column', size = 0, root = null,
    thumb = null, label = (n) => String(n), night = false,
  } = $props();

  let box = $state(null);
  const nums = $derived(Array.from({ length: count }, (_, i) => i + 1));

  // —— 可见性：IntersectionObserver，根是自己（或传进来的滚动区）——
  let io = null;
  const seen = new Set();
  $effect(() => {
    const el = box;
    if (!el) return;
    const r = root || (layout === 'grid' ? null : el);
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = +e.target.dataset.n;
        if (e.isIntersecting) { if (!seen.has(n)) { seen.add(n); want(n); } }
        else if (seen.has(n)) { seen.delete(n); unwant(n); }
      }
    }, { root: r, rootMargin: layout === 'row' ? '0px 50%' : '50% 0px' });
    for (const c of el.querySelectorAll('[data-n]')) io.observe(c);
    return () => { io?.disconnect(); io = null; for (const n of seen) unwant(n); seen.clear(); };
  });
  function cell(node) {
    io?.observe(node);
    return { destroy() { io?.unobserve(node); } };
  }

  // —— 当前页滚进视口（只动自己的滚动，不用 scrollIntoView：它会连带外层容器一起滚）——
  $effect(() => {
    const n = current, el = box;
    if (!el || !n) return;
    untrack(() => requestAnimationFrame(() => reveal(n)));
  });
  function reveal(n) {
    const el = box;
    const c = el?.querySelector(`[data-n="${n}"]`);
    if (!c) return;
    const sc = root || (layout === 'grid' ? el.closest('.sh-body') : el);
    if (!sc) return;
    const sr = sc.getBoundingClientRect(), r = c.getBoundingClientRect();
    if (layout === 'row') {
      if (r.left < sr.left + 8) sc.scrollLeft += r.left - sr.left - 8;
      else if (r.right > sr.right - 8) sc.scrollLeft += r.right - sr.right + 8;
    } else {
      if (r.top < sr.top + 8) sc.scrollTop += r.top - sr.top - 8;
      else if (r.bottom > sr.bottom - 8) sc.scrollTop += r.bottom - sr.bottom + 8;
    }
  }

  function keydown(e) {
    // 方向键在格子之间挪焦点（竖列 ↑↓、横条 ←→、网格四向按三列）
    const cur = document.activeElement?.closest?.('[data-n]');
    if (!cur || !box?.contains(cur)) return;
    const n = +cur.dataset.n;
    const cols = layout === 'grid' ? 3 : 1;
    const map = layout === 'row'
      ? { ArrowLeft: -1, ArrowRight: 1 }
      : { ArrowUp: -cols, ArrowDown: cols, ...(layout === 'grid' ? { ArrowLeft: -1, ArrowRight: 1 } : {}) };
    let d = map[e.key];
    if (e.key === 'Home') d = 1 - n;
    if (e.key === 'End') d = count - n;
    if (d == null) return;
    e.preventDefault(); e.stopPropagation();
    const to = Math.max(1, Math.min(count, n + d));
    box.querySelector(`[data-n="${to}"]`)?.focus();
    reveal(to);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="ts ts-{layout}" class:night bind:this={box} style:--ts-size={size ? size + 'px' : null} role="group" aria-label={t('页面缩略图')} onkeydown={keydown}>
  {#each nums as n (n)}
    {@const a = aspect(n) || 0.75}
    {@const u = thumb ? '' : src(n)}
    <button type="button" class="ts-it" class:on={n === current} data-n={n} use:cell
      aria-current={n === current ? 'page' : undefined} aria-label={t('第 {n} 页', { n })} tabindex={n === current ? 0 : -1}
      onclick={() => onpick?.(n)}>
      <span class="ts-pic" style:aspect-ratio={a}>
        {#if thumb}{@render thumb(n)}
        {:else if u}<img src={u} alt="" draggable="false" decoding="async" />{/if}
      </span>
      {#if layout !== 'row'}<span class="ts-no">{label(n)}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .ts { box-sizing: border-box; outline: none; }
  .ts-column { height: 100%; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 14px 12px 24px; scrollbar-width: thin; }
  .ts-row { width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior: contain; display: flex; align-items: center; gap: 8px; padding: 6px 10px; scrollbar-width: none; }
  .ts-row::-webkit-scrollbar { display: none; }
  .ts-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 12px; padding: 4px 2px 8px; }

  .ts-it { position: relative; flex: none; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0; border: 0; background: none;
    color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; outline: none; }
  .ts-column .ts-it { width: var(--ts-size, 120px); }
  .ts-grid .ts-it { width: 100%; }
  .ts-row .ts-it { height: var(--ts-size, 56px); }
  .ts-pic { position: relative; display: block; overflow: hidden; border-radius: 3px; background: #fff;
    box-shadow: 0 0 0 1px rgba(var(--md-ink), .1), 0 1px 4px rgba(0, 0, 0, .12);
    transition: box-shadow var(--mo-micro) var(--ea-out); }
  .ts-column .ts-pic, .ts-grid .ts-pic { width: 100%; }
  .ts-row .ts-pic { height: 100%; }
  /* 暗主题：还没画出来的占位不先闪一块白 */
  :global(html:not([data-theme="light"])) .ts-pic:not(:has(:global(img), :global(.ts-own))) { background: #3a3a37; }
  .ts-pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; animation: ts-in var(--mo-quick) var(--ea-fade) both; }
  @keyframes ts-in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .ts-pic img { animation: none; } }
  :global(html:not([data-theme="light"])) .ts.night .ts-pic img { filter: invert(.88) hue-rotate(180deg); }
  .ts-no { font-size: 12px; line-height: 14px; color: var(--vw-fg-3, var(--md-fg-3)); font-variant-numeric: tabular-nums; }
  :global(.vw-touch) .ts-no { font-size: 13px; }

  @media (hover: hover) { .ts-it:hover .ts-pic { box-shadow: 0 0 0 1px rgba(var(--md-ink), .28), 0 1px 4px rgba(0, 0, 0, .14); } }
  .ts-it.on .ts-pic { box-shadow: 0 0 0 2px var(--md-accent), 0 1px 4px rgba(0, 0, 0, .14); }
  .ts-it.on .ts-no { color: var(--md-fg); font-weight: 600; }
  .ts-it:focus-visible .ts-pic { box-shadow: 0 0 0 2px var(--md-fg-3); }
  .ts-it.on:focus-visible .ts-pic { box-shadow: 0 0 0 2px var(--md-accent), 0 0 0 4px rgba(var(--md-ink), .18); }
</style>
