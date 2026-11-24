<script>
  // agy 分页统一弹层外壳：有锚点（输入框底栏芯片 / 仪表 / 顶栏文件夹）时在桌面端实时跟踪锚点弹出；
  // 窄屏一律自底向上的抽屉并支持把手下滑关闭；无锚点时为居中对话框。支持方向键选单与 Esc 关闭。
  //
  // 开合动效（11-19，Material container transform）：弹层不是 0 帧冒出来，而是由锚点本身「长」成——
  //   · cover（仪表用）：卡片盖住锚点、右缘对齐，从那颗圆的形状与位置展开成卡片；
  //   · 其余锚点：从芯片本身展开（起点就是芯片的矩形，向上 / 向下长出、平移落位）；
  //   编排：容器边界与圆角一根弹簧（开 k=300 临界阻尼，收 k=640 更快）；淡入淡出按时间编排（效果通道，
  //   见 FX）：开——锚点的「影子」（克隆）150ms 内退场、它身后的底色随后换成弹层底色，菜单内容 120ms 后
  //   淡入并从锚点一侧微微滑入；收——内容先退、底色与影子回来，容器缩回时正好是锚点原样。阴影随容器抬升。
  //   关闭时整套反着走，最后容器缩回锚点、影子淡回来，和底下真正的锚点严丝合缝地交接。
  //   打开途中关闭 / 关闭途中再开都从当下进度接着走（弹簧可打断）。
  import { onMount, onDestroy, untrack, tick } from 'svelte';
  import { pushBackLayer } from '../../lib/nav.js';
  import { t } from '../../lib/i18n.js';
  import { Spring, stepAll } from '../../lib/agy/springs.js';
  import { clamp01, lerp, reducedMotion, emphDecel, standard } from '../../lib/agy/motion.js';

  const {
    anchor = null,
    anchorEl = null,
    width = 320,
    title = '',
    cover = false,       // 卡片盖住锚点（仪表变菜单）
    skin = 'var(--ag-cbox-bg)',   // 锚点身后的底色：容器起点就是这个颜色，渐变成弹层底色
    locked = false,      // 上层盖着子浮层（如长按上下文菜单）时暂停本层键盘与下滑关闭
    onClose,
    children,
  } = $props();

  let innerW = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
  let innerH = $state(typeof window !== 'undefined' ? window.innerHeight : 900);
  let geomTick = $state(0);
  let cardEl = $state(null);
  let bodyEl = $state(null);
  let scrollEl = $state(null);
  let shadowEl = $state(null);
  let skinEl = $state(null);
  let ghostEl = $state(null);
  let kbIdx = $state(-1);
  let dragY = $state(0);
  let dragging = $state(false);
  let closing = $state(false);
  let touchStartY = null;

  const narrow = $derived(innerW < 600);
  // 有锚点、没开减弱动态效果 → 走 container transform；变形用的几层（影子 / 底色 / 锚点克隆）常驻，只在变形途中显示
  // 窄屏（手机）不变形：抽屉从屏幕底滑上来，从输入框中间的芯片长成整宽抽屉又灰又乱、收回还抽一下（维护者 11-19）
  const morphCapable = untrack(() => !!anchorEl && !reducedMotion() && (typeof window === 'undefined' || window.innerWidth >= 600));
  let morphing = $state(morphCapable);
  // 走过 container transform 的弹层永远不再播 CSS 入场动画：形变结束摘掉 .morph 时，被它压住的
  // agy-pop-up（抽屉从屏幕底滑上来）/ agy-pop-in 会从头重播一遍 → 手机上菜单开完又往下一跳再滑上来
  let morphed = $state(morphCapable);

  $effect(() => pushBackLayer(() => close()));

  // 监听布局与滚动变化，使锚定弹层在侧栏/工作区开合或窗口缩放时实时跟紧触发按钮
  $effect(() => {
    const el = anchorEl;
    if (!el || typeof window === 'undefined') return;
    const bump = () => { geomTick++; };
    window.addEventListener('scroll', bump, { passive: true, capture: true });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(bump);
      ro.observe(document.documentElement);
      if (el.parentElement) ro.observe(el.parentElement);
    }
    return () => {
      window.removeEventListener('scroll', bump, { capture: true });
      ro?.disconnect();
    };
  });

  const liveRect = $derived.by(() => {
    void geomTick;
    void innerW;
    void innerH;
    if (anchorEl?.isConnected) {
      const r = anchorEl.getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    return anchor;
  });

  // 锚点在视口下半部 → 向上弹；在上半部 → 向下弹（欢迎态输入框居中偏上时向空间更大一侧展开）
  // cover：右缘对齐锚点、盖住锚点（外扩 5px，让那颗圆完整落在卡片的圆角里）
  const placement = $derived.by(() => {
    const r = liveRect;
    if (!r || narrow) return null;
    const w = Math.min(width, innerW - 24);
    let sat = 0;
    try { sat = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0; } catch {}
    if (cover) {
      const O = 5;
      const right = (r.left + (r.width || 0)) + O;
      const left = Math.max(12, Math.min(right - w, innerW - w - 12));
      const bottomEdge = (r.bottom ?? r.top) + O;
      const topEdge = r.top - O;
      if (topEdge - 12 - sat >= innerH - bottomEdge - 12) {
        return { left, width: w, bottom: innerH - bottomEdge, maxH: Math.max(180, bottomEdge - 12 - sat) };
      }
      return { left, width: w, top: topEdge, maxH: Math.max(180, innerH - topEdge - 12) };
    }
    const left = Math.max(12, Math.min(r.left, innerW - w - 12));
    const spaceAbove = r.top - 12 - sat;
    const spaceBelow = innerH - r.bottom - 12;
    if (spaceAbove >= spaceBelow) {
      return { left, width: w, bottom: innerH - r.top + 6, maxH: Math.max(180, spaceAbove - 6) };
    }
    return { left, width: w, top: r.bottom + 6, maxH: Math.max(180, spaceBelow - 6) };
  });

  // —— container transform ——
  const M = new Spring(0, 320, 1);
  let raf = 0, last = 0;
  let geo = null;           // 起点几何（相对卡片）：{ x0,y0,x1,y1, dy0, r0 }
  let canMorph = false;

  function anchorBox() {
    if (anchorEl?.isConnected) {
      const r = anchorEl.getBoundingClientRect();
      if (r.width && r.height) return r;
    }
    return null;
  }
  function cardBox() {
    if (!cardEl) return null;
    // offset* 不含 transform（容器平移由我们自己加），根是 fixed inset:0，所以就是视口坐标
    return { left: cardEl.offsetLeft, top: cardEl.offsetTop, width: cardEl.offsetWidth, height: cardEl.offsetHeight };
  }
  function radiusOf(el) {
    try {
      const cs = getComputedStyle(el);
      return parseFloat(cs.borderTopLeftRadius) || 0;
    } catch { return 0; }
  }

  // 起点：锚点矩形落在卡片坐标系里（fromBottom / fromRight：卡片尺寸途中变化时，起点跟着离锚点近的那条边走）；锚点在卡片外（芯片在卡片下方 / 上方）时，起点取卡片近锚点那条边上、
  // 和芯片同宽同高的一条，并把整个卡片先平移到让这条正好叠在芯片上，展开途中平移归零 → 视觉上就是芯片长成了菜单。
  function measure() {
    const a = anchorBox(), c = cardBox();
    if (!a || !c || !c.width || !c.height) return null;
    let x0 = Math.max(0, Math.min(c.width, a.left - c.left));
    let x1 = Math.max(0, Math.min(c.width, a.right - c.left));
    if (x1 - x0 < 12) { const mid = (x0 + x1) / 2; x0 = Math.max(0, mid - 6); x1 = Math.min(c.width, mid + 6); }
    let y0 = a.top - c.top, y1 = a.bottom - c.top, dy0 = 0;
    const h = Math.min(a.height, c.height);
    if (y0 >= c.height - 1) { dy0 = a.bottom - (c.top + c.height); y1 = c.height; y0 = c.height - h; }        // 卡片在锚点上方
    else if (y1 <= 1) { dy0 = a.top - c.top; y0 = 0; y1 = h; }                                                 // 卡片在锚点下方
    else { y0 = Math.max(0, y0); y1 = Math.min(c.height, y1); }
    const r0 = Math.min(radiusOf(anchorEl), (x1 - x0) / 2, (y1 - y0) / 2);
    const fromBottom = (y0 + y1) / 2 > c.height / 2;
    const fromRight = (x0 + x1) / 2 > c.width / 2;
    return { x0, y0, x1, y1, dy0, r0, a, c, fromBottom, fromRight };
  }

  function placeGhost() {
    const g = ghostEl?.firstElementChild;
    if (!g || !geo) return;
    g.style.left = (geo.a.left - geo.c.left) + 'px';
    g.style.top = (geo.dy0 ? geo.y0 : geo.a.top - geo.c.top) + 'px';
    g.style.width = geo.a.width + 'px';
    g.style.height = geo.a.height + 'px';
  }

  // 卡片四角的终点圆角（抽屉只有上两角）
  function endRadii() {
    if (!cardEl) return [13, 13, 13, 13];
    try {
      const cs = getComputedStyle(cardEl);
      return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0);
    } catch { return [13, 13, 13, 13]; }
  }
  let rEnd = [13, 13, 13, 13];

  // —— 效果通道：透明度按时间补间（emphasized 编排要的是「先后」，用进度当时钟会被弹簧的快起步压成一瞬）。
  // 换方向时从当前值重新起算，所以开到一半关也是连续的。t0 在第一帧落地时才定（跟 rAF 时间轴对齐）。
  const lin = (x) => x;
  const chan = (v) => ({ v, from: v, to: v, t0: null, delay: 0, dur: 1, ease: lin });
  const FX = { ghost: chan(1), skin: chan(1), body: chan(0), shadow: chan(0) };
  function aim(ch, to, delay, dur, ease = standard) {
    ch.from = ch.v; ch.to = to; ch.t0 = null; ch.delay = delay; ch.dur = dur; ch.ease = ease;
  }
  function tickFx(ts) {
    let busy = false;
    for (const k in FX) {
      const ch = FX[k];
      if (ch.t0 === null) ch.t0 = ts;
      const p = clamp01((ts - ch.t0 - ch.delay) / ch.dur);
      ch.v = ch.from + (ch.to - ch.from) * ch.ease(p);
      if (p < 1) busy = true;
    }
    return busy;
  }

  function paint() {
    if (!geo || !cardEl) return;
    const p = M.x;
    const e = clamp01(p);
    const c = cardBox();
    if (!c) return;
    // 卡片尺寸途中可能变（额度数据到了、下半段长高）：起点按比例跟着卡片走
    const W = c.width, H = c.height;
    const fx0 = geo.fromRight ? W - (geo.c.width - geo.x0) : geo.x0;
    const fx1 = geo.fromRight ? W - (geo.c.width - geo.x1) : geo.x1;
    const fy0 = geo.fromBottom ? H - (geo.c.height - geo.y0) : geo.y0;
    const fy1 = geo.fromBottom ? H - (geo.c.height - geo.y1) : geo.y1;
    const it = lerp(fy0, 0, e), il = lerp(fx0, 0, e), ir = lerp(W - fx1, 0, e), ib = lerp(H - fy1, 0, e);
    const rr = rEnd.map((r) => lerp(geo.r0, r, e).toFixed(2) + 'px').join(' ');
    const dy = lerp(geo.dy0, 0, e);
    cardEl.style.clipPath = `inset(${it.toFixed(2)}px ${ir.toFixed(2)}px ${ib.toFixed(2)}px ${il.toFixed(2)}px round ${rr})`;
    cardEl.style.transform = dy ? `translateY(${dy.toFixed(2)}px)` : '';
    if (shadowEl) {
      shadowEl.style.left = (c.left + il) + 'px';
      shadowEl.style.top = (c.top + it + dy) + 'px';
      shadowEl.style.width = Math.max(0, W - il - ir) + 'px';
      shadowEl.style.height = Math.max(0, H - it - ib) + 'px';
      shadowEl.style.borderRadius = rr;
      shadowEl.style.opacity = FX.shadow.v.toFixed(3);
    }
    if (ghostEl) {
      ghostEl.style.opacity = FX.ghost.v.toFixed(3);
      // 影子钉在锚点原位，不随卡片平移：卡片往上长走时它被裁掉，而不是被带着飘起来、看着像多出一个芯片
      // （影子按起点那一条摆在卡片里，卡片平移了 dy，再反向补 dy0 - dy 就始终叠在锚点上）
      const gy = geo.dy0 - dy;
      ghostEl.style.transform = gy ? `translateY(${gy.toFixed(2)}px)` : '';
    }
    if (skinEl) skinEl.style.opacity = FX.skin.v.toFixed(3);
    if (bodyEl) {
      const o = FX.body.v;
      bodyEl.style.opacity = o.toFixed(3);
      // 内容从锚点那一侧滑入（锚点在卡片下半 → 从下往上）
      const dir = geo.fromBottom ? 1 : -1;
      bodyEl.style.transform = o < 1 ? `translateY(${(dir * (1 - o) * 10).toFixed(2)}px)` : '';
    }
  }

  function clearMorphStyles() {
    if (cardEl) { cardEl.style.clipPath = ''; cardEl.style.transform = ''; }
    if (bodyEl) { bodyEl.style.opacity = ''; bodyEl.style.transform = ''; }
  }

  function loop(ts) {
    const dt = last ? (ts - last) / 1000 : 1 / 60;
    last = ts;
    stepAll([M], dt);
    const fxBusy = tickFx(ts);
    paint();
    if (M.settled(0.002) && !fxBusy) {
      raf = 0; last = 0;
      M.jump(M.target);
      paint();
      if (closing) { finalClose(); return; }
      morphing = false;
      clearMorphStyles();
      return;
    }
    raf = requestAnimationFrame(loop);
  }
  function run() { if (!raf) { last = 0; raf = requestAnimationFrame(loop); } }

  // 锚点的「影子」：克隆一份叠在卡片里锚点的位置。收回时重新克隆一次——选完模型 / 档位后芯片上的字已经变了，
  // 缩回去时淡回来的应当是新字，不然落地那一下会从旧名字跳成新名字。
  function makeGhost() {
    if (!ghostEl || !anchorEl) return;
    const g = anchorEl.cloneNode(true);
    g.classList.remove('on');
    g.removeAttribute('id');
    g.setAttribute('tabindex', '-1');
    Object.assign(g.style, { position: 'absolute', margin: '0', pointerEvents: 'none', transform: 'none' });
    // 锚点自己透明、底色在外层分组上（模型名 + 档位共用一块悬停底）：把那块底色垫到影子身后，
    // 第一帧芯片那一截才不会比旁边的档位暗一块
    if (!g.style.backgroundColor) {
      for (let el = anchorEl, i = 0; el && i < 3; el = el.parentElement, i++) {
        // 分组的悬停底带 140ms 过渡、此刻还在半路：先掐掉过渡读终值（它正被卡片盖着，跳到终值看不出来）
        const tr = el.style.transition;
        el.style.transition = 'none';
        const bc = getComputedStyle(el).backgroundColor;
        el.style.transition = tr;
        if (bc && bc !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bc)) {
          if (el !== anchorEl) { g.style.backgroundColor = bc; g.style.borderRadius = getComputedStyle(el).borderTopLeftRadius; }
          break;
        }
      }
    }
    ghostEl.replaceChildren(g);
    placeGhost();
  }

  // 卡片挂上后、首帧绘制之前起算（$effect 在 DOM 就位后、浏览器绘制前跑），第一帧就是锚点的形状
  onMount(() => {
    canMorph = morphCapable && (!!placement || narrow);
    if (canMorph && cardEl) geo = measure();
    if (!canMorph || !geo) { canMorph = false; morphing = false; morphed = false; return; }
    rEnd = endRadii();
    makeGhost();
    M.tune(300, 1).jump(0).to(1);
    aim(FX.ghost, 0, 0, 150, lin);
    aim(FX.skin, 0, 30, 240);
    aim(FX.body, 1, 120, 280, emphDecel);
    aim(FX.shadow, 1, 0, 300);
    tickFx(0);
    FX.ghost.t0 = FX.skin.t0 = FX.body.t0 = FX.shadow.t0 = null;
    paint();
    run();
  });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); raf = 0; });

  function finalClose() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    onClose?.();
  }

  /** 关闭（带收回锚点的动效）；父组件选完项也调它，而不是直接把弹层摘掉 */
  export function close() {
    if (closing) return;
    // 手机抽屉：顺着往下滑走再摘掉（CSS agy-pop-down），不再瞬间消失
    if (narrow && !canMorph && !dragging && !reducedMotion()) {
      closing = true;
      setTimeout(finalClose, 200);
      return;
    }
    if (!canMorph || !geo || !cardEl || reducedMotion() || dragging) { finalClose(); return; }
    // 锚点没了（输入框被换掉）就别往回缩了
    if (!anchorEl?.isConnected) { finalClose(); return; }
    closing = true;
    // 选项刚改了配置：等这一轮 DOM 更新落地（芯片换成新名字、宽度变了）再量、再克隆
    tick().then(() => {
      if (!cardEl) return;
      if (!anchorEl?.isConnected) { finalClose(); return; }
      // 收回前重新量一次：开着的这段时间里锚点 / 卡片可能挪过（窗口缩放、额度数据撑高了卡片）
      const g2 = measure();
      if (g2) geo = g2;
      makeGhost();
      rEnd = endRadii();
      morphing = true;
      M.tune(640, 1).to(0);
      aim(FX.body, 0, 0, 100, lin);
      aim(FX.skin, 1, 30, 170);
      aim(FX.ghost, 1, 100, 150);
      aim(FX.shadow, 0, 60, 200);
      paint();
      run();
    });
  }

  function menuRows() {
    if (!bodyEl) return [];
    return Array.from(bodyEl.querySelectorAll('button.agy-menu-row:not(:disabled)'));
  }

  function syncKbHighlight(nextIdx) {
    const rows = menuRows();
    if (!rows.length) return;
    const idx = ((nextIdx % rows.length) + rows.length) % rows.length;
    kbIdx = idx;
    rows.forEach((btn, i) => btn.classList.toggle('kb', i === idx));
    rows[idx]?.scrollIntoView?.({ block: 'nearest' });
  }

  function onKey(ev) {
    if (closing || locked) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const rows = menuRows();
      if (!rows.length) return;
      ev.preventDefault();
      const base = kbIdx < 0 ? rows.findIndex((b) => b.classList.contains('cur')) : kbIdx;
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      syncKbHighlight(base < 0 ? (step > 0 ? 0 : rows.length - 1) : base + step);
      return;
    }
    if (ev.key === 'Enter' && kbIdx >= 0) {
      const rows = menuRows();
      if (rows[kbIdx]) {
        ev.preventDefault();
        rows[kbIdx].click();
      }
    }
  }

  function onSheetTouchStart(ev) {
    if (!narrow || morphing || locked || ev.touches.length !== 1) { touchStartY = null; return; }
    if (scrollEl && scrollEl.scrollTop > 2 && !ev.target?.closest?.('.pop-grab, .pop-head')) {
      touchStartY = null;
      return;
    }
    touchStartY = ev.touches[0].clientY;
    dragging = false;
  }

  function onSheetTouchMove(ev) {
    if (locked || touchStartY === null || ev.touches.length !== 1) return;
    const dy = ev.touches[0].clientY - touchStartY;
    if (dy > 6) {
      dragging = true;
      dragY = Math.round(dy * 0.88);
    } else if (dragging) {
      dragY = 0;
    }
  }

  function onSheetTouchEnd() {
    if (touchStartY === null) return;
    touchStartY = null;
    const shouldClose = dragY > 76;
    dragging = false;
    // 下滑关闭：顺着手势滑走就好，不再缩回锚点
    if (shouldClose) { finalClose(); return; }
    dragY = 0;
  }
</script>

<svelte:window
  onresize={() => { innerW = window.innerWidth; innerH = window.innerHeight; }}
  onkeydown={onKey}
/>

<div class="agy-pop-root" class:sheet={narrow} class:dialog={!placement && !narrow} class:closing class:morph={morphing} class:morphed>
  <button type="button" class="agy-pop-scrim" aria-label={t('关闭')} onclick={close}></button>
  {#if morphCapable}<div class="agy-pop-shadow" bind:this={shadowEl} aria-hidden="true"></div>{/if}
  <div
    bind:this={cardEl}
    class="agy-pop-card"
    class:dragging
    role="dialog"
    aria-modal="true"
    aria-label={title}
    style:left={placement ? placement.left + 'px' : null}
    style:width={placement ? placement.width + 'px' : (!narrow ? Math.min(width, innerW - 32) + 'px' : null)}
    style:bottom={placement && placement.bottom !== undefined ? placement.bottom + 'px' : null}
    style:top={placement && placement.top !== undefined ? placement.top + 'px' : null}
    style:max-height={placement ? placement.maxH + 'px' : null}
    style:transform={narrow && dragY > 0 ? `translateY(${dragY}px)` : null}
    ontouchstart={onSheetTouchStart}
    ontouchmove={onSheetTouchMove}
    ontouchend={onSheetTouchEnd}
    ontouchcancel={onSheetTouchEnd}
  >
    {#if morphCapable}
      <div class="pop-skin" bind:this={skinEl} style:background={skin} aria-hidden="true"></div>
      <div class="pop-ghost" bind:this={ghostEl} aria-hidden="true" inert></div>
    {/if}
    <div class="pop-content" bind:this={bodyEl}>
      {#if narrow}<div class="pop-grab" aria-hidden="true"></div>{/if}
      {#if title && (narrow || !placement)}
        <div class="pop-head">
          <span>{title}</span>
          <!-- 抽屉有拖拽把手（下滑 / 点遮罩 / 返回键都能关），不再放关闭键；居中对话框才有 -->
          {#if !narrow}
            <button type="button" class="pop-x" onclick={close} aria-label={t('关闭')}>
              <span class="msr4">close</span>
            </button>
          {/if}
        </div>
      {/if}
      <div class="pop-body" bind:this={scrollEl}>
        {@render children?.()}
      </div>
    </div>
  </div>
</div>

<style>
  .agy-pop-root {
    position: fixed;
    inset: 0;
    z-index: 70;
  }
  .agy-pop-root.closing { pointer-events: none; }
  .agy-pop-scrim {
    position: absolute;
    inset: 0;
    background: transparent;
  }
  .sheet .agy-pop-scrim,
  .dialog .agy-pop-scrim {
    background: var(--ag-scrim);
    animation: agy-pop-fade var(--ag-dur-quick) var(--ag-ease-fade) both;
  }
  .sheet.closing .agy-pop-scrim {
    animation: agy-pop-unfade 0.24s cubic-bezier(0.3, 0, 0.8, 0.15) both;
  }
  /* 手机抽屉不压灰（维护者 11-19：灰色块看着乱）；遮罩只留透明的点外关闭，抽屉靠向上的阴影浮起来 */
  .sheet .agy-pop-scrim { background: transparent; animation: none; }

  .agy-pop-card {
    position: absolute;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: 13px;
    background: var(--ag-pop-bg);
    box-shadow: var(--ag-elev-shadow);
    color: var(--ag-on);
    overflow: hidden;
    animation: agy-pop-in var(--ag-dur-quick) var(--ag-ease-decel) both;
  }
  /* 变形途中：阴影交给外面那层跟着容器走的影子（clip-path 会把卡片自己的阴影一起裁掉），CSS 入场动画让位 */
  .morph .agy-pop-card {
    animation: none;
    box-shadow: none;
  }
  .agy-pop-shadow {
    position: absolute;
    pointer-events: none;
    box-shadow: var(--ag-elev-shadow);
  }
  .agy-pop-root:not(.morph) .agy-pop-shadow,
  .agy-pop-root:not(.morph) .pop-skin,
  .agy-pop-root:not(.morph) .pop-ghost { display: none; }
  .pop-skin,
  .pop-ghost {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
  }
  .pop-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .agy-pop-card.dragging {
    animation: none;
    transition: none;
  }
  .dialog .agy-pop-card {
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    max-height: min(640px, 80vh);
    animation: agy-pop-fade var(--ag-dur-quick) var(--ag-ease-fade) both;
  }
  .sheet .agy-pop-card {
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 82vh;
    border-radius: 28px 28px 0 0;
    padding-bottom: var(--sab, 0px);
    box-shadow: 0 -10px 36px -10px rgba(0, 0, 0, 0.28), var(--ag-elev-shadow);
    animation: agy-pop-up var(--ag-dur-base) var(--ag-ease-decel) both;
  }
  .sheet.closing .agy-pop-card { animation: agy-pop-down 0.2s cubic-bezier(0.3, 0, 0.8, 0.15) both; }
  .agy-pop-root.morphed .agy-pop-card { animation: none; }
  @keyframes agy-pop-in { from { opacity: 0; transform: translateY(4px) scale(0.985); } }
  @keyframes agy-pop-fade { from { opacity: 0; } }
  @keyframes agy-pop-unfade { to { opacity: 0; } }
  @keyframes agy-pop-up { from { transform: translateY(100%); } }
  @keyframes agy-pop-down { to { transform: translateY(100%); } }

  /* Material 3 拖拽把手：32×4、on-surface-variant 四成 */
  .pop-grab {
    width: 32px;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--ag-on-dim) 40%, transparent);
    margin: 14px auto 4px;
    flex: none;
  }
  .sheet .pop-head { padding: 10px 22px 8px; min-height: 30px; }
  .pop-head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 10px 6px 16px;
    font-size: 14.5px;
    font-weight: 550;
  }
  .pop-x {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .pop-x:hover { background: var(--ag-hover); color: var(--ag-on); }
  .pop-x .msr4 { font-size: 18px; }

  .pop-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 5px;
    scrollbar-width: thin;
  }
</style>
