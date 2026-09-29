<script>
  // 沉浸式图片查看器：双指缩放、双击放大、缩放后拖动、渐进加载（模糊缩略→预览→缩放时换原图）。
  // 手势分流（避免缩放/翻页/下滑关闭互相打架）：
  //   · 2 指 → 始终是 pinch 缩放（绕双指中点）
  //   · 1 指且已放大(scale>1) → 在图内平移(到边界为止)
  //   · 1 指且 scale==1 → 横向=翻页(轻微跟手，松手判定)、向下=下滑关闭(跟手 + 上报进度给壳调暗背景)
  //   · 双击 → 在 1 ↔ 2.5 间切换，以点按点为中心
  import { onMount } from 'svelte';
  import { registerCapture } from '../../lib/uiReport.js';
  import { t } from '../../lib/i18n.js';

  let { item, canPrev = false, canNext = false, onClose, onPrev, onNext, onDragProgress } = $props();

  // 工作区协同·网页端截图：把当前展示的图画进 canvas（同源 <img> 不污染画布）。长边压到 1600 省传输。
  $effect(() => registerCapture(() => {
    const img = stage?.querySelector('img');
    if (!img || !img.naturalWidth) return null;
    try {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return { image: cv.toDataURL('image/jpeg', 0.85), note: '图片预览（' + (item?.name || '') + '）' };   // i18n-ignore 截图附注是给 agent 看的上下文，不上屏
    } catch { return null; }
  }));

  let stage = $state();      // 容器
  let scale = $state(1), tx = $state(0), ty = $state(0);
  let smooth = $state(false); // 是否给 transform 加过渡（手势进行中关，松手/双击开）
  let loaded = $state(false), errored = $state(false);
  let mainSrc = $state(item.dataUrl || item.previewUrl || item.url || '');
  let fullLoaded = false;    // 已升级到原图
  let natW = 0, natH = 0;

  // —— 渐进升级：缩放较大时偷偷加载原图换上（预览图是 1280，放大看原图更锐）——
  function upgradeFull() {
    if (fullLoaded || !item.url || item.url === mainSrc) return;
    fullLoaded = true;
    const im = new Image();
    im.onload = () => { mainSrc = im.src; };
    im.src = item.url;
  }

  function onImgLoad(e) {
    natW = e.currentTarget.naturalWidth || 0;
    natH = e.currentTarget.naturalHeight || 0;
    loaded = true; errored = false;
  }
  function onImgError() {
    if (mainSrc === item.url && item.previewUrl && item.previewUrl !== item.url) { mainSrc = item.previewUrl; return; }
    errored = true;
  }
  function retry() { errored = false; loaded = false; const s = mainSrc; mainSrc = ''; requestAnimationFrame(() => (mainSrc = s)); }

  // —— 适配尺寸（contain）：算缩放 1 时图片实际占据的像素，用于平移边界 ——
  function fitSize() {
    const r = stage?.getBoundingClientRect();
    if (!r || !natW || !natH) return { w: r?.width || 0, h: r?.height || 0 };
    const s = Math.min(r.width / natW, r.height / natH);
    return { w: natW * s, h: natH * s };
  }
  function clampPan() {
    const r = stage?.getBoundingClientRect(); if (!r) return;
    const f = fitSize();
    const maxX = Math.max(0, (f.w * scale - r.width) / 2);
    const maxY = Math.max(0, (f.h * scale - r.height) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  // —— 指针手势 ——
  const pointers = new Map();
  let mode = null;           // 'pinch' | 'pan' | 'page' | 'dismiss' | 'maybe'
  let sx = 0, sy = 0, sTx = 0, sTy = 0, sScale = 1, sDist = 0, sMidX = 0, sMidY = 0, sTime = 0;
  let lastTap = 0, lastTapX = 0, lastTapY = 0;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function midRelCenter(a, b) {
    const r = stage.getBoundingClientRect();
    return { x: (a.x + b.x) / 2 - (r.left + r.width / 2), y: (a.y + b.y) / 2 - (r.top + r.height / 2) };
  }

  function down(e) {
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    smooth = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      sDist = dist(a, b); sScale = scale; sTx = tx; sTy = ty;
      const m = midRelCenter(a, b); sMidX = m.x; sMidY = m.y;
      mode = 'pinch';
    } else if (pointers.size === 1) {
      sx = e.clientX; sy = e.clientY; sTx = tx; sTy = ty; sTime = e.timeStamp;
      mode = scale > 1.01 ? 'pan' : 'maybe';
    }
  }

  function move(e) {
    const p = pointers.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;

    if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const ns = Math.min(6, Math.max(1, sScale * (dist(a, b) / (sDist || 1))));
      const m = midRelCenter(a, b);
      // 绕双指中点缩放并随中点平移：t = curMid - (startMid - startT)*(ns/sScale)
      tx = m.x - (sMidX - sTx) * (ns / sScale);
      ty = m.y - (sMidY - sTy) * (ns / sScale);
      scale = ns;
      clampPan();
      return;
    }
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (mode === 'pan') { tx = sTx + dx; ty = sTy + dy; clampPan(); return; }
    if (mode === 'maybe') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      mode = Math.abs(dx) > Math.abs(dy) ? 'page' : (dy > 0 ? 'dismiss' : 'page');
    }
    if (mode === 'page') { tx = dx * 0.55; ty = 0; }       // 轻微跟手
    else if (mode === 'dismiss') { ty = dy; tx = 0; onDragProgress?.(Math.min(1, dy / 320)); }
  }

  function up(e) {
    if (!pointers.has(e.pointerId)) return;
    const dx = e.clientX - sx, dy = e.clientY - sy, dt = e.timeStamp - sTime;
    pointers.delete(e.pointerId);
    smooth = true;
    if (mode === 'pinch') {
      if (scale <= 1.02) { scale = 1; tx = 0; ty = 0; } else { clampPan(); upgradeFull(); }
    } else if (mode === 'pan') {
      clampPan(); upgradeFull();
    } else if (mode === 'page') {
      const fling = Math.abs(dx) > 80 || (Math.abs(dx) > 36 && dt < 240);
      if (fling && dx > 0 && canPrev) onPrev?.();
      else if (fling && dx < 0 && canNext) onNext?.();
      tx = 0; ty = 0;
    } else if (mode === 'dismiss') {
      if (dy > 120 || (dy > 60 && dt < 240)) { onClose?.(); }
      else { ty = 0; tx = 0; onDragProgress?.(0); }
    }
    if (pointers.size === 0) mode = null;
    else if (pointers.size === 1) { const [only] = [...pointers.entries()]; sx = only[1].x; sy = only[1].y; sTx = tx; sTy = ty; mode = scale > 1.01 ? 'pan' : 'maybe'; }
  }

  function tap(e) {
    // 双击缩放（避免与拖动冲突：仅在没有移动时算 tap）
    const now = e.timeStamp;
    if (now - lastTap < 300 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 30) {
      lastTap = 0;
      smooth = true;
      if (scale > 1.01) { scale = 1; tx = 0; ty = 0; }
      else {
        const r = stage.getBoundingClientRect();
        const T = { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
        scale = 2.5; tx = -1.5 * T.x; ty = -1.5 * T.y; clampPan(); upgradeFull();
      }
    } else { lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY; }
  }

  onMount(() => {
    const onResize = () => { if (scale > 1) clampPan(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

<div class="iv-stage" bind:this={stage}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onclick={tap}
  role="presentation" style:touch-action="none">

  {#if item.thumbUrl && !loaded && !errored}
    <img class="iv-blur" src={item.thumbUrl} alt="" aria-hidden="true" />
  {/if}

  {#if !errored}
    <img class="iv-img" class:ready={loaded} src={mainSrc} alt={item.name}
      draggable="false" onload={onImgLoad} onerror={onImgError}
      style:transform="translate3d({tx}px,{ty}px,0) scale({scale})"
      style:transition={smooth ? 'transform var(--mo-base) var(--ea-decel)' : 'none'} />
  {/if}

  {#if !loaded && !errored}
    <div class="iv-spin" aria-label={t('加载中')}><span></span></div>
  {/if}

  {#if errored}
    <div class="iv-err">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="m6 17 4.2-4.4 3 3 2.4-2.5 2.9 3.1"/><circle cx="9" cy="9.6" r="1.3"/></svg>
      <p>{t('图片加载失败')}</p>
      <button onclick={retry}>{t('重试')}</button>
    </div>
  {/if}
</div>

<style>
  .iv-stage { position: absolute; inset: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .iv-blur { position: absolute; max-width: 100%; max-height: 100%; object-fit: contain; filter: blur(18px); transform: scale(1.06); opacity: .6; }
  .iv-img { max-width: 100%; max-height: 100%; object-fit: contain; will-change: transform; opacity: 0; user-select: none; -webkit-user-drag: none; -webkit-touch-callout: none; }
  .iv-img.ready { opacity: 1; transition: opacity var(--mo-quick) var(--ea-fade); }
  .iv-spin { position: absolute; width: 34px; height: 34px; }
  .iv-spin span { display: block; width: 100%; height: 100%; border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: rgba(255,255,255,.92); animation: ivspin .8s linear infinite; }
  @keyframes ivspin { to { transform: rotate(360deg); } }
  .iv-err { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 10px; color: rgba(255,255,255,.82); }
  .iv-err p { font-size: 14px; }
  .iv-err button { padding: 7px 20px; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; font-size: 14px; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
  .iv-err button:active { background: rgba(255,255,255,.26); }
</style>
