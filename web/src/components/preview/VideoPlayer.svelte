<script>
  // 自定义视频播放器（MediaViewer 全屏内，YouTube 手机版同款交互）。
  //
  // 播放内核 = 四级回退链（quality × transport）：
  //   ① 原画-MSE   /api/file/stream&remux=1（视频零转码全画质）+ msePump 全速深缓冲 —— 默认主路径。
  //      <video src> 的取流被 Chromium 按播放进度限速（实测只拉 ~8MB/s，下载器能跑 90MB/s），
  //      120Mbps 4K 原片喂不饱必卡；MSE 自己一根 fetch 全速拉流灌 SourceBuffer，网络多快缓多快。
  //   ② 原画-直连  <video src=/api/file>（本地缓存 blob 命中时优先走这条：0 网络最快）
  //   ③ 流畅-MSE   /api/file/stream（服务端转码 H.264≤1080p ~6Mbps）+ msePump
  //   ④ 流畅-直连  <video src=stream&t=>（换 src 续播，tOff 偏移时间轴）
  //   任一级失败（解码/网络/配额）自动降级下一级。
  //   MSE 级 timestampOffset 映射绝对时间轴，currentTime/buffered 全真值；只有 ④ 需要 tOff 换算。
  //
  // YouTube 手势：双击左右 ±10s（连击累计 + 半月 ripple）、长按 2 倍速（锐利震动 + 2x chip，
  // 松手恢复）、轻点显隐控件、向下滑动关闭（联动壳调暗背景）、进度条拖动出时间气泡。
  // 倍速/画质/下载收进右上 ⋮ 设置菜单（MediaViewer 的 ⋮ 调 api.openMenu 打开底部弹层）。
  // 横屏全屏：requestFullscreen + 方向锁。
  import { onMount, onDestroy } from 'svelte';
  import { resolveSrc, hasBlob } from '../../lib/mediaCache.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { createMsePump, isMseSupported } from '../../lib/msePump.js';
  import { t, tc } from '../../lib/i18n.js';

  let { item, onClose, onDragProgress, api = $bindable(null) } = $props();

  let videoEl = $state();
  let src = $state(''), revoke = () => {};
  let srcIsBlob = false;
  let loading = $state(true), errored = $state(false);
  let playing = $state(false), muted = $state(false);
  let metaDur = $state(0), cur = $state(0), buffered = $state(0);
  let controls = $state(true);   // 控件可见
  let scrubbing = $state(false), scrubT = $state(0);   // 拖动中 + 拖到的绝对时间
  let hideT = null;
  let dead = false;

  // —— 回退链 ——
  const STEPS = ['orig-mse', 'orig-src', 'smooth-mse', 'smooth-src'];
  let step = $state('orig-src');      // 当前生效级
  let stepAt = 0;                     // 本级起播位置（早期失败时接力用）
  let probeData = $state(null);       // /stream?probe=1：{duration,mseCodecs,hasAudio,...}
  let pump = null;                    // msePump 控制器（MSE 级）
  let cacheDowngraded = false;
  let pendingSeek = -1;               // 直连级等 metadata 再应用的位置
  const qualityNow = $derived(step.startsWith('smooth') ? 'smooth' : 'orig');
  const isMse = $derived(step.endsWith('mse'));

  const rawUrl = () => item.url;
  const rawStream = () => item.streamUrl;

  const SMOOTH_V = 'avc1.64002A';   // 服务端转码钉死 high@4.2
  function mimeFor(s) {
    if (!probeData) return null;
    const a = probeData.hasAudio ? ', mp4a.40.2' : '';
    if (s === 'orig-mse') return probeData.mseCodecs ? `video/mp4; codecs="${probeData.mseCodecs}${a}"` : null;
    return `video/mp4; codecs="${SMOOTH_V}${a}"`;
  }
  function stepOk(s) {
    if (s === 'orig-src') return true;
    if (!item.streamUrl) return false;
    if (s === 'smooth-src') return true;
    if (!probeData || !(probeData.duration > 0)) return false;
    const m = mimeFor(s);
    return !!m && isMseSupported(m);
  }

  // —— 速度 ——
  const RATES = [0.5, 1, 1.25, 1.5, 2];
  let baseRate = $state(1);
  let lp2x = $state(false);           // 长按 2 倍速中
  let lpT = null;
  function setRate(r) { baseRate = r; if (videoEl && !lp2x) try { videoEl.playbackRate = r; } catch {} }

  // —— ⋮ 设置菜单（MediaViewer 的右上 ⋮ 调 openMenu）——
  let menu = $state(null);            // null | 'main' | 'rate' | 'quality'
  function closeMenu() { menu = null; }
  $effect(() => { if (!menu) return; return pushBackLayer(closeMenu); });   // 系统返回先关菜单

  // —— 双击跳转指示 ——
  let skipUi = $state(null);          // { side:'l'|'r', amt }
  let skipTimer = null;

  // —— 卡顿提示 ——
  let smoothHint = $state(false);
  let stallT = null, stallCount = 0;

  // —— 时间轴（MSE/原画直连=绝对；仅流畅直连需要 tOff 偏移）——
  let tOff = $state(0);
  const probeDur = $derived(probeData?.duration || 0);
  const effDur = $derived(probeDur || metaDur);
  const effCur = $derived(step === 'smooth-src' ? tOff + cur : cur);
  const shownT = $derived(scrubbing ? scrubT : effCur);
  const pct = $derived(effDur ? (shownT / effDur) * 100 : 0);
  const bufPct = $derived(effDur ? (Math.min(effDur, (step === 'smooth-src' ? tOff : 0) + buffered) / effDur) * 100 : 0);

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };

  // —— 触觉（navigator.vibrate，不支持的浏览器静默）——
  function haptic(kind) {
    try { navigator.vibrate?.(kind === 'heavy' ? 30 : kind === 'tick' ? 8 : 15); } catch {}
  }

  function armHide() { clearTimeout(hideT); if (playing && !scrubbing) hideT = setTimeout(() => (controls = false), 2600); }
  function showControls() { controls = true; armHide(); }

  function killPump() { try { pump?.destroy(); } catch {} pump = null; }

  // —— 换级（回退链/画质切换共用）——
  function runStep(s, at = 0) {
    if (dead || !videoEl) return;
    killPump(); revoke(); revoke = () => {}; srcIsBlob = false;
    clearTimeout(stallT); smoothHint = false; stallCount = 0;
    step = s; stepAt = at; loading = true; errored = false;
    buffered = 0; tOff = 0; pendingSeek = -1;
    if (s === 'orig-mse' || s === 'smooth-mse') {
      const remux = s === 'orig-mse';
      cur = at;
      pump = createMsePump(videoEl, {
        mime: mimeFor(s), duration: probeDur, startAt: at,
        urlFor: (sec) => rawStream() + (remux ? '&remux=1' : '') + '&t=' + Math.max(0, Math.round(sec * 10) / 10),
        onFatal: () => failStep(s),
      });
      src = pump.objectUrl;
    } else if (s === 'orig-src') {
      cur = 0; pendingSeek = at > 0.1 ? at : -1;
      resolveSrc(item.cacheKey, rawUrl())
        .then((r) => { if (dead || step !== s) { try { r.revoke(); } catch {} return; } src = r.src; revoke = r.revoke; srcIsBlob = !!r.cached; })
        .catch(() => { if (!dead && step === s) { src = rawUrl(); } });
    } else {   // smooth-src
      tOff = at; cur = 0;
      src = rawStream() + '&t=' + Math.max(0, Math.round(at * 10) / 10);
    }
  }

  // 这一级失败就降级到下一可用级，全灭出错误 UI。
  function failStep(s) {
    if (dead || step !== s || errored) return;
    const at = effCur > 0.5 ? effCur : stepAt;
    const i = STEPS.indexOf(s);
    for (let j = i + 1; j < STEPS.length; j++) if (stepOk(STEPS[j])) { runStep(STEPS[j], at); return; }
    errored = true; loading = false;
  }

  function setQuality(q) {
    if (q === qualityNow) { closeMenu(); return; }
    const at = effCur || 0;
    const seq = q === 'smooth' ? ['smooth-mse', 'smooth-src'] : ['orig-mse', 'orig-src'];
    const s = seq.find(stepOk);
    if (s) runStep(s, at);
    closeMenu();
  }

  async function load() {
    loading = true; errored = false;
    if (item.streamProbeUrl) {
      // no-store：probe 格式随版本演进，命中浏览器 HTTP 缓存的旧响应会让 MSE 误判降级；
      // 体积极小且服务端自有 ffprobe 结果缓存，每次真拉不亏。
      try { const r = await fetch(item.streamProbeUrl, { cache: 'no-store' }); if (r.ok) probeData = await r.json(); } catch {}
    }
    if (dead) return;
    // 本地缓存命中 → 直连 blob 最快；否则 MSE 原画优先（没条件再直连）
    let first = 'orig-src';
    if (!(item.cacheKey && (await hasBlob(item.cacheKey)))) first = stepOk('orig-mse') ? 'orig-mse' : 'orig-src';
    if (dead) return;
    runStep(first, 0);
  }

  function onLoadedMeta() {
    const d = videoEl?.duration;
    if (step === 'orig-src') {
      if (d === Infinity) { try { videoEl.currentTime = 1e7; } catch {} }   // 流式无时长兜底：跳极大处逼出真时长
      else if (isFinite(d) && d > 0) metaDur = d;
      if (pendingSeek >= 0) { try { videoEl.currentTime = pendingSeek; } catch {} pendingSeek = -1; }
    } else if (isMse && isFinite(d) && d > 0) metaDur = d;
    loading = false;
  }
  function onDur() { if (step !== 'orig-src') return; const d = videoEl?.duration; if (isFinite(d) && d > 0) { metaDur = d; if (videoEl.currentTime > d) { try { videoEl.currentTime = 0; } catch {} } } }
  function onTime() { if (!scrubbing) cur = videoEl?.currentTime || 0; }
  function onProgress() {
    try { const b = videoEl.buffered; if (b && b.length) buffered = b.end(b.length - 1); } catch {}
  }
  function onWaiting() {
    loading = true;
    // 原画反复喂不动（弱网 vs 大码率）→ 提示切流畅。缓存 blob 源不算。
    if (qualityNow === 'orig' && playing && item.streamUrl && !srcIsBlob) {
      stallCount++;
      clearTimeout(stallT); stallT = setTimeout(() => { if (loading) smoothHint = true; }, 4000);
      if (stallCount >= 3) smoothHint = true;
    }
  }
  function onPlaying() {
    loading = false; playing = true; clearTimeout(stallT);
    try { videoEl.playbackRate = lp2x ? 2 : baseRate; } catch {}
    armHide();
  }
  function onPause() { playing = false; controls = true; clearTimeout(hideT); }
  function onEnded() { playing = false; controls = true; }
  function onErr() {
    if (!src) return;   // 忽略空 src 的伪 error
    if (step === 'orig-src' && srcIsBlob && !cacheDowngraded) {   // 缓存 blob 坏 → 原始 URL 重试
      cacheDowngraded = true; revoke(); revoke = () => {}; srcIsBlob = false; src = rawUrl(); return;
    }
    failStep(step);
  }

  function togglePlay() { const v = videoEl; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); showControls(); }
  function toggleMute() { muted = !muted; if (videoEl) videoEl.muted = muted; showControls(); }

  function seekTo(sec) {
    sec = Math.max(0, Math.min(effDur || 0, sec));
    if (!videoEl) return;
    if (isMse && pump) { pump.seek(sec); cur = sec; return; }
    if (step === 'orig-src') { try { videoEl.currentTime = sec; } catch {} cur = videoEl.currentTime || sec; return; }
    // 流畅直连：缓冲窗内原生 seek（含回看），窗外重开流带 &t=
    const rel = sec - tOff;
    let bufEnd = 0;
    try { const b = videoEl.buffered; if (b && b.length) bufEnd = b.end(b.length - 1); } catch {}
    if (rel >= 0 && rel <= bufEnd) { try { videoEl.currentTime = rel; } catch {} cur = rel; }
    else { tOff = sec; cur = 0; buffered = 0; loading = true; src = rawStream() + '&t=' + Math.max(0, Math.round(sec * 10) / 10); }
  }

  // —— 进度条拖动（拖动中出时间气泡，松手才真 seek）——
  let track = $state();
  function scrubAt(clientX) { const r = track.getBoundingClientRect(); const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width)); return p * (effDur || 0); }
  function trackDown(e) { e.stopPropagation(); scrubbing = true; clearTimeout(hideT); try { track.setPointerCapture?.(e.pointerId); } catch {} scrubT = scrubAt(e.clientX); }
  function trackMove(e) { if (!scrubbing) return; scrubT = scrubAt(e.clientX); }
  function trackUp(e) { if (!scrubbing) return; scrubbing = false; seekTo(scrubAt(e.clientX)); armHide(); }

  // —— 横屏全屏 ——
  // Fullscreen API + 方向锁。
  let fsOn = $state(false);
  function toggleFs() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else {
        const p = wrap?.requestFullscreen?.();
        if (p && p.then) p.then(() => { try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {} }).catch(() => {});
      }
    } catch {}
    showControls();
  }
  function onFsChange() {
    fsOn = !!document.fullscreenElement;
    if (!fsOn) { try { screen.orientation?.unlock?.(); } catch {} }
  }
  function restoreOrientation() {
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
  }

  // —— 双击左右 ±10s（连击累计：指示存活期内同侧单击继续累加，YouTube 同款）——
  function doSkip(side) {
    const d = side === 'r' ? 10 : -10;
    if (skipUi && skipUi.side === side) skipUi = { side, amt: skipUi.amt + 10 };
    else skipUi = { side, amt: 10 };
    seekTo(effCur + d);
    haptic('tick');
    clearTimeout(skipTimer); skipTimer = setTimeout(() => (skipUi = null), 750);
  }
  const sideOf = (x) => { const r = wrap.getBoundingClientRect(); return x < r.left + r.width * 0.4 ? 'l' : x > r.left + r.width * 0.6 ? 'r' : 'c'; };

  // —— 手势：轻点显隐 / 双击跳转 / 长按 2x / 下滑关闭 ——
  let wrap = $state();
  let gx = 0, gy = 0, gMode = null, lastTap = 0, lastX = 0;
  let shiftY = $state(0);
  function startLp() {
    clearTimeout(lpT);
    if (!playing) return;
    lpT = setTimeout(() => {
      if (gMode !== 'maybe') return;
      gMode = 'lp'; lp2x = true; controls = false; clearTimeout(hideT);
      try { videoEl.playbackRate = 2; } catch {}
      haptic('heavy');   // 短促锐利，进入 2x 的确认感
    }, 480);
  }
  function endLp(restore = true) {
    clearTimeout(lpT); lpT = null;
    if (lp2x && restore) { lp2x = false; try { videoEl.playbackRate = baseRate; } catch {} }
  }
  function stageDown(e) { gx = e.clientX; gy = e.clientY; gMode = 'maybe'; startLp(); }
  function stageMove(e) {
    if (gMode === 'lp') return;   // 2x 按住期间指头漂移不打断
    if (gMode !== 'maybe' && gMode !== 'dismiss') return;
    const dx = e.clientX - gx, dy = e.clientY - gy;
    if (gMode === 'maybe') {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      clearTimeout(lpT);
      if (dy > 0 && dy > Math.abs(dx)) gMode = 'dismiss'; else gMode = 'pan';
    }
    if (gMode === 'dismiss') { shiftY = dy; onDragProgress?.(Math.min(1, dy / 320)); }
  }
  function stageUp(e) {
    const dx = e.clientX - gx, dy = e.clientY - gy, now = e.timeStamp;
    if (gMode === 'lp') { endLp(); gMode = null; return; }   // 松手退出 2x，不当 tap
    endLp();
    if (gMode === 'dismiss') {
      if (dy > 120) { restoreOrientation(); onClose?.(); return; }
      shiftY = 0; onDragProgress?.(0);
    } else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      const side = sideOf(e.clientX);
      if (skipUi && side === skipUi.side) {
        doSkip(side);   // 指示存活期内同侧单击=继续累计
        lastTap = 0;
      } else if (now - lastTap < 300 && Math.abs(e.clientX - lastX) < 60) {
        if (side === 'l' || side === 'r') doSkip(side);
        else controls ? (controls = false) : showControls();
        lastTap = 0;
      } else { lastTap = now; lastX = e.clientX; controls ? (clearTimeout(hideT), controls = false) : showControls(); }
    }
    gMode = null;
  }
  function stageCancel() { endLp(); if (gMode === 'dismiss') { shiftY = 0; onDragProgress?.(0); } gMode = null; }

  onMount(() => {
    api = { openMenu: () => { menu = 'main'; } };
    load();
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  });
  onDestroy(() => {
    dead = true;
    clearTimeout(hideT); clearTimeout(lpT); clearTimeout(skipTimer); clearTimeout(stallT);
    restoreOrientation();
    killPump();
    revoke();
  });

  // src 就绪后尝试自动播放（失败=移动端策略，留暂停态+控件，用户点播放）
  $effect(() => { if (src && videoEl) videoEl.play().then(() => {}).catch(() => { controls = true; }); });
</script>

<div class="vp-wrap" bind:this={wrap} style:transform="translateY({shiftY}px)" style:transition={shiftY ? 'none' : 'transform .26s cubic-bezier(.22,1,.36,1)'}>
  <div class="vp-stage" role="presentation" onpointerdown={stageDown} onpointermove={stageMove} onpointerup={stageUp} onpointercancel={stageCancel} style:touch-action="none">
    {#if !errored}
      <video bind:this={videoEl} class="vp-video" src={src || undefined} poster={item.poster || undefined}
        playsinline muted={muted} preload="metadata"
        onloadedmetadata={onLoadedMeta} ondurationchange={onDur} ontimeupdate={onTime} onprogress={onProgress}
        onwaiting={onWaiting} onplaying={onPlaying} onplay={onPlaying} onpause={onPause} onended={onEnded} onerror={onErr}></video>
    {/if}

    {#if loading && !errored}
      <div class="vp-spin"><span></span></div>
    {/if}

    {#if errored}
      <div class="vp-err">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 8l6 4-6 4V8Z"/><circle cx="12" cy="12" r="9.2"/></svg>
        <p>{t('视频加载失败')}</p>
        <button onclick={() => { cacheDowngraded = false; load(); }}>{t('重试')}</button>
      </div>
    {/if}

    <!-- 双击跳转半月指示（YouTube 同款：ripple + 三箭头 + 累计秒数） -->
    {#if skipUi}
      <div class="vp-skip {skipUi.side === 'l' ? 'left' : 'right'}">
        {#key skipUi.amt}
          <div class="vp-skip-in">
            <div class="vp-skip-arrows" class:rev={skipUi.side === 'l'}><i></i><i></i><i></i></div>
            <span>{t('{n} 秒', { n: skipUi.amt })}</span>
          </div>
        {/key}
      </div>
    {/if}

    <!-- 长按 2x chip -->
    {#if lp2x}
      <div class="vp-2x"><span>2×</span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5.5v13l8-6.5zM12.5 5.5v13l8-6.5z"/></svg></div>
    {/if}

    <!-- 卡顿提示：切流畅 -->
    {#if smoothHint && qualityNow === 'orig' && !errored}
      <button class="vp-hint" onclick={(e) => { e.stopPropagation(); setQuality('smooth'); }} onpointerdown={(e) => e.stopPropagation()}>
        {t('网络吃紧 · 切换流畅播放')}
      </button>
    {/if}

    <!-- 中央播放/暂停（暂停时或控件可见时显示；长按 2x 时藏） -->
    {#if !errored && (!playing || controls) && !lp2x}
      <button class="vp-center" aria-label={playing ? t('暂停') : t('播放')} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); togglePlay(); }}>
        {#if playing}
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
        {/if}
      </button>
    {/if}
  </div>

  <!-- 底部控件（YouTube 手机版两行：时间+功能钮 / 全宽进度条；倍速/画质在右上 ⋮ 菜单里） -->
  {#if !errored}
    <div class="vp-bar" class:show={controls && !lp2x} onpointerdown={(e) => e.stopPropagation()} role="presentation">
      <div class="vp-row">
        <span class="vp-t">{fmt(shownT)}<em>/{fmt(effDur)}</em></span>
        <span class="vp-sp"></span>
        <button class="vp-ic" aria-label={muted ? t('取消静音') : t('静音')} onclick={toggleMute}>
          {#if muted}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m22 9-6 6M16 9l6 6"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>
          {/if}
        </button>
        <button class="vp-ic" aria-label={t('横屏全屏')} onclick={toggleFs}>
          {#if fsOn}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
          {/if}
        </button>
      </div>
      <div class="vp-track" class:live={scrubbing} bind:this={track} onpointerdown={trackDown} onpointermove={trackMove} onpointerup={trackUp} onpointercancel={trackUp} role="slider" tabindex="0" aria-label={t('进度')} aria-valuenow={Math.round(shownT)} aria-valuemax={Math.round(effDur)}>
        {#if scrubbing}
          <div class="vp-bubble" style:left="{pct}%">{fmt(shownT)}</div>
        {/if}
        <div class="vp-rail"></div>
        <div class="vp-buf" style:width="{bufPct}%"></div>
        <div class="vp-fill" style:width="{pct}%"></div>
        <div class="vp-knob" style:left="{pct}%"></div>
      </div>
    </div>
  {/if}

  <!-- ⋮ 设置菜单：底部弹层（倍速 / 画质 / 下载），两级导航 -->
  {#if menu}
    <div class="vp-sheet-back" role="presentation" onpointerdown={(e) => e.stopPropagation()} onclick={closeMenu}>
      <div class="vp-sheet" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        {#if menu === 'main'}
          <button class="vp-mrow" onclick={() => (menu = 'rate')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
            <span>{t('播放速度')}</span><em>{baseRate === 1 ? tc('files', '正常') : baseRate + '×'}</em>
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </button>
          {#if item.streamUrl}
            <button class="vp-mrow" onclick={() => (menu = 'quality')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.2"/></svg>
              <span>{t('画质')}</span><em>{qualityNow === 'smooth' ? t('流畅') : t('原画')}</em>
              <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
            </button>
          {/if}
          {#if item.downloadHref}
            <a class="vp-mrow" href={item.downloadHref} download={item.name} onclick={() => closeMenu()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M12 16l-5-5M12 16l5-5"/><path d="M5 20h14"/></svg>
              <span>{t('下载')}</span>
            </a>
          {/if}
        {:else if menu === 'rate'}
          <button class="vp-mrow head" onclick={() => (menu = 'main')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
            <span>{t('播放速度')}</span>
          </button>
          {#each RATES as r}
            <button class="vp-mrow opt" onclick={() => { setRate(r); closeMenu(); }}>
              <span>{r === 1 ? tc('files', '正常') : r + '×'}</span>
              {#if r === baseRate}<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>{/if}
            </button>
          {/each}
        {:else if menu === 'quality'}
          <button class="vp-mrow head" onclick={() => (menu = 'main')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
            <span>{t('画质')}</span>
          </button>
          <button class="vp-mrow opt" onclick={() => setQuality('orig')}>
            <span>{t('原画')}<small>{t('完整分辨率与码率')}</small></span>
            {#if qualityNow === 'orig'}<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>{/if}
          </button>
          <button class="vp-mrow opt" onclick={() => setQuality('smooth')}>
            <span>{t('流畅')}<small>{t('转码 ≤1080p · 更抗弱网省流量')}</small></span>
            {#if qualityNow === 'smooth'}<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>{/if}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .vp-wrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; will-change: transform; background: #000; }
  .vp-stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .vp-video { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; background: #000; }

  .vp-spin { position: absolute; width: 40px; height: 40px; pointer-events: none; }
  .vp-spin span { display: block; width: 100%; height: 100%; border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; animation: vpspin .8s linear infinite; }
  @keyframes vpspin { to { transform: rotate(360deg); } }

  .vp-err { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 10px; color: rgba(255,255,255,.85); padding: 0 30px; text-align: center; }
  .vp-err button { padding: 7px 20px; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; font-size: 14px; }
  .vp-err button:active { background: rgba(255,255,255,.26); }

  .vp-center { position: absolute; width: 74px; height: 74px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.4); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: #fff; }
  .vp-center svg { width: 38px; height: 38px; }
  .vp-center:active { background: rgba(0,0,0,.55); transform: scale(.96); }

  /* —— 双击跳转半月指示 —— */
  .vp-skip { position: absolute; top: 0; bottom: 0; width: 38%; display: flex; align-items: center; justify-content: center; pointer-events: none; overflow: hidden; }
  .vp-skip.left { left: 0; border-radius: 0 100vh 100vh 0 / 0 50% 50% 0; background: radial-gradient(closest-side at 30% 50%, rgba(255,255,255,.14), rgba(255,255,255,.05) 70%, transparent); }
  .vp-skip.right { right: 0; border-radius: 100vh 0 0 100vh / 50% 0 0 50%; background: radial-gradient(closest-side at 70% 50%, rgba(255,255,255,.14), rgba(255,255,255,.05) 70%, transparent); }
  .vp-skip-in { display: flex; flex-direction: column; align-items: center; gap: 7px; color: #fff; animation: vpSkipPop .5s ease; }
  .vp-skip-in span { font-size: 13px; font-weight: 500; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
  @keyframes vpSkipPop { from { transform: scale(.82); opacity: .4; } to { transform: scale(1); opacity: 1; } }
  .vp-skip-arrows { display: flex; gap: 3px; }
  .vp-skip-arrows.rev { flex-direction: row-reverse; }
  .vp-skip-arrows i { width: 0; height: 0; border-style: solid; border-width: 7px 0 7px 11px; border-color: transparent transparent transparent #fff; opacity: .5; animation: vpArr .75s infinite; }
  .vp-skip-arrows.rev i { transform: rotate(180deg); }
  .vp-skip-arrows i:nth-child(2) { animation-delay: .12s; }
  .vp-skip-arrows i:nth-child(3) { animation-delay: .24s; }
  @keyframes vpArr { 0%, 100% { opacity: .35; } 40% { opacity: 1; } }

  /* —— 长按 2x chip —— */
  .vp-2x { position: absolute; top: max(14px, var(--sat)); left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px;
    padding: 7px 16px; border-radius: 999px; background: rgba(0,0,0,.55); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #fff; font-size: 14px; font-weight: 600; pointer-events: none; animation: vp2xIn .18s ease; }
  .vp-2x svg { width: 18px; height: 18px; }
  @keyframes vp2xIn { from { opacity: 0; transform: translateX(-50%) scale(.9); } to { opacity: 1; transform: translateX(-50%) scale(1); } }

  /* —— 卡顿→流畅提示 —— */
  .vp-hint { position: absolute; bottom: 120px; left: 50%; transform: translateX(-50%); white-space: nowrap;
    padding: 9px 18px; border-radius: 999px; background: rgba(0,0,0,.6); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    color: #fff; font-size: 13px; animation: vp2xIn .2s ease; }
  .vp-hint:active { background: rgba(255,255,255,.2); }

  /* —— 底部控件：两行（时间+功能钮 / 全宽进度条），渐变底、安全区内、自动显隐 —— */
  .vp-bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 6; display: flex; flex-direction: column; gap: 2px;
    padding: 34px 14px max(12px, var(--sab)); background: linear-gradient(to top, rgba(0,0,0,.66), rgba(0,0,0,0));
    opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s; pointer-events: none; }
  .vp-bar.show { opacity: 1; transform: none; pointer-events: auto; }
  .vp-row { display: flex; align-items: center; gap: 6px; }
  .vp-sp { flex: 1; }
  .vp-t { color: #fff; font-size: 13px; font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px rgba(0,0,0,.5); padding-left: 2px; }
  .vp-t em { font-style: normal; color: rgba(255,255,255,.6); }
  .vp-ic { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; flex: none; }
  .vp-ic svg { width: 22px; height: 22px; }
  .vp-ic:active { background: rgba(255,255,255,.16); }

  .vp-track { position: relative; height: 28px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
  .vp-rail { position: absolute; left: 0; right: 0; height: 3px; border-radius: 2px; background: rgba(255,255,255,.28); transition: height .12s; }
  .vp-buf { position: absolute; left: 0; height: 3px; border-radius: 2px; background: rgba(255,255,255,.45); transition: height .12s; }
  .vp-fill { position: absolute; left: 0; height: 3px; border-radius: 2px; background: #fff; transition: height .12s; }
  .vp-knob { position: absolute; top: 50%; width: 13px; height: 13px; border-radius: 50%; background: #fff; transform: translate(-50%, -50%); box-shadow: 0 1px 4px rgba(0,0,0,.4); transition: width .12s, height .12s; }
  .vp-track.live .vp-rail, .vp-track.live .vp-buf, .vp-track.live .vp-fill { height: 5px; }
  .vp-track.live .vp-knob { width: 17px; height: 17px; }
  .vp-bubble { position: absolute; bottom: 30px; transform: translateX(-50%); padding: 5px 12px; border-radius: 999px;
    background: rgba(0,0,0,.72); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #fff; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }

  /* —— ⋮ 设置菜单：底部弹层 —— */
  .vp-sheet-back { position: absolute; inset: 0; z-index: 8; background: rgba(0,0,0,.45); animation: vpFade .16s ease; }
  @keyframes vpFade { from { opacity: 0; } to { opacity: 1; } }
  .vp-sheet { position: absolute; left: 10px; right: 10px; bottom: max(10px, var(--sab)); border-radius: 18px; overflow: hidden;
    background: rgba(28,28,30,.96); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    padding: 6px 0; animation: vpSheetUp .22s cubic-bezier(.22,1,.36,1); }
  @keyframes vpSheetUp { from { transform: translateY(28px); opacity: 0; } to { transform: none; opacity: 1; } }
  .vp-mrow { display: flex; align-items: center; gap: 14px; width: 100%; padding: 13px 18px; color: #fff; font-size: 15px; text-align: left; }
  .vp-mrow:active { background: rgba(255,255,255,.08); }
  .vp-mrow > svg { width: 21px; height: 21px; flex: none; color: rgba(255,255,255,.85); }
  .vp-mrow span { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .vp-mrow span small { font-size: 12px; color: rgba(255,255,255,.5); font-weight: 400; }
  .vp-mrow em { font-style: normal; color: rgba(255,255,255,.55); font-size: 13.5px; flex: none; }
  .vp-mrow .chev { width: 16px; height: 16px; color: rgba(255,255,255,.4); }
  .vp-mrow.head { font-weight: 600; border-bottom: 0.5px solid rgba(255,255,255,.12); margin-bottom: 4px; }
  .vp-mrow.head > svg { width: 18px; height: 18px; }
  .vp-mrow.opt { padding-left: 22px; }
  .vp-mrow .ck { width: 18px; height: 18px; color: #fff; flex: none; }
</style>
