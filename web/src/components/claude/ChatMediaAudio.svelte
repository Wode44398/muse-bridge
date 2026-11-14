<script module>
  // 同一时间只响一条：新的一条开播就把上一条停掉
  let current = null;
</script>

<script>
  // 聊天流里生成的音乐 / 语音（mcp__media__generate_music / generate_speech）：紧凑迷你播放条。
  //
  // 以前是裸 <audio controls>：各家 WebView 长得不一样，流式 WAV 在安卓上常报时长 Infinity、拖不动。
  // 现在：暗底白强调（媒体皮肤，与查看器 AudioPlayer 同一套色）——播放 / 暂停、进度条（可点可拖）、
  // 时长、展开到查看器（波形 + 文件信息 + 下载 / 分享都在那边）。
  // 第一次按播放才拉数据：整段下成本地 blob 再播（与查看器同一个缓存键 v:<id>，
  // 播过一次再展开、再播都是本地秒开），时长 / 拖动在任何 WebView 上都可靠。
  import { onDestroy } from 'svelte';
  import { vertexMediaUrl } from '../../lib/preview.svelte.js';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { getBlob, putBlob } from '../../lib/mediaCache.js';
  import { viewerSvg } from '../../lib/viewerIcons.js';
  import { mediaDescriptor, openChatItem } from '../../lib/chatGallery.js';
  import { fmtDuration, knownDuration, probeDuration, rememberDuration, whenVisible } from '../../lib/mediaProbe.js';
  import { t } from '../../lib/i18n.js';

  let { seg } = $props();

  // 父级按 seg.id 重建本组件（{#key}），初值只取一次
  // svelte-ignore state_referenced_locally
  const id = seg.id;
  const cacheKey = 'v:' + id;
  // svelte-ignore state_referenced_locally
  const title = seg.prompt || (seg.mediaKind === 'music' ? t('生成的音乐') : t('生成的语音'));

  let el = $state();
  let audioEl = $state();
  let rail = $state();
  let src = $state('');
  let loading = $state(false), errored = $state(false), playing = $state(false);
  let dur = $state(knownDuration(cacheKey)), cur = $state(0);
  let scrubbing = false, wantPlay = false;
  let revoke = () => {};

  const prog = $derived(dur ? Math.max(0, Math.min(1, cur / dur)) : 0);
  const ICONS = { play: viewerSvg('play'), pause: viewerSvg('pause'), retry: viewerSvg('retry'), expand: viewerSvg('fullscreen') };

  // 进入视口就探一下时长（只拉文件头），没播之前也能看到多长
  $effect(() => {
    if (!el || dur) return;
    let alive = true;
    const stop = whenVisible(el, () => {
      probeDuration(cacheKey, vertexMediaUrl(id), 'audio').then((s) => { if (alive && s && !dur) dur = s; });
    });
    return () => { alive = false; stop(); };
  });

  async function fetchBlob(url) {
    let r;
    try { r = await fetch(url); }
    catch (e) {
      const alt = mediaFallbackUrl(url);   // 局域网直连失败 → 隧道再来一次
      if (alt === url) throw e;
      r = await fetch(alt);
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }

  async function load() {
    loading = true; errored = false;
    try {
      let blob = await getBlob(cacheKey);
      if (!blob) {
        blob = await fetchBlob(vertexMediaUrl(id));
        putBlob(cacheKey, blob);
      }
      revoke();
      const obj = URL.createObjectURL(blob);
      revoke = () => { try { URL.revokeObjectURL(obj); } catch {} };
      src = obj;
    } catch {
      errored = true; wantPlay = false;
    } finally {
      loading = false;
    }
  }

  async function toggle() {
    if (loading) return;
    if (errored || !src) {
      wantPlay = true;
      await load();
      return;   // 数据到了在 oncanplay 里开播
    }
    const a = audioEl;
    if (!a) return;
    if (a.paused) play(); else a.pause();
  }
  function play() {
    const a = audioEl;
    if (!a) return;
    if (current && current !== a) { try { current.pause(); } catch {} }
    current = a;
    a.play().catch(() => {});
  }

  function onCanPlay() { if (wantPlay) { wantPlay = false; play(); } }
  function onMeta() {
    const d = audioEl?.duration;
    if (isFinite(d) && d > 0) { dur = d; rememberDuration(cacheKey, d); }
  }
  function onTime() { if (!scrubbing) cur = audioEl?.currentTime || 0; }
  function onEnd() { playing = false; cur = 0; }
  function onErr() { if (src) { errored = true; playing = false; } }

  // —— 进度条：点 / 拖 ——
  function seekAt(clientX) {
    if (!rail || !dur) return;
    const r = rail.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    cur = p * dur;
    if (audioEl && src) { try { audioEl.currentTime = cur; } catch {} }
  }
  function rDown(e) {
    if (!dur || !src) return;
    scrubbing = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekAt(e.clientX);
  }
  function rMove(e) { if (scrubbing) seekAt(e.clientX); }
  function rUp() { scrubbing = false; }
  function rKey(e) {
    if (!audioEl || !src || !dur) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      cur = Math.max(0, Math.min(dur, (audioEl.currentTime || 0) + (e.key === 'ArrowRight' ? 5 : -5)));
      audioEl.currentTime = cur;
    }
  }

  function expand() {
    try { audioEl?.pause(); } catch {}
    const d = mediaDescriptor(seg);
    openChatItem(dur ? { ...d, duration: dur } : d, el);
  }

  onDestroy(() => {
    try { audioEl?.pause(); } catch {}
    if (current === audioEl) current = null;
    revoke();
  });
</script>

<div class="cma" bind:this={el} title={seg.prompt || ''}>
  <audio bind:this={audioEl} src={src || undefined} preload="auto" data-noheal
    onloadedmetadata={onMeta} ondurationchange={onMeta} oncanplay={onCanPlay} ontimeupdate={onTime}
    onplay={() => (playing = true)} onpause={() => (playing = false)} onended={onEnd} onerror={onErr}></audio>

  <button type="button" class="cma-btn cma-play" onclick={toggle} disabled={loading}
    aria-label={errored ? t('重试') : playing ? t('暂停') : t('播放')}>
    <span class="cma-disc">
      {#if loading}<span class="cma-spin"></span>
      {:else}{@html errored ? ICONS.retry : playing ? ICONS.pause : ICONS.play}{/if}
    </span>
  </button>

  <div class="cma-mid">
    <div class="cma-title">{errored ? t('音频加载失败') : title}</div>
    <div class="cma-rail" bind:this={rail} class:live={!!src && dur > 0}
      onpointerdown={rDown} onpointermove={rMove} onpointerup={rUp} onpointercancel={rUp} onkeydown={rKey}
      role="slider" tabindex={src && dur ? 0 : -1} aria-label={t('进度')}
      aria-valuemin="0" aria-valuenow={Math.round(cur)} aria-valuemax={Math.round(dur)} aria-valuetext={fmtDuration(cur) + ' / ' + fmtDuration(dur)}>
      <span class="cma-track"><span class="cma-fill" style:transform="scaleX({prog})"></span></span>
    </div>
  </div>

  <span class="cma-time">{#if src || cur}{fmtDuration(cur)} / {/if}{dur ? fmtDuration(dur) : '--:--'}</span>

  <button type="button" class="cma-btn cma-exp" onclick={expand} aria-label={t('在查看器中打开')} title={t('在查看器中打开')}>
    {@html ICONS.expand}
  </button>
</div>

<style>
  /* 媒体恒暗、白为唯一强调色（与查看器 AudioPlayer 同色：轨道 .24 白、填充纯白、时间 .72 白） */
  .cma {
    display: flex; align-items: center; gap: 6px; width: min(100%, 440px); height: 60px; padding: 0 6px 0 8px;
    box-sizing: border-box; border-radius: 14px; background: #18181a; color: #fff;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .06) inset;
    -webkit-tap-highlight-color: transparent;
  }
  .cma-btn {
    flex: none; display: flex; align-items: center; justify-content: center; padding: 0; border: 0; background: none;
    color: inherit; font: inherit; cursor: pointer; border-radius: 50%;
  }
  .cma-btn:focus-visible { outline: 2px solid rgba(255, 255, 255, .6); outline-offset: 1px; }
  .cma-play { width: 44px; height: 44px; }
  .cma-disc {
    width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: #fff; color: #111113; transition: transform var(--mo-tap) var(--ea-out);
  }
  .cma-disc :global(svg) { width: 18px; height: 18px; }
  .cma-play:active .cma-disc { transform: scale(.94); }
  .cma-play:disabled { cursor: default; }
  .cma-spin {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(0, 0, 0, .14); border-top-color: #111113;
    animation: cma-rot 0.8s linear infinite;
  }
  @keyframes cma-rot { to { transform: rotate(360deg); } }

  .cma-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding-left: 4px; }
  .cma-title { font-size: 13px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: rgba(255, 255, 255, .92); }
  /* 进度条命中区 20px 高（细轨 3px 居中）；手指拖动不滚页面 */
  .cma-rail { height: 20px; display: flex; align-items: center; touch-action: none; outline: none; cursor: default; }
  .cma-rail.live { cursor: pointer; }
  .cma-rail:focus-visible .cma-track { box-shadow: 0 0 0 2px rgba(255, 255, 255, .25); }
  .cma-track { position: relative; flex: 1; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .24); overflow: hidden; }
  .cma-fill { position: absolute; inset: 0; background: #fff; transform-origin: 0 50%; transform: scaleX(0); }

  .cma-time { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, .72); padding: 0 2px 0 6px; }
  .cma-exp { width: 44px; height: 44px; color: rgba(255, 255, 255, .72); }
  .cma-exp :global(svg) { width: 20px; height: 20px; }
  @media (hover: hover) and (pointer: fine) {
    .cma-exp { width: 32px; height: 32px; border-radius: 8px; transition: background-color var(--mo-micro) var(--ea-out), color var(--mo-micro) var(--ea-out); }
    .cma-exp:hover { background: rgba(255, 255, 255, .1); color: #fff; }
    .cma-exp :global(svg) { width: 18px; height: 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cma-disc { transition: none; }
    .cma-play:active .cma-disc { transform: none; }
    .cma-spin { animation-duration: 2.4s; }
  }
</style>
