<script>
  // 侧栏的一行线程：状态列（文件夹图标下面那一列）+ 标题 + 时间（方案第十五节第 9 条）。
  // 状态列都是对话里那颗小球的缩影：思考 = 呼吸的点，跑命令 = 闪烁的短线，等你批准 = 点外一圈声纳，
  // 跑完没看 = 蓝点，出错 = 警示图标；变成「等你 / 没看」时点弹一下。
  // 新出现的一行从零高度长出来，删掉 / 归档的一行向左收走；搜索时只藏起来（不卸），选中底块不会乱跳。
  //
  // 这一行的操作（同顶栏标题那张线程菜单：重命名、分叉、复制 ID、终端接着跑、归档、删除）：
  //   · 鼠标：悬停时时间让位给「⋯」，点它或在行上右键；
  //   · 手指：长按原地松手 = 菜单（长按拎起来挪动 = 拖去引用，见下）。
  // 拖放（同 Claude / Antigravity 侧栏）：拖进输入栏或松在另一条线程上 = 把这条线程当背景材料引用进去。
  import { onMount, tick, untrack } from 'svelte';
  import { cubicIn } from 'svelte/easing';
  import { t, tr } from '../../lib/i18n.js';
  import { layout, pointer } from '../../lib/layout.svelte.js';
  import { codex, leadOf, openThread, renameThread, errText } from '../../lib/codex/store.svelte.js';
  import { cxPop, openPop, closePop } from '../../lib/codex/ui.svelte.js';
  import { anim, EASE, reduced } from '../../lib/codex/motion.js';
  import { leadToken, markParts } from '../../lib/codex/chrome/logic.js';
  import { agoText } from '../../lib/codex/chrome/text.js';
  import { clock } from '../../lib/codex/chrome/clock.svelte.js';
  import { queueTitleFlight } from '../../lib/codex/chrome/flight.js';
  import {
    CX_THREAD_REF, CX_SIDE_DT, CHAT_GHOST_IC, cxSideDrag, rawCxSideDrag, beginCxMouseDrag, endCxMouseDrag,
    isCxThreadRef, canQuoteCx, quoteCxThread, cxDragGhost,
  } from '../../lib/codex/chrome/sideDnd.svelte.js';
  import { drag, beginDrag, makeHold, dropZone, dropToast } from '../../lib/dragdrop.svelte.js';
  import Icon from './Icon.svelte';

  let { session, q = '', miss = false, active = false, grow = false } = $props();

  let wrapEl = $state(null);
  let rowEl = $state(null);
  let titleEl = $state(null);
  let leadEl = $state(null);
  let moreEl = $state(null);
  let inputEl = $state(null);

  const title = $derived(tr(session.title || '') || t('新线程'));
  const parts = $derived(markParts(title, q));
  const st = $derived(leadToken(leadOf(session.id)));
  const when = $derived(agoText(session.mtime, clock.now));
  const menuOpen = $derived(cxPop.id === 'thread' && cxPop.data?.id === session.id);

  function go() {
    if (editing) return;
    if (session.id !== codex.sessionId && layout.side) queueTitleFlight(session.id, titleEl);
    codex.drawer = false;
    openThread(session.id);
  }

  /* ---------- 菜单 ---------- */
  function openMenu(anchor) {
    openPop('thread', anchor || moreEl || rowEl, { id: session.id, title, onrename: startRename });
  }
  function onMore(e) {
    e.stopPropagation();
    if (menuOpen) { closePop('thread'); return; }
    openMenu(e.currentTarget);
  }
  let lastPtr = 'mouse';
  function onContext(e) {
    if (editing || e.target.closest?.('input')) return;
    e.preventDefault();
    // 手指长按时系统也会发 contextmenu：菜单由长按那套（原地松手）出，这里不抢，免得拎着拖的时候弹菜单
    if (lastPtr !== 'mouse') return;
    openMenu(moreEl && getComputedStyle(moreEl).display !== 'none' ? moreEl : rowEl);
  }

  /* ---------- 就地改名 ---------- */
  let editing = $state(false);
  let editText = $state('');
  async function startRename() {
    closePop();
    editText = title;
    editing = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }
  let committing = false;
  async function endRename(save) {
    if (!editing || committing) return;
    const next = editText.trim();
    committing = true;
    editing = false;
    try {
      if (save && next && next !== title) await renameThread(session.id, next);
    } catch (e) {
      dropToast(errText(e, t('改名没成功')));
    } finally { committing = false; }
  }
  function editKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename(false); }
  }

  /* ---------- 拖放：鼠标（HTML5） ---------- */
  const mouseDnd = $derived(pointer.fine && !editing);
  let hover = $state(false);     // 另一条线程正拖到这一行上
  let touchLifted = $state(false);
  const lifted = $derived(cxSideDrag.id === session.id || touchLifted);
  const dropKey = $derived('codex-thread:' + session.id);

  function onDragStart(e) {
    if (!mouseDnd) { e.preventDefault(); return; }
    closePop();
    const rec = { id: session.id, title };
    try {
      e.dataTransfer.setData(CX_SIDE_DT, JSON.stringify({ kind: 'thread', id: session.id }));
      e.dataTransfer.effectAllowed = 'copy';
    } catch {}
    cxDragGhost(e, title);
    beginCxMouseDrag(rec);
  }
  function onDragEnd() { endCxMouseDrag(); hover = false; }
  function onDragOver(e) {
    const rec = rawCxSideDrag();
    if (!rec || !canQuoteCx(rec.id, session.id)) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    hover = true;
  }
  function onDragLeave(e) { if (hover && !e.currentTarget.contains(e.relatedTarget)) hover = false; }
  async function onDrop(e) {
    const rec = rawCxSideDrag();
    if (!rec || !canQuoteCx(rec.id, session.id)) return;
    e.preventDefault();
    e.stopPropagation();
    hover = false;
    endCxMouseDrag();
    await quoteInto(rec);
  }
  // 松在另一条线程上：先切过去，再引用进它的输入栏
  async function quoteInto(rec) {
    if (session.id !== codex.sessionId) { codex.drawer = false; await openThread(session.id); }
    quoteCxThread(rec);
  }

  /* ---------- 拖放：手指（长按拎起） ---------- */
  const hold = makeHold();
  function onPointerDown(e) {
    lastPtr = e.pointerType || 'mouse';
    if (e.pointerType === 'mouse' || editing) return;
    hold.arm(e, (f) => {
      const ok = beginDrag({ type: CX_THREAD_REF, id: session.id, name: title }, {
        x: f.x, y: f.y, pointerId: f.pointerId, pointerType: f.pointerType, sourceEl: f.el,
        ghost: { name: title, iconHtml: CHAT_GHOST_IC },
        onStay: () => openMenu(rowEl),
      });
      if (ok) touchLifted = true;
    });
  }
  const onPointerMove = (e) => hold.track(e);
  const onPointerUp = () => hold.disarm();
  $effect(() => { if (!drag.on && touchLifted) untrack(() => { touchLifted = false; }); });
  // 手机抽屉盖着正文：拎着往右拖出抽屉，抽屉自己收起，露出输入栏接着放
  $effect(() => {
    if (!touchLifted || layout.side || !codex.drawer) return;
    const x = drag.x;
    const side = untrack(() => wrapEl?.closest('.cx-side'));
    if (side && x > side.getBoundingClientRect().right + 6) untrack(() => { codex.drawer = false; });
  });
  const rowDrop = $derived({
    key: dropKey,
    label: t('引用到「{title}」', { title }),
    effect: 'copy',
    accept: (pl) => isCxThreadRef(pl) && pl.id !== session.id,
    drop: (pl) => quoteInto({ id: pl.id, title: pl.name }),
  });

  /* ---------- 小动效 ---------- */
  // 变成「等你批准 / 跑完没看」时，点弹一下
  let lastSt = untrack(() => st);
  $effect(() => {
    const s = st;
    if (s === lastSt) return;
    lastSt = s;
    if ((s === 'unread' || s === 'ask') && leadEl) {
      anim(leadEl, [{ transform: 'scale(.4)' }, { transform: 'scale(1.25)', offset: 0.5 }, { transform: 'scale(1)' }], { dur: 420, ease: EASE.out });
    }
  });

  // 改了名：标题淡一下再定住
  let lastTitle = untrack(() => title);
  $effect(() => {
    const s = title;
    if (s === lastTitle) return;
    lastTitle = s;
    if (titleEl && !q) anim(titleEl, [{ opacity: 0.2 }, { opacity: 1 }], { dur: 300 });
  });

  onMount(() => {
    if (!grow || reduced() || !wrapEl) return;
    const h = wrapEl.offsetHeight;
    anim(wrapEl, [{ height: '0px', opacity: 0, transform: 'translateY(-4px)' }, { height: h + 'px', opacity: 1, transform: 'none' }], { dur: 420, ease: EASE.soft });
  });

  function shrink(node) {
    if (reduced()) return { duration: 0 };
    const h = node.offsetHeight;
    return { duration: 300, easing: cubicIn, css: (k) => `height:${k * h}px;opacity:${k};transform:translateX(${(1 - k) * -10}px);overflow:hidden` };
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="th-wrap" class:miss class:menu-open={menuOpen} class:lifted class:drop-quote={hover || drag.overKey === dropKey}
  bind:this={wrapEl} out:shrink oncontextmenu={onContext}
  ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} use:dropZone={rowDrop}>
  {#if editing}
    <div class="th-row th-edit" class:is-active={active} data-thread={session.id} bind:this={rowEl}>
      <span class="th-lead" data-st={st} bind:this={leadEl}>{#if st === 'err'}<Icon name="warn" />{/if}</span>
      <input bind:this={inputEl} bind:value={editText} maxlength="200" spellcheck="false" aria-label={t('线程名称')}
        onkeydown={editKey} onblur={() => endRename(true)} />
    </div>
  {:else}
    <button class="th-row" class:is-active={active} class:miss bind:this={rowEl} data-thread={session.id}
      aria-current={active ? 'page' : undefined} onclick={go}
      draggable={mouseDnd} ondragstart={onDragStart} ondragend={onDragEnd}
      onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}>
      <span class="th-lead" data-st={st} bind:this={leadEl}>{#if st === 'err'}<Icon name="warn" />{/if}</span>
      <span class="th-title" bind:this={titleEl}>{#each parts as p, i (i)}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}</span>
      <span class="th-time">{when}</span>
    </button>
    <button class="ibtn sm th-more" bind:this={moreEl} tabindex="-1" title={t('线程操作')} aria-label={t('线程操作')}
      aria-haspopup="menu" aria-expanded={menuOpen} onclick={onMore}><Icon name="more" /></button>
  {/if}
</div>

<style>
  .th-wrap { position: relative; flex: none; border-radius: 10px; transition: opacity var(--d-2), box-shadow var(--d-2); }
  .th-wrap.miss { display: none; }
  .th-row { width: 100%; -webkit-touch-callout: none; }
  /* 「⋯」坐在时间那一格上：悬停 / 菜单开着时时间让位，「⋯」淡进来 */
  .th-more {
    position: absolute; right: 3px; top: 50%; width: 26px; height: 26px; margin-top: -13px; z-index: 2;
    color: var(--fg3); opacity: 0; pointer-events: none; transform: translateX(3px);
    transition: opacity var(--d-2), transform var(--d-3) var(--ease-out), background-color var(--d-2), color var(--d-2);
  }
  .th-more :global(svg) { width: 16px; height: 16px; }
  .th-more:hover, .menu-open .th-more { color: var(--fg); background: var(--fill3); }
  @media (hover: hover) {
    .th-wrap:hover .th-more, .th-wrap.menu-open .th-more, .th-wrap:focus-within .th-more { opacity: 1; pointer-events: auto; transform: none; }
    .th-wrap:hover :global(.th-time), .th-wrap.menu-open :global(.th-time), .th-wrap:focus-within :global(.th-time) { opacity: 0 !important; }
  }
  /* 触屏：长按就是菜单，不放这颗键 */
  @media (hover: none) { .th-more { display: none; } }
  .menu-open :global(.th-row::before) { opacity: 1; }

  /* 拖着的那一行变淡；另一条线程拖到这一行上 = 引用落点 */
  .th-wrap.lifted { opacity: .35; }
  .th-wrap.drop-quote { box-shadow: inset 0 0 0 1.5px var(--fg3); }
  .th-wrap.drop-quote :global(.th-row::before) { opacity: 1; }

  .th-edit input {
    flex: 1; min-width: 0; height: 26px; margin-right: -4px; padding: 0 8px; border-radius: 7px;
    border: 0; outline: none; background: var(--fill2); box-shadow: inset 0 0 0 1px var(--line2);
    color: var(--fg); font: inherit;
  }
</style>
