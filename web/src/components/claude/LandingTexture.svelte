<script>
  // 新对话空态的背景层：原版动态底纹（visuals/modules/landing-texture.js，懒加载：
  //   mountLandingTexture(el, onReady) → { setRunning(bool), destroy() }，可选导出 LANDING_FADE_IN_MS）。
  //   画布真正就绪后才淡入，离开时 500ms 淡出；shown=false 时停帧，animate=false 时只画静帧。
  // 父元素要能收指针事件（模块可能要划过搅动、点击荡开波纹），且是定位容器。
  import { onDestroy } from 'svelte';

  let { shown = true, animate = true } = $props();
  let el = $state(null);
  let mod = $state(null);
  let ready = $state(false);
  let ctrl = null;

  $effect(() => {
    let alive = true;
    import('../../visuals/modules/landing-texture.js').then((m) => { if (alive) mod = m; });
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

  const fadeIn = $derived(mod ? Number(mod.LANDING_FADE_IN_MS) || 3000 : 3000);
  const visible = $derived(shown && !!mod && ready);
</script>

{#if mod}
  <div bind:this={el} class="landing-texture" aria-hidden="true"
    style:opacity={visible ? 1 : 0} style:transition-duration={(visible ? fadeIn : 500) + 'ms'}></div>
{/if}

<style>
  /* 字色＝官方 muted-as-secondary（fizzy-lake）：暗 #ffffff91 / 亮 #0009，模块按 rgba 取墨色与透明度；动态模块按它画字、按 color-scheme 选配色；字体用系统等宽栈。 */
  .landing-texture { position: absolute; inset: 0; pointer-events: none; contain: strict; z-index: 0;
    transition-property: opacity; transition-timing-function: ease-out;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    color: rgba(255,255,255,.57); color-scheme: dark; }
  :global(html[data-theme="light"]) .landing-texture { color: rgba(0,0,0,.6); color-scheme: light; }
</style>
