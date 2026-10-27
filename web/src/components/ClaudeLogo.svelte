<script module>
  // 条带缓存必须是【模块级】——Thread 里每条消息一个 logo 实例，不能各自重复取同一组条带。
  // 值是 Promise<{ url, ratio } | null>：条带取一次转成本页的 blob 地址当遮罩用（切换相位时同一帧就能换上），
  // ratio = 视框高 / 宽（条带的高按它算，和以前「宽占满、高随比例」的排法一致）。
  const stripCache = new Map();
  // 首次进入任何循环运行态时，顺手预取其余循环条带（见 run）。否则相位切换（如 thinking→orbiting）要现取新条带，
  // 星标会冻住几百 ms。预取后切换在同一帧内完成。
  let loopsPreloaded = false;
</script>

<script>
  // Claude 星标。
  // 公开版：静止 = Claude 的服务标志（LobeHub 版，MIT，lib/claudeMark.js）；运行动画 = 自绘星标 + CSS 关键帧（StarMark）。
  // 维护者的私有 overlay 带了原版竖向条带时（清单 data.marks.strips = { 名字: { file, frames, speed, loop } }，图在 overlay 的
  // logo-animations/strips/<file>.svg），用 Web Animations API 逐帧播条带。条带当 CSS 遮罩用（底色 = currentColor），
  // 不把取来的 SVG 塞进页面——离线壳跨源取到的东西只当图片用，不进 DOM。
  // `color` 给颜色；`interactive`：点一下播一次彩蛋（overlay 是 tickle 条带，公开版是轻轻一扭），然后回到原状态。
  // NB: the prop is `anim`, NOT `state` (which collides with the $state rune).
  import { ovData, ovUrl } from '../lib/overlay.svelte.js';
  import { CLAUDE_MARK_PATH } from '../lib/claudeMark.js';
  import StarMark from './StarMark.svelte';

  let { anim = 'static', size = 30, color = 'var(--coral)', interactive = false } = $props();

  const ANIM = $derived(ovData('marks')?.strips || null);
  // 公开版的动作映射（见 StarMark 顶部）
  const MODE = { entrance: 'enter', exit: 'exit', tickle: 'tickle', thinking: 'think', writing: 'work', waiting: 'wait', orbiting: 'tool', shimmer: 'wait' };

  function loadStrip(file) {
    if (!stripCache.has(file)) {
      stripCache.set(file, fetch(ovUrl(`logo-animations/strips/${file}.svg`))
        .then((r) => (r.ok ? r.text() : ''))
        .then((txt) => {
          const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(txt);
          if (!vb || !/<svg[\s>]/.test(txt)) return null;
          const ratio = Number(vb[2]) / Number(vb[1]);
          if (!(ratio > 0)) return null;
          // 条带原本是内联进页面用的，根元素可能没写 xmlns：单独当图片解析时没有它就不是 SVG，补上
          const svg = /<svg[^>]*\sxmlns=/.test(txt) ? txt : txt.replace(/<svg(?=[\s>])/, '<svg xmlns="http://www.w3.org/2000/svg"');
          return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), ratio };
        })
        .catch(() => null));
    }
    return stripCache.get(file);
  }

  let inner = $state();
  let player = null;
  let playing = false; // a one-shot (tickle) is in flight; don't let the effect interrupt it
  let gen = 0;         // run() 代际：anim 快速切换时，慢加载的旧次完成后直接丢弃，不覆盖新动画

  const keyframes = (n) => Array.from({ length: n }, (_, t) => ({ transform: `translateY(-${t * (100 / n)}%)` }));

  async function run(tbl, name, once) {
    const g = ++gen;
    const a = tbl[name] || tbl.static;
    if (!a) return;
    if (a.loop && !loopsPreloaded) {
      loopsPreloaded = true;
      for (const n of ['thinking', 'writing', 'orbiting', 'shimmer', 'waiting']) if (tbl[n]) loadStrip(tbl[n].file);
    }
    const sp = await loadStrip(a.file);
    if (g !== gen || !inner) return;
    const frames = Math.max(1, Number(a.frames) || 1);
    inner.style.height = (sp ? sp.ratio : frames) * 100 + '%';
    const m = sp ? `url("${sp.url}")` : 'none';
    inner.style.webkitMaskImage = m;
    inner.style.maskImage = m;
    if (player) { player.cancel(); player = null; }
    if (name === 'static') { inner.style.transform = 'translateY(0)'; playing = false; return; }
    player = inner.animate(keyframes(frames), { duration: a.speed * frames, iterations: once ? 1 : (a.loop ? Infinity : 1), easing: `steps(${frames}, jump-none)` });
    if (once) { playing = true; player.onfinish = () => { playing = false; run(tbl, anim, false); }; }
  }

  function tickle() {
    // 循环运行态（thinking/writing/orbiting/shimmer/waiting）不接彩蛋：状态动画不被点断。
    const tbl = ANIM;
    if (!tbl || !interactive || playing || (tbl[anim] && tbl[anim].loop)) return;
    run(tbl, 'tickle', true);
  }

  $effect(() => {
    const a = anim, tbl = ANIM, el = inner;
    if (!tbl || !el) return;
    if (!playing) run(tbl, a, false);
    return () => { if (player) player.cancel(); };
  });

  // 公开版静止标志的彩蛋：点一下扭一扭
  let wiggle = $state(false);
  function poke() {
    if (!interactive || wiggle) return;
    wiggle = true;
    setTimeout(() => { wiggle = false; }, 620);
  }
</script>

{#snippet mark()}
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"><path d={CLAUDE_MARK_PATH} /></svg>
{/snippet}

{#if !ANIM && anim === 'static'}
  {#if interactive}
    <button type="button" class="cmark" class:wiggle style="width:{size}px;height:{size}px;color:{color}" onclick={poke} aria-label="Claude">{@render mark()}</button>
  {:else}
    <span class="cmark" style="width:{size}px;height:{size}px;color:{color}" aria-hidden="true">{@render mark()}</span>
  {/if}
{:else if !ANIM}
  <StarMark mode={MODE[anim] || 'static'} {size} {color} {interactive} />
{:else if interactive}
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
  /* 条带：宽 = 方框，高按条带视框比例（run 里设）；底色跟 color，形状来自遮罩 */
  .strip { display: block; width: 100%; height: 100%; background: currentColor; will-change: transform;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; }
  @media (max-resolution: 1.99dppx) { .clogo { clip-path: inset(.5px 0); } }

  .cmark { display: inline-flex; align-items: center; justify-content: center; flex: none; line-height: 0; padding: 0; border: none; background: none; }
  button.cmark { cursor: pointer; }
  .cmark svg { display: block; fill: currentColor; }
  @media (prefers-reduced-motion: no-preference) {
    .cmark.wiggle svg { animation: cmark-wiggle .6s cubic-bezier(.36, .07, .19, .97); }
  }
  @keyframes cmark-wiggle {
    0%, 100% { transform: rotate(0); }
    20% { transform: rotate(-14deg) scale(1.04); }
    45% { transform: rotate(10deg); }
    70% { transform: rotate(-5deg); }
  }
</style>
