<script>
  // 策略栏：一排策略签（点一枚 = 查看 / 编辑那一套；生效的那套带「生效中」）+ 末尾的「＋」+ 当前这一套的操作。
  //   · 签多了横向滚动、两端渐隐，选中的那枚自己滚进视野；「＋」钉在滚动区外面，永远点得到。
  //   · 选中态是一块浅底滑块在签之间滑动（同模型中心的种类筛选）；位置按实测的 offsetLeft / offsetWidth。
  //   · 改名就地改：选中的那枚签变成输入框。Enter / 点别处 = 确认，Esc = 取消；空名或没变就当没改。
  //     入口：「重命名」、双击选中的签、F2；新建 / 复制成功后直接进入（父组件给 renameId + renameTick）。
  //   · 生效的那套不能删：「删除」是灰的，点它用一句话说明原因（触屏上看不到 title）。
  //   · 名字的显示一律过 dpLabels.strategyLabel：迁移出来的那一套存的名字是「默认」，界面上跟着语言走（和外壳入口副标题一致）；
  //     name / s.name 都是存下来的原名，比较、回传用原名。改名框里先放的是显示的那个写法（看到什么改什么），原样确认 = 没改。
  //   · busy = 父组件正在新建 / 复制：这期间「＋」和「复制」置灰，点了不理（防连点建出两套）。
  import { tick, untrack } from 'svelte';
  import DpMenu from './DpMenu.svelte';
  import { showToast } from '../../../lib/toast.svelte.js';
  import { reduced } from '../../../lib/motion.js';
  import { t } from '../../../lib/i18n.js';
  import { NAME_MAX, STRATEGY_MAX, clipName } from './dpUtil.js';
  import { strategyLabel } from './dpLabels.js';

  let {
    shell = 'desk', strategies = [], activeId = '', viewId = '', name = '', canEdit = false, busy = false,
    renameId = '', renameTick = 0,
    onview, oncreate, onactivate, onrename, ondelete, onModal = () => {},
  } = $props();

  const isActive = $derived(!!viewId && viewId === activeId);
  const full = $derived(strategies.length >= STRATEGY_MAX);

  // —— 就地改名 ——
  let renamingId = $state('');   // 正在改哪一套的名字（换去看别的一套时自然失效）
  const renaming = $derived(!!viewId && renamingId === viewId);
  let nameIn = $state('');
  let nameFrom = '';     // 改名框里一开始放的那个写法（非响应式）：原样确认不算改名
  let inputEl = $state();
  let committedAt = 0;   // 刚确认过改名的时刻：点「重命名」让输入框失焦确认的那一下，不算再开一次
  function startRename(fromSaved = false) {
    if (!canEdit || renaming || !viewId || performance.now() - committedAt < 300) return;
    // 刚新建的那一套：父组件的草稿可能还没换过来，名字直接取列表里那份
    nameIn = nameFrom = strategyLabel((fromSaved && strategies.find((s) => s.id === viewId)?.name) || name);
    renamingId = viewId;
    tick().then(() => { inputEl?.focus({ preventScroll: true }); inputEl?.select(); });
  }
  function commit(refocus = false) {
    if (!renaming) return;
    renamingId = '';
    committedAt = performance.now();
    const n = clipName(nameIn);
    // 没动过（还是框里一开始的写法——英文界面下「默认」那一套显示成 Default，原样确认不能把它存成 Default）、或和原名一样：都当没改
    if (n && n !== nameFrom && n !== name) onrename?.(n);
    if (refocus) tick().then(() => chipOf(viewId)?.focus({ preventScroll: true }));
  }
  function cancel() {
    if (!renaming) return;
    renamingId = '';
    tick().then(() => chipOf(viewId)?.focus({ preventScroll: true }));
  }
  function inKey(e) {
    e.stopPropagation();   // 输入框里的方向键 / Esc 不交给签的方向键切换与外壳的「返回」
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }
  // 新建 / 复制之后：等新的那一套成了当前这一套，直接进入改名
  let handled = untrack(() => renameTick);
  $effect(() => {
    const k = renameTick;
    if (k === handled || !canEdit || !renameId || viewId !== renameId) return;
    handled = k;
    untrack(() => startRename(true));
  });
  // 换了一套看：改名状态不带过去（也不留到下次切回来）
  $effect(() => { if (renamingId && renamingId !== viewId) renamingId = ''; });

  // —— 签条：滑块、两端渐隐、选中的滚进视野 ——
  let strip = $state(null);
  let tx = $state(0), tw = $state(0);
  let tOn = $state(false);   // 第一次量好之后才开过渡，免得滑块从最左边飞进来
  let fl = $state(0), fr = $state(0);
  const chipOf = (id) => (strip && id ? [...strip.querySelectorAll('[data-id]')].find((el) => el.dataset.id === id) || null : null);
  function measure() {
    const el = chipOf(viewId);
    if (!el) { tw = 0; return; }
    tx = el.offsetLeft;
    tw = el.offsetWidth;
    if (!tOn) requestAnimationFrame(() => requestAnimationFrame(() => { tOn = true; }));
  }
  function edges() {
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    fl = Math.max(0, Math.min(20, strip.scrollLeft));
    fr = Math.max(0, Math.min(20, max - strip.scrollLeft));
  }
  function reveal(smooth) {
    const el = chipOf(viewId);
    if (!el || !strip || strip.scrollWidth <= strip.clientWidth) return;
    const pad = 28;
    const a = el.offsetLeft - pad, b = el.offsetLeft + el.offsetWidth + pad - strip.clientWidth;
    const x = strip.scrollLeft > a ? a : strip.scrollLeft < b ? b : null;
    if (x == null) return;
    strip.scrollTo({ left: Math.max(0, x), behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  }
  $effect(() => {
    viewId; activeId; renaming; name; strategies.map((s) => s.name).join('\n');
    if (!strip) return;
    tick().then(() => { measure(); reveal(tOn); edges(); });
  });
  // 字体晚到、窗口改宽、改名时输入框变宽：都要重量
  $effect(() => {
    const el = strip;
    strategies.length; renaming;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { measure(); edges(); });
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  });
  function onKey(e) {
    if (e.key === 'F2') { e.preventDefault(); startRename(); return; }
    const i = strategies.findIndex((s) => s.id === viewId), n = strategies.length;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j < 0 || j === i || !strategies[j]) return;
    e.preventDefault();
    const id = strategies[j].id;
    Promise.resolve(onview?.(id)).then(() => tick()).then(() => { if (viewId === id) chipOf(id)?.focus({ preventScroll: true }); });
  }

  // —— 新建菜单 ——
  let menu = $state.raw(null);   // { rect }
  $effect(() => { onModal(!!menu); });
  function openAdd(e) {
    if (busy) return;
    if (full) { showToast(t('最多 {n} 套策略', { n: STRATEGY_MAX })); return; }
    menu = { rect: e.currentTarget.getBoundingClientRect() };
  }
  const addItems = $derived([
    { label: t('复制「{name}」', { name: strategyLabel(name) }), onclick: () => oncreate?.('copy') },
    { label: t('从默认线开始'), onclick: () => oncreate?.('blank') },
  ]);
  function copy() {
    if (busy) return;
    if (full) showToast(t('最多 {n} 套策略', { n: STRATEGY_MAX })); else oncreate?.('copy');
  }

  function del() {
    if (isActive) { showToast(t('生效中的策略不能删除，先把别的策略设为生效')); return; }
    ondelete?.();
  }
</script>

<div class="sb" class:desk={shell !== 'ios'} class:ios={shell === 'ios'}>
  <div class="sb-top">
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="sb-strip" bind:this={strip} role="tablist" aria-label={t('策略')}
      style:--fl={fl + 'px'} style:--fr={fr + 'px'} onscroll={edges} onkeydown={onKey}>
      <span class="sb-thumb" class:ready={tw > 0} class:anim={tOn} style:transform={`translateX(${tx}px)`} style:width={tw + 'px'} aria-hidden="true"></span>
      {#each strategies as s (s.id)}
        {@const sel = s.id === viewId}
        {#if sel && renaming}
          <span class="sb-chip sel sb-edit" data-id={s.id}>
            <span class="sb-grow">
              <span class="sb-ghost" aria-hidden="true">{nameIn || ' '}</span>
              <input class="sb-in" bind:this={inputEl} bind:value={nameIn} maxlength={NAME_MAX} autocomplete="off" spellcheck="false" enterkeyhint="done"
                aria-label={t('策略名字')} onkeydown={inKey} onblur={() => commit()} />
            </span>
          </span>
        {:else}
          <button type="button" class="sb-chip" class:sel role="tab" aria-selected={sel} tabindex={sel ? 0 : -1} data-id={s.id}
            title={sel && canEdit ? t('双击改名') : undefined}
            onclick={() => { if (!sel) onview?.(s.id); }} ondblclick={() => { if (sel) startRename(); }}>
            <span class="sb-name">{strategyLabel(sel ? name : s.name)}</span>
            {#if s.id === activeId}<span class="sb-live">{t('生效中')}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
    {#if canEdit}
      <button type="button" class="sb-add" aria-label={t('新建策略')} title={full ? t('最多 {n} 套策略', { n: STRATEGY_MAX }) : t('新建策略')}
        aria-disabled={full || busy} aria-haspopup="menu" aria-expanded={!!menu} onclick={openAdd}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
      </button>
    {/if}
  </div>

  {#if canEdit && viewId}
    <div class="sb-acts" role="group" aria-label={t('当前策略的操作')}>
      {#if !isActive}
        <button type="button" class="dp-btn" onclick={() => onactivate?.()}>{t('设为生效')}</button>
      {/if}
      <button type="button" class="dp-btn ghost" onclick={() => startRename()}>{t('重命名')}</button>
      <button type="button" class="dp-btn ghost" aria-disabled={full || busy} title={full ? t('最多 {n} 套策略', { n: STRATEGY_MAX }) : undefined}
        onclick={copy}>{t('复制')}</button>
      <button type="button" class="dp-btn ghost danger" aria-disabled={isActive}
        title={isActive ? t('生效中的策略不能删除，先把别的策略设为生效') : undefined} onclick={del}>{t('删除')}</button>
    </div>
  {/if}
</div>

{#if menu}<DpMenu at={menu} items={addItems} onClose={() => { menu = null; }} />{/if}

<style>
  /* 一行放得下就「签条 + 加号 | 操作」排一行，放不下操作换到第二行 */
  .sb { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; min-width: 0; }
  .sb-top { flex: 1 1 300px; min-width: 0; display: flex; align-items: center; gap: 6px; }
  .sb-acts { flex: none; max-width: 100%; display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .sb-acts::-webkit-scrollbar { display: none; }
  .ios .sb-acts { gap: 6px; }

  .sb-strip { position: relative; flex: 0 1 auto; min-width: 0; display: flex; gap: 2px; overflow-x: auto; overflow-y: hidden; outline: none;
    scrollbar-width: none; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent 100%); }
  .sb-strip::-webkit-scrollbar { display: none; }

  .sb-chip { position: relative; z-index: 1; flex: none; display: inline-flex; align-items: center; gap: 7px; height: 34px; max-width: 260px; padding: 0 13px; touch-action: manipulation;
    border: 0; border-radius: 999px; background: transparent; color: var(--dp-ink2); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: color var(--mo-base, 280ms) var(--ea-std, ease); }
  .sb-chip.sel { color: var(--dp-ink); cursor: default; }
  .sb-chip:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dp-ink) 40%, transparent); }
  @media (hover: hover) { .sb-chip:not(.sel):hover { color: var(--dp-ink); } }
  .ios .sb-chip { height: 40px; padding: 0 15px; font-size: 15px; }
  .sb-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* 「生效中」：一枚小字签，底色比滑块再深一层（不用彩点） */
  .sb-live { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 11px; font-weight: 500; line-height: 1;
    background: color-mix(in srgb, var(--dp-ink) 9%, transparent); color: var(--dp-ink2); }
  .sb-chip.sel .sb-live { color: var(--dp-ink); }
  .ios .sb-live { height: 20px; font-size: 12px; }

  .sb-thumb { position: absolute; left: 0; top: 0; z-index: 0; height: 34px; border-radius: 999px; background: color-mix(in srgb, var(--dp-ink) 10%, transparent); opacity: 0; pointer-events: none; }
  .sb-thumb.ready { opacity: 1; }
  .sb-thumb.anim { transition: transform var(--mo-base, 280ms) var(--ea-std, ease), width var(--mo-base, 280ms) var(--ea-std, ease); }
  .ios .sb-thumb { height: 40px; }

  /* 改名：签里的字换成输入框；一个看不见的影子字把宽度撑成正好装下内容 */
  .sb-edit { cursor: text; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--dp-ink) 55%, transparent); max-width: min(360px, 100%); }
  .sb-grow { display: inline-grid; min-width: 3em; max-width: 100%; }
  .sb-ghost, .sb-in { grid-area: 1 / 1; min-width: 0; font: inherit; font-weight: 500; letter-spacing: inherit; white-space: pre; }
  .sb-ghost { visibility: hidden; overflow: hidden; }
  .sb-in { width: 100%; padding: 0; margin: 0; border: 0; outline: 0; background: transparent; color: var(--dp-ink); }
  /* 手机上输入框字号不到 16 会被 iOS 自动放大页面：改名时这枚签的字放到 16 */
  .ios .sb-ghost, .ios .sb-in { font-size: 16px; }

  .sb-add { flex: none; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 999px;
    background: transparent; color: var(--dp-ink2); cursor: pointer; box-shadow: inset 0 0 0 1px var(--dp-line2);
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease), transform var(--mo-tap, 90ms) var(--ea-std, ease); }
  .sb-add svg { width: 16px; height: 16px; }
  .sb-add:active:not([aria-disabled="true"]) { transform: scale(.94); }
  .sb-add[aria-disabled="true"] { opacity: .42; cursor: default; }
  .sb-add:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dp-ink) 45%, transparent); }
  @media (hover: hover) { .sb-add:hover:not([aria-disabled="true"]) { background: var(--dp-sunk); color: var(--dp-ink); } }
  .ios .sb-add { width: 40px; height: 40px; }
  .ios .sb-add svg { width: 18px; height: 18px; }

  @media (prefers-reduced-motion: reduce) {
    .sb-thumb.anim, .sb-chip, .sb-add { transition: none; }
    .sb-add:active:not([aria-disabled="true"]) { transform: none; }
  }
</style>
