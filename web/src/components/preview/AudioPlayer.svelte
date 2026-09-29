<script>
  // 自定义音频播放器（查看器内"正在播放"）。替换裸 <audio controls>：
  //   · 波形可视化（Web Audio 解码抽峰，按 cacheKey 内存缓存，再开不重解码）+ 点击/拖动波形 seek
  //   · 大播放/暂停、当前/总时长；本地缓存接入（mediaCache）听过即本地秒播
  //   · 明/暗双配色（dark：查看器深底；浅：浅色宿主）；解码失败/超大文件回落纯进度条仍可用
  import { onMount, onDestroy } from 'svelte';
  import { getBlob, putBlob } from '../../lib/mediaCache.js';
  import { t } from '../../lib/i18n.js';

  let { item, dark = false } = $props();

  let audioEl = $state();
  let src = $state(''), revoke = () => {};
  let playing = $state(false), dur = $state(0), cur = $state(0);
  let errored = $state(false), loadingSrc = $state(true);
  let canvas = $state();
  let peaks = null;          // Float32 归一化峰值数组
  let scrubbing = false;

  const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), x = Math.floor(s % 60); return m + ':' + String(x).padStart(2, '0'); };

  // —— 峰值内存缓存（跨实例复用，免重复解码）——
  const PEAKS = (window.__bridgeWavePeaks ||= new Map());
  const N_PEAKS = 160;

  let _ac = null;
  function audioCtx() { try { return (_ac ||= new (window.AudioContext || window.webkitAudioContext)()); } catch { return null; } }

  async function decodeWave(blob) {
    if (item.cacheKey && PEAKS.has(item.cacheKey)) { peaks = PEAKS.get(item.cacheKey); draw(); return; }
    try {
      const buf = await blob.arrayBuffer();
      if (buf.byteLength > 30 * 1024 * 1024) return;   // 太大不解码（回落纯进度条）
      const ac = audioCtx(); if (!ac) return;
      const ab = await ac.decodeAudioData(buf.slice(0));
      const ch = ab.getChannelData(0);
      const block = Math.floor(ch.length / N_PEAKS) || 1;
      const out = new Float32Array(N_PEAKS);
      let max = 0;
      for (let i = 0; i < N_PEAKS; i++) {
        let m = 0; const start = i * block;
        for (let j = 0; j < block; j++) { const v = Math.abs(ch[start + j] || 0); if (v > m) m = v; }
        out[i] = m; if (m > max) max = m;
      }
      if (max > 0) for (let i = 0; i < N_PEAKS; i++) out[i] /= max;
      peaks = out;
      if (item.cacheKey) PEAKS.set(item.cacheKey, out);
      draw();
    } catch {}
  }

  function draw() {
    const c = canvas; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const dim = dark ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.20)';
    const acc = dark ? '#fff' : 'var(--g-primary, #1a73e8)';
    const prog = dur ? cur / dur : 0;
    const n = peaks ? peaks.length : N_PEAKS;
    const gap = 2, bw = Math.max(1.5, (w - (n - 1) * gap) / n);
    for (let i = 0; i < n; i++) {
      const v = peaks ? peaks[i] : 0.12;
      const bh = Math.max(2, v * (h - 4));
      const x = i * (bw + gap), y = (h - bh) / 2;
      ctx.fillStyle = (i / n) <= prog ? acc : dim;
      ctx.beginPath();
      const r = Math.min(bw / 2, 2);
      ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
      ctx.fill();
    }
  }

  // 音频文件小 → 一律下成完整本地 blob 再播（objectURL）：duration/seek/播放在任何 WebView/网络都可靠。
  // 跨源流式 WAV 在 Android WebView 上常报 duration=Infinity（进度条 0、播不动），blob 根治；顺手入缓存秒播。
  async function load() {
    errored = false; loadingSrc = true;
    try {
      revoke();
      let blob = await getBlob(item.cacheKey);
      if (!blob) {
        const r = await fetch(item.url, { credentials: 'same-origin' });
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        blob = await r.blob();
        if (item.cacheKey) putBlob(item.cacheKey, blob);
      }
      const obj = URL.createObjectURL(blob);
      revoke = () => { try { URL.revokeObjectURL(obj); } catch {} };
      src = obj;
      decodeWave(blob);
    } catch (e) { errored = true; }
    finally { loadingSrc = false; }
  }

  function onMeta() {
    const d = audioEl?.duration;
    if (d === Infinity) { try { audioEl.currentTime = 1e7; } catch {} return; }   // 流式无时长兜底：跳极大处逼出真时长
    dur = (isFinite(d) && d > 0) ? d : 0;
  }
  function onDur() { const d = audioEl?.duration; if (isFinite(d) && d > 0) { dur = d; if (audioEl.currentTime > d) { try { audioEl.currentTime = 0; } catch {} } } }
  function onTime() { if (!scrubbing) { cur = audioEl?.currentTime || 0; draw(); } }
  function onPlay() { playing = true; }
  function onPause() { playing = false; }
  function onEnd() { playing = false; cur = 0; draw(); }
  function onErr() { if (!src) return; errored = true; }
  function toggle() { if (errored) { load(); return; } const a = audioEl; if (!a) return; if (a.paused) a.play().catch(() => {}); else a.pause(); }

  function seekAt(clientX) { const r = canvas.getBoundingClientRect(); const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width)); cur = p * (dur || 0); if (audioEl) audioEl.currentTime = cur; draw(); }
  function wDown(e) { scrubbing = true; canvas.setPointerCapture?.(e.pointerId); seekAt(e.clientX); }
  function wMove(e) { if (scrubbing) seekAt(e.clientX); }
  function wUp() { scrubbing = false; }

  onMount(() => { load(); const ro = new ResizeObserver(() => draw()); if (canvas) ro.observe(canvas); return () => ro.disconnect(); });
  onDestroy(() => { revoke(); try { audioEl?.pause(); } catch {} });
</script>

<div class="ap" class:dark>
  <audio bind:this={audioEl} src={src || undefined} preload="metadata"
    onloadedmetadata={onMeta} ondurationchange={onDur} ontimeupdate={onTime} onplay={onPlay} onpause={onPause} onended={onEnd} onerror={onErr}></audio>

  <button class="ap-play" aria-label={errored ? t('重试') : playing ? t('暂停') : t('播放')} disabled={loadingSrc} onclick={toggle}>
    {#if loadingSrc}
      <span class="ap-spin"></span>
    {:else if errored}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
    {:else if playing}
      <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
    {/if}
  </button>

  <div class="ap-mid">
    <canvas class="ap-wave" bind:this={canvas} onpointerdown={wDown} onpointermove={wMove} onpointerup={wUp} onpointercancel={wUp} role="slider" tabindex="0" aria-label={t('进度')} aria-valuenow={Math.round(cur)} aria-valuemax={Math.round(dur)}></canvas>
  </div>
  <span class="ap-time">{fmt(cur)} / {fmt(dur)}</span>
</div>

<style>
  .ap { display: flex; align-items: center; gap: 12px; width: 100%; }
  .ap-play { width: 46px; height: 46px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--g-primary, #1a73e8); color: #fff; transition: transform .12s, filter .12s; }
  .ap-play svg { width: 24px; height: 24px; margin-left: 1px; }
  .ap-play:active { transform: scale(.94); filter: brightness(.95); }
  .ap-play:disabled { opacity: .75; }
  .ap-spin { width: 20px; height: 20px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.45); border-top-color: #fff; animation: apspin .8s linear infinite; }
  @keyframes apspin { to { transform: rotate(360deg); } }
  .ap-mid { flex: 1; min-width: 0; }
  .ap-wave { display: block; width: 100%; height: 40px; touch-action: none; cursor: pointer; }
  .ap-time { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--g-on-variant, #5f6368); min-width: 74px; text-align: right; }

  /* 暗色（查看器内"正在播放"）*/
  .ap.dark .ap-play { background: rgba(255,255,255,.18); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
  .ap.dark .ap-play:active { background: rgba(255,255,255,.3); }
  .ap.dark .ap-time { color: rgba(255,255,255,.8); }
</style>
