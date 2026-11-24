<script module>
  // 全局单活播放器协调：点播另一条语音气泡时自动暂停上一条
  let stopActivePlayer = null;
</script>

<script>
  // Antigravity 原生语音气泡（直发 Gemini 原生音频）：
  //   · 沿用 Gemini 用户气泡外廓（22px 6px 22px 22px），内嵌播放/暂停键、28 柱可点按拖拽定位声纹与等宽时长；
  //   · 刚录完的当轮直接用本地 blob: URL 零延迟回放；重开历史 / 跨设备自动走 /api/agy/artifact 流式播放（支持 Range）；
  //   · 声纹优先用实时记录的 peaks → 本机 localStorage 缓存 → 确定性语流轮廓（首次加载/播放时可选从真音频补回真声纹）。
  import { onDestroy } from 'svelte';
  import { agyArtifactUrl } from '../../lib/preview.svelte.js';
  import {
    VOICE_BAR_COUNT,
    fallbackPeaksFor,
    formatVoiceDuration,
    loadVoicePeaks,
    parseVoiceFileName,
    peaksFromPcm,
    saveVoicePeaks,
  } from '../../lib/agy/voice-peaks.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t } from '../../lib/i18n.js';

  const { att, sessionId = '', fresh = false } = $props();

  const localUrl = $derived(/^(?:blob:|data:)/i.test(att?.url || '') ? att.url : '');
  const srcUrl = $derived(
    localUrl
      || (att?.path ? agyArtifactUrl(sessionId, att.path, { name: att.name }) : '')
      || (att?.url || '')
  );

  const parsedName = $derived(parseVoiceFileName(att?.name || att?.path || ''));
  let metaDuration = $state(0);
  const totalSec = $derived(
    metaDuration > 0
      ? metaDuration
      : (Number(att?.duration) > 0 ? Number(att.duration) : (parsedName?.duration || 1))
  );

  let decodedPeaks = $state(null);
  const bars = $derived.by(() => {
    if (Array.isArray(att?.peaks) && att.peaks.length >= 8) return att.peaks;
    if (Array.isArray(decodedPeaks) && decodedPeaks.length >= 8) return decodedPeaks;
    const cached = loadVoicePeaks(att?.path || '') || loadVoicePeaks(att?.name || '');
    if (cached && cached.length >= 8) return cached;
    return fallbackPeaksFor(att?.path || att?.name || 'voice', VOICE_BAR_COUNT);
  });

  let alive = true;
  let playing = $state(false);
  let progress = $state(0);   // 0..1
  let audioEl = null;
  let rafId = 0;
  let waveformEl = $state(null);
  let decodedAttempted = false;

  const shownTime = $derived(
    playing || progress > 0.005
      ? formatVoiceDuration(Math.max(0, totalSec * (1 - progress)))
      : formatVoiceDuration(totalSec)
  );
  const litIndex = $derived(playing || progress > 0.005 ? Math.floor(progress * bars.length) : -1);

  function ensureAudio() {
    if (audioEl) return audioEl;
    if (!srcUrl) return null;
    const a = new Audio(srcUrl);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (!alive) return;
      if (Number.isFinite(a.duration) && a.duration > 0) metaDuration = a.duration;
    };
    a.onended = () => {
      if (!alive) return;
      stopPlayback(true);
    };
    a.onerror = () => {
      if (!alive) return;
      stopPlayback(true);
      showToast(t('语音加载失败，请稍后重试'), 'err');
    };
    audioEl = a;
    return a;
  }

  // 跨设备重开历史消息首次点播时，静默从远端 WAV 提取真实 28 柱声纹并写缓存
  async function maybeExtractRealPeaks() {
    if (decodedAttempted || !srcUrl) return;
    if (Array.isArray(att?.peaks) && att.peaks.length >= 8) return;
    if (loadVoicePeaks(att?.path || '') || loadVoicePeaks(att?.name || '')) return;
    decodedAttempted = true;
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) return;
    let actx = null;
    try {
      const resp = await fetch(srcUrl, { credentials: 'same-origin' });
      if (!resp.ok) return;
      const buf = await resp.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 12 * 1024 * 1024) return;
      actx = new AudioCtx();
      const decoded = await actx.decodeAudioData(buf.slice(0));
      const ch = decoded.getChannelData(0);
      const next = peaksFromPcm(ch, VOICE_BAR_COUNT);
      if (next.length >= 8) {
        decodedPeaks = next;
        if (att?.path) saveVoicePeaks(att.path, next);
        if (att?.name) saveVoicePeaks(att.name, next);
      }
    } catch {} finally {
      try { actx?.close(); } catch {}
    }
  }

  function tick() {
    if (!playing || !audioEl) { rafId = 0; return; }
    const dur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : totalSec;
    if (dur > 0) progress = Math.max(0, Math.min(1, audioEl.currentTime / dur));
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback(reset = false) {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (audioEl) {
      try { audioEl.pause(); } catch {}
      if (reset) { try { audioEl.currentTime = 0; } catch {} }
    }
    if (reset) progress = 0;
    if (stopActivePlayer === pauseFromOther) stopActivePlayer = null;
  }

  function pauseFromOther() {
    stopPlayback(false);
  }

  async function togglePlay() {
    if (playing) {
      stopPlayback(false);
      return;
    }
    const a = ensureAudio();
    if (!a) return;
    if (stopActivePlayer && stopActivePlayer !== pauseFromOther) {
      try { stopActivePlayer(); } catch {}
    }
    stopActivePlayer = pauseFromOther;
    if (progress >= 0.995) {
      try { a.currentTime = 0; } catch {}
      progress = 0;
    }
    playing = true;
    maybeExtractRealPeaks();
    try {
      await a.play();
      if (playing && !rafId) rafId = requestAnimationFrame(tick);
    } catch {
      stopPlayback(false);
    }
  }

  function seekToClientX(clientX) {
    if (!waveformEl) return;
    const r = waveformEl.getBoundingClientRect();
    if (!r.width) return;
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    progress = p;
    const a = ensureAudio();
    if (a) {
      const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : totalSec;
      if (dur > 0) {
        try { a.currentTime = p * dur; } catch {}
      }
    }
  }

  function onWavePointerDown(ev) {
    if (ev.button && ev.button !== 0) return;
    ev.stopPropagation();
    seekToClientX(ev.clientX);
    const el = ev.currentTarget;
    const pid = ev.pointerId;
    try { el.setPointerCapture(pid); } catch {}
    const onMove = (mev) => {
      if (mev.pointerId !== pid) return;
      seekToClientX(mev.clientX);
    };
    const onUp = (uev) => {
      if (uev.pointerId !== pid) return;
      try { el.releasePointerCapture(pid); } catch {}
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  onDestroy(() => {
    alive = false;
    stopPlayback(false);
    if (audioEl) {
      audioEl.onloadedmetadata = null;
      audioEl.onended = null;
      audioEl.onerror = null;
      try { audioEl.removeAttribute('src'); audioEl.load(); } catch {}
      audioEl = null;
    }
  });
</script>

<div class="agy-voice-bubble" class:sent={fresh} class:playing title={t('原生语音消息')}>
  <button
    type="button"
    class="vb-play"
    onclick={togglePlay}
    aria-label={playing ? t('暂停语音') : t('播放语音')}
  >
    {#if playing}
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <rect x="4" y="3.2" width="2.8" height="9.6" rx="1" />
        <rect x="9.2" y="3.2" width="2.8" height="9.6" rx="1" />
      </svg>
    {:else}
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M4.6 3.2v9.6a.6.6 0 0 0 .92.5l7.4-4.8a.6.6 0 0 0 0-1l-7.4-4.8a.6.6 0 0 0-.92.5Z" />
      </svg>
    {/if}
  </button>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={waveformEl}
    class="vb-wave"
    role="slider"
    tabindex="0"
    aria-label={t('语音播放进度')}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={Math.round(progress * 100)}
    onpointerdown={onWavePointerDown}
    onkeydown={(e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePlay(); }
    }}
  >
    {#each bars as v, bi (bi)}
      <span
        class="vb-bar"
        class:played={bi <= litIndex}
        style:height="{Math.round(4 + v * 17)}px"
      ></span>
    {/each}
  </div>

  <span class="vb-dur">{shownTime}</span>
</div>

<style>
  .agy-voice-bubble {
    display: inline-flex;
    align-items: center;
    gap: 11px;
    padding: 8px 14px 8px 9px;
    border-radius: 22px 6px 22px 22px;
    background: var(--ag-bubble-bg);
    color: var(--ag-bubble-on);
    min-width: 196px;
    max-width: min(85%, 320px);
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .agy-voice-bubble.sent {
    transform-origin: 100% 100%;
    animation: agy-vb-sent 0.5s cubic-bezier(0.05, 0.7, 0.1, 1) backwards;
  }
  @keyframes agy-vb-sent {
    from { opacity: 0; transform: translateY(24px) scale(0.93); }
    40% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agy-voice-bubble.sent { animation: none; }
  }

  .vb-play {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--ag-accent-fill);
    color: var(--ag-on-accent, #fff);
    display: grid;
    place-items: center;
    flex: none;
    transition: transform 0.16s var(--ag-ease-std), background-color 0.16s var(--ag-ease-std);
  }
  .vb-play:hover { background: var(--ag-accent-strong); }
  .vb-play:active { transform: scale(0.9); }
  .vb-play svg { width: 15px; height: 15px; }

  .vb-wave {
    flex: 1;
    height: 24px;
    display: flex;
    align-items: center;
    gap: 2.5px;
    min-width: 96px;
    cursor: pointer;
    touch-action: none;
  }
  .vb-wave:focus-visible {
    outline: 2px solid var(--ag-accent);
    outline-offset: 3px;
    border-radius: 6px;
  }
  .vb-bar {
    flex: 1;
    min-width: 2px;
    border-radius: 99px;
    background: color-mix(in srgb, var(--ag-on) 24%, transparent);
    transition: background-color 0.1s;
  }
  .vb-bar.played {
    background: var(--ag-accent);
  }

  .vb-dur {
    font-size: 12.5px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: var(--ag-on-dim);
    flex: none;
    min-width: 28px;
    text-align: right;
  }
</style>
