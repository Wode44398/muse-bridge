<script>
  // iOS 27 分段控件。
  // 长什么样 = kit「Segmented Control」：底 Fills/Tertiary 胶囊、内距 2、段间距 4；选中段白色胶囊（暗色 白 27%）
  //           + 投影 0/2/20 黑 6%（CSS 模糊 2σ=16.9）；字 13.33 Semibold（选中）/ Medium。Large 高 50（段 46）、Small 高 32（段 28）。
  // 怎么动   = 同 Tab 栏指示器（Kyant0 LiquidBottomTabs 那套 DampedDragAnimation）：按住选中胶囊可拖动、松手吸到最近一段；
  //           点别的段＝animateToValue（按下 → 滑过去 → 到位松开）；按下 / 滑动途中胶囊化成液态玻璃透镜（lens.js 'indicator'，
  //           kit 没有分段按下态，借开关 / 滑块按下态的玻璃配方），放大 78/56、速度拉伸 /10。
  import { getContext, onMount, untrack } from 'svelte';
  import { Damped, register, wake, clamp, stretch } from '../../lib/liquid/core.js';
  import { PressedLens } from '../../lib/liquid/lens.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';

  let { options = [], value, onchange, size = 'large', disabled = false, label = '' } = $props();
  const idx = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
  const n = $derived(Math.max(1, options.length));
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);

  const K = 78 / 56, GAP = 4, PAD = 2;
  let host = $state(), pill;
  const ctl = {
    d: new Damped(untrack(() => idx), Math.max(1, untrack(() => n) - 1), [K, K]),
    lens: null, W: 0, H: 0, pw: 0, ph: 0, index: untrack(() => idx),
    geom() { const N = untrack(() => n); this.pw = (this.W - 2 * PAD - (N - 1) * GAP) / N; this.ph = this.H - 2 * PAD; },
    step(dt) { this.d.step(dt); },
    isIdle() { return this.d.idle; },
    render() {
      if (!this.W || !pill) return;
      const d = this.d, p = clamp(d.press.x, 0, 1);
      const [sx, sy] = stretch(d.sx.x, d.sy.x, d.vel.x / 10);
      const x = PAD + d.value.x * (this.pw + GAP);
      pill.style.transform = `translateX(${x.toFixed(3)}px) scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`;
      pill.style.opacity = (1 - p).toFixed(4);   // 胶囊表面 alpha = 1 − 按下进度（Kyant 指示器）
      this.lens?.render(x + this.pw / 2, PAD + this.ph / 2, sx / K, sy / K, p);
    },
  };
  function layout() {
    if (!host) return;
    ctl.W = host.clientWidth; ctl.H = host.clientHeight;
    const ow = ctl.pw, oh = ctl.ph;
    ctl.geom();
    ctl.d.max = Math.max(1, n - 1);
    pill.style.width = ctl.pw + 'px';
    if ((Math.abs(ow - ctl.pw) > .5 || Math.abs(oh - ctl.ph) > .5) && ctl.pw > 0) {
      ctl.lens?.destroy();
      ctl.lens = new PressedLens(host, 'indicator', [ctl.pw * K, ctl.ph * K], { solid: false, dark });
    }
    wake(ctl);
  }
  onMount(() => {
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    const off = register(ctl);
    return () => { off(); ro.disconnect(); ctl.lens?.destroy(); };
  });
  $effect(() => { dark; untrack(() => { ctl.lens?.setDark(dark); wake(ctl); }); });
  $effect(() => { n; untrack(layout); });
  // 受控：调用方改了选中就滑过去；自己选的调用方没跟上（拒绝了）就滑回
  $effect(() => {
    const i = idx;
    untrack(() => { ctl.index = i; if (!drag && Math.abs(ctl.d.value.t - i) > 1e-4) { ctl.d.animateToValue(i); wake(ctl); } });
  });
  function choose(i) {
    i = clamp(i, 0, n - 1);
    ctl.d.animateToValue(i); wake(ctl);
    const o = options[i];
    if (!o || o.value === value) return;
    haptic('tick');
    onchange?.(o.value);
    setTimeout(() => { if (!drag && Math.abs(ctl.d.value.t - ctl.index) > 1e-4) { ctl.d.animateToValue(ctl.index); wake(ctl); } }, 320);
  }

  let drag = null;
  function down(e) {
    if (disabled || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const r = host.getBoundingClientRect(), x = (e.clientX - r.left) * ctl.W / Math.max(1, r.width);
    const left = PAD + ctl.d.value.x * (ctl.pw + GAP);
    if (x >= left && x <= left + ctl.pw) {
      try { host.setPointerCapture(e.pointerId); } catch {}
      drag = { id: e.pointerId, x: e.clientX, x0: e.clientX, mode: 'drag' };
      ctl.d.doPress(); wake(ctl);
    } else {
      drag = { id: e.pointerId, x0: e.clientX, mode: 'tap', seg: clamp(Math.floor((x - PAD + GAP / 2) / (ctl.pw + GAP)), 0, n - 1) };
    }
  }
  function move(e) {
    if (!drag || e.pointerId !== drag.id || drag.mode !== 'drag') return;
    const dx = e.clientX - drag.x; drag.x = e.clientX;
    ctl.d.updateValue(ctl.d.value.t + dx / Math.max(1, ctl.pw + GAP));
  }
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const g = drag; drag = null;
    if (g.mode === 'drag') {
      if (e.type === 'pointercancel') { ctl.d.updateValue(ctl.index); ctl.d.doRelease(); wake(ctl); return; }
      ctl.d.doRelease();
      choose(Math.round(ctl.d.value.t));
    } else if (e.type === 'pointerup' && Math.abs(e.clientX - g.x0) < 10) choose(g.seg);
  }
</script>

<!-- 指针手势挂在整条控件上（段按钮只给键盘用，焦点在每个 radio 按钮上）；宿主不建层叠上下文，透镜玻璃要采得到底下的卡片 -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="seg {size}" class:dis={disabled} role="radiogroup" aria-label={label} style:--n={n} bind:this={host}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
  <span class="pill" bind:this={pill}></span>
  {#each options as o, i (o.value)}
    <button type="button" class="opt" class:on={o.value === value} role="radio" aria-checked={o.value === value}
      {disabled} onclick={(e) => { if (e.detail === 0) choose(i); }}>{o.label}</button>
  {/each}
</div>

<style>
  .seg {
    position: relative; display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 4px; padding: 2px;
    border-radius: 999px; background: var(--i-fill3); -webkit-tap-highlight-color: transparent; touch-action: pan-y; cursor: pointer;
    user-select: none; -webkit-user-select: none;
  }
  .seg.large { height: 50px; }
  .seg.small { height: 32px; }
  .seg.dis { opacity: .45; pointer-events: none; }
  .pill {
    position: absolute; left: 0; top: 2px; bottom: 2px; width: calc((100% - 4px - (var(--n) - 1) * 4px) / var(--n));
    border-radius: 999px; background: var(--i-seg-sel); box-shadow: 0 2px 16.9px rgba(0, 0, 0, .06);
    transform: translateX(2px); transform-origin: 50% 50%; pointer-events: none;
  }
  .opt {
    position: relative; z-index: 1; min-width: 0; border: 0; background: none; padding: 3px 6px; cursor: pointer;
    font: inherit; font-size: 13.33px; line-height: 18px; font-weight: 500; letter-spacing: -.08px; color: var(--i-label);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 999px; pointer-events: none;
  }
  .opt.on { font-weight: 600; }
  .opt:focus-visible { outline: 2px solid color-mix(in srgb, var(--i-accent, var(--i-blue, #0088ff)) 55%, transparent); outline-offset: -2px; }
</style>
