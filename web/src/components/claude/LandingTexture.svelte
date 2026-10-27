<script>
  // 新对话空态的背景层。
  // 公开版：一层静态的点阵底纹（自绘 CSS，中间输入区一带渐隐，不抢正文），淡入 600ms。
  // 维护者的私有 overlay 提供了动态底纹模块时（清单 modules.landingTexture：
  //   mountLandingTexture(el, onReady) → { setRunning(bool), destroy() }，可选导出 LANDING_FADE_IN_MS）改用它：
  //   画布真正就绪后才淡入，离开时 500ms 淡出；shown=false 时停帧，animate=false 时只画静帧。
  // 父元素要能收指针事件（模块可能要划过搅动、点击荡开波纹），且是定位容器。
  import { onDestroy } from 'svelte';
  import { ov, ovModule } from '../../lib/overlay.svelte.js';

  let { shown = true, animate = true } = $props();
  let el = $state(null);
  let mod = $state(undefined);   // undefined = 等 overlay 模块；null = 没有（走静态底纹）
  let ready = $state(false);
  let ctrl = null;
  // 清单里没有这个模块就不用等
  const expect = $derived(!ov.ready || !!(ov.on && ov.modules.landingTexture));

  $effect(() => {
    if (!expect) { mod = null; return; }
    let alive = true;
    ovModule('landingTexture').then((m) => { if (alive) mod = m && typeof m.mountLandingTexture === 'function' ? m : null; });
    return () => { alive = false; };
  });

  $effect(() => {
    if (!mod || !el || ctrl || !shown) return;
    try { ctrl = mod.mountLandingTexture(el, () => { ready = true; }); } catch { ctrl = null; }
    // 模块是异步到的：下面那个 effect 首轮跑时 ctrl 还是空的、之后也不会因 ctrl 重跑（ctrl 不是 $state），
    // 挂上就得在这里把开关拨到位——模块默认是关的，不拨就一直停在静帧（state=still）。
    ctrl?.setRunning(shown && animate);
  });
  $effect(() => {
    const run = shown && animate;
    if (ctrl) ctrl.setRunning(run);
    if (!shown && !ready && ctrl) { ctrl.destroy(); ctrl = null; }
  });
  onDestroy(() => { try { ctrl?.destroy(); } catch {} ctrl = null; });

  const fadeIn = $derived(mod ? Number(mod.LANDING_FADE_IN_MS) || 3000 : 600);
  const visible = $derived(shown && (mod ? ready : mod === null));
</script>

{#if mod}
  <div bind:this={el} class="landing-texture" aria-hidden="true"
    style:opacity={visible ? 1 : 0} style:transition-duration={(visible ? fadeIn : 500) + 'ms'}></div>
{:else}
  <div class="landing-texture dots" aria-hidden="true"
    style:opacity={visible ? 1 : 0} style:transition-duration={(visible ? fadeIn : 500) + 'ms'}></div>
{/if}

<style>
  /* 字色 暗 #c3c2b7 / 亮 #52514e：动态模块按它画字、按 color-scheme 选配色；字体用系统等宽栈。 */
  .landing-texture { position: absolute; inset: 0; pointer-events: none; contain: strict; z-index: 0;
    transition-property: opacity; transition-timing-function: ease-out;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    color: #c3c2b7; color-scheme: dark; }
  :global(html[data-theme="light"]) .landing-texture { color: #52514e; color-scheme: light; }

  /* 公开版静态底纹：14px 点阵，四周与中部输入区渐隐 */
  .dots {
    background-image: radial-gradient(circle at center, color-mix(in srgb, currentColor 26%, transparent) 0 1px, transparent 1.4px);
    background-size: 14px 14px;
    background-position: center;
    -webkit-mask-image: radial-gradient(ellipse 46% 30% at 50% 58%, transparent 0 55%, #000 100%), radial-gradient(ellipse 80% 70% at 50% 50%, #000 40%, transparent 100%);
    -webkit-mask-composite: source-in;
    mask-image: radial-gradient(ellipse 46% 30% at 50% 58%, transparent 0 55%, #000 100%), radial-gradient(ellipse 80% 70% at 50% 50%, #000 40%, transparent 100%);
    mask-composite: intersect;
  }
</style>
