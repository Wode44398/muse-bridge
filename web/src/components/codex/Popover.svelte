<script>
  // Codex 分页的通用弹层：锚在一个按钮上，挂到 .cx 根下按它定位；上下放不下时自动翻面。
  // 进场轻轻放大落下（官方 220ms ease-out），退场短而直接（120ms），都能被打断。
  // 同一时间只开一个（lib/codex/ui.svelte.js 的 cxPop）；点空白、Esc、再点一次锚点都收起。
  import { onMount, tick } from 'svelte';
  import { cxPop, closePop, portal } from '../../lib/codex/ui.svelte.js';
  import { reduced } from '../../lib/codex/motion.js';

  let {
    id,
    side = 'top',          // 'top' | 'bottom' | 'right'
    align = 'start',       // 'start' | 'end'
    width = 0,
    gap = 8,
    class: cls = '',
    label = '',
    role = 'menu',
    onclose = null,
    children,
  } = $props();

  const open = $derived(cxPop.id === id);
  let el = $state(null);
  let pos = $state({ style: '', ox: '0%', oy: '100%', avail: 0 });

  function place() {
    const anchor = cxPop.anchor;
    const root = el?.parentElement;
    if (!el || !root || !anchor?.isConnected) return;
    const base = root.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const W = root.clientWidth, H = root.clientHeight;
    const pw = el.offsetWidth, ph = el.offsetHeight;
    const A = { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top };
    if (side === 'right' && W > 640) {
      pos = {
        style: `left:${Math.min(W - pw - 8, A.r + gap)}px;bottom:${Math.max(8, H - A.b)}px`,
        ox: '0%', oy: '100%', avail: A.b - 8,
      };
      return;
    }
    const above = A.t - gap - 8, below = H - A.b - gap - 8;
    let s = side === 'right' ? 'top' : side;
    if (s === 'top' && ph > above && below > above) s = 'bottom';
    if (s === 'bottom' && ph > below && above > below) s = 'top';
    const v = s === 'top' ? `bottom:${H - A.t + gap}px` : `top:${A.b + gap}px`;
    const h = align === 'end'
      ? `right:${Math.max(8, Math.min(W - pw - 8, W - A.r))}px`
      : `left:${Math.max(8, Math.min(W - pw - 8, A.l))}px`;
    pos = { style: `${v};${h}`, ox: align === 'end' ? '100%' : '0%', oy: s === 'top' ? '100%' : '0%', avail: s === 'top' ? above : below };
  }

  $effect(() => {
    if (!open || !el) return;
    void cxPop.anchor;
    place();
    tick().then(place);
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); };
  });

  function popIn(node) {
    if (reduced()) return { duration: 0 };
    return {
      duration: 220,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      css: (t) => `opacity:${t};transform:scale(${0.96 + 0.04 * t}) translateY(${(1 - t) * 4}px)`,
    };
  }
  function popOut() {
    if (reduced()) return { duration: 0 };
    return { duration: 120, css: (t) => `opacity:${t};transform:scale(${0.98 + 0.02 * t})` };
  }

  onMount(() => {
    const down = (e) => {
      if (!open || !el) return;
      if (el.contains(e.target)) return;
      if (cxPop.anchor && cxPop.anchor.contains?.(e.target)) return;
      // 打开弹层的那次点击由锚点自己 stopPropagation；这里只管点空白
      closePop(id);
      onclose?.();
    };
    const key = (e) => {
      if (!open || e.key !== 'Escape') return;
      e.stopPropagation();
      closePop(id);
      onclose?.();
      cxPop.anchor?.focus?.({ preventScroll: true });
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  });
</script>

{#if open}
  <div
    bind:this={el}
    use:portal
    class="pop sq open {cls}"
    {role}
    aria-label={label || undefined}
    style="{pos.style};{width ? `width:${width}px;` : ''}--ox:{pos.ox};--oy:{pos.oy};--avail:{pos.avail}px"
    in:popIn
    out:popOut
  >
    {@render children?.({ avail: pos.avail })}
  </div>
{/if}
