<script>
  // 官方侧栏图标（Lottie 原件）：平时停在第 0 帧，鼠标移到所在的那一行 / 那颗键上时完整播一遍（0.67 秒）。
  // 触屏、减少动态效果时不播。取不到原件（没装桌面版、Linux、云端）退回同义的静态线稿图标；
  // 加载中先空着一小会儿（本机取通常很快），超过 250ms 才先摆静态图标，免得图标先跳一个样子再换。
  import { onMount } from 'svelte';
  import { mountLottie } from '../../lib/codex/assets.js';
  import { reduced } from '../../lib/codex/motion.js';
  import Icon from './Icon.svelte';

  let {
    name,                                  // sidebar-new-chat | sidebar-search | sidebar-projects | sidebar-tasks | sidebar-plugins | sidebar-library
    icon = '',                             // 退回用的静态图标名（Icon.svelte）
    trigger = 'button, [role="button"]',   // 悬停哪个祖先时播
  } = $props();

  let host = $state(null);
  let ready = $state(false);
  let slow = $state(false);
  let failed = $state(false);
  let lot = null;

  /** 从头播一遍（外面也可以 bind:this 后直接调）。 */
  export function play() {
    if (!lot || reduced()) return;
    lot.goToAndPlay(0, true);
  }

  onMount(() => {
    let alive = true;
    const slowT = setTimeout(() => { slow = true; }, 250);
    mountLottie(host, name).then((a) => {
      if (!alive) { a?.destroy?.(); return; }
      if (!a) { failed = true; return; }
      lot = a;
      const shown = () => { if (alive) ready = true; };
      if (a.isLoaded) shown(); else a.addEventListener('DOMLoaded', shown);
    });
    const trig = host?.closest(trigger);
    const enter = (e) => { if (e.pointerType === 'touch') return; play(); };
    trig?.addEventListener('pointerenter', enter);
    return () => {
      alive = false;
      clearTimeout(slowT);
      trig?.removeEventListener('pointerenter', enter);
      try { lot?.destroy(); } catch {}
      lot = null;
    };
  });
</script>

<span class="lot" aria-hidden="true">
  {#if !ready && icon && (failed || slow)}<Icon name={icon} />{/if}
  <span class="lot-in" class:on={ready} bind:this={host}></span>
</span>

<style>
  .lot { position: relative; display: grid; place-items: center; }
  .lot > :global(svg) { position: absolute; inset: 0; }
  .lot-in { position: absolute; inset: 0; opacity: 0; }
  .lot-in.on { opacity: 1; }
</style>
