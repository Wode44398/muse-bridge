<script>
  // 主区顶栏：打开侧栏（手机是抽屉键）、线程标题（点开线程菜单；首页是灰色的「新线程」，不能点）、项目 · 分支、
  // 改动计数（只滚变了的那一位，点开工作区的「更改」卡）、新线程（手机）、工作区开关（终端 / 浏览器被 agent 动过而卡没开时亮一个点）。
  // 换线程时标题从侧栏那一行飞过来（lib/codex/chrome/flight.js）。重命名就在标题上原地改：回车定、Esc 放弃、点别处也算定。
  import { tick, untrack } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { codexDock, openCodexDock, closeCodexDock } from '../../lib/dock.svelte.js';
  import { codex, current, newThread, projectOf, sessionMeta, renameThread, errText } from '../../lib/codex/store.svelte.js';
  import { turnSummary } from '../../lib/codex/turns.js';
  import { cxPop, togglePop, closePop } from '../../lib/codex/ui.svelte.js';
  import { rolled } from '../../lib/codex/motion.js';
  import { diffTotal } from '../../lib/codex/chrome/logic.js';
  import { takeTitleFlight, flyTitle } from '../../lib/codex/chrome/flight.js';
  import Icon from './Icon.svelte';
  import ThreadMenu from './ThreadMenu.svelte';

  const thread = $derived(current());
  const home = $derived(!codex.sessionId);
  const meta = $derived(codex.sessionId ? sessionMeta(codex.sessionId) : null);
  const title = $derived(home ? t('新线程') : tr(thread.title || meta?.title || '') || t('新线程'));
  const project = $derived(projectOf(thread.projectId || meta?.projectId || ''));
  const sub = $derived.by(() => {
    if (home) return '';
    const name = project?.name || meta?.projectName || '';
    const branch = project?.branch || '';
    return name && branch ? `${name} · ${branch}` : name;
  });
  const diff = $derived(home ? { a: 0, d: 0 } : diffTotal(thread.turns, turnSummary));
  const live = $derived(!codexDock.open && (codexDock.termLive || !!codexDock.browserLive));

  let nameEl = $state(null);
  let editEl = $state(null);
  let renaming = $state(false);
  let renameErr = $state('');

  function openSide() {
    closePop();
    if (!layout.side) codex.drawer = !codex.drawer;
    else codex.sideOpen = true;
  }

  function menu(e) {
    if (home || renaming) return;
    e.stopPropagation();
    togglePop('thread', e.currentTarget);
  }

  function toggleDock() {
    closePop();
    if (codexDock.open) closeCodexDock(); else openCodexDock();
  }

  function fresh() {
    closePop();
    newThread();
  }

  /* ---------- 原地重命名 ---------- */
  async function startRename() {
    if (home) return;
    renameErr = '';
    renaming = true;
    await tick();
    if (!editEl) { renaming = false; return; }
    editEl.textContent = title;
    editEl.focus();
    const sel = getSelection(), rg = document.createRange();
    rg.selectNodeContents(editEl);
    sel.removeAllRanges();
    sel.addRange(rg);
  }
  function endRename(commit) {
    if (!renaming) return;
    const id = codex.sessionId;
    const v = (editEl?.textContent || '').replace(/\s+/g, ' ').trim();
    renaming = false;
    if (!commit || !v || v === title) return;
    renameThread(id, v).catch((e) => {
      renameErr = errText(e, t('改名没成功'));
      setTimeout(() => { renameErr = ''; }, 4000);
    });
  }
  function editKey(e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename(false); }
    else if (e.key === ' ') e.stopPropagation();
  }
  // 换了线程还在改：放弃
  $effect(() => { void codex.sessionId; untrack(() => { if (renaming) renaming = false; renameErr = ''; }); });

  /* ---------- 标题从侧栏飞过来 ---------- */
  let lastId = untrack(() => codex.sessionId);
  $effect(() => {
    const id = codex.sessionId;
    if (id === lastId) return;
    lastId = id;
    if (!id) return;
    untrack(() => tick().then(() => {
      const from = takeTitleFlight(id);
      const root = nameEl?.closest('.cx');
      if (from && root) flyTitle(root, from, nameEl, title);
    }));
  });
</script>

<header class="cx-top">
  <button class="ibtn top-open" title={layout.side ? t('打开侧栏') : t('线程列表')} aria-label={layout.side ? t('打开侧栏') : t('线程列表')} onclick={openSide}>
    <Icon name="side" /><i class="rl-dot"></i>
  </button>
  <button class="top-title" title={home ? undefined : t('线程操作')} disabled={home} aria-haspopup={home ? undefined : 'menu'}
    aria-expanded={home ? undefined : cxPop.id === 'thread' && !cxPop.data?.id} onclick={menu}>
    {#if renaming}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <b class="tt-edit" contenteditable="true" spellcheck="false" bind:this={editEl} onkeydown={editKey} onblur={() => endRename(true)}></b>
    {:else}
      <b bind:this={nameEl}>{title}</b>
    {/if}
    <Icon name="chev" class="cv" />
  </button>
  {#if renameErr}
    <span class="top-sub top-err" role="alert">{renameErr}</span>
  {:else if sub}
    <span class="top-sub">{sub}</span>
  {/if}
  <div class="top-grow"></div>
  <button class="chip diffchip" class:on={!home && (diff.a > 0 || diff.d > 0)} title={t('查看改动')} aria-label={t('查看改动')} onclick={() => { closePop(); openCodexDock('review'); }}>
    <Icon name="branch" /><span class="a roll" use:rolled={'+' + diff.a}></span><span class="d roll" use:rolled={'−' + diff.d}></span>
  </button>
  <button class="ibtn top-new" title={t('新线程')} aria-label={t('新线程')} onclick={fresh}><Icon name="compose" /></button>
  <button class="ibtn" id="dockBtn" title={t('工作区')} aria-label={t('工作区')} aria-pressed={codexDock.open} onclick={toggleDock}>
    <Icon name="panel" />{#if live}<i class="dock-live"></i>{/if}
  </button>
</header>
<ThreadMenu id={codex.sessionId} {title} onrename={startRename} />

<style>
  .top-err { color: var(--warn); }
  .tt-edit { cursor: text; -webkit-user-select: text; user-select: text; }
  .dock-live { position: absolute; top: 6px; right: 6px; width: 5px; height: 5px; border-radius: 50%; background: var(--fg); pointer-events: none; animation: cx-ball-pulse calc(var(--k, 1) * 1.4s) infinite; }
</style>
