<script>
  // 首页标志：Codex 桌面版首页那枚单色线稿云朵 `>_`，连同它的官方交互（方案 3.2）。
  //   静态：56px，前景色 30%，悬停 40%（CSS）。
  //   悬停（只认鼠标、减少动态效果时不播）：随机播「打招呼」或「加载」一段官方 Lottie，播完回静态；正在播时再进不重来。
  //   按下（松手那一下）：整朵云逆时针转一圈、放大到 1.18（弹簧 0.55s / 回弹 0.15），到位后缩回 1；
  //     连点从当前角度接着转（先把正在跑的那段定格成样式再接）。
  //   nod()：换项目时很轻地点一下头。
  import { onMount } from 'svelte';
  import { mountLottie } from '../../lib/codex/assets.js';
  import { anim, EASE, reduced } from '../../lib/codex/motion.js';

  let { el = $bindable(null) } = $props();

  const uid = 'cxl' + Math.random().toString(36).slice(2, 8);
  let lotHost = $state(null);
  let playing = $state(false);
  let current = null;       // 正在播的那段 Lottie
  let loading = false;
  let spins = 0;
  let spin = null;          // 正在跑的转圈动画

  async function hover(e) {
    if (e.pointerType === 'touch' || reduced() || current || loading) return;
    loading = true;
    const a = await mountLottie(lotHost, Math.random() < 0.5 ? 'hello' : 'loader', { autoplay: true });
    loading = false;
    if (!a) return;
    current = a;
    const done = () => {
      if (current !== a) return;
      playing = false;
      try { a.destroy(); } catch {}
      if (lotHost) lotHost.innerHTML = '';
      current = null;
    };
    if (a.isLoaded) playing = true; else a.addEventListener('DOMLoaded', () => { if (current === a) playing = true; });
    a.addEventListener('complete', done);
  }

  function press(e) {
    if (e.button !== 0 || reduced() || !el) return;
    if (spin) { try { spin.commitStyles(); } catch {} spin.cancel(); }
    const from = getComputedStyle(el).transform;
    spins += 1;
    const to = -360 * spins;
    spin = el.animate([
      { transform: from === 'none' ? 'rotate(0deg) scale(1)' : from, easing: EASE.logo },
      { transform: `rotate(${to}deg) scale(1.18)`, offset: 0.5, easing: EASE.logo },
      { transform: `rotate(${to}deg) scale(1)` },
    ], { duration: 1100, fill: 'forwards' });
  }

  /** 换项目时点一下头。 */
  export function nod() {
    if (!el || reduced() || spin?.playState === 'running') return;
    anim(el, [{ scale: '1' }, { scale: '.92', offset: 0.3 }, { scale: '1' }], { dur: 420, ease: EASE.out });
  }

  onMount(() => () => {
    try { current?.destroy(); } catch {}
    current = null;
    spin?.cancel();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="logo" class:playing bind:this={el} aria-hidden="true" onpointerenter={hover} onpointerup={press}>
  <svg class="static" viewBox="149 149 418 418" fill="none">
    <mask id={uid} fill="#fff"><path fill-rule="evenodd" clip-rule="evenodd" d="M247.429 247.43C257.73 208.911 292.871 180.543 334.638 180.543C359.555 180.543 382.115 190.64 398.449 206.964C405.906 204.97 413.743 203.905 421.829 203.905C471.681 203.906 512.096 244.32 512.096 294.173C512.096 302.259 511.031 310.096 509.037 317.553C525.361 333.887 535.458 356.446 535.458 381.364C535.458 423.131 507.09 458.271 468.571 468.572C458.271 507.091 423.131 535.459 381.364 535.459C356.446 535.459 333.886 525.362 317.552 509.037C310.095 511.031 302.258 512.097 294.172 512.097C244.319 512.097 203.906 471.682 203.906 421.829C203.906 413.743 204.969 405.905 206.963 398.448C190.639 382.115 180.543 359.555 180.543 334.638C180.543 292.871 208.91 257.73 247.429 247.43Z"/></mask>
    <path class="cl" d="M247.429 247.43C257.73 208.911 292.871 180.543 334.638 180.543C359.555 180.543 382.115 190.64 398.449 206.964C405.906 204.97 413.743 203.905 421.829 203.905C471.681 203.906 512.096 244.32 512.096 294.173C512.096 302.259 511.031 310.096 509.037 317.553C525.361 333.887 535.458 356.446 535.458 381.364C535.458 423.131 507.09 458.271 468.571 468.572C458.271 507.091 423.131 535.459 381.364 535.459C356.446 535.459 333.886 525.362 317.552 509.037C310.095 511.031 302.258 512.097 294.172 512.097C244.319 512.097 203.906 471.682 203.906 421.829C203.906 413.743 204.969 405.905 206.963 398.448C190.639 382.115 180.543 359.555 180.543 334.638C180.543 292.871 208.91 257.73 247.429 247.43Z" stroke="currentColor" stroke-width="41.2" mask="url(#{uid})"/>
    <path class="ul" d="M436.706 408.738H370.021" stroke="currentColor" stroke-width="24" stroke-linecap="round"/>
    <path class="gt" d="M276.533 309.154L303.468 357.831C304.433 359.575 304.412 361.698 303.414 363.423L276.533 409.854" stroke="currentColor" stroke-width="24" stroke-linecap="round"/>
  </svg>
  <div class="lot-host" bind:this={lotHost}></div>
</div>
