<script>
  // Antigravity 分页长按 / 右键浮层菜单（Material 3 Expressive 动效语言）：
  //   · 传送挂载到最近的 .agy-root 下，避免被弹层 clip-path 或侧栏抽屉 transform 截断，同时继承双主题与紧凑档令牌；
  //   · 从按压点处弹簧展开（欠阻尼空间弹簧 + 临界淡入 + 逐行错峰），退场更快更干脆（非对称加速曲线）；
  //   · 支持触屏长按后不松手直接滑选（松在菜单外则保持打开待轻点），并支持桌面方向键 / Enter / Esc 与安卓返回键。
  //   · 条目图标：Material Symbols 名字；'claude' / 'agy' 画该 agent 的单色标志；svg（插件图标）原样画。
  //   · headPeers：这个文件夹带插件外观（共用）时，头部的文件夹图标换成头像组。
  import { onMount, onDestroy, tick } from 'svelte';
  import { pushBackLayer } from '../../lib/nav.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';
  import { Spring, stepAll } from '../../lib/agy/springs.js';
  import { clamp01, lerp, reducedMotion, emphDecel, emphAccel } from '../../lib/agy/motion.js';
  import { t } from '../../lib/i18n.js';
  import AgyPinIcon from './AgyPinIcon.svelte';
  import AgyPeerDuo from './AgyPeerDuo.svelte';
  import AgyClaudeThink from './AgyClaudeThink.svelte';
  import { agyLogoSvg } from '../../lib/agy/peer-marks.js';

  const {
    point = null,
    anchorEl = null,
    title = '',
    subtitle = '',
    items = [],
    pointerId = null,
    width = 236,
    headPeers = null,
    headBusy = [],
    onClose,
  } = $props();

  let rootEl = $state(null);
  let cardEl = $state(null);
  let scrimEl = $state(null);
  let itemEls = $state([]);
  let activeIdx = $state(-1);
  let closing = $state(false);
  let placed = $state({ left: 16, top: 16, width: 236, ox: 118, oy: 0, dir: 1 });

  // 传送挂载到 .agy-root（继承暗/亮主题与 .ag-compact），不建局部层叠陷阱
  function portalToAgyRoot(node) {
    const host = node.parentElement?.closest?.('.agy-root') || document.querySelector('.agy-root') || document.body;
    if (host && node.parentElement !== host) host.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
  }

  $effect(() => pushBackLayer(() => close()));

  const actionableIndices = () => items
    .map((it, idx) => (it && !it.sep && !it.disabled ? idx : -1))
    .filter((idx) => idx >= 0);

  function computePlacement() {
    if (typeof window === 'undefined') return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let sat = 0;
    let sab = 0;
    try {
      const cs = getComputedStyle(document.documentElement);
      sat = parseFloat(cs.getPropertyValue('--sat')) || 0;
      sab = parseFloat(cs.getPropertyValue('--sab')) || 0;
    } catch {}
    const margin = 12;
    const topBound = sat + margin;
    const botBound = vh - sab - margin;
    const w = Math.min(width, vw - margin * 2);
    const h = Math.max(88, cardEl?.offsetHeight || 156);

    let px = point?.x;
    let py = point?.y;
    if ((px == null || py == null) && anchorEl?.isConnected) {
      const r = anchorEl.getBoundingClientRect();
      px = r.left + r.width / 2;
      py = r.bottom;
    }
    if (px == null) px = vw / 2;
    if (py == null) py = vh / 2;

    const gap = 10;
    let top;
    let oy;
    let dir;
    if (py + gap + h <= botBound) {
      top = py + gap;
      oy = 0;
      dir = 1;
    } else if (py - gap - h >= topBound) {
      top = py - gap - h;
      oy = h;
      dir = -1;
    } else {
      top = Math.max(topBound, Math.min(py - h / 2, botBound - h));
      oy = Math.max(16, Math.min(h - 16, py - top));
      dir = oy > h / 2 ? -1 : 1;
    }

    const left = Math.max(margin, Math.min(px - w / 2, vw - margin - w));
    const ox = Math.max(18, Math.min(w - 18, px - left));
    placed = { left: Math.round(left), top: Math.round(top), width: Math.round(w), ox: Math.round(ox), oy: Math.round(oy), dir };
  }

  // —— M3 Expressive 弹簧进场 + 加速退场 ——
  const scaleSpring = new Spring(0, 560, 0.8);
  let raf = 0;
  let lastTs = 0;
  let phaseStart = 0;
  let mode = 'open'; // 'open' | 'close'
  let closeFromScale = 1;
  let closeFromOp = 1;
  let curScale = 0.84;
  let curOp = 0;

  function paintFrame(scaleVal, opVal, shiftY, scrimOp) {
    curScale = scaleVal;
    curOp = opVal;
    if (cardEl) {
      cardEl.style.transformOrigin = `${placed.ox}px ${placed.oy}px`;
      cardEl.style.transform = `translateY(${shiftY.toFixed(2)}px) scale(${scaleVal.toFixed(4)})`;
      cardEl.style.opacity = opVal.toFixed(4);
    }
    if (scrimEl) {
      scrimEl.style.opacity = scrimOp.toFixed(4);
    }
  }

  function animate(ts) {
    if (!phaseStart) phaseStart = ts;
    const dt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
    lastTs = ts;
    const elapsed = ts - phaseStart;

    if (mode === 'open') {
      stepAll([scaleSpring], dt);
      const s = scaleSpring.x;
      const sc = 0.84 + 0.16 * s;
      const shiftY = (1 - s) * placed.dir * -7;
      const op = emphDecel(clamp01(elapsed / 115));
      const scrimOp = emphDecel(clamp01(elapsed / 150));
      paintFrame(sc, op, shiftY, scrimOp);
      if (scaleSpring.settled(0.0015) && elapsed >= 150) {
        paintFrame(1, 1, 0, 1);
        raf = 0;
        lastTs = 0;
        return;
      }
    } else {
      const p = clamp01(elapsed / 125);
      const e = emphAccel(p);
      const sc = lerp(closeFromScale, 0.92, e);
      const op = lerp(closeFromOp, 0, e);
      const shiftY = e * placed.dir * -4;
      paintFrame(sc, op, shiftY, op);
      if (p >= 1) {
        raf = 0;
        lastTs = 0;
        onClose?.();
        return;
      }
    }
    raf = requestAnimationFrame(animate);
  }

  function startLoop() {
    if (!raf) {
      lastTs = 0;
      raf = requestAnimationFrame(animate);
    }
  }

  export function close() {
    if (closing) return;
    closing = true;
    if (reducedMotion() || !cardEl) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      onClose?.();
      return;
    }
    mode = 'close';
    phaseStart = 0;
    closeFromScale = curScale;
    closeFromOp = curOp;
    startLoop();
  }

  function pickIndex(idx) {
    const it = items[idx];
    if (!it || it.sep || it.disabled || closing) return;
    haptic('tick');
    close();
    it.onclick?.();
  }

  // —— 长按后不松手直接滑选 ——
  let glideId = null;

  function hitTestItem(clientX, clientY) {
    for (let i = 0; i < itemEls.length; i++) {
      const el = itemEls[i];
      const it = items[i];
      if (!el || !it || it.sep || it.disabled) continue;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left - 8 && clientX <= r.right + 8 && clientY >= r.top && clientY <= r.bottom) {
        return i;
      }
    }
    return -1;
  }

  function onGlideMove(ev) {
    if (glideId == null || ev.pointerId !== glideId || closing) return;
    const hit = hitTestItem(ev.clientX, ev.clientY);
    if (hit !== activeIdx) {
      if (hit >= 0) haptic('tick');
      activeIdx = hit;
    }
  }

  function onGlideUp(ev) {
    if (glideId == null || ev.pointerId !== glideId) return;
    glideId = null;
    const idx = activeIdx;
    if (ev.type === 'pointerup' && idx >= 0) {
      pickIndex(idx);
    } else {
      activeIdx = -1;
    }
  }

  // 捕获阶段截住键盘事件：Esc 只关当前浮层菜单，不把底下的工作空间弹层一并关掉
  function onKeyCapture(ev) {
    if (closing) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      close();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const valid = actionableIndices();
      if (!valid.length) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const pos = valid.indexOf(activeIdx);
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      const nextPos = pos < 0 ? (step > 0 ? 0 : valid.length - 1) : (pos + step + valid.length) % valid.length;
      activeIdx = valid[nextPos];
      itemEls[activeIdx]?.focus?.({ preventScroll: true });
      return;
    }
    if (ev.key === 'Enter' && activeIdx >= 0) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      pickIndex(activeIdx);
    }
  }

  onMount(() => {
    glideId = pointerId ?? null;
    tick().then(() => {
      computePlacement();
      if (reducedMotion()) {
        paintFrame(1, 1, 0, 1);
      } else {
        mode = 'open';
        phaseStart = 0;
        scaleSpring.jump(0).to(1);
        paintFrame(0.84, 0, placed.dir * -7, 0);
        startLoop();
      }
    });
    window.addEventListener('keydown', onKeyCapture, true);
    window.addEventListener('pointermove', onGlideMove, true);
    window.addEventListener('pointerup', onGlideUp, true);
    window.addEventListener('pointercancel', onGlideUp, true);
    window.addEventListener('resize', computePlacement);
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true);
      window.removeEventListener('pointermove', onGlideMove, true);
      window.removeEventListener('pointerup', onGlideUp, true);
      window.removeEventListener('pointercancel', onGlideUp, true);
      window.removeEventListener('resize', computePlacement);
    };
  });

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });
</script>

<div
  use:portalToAgyRoot
  bind:this={rootEl}
  class="agy-ctx-root"
  class:closing
  oncontextmenu={(e) => e.preventDefault()}
>
  <button
    type="button"
    class="agy-ctx-scrim"
    tabindex="-1"
    data-no-ripple
    bind:this={scrimEl}
    aria-label={t('关闭')}
    onpointerdown={(e) => { e.preventDefault(); close(); }}
  ></button>

  <div
    bind:this={cardEl}
    class="agy-ctx-card"
    role="menu"
    aria-label={title || t('工作空间操作')}
    style:left="{placed.left}px"
    style:top="{placed.top}px"
    style:width="{placed.width}px"
  >
    {#if title}
      <div class="ctx-head">
        {#if headPeers?.length}
          <AgyPeerDuo peers={headPeers} busy={headBusy} size={20} cut="var(--ag-pop-bg)" />
        {:else}
          <span class="msr4 ctx-head-ico" aria-hidden="true">folder</span>
        {/if}
        <span class="ctx-head-tx">
          <span class="ctx-head-name">{title}</span>
          {#if subtitle}<span class="ctx-head-sub">{subtitle}</span>{/if}
        </span>
      </div>
      <div class="ctx-sep" role="separator"></div>
    {/if}

    <div class="ctx-items">
      {#each items as it, i (it.sep ? 'sep-' + i : (it.id || it.label) + '-' + i)}
        {#if it.sep}
          <div class="ctx-sep" role="separator"></div>
        {:else}
          <button
            type="button"
            role="menuitem"
            class="ctx-row"
            class:danger={it.danger}
            class:on={activeIdx === i}
            disabled={it.disabled}
            style:--stagger="{Math.min(i, 4) * 24}ms"
            bind:this={itemEls[i]}
            onpointerenter={(e) => { if (e.pointerType === 'mouse') activeIdx = i; }}
            onpointerleave={(e) => { if (e.pointerType === 'mouse' && activeIdx === i) activeIdx = -1; }}
            onclick={() => pickIndex(i)}
          >
            <span class="ctx-ico" aria-hidden="true">
              {#if it.icon === 'pin'}
                <AgyPinIcon size={18} />
              {:else if it.icon === 'unpin'}
                <AgyPinIcon off size={18} />
              {:else if it.icon === 'claude'}
                <AgyClaudeThink live={false} size={15} />
              {:else if it.icon === 'agy'}
                <span class="ctx-mark">{@html agyLogoSvg(16, { mono: true })}</span>
              {:else if it.svg}
                <span class="ctx-svg">{@html it.svg}</span>
              {:else if it.icon}
                <span class="msr4">{it.icon}</span>
              {/if}
            </span>
            <span class="ctx-lbl">{it.label}</span>
          </button>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .agy-ctx-root {
    position: fixed;
    inset: 0;
    z-index: 90;
    user-select: none;
    -webkit-user-select: none;
  }
  .agy-ctx-root.closing {
    pointer-events: none;
  }

  .agy-ctx-scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.22);
    opacity: 0;
    cursor: default;
  }
  :global(.agy-root.light) .agy-ctx-scrim {
    background: rgba(32, 33, 36, 0.14);
  }

  .agy-ctx-card {
    position: fixed;
    border-radius: 14px;
    background: var(--ag-pop-bg);
    box-shadow: var(--ag-elev-shadow);
    color: var(--ag-on);
    overflow: hidden;
    will-change: transform, opacity;
  }
  :global(.agy-root.ag-compact) .agy-ctx-card {
    border-radius: 18px;
  }

  .ctx-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 14px 8px;
    min-width: 0;
  }
  .ctx-head-ico {
    font-size: 17px;
    color: var(--ag-on-faint);
    flex: none;
  }
  .ctx-head-tx {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ctx-head-name {
    font-size: 13px;
    font-weight: 540;
    color: var(--ag-on);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ctx-head-sub {
    font-size: 11.5px;
    color: var(--ag-on-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ctx-sep {
    height: 1px;
    margin: 3px 10px;
    background: var(--ag-divider);
  }

  .ctx-items {
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .ctx-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 7px 11px;
    border-radius: 9px;
    font-size: 13.5px;
    color: var(--ag-on);
    text-align: left;
    transition: background var(--ag-dur-micro) var(--ag-ease-std), color var(--ag-dur-micro) var(--ag-ease-std);
    animation: agy-ctx-row-in 190ms var(--ag-ease-decel) var(--stagger, 0ms) backwards;
  }
  @keyframes agy-ctx-row-in {
    from { opacity: 0; transform: translateY(4px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ctx-row { animation: none; }
  }

  .ctx-row.on,
  .ctx-row:focus-visible {
    background: var(--ag-hover);
    outline: none;
  }
  .ctx-row.danger {
    color: var(--ag-err);
  }
  .ctx-row.danger.on,
  .ctx-row.danger:focus-visible {
    background: var(--ag-err-bg);
  }

  .ctx-ico {
    width: 20px;
    height: 20px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .ctx-row.danger .ctx-ico {
    color: var(--ag-err);
  }
  .ctx-ico .msr4 {
    font-size: 18px;
  }
  .ctx-svg, .ctx-mark { display: grid; place-items: center; }
  .ctx-svg :global(svg) { width: 18px; height: 18px; }
  .ctx-mark :global(svg) { width: 16px; height: 16px; }
  .ctx-lbl {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 手机紧凑档：跟抽屉行高对齐，适合单指点按与滑选 */
  :global(.agy-root.ag-compact) .ctx-head {
    padding: 12px 16px 9px;
  }
  :global(.agy-root.ag-compact) .ctx-head-name {
    font-size: 14px;
  }
  :global(.agy-root.ag-compact) .ctx-head-sub {
    font-size: 12px;
  }
  :global(.agy-root.ag-compact) .ctx-items {
    padding: 6px;
    gap: 2px;
  }
  :global(.agy-root.ag-compact) .ctx-row {
    min-height: 44px;
    padding: 9px 14px;
    border-radius: 12px;
    font-size: 15px;
    gap: 12px;
  }
  :global(.agy-root.ag-compact) .ctx-ico .msr4 {
    font-size: 20px;
  }
</style>
