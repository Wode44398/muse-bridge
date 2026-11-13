<script>
  // iOS 27 滑块。
  // 长什么样 = kit「Sliders」：轨道 6 高、圆角 3（Fills/Primary），填充（强调色）画到旋钮中心；旋钮 38×24 白色胶囊 +
  //           两道投影（0/6/13 与 0/0.5/4 黑 12%）、中心落在 [19, 宽−19]；拖动时旋钮化成 57×38 的液态玻璃透镜（lens.js）。
  // 怎么动   = Kyant0 LiquidSlider：DampedDragAnimation（value 1/1000 跟手、press 1/1000、放大 0.6·0.7/250）、
  //           速度拉伸（/10）、松手等旋钮到位才收回透镜；点轨道 / 键盘＝animateToValue（不跟踪速度、不拉伸）。
  // 手势：触屏照 iOS 原生——只有按在旋钮上、并且先横向拖开才算拖动，按轨道别处不跳值，竖向滑动交给页面滚动
  // （设置页一屏十根滑条，手指想滚页面就改了参数、从左缘做返回手势正好落在最小值，这些坑都在旧版修过）。鼠标点哪跳哪。
  import { getContext, onMount, untrack } from 'svelte';
  import { Damped, register, wake, clamp, stretch } from '../../lib/liquid/core.js';
  import { KIT } from '../../lib/liquid/kit.js';
  import { cssShadow } from '../../lib/liquid/glass.js';
  import { PressedLens } from '../../lib/liquid/lens.js';

  let { value = 0, disabled = false, oninput, onstart, onend, label = '' } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);

  const S = KIT.slider, KW = S.knob[0], KH = S.knob[1], CY = 22;
  let host = $state();
  let fill, shadow;
  let W = 0;
  const v0 = clamp(untrack(() => value) || 0, 0, 1);
  const ctl = {
    d: new Damped(v0, 1, [S.pressed[0] / KW, S.pressed[1] / KH]),
    lens: null,
    step(dt) { this.d.step(dt); },
    isIdle() { return this.d.idle; },
    render() {
      const d = this.d, cx = KW / 2 + clamp(d.value.x, 0, 1) * Math.max(0, W - KW);
      fill.style.width = cx.toFixed(2) + 'px';
      const [sx, sy] = stretch(d.sx.x, d.sy.x, d.vel.x / 10);
      const p = clamp(d.press.x, 0, 1);
      shadow.style.transform = `translate(${(cx - KW / 2).toFixed(3)}px, ${(CY - KH / 2).toFixed(3)}px) scale(${sx.toFixed(5)}, ${sy.toFixed(5)})`;
      shadow.style.opacity = (1 - p).toFixed(4);   // kit：静止旋钮的两道投影，按下态没有
      this.lens.render(cx, CY, sx * KW / S.pressed[0], sy * KH / S.pressed[1], d.press.x);
    },
  };

  onMount(() => {
    shadow.style.boxShadow = KIT.sliderKnobShadows.map(cssShadow).join(', ');
    ctl.lens = new PressedLens(host, 'slider', S.pressed, { dark, surface: '#fff' });
    W = host.clientWidth;
    const ro = new ResizeObserver(() => { W = host.clientWidth; wake(ctl); });
    ro.observe(host);
    ctl.render();
    const off = register(ctl);
    return () => { off(); ro.disconnect(); ctl.lens?.destroy(); };
  });
  $effect(() => { dark; untrack(() => { ctl.lens?.setDark(dark); wake(ctl); }); });
  // 受控：调用方改了 value（不是自己拖出来的回声）就滑过去，不出透镜
  $effect(() => {
    const v = clamp(value || 0, 0, 1);
    untrack(() => { if (!drag && Math.abs(v - ctl.d.value.t) > 1e-4) { ctl.d.value.t = v; ctl.d.tracking = false; wake(ctl); } });
  });

  const span = () => Math.max(1, W - KW);
  const at = (e) => clamp((e.clientX - host.getBoundingClientRect().left - KW / 2) / span(), 0, 1);
  const knobX = () => KW / 2 + clamp(ctl.d.value.x, 0, 1) * Math.max(0, W - KW);
  let drag = null;   // { id, x0, y0, v0, live }
  function begin(e) {
    drag.live = true;
    try { host.setPointerCapture(e.pointerId); } catch {}
    ctl.d.doPress(); wake(ctl);
    onstart?.();
  }
  function down(e) {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'touch') {
      if (Math.abs(e.clientX - host.getBoundingClientRect().left - knobX()) > 30) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: ctl.d.value.t, live: false };
      return;
    }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: at(e), live: false };
    begin(e);
    ctl.d.updateValue(drag.v0); oninput?.(drag.v0);
  }
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.live) {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) return;
      begin(e);
    }
    const v = clamp(drag.v0 + (e.clientX - drag.x0) / span(), 0, 1);
    ctl.d.updateValue(v); oninput?.(v);
  }
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const live = drag.live; drag = null;
    if (!live) return;
    ctl.d.doRelease(); wake(ctl);
    onend?.();
  }
  function key(e) {
    if (disabled) return;
    const step = e.shiftKey ? .1 : .02;
    const s = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step }[e.key];
    if (s == null) return;
    e.preventDefault();
    const v = clamp(ctl.d.value.t + s, 0, 1);
    ctl.d.animateToValue(v); wake(ctl); oninput?.(v); onend?.();
  }
</script>

<div class="sl" class:dis={disabled} bind:this={host} role="slider" tabindex={disabled ? -1 : 0}
  aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(clamp(value || 0, 0, 1) * 100)} aria-disabled={disabled}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={key}>
  <span class="track"></span>
  <span class="fill" bind:this={fill}></span>
  <span class="kshadow" bind:this={shadow}></span>
</div>

<style>
  /* 宿主不建层叠上下文：透镜玻璃要采得到轨道和底下的卡片 */
  .sl { position: relative; height: 44px; width: 100%; touch-action: pan-y; cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent; }
  .sl.dis { opacity: .45; cursor: default; }
  .track, .fill { position: absolute; left: 0; top: 19px; height: 6px; border-radius: 3px; pointer-events: none; }
  .track { right: 0; background: var(--i-fill1); }
  .fill { width: 19px; background: var(--i-accent, var(--i-blue)); }
  .kshadow { position: absolute; left: 0; top: 0; width: 38px; height: 24px; border-radius: 12px; transform-origin: 19px 12px; pointer-events: none; }
  .sl:focus-visible .track { box-shadow: 0 0 0 3px color-mix(in srgb, var(--i-accent, var(--i-blue, #0088ff)) 35%, transparent); }
</style>
