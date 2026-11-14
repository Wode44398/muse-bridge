<script>
  // 全屏放映（PPT 转出的 PDF、PPT 客户端回落共用；PowerPoint / Keynote 放映的手感）：
  //   黑底满屏，幻灯片按比例居中；进浏览器全屏（不支持全屏的 WebView 里就是盖满视口的一层），apk 里横过来。
  //   下一张：单击 / → / ↓ / 空格 / PageDown / Enter / N；上一张：右键 / ← / ↑ / PageUp / Backspace / P；
  //   Home / End 首尾；先敲页码再回车跳页；Esc 退出（退出全屏的那一下 Esc 被浏览器吃掉时，看 fullscreenchange 一并退出）。
  //   触屏：点左三分之一上一张、其余下一张，左右滑翻页，系统返回退出。最后一张之后是「放映结束，单击退出」。
  //   页码角标翻页后亮 1.5s 再淡出；鼠标 2s 不动光标隐藏；放映期间申请屏幕常亮。
  //   下一张提前在屏外画好（slide snippet 同时挂两份），翻页不等渲染。
  // props
  //   count · start（1 起）· aspect(n) → 宽/高 · slide：Snippet(n, w, h) 在 w×h 的框里画第 n 张
  //   onexit(n)：退出时停在第几张（调用方据此把查看器翻到那一页）
  import { onMount, untrack } from 'svelte';
  import VIcon from '../kit/VIcon.svelte';
  import { pushBackLayer } from '../../../lib/nav.js';
  import { t } from '../../../lib/i18n.js';

  let { count = 0, start = 1, aspect = () => 16 / 9, slide, onexit } = $props();

  let cur = $state(untrack(() => Math.max(1, Math.min(count, start || 1))));
  let ended = $state(false);
  let W = $state(innerWidth), H = $state(innerHeight);
  let el = $state(null);
  let badge = $state(true), badgeT = 0;
  let cursorOn = $state(true), cursorT = 0;
  let typed = '', typedT = 0;
  let done = false;

  const fit = (n) => {
    const a = aspect(n) || 16 / 9;
    let w = W, h = W / a;
    if (h > H) { h = H; w = H * a; }
    return { w: Math.floor(w), h: Math.floor(h) };
  };
  // 眼前这张 + 下一张（屏外预渲染）
  const shown = $derived(cur < count ? [cur, cur + 1] : [cur]);

  function poke() {
    badge = true; clearTimeout(badgeT);
    badgeT = setTimeout(() => (badge = false), 1500);
  }
  function go(n) {
    if (ended) { ended = false; }
    const to = Math.max(1, Math.min(count, n));
    if (to !== cur) cur = to;
    poke();
  }
  function next() {
    if (ended) { exit(); return; }
    if (cur >= count) { ended = true; return; }
    go(cur + 1);
  }
  function prev() {
    if (ended) { ended = false; poke(); return; }
    go(cur - 1);
  }

  function exit() {
    if (done) return;
    done = true;
    try { if (document.fullscreenElement === el) document.exitFullscreen?.(); } catch {}
    restoreOrient();
    onexit?.(cur);
  }

  // —— 键盘：捕获阶段拦在最前（外框的 Esc 关闭、PdfView 的翻页都不该再收到）——
  function onKey(e) {
    if (e.isComposing) return;
    const k = e.key;
    let used = true;
    if (/^[0-9]$/.test(k)) {
      typed = (typed + k).slice(-4);
      clearTimeout(typedT); typedT = setTimeout(() => (typed = ''), 1500);
    } else if (k === 'Enter' && typed) { go(+typed); typed = ''; }
    else if (k === 'Escape') exit();
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) { if (k === ' ' && e.shiftKey) prev(); else next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) prev();
    else if (k === 'Home') go(1);
    else if (k === 'End') go(count);
    else if (k === 'F5' || k === 'Tab') { /* 吃掉：放映中不重开、不让焦点跑出去 */ }
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  // —— 指针：鼠标单击下一张 / 右键上一张；触屏点左三分之一上一张、横滑翻页 ——
  let down = null;
  function pd(e) {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp, type: e.pointerType };
  }
  function pu(e) {
    if (!down || e.button !== 0) return;
    const d = down; down = null;
    if (e.target.closest?.('.ss-x')) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.type !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) { if (dx < 0) next(); else prev(); return; }
    if (Math.hypot(dx, dy) > 12) return;
    if (d.type !== 'mouse' && e.clientX < W / 3) prev(); else next();
  }
  function ctxmenu(e) { e.preventDefault(); prev(); }
  function move(e) {
    if (e.pointerType !== 'mouse') return;
    cursorOn = true; clearTimeout(cursorT);
    cursorT = setTimeout(() => (cursorOn = false), 2000);
  }

  // —— 屏幕常亮 / 横屏 / 全屏 ——
  let lock = null;
  async function keepAwake() {
    try { lock = await navigator.wakeLock?.request?.('screen'); } catch { lock = null; }
  }
  const nativeOrient = () => { try { return typeof window.AndroidStore?.setOrientation === 'function'; } catch { return false; } };
  let rotated = false;
  function landscape() {
    if (!(aspect(cur) > 1.05)) return;
    if (nativeOrient() && innerHeight > innerWidth) {
      try { window.AndroidStore.setOrientation('landscape'); rotated = true; } catch {}
    }
  }
  function restoreOrient() {
    if (rotated) { try { window.AndroidStore.setOrientation('auto'); } catch {} rotated = false; }
    try { screen.orientation?.unlock?.(); } catch {}
    try { lock?.release?.(); } catch {}
    lock = null;
  }
  function onFs() {
    // 浏览器自己处理了退出全屏的 Esc（页面收不到这一下）：跟着退出放映
    if (!document.fullscreenElement && entered) exit();
  }
  let entered = false;

  onMount(() => {
    const ro = new ResizeObserver(() => { if (el) { W = el.clientWidth; H = el.clientHeight; } });
    if (el) ro.observe(el);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFs);
    const popBack = pushBackLayer(() => exit());
    try {
      const p = el?.requestFullscreen?.({ navigationUI: 'hide' });
      p?.then?.(() => { entered = true; if (aspect(cur) > 1.05) screen.orientation?.lock?.('landscape').catch(() => {}); }).catch(() => {});
    } catch {}
    landscape();
    keepAwake();
    poke();
    cursorT = setTimeout(() => (cursorOn = false), 2000);
    try { el?.focus({ preventScroll: true }); } catch {}
    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFs);
      popBack();
      clearTimeout(badgeT); clearTimeout(cursorT); clearTimeout(typedT);
      if (!done) { done = true; try { if (document.fullscreenElement === el) document.exitFullscreen?.(); } catch {} restoreOrient(); }
    };
  });
  // 页面切回前台时常亮锁会被系统收走，重新申请
  function onVis() { if (document.visibilityState === 'visible' && !done) keepAwake(); }
</script>

<svelte:document onvisibilitychange={onVis} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="ss" class:nocursor={!cursorOn} bind:this={el} role="dialog" aria-modal="true" aria-label={t('放映')} tabindex="-1"
  onpointerdown={pd} onpointerup={pu} oncontextmenu={ctxmenu} onpointermove={move}>
  {#if ended}
    <p class="ss-end">{t('放映结束，单击退出')}</p>
  {:else}
    <!-- 按页码做键：翻到下一张时那一份（已在屏外画好）原地转正，不重画 -->
    {#each shown as n (n)}
      {@const b = fit(n)}
      <div class="ss-slide" class:ss-pre={n !== cur} aria-hidden={n !== cur ? 'true' : undefined} style:width="{b.w}px" style:height="{b.h}px">{@render slide?.(n, b.w, b.h)}</div>
    {/each}
  {/if}
  <span class="ss-badge" class:on={badge || ended} aria-live="polite">{ended ? `${count} / ${count}` : `${cur} / ${count}`}</span>
  <button type="button" class="ss-x" class:on={badge || cursorOn} aria-label={t('退出放映')} onclick={exit}><VIcon name="close" size={22} /></button>
</div>

<style>
  .ss { position: fixed; inset: 0; z-index: 400; background: #000; color: #fff; display: flex; align-items: center; justify-content: center;
    outline: none; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; animation: ss-in var(--mo-base) var(--ea-fade) both; }
  @keyframes ss-in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .ss { animation: none; } }
  .ss.nocursor { cursor: none; }
  .ss-slide { position: relative; flex: none; overflow: hidden; background: #fff; }
  /* 下一张在屏外画好：不占位、不可见，但渲染照常进行 */
  .ss-pre { position: absolute; left: -200vw; top: 0; visibility: hidden; pointer-events: none; }
  .ss-end { margin: 0; font-size: 15px; color: rgba(255, 255, 255, .6); }
  .ss-badge { position: absolute; right: max(16px, var(--sar, 0px)); bottom: max(14px, var(--sab, 0px)); padding: 4px 10px; border-radius: 999px;
    font-size: 13px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, .86); background: rgba(0, 0, 0, .5);
    opacity: 0; transition: opacity var(--mo-base) var(--ea-fade); pointer-events: none; }
  .ss-badge.on { opacity: 1; }
  .ss-x { position: absolute; top: max(10px, var(--sat, 0px)); right: max(10px, var(--sar, 0px)); width: 44px; height: 44px; border: 0; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; padding: 0; color: #fff; background: rgba(0, 0, 0, .42); cursor: pointer;
    opacity: 0; pointer-events: none; transition: opacity var(--mo-base) var(--ea-fade); }
  .ss-x.on { opacity: .9; pointer-events: auto; }
  .ss.nocursor .ss-x { opacity: 0; pointer-events: none; }
</style>
