<script>
  // 稍后发送的消息：叠在输入栏上沿。点字可以改（回车存、Esc 放弃），× 删，跑着时「现在插话」，
  // 按住左边的「稍后发送」拖动排序（指针事件，触屏同样能拖）。轮到哪条，哪条往上滑进对话。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import Icon from './Icon.svelte';
  import { current, updateQueued, removeQueued, reorderQueue, steer, errText } from '../../lib/codex/store.svelte.js';
  import { dropIndex } from '../../lib/codex/composer/logic.js';
  import { riseIn, cardOut } from '../../lib/codex/composer/fx.js';
  import { reduced } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';

  let { busy = false, onerror = null } = $props();

  const thread = $derived(current());
  const queue = $derived(thread.queue || []);

  // 退场去向：你删的往右让开、现在插话往上一小段，其余（服务端把它发出去了）滑进对话
  const leaving = new Map();
  const howOf = (id, owner) => () => (current().id !== owner ? 'none' : leaving.get(id) || 'up');

  let editing = $state('');
  let editText = $state('');
  let box = $state(null);

  function startEdit(q) {
    if (drag) return;
    editing = q.id;
    editText = q.text;
  }
  async function commitEdit(q) {
    if (editing !== q.id) return;
    const next = editText.trim();
    editing = '';
    if (!next || next === q.text) return;
    const was = q.text;
    q.text = next;
    try { await updateQueued(q.id, next); } catch (e) { q.text = was; onerror?.(errText(e, t('没改成'))); }
  }
  function editKey(e, q) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitEdit(q); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing = ''; }
  }
  function focusOnMount(node) {
    node.focus({ preventScroll: true });
    node.select?.();
  }

  async function del(q) {
    leaving.set(q.id, 'right');
    try { await removeQueued(q.id); } catch (e) { onerror?.(errText(e, t('没删掉'))); }
  }
  async function steerNow(q) {
    leaving.set(q.id, 'steer');
    haptic('tick');
    try {
      await removeQueued(q.id);
      await steer(q.text);
    } catch (e) { onerror?.(errText(e, t('没插进去'))); }
  }

  /* ---------------- 拖动排序 ---------------- */
  let drag = $state(null);       // { id, from, to, startY, dy, h, mids, els, pid }
  const GAP = 6;

  function cards() { return box ? [...box.querySelectorAll('.q-card')] : []; }

  function onGripDown(e, i) {
    if (queue.length < 2 || e.button > 0 || editing) return;
    e.preventDefault();
    const els = cards();
    const el = els[i];
    if (!el) return;
    const mids = els.map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; });
    drag = { id: queue[i].id, from: i, to: i, startY: e.clientY, dy: 0, h: el.offsetHeight + GAP, mids, els, pid: e.pointerId, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function onGripMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(drag.dy) < 4) return;
    if (!drag.moved) { drag.moved = true; haptic('tick'); }
    const to = dropIndex(drag.mids, drag.from, drag.mids[drag.from] + drag.dy);
    if (to !== drag.to) { drag.to = to; haptic('tick'); }
    paint();
  }
  // 其余卡让位：落点和原位之间的那几张各挪一格
  function paint() {
    const { from, to, dy, h, els } = drag;
    els.forEach((c, k) => {
      if (k === from) { c.style.transition = 'none'; c.style.transform = `translateY(${dy}px) scale(1.02)`; c.style.zIndex = '2'; return; }
      let s = 0;
      if (from < to && k > from && k <= to) s = -h;
      if (from > to && k >= to && k < from) s = h;
      c.style.transition = reduced() ? 'none' : 'transform var(--d-3) var(--ease-out)';
      c.style.transform = s ? `translateY(${s}px)` : '';
    });
  }
  function onGripUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    if (!d.moved) { drag = null; return; }
    const el = d.els[d.from];
    // 先把拖着的那张落到它的新位置，落稳了再一次性交换真实顺序（位置刚好重合，不会跳）
    const settle = () => {
      d.els.forEach((c) => { c.style.transition = 'none'; c.style.transform = ''; c.style.zIndex = ''; });
      drag = null;
      if (d.to !== d.from) {
        const ids = queue.map((q) => q.id);
        const [x] = ids.splice(d.from, 1);
        ids.splice(d.to, 0, x);
        reorderQueue(ids).catch((err) => onerror?.(errText(err, t('没排上'))));
      }
      requestAnimationFrame(() => d.els.forEach((c) => { c.style.transition = ''; }));
    };
    const target = (d.to - d.from) * d.h;
    if (reduced() || !el) { settle(); return; }
    el.style.transition = 'transform var(--d-3) var(--ease-out)';
    el.style.transform = `translateY(${target}px)`;
    let done = false;
    const fin = () => { if (done) return; done = true; settle(); };
    el.addEventListener('transitionend', fin, { once: true });
    setTimeout(fin, 320);
  }

  // 换了线程：手上的编辑和拖动作废
  $effect(() => {
    void thread.id;
    untrack(() => { editing = ''; drag = null; });
  });
</script>

<div class="q-stack" bind:this={box}>
  {#each queue as q, i (q.id)}
    <div class="q-card sq" class:dragging={drag?.id === q.id && drag.moved} in:riseIn out:cardOut={{ how: howOf(q.id, thread.id) }}>
      <span
        class="qn"
        class:grip={queue.length > 1}
        title={queue.length > 1 ? t('按住拖动，调整先后') : undefined}
        onpointerdown={(e) => onGripDown(e, i)}
        onpointermove={onGripMove}
        onpointerup={onGripUp}
        onpointercancel={onGripUp}
        role="presentation"
      ><Icon name="clock" />{t('稍后发送')}</span>
      {#if editing === q.id}
        <input
          class="qt qe"
          bind:value={editText}
          use:focusOnMount
          onkeydown={(e) => editKey(e, q)}
          onblur={() => commitEdit(q)}
          aria-label={t('改这条稍后发送的消息')}
        />
      {:else}
        <button type="button" class="qt" title={t('点一下改')} onclick={() => startEdit(q)}>{q.text}</button>
      {/if}
      {#if busy}
        <button type="button" class="tbtn" title={t('不等这一轮跑完，现在就插进去')} onclick={() => steerNow(q)}>{t('现在插话')}</button>
      {/if}
      <button type="button" class="ibtn sm" title={t('删除')} aria-label={t('删除')} onclick={() => del(q)}><Icon name="x" /></button>
    </div>
  {/each}
</div>

<style>
  .q-stack { display: flex; flex-direction: column; gap: 6px; }
  .q-stack:empty { display: none; }
  .q-card { position: relative; will-change: transform; }
  .q-card.dragging { box-shadow: var(--shadow-pop); }
  .qn.grip { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .q-card.dragging .qn.grip { cursor: grabbing; }
  button.qt { text-align: left; padding: 0; cursor: text; }
  .qe { height: 24px; border: 0; outline: 0; background: var(--fill2); border-radius: 6px; padding: 0 6px; font: inherit; color: var(--fg); }
</style>
