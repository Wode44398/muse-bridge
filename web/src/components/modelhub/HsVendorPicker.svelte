<script>
  // 模型厂商筛选器：替代横滑胶囊（Windows 鼠标无法横滚，厂商多时看不到后半段）。
  // 宽屏：工具栏触发按钮 → 贴着按钮展开毛玻璃弹层（多厂商时自动双列 + 顶部搜厂商，鼠标滚轮竖向滚动）；
  // 窄屏：底部毛玻璃浮层单列列表，手指好点。选中厂商后按钮上自带一键清除「×」。
  import { tick } from 'svelte';
  import BrandLogo from './BrandLogo.svelte';
  import { G, svg, filterVendors } from './HsKit.js';
  import { portal } from '../claude/dispatch/dpDom.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { t, tr } from '../../lib/i18n.js';

  let { vendors = [], vf = '', allN = 0, onvendor, narrow = false } = $props();

  let open = $state(false);
  let vq = $state('');
  let hi = $state(-1);       // 键盘高亮：-1 = 「全部厂商」，0..n-1 = shown[i]
  let kbd = $state(false);
  let anchorEl = $state();
  let trigEl = $state();
  let popEl = $state();
  let searchEl = $state();
  let listEl = $state();
  let popStyle = $state('');
  let popOrigin = $state('top right');

  const cur = $derived(vf ? vendors.find((v) => v.key === vf) || null : null);
  const showSearch = $derived(vendors.length > 8);
  const multiCol = $derived(!narrow && vendors.length > 6);
  const shown = $derived(filterVendors(vendors, vq, (v) => tr(v.name)));
  const showAll = $derived(!vq.trim());

  function place() {
    if (narrow || !anchorEl || !popEl) return;
    const PAD = 12, GAP = 6;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = anchorEl.getBoundingClientRect();
    const w = Math.min(multiCol ? 428 : 256, vw - PAD * 2);
    const spaceBelow = vh - r.bottom - GAP - PAD;
    const spaceAbove = r.top - GAP - PAD;
    const flipUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxH = Math.max(180, Math.min(460, Math.floor((flipUp ? spaceAbove : spaceBelow) - 4)));
    // 默认与触发按钮右缘对齐，超出视口则收进安全边距
    const left = Math.round(Math.min(Math.max(PAD, r.right - w), Math.max(PAD, vw - PAD - w)));
    if (flipUp) {
      const bottom = Math.round(vh - r.top + GAP);
      popStyle = `left:${left}px;bottom:${bottom}px;width:${w}px;max-height:${maxH}px`;
      popOrigin = 'bottom right';
    } else {
      const top = Math.round(r.bottom + GAP);
      popStyle = `left:${left}px;top:${top}px;width:${w}px;max-height:${maxH}px`;
      popOrigin = 'top right';
    }
  }

  async function openMenu() {
    if (open) { close(true); return; }
    vq = '';
    kbd = false;
    hi = vf ? vendors.findIndex((v) => v.key === vf) : -1;
    open = true;
    await tick();
    place();
    if (!narrow) {
      if (showSearch) searchEl?.focus({ preventScroll: true });
      else {
        const target = popEl?.querySelector('[aria-selected="true"]') || popEl?.querySelector('button[role="option"]');
        target?.focus({ preventScroll: true });
      }
    }
    const sel = listEl?.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function close(refocus = false) {
    if (!open) return;
    open = false;
    vq = '';
    kbd = false;
    if (refocus) tick().then(() => trigEl?.focus({ preventScroll: true }));
  }

  function pick(key) {
    onvendor?.(key);
    close(true);
  }

  function clearPick(e) {
    e.stopPropagation();
    open = false;
    vq = '';
    onvendor?.('');
    tick().then(() => trigEl?.focus({ preventScroll: true }));
  }

  // 系统返回（手机返回键 / 浏览器后退）
  $effect(() => {
    if (!open) return;
    return pushBackLayer(() => close(true));
  });

  // 捕获阶段接 Esc（不穿透到服务浮层）；搜索框有字时先清空搜索，再按一次才关弹层
  $effect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (vq && document.activeElement === searchEl) {
        vq = '';
        hi = -1;
      } else {
        close(true);
      }
    };
    const onResize = () => close(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  });

  function scrollHi(next) {
    tick().then(() => {
      const el = next === -1 ? popEl?.querySelector('.vp-all') : listEl?.querySelector(`[data-vi="${next}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function onPopKey(e) {
    if (e.isComposing) return;
    const inSearch = document.activeElement === searchEl;
    const cols = multiCol ? 2 : 1;
    const n = shown.length;
    const minIdx = showAll ? -1 : 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (!inSearch && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
      if (!n && !showAll) return;
      e.preventDefault();
      kbd = true;
      let next = hi;
      if (e.key === 'ArrowDown') {
        if (next < 0) next = n > 0 ? 0 : -1;
        else next = Math.min(n - 1, next + cols);
      } else if (e.key === 'ArrowUp') {
        if (next < 0) next = minIdx;
        else if (next - cols < 0) next = minIdx;
        else next = next - cols;
      } else if (e.key === 'ArrowRight') {
        if (next < 0) next = n > 0 ? 0 : -1;
        else next = Math.min(n - 1, next + 1);
      } else if (e.key === 'ArrowLeft') {
        if (next <= 0) next = minIdx;
        else next = next - 1;
      }
      hi = next;
      scrollHi(next);
    } else if (e.key === 'Home' && !inSearch) {
      e.preventDefault();
      kbd = true;
      hi = minIdx;
      scrollHi(hi);
    } else if (e.key === 'End' && !inSearch && n > 0) {
      e.preventDefault();
      kbd = true;
      hi = n - 1;
      scrollHi(hi);
    } else if (e.key === 'Enter') {
      // 按钮本身有焦点且未用方向键走位时，交给浏览器默认触发按钮
      if (!inSearch && !kbd && document.activeElement?.matches?.('button')) return;
      e.preventDefault();
      if (hi >= 0 && shown[hi]) pick(shown[hi].key);
      else if (hi === -1 && showAll) pick('');
      else if (shown.length > 0) pick(shown[0].key);
    }
  }

  function onSearchInput() {
    kbd = true;
    hi = vq.trim() ? (shown.length ? 0 : -1) : -1;
  }
</script>

<div class="vp-anchor" class:narrow class:selected={!!cur} class:open bind:this={anchorEl}>
  <button type="button" class="vp-btn" class:on={!!cur} class:open bind:this={trigEl}
    aria-haspopup="dialog" aria-expanded={open} aria-label={t('按模型厂筛选')} title={cur ? tr(cur.name) : t('按模型厂筛选')}
    onclick={openMenu}>
    {#if cur}
      <BrandLogo plain size={narrow ? 15 : 14} logo={cur.logo} name={cur.name} />
      <span class="vp-lbl">{tr(cur.name)}</span>
      <span class="vp-num">{cur.n}</span>
    {:else}
      <span class="vp-lbl">{t('全部厂商')}</span>
      <span class="vp-num">{vendors.length}</span>
    {/if}
    <span class="vp-chev" class:up={open} aria-hidden="true">{@html svg(G.chev, 1.8)}</span>
  </button>
  {#if cur}
    <button type="button" class="vp-clr" aria-label={t('清除厂商筛选')} title={t('清除厂商筛选')} onclick={clearPick}>
      {@html svg(G.clear, 1.8)}
    </button>
  {/if}
</div>

{#if open}
  <div class="vp-layer" class:narrow use:portal>
    <button type="button" class="vp-bg" tabindex="-1" aria-label={t('关闭')} onclick={() => close(true)}></button>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="vp-pop" class:multi={multiCol} role="dialog" aria-label={t('按模型厂筛选')}
      bind:this={popEl} style={narrow ? '' : popStyle} style:transform-origin={narrow ? 'bottom center' : popOrigin}
      onkeydown={onPopKey}>
      {#if narrow}
        <div class="vp-sheet-hd">
          <span class="vp-grab" aria-hidden="true"></span>
          <div class="vp-sheet-bar">
            <span class="vp-sheet-title">{t('按模型厂筛选')}</span>
            <button type="button" class="vp-sheet-x" aria-label={t('关闭')} onclick={() => close(true)}>{@html svg(G.close, 1.8)}</button>
          </div>
        </div>
      {/if}

      {#if showSearch}
        <div class="vp-sbox">
          <label class="vp-search">
            <span class="vp-sic" aria-hidden="true">{@html svg(G.search)}</span>
            <input bind:this={searchEl} bind:value={vq} oninput={onSearchInput} type="search" enterkeyhint="search"
              autocomplete="off" spellcheck="false" autocapitalize="off"
              placeholder={t('搜索厂商')} aria-label={t('搜索厂商')} />
            {#if vq}
              <button type="button" class="vp-sx" aria-label={t('清除搜索')} title={t('清除搜索')}
                onclick={() => { vq = ''; hi = -1; searchEl?.focus(); }}>{@html svg(G.clear, 1.8)}</button>
            {/if}
          </label>
        </div>
      {/if}

      {#if showAll}
        <div class="vp-allwrap">
          <button type="button" class="vp-item vp-all" class:on={!vf} class:act={hi === -1 && kbd}
            role="option" aria-selected={!vf} onclick={() => pick('')}>
            <span class="vp-name">{t('全部厂商')}</span>
            {#if allN > 0}<span class="vp-cnt">{allN}</span>{/if}
            {#if !vf}<span class="vp-ck on" aria-hidden="true">{@html svg(G.check, 2)}</span>{/if}
          </button>
        </div>
      {/if}

      <div class="vp-list" bind:this={listEl} role="listbox" aria-label={t('按模型厂筛选')}>
        {#if shown.length}
          <div class="vp-grid" class:multi={multiCol}>
            {#each shown as v, i (v.key)}
              {@const on = vf === v.key}
              <button type="button" class="vp-item" class:on class:act={hi === i && kbd}
                data-vi={i} role="option" aria-selected={on} title={tr(v.name)}
                onclick={() => pick(v.key)}>
                <BrandLogo plain size={narrow ? 18 : 15} logo={v.logo} name={v.name} />
                <span class="vp-name">{tr(v.name)}</span>
                <span class="vp-cnt">{v.n}</span>
                {#if on}<span class="vp-ck on" aria-hidden="true">{@html svg(G.check, 2)}</span>{/if}
              </button>
            {/each}
          </div>
        {:else}
          <div class="vp-empty">{t('没有匹配的厂商')}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* —— 工具栏里的触发器：与搜索框同高同圆角；选中时带内嵌清除「×」 —— */
  .vp-anchor { position: relative; flex: none; min-width: 0; max-width: 240px; display: inline-flex; align-items: stretch;
    height: 34px; border-radius: 10px; background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line);
    color: var(--st-text2); transition: background-color var(--mo-micro) var(--ea-fade), box-shadow var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade); }
  .vp-anchor.open:not(.selected) { background: var(--st-seg); color: var(--text);
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 42%, transparent); }
  @media (hover: hover) {
    .vp-anchor:not(.selected):not(.open):hover { background: var(--st-seg); color: var(--text); }
  }
  /* 宽屏选中：墨色实心，并把 --text 重映射给内部单色 BrandLogo，防止亮色图标融在象牙底上 */
  .vp-anchor.selected { background: var(--st-primary); box-shadow: none; color: var(--st-primary-ink); --text: var(--st-primary-ink); }
  .vp-anchor.narrow { flex: 1; max-width: none; height: 38px; border-radius: 11px; background: var(--st-surface); box-shadow: none; }
  /* 窄屏选中：实心墨色留给上一级种类胶囊，这一级用浅一档底色区分主次 */
  .vp-anchor.narrow.selected { background: color-mix(in srgb, var(--text) 16%, transparent); color: var(--text); --text: inherit; }

  .vp-btn { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px; padding: 0 9px 0 11px; border: 0; border-radius: 10px;
    background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap) var(--ea-std); }
  .selected .vp-btn { padding-right: 4px; border-radius: 10px 0 0 10px; }
  .narrow .vp-btn { padding: 0 10px 0 12px; font-size: 13.5px; border-radius: 11px; }
  .narrow.selected .vp-btn { padding-right: 4px; border-radius: 11px 0 0 11px; }
  .vp-btn:active { transform: scale(.98); }
  .vp-btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .vp-lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .vp-num { flex: none; font-variant-numeric: tabular-nums; opacity: .58; font-size: 12px; }
  .narrow .vp-num { font-size: 12.5px; }
  .vp-chev { flex: none; display: grid; place-items: center; width: 14px; height: 14px; opacity: .68; margin-left: auto;
    transition: transform var(--mo-quick) var(--ea-std); }
  .vp-chev :global(svg) { width: 14px; height: 14px; }
  .vp-chev.up { transform: rotate(180deg); }

  .vp-clr { position: relative; flex: none; display: grid; place-items: center; width: 28px; padding: 0; border: 0; border-radius: 0 10px 10px 0;
    background: transparent; color: inherit; opacity: .72; cursor: pointer;
    transition: opacity var(--mo-micro) var(--ea-fade), background-color var(--mo-micro) var(--ea-fade); }
  .vp-clr::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 1px;
    background: color-mix(in srgb, currentColor 18%, transparent); pointer-events: none; }
  .narrow .vp-clr { width: 34px; border-radius: 0 11px 11px 0; }
  .narrow .vp-clr::before { top: 9px; bottom: 9px; }
  .vp-clr :global(svg) { width: 14px; height: 14px; }
  @media (hover: hover) { .vp-clr:hover { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); } }
  .vp-clr:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  @media (pointer: coarse) {
    .vp-btn, .vp-clr { position: relative; }
    .vp-btn::after, .vp-clr::after { content: ''; position: absolute; inset: -3px 0; }
  }

  /* —— 弹层（portaled 到 body，自带墨与象牙 + 苹果磨砂玻璃令牌） —— */
  .vp-layer {
    --vp-bg: rgba(31, 30, 27, .88);
    --vp-text: #f1ece2;
    --text: #f1ece2;
    --vp-text2: rgba(241, 236, 226, .76);
    --vp-muted: rgba(241, 236, 226, .48);
    --vp-line: rgba(241, 236, 226, .1);
    --vp-hair: rgba(241, 236, 226, .07);
    --vp-field: rgba(241, 236, 226, .07);
    --vp-hover: rgba(241, 236, 226, .075);
    --vp-sel: rgba(241, 236, 226, .13);
    --vp-shadow: 0 22px 60px rgba(0, 0, 0, .52), 0 0 0 1px rgba(241, 236, 226, .11), inset 0 1px 0 rgba(255, 255, 255, .07);
    --vp-dim: rgba(0, 0, 0, .44);
    position: fixed; inset: 0; z-index: 1000;
    color: var(--vp-text);
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  :global(html[data-theme="light"]) .vp-layer {
    --vp-bg: rgba(252, 251, 248, .88);
    --vp-text: #1d1b18;
    --text: #1d1b18;
    --vp-text2: rgba(29, 27, 24, .74);
    --vp-muted: rgba(29, 27, 24, .48);
    --vp-line: rgba(29, 27, 24, .1);
    --vp-hair: rgba(29, 27, 24, .075);
    --vp-field: rgba(29, 27, 24, .055);
    --vp-hover: rgba(29, 27, 24, .055);
    --vp-sel: rgba(29, 27, 24, .1);
    --vp-shadow: 0 20px 56px rgba(24, 21, 17, .18), 0 0 0 1px rgba(29, 27, 24, .08), inset 0 1px 0 rgba(255, 255, 255, .75);
    --vp-dim: rgba(24, 21, 17, .26);
  }

  .vp-bg { position: fixed; inset: 0; border: 0; padding: 0; background: transparent; cursor: default; }
  .vp-layer.narrow .vp-bg { background: var(--vp-dim); animation: vp-fade var(--mo-quick) var(--ea-fade) both; }

  .vp-pop {
    position: fixed; display: flex; flex-direction: column; box-sizing: border-box;
    border-radius: 16px; background: var(--vp-bg); color: var(--vp-text);
    -webkit-backdrop-filter: blur(26px) saturate(1.45); backdrop-filter: blur(26px) saturate(1.45);
    box-shadow: var(--vp-shadow); overflow: hidden; outline: none;
    animation: vp-pop var(--mo-quick) var(--ea-decel) both;
  }
  @keyframes vp-pop { from { opacity: 0; transform: scale(.96) translateY(-4px); } }
  @keyframes vp-fade { from { opacity: 0; } }
  @keyframes vp-sheet { from { transform: translateY(100%); } }

  .vp-layer.narrow .vp-pop {
    left: 8px; right: 8px; bottom: max(8px, var(--sab, 0px)); top: auto; width: auto;
    max-height: min(72vh, calc(100vh - var(--sat, 0px) - 48px));
    border-radius: 26px;
    animation: vp-sheet var(--mo-base) var(--ea-decel) both;
  }

  .vp-sheet-hd { flex: none; position: relative; padding-top: 12px; }
  .vp-grab { position: absolute; top: 6px; left: 50%; width: 40px; height: 4px; margin-left: -20px; border-radius: 2px; background: var(--vp-line); }
  .vp-sheet-bar { display: flex; align-items: center; justify-content: space-between; padding: 2px 10px 6px 18px; }
  .vp-sheet-title { font-size: 15px; font-weight: 600; color: var(--vp-text); }
  .vp-sheet-x { display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 50%; background: var(--vp-field);
    color: var(--vp-text2); cursor: pointer; }
  .vp-sheet-x :global(svg) { width: 16px; height: 16px; }

  .vp-sbox { flex: none; padding: 10px 10px 6px; }
  .narrow .vp-sbox { padding: 4px 14px 8px; }
  .vp-search { display: flex; align-items: center; height: 32px; border-radius: 9px; background: var(--vp-field);
    box-shadow: inset 0 0 0 1px var(--vp-line); transition: box-shadow var(--mo-micro) var(--ea-fade); cursor: text; }
  .vp-search:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--vp-text) 45%, transparent); }
  .narrow .vp-search { height: 40px; border-radius: 12px; }
  .vp-sic { flex: none; display: grid; place-items: center; width: 32px; color: var(--vp-muted); }
  .vp-sic :global(svg) { width: 14px; height: 14px; }
  .narrow .vp-sic { width: 38px; }
  .narrow .vp-sic :global(svg) { width: 16px; height: 16px; }
  .vp-search input { flex: 1; min-width: 0; height: 100%; padding: 0 4px 0 0; border: 0; background: transparent;
    color: var(--vp-text); font: inherit; font-size: 13px; outline: none; }
  .narrow .vp-search input { font-size: 15px; }
  .vp-search input::placeholder { color: var(--vp-muted); }
  .vp-search input::-webkit-search-cancel-button { display: none; }
  .vp-sx { flex: none; display: grid; place-items: center; width: 26px; height: 26px; margin-right: 3px; border: 0; border-radius: 7px;
    background: transparent; color: var(--vp-muted); cursor: pointer; }
  .vp-sx :global(svg) { width: 13px; height: 13px; }
  @media (hover: hover) { .vp-sx:hover { background: var(--vp-hover); color: var(--vp-text); } }

  .vp-allwrap { flex: none; padding: 6px 6px 5px; border-bottom: 1px solid var(--vp-hair); }
  .vp-sbox + .vp-allwrap { padding-top: 2px; }
  .narrow .vp-allwrap { padding: 4px 10px 6px; }

  .vp-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px; }
  .narrow .vp-list { padding: 6px 10px 14px; }
  .vp-grid { display: flex; flex-direction: column; gap: 2px; }
  .vp-grid.multi { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; }

  .vp-item { width: 100%; min-width: 0; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 0; border-radius: 9px;
    background: transparent; color: var(--vp-text2); font: inherit; font-size: 13px; font-weight: 450; text-align: left; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade); }
  .narrow .vp-item { height: 44px; padding: 0 12px; border-radius: 12px; font-size: 15px; gap: 10px; }
  @media (hover: hover) { .vp-item:hover { background: var(--vp-hover); color: var(--vp-text); } }
  .vp-item:active { background: var(--vp-sel); }
  .vp-item.act { background: var(--vp-hover); color: var(--vp-text); }
  .vp-item.on { background: var(--vp-sel); color: var(--vp-text); font-weight: 550; }
  .vp-item:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px var(--vp-text); }

  .vp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vp-cnt { flex: none; font-size: 12px; color: var(--vp-muted); font-variant-numeric: tabular-nums; }
  .narrow .vp-cnt { font-size: 13px; }
  .vp-item.on .vp-cnt { color: var(--vp-text2); }
  .vp-ck { flex: none; display: grid; place-items: center; width: 14px; height: 14px; color: var(--vp-text); visibility: hidden; }
  .vp-ck.on { visibility: visible; }
  .vp-ck :global(svg) { width: 14px; height: 14px; }

  .vp-empty { padding: 24px 12px; text-align: center; font-size: 13px; color: var(--vp-muted); }

  @media (prefers-reduced-motion: reduce) {
    .vp-pop, .vp-layer.narrow .vp-bg, .vp-layer.narrow .vp-pop { animation: none; }
    .vp-btn, .vp-chev { transition: none; }
    .vp-btn:active { transform: none; }
  }
</style>
