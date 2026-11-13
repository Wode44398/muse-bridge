<script>
  // 弹层（方案 §9.2：模型选择器、档位 / 选项菜单、作品菜单、任务托盘都用它）。做法照抄 dimensio 的
  // harness/web/src/components/ui/Popover.svelte：position:fixed + 视口钳制；内容变高重新定位；从锚点方向弹出
  // （transform-origin 跟着上下翻转与对齐走）；点在外面按下即关；方向键在项之间移动。
  // Studio 版的差别：挂到 .studio-root（令牌在那儿；手机抽屉带 transform，会圈住 fixed）、登记 Studio 自己的返回栈（layers.js）。
  //
  // anchor：元素，或 { getBoundingClientRect() }（右键点出来的菜单锚在鼠标位置）。
  // avoid：{ top, bottom } 竖直方向别盖住的一段（作品行：菜单贴着整行上下沿开，不盖住它）。
  import { onMount } from 'svelte';
  import { pushLayer } from '../../../modules/studio/layers.js';
  import { pop } from '../../../modules/studio/motion.js';

  let {
    anchor, onclose, children, head = null,
    prefer = 'down', align = 'start', minWidth = 200, maxWidth = 360, width = 0, offset = 6,
    role = 'menu', label = '', flush = false, avoid = null, maxHeight = 0,
    trigger = null,   // 点它不算「点在外面」（默认就是锚点；锚点是整块输入框时，触发钮另给）
  } = $props();

  let el = $state();
  let pos = $state({ left: 0, top: 0, origin: 'top left', placed: false, maxH: 0 });
  const M = 10;

  function place() {
    if (!el || !anchor) return;
    let a;
    try { a = anchor.getBoundingClientRect(); } catch { a = { left: 20, right: 40, top: 20, bottom: 40, width: 20, height: 20 }; }
    const vw = innerWidth, vh = innerHeight;
    const w = el.offsetWidth;
    // 内容的自然高度：里面滚动区的 scrollHeight 补回来（否则被上一次的 maxH 夹住，算不出该往哪边开）
    const sc = el.querySelector('.pv-scroll');
    const natural = sc ? el.offsetHeight - sc.clientHeight + sc.scrollHeight : el.scrollHeight;
    const cap = Math.min(maxHeight || 9999, vh - 2 * M);
    const h = Math.min(natural, cap);
    let left = align === 'end' ? a.right - w : align === 'center' ? a.left + a.width / 2 - w / 2 : a.left;
    left = Math.max(M, Math.min(left, vw - M - w));
    // avoid：一段不许盖住的竖直范围，或一个元素（输入框整块）——每次定位现量
    const av = avoid && avoid.getBoundingClientRect ? avoid.getBoundingClientRect() : avoid;
    const topEdge = av ? Math.min(av.top, a.top) : a.top;
    const botEdge = av ? Math.max(av.bottom, a.bottom) : a.bottom;
    const roomUp = topEdge - offset - M, roomDown = vh - M - botEdge - offset;
    let up = prefer === 'up' ? !(roomUp < h && roomDown > roomUp) : roomDown < h && roomUp > roomDown;
    const room = up ? roomUp : roomDown;
    const maxH = Math.max(120, Math.min(cap, room));
    const hh = Math.min(h, maxH);
    let top = up ? topEdge - offset - hh : botEdge + offset;
    top = Math.max(M, Math.min(top, vh - M - hh));
    const ox = align === 'end' ? 'right' : align === 'center' ? 'center' : 'left';
    pos = { left: Math.round(left), top: Math.round(top), origin: `${up ? 'bottom' : 'top'} ${ox}`, placed: true, maxH: Math.round(maxH) };
  }

  function portal(node) {
    const host = (anchor && anchor.closest?.('.studio-root')) || document.querySelector('.studio-root') || document.body;
    if (node.parentNode !== host) host.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  onMount(() => {
    place();
    const release = pushLayer(() => onclose?.());
    const ro = new ResizeObserver(() => place());
    if (el) { ro.observe(el); const sc = el.querySelector('.pv-scroll > *'); if (sc) ro.observe(sc); }
    const onScroll = (e) => { if (el && e.target instanceof Node && el.contains(e.target)) return; place(); };
    const onDown = (e) => {
      const t = e.target;
      const tg = trigger || anchor;
      if (!t || el?.contains(t) || (tg?.contains && tg.contains(t))) return;
      // 别的浮层（这个弹层里再弹出的菜单）里的点按不算「外面」
      if (t.closest?.('.pv, .sh') && !el?.contains(t)) { const mine = [...document.querySelectorAll('.studio-root .pv, .studio-root .sh')]; if (mine.indexOf(t.closest('.pv, .sh')) > mine.indexOf(el)) return; }
      onclose?.();
    };
    addEventListener('resize', place);
    addEventListener('scroll', onScroll, true);
    addEventListener('pointerdown', onDown, true);
    // 桌面上接管焦点（方向键 / Esc 可用）；触屏不抢——抢了会收起输入框的软键盘
    if (matchMedia('(pointer: fine)').matches && !el?.querySelector('input')) el?.focus({ preventScroll: true });
    return () => {
      release(); ro.disconnect();
      removeEventListener('resize', place);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('pointerdown', onDown, true);
    };
  });

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onclose?.(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...(el?.querySelectorAll('[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="option"]:not([aria-disabled="true"]), .op:not([disabled])') || [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[n]?.focus();
  }
</script>

<div bind:this={el} use:portal class="pv" class:flush class:placed={pos.placed}
  style:left="{pos.left}px" style:top="{pos.top}px" style:max-height={pos.maxH ? pos.maxH + 'px' : null}
  style:width={width ? `min(${width}px, calc(100vw - 20px))` : null}
  style:min-width={width ? null : `min(${minWidth}px, calc(100vw - 20px))`} style:max-width="min({maxWidth}px, calc(100vw - 20px))"
  style:transform-origin={pos.origin}
  {role} aria-label={label || null} tabindex="-1" onkeydown={onKey} in:pop|global out:pop|global>
  {#if head}{@render head()}{/if}
  <div class="pv-scroll"><div class="pv-in">{@render children?.()}</div></div>
</div>
