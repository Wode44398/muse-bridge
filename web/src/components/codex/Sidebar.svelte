<script>
  // 侧栏：只放线程（杂项在窄栏）。头部是 Codex 字样、搜索（放大镜原地展开成搜索框，Ctrl+K，Esc 收起）、收起侧栏；
  // 下面一行「新线程」；再往下按项目分组：项目行写名字和当前分支，悬停（触屏上常显）露出「在这个项目里开新线程」，
  // 点这一行本身是展开 / 收起（记在本机）。选中的线程只换一块底色，换线程时这块底色滑过去。
  // 线程的项目认不出来（被删了、别的号建的）就按它自带的项目名归一组。手机上整块在抽屉里，打开线程时抽屉收起。
  import { onMount, tick, untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { ui } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { codex, newThread, openThread, refreshSessions } from '../../lib/codex/store.svelte.js';
  import { closePop } from '../../lib/codex/ui.svelte.js';
  import { groupSessions, matches, parseFolded, toggleFolded } from '../../lib/codex/chrome/logic.js';
  import { startClock } from '../../lib/codex/chrome/clock.svelte.js';
  import { heroRef } from '../../lib/codex/chrome/hero.js';
  import Icon from './Icon.svelte';
  import LottieIcon from './LottieIcon.svelte';
  import ThreadRow from './ThreadRow.svelte';

  let { onAddProject = null } = $props();

  const FOLD_KEY = 'bridge-codex-folded';
  let folded = $state(parseFolded((() => { try { return localStorage.getItem(FOLD_KEY); } catch { return ''; } })()));
  let qEl = $state(null);
  let scrollEl = $state(null);
  let listEl = $state(null);
  let selEl = $state(null);
  let retrying = $state(false);
  // 首屏的列表不演「长出来」：列表到手、画过一帧以后新出现的行才演
  let grown = $state(false);

  const q = $derived(codex.searching ? codex.search.trim() : '');
  const groups = $derived(groupSessions(codex.projects, codex.sessions).map((g) => {
    const hits = new Set(g.sessions.filter((s) => matches(s, g.name, q)).map((s) => s.id));
    return { ...g, hits };
  }));
  const anyHit = $derived(!q || groups.some((g) => g.hits.size > 0));

  function saveFolded() {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folded)); } catch {}
  }
  function toggle(key) {
    folded = toggleFolded(folded, key);
    saveFolded();
    setTimeout(() => moveSel(false), 330);
  }
  function rowKey(e, key) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); }
  }

  function fresh() {
    closePop();
    codex.drawer = false;
    newThread();
  }
  function newIn(e, id) {
    e.stopPropagation();
    closePop();
    const nod = !codex.sessionId && codex.projectId === id;
    codex.drawer = false;
    newThread({ projectId: id });
    // 已经在这个项目的首页：项目没变，Home 不会自己点头，这里补一下
    if (nod) tick().then(() => heroRef.nod?.());
  }

  /* ---------- 搜索 ---------- */
  function openSearch() {
    if (!layout.side && !codex.drawer) codex.drawer = true;
    if (layout.side && !codex.sideOpen) codex.sideOpen = true;
    codex.searching = true;
    setTimeout(() => qEl?.focus({ preventScroll: true }), 80);
  }
  function closeSearch() {
    if (!codex.searching) return;
    codex.searching = false;
    codex.search = '';
    qEl?.blur();
  }
  function onQKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); return; }
    if (e.key === 'Enter' && !e.isComposing) {
      const g = groups.find((x) => x.hits.size);
      const s = g?.sessions.find((x) => g.hits.has(x.id));
      if (s) { e.preventDefault(); codex.drawer = false; openThread(s.id); closeSearch(); }
    }
  }
  function onQBlur() {
    setTimeout(() => { if (!codex.search && document.activeElement !== qEl) closeSearch(); }, 160);
  }
  function onKey(e) {
    if (ui.screen !== 'chatgpt' || ui.settingsOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); closePop(); openSearch(); }
  }

  async function retry() {
    retrying = true;
    try { await refreshSessions(); } finally { retrying = false; }
  }

  /* ---------- 选中底块 ---------- */
  let selShown = false;
  function moveSel(instant) {
    const bg = selEl, sc = scrollEl;
    if (!bg || !sc) return;
    const id = codex.view === 'threads' ? codex.sessionId : '';
    const row = id ? [...sc.querySelectorAll('.th-row')].find((r) => r.dataset.thread === id) : null;
    if (!row || row.classList.contains('miss') || row.closest('.proj.miss') || row.closest('.proj[data-open="false"]')) {
      bg.style.opacity = '0';
      selShown = false;
      return;
    }
    const top = row.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    // 从藏着到出现：原地出现再淡入，不从上一次的位置滑过来
    const jump = instant || !selShown;
    if (jump) bg.style.transition = 'none';
    bg.style.transform = `translateY(${top}px)`;
    bg.style.height = Math.max(32, row.offsetHeight) + 'px';
    if (jump) { void bg.offsetHeight; bg.style.transition = ''; }
    bg.style.opacity = '1';
    selShown = true;
  }
  $effect(() => {
    void codex.sessionId; void codex.view; void q; void folded; void groups; void codex.sideOpen; void codex.drawer;
    const id = requestAnimationFrame(() => moveSel(false));
    return () => cancelAnimationFrame(id);
  });

  $effect(() => {
    if (!codex.booted || untrack(() => grown)) return;
    const id = requestAnimationFrame(() => { grown = true; });
    return () => cancelAnimationFrame(id);
  });

  onMount(() => {
    startClock();
    // 行增删、长出来、窄宽变化：位置跟着走（不滑，免得追着动画跑）
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => moveSel(true)); });
    if (listEl) ro.observe(listEl);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  });
</script>

<svelte:window onkeydown={onKey} />

<aside class="cx-side" aria-label={t('线程')}>
  <div class="sd-head" class:searching={codex.searching}>
    <b class="sd-title">Codex</b>
    <label class="sd-search">
      <Icon name="search" />
      <input bind:this={qEl} bind:value={codex.search} placeholder={t('搜索线程')} autocomplete="off" spellcheck="false"
        tabindex={codex.searching ? 0 : -1} aria-label={t('搜索线程')} onkeydown={onQKey} onblur={onQBlur} />
      <kbd>Esc</kbd>
    </label>
    <span class="grow"></span>
    <button class="ibtn" title={t('搜索线程（Ctrl+K）')} aria-label={t('搜索线程')} onclick={openSearch}><Icon name="search" /></button>
    <button class="ibtn sd-fold" title={t('收起侧栏（Ctrl+B）')} aria-label={t('收起侧栏')} onclick={() => { codex.sideOpen = false; }}><Icon name="side" /></button>
  </div>
  <div class="sd-new">
    <button class="nav-row" onclick={fresh}>
      <LottieIcon name="sidebar-new-chat" icon="compose" />
      <span class="lbl">{t('新线程')}</span><kbd>Ctrl N</kbd>
    </button>
  </div>
  <div class="side-scroll" bind:this={scrollEl}>
    <div class="sel-bg" bind:this={selEl}></div>
    <div bind:this={listEl}>
      <div class="sec-head">
        <span class="lbl">{t('项目')}</span>
        <button class="ibtn sm" title={t('添加项目')} aria-label={t('添加项目')} onclick={() => { closePop(); onAddProject?.(); }}><Icon name="plus" /></button>
      </div>
      {#if codex.listError}
        <div class="sd-err" role="alert">
          <Icon name="warn" />
          <span>{codex.listError}</span>
          <button class="tbtn" disabled={retrying} onclick={retry}>{t('重试')}</button>
        </div>
      {/if}
      {#each groups as g (g.key)}
        {@const open = q ? true : !folded.includes(g.key)}
        {@const name = g.name || t('其它')}
        <div class="proj" class:miss={!!q && g.hits.size === 0} data-open={open ? 'true' : 'false'}>
          <div class="proj-row" role="button" tabindex="0" aria-expanded={open} onclick={() => toggle(g.key)} onkeydown={(e) => rowKey(e, g.key)}>
            <LottieIcon name="sidebar-projects" icon="folder" trigger=".proj-row" />
            <span class="proj-name">{name}</span>
            <span class="proj-branch">{g.branch}</span>
            {#if g.known}
              <span class="proj-acts">
                <button class="ibtn sm" title={t('在 {name} 里开新线程', { name })} aria-label={t('在 {name} 里开新线程', { name })} onclick={(e) => newIn(e, g.id)}><Icon name="compose" /></button>
              </span>
            {/if}
          </div>
          <div class="threads"><div>
            {#each g.sessions as s (s.id)}
              <ThreadRow session={s} {q} miss={!!q && !g.hits.has(s.id)} active={codex.view === 'threads' && codex.sessionId === s.id} grow={grown} />
            {/each}
          </div></div>
        </div>
      {/each}
      {#if q && !anyHit}
        <div class="sd-empty">{t('没有找到相关线程')}</div>
      {:else if codex.booted && !codex.listError && !groups.length}
        <div class="sd-empty">{t('添加一个项目，Codex 就能在里面开工')}</div>
      {/if}
    </div>
  </div>
</aside>

<style>
  .sd-err { display: flex; align-items: center; gap: 8px; margin: 6px 2px 4px; padding: 8px 6px 8px 10px; border-radius: 10px; background: var(--fill2); color: var(--fg2); font-size: 12.5px; line-height: 1.4; }
  .sd-err :global(svg) { width: 15px; height: 15px; color: var(--warn); flex: none; }
  .sd-err span { flex: 1; min-width: 0; }
  .sd-err .tbtn { flex: none; }
  /* 宽屏的触屏设备（平板）没有悬停：「在这个项目里开新线程」一直露着 */
  @media (hover: none) { :global(.cx) .proj-acts { opacity: 1; transform: none; } }
</style>
