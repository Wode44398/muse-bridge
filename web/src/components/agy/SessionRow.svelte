<script>
  // 侧栏单条会话行：点击切换、悬停或移动端 ⋯ 菜单（靠近底边自动向上展开防裁切）、左滑操作、就地重命名，
  // 以及拖放引用对话（鼠标 HTML5 拖拽 / 触屏长按拿起，拖进输入栏或另一条会话松手即可引用）。
  // 菜单：收藏 / 重命名 / 隐藏（可恢复）/ 删除（彻底删除、不可恢复，点两次确认，同 Claude 侧栏）。
  // gutter：所在文件夹带插件外观（共用文件夹）时，标题对齐 26px 身份栏那根竖线；by = 'claude' 时身份栏里画 Claude 的小头像（谁开的）。
  import {
    agy,
    openAgySession,
    renameAgySession,
    hideAgySession,
  } from '../../lib/agy/store.svelte.js';
  import { setAgyFavorite, purgeAgySession } from '../../lib/agy/session-manage.js';
  import {
    AGY_CHAT_REF,
    AGY_SIDE_DT,
    CHAT_GHOST_IC,
    agySideDrag,
    getRawAgySideDrag,
    beginAgyMouseDrag,
    endAgyMouseDrag,
    isAgyChatRef,
    canQuoteAgy,
    quoteAgySession,
    makeAgyDragGhost,
  } from '../../lib/agy/chat-quote.svelte.js';
  import { drag, beginDrag, makeHold, dropZone } from '../../lib/dragdrop.svelte.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { t } from '../../lib/i18n.js';
  import AgyPeerDuo from './AgyPeerDuo.svelte';

  const {
    item,
    isCurrent = false,
    isLive = false,
    // 这个会话在等你：'permission'（等审批）/ 'question'（等回答）/ ''
    pending = '',
    // 这一轮说完了、后台还在跑（转入后台的命令 / 定时任务 / 子代理）
    bgWait = false,
    menuOpen = false,
    onToggleMenu,
    onCloseMenu,
    gutter = false,
    by = '',
  } = $props();

  let editing = $state(false);
  let delConfirm = $state(false);
  // 菜单一收起，「确认删除」就退回第一步
  $effect(() => { if (!menuOpen) delConfirm = false; });
  let editingTitle = $state('');
  let swiped = $state(false);
  let openUpward = $state(false);
  let touchStartX = 0;
  let touchStartY = 0;
  let rowHover = $state(false);
  let touchLifted = $state(false);

  const rowTitle = $derived(item.title || t('未命名对话'));
  const mouseDnd = $derived(pointer.fine && !editing);
  const lifted = $derived((agySideDrag.kind === 'session' && agySideDrag.id === item.sessionId) || touchLifted);
  const dropKey = $derived('agy-sess:' + item.sessionId);

  $effect(() => { if (!drag.on && touchLifted) touchLifted = false; });

  const hold = makeHold();
  function onRowPointerDown(ev) {
    if (ev.pointerType === 'mouse' || editing) return;
    if (ev.target?.closest?.('.sb-more-btn, .sb-menu, .sb-swipe-acts')) return;
    hold.arm(ev, (f) => {
      const ok = beginDrag(
        { type: AGY_CHAT_REF, id: item.sessionId, name: rowTitle, cwd: item.cwd || '' },
        {
          x: f.x,
          y: f.y,
          pointerId: f.pointerId,
          pointerType: f.pointerType,
          sourceEl: f.el,
          ghost: { name: rowTitle, iconHtml: CHAT_GHOST_IC },
          onStay: () => { onToggleMenu?.(); },
        },
      );
      if (ok) touchLifted = true;
    });
  }
  const onRowPointerMove = (ev) => hold.track(ev);
  const onRowPointerUp = () => hold.disarm();

  function onDragStart(ev) {
    if (!mouseDnd) { ev.preventDefault(); return; }
    ev.stopPropagation();
    const rec = { kind: 'session', id: item.sessionId, title: rowTitle, cwd: item.cwd || '', path: '' };
    try {
      ev.dataTransfer.setData(AGY_SIDE_DT, JSON.stringify({ kind: 'session', id: item.sessionId }));
      ev.dataTransfer.effectAllowed = 'copy';
    } catch {}
    makeAgyDragGhost(ev, rowTitle, 'session');
    beginAgyMouseDrag(rec);
  }

  function onDragEnd() {
    endAgyMouseDrag();
    rowHover = false;
  }

  // 把另一条会话拖到本行松手 = 切到本条并引用拖过来的对话
  function onRowDragOver(ev) {
    const rec = getRawAgySideDrag();
    if (!rec || rec.kind !== 'session' || !canQuoteAgy(rec.id, item.sessionId)) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { ev.dataTransfer.dropEffect = 'copy'; } catch {}
    rowHover = true;
  }

  function onRowDragLeave(ev) {
    if (rowHover && !ev.currentTarget.contains(ev.relatedTarget)) rowHover = false;
  }

  async function onRowDrop(ev) {
    const rec = getRawAgySideDrag();
    if (!rec || rec.kind !== 'session' || !canQuoteAgy(rec.id, item.sessionId)) return;
    ev.preventDefault();
    ev.stopPropagation();
    rowHover = false;
    if (item.sessionId !== agy.sessionId) await openAgySession(item.sessionId);
    quoteAgySession({ id: rec.id, title: rec.title, cwd: rec.cwd });
  }

  const rowDropZone = $derived({
    key: dropKey,
    label: t('引用到「{title}」', { title: rowTitle }),
    effect: 'copy',
    accept: (pl) => isAgyChatRef(pl) && pl.id !== item.sessionId,
    drop: async (pl) => {
      if (item.sessionId !== agy.sessionId) await openAgySession(item.sessionId);
      quoteAgySession({ id: pl.id, title: pl.name, cwd: pl.cwd || '' });
    },
  });

  function startRename(ev) {
    ev?.stopPropagation?.();
    onCloseMenu?.();
    swiped = false;
    editing = true;
    editingTitle = item.title || '';
  }

  async function commitRename() {
    const next = editingTitle.trim();
    editing = false;
    if (next) await renameAgySession(item.sessionId, next);
  }

  function handleMoreClick(ev) {
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const scroller = btn?.closest?.('.sb-list');
    if (btn && scroller) {
      const br = btn.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      openUpward = sr.bottom - br.bottom < 150;
    } else {
      openUpward = false;
    }
    onToggleMenu?.();
  }

  function onTouchStart(ev) {
    const pt = ev.touches?.[0];
    if (!pt) return;
    touchStartX = pt.clientX;
    touchStartY = pt.clientY;
  }

  function onTouchEnd(ev) {
    const pt = ev.changedTouches?.[0];
    if (!pt) return;
    const dx = pt.clientX - touchStartX;
    const dy = Math.abs(pt.clientY - touchStartY);
    if (dy > 36) return;
    if (dx < -48) swiped = true;
    else if (dx > 32 && swiped) swiped = false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="sb-item-wrap"
  class:swiped
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
>
  {#if editing}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="sb-rename-row" onclick={(e) => e.stopPropagation()}>
      <input
        type="text"
        class="sb-rename-in"
        bind:value={editingTitle}
        onkeydown={(e) => {
          if (e.key === 'Enter') commitRename();
          else if (e.key === 'Escape') editing = false;
        }}
        onblur={commitRename}
      />
    </div>
  {:else}
    <div
      class="sb-item"
      class:active={isCurrent}
      class:lifted
      class:drop-quote={rowHover || drag.overKey === dropKey}
      draggable={mouseDnd}
      ondragstart={onDragStart}
      ondragend={onDragEnd}
      ondragover={onRowDragOver}
      ondragleave={onRowDragLeave}
      ondrop={onRowDrop}
      onpointerdown={onRowPointerDown}
      onpointermove={onRowPointerMove}
      onpointerup={onRowPointerUp}
      onpointercancel={onRowPointerUp}
      use:dropZone={rowDropZone}
    >
      <button
        type="button"
        class="sb-item-main"
        class:gutter
        onclick={() => openAgySession(item.sessionId)}
      >
        {#if gutter && by === 'claude'}
          <span class="og" title={t('Claude 开的对话')}><AgyPeerDuo peers={['claude']} size={13} cut="var(--ag-box)" /></span>
        {/if}
        {#if pending}
          <span class="wait-dot" title={pending === 'question' ? t('在等你回答') : t('需要你批准')} aria-label={pending === 'question' ? t('在等你回答') : t('需要你批准')}></span>
        {:else if isLive}
          <span class="live-dot" aria-label={t('运行中')}></span>
        {:else if bgWait}
          <span class="bg-ring" title={t('后台还在跑')} aria-label={t('后台还在跑')}></span>
        {/if}
        <span class="stitle">{rowTitle}</span>
      </button>

      <button
        type="button"
        class="sb-more-btn"
        aria-label={t('会话操作')}
        onclick={handleMoreClick}
      >
        <span class="msr">more_horiz</span>
      </button>

      {#if menuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="sb-menu" class:up={openUpward} onclick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onclick={() => { onCloseMenu?.(); setAgyFavorite(item.sessionId, !item.favorite); }}
          >
            <span class="msr" class:filled={item.favorite}>star</span>
            <span>{item.favorite ? t('取消收藏') : t('收藏')}</span>
          </button>
          <button type="button" onclick={startRename}>
            <span class="msr">edit</span>
            <span>{t('重命名')}</span>
          </button>
          <button
            type="button"
            class="danger"
            onclick={() => { onCloseMenu?.(); hideAgySession(item.sessionId); }}
          >
            <span class="msr">visibility_off</span>
            <span>{t('隐藏对话')}</span>
          </button>
          <button
            type="button"
            class="danger"
            onclick={() => {
              if (!delConfirm) { delConfirm = true; return; }
              onCloseMenu?.();
              purgeAgySession(item.sessionId);
            }}
          >
            <span class="msr">delete</span>
            <span>{delConfirm ? t('确认删除') : t('删除')}</span>
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if swiped}
    <div class="sb-swipe-acts">
      <button type="button" onclick={startRename} aria-label={t('重命名')}>
        <span class="msr">edit</span>
      </button>
      <button
        type="button"
        class="hide"
        onclick={() => { swiped = false; hideAgySession(item.sessionId); }}
        aria-label={t('隐藏对话')}
      >
        <span class="msr">visibility_off</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .sb-item-wrap {
    position: relative;
    display: flex;
    align-items: center;
    margin: 1px 0;
  }
  .sb-item {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    border-radius: 8px;
    -webkit-touch-callout: none;
    user-select: none;
    transition: opacity 0.14s, background 0.12s, box-shadow 0.12s;
  }
  .sb-item:hover { background: var(--ag-hover); }
  .sb-item.active { background: var(--ag-active); }
  .sb-item.lifted { opacity: 0.35; }
  .sb-item.drop-quote {
    background: var(--ag-accent-soft);
    box-shadow: inset 0 0 0 1.5px var(--ag-accent);
  }
  .sb-item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 4px 0 10px;
    text-align: left;
    font-size: 13.5px;
    color: var(--ag-on-sub);
  }
  .sb-item-main.gutter { position: relative; padding-left: 26px; }
  .og {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 26px;
    display: grid;
    place-items: center;
  }
  .sb-item.active .sb-item-main {
    color: var(--ag-on);
  }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ag-accent);
    flex: none;
    animation: agy-live-breathe 1.6s ease-in-out infinite;
  }
  @keyframes agy-live-breathe { 50% { opacity: 0.35; } }
  /* 说完了、后台还在跑：空心环，芯慢慢呼吸（和代理面板「在等」同一个记号）；和实心的「正在跑」分得开 */
  .bg-ring {
    position: relative;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.3px var(--ag-accent);
    flex: none;
  }
  .bg-ring::after {
    content: '';
    position: absolute;
    inset: 2.5px;
    border-radius: 50%;
    background: var(--ag-accent);
    animation: agy-bg-core 2.8s ease-in-out infinite;
  }
  @keyframes agy-bg-core { 0%, 100% { transform: scale(0.4); opacity: 0.35; } 50% { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .bg-ring::after { animation: none; } }
  /* 在等你（审批 / 回答）：实心不呼吸，和「运行中」的蓝点分得开 */
  .wait-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ag-warn);
    flex: none;
  }
  .stitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .sb-more-btn {
    width: 26px;
    height: 26px;
    margin-right: 4px;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
    opacity: 0;
  }
  .sb-item:hover .sb-more-btn,
  .sb-item.active .sb-more-btn {
    opacity: 1;
  }
  @media (pointer: coarse) {
    .sb-more-btn { opacity: 1; }
  }
  .sb-more-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sb-more-btn .msr { font-size: 18px; }

  .sb-menu {
    position: absolute;
    right: 6px;
    top: calc(100% + 2px);
    min-width: 128px;
    padding: 4px;
    border-radius: 10px;
    background: var(--ag-pop-bg);
    box-shadow: var(--ag-elev-shadow);
    z-index: 25;
    display: flex;
    flex-direction: column;
  }
  .sb-menu.up {
    top: auto;
    bottom: calc(100% + 2px);
  }
  .sb-menu button {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border-radius: 7px;
    font-size: 12.5px;
    color: var(--ag-on);
    text-align: left;
  }
  .sb-menu button:hover { background: var(--ag-hover); }
  .sb-menu button.danger { color: var(--ag-err); }
  .sb-menu .msr { font-size: 16px; }

  .sb-rename-row {
    flex: 1;
    padding: 2px 0;
  }
  .sb-rename-in {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    border-radius: 7px;
    border: 1px solid var(--ag-accent);
    background: var(--ag-cbox-bg);
    color: var(--ag-on);
    font-family: inherit;
    font-size: 12.5px;
    outline: none;
  }

  .sb-swipe-acts {
    display: flex;
    gap: 4px;
    padding-left: 4px;
    flex: none;
  }
  .sb-swipe-acts button {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--ag-surface-2);
    color: var(--ag-on);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .sb-swipe-acts button.hide {
    background: var(--ag-err-bg);
    color: var(--ag-err);
  }
  .sb-swipe-acts .msr { font-size: 16px; }
</style>
