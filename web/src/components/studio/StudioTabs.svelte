<script>
  // 顶栏的四个种类（方案 §12.1）：线稿字形 + 文字，选中项垫一块纸面滑块（快弹簧，从此刻的位置接着滑）。
  // 放不下时（room 由外壳量好传进来）没选中的只留字形，选中的字宽和滑块同一条弹簧一起走。
  // 有任务在跑的页：字形上一小段墨沿笔画走（pathLength 100、dasharray 22 78）；这一页最后一个任务完成时描满一圈再淡回，
  // 失败 / 取消就直接淡回。也是落点：拖着素材悬停切页，直接松在上面＝切页并按默认角色挂上。
  import { untrack, onDestroy } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { drag, dropZone } from '../../lib/dragdrop.svelte.js';
  import { reduced } from '../../lib/motion.js';
  import { PAGES } from '../../modules/studio/kinds.js';
  import { slotDropFor } from '../../modules/studio/drag.js';
  import { tabGlyph } from '../../modules/studio/icons.js';
  import { SPRING_SNAP, springEasing } from '../../modules/studio/motion.js';

  let { value, onchange, labels, busy = {}, done = {}, room = 0 } = $props();

  let nav = $state(), puck = $state(), natW = $state(0);
  const tight = $derived(!!room && !!natW && natW > room);
  const quiet = () => reduced() || !!nav?.closest('.sd-noanim');

  // —— 滑块与标签宽 ——
  let placed = false;
  function labelsTo(sel, animate) {
    for (const b of nav.querySelectorAll('.st-tab')) {
      const lb = b.querySelector('.st-lb');
      if (!tight) { lb.style.transition = ''; lb.style.width = ''; continue; }
      const w = b.dataset.v === sel ? lb.scrollWidth : 0;
      lb.style.transition = animate ? `width ${SPRING_SNAP.ms}ms ${springEasing(SPRING_SNAP)}` : 'none';
      lb.style.width = w + 'px';
    }
  }
  function layoutTabs(animate) {
    if (!nav || !puck) return;
    const sel = value;
    const lbs = [...nav.querySelectorAll('.st-lb')];
    const old = lbs.map((l) => l.style.width);
    // 先把标签瞬间摆到终态量出选中项的终点，再退回旧宽从那里过渡过去（滑块和标签走同一条弹簧）
    labelsTo(sel, false);
    const btn = nav.querySelector(`.st-tab[data-v="${sel}"]`);
    if (!btn) return;
    const to = { x: btn.offsetLeft, w: btn.offsetWidth };
    const anim = animate && placed && !quiet();
    if (tight && anim) { lbs.forEach((l, i) => { l.style.width = old[i]; }); void nav.offsetWidth; labelsTo(sel, true); }
    slidePuck(to, anim);
    placed = true;
  }
  // 滑块：正在滑就从它此刻的样子接着滑；撤掉旧动画、终值写进 style、不 commitStyles（会把旧终值写回来，§12.8）
  function slidePuck(to, anim) {
    const cs = puck._mo?.playState === 'running' ? getComputedStyle(puck) : null;
    const from = cs ? { transform: cs.transform, width: cs.width } : puck._last;
    puck._mo?.cancel(); puck._mo = null;
    const end = { transform: `translateX(${to.x}px)`, width: to.w + 'px' };
    puck.style.transform = end.transform; puck.style.width = end.width;
    puck._last = end;
    if (!anim || !from || (from.transform === end.transform && from.width === end.width)) return;
    puck._mo = puck.animate([from, end], { duration: SPRING_SNAP.ms, easing: springEasing(SPRING_SNAP) });
  }
  // 换页才动画；放不下 / 放得下切换、字宽变了（字体到货、换语言）是重排，原地摆好。
  // 不拿 ResizeObserver 盯 nav：标签宽在弹簧里逐帧变，一重排就把正在走的动画掐掉
  let lastValue = '';
  $effect(() => {
    const v = value; tight; natW;
    untrack(() => { layoutTabs(v !== lastValue && !!lastValue); lastValue = v; });
  });

  // —— 在跑的墨描 ——
  const st = {};          // page → { busy, t0, off, end, fill }
  let raf = 0;
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const traceOf = (p) => nav?.querySelector(`.st-tab[data-v="${p}"]`);
  function paint(now) {
    let live = false;
    for (const p of PAGES) {
      const s = st[p]; const b = traceOf(p);
      if (!s || !b) continue;
      const tr = b.querySelector('.tg-trace'), base = b.querySelector('.tg-base');
      const segs = tr.querySelectorAll('[pathLength]');
      if (s.busy) {
        s.off = -((now - s.t0) / 16) % 100;
        for (const e of segs) { e.style.strokeDasharray = '22 78'; e.style.strokeDashoffset = String(s.off); }
        tr.style.opacity = '1'; base.style.opacity = '.42';
        live = true;
      } else if (s.end) {
        const dt = now - s.end;
        if (s.fill) {
          const k = 1 - (1 - clamp(dt / 520)) ** 3, len = 22 + 78 * k;
          for (const e of segs) e.style.strokeDasharray = `${len} ${100 - len}`;
        }
        const fade = clamp((dt - (s.fill ? 620 : 0)) / (s.fill ? 380 : 260));
        tr.style.opacity = String(1 - fade); base.style.opacity = String(0.42 + 0.58 * fade);
        if (fade >= 1) { delete st[p]; tr.style.opacity = ''; base.style.opacity = ''; b.classList.remove('st-busy'); }
        else live = true;
      }
    }
    return live;
  }
  function loop(now) { raf = 0; if (paint(now)) raf = requestAnimationFrame(loop); }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  $effect(() => {
    const on = PAGES.map((p) => !!busy[p]);
    const dn = PAGES.map((p) => done[p] || 0);
    untrack(() => {
      const q = quiet();
      PAGES.forEach((p, i) => {
        const b = traceOf(p);
        const s = st[p];
        if (on[i] && !s?.busy) {
          st[p] = { busy: true, t0: performance.now(), off: 0, end: 0, fill: false, seq: dn[i] };
          b?.classList.add('st-busy');
        } else if (!on[i] && s?.busy) {
          // 这一轮里有任务完成（done 计数涨过）就描满一圈；没有（失败 / 取消）只淡回
          s.busy = false; s.end = performance.now(); s.fill = dn[i] !== s.seq;
        }
      });
      if (q) {
        // 减少动态效果：不走、不描满；在跑的页留一小段静止的墨
        for (const p of PAGES) {
          const b = traceOf(p); if (!b) continue;
          const tr = b.querySelector('.tg-trace');
          if (st[p]?.busy) { for (const e of tr.querySelectorAll('[pathLength]')) { e.style.strokeDasharray = '22 78'; e.style.strokeDashoffset = '0'; } tr.style.opacity = '1'; }
          else if (st[p]) { delete st[p]; tr.style.opacity = ''; b.querySelector('.tg-base').style.opacity = ''; b.classList.remove('st-busy'); }
        }
        return;
      }
      kick();
    });
  });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });

  // —— 键盘：←→ 在四页之间走（焦点跟着走）——
  function onKey(e) {
    const n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? 3 : 0;
    if (!n) return;
    e.preventDefault();
    const p = PAGES[(PAGES.indexOf(value) + n) % 4];
    onchange?.(p);
    requestAnimationFrame(() => nav?.querySelector(`.st-tab[data-v="${p}"]`)?.focus());
  }

  // —— 落点：拖着素材悬停 600ms 切页（spring folder），直接松在上面＝切页并按默认角色挂上 ——
  function tabDrop(node, p) {
    const opts = (pp) => ({
      key: 'studio-seg:' + pp, effect: 'send',
      label: () => t('切到{page}', { page: labels[pp] }),
      accept: (pl) => !!slotDropFor(pp, pl, null),
      spring: () => onchange?.(pp),
      drop: (pl) => { onchange?.(pp); return slotDropFor(pp, pl, null)?.(); },
    });
    const z = dropZone(node, opts(p));
    return { update: (n) => z.update(opts(n)), destroy: z.destroy };
  }
  const over = $derived(drag.on ? drag.overKey : '');
  // 屏幕阅读器：在跑的页报一声
  const busyText = t('生成中');
</script>

<nav class="st-tabs" class:tight bind:this={nav} role="tablist" aria-label={t('创作页')} tabindex="-1" onkeydown={onKey}>
  <span class="st-puck" bind:this={puck} aria-hidden="true"></span>
  {#each PAGES as p (p)}
    <button class="st-tab" class:on={value === p} class:dnd-on={over === 'studio-seg:' + p} data-v={p} role="tab"
      aria-selected={value === p} tabindex={value === p ? 0 : -1} aria-label={busy[p] ? `${labels[p]}（${busyText}）` : labels[p]}
      onclick={() => onchange?.(p)} use:tabDrop={p}>
      <span class="tg">{@html tabGlyph(p)}</span><span class="st-lb">{labels[p]}</span>
    </button>
  {/each}
</nav>
<!-- 量「都摆得下」时的自然宽：一份看不见的同款（字形 + 全部文字），放不下就挂 tight -->
<div class="st-tabs st-measure" aria-hidden="true" bind:offsetWidth={natW}>
  {#each PAGES as p (p)}<span class="st-tab"><span class="tg"></span><span class="st-lb">{labels[p]}</span></span>{/each}
</div>
