<script>
  // iOS 27 开关。
  // 长什么样 = kit「Toggle - Switch」：轨道 64×28 胶囊、内距 2、旋钮 38×24；按下时旋钮化成 58×38 的液态玻璃透镜
  //           （kit「Knob · Pressed」的 Glass Effect + Specular Light + 模糊环，对页面实时折射，lib/liquid/lens.js）。
  // 怎么动   = Kyant0 LiquidToggle：DampedDragAnimation 弹簧（value 1/1000、press 1/1000、放大 0.6·0.7/250）、
  //           拖动行程 22、速度拉伸（/50）、等滑到位再收回透镜、轨道颜色在 Oklab 里渐变。
  // 配色：墨色模式（设置页「墨与象牙」）开＝--i-accent（亮墨 / 暗象牙）、关＝--i-fill1，旋钮 --i-knob / --i-knob-on；
  //       其余调用方（工作空间）按 kit：关 --i-label3、开 --i-green，旋钮白。
  import { getContext, onMount, untrack } from 'svelte';
  import { Damped, register, wake, clamp, stretch, oklab, lerpOklab, cssVarColor } from '../../lib/liquid/core.js';
  import { KIT } from '../../lib/liquid/kit.js';
  import { PressedLens } from '../../lib/liquid/lens.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';

  // ink / dark：不在 ios27 上下文里的调用方（SToggle 的窄屏形态）可以直接指定，否则取上下文
  let { checked = false, disabled = false, onchange, label = '', ink: inkProp = undefined, dark: darkProp = undefined } = $props();
  const ios = getContext('ios27');
  const dark = $derived(darkProp ?? !!ios?.dark);
  const ink = $derived(inkProp ?? !!ios?.ink);

  const T = KIT.toggle;
  let host = $state();
  let track;
  // 控件对象（非响应式）：帧循环逐帧调 step / render，停稳后休眠
  const ctl = {
    d: new Damped(untrack(() => checked) ? 1 : 0, 1, [T.pressed[0] / T.knob[0], T.pressed[1] / T.knob[1]]),
    fraction: untrack(() => checked) ? 1 : 0,
    lens: null, cOff: null, cOn: null, kOff: null, kOn: null, lastV: -1,
    step(dt) { this.d.step(dt); },
    isIdle() { return this.d.idle; },
    render() {
      const d = this.d, v = clamp(d.value.x, 0, 1);
      if (Math.abs(v - this.lastV) > 1e-4 && this.cOff) {
        this.lastV = v;
        track.style.background = lerpOklab(this.cOff, this.cOn, v);
        this.lens.setSurface(lerpOklab(this.kOff, this.kOn, v));
      }
      const cx = T.pad + T.travel * d.value.x + T.knob[0] / 2, cy = T.h / 2;
      const [sx, sy] = stretch(d.sx.x, d.sy.x, d.vel.x / 50);
      this.lens.render(cx, cy, sx * T.knob[0] / T.pressed[0], sy * T.knob[1] / T.pressed[1], d.press.x);
    },
  };

  function readColors() {
    if (!host) return;
    const C = (n, f) => oklab(cssVarColor(host, n, f));
    if (ink) {
      // 没定义 --i-* 的宿主（Claude / Media Studio 的接入编辑器只定义了 --st-*）：开＝--st-accent、关＝--text 的 20%，
      // 开着的旋钮按轨道明暗取（象牙轨道配墨色钮，墨色轨道配白钮）
      const raw = (n) => cssVarColor(host, n, null);
      const on = raw('--i-accent') || raw('--st-accent') || [.11, .1, .09, 1];
      const tx = raw('--text');
      ctl.cOn = oklab(on);
      ctl.cOff = oklab(raw('--i-fill1') || (tx ? [tx[0], tx[1], tx[2], .2] : [.47, .47, .47, .2]));
      ctl.kOff = oklab(raw('--i-knob') || [1, 1, 1, 1]);
      ctl.kOn = oklab(raw('--i-knob-on') || (ctl.cOn[0] > .75 ? [.082, .078, .071, 1] : [1, 1, 1, 1]));
    } else {
      ctl.cOff = C('--i-label3', [.235, .235, .263, .3]); ctl.cOn = C('--i-green', [.204, .78, .349, 1]);
      ctl.kOff = ctl.kOn = oklab([1, 1, 1, 1]);
    }
    ctl.lastV = -1;
  }

  onMount(() => {
    ctl.lens = new PressedLens(host, 'toggle', T.pressed, { dark, surface: '#fff' });
    readColors();
    ctl.render();
    const off = register(ctl);
    return () => { off(); ctl.lens?.destroy(); };
  });
  // 换明暗 / 墨色：重读颜色、透镜按新明暗重建
  $effect(() => { dark; ink; untrack(() => { if (!ctl.lens) return; ctl.lens.setDark(dark); readColors(); wake(ctl); }); });

  // 受控：checked 由调用方决定。点按 / 拖完先按新状态乐观地滑过去（Kyant 的手感），调用方 600ms 内没跟上
  // （拒绝了、或异步还没回来又没置 disabled）就滑回 checked；调用方置了 disabled（忙）就等它忙完再对账。
  let pending = null;   // { want, until }
  let drag = null;
  function follow(c) {
    if (drag) return;
    const f = c ? 1 : 0;
    if (f !== ctl.fraction) { ctl.fraction = f; ctl.d.animateToValue(f); wake(ctl); }
  }
  function settle() {
    if (!pending) return follow(checked);
    if (checked === pending.want) { pending = null; return; }
    if (disabled || performance.now() < pending.until) return;
    pending = null; follow(checked);
  }
  $effect(() => { checked; disabled; untrack(settle); });
  function fire(want) {
    pending = { want, until: performance.now() + 600 };
    setTimeout(settle, 620);
    haptic('tick');
    onchange?.();
  }

  // Kyant：整个开关都接手势；按下即长出透镜，横向拖动跟手（行程 = 轨道 − 内距 − 旋钮），
  // 拖过就按落点归位、没拖就是点按翻转。竖向滑动交给页面滚动（touch-action: pan-y → pointercancel 不算点按）。
  function down(e) {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { host.setPointerCapture(e.pointerId); } catch {}
    drag = { id: e.pointerId, x: e.clientX, x0: e.clientX, did: false, from: ctl.fraction };
    ctl.d.doPress(); wake(ctl);
  }
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x; drag.x = e.clientX;
    if (!drag.did && Math.abs(e.clientX - drag.x0) > 4) drag.did = true;
    if (!drag.did) return;
    ctl.fraction = clamp(ctl.fraction + dx / T.travel, 0, 1);
    ctl.d.updateValue(ctl.fraction);
  }
  function end(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const g = drag; drag = null;
    if (e.type === 'pointercancel') {
      // 浏览器接管滚动：不算点按，滑回原位
      ctl.fraction = g.from; ctl.d.updateValue(ctl.fraction); ctl.d.doRelease(); wake(ctl);
      return;
    }
    const want = g.did ? ctl.d.value.t >= .5 : !checked;
    ctl.fraction = want ? 1 : 0;
    ctl.d.updateValue(ctl.fraction); ctl.d.doRelease(); wake(ctl);
    if (want !== checked) fire(want);
  }
  function key(e) {
    if (disabled || (e.key !== ' ' && e.key !== 'Enter')) return;
    e.preventDefault();
    const want = !checked;
    ctl.fraction = want ? 1 : 0; ctl.d.animateToValue(ctl.fraction); wake(ctl);
    fire(want);
  }
</script>

<button class="lqt" class:dis={disabled} type="button" role="switch" aria-checked={checked} aria-label={label} {disabled}
  bind:this={host} onpointerdown={down} onpointermove={move} onpointerup={end} onpointercancel={end} onkeydown={key}
  onclick={(e) => e.preventDefault()}>
  <span class="lqt-track" bind:this={track}></span>
</button>

<style>
  /* 宿主不建层叠上下文（不加 transform / opacity / isolation）：透镜玻璃要采得到轨道和底下的卡片。
     类名不用 .tg：好几处给旧的扁平开关（settings/SToggle）写了 :global(.tg) 的尺寸覆盖，会把这枚压扁 */
  .lqt {
    position: relative; flex: none; width: 64px; height: 28px; border-radius: 14px; padding: 0; border: 0; margin: 0;
    background: none; cursor: pointer; touch-action: pan-y; -webkit-tap-highlight-color: transparent; outline: none;
  }
  .lqt-track { position: absolute; inset: 0; border-radius: 14px; pointer-events: none; }
  /* 触屏命中区上下扩到 40 左右（视觉 28 高，手指按偏一点也算） */
  @media (pointer: coarse) { .lqt::after { content: ''; position: absolute; inset: -6px -4px; } }
  .lqt.dis { opacity: .5; cursor: default; }
  .lqt:focus-visible .lqt-track { box-shadow: 0 0 0 3px color-mix(in srgb, var(--i-accent, var(--i-blue, #0088ff)) 40%, transparent); }
</style>
