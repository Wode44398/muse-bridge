<script>
  // Codex 输入栏右下角的发送键（「让位」分叉）：同一颗键的几个样子靠同一条线索串起来，不加颜色、不加光。
  //   none   空着又没在跑：这一格让出去（0 宽），模型按钮顺势挪到最右；一打字从 0 宽弹出来，箭头从下面升上来
  //   ready  有字：黑芯从中心胀满；按下先往回收（蓄力），松手箭头从圆顶穿出去，带一道短残影
  //   busy   跑着：停止方块，跟对话里那颗小球同一个节奏呼吸
  //   steer  跑着又打了字：方块压扁成 Codex 的「_」，插话的箭头从横线上画出来（两翼同时画）
  // 每一下都从当前样子接着走（WAAPI 从此刻的值起），系统开了「减少动态效果」时只换样子不演。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { anim, EASE, reduced } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';

  let {
    st = 'none',           // none | ready | busy | steer
    touch = false,         // 触屏：不写按键提示
    onpress = null,        // 点一下：ready = 发送，busy = 停止，steer = 插话
    onqueue = null,        // 长按 / 右键（只在 steer）：稍后发送
  } = $props();

  let btn = $state(null);
  let arrow = $state(null);
  let trail = $state(null);
  let stopEl = $state(null);
  let steerIco = $state(null);
  let pressing = $state(false);
  let fly = $state(false);

  let launched = false;      // launch() 已经演了「发出去」，状态变成 busy 时别再演一遍
  let steered = false;
  let prev = untrack(() => st);
  let lpTimer = 0;
  let lpFired = false;

  const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘+⏎' : 'Ctrl+⏎';
  const busyish = $derived(st === 'busy' || st === 'steer');
  const label = $derived(
    st === 'steer' ? t('插话') : st === 'busy' ? t('停止') : t('发送'),
  );
  const title = $derived(
    st === 'steer'
      ? (touch ? t('插话 · 长按稍后发送') : t('插话：这一轮下一步就会读到（回车）· {key} 稍后发送', { key: modKey }))
      : st === 'busy' ? t('停止') : touch ? t('发送') : t('发送（回车）'),
  );

  function scaleOf(el) {
    try {
      const tf = getComputedStyle(el).transform;
      if (!tf || tf === 'none') return 1;
      const m = new DOMMatrixReadOnly(tf);
      return Math.hypot(m.a, m.b) || 1;
    } catch { return 1; }
  }

  // 两翼从杆顶同时画出来（箭头是一根杆 + 两条翼，翼各自 pathLength=1）
  function drawWings(delay = 0) {
    if (!arrow) return;
    for (const p of arrow.querySelectorAll('.ah')) anim(p, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { dur: 220, ease: EASE.out, delay });
  }

  // 让位 → 发送：键从 0 宽长出来（CSS 弹簧），箭头跟着从下面升上来、两翼张开
  function growIn() {
    anim(arrow, [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { dur: 380, ease: EASE.pop, delay: 70 });
    drawWings(170);
  }

  // 停止方块从中心转正长出来（别处发起的轮接上时、排队的那条开跑时）
  function popStop() {
    anim(stopEl, [{ transform: 'scale(0) rotate(-30deg)', opacity: 0, borderRadius: '5.5px' }, { transform: 'scale(1) rotate(0)', opacity: 1, borderRadius: '2.5px' }], { dur: 460, ease: EASE.pop });
    anim(btn, [{ transform: 'scale(.9)' }, { transform: 'scale(1.04)', offset: 0.4 }, { transform: 'scale(1)' }], { dur: 380, ease: EASE.out });
  }

  // 一轮收尾、输入框空着：方块从它此刻呼吸到的大小缩没，键随即收回 0 宽
  function shrinkStop() {
    const sc = scaleOf(stopEl);
    anim(stopEl, [{ transform: `scale(${sc})`, opacity: 1 }, { transform: 'scale(.3)', opacity: 0 }], { dur: 150, ease: EASE.in });
  }

  // 一轮收尾、输入框里有字：方块缩没，箭头落回来
  function landFx() {
    const sc = scaleOf(stopEl);
    anim(stopEl, [{ transform: `scale(${sc})`, opacity: 1 }, { transform: 'scale(.3)', opacity: 0 }], { dur: 140, ease: EASE.in });
    anim(arrow, [{ transform: 'translateY(9px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { dur: 380, ease: EASE.pop, delay: 90 });
  }

  function morph(from, to) {
    const k = from + '>' + to;
    if (to === 'busy' && from === 'ready') { if (launched) { launched = false; return; } popStop(); return; }
    if (to === 'busy' && from === 'steer') { steered = false; return; }   // 插话发出去那一下 steerFly 已演；或字删了，CSS 收回成方块
    if (to === 'busy' || (to === 'steer' && from !== 'busy')) { popStop(); return; }
    if (k === 'none>ready') { growIn(); return; }
    if (to === 'none' && (from === 'busy' || from === 'steer')) { shrinkStop(); return; }
    if (to === 'ready' && (from === 'busy' || from === 'steer')) { landFx(); return; }
  }

  $effect(() => {
    const s = st;
    const p = prev;
    prev = s;
    if (p === s || !btn) return;
    if (reduced()) { launched = steered = false; return; }
    untrack(() => morph(p, s));
  });

  /** 发出去：箭头从圆顶穿出去（键是圆形裁切，箭头不淡出、直接出画），带一道残影；停止方块从中心转正长出来。 */
  export function launch() {
    if (reduced() || !btn) return;
    launched = true;
    anim(arrow, [{ transform: 'translateY(1.6px)', opacity: 1 }, { transform: 'translateY(-24px)', opacity: 1 }], { dur: 210, ease: EASE.in });
    anim(trail, [{ opacity: 0, transform: 'translateY(6px) scaleY(.2)' }, { opacity: 0.5, transform: 'translateY(-2px) scaleY(1)', offset: 0.45 }, { opacity: 0, transform: 'translateY(-16px) scaleY(.4)' }], { dur: 280, ease: EASE.out, delay: 30 });
    anim(stopEl, [{ transform: 'scale(0) rotate(-30deg)', opacity: 0, borderRadius: '5.5px' }, { transform: 'scale(1) rotate(0)', opacity: 1, borderRadius: '2.5px' }], { dur: 460, ease: EASE.pop, delay: 130 });
    anim(btn, [{ transform: 'scale(.9)' }, { transform: 'scale(1.04)', offset: 0.4 }, { transform: 'scale(1)' }], { dur: 380, ease: EASE.out });
    // 万一这一下没发出去（被拦下），别让下一次变成 busy 时少演一遍
    setTimeout(() => { launched = false; }, 600);
  }

  /** 插话发出去：箭头从「_」上射出圆顶，横线留在原地，随后长回停止方块。 */
  export function steerFly() {
    if (reduced() || !steerIco) return;
    steered = true;
    fly = true;
    const paths = [...steerIco.querySelectorAll('path')];
    const a = anim(steerIco, [{ transform: 'translateY(1.6px)' }, { transform: 'translateY(-22px)' }], { dur: 200, ease: EASE.in, keep: true });
    const reset = () => {
      paths.forEach((p) => { p.style.transition = 'none'; p.style.strokeDashoffset = '1'; });
      try { a?.cancel(); } catch {}
      fly = false;
      requestAnimationFrame(() => paths.forEach((p) => { p.style.transition = ''; p.style.strokeDashoffset = ''; }));
    };
    if (a) a.finished.then(reset, () => { fly = false; });
    else reset();
    setTimeout(() => { steered = false; }, 600);
  }

  /** 键盘发的：屏幕上也按一下（先收，90ms 后再做 then）。 */
  export function press(then) {
    if (reduced()) { then?.(); return; }
    pressing = true;
    setTimeout(() => { pressing = false; then?.(); }, 90);
  }

  export function rect() {
    return btn?.getBoundingClientRect() || null;
  }

  function clearLp() { clearTimeout(lpTimer); lpTimer = 0; }

  function onDown(e) {
    if (e.button !== 0 || st === 'none') return;
    pressing = true;
    lpFired = false;
    clearLp();
    if (st === 'steer' && onqueue) {
      lpTimer = setTimeout(() => {
        lpTimer = 0;
        lpFired = true;
        pressing = false;
        haptic('tick');
        onqueue();
      }, 450);
    }
  }
  function onUp() { clearLp(); }
  function onLeave() { pressing = false; clearLp(); }
  function onClick() {
    pressing = false;
    clearLp();
    if (lpFired) { lpFired = false; return; }
    if (st === 'none') return;
    onpress?.(st);
  }
  function onContext(e) {
    if (st !== 'steer' || !onqueue) return;
    e.preventDefault();
    if (lpFired) return;
    clearLp();
    pressing = false;
    lpFired = !!touch;      // 触屏长按也会来一次 contextmenu：松手那一下不算点
    onqueue();
  }
</script>

<button
  bind:this={btn}
  type="button"
  class="send"
  class:ready={st === 'ready'}
  class:busy={busyish}
  class:steer={st === 'steer'}
  class:press={pressing}
  class:fly
  data-idle={st === 'none' ? 'none' : undefined}
  aria-label={label}
  aria-hidden={st === 'none' ? 'true' : undefined}
  tabindex={st === 'none' ? -1 : undefined}
  {title}
  onpointerdown={onDown}
  onpointerup={onUp}
  onpointerleave={onLeave}
  onpointercancel={onLeave}
  onclick={onClick}
  oncontextmenu={onContext}
>
  <span class="core"></span>
  <span class="trail" bind:this={trail}></span>
  <svg class="arrow" bind:this={arrow} viewBox="0 0 20 20" aria-hidden="true"><path class="as" d="M10 15.4V5.2"/><path class="ah" pathLength="1" d="M10 5L5.3 9.7"/><path class="ah" pathLength="1" d="M10 5L14.7 9.7"/></svg>
  <span class="stop" bind:this={stopEl}></span>
  <svg class="steer-ico" bind:this={steerIco} viewBox="0 0 20 20" aria-hidden="true"><path class="sh" pathLength="1" d="M10 13.2V5.6"/><path class="hd" pathLength="1" d="M10 5.3L6.2 9.1"/><path class="hd" pathLength="1" d="M10 5.3L13.8 9.1"/></svg>
</button>

<style>
  /* 让位：宽度和外边距也走弹簧，模型按钮跟着平滑挪位（theme.css 的 .send 只过渡 transform / 阴影 / 颜色） */
  :global(.cx .comp-bar .send) {
    -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; touch-action: manipulation;
    transition: transform calc(var(--k) * 260ms) var(--ease-out), box-shadow var(--d-2), color var(--d-3), background-color var(--d-2),
      width calc(var(--k) * 360ms) var(--sp-snap, var(--ease-out)), margin calc(var(--k) * 360ms) var(--sp-snap, var(--ease-out)), opacity calc(var(--k) * 160ms);
  }
  :global(.cx .comp-bar .send.press) { transition-duration: calc(var(--k) * 80ms), var(--d-2), var(--d-3), var(--d-2), calc(var(--k) * 360ms), calc(var(--k) * 360ms), calc(var(--k) * 160ms); }
  :global(.cx .comp-bar .send[data-idle="none"]) { width: 0; margin-left: -4px; opacity: 0; transform: scale(.5); pointer-events: none; }
  :global(.cx .send .arrow .ah) { stroke-dasharray: 1 1; stroke-dashoffset: 0; }
</style>
