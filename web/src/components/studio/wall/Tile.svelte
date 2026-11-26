<script>
  // 墙上的一件作品（图 / 视频封面）。格子多大就拿多大的衍生档：小格（桌面四列）走 thumb，大格走 preview；
  // 从显影接过来的那一格固定用 preview（DevFrame 刚解码过同一张，命中缓存，换过来看不出接缝）。
  // 视频：右下 mono 时长签；鼠标停在上面就地静音预播（触屏不播）。
  import { onMount } from 'svelte';
  import { t, tc } from '../../../lib/i18n.js';
  import { mediaSrc, openAsset } from '../../../modules/studio/media.svelte.js';
  import { assetDrag } from '../../../modules/studio/assetDrag.js';
  import { heal } from '../../../modules/studio/heal.js';
  import { icon } from '../../../modules/studio/icons.js';
  import Img from '../ui/Img.svelte';
  import { anim } from './fx.js';
  import { mmss } from './when.js';

  let { asset, w = 0, handoff = false, onratio = null, onready = null, onmenu = null } = $props();

  const isVideo = $derived(asset?.kind === 'video');
  // 档位只升不降：窗口拉宽过一次就留在 preview，别来回换图
  let big = $state(false);
  $effect(() => { const dpr = Math.min(3, window.devicePixelRatio || 1); if (handoff || w * dpr > 340) big = true; });
  const src = $derived(mediaSrc(asset, big ? 'preview' : 'thumb'));
  let img = $state();
  let dur = $state(0);
  $effect(() => { dur = Number(asset?.duration) || 0; });

  function loaded() {
    if (!img?.naturalWidth) return;
    onratio?.(asset.id, img.naturalHeight / img.naturalWidth);
    onready?.();
  }
  onMount(() => { if (img?.complete && img.naturalWidth) loaded(); });

  // —— 悬停预播 ——
  let hov = $state(false), vid = $state(), leaving = null;
  function enter(e) {
    if (!isVideo || e.pointerType !== 'mouse') return;
    leaving?.cancel(); leaving = null;
    hov = true;
  }
  function leave() {
    if (!hov) return;
    if (!vid) { hov = false; return; }
    leaving = anim(vid, [{ opacity: 1 }, { opacity: 0 }], { d: 160, fill: 'forwards' });
    if (!leaving) { hov = false; return; }
    const me = leaving;
    me.finished.then(() => { if (leaving === me) { leaving = null; hov = false; } }).catch(() => {});
  }
  // 没出画面前一直透明（CSS），真开始播了再淡出来：终值先写进 style，再从 0 动画过去
  function playing() { if (!vid || leaving) return; vid.style.opacity = '1'; anim(vid, [{ opacity: 0 }, { opacity: 1 }], { d: 220 }); }
  function meta() { if (vid && isFinite(vid.duration) && !dur) dur = vid.duration; }

  function open() { openAsset(asset); }
  function key(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }
  function ctx(e) { e.preventDefault(); onmenu?.({ asset, at: { x: e.clientX, y: e.clientY } }); }
  const label = $derived(String(asset?.prompt || '').replace(/\s+/g, ' ').slice(0, 80) || (isVideo ? tc('名词', '生成视频') : tc('名词', '生成图像')));
</script>

<div class="sw-tile" data-asset={asset.id} role="button" tabindex="0" aria-label={label}
  onclick={open} onkeydown={key} oncontextmenu={ctx} onpointerenter={enter} onpointerleave={leave}
  use:assetDrag={{ asset, onStay: (node) => onmenu?.({ asset, anchor: node }) }}>
  <Img bind:img {src} alt="" decoding="async" loading={handoff ? 'eager' : 'lazy'} draggable="false" onload={loaded} />
  {#if hov}
    <video bind:this={vid} class="sw-hv" src={mediaSrc(asset)} muted loop playsinline autoplay preload="auto"
      use:heal={{ src: mediaSrc(asset) }} onplaying={playing} onloadedmetadata={meta}></video>
  {/if}
  {#if isVideo}
    <span class="sw-dur mono" aria-label={dur ? t('时长 {t}', { t: mmss(dur) }) : undefined}>{@html icon('play')}{#if dur}<span>{mmss(dur)}</span>{/if}</span>
  {/if}
</div>
