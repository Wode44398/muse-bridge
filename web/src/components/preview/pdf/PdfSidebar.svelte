<script>
  // PDF 左侧导航（Acrobat / Chrome PDF 的侧栏）：「缩略图」「书签」两页（Word 转出来的叫「页面」「标题」，整栏叫「导航」）。
  //   电脑：舞台左边 232 宽的一栏，宽窗里推开内容（文档流），窄窗（< 760）里盖在内容上、选完自动收起；
  //         书签是可折叠的树，当前所在章节高亮（只高亮看得见的那一级：子节点收着时亮它的父节点）。
  //   触屏：ios27 表单页（Sheet）：上面分段切换，缩略图三列网格 / 书签 44 高的列表，点了跳过去并收起。
  // props
  //   open · touch · overlay（电脑窄窗盖在上面）· title · tab（可绑定 'thumbs' | 'outline'）
  //   count · current · onpick(n) · aspect(n) · thumbs（PdfThumbs）· night · thumbSize
  //   outline（loadOutline 的 items）· activeId · ongo(item) · labels { thumbs, outline } · onclose()
  //   only：'outline' = 只有标题树、没有缩略图页（Word 客户端回落的「导航」）
  //   thumb：Snippet(n) 自定义缩略图格子（PPT 客户端回落直接画缩小的幻灯片）；thumbs 仍可传 { urls, want, unwant } 报可见性
  import { getContext, untrack } from 'svelte';
  import Sheet from '../../ios27/Sheet.svelte';
  import Segmented from '../../ios27/Segmented.svelte';
  import ThumbStrip from '../paged/ThumbStrip.svelte';
  import VIcon from '../kit/VIcon.svelte';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { t } from '../../../lib/i18n.js';

  let {
    open = false, touch = false, overlay = false, title = '', tab = $bindable('thumbs'),
    count = 0, current = 1, onpick, aspect = () => 0.75, thumbs = null, night = false, thumbSize = 120,
    outline = [], activeId = -1, ongo, labels = null, onclose, only = '', thumb = null,
  } = $props();

  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
  const hasOutline = $derived(outline.length > 0);
  const outlineOnly = $derived(only === 'outline');
  const showTabs = $derived(hasOutline && !outlineOnly);
  const showTree = $derived(hasOutline && (outlineOnly || tab === 'outline'));
  const L = $derived({ thumbs: labels?.thumbs || t('缩略图'), outline: labels?.outline || t('书签') });
  $effect(() => { if (!hasOutline && tab === 'outline') untrack(() => { tab = 'thumbs'; }); });

  // —— 书签树：展开集合。条目少（≤ 40）全展开，多了只露顶层 ——
  let expanded = $state(new Set());
  let seeded = null;
  $effect(() => {
    const list = outline;
    if (list === seeded) return;
    untrack(() => {
      // 同一份书签解析完页码后会整体换一次数组（条目不变），不重置用户折叠过的状态
      const same = seeded && seeded.length === list.length && seeded.every((it, i) => it.title === list[i].title && it.depth === list[i].depth);
      seeded = list;
      if (same) return;
      expanded = new Set(list.length <= 40 ? list.filter((it) => it.kids).map((it) => it.id) : []);
    });
  });
  function toggle(id) {
    const s = new Set(expanded);
    if (s.has(id)) s.delete(id); else s.add(id);
    expanded = s;
  }
  const visible = $derived.by(() => {
    const out = [];
    const shownParent = new Map();   // id → 是否可见
    for (const it of outline) {
      const ok = it.parent < 0 || (shownParent.get(it.parent) && expanded.has(it.parent));
      shownParent.set(it.id, ok);
      if (ok) out.push(it);
    }
    return out;
  });
  // 高亮：当前章节往上找第一个看得见的祖先
  const lit = $derived.by(() => {
    if (activeId < 0) return -1;
    const vis = new Set(visible.map((it) => it.id));
    let id = activeId;
    while (id >= 0 && !vis.has(id)) id = outline[id]?.parent ?? -1;
    return id;
  });

  let tree = $state(null);
  // 当前章节滚进视口（只滚书签栏自己）
  $effect(() => {
    const id = lit, el = tree;
    if (!el || id < 0 || tab !== 'outline') return;
    untrack(() => requestAnimationFrame(() => {
      const row = el.querySelector(`[data-oid="${id}"]`);
      const sc = el.closest('.sh-body') || el;
      if (!row || !sc) return;
      const sr = sc.getBoundingClientRect(), r = row.getBoundingClientRect();
      if (r.top < sr.top + 4) sc.scrollTop += r.top - sr.top - 4;
      else if (r.bottom > sr.bottom - 4) sc.scrollTop += r.bottom - sr.bottom + 4;
    }));
  });

  function treeKey(e) {
    const row = document.activeElement?.closest?.('[data-oid]');
    if (!row || !tree?.contains(row)) return;
    const id = +row.dataset.oid;
    const it = outline[id];
    const i = visible.findIndex((v) => v.id === id);
    const focusAt = (j) => tree.querySelector(`[data-oid="${visible[Math.max(0, Math.min(visible.length - 1, j))]?.id}"] .po-t`)?.focus();
    if (e.key === 'ArrowDown') focusAt(i + 1);
    else if (e.key === 'ArrowUp') focusAt(i - 1);
    else if (e.key === 'ArrowRight' && it?.kids) { if (!expanded.has(id)) toggle(id); else focusAt(i + 1); }
    else if (e.key === 'ArrowLeft') {
      if (it?.kids && expanded.has(id)) toggle(id);
      else if (it && it.parent >= 0) tree.querySelector(`[data-oid="${it.parent}"] .po-t`)?.focus();
    } else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(visible.length - 1);
    else return;
    e.preventDefault(); e.stopPropagation();
  }

  function pick(n) { onpick?.(n); if (touch || overlay) onclose?.(); }
  function go(it) { ongo?.(it); if (touch || overlay) onclose?.(); }

  // 盖在上面的那几种（触屏 Sheet、电脑窄窗）系统返回先关它
  $effect(() => { if (open && (touch || overlay)) return pushBackLayer(() => onclose?.()); });

  let sheetBody = $state(null);
</script>

{#snippet outlineTree(rowH)}
  <div class="po" class:touch bind:this={tree} role="tree" aria-label={L.outline} onkeydown={treeKey} tabindex="-1" style:--po-h="{rowH}px">
    {#each visible as it (it.id)}
      <div class="po-row" class:on={it.id === lit} data-oid={it.id} role="treeitem" aria-selected={it.id === lit}
        aria-expanded={it.kids ? expanded.has(it.id) : undefined} aria-level={it.depth + 1} style:--po-d={it.depth}>
        {#if it.kids}
          <button type="button" class="po-tw" class:open={expanded.has(it.id)} tabindex="-1" aria-label={expanded.has(it.id) ? t('收起') : t('展开')} onclick={() => toggle(it.id)}>
            <VIcon name="chev" size={14} />
          </button>
        {:else}<span class="po-tw po-sp" aria-hidden="true"></span>{/if}
        <button type="button" class="po-t" class:b={it.bold} class:i={it.italic} tabindex={it.id === lit || (lit < 0 && it === visible[0]) ? 0 : -1}
          title={it.title} onclick={() => go(it)}>
          <span class="po-tx">{it.title || t('（无标题）')}</span>
          {#if it.page}<span class="po-pg">{it.page}</span>{/if}
        </button>
      </div>
    {/each}
  </div>
{/snippet}

{#if open}
  {#if touch}
    <div class="i27ink" class:dark>
      <Sheet title={title || L.thumbs} onclose={() => onclose?.()} closeLabel={t('关闭')}>
        <div class="ps-sheet" bind:this={sheetBody}>
          {#if showTabs}
            <div class="ps-seg">
              <Segmented value={tab} label={title} onchange={(v) => (tab = v)}
                options={[{ value: 'thumbs', label: L.thumbs }, { value: 'outline', label: L.outline }]} />
            </div>
          {/if}
          {#if showTree}
            {@render outlineTree(44)}
          {:else if outlineOnly}
            <p class="ps-empty">{t('没有标题')}</p>
          {:else}
            <ThumbStrip layout="grid" {count} {current} onpick={pick} {aspect} {night} {thumb}
              src={(n) => thumbs?.urls.get(n) || ''} want={(n) => thumbs?.want(n)} unwant={(n) => thumbs?.unwant(n)} />
          {/if}
        </div>
      </Sheet>
    </div>
  {:else}
    <aside class="ps" class:overlay aria-label={title || L.thumbs}>
      <div class="ps-head">
        {#if showTabs}
          <div class="ps-tabs" role="tablist">
            <button type="button" role="tab" class="ps-tab" class:on={tab === 'thumbs'} aria-selected={tab === 'thumbs'} onclick={() => (tab = 'thumbs')}>{L.thumbs}</button>
            <button type="button" role="tab" class="ps-tab" class:on={tab === 'outline'} aria-selected={tab === 'outline'} onclick={() => (tab = 'outline')}>{L.outline}</button>
          </div>
        {:else}
          <span class="ps-title">{title || L.thumbs}</span>
        {/if}
      </div>
      <div class="ps-body">
        {#if showTree}
          <div class="ps-scroll">{@render outlineTree(30)}</div>
        {:else if outlineOnly}
          <p class="ps-empty">{t('没有标题')}</p>
        {:else}
          <ThumbStrip layout="column" size={thumbSize} {count} {current} onpick={pick} {aspect} {night} {thumb}
            src={(n) => thumbs?.urls.get(n) || ''} want={(n) => thumbs?.want(n)} unwant={(n) => thumbs?.unwant(n)} />
        {/if}
      </div>
    </aside>
    {#if overlay}<button type="button" class="ps-scrim" tabindex="-1" aria-label={t('关闭')} onclick={() => onclose?.()}></button>{/if}
  {/if}
{/if}

<style>
  /* —— 电脑侧栏 —— */
  .ps { position: relative; z-index: 3; flex: none; width: 232px; height: 100%; display: flex; flex-direction: column; box-sizing: border-box;
    background: var(--md-bg); box-shadow: inset -.5px 0 0 rgba(var(--md-ink), .12); color: var(--md-fg);
    animation: ps-in var(--mo-quick) var(--ea-decel) both; }
  @keyframes ps-in { from { opacity: 0; transform: translateX(-8px); } }
  @media (prefers-reduced-motion: reduce) { .ps { animation: none; } }
  .ps.overlay { position: absolute; left: 0; top: 0; bottom: 0; z-index: 7; box-shadow: 0 0 0 .5px rgba(var(--md-ink), .14), 8px 0 28px rgba(0, 0, 0, .18); }
  .ps-scrim { position: absolute; inset: 0; z-index: 6; border: 0; padding: 0; margin: 0; background: rgba(0, 0, 0, .12); cursor: default; animation: ps-fade var(--mo-quick) var(--ea-fade) both; }
  @keyframes ps-fade { from { opacity: 0; } }
  .ps-head { flex: none; height: 40px; display: flex; align-items: center; padding: 0 10px; box-sizing: border-box; }
  .ps-title { font-size: 12.5px; font-weight: 600; color: var(--md-fg-2); padding: 0 4px; }
  .ps-tabs { display: flex; gap: 2px; }
  .ps-tab { height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--md-fg-3); font: inherit; font-size: 12.5px; cursor: pointer; }
  .ps-tab:hover { color: var(--md-fg); }
  .ps-tab.on { color: var(--md-fg); font-weight: 600; background: rgba(var(--md-ink), .07); }
  .ps-tab:focus-visible { outline: 2px solid var(--md-fg-3); outline-offset: -2px; }
  .ps-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .ps-empty { margin: 0; padding: 12px 14px; font-size: 12.5px; color: var(--md-fg-3); }
  .ps-sheet .ps-empty { padding: 20px 16px; font-size: 15px; text-align: center; }
  .ps-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 6px 24px; scrollbar-width: thin; }

  /* —— 书签树 —— */
  .po { outline: none; }
  .po-row { display: flex; align-items: center; min-height: var(--po-h); padding-left: calc(var(--po-d) * 14px); border-radius: 6px; }
  .po-row.on { background: rgba(var(--md-ink), .08); }
  .po-tw { flex: none; width: 20px; height: 24px; display: flex; align-items: center; justify-content: center; padding: 0; border: 0; background: none;
    color: var(--md-fg-3); cursor: pointer; border-radius: 4px; }
  .po-tw :global(svg) { transition: transform var(--mo-micro) var(--ea-out); }
  .po-tw.open :global(svg) { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .po-tw :global(svg) { transition: none; } }
  .po-tw:hover { color: var(--md-fg); }
  .po-sp { cursor: default; }
  .po-t { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; min-height: var(--po-h); padding: 5px 6px 5px 2px; border: 0; background: none;
    color: var(--md-fg-2); font: inherit; font-size: 13px; line-height: 18px; text-align: left; cursor: pointer; border-radius: 6px; box-sizing: border-box; }
  .po-t:hover { color: var(--md-fg); }
  .po-t:focus-visible { outline: 2px solid var(--md-fg-3); outline-offset: -2px; }
  .po-row.on .po-t { color: var(--md-fg); font-weight: 600; }
  .po-t.b { font-weight: 600; }
  .po-t.i .po-tx { font-style: italic; }
  .po-tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .po-pg { flex: none; font-size: 11.5px; color: var(--md-fg-4); font-variant-numeric: tabular-nums; font-weight: 400; }

  /* —— 触屏 Sheet 里 —— */
  .ps-sheet { color: var(--i-label); }
  .ps-seg { padding: 2px 0 14px; }
  .po.touch .po-row { padding-left: calc(var(--po-d) * 16px); border-radius: 10px; }
  .po.touch .po-row.on { background: var(--i-fill3, rgba(120, 120, 128, .14)); }
  .po.touch .po-tw { width: 44px; height: 44px; color: var(--i-label3, inherit); }
  .po.touch .po-t { font-size: 16px; line-height: 21px; padding: 11px 10px 11px 2px; color: var(--i-label); }
  .po.touch .po-pg { font-size: 13px; color: var(--i-label3, inherit); }
  .ps-sheet :global(.ts-grid) { --md-accent: var(--i-label); }
  .ps-sheet :global(.ts-no) { color: var(--i-label2, inherit); }
</style>
