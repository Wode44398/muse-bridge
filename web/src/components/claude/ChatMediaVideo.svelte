<script>
  // 聊天流里生成的视频（mcp__media__generate_video）：海报卡，点开进查看器即播。
  //
  // 以前是裸 <video controls>：手机上一块黑底系统控件，没有画面、没有时长，全屏也是系统的那套。
  // 现在：真画面海报（服务端从视频抽的一帧 webp，1280 档）+ 中央播放钮 + 右下角时长；
  // 点卡片 = 打开统一查看器（VideoPlayer 自动播放，倍速 / 画中画 / 下载 / 线路自愈都在那边）。
  // 海报失败的退路：① 局域网地址换隧道 ② 抽帧不可用（服务端此时回原文件，<img> 必失败）→
  // 用静音 <video preload=metadata> 自己显示第一帧 ③ 仍不行露一块暗色占位，照样能点开播放。
  // 时长：卡片进入视口才探（只拉文件头），探到前不显示，不影响点开。
  import { vertexMediaUrl } from '../../lib/preview.svelte.js';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { viewerSvg } from '../../lib/viewerIcons.js';
  import { mediaDescriptor, openChatItem } from '../../lib/chatGallery.js';
  import { fmtDuration, knownDuration, probeDuration, rememberDuration, whenVisible } from '../../lib/mediaProbe.js';
  import { t } from '../../lib/i18n.js';

  let { seg } = $props();

  // 父级按 seg.id 重建本组件（{#key}），这里的初值只取一次即可
  // svelte-ignore state_referenced_locally
  const id = seg.id;
  const durKey = 'v:' + id;
  let el = $state();
  let stage = $state('img');                 // img | video | none
  let posterSrc = $state(vertexMediaUrl(id, 'preview'));
  let videoSrc = $state(vertexMediaUrl(id));
  let ar = $state(16 / 9);
  let dur = $state(knownDuration(durKey));

  const ICON_PLAY = viewerSvg('play');
  const ICON_VIDEO = viewerSvg('video');

  function fitAr(w, h) { if (w > 0 && h > 0) ar = Math.max(0.4, Math.min(2.4, w / h)); }

  function onPosterLoad(e) { fitAr(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); }
  function onPosterError(e) {
    const cur = e.currentTarget.src;
    const next = mediaFallbackUrl(cur);
    if (next !== cur) { posterSrc = next; return; }
    stage = 'video';
  }
  function onFrameMeta(e) {
    const v = e.currentTarget;
    fitAr(v.videoWidth, v.videoHeight);
    if (isFinite(v.duration) && v.duration > 0) { dur = v.duration; rememberDuration(durKey, v.duration); }
  }
  function onFrameError(e) {
    const cur = e.currentTarget.currentSrc || e.currentTarget.src;
    const next = mediaFallbackUrl(cur);
    if (next !== cur) { videoSrc = next.replace(/#t=[\d.]+$/, ''); return; }
    stage = 'none';
  }

  $effect(() => {
    if (!el || dur) return;
    let alive = true;
    const stop = whenVisible(el, () => {
      probeDuration(durKey, vertexMediaUrl(id), 'video').then((s) => { if (alive && s) dur = s; });
    });
    return () => { alive = false; stop(); };
  });

  function open() {
    const d = mediaDescriptor(seg);
    openChatItem(dur ? { ...d, duration: dur } : d, el);
  }
</script>

<button type="button" class="cmv" bind:this={el} style:--ar={ar} onclick={open}
  aria-label={t('播放视频') + (dur ? ' · ' + fmtDuration(dur) : '')} title={seg.prompt || ''}>
  {#if stage === 'img'}
    <img class="cmv-media" src={posterSrc} alt="" loading="lazy" decoding="async" draggable="false" onload={onPosterLoad} onerror={onPosterError} />
  {:else if stage === 'video'}
    <video class="cmv-media" src={videoSrc + '#t=0.1'} muted playsinline preload="metadata" disablepictureinpicture data-noheal
      tabindex="-1" onloadedmetadata={onFrameMeta} onerror={onFrameError}></video>
  {:else}
    <span class="cmv-ph" aria-hidden="true">{@html ICON_VIDEO}</span>
  {/if}
  <span class="cmv-play" aria-hidden="true">{@html ICON_PLAY}</span>
  {#if dur}<span class="cmv-dur" aria-hidden="true">{fmtDuration(dur)}</span>{/if}
</button>

<style>
  /* 媒体恒暗：卡片底色、角标都是暗底白字，不随亮暗主题变 */
  .cmv {
    position: relative; display: block; padding: 0; border: 0; overflow: hidden; cursor: pointer;
    width: min(100%, 480px, calc(420px * var(--ar))); aspect-ratio: var(--ar);
    border-radius: 12px; background: #141416; color: #fff; font: inherit;
    -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; user-select: none;
  }
  .cmv:focus-visible { outline: 2px solid var(--accent, #fff); outline-offset: 2px; }
  .cmv-media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
  .cmv-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255, 255, 255, .28); }
  .cmv-ph :global(svg) { width: 40px; height: 40px; }
  .cmv-play {
    position: absolute; left: 50%; top: 50%; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45); color: #fff;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .14) inset;
    transition: transform var(--mo-tap) var(--ea-out), background-color var(--mo-tap) var(--ea-out);
  }
  .cmv-play :global(svg) { width: 24px; height: 24px; margin-left: 2px; }
  .cmv:active .cmv-play { transform: scale(.94); }
  @media (hover: hover) and (pointer: fine) {
    .cmv:hover .cmv-play { background: rgba(0, 0, 0, .6); }
  }
  .cmv-dur {
    position: absolute; right: 8px; bottom: 8px; padding: 2px 7px; border-radius: 6px;
    background: rgba(0, 0, 0, .6); color: #fff; font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums;
  }
  @media (prefers-reduced-motion: reduce) {
    .cmv-play { transition: none; }
    .cmv:active .cmv-play { transform: none; }
  }
</style>
