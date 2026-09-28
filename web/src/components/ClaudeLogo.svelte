<script module>
  // 雪碧图缓存必须是【模块级】——之前定义在实例作用域，Thread 里每条消息一个 logo
  // 实例就各自重复 fetch 一遍同一组 SVG。全组件共享一份 in-flight/完成的 Promise。
  const stripCache = new Map();
  // 首次进入任何循环运行态时，顺手预取其余循环雪碧图（见 run）。否则相位切换
  // （如 thinking→orbiting）要现 fetch 新 strip，effect 清理已 cancel 旧动画，
  // 星标会冻住几百 ms。预取后切换在同一帧内完成。
  let loopsPreloaded = false;
</script>

<script>
  // Claude 星标（菊花）— vertical sprite strips played with the Web Animations API,
  // exactly as the reference logo-animations library. Strips live in
  // public/logo-animations/strips/<name>.svg (served under BASE_URL).
  // Color: paths have no fill, so the svg sets fill:currentColor — set `color` to tint.
  // `interactive`: tap plays the one-shot `tickle` easter-egg, then reverts.
  // NB: the prop is `anim`, NOT `state` (which collides with the $state rune).
  let { anim = 'static', size = 30, color = 'var(--coral)', interactive = false } = $props();

  const BASE = import.meta.env.BASE_URL;
  const ANIM = {
    static:   { file: 'tickle',   frames: 7,  speed: 40,  loop: false },
    entrance: { file: 'entrance', frames: 6,  speed: 70,  loop: false },
    exit:     { file: 'exit',     frames: 6,  speed: 70,  loop: false },
    tickle:   { file: 'tickle',   frames: 7,  speed: 40,  loop: false },
    thinking: { file: 'thinking', frames: 9,  speed: 90,  loop: true },
    writing:  { file: 'writing',  frames: 8,  speed: 90,  loop: true },
    waiting:  { file: 'waiting',  frames: 16, speed: 600, loop: true },
    orbiting: { file: 'orbiting', frames: 18, speed: 100, loop: true },
    shimmer:  { file: 'shimmer',  frames: 15, speed: 100, loop: true },
  };

  function loadStrip(file) {
    if (!stripCache.has(file)) stripCache.set(file, fetch(`${BASE}logo-animations/strips/${file}.svg`).then((r) => r.text()).catch(() => ''));
    return stripCache.get(file);
  }

  let inner = $state();
  let player = null;
  let playing = false; // a one-shot (tickle) is in flight; don't let the effect interrupt it
  let gen = 0;         // run() 代际：anim 快速切换时，慢加载的旧次完成后直接丢弃，不覆盖新动画

  const keyframes = (a) => Array.from({ length: a.frames }, (_, t) => ({ transform: `translateY(-${t * (100 / a.frames)}%)` }));

  async function run(name, once) {
    const g = ++gen;
    const a = ANIM[name] || ANIM.static;
    if (a.loop && !loopsPreloaded) {
      loopsPreloaded = true;
      for (const n of ['thinking', 'writing', 'orbiting', 'shimmer', 'waiting']) loadStrip(ANIM[n].file);
    }
    const svg = await loadStrip(a.file);
    if (g !== gen || !inner) return;
    inner.innerHTML = svg;
    if (player) { player.cancel(); player = null; }
    if (name === 'static') { inner.style.transform = 'translateY(0)'; playing = false; return; }
    player = inner.animate(keyframes(a), { duration: a.speed * a.frames, iterations: once ? 1 : (a.loop ? Infinity : 1), easing: `steps(${a.frames}, jump-none)` });
    if (once) { playing = true; player.onfinish = () => { playing = false; run(anim, false); }; }
  }

  function tickle() {
    // 循环运行态（thinking/writing/orbiting/shimmer/waiting）不接彩蛋：状态动画不被点断。
    if (!interactive || playing || (ANIM[anim] && ANIM[anim].loop)) return;
    run('tickle', true);
  }

  $effect(() => { const a = anim; if (!playing) run(a, false); return () => { if (player) player.cancel(); }; });
</script>

{#if interactive}
  <button class="clogo interactive" style="width:{size}px;height:{size}px;color:{color}" onclick={tickle} aria-label="Claude">
    <span class="strip" bind:this={inner}></span>
  </button>
{:else}
  <span class="clogo" style="width:{size}px;height:{size}px;color:{color}">
    <span class="strip" bind:this={inner}></span>
  </span>
{/if}

<style>
  .clogo { display: inline-block; overflow: hidden; line-height: 0; flex: none; padding: 0; border: none; background: none; }
  .clogo.interactive { cursor: pointer; }
  .strip { display: block; width: 100%; }
  .strip :global(svg) { display: block; width: 100%; height: auto; fill: currentColor; will-change: transform; }
  @media (max-resolution: 1.99dppx) { .clogo { clip-path: inset(.5px 0); } }
</style>
