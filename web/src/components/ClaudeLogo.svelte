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
  // Claude 星标：原版竖向条带（清单 data.marks.strips = { 名字: { file, frames, speed, loop } }，
  // 图在 logo-animations/strips/<file>.svg），用 Web Animations API 逐帧播；静止 = static 条带第 0 帧。
  // 条带当 CSS 遮罩用（底色 = currentColor），不把取来的 SVG 塞进页面。
  // `color` 给颜色；`interactive`：点一下播一次 tickle 彩蛋，然后回到原状态。
  // `onpress(el)`：点击时额外回调，参数是标志按钮本身（Claude 页拿它当明暗换场的波心；运行态点了也照样触发，只是不播彩蛋）。
  // NB: the prop is `anim`, NOT `state` (which collides with the $state rune).
  import { ovData, ovUrl } from '../lib/overlay.svelte.js';

  let { anim = 'static', size = 30, color = 'var(--coral)', interactive = false, onpress = null } = $props();

  const ANIM = $derived(ovData('marks')?.strips || null);

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

  function tickle(e) {
    onpress?.(e?.currentTarget ?? null);
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
  /* 条带：宽 = 方框，高按条带视框比例（run 里设）；底色跟 color，形状来自遮罩 */
  .strip { display: block; width: 100%; height: 100%; background: currentColor; will-change: transform;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; }
  @media (max-resolution: 1.99dppx) { .clogo { clip-path: inset(.5px 0); } }
</style>
