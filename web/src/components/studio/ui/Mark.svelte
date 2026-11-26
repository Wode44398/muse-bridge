<script>
  // 「错拍」标会动的版本（方案 §12）：拱 + 水面 + 错开半拍的倒影，几何同 scripts/brand/studio-mark.cjs。
  // 它就是 Studio 的状态灯：
  //   idle  倒影在拱右边错开半拍，静止
  //   work  倒影一拍一拍往拱下面追（快追、慢退），拱在反拍上轻轻一沉——始终差半拍，读起来是节奏不是闪烁
  //   beat  每加 1 播一次「合拍」：倒影追上、滑到拱正下方、长到和拱一样大，接成一个整圆（bridge 的月桥），停一下再松回去
  // 只画 SVG 路径属性，不动布局；不在跑也不在合拍时不占 rAF。减少动态效果时一律静止。
  import { onDestroy } from 'svelte';
  import { reduced } from '../../../lib/motion.js';

  // 属性对外叫 state，组件里改名 mode：局部变量叫 state 时 $state() 会被当成「订阅 state 这个 store」，一挂就抛 store_invalid_shape
  let { state: mode = 'idle', beat = 0, size = 22, small = true, label = '' } = $props();

  const CX = 43.393, R0 = 14.95, RX0 = 70.3, RR0 = 11.96;
  const lw = $derived(small ? 2.6 : 1.6), rw = $derived(small ? 2.9 : 1.9);
  let arch = $state(), refl = $state();
  let raf = 0, t0 = performance.now(), m0 = -1, lastBeat = beat;

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const eOut = (t) => 1 - Math.pow(1 - t, 3);
  // 0→1 的欠阻尼弹簧（解析解）
  function springAt(t, k = 230, c = 22) {
    if (t <= 0) return 0;
    const w = Math.sqrt(k), z = c / (2 * w), wd = w * Math.sqrt(Math.max(1e-4, 1 - z * z));
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  }
  function paint(now) {
    if (!refl || !arch) return false;
    let x = RX0, r = RR0, op = 0.6, dip = 0, yk = 0, live = false;
    if (m0 >= 0) {
      const t = (now - m0) / 1000;
      const go = Math.min(1.08, Math.max(0, springAt(t))), back = t > 1.05 ? ease(Math.min(1, (t - 1.05) / 0.8)) : 0;
      const k = go * (1 - back);
      x = RX0 + (CX - RX0) * k; r = RR0 + (R0 - RR0) * k; op = 0.6 + 0.4 * Math.min(1, k); yk = Math.min(1, k);
      live = t < 1.9;
      if (!live) { m0 = -1; t0 = now; }
    } else if (mode === 'work') {
      const f = ((now - t0) % 1500) / 1500;
      const chase = f < 0.36 ? eOut(f / 0.36) : 1 - ease((f - 0.36) / 0.64);
      x = RX0 - 10.5 * chase; r = RR0 * (1 + 0.06 * chase); op = 0.6 + 0.18 * chase; yk = 0.2 * chase;
      dip = Math.max(0, Math.sin(((f + 0.5) % 1) * Math.PI * 2)) * 0.07;
      live = true;
    }
    // 合拍时倒影的两端贴上水面，和拱接成一个圆
    const y = 57.4 - 2.4 * yk;
    refl.setAttribute('d', `M${(x - r).toFixed(2)} ${y.toFixed(2)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 0 ${(x + r).toFixed(2)} ${y.toFixed(2)}`);
    refl.setAttribute('opacity', op.toFixed(3));
    arch.setAttribute('transform', dip ? `translate(0 ${(55 * dip).toFixed(2)}) scale(1 ${(1 - dip).toFixed(3)})` : '');
    return live;
  }
  function loop(now) { raf = 0; if (paint(now)) raf = requestAnimationFrame(loop); }
  function kick() { if (!raf && !reduced()) raf = requestAnimationFrame(loop); }

  $effect(() => {
    mode;
    if (beat !== lastBeat) { lastBeat = beat; if (!reduced()) m0 = performance.now(); }
    if (reduced()) { m0 = -1; paint(t0); return; }
    if (mode === 'work' && m0 < 0) t0 = performance.now();
    paint(performance.now());
    kick();
  });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });
</script>

<svg class="sd-mk" viewBox="21.9 22.4 61.2 61.2" width={size} height={size} fill="none" stroke="currentColor" stroke-linecap="round"
  role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}>
  <path bind:this={arch} d="M{CX - R0} 55A{R0} {R0} 0 0 1 {CX + R0} 55" stroke-width="5.5" stroke-linecap="butt" />
  <path d="M24.6 55H83.4" stroke-width={lw} />
  <path bind:this={refl} d="M{RX0 - RR0} 57.4A{RR0} {RR0} 0 0 0 {RX0 + RR0} 57.4" stroke-width={rw} opacity=".6" />
</svg>

<style>
  .sd-mk { display: block; flex: none; overflow: visible; }
</style>
