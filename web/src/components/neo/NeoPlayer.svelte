<script module>
  // 全局互斥：同时只放一个音频（新的 play 会暂停上一个）。
  let current = null;
</script>

<script>
  // vmx 音频播放器：巨型圆播放钮 + 粗胶囊进度（点按可跳转）+ 可选扁平波形（音乐）。
  // 真 <audio> 驱动（src=mediaUrl 带 token），时长从 metadata 读。
  import { icon, fmtT } from '../../lib/neoUi.js';
  import { dragOut } from '../../lib/dragOut.js';
  import { t } from '../../lib/i18n.js';
  // dragSrc：桌面壳里整块播放器可拖出成文件（lib/dragOut.js 来源对象）；进度条上起拖不算。
  let { src, sm = false, wave = false, seed = 0, dragSrc = null } = $props();

  let audio = $state(null);
  let playing = $state(false), cur = $state(0), total = $state(0);

  // 波形条（seed 定型，纯装饰；播放进度点亮）
  let bars = [];
  if (wave) {
    let a = (seed | 0) || 7;
    const R = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let z = Math.imul(a ^ (a >>> 15), 1 | a); z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z; return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
    bars = Array.from({ length: 36 }, () => 18 + R() * 82);
  }

  function toggle() {
    if (!audio) return;
    if (playing) { audio.pause(); return; }
    if (current && current !== audio) { try { current.pause(); } catch {} }
    current = audio;
    audio.play().catch(() => {});
  }
  function seek(e) {
    if (!audio || !total) return;
    const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
  }
</script>

<div class="player" class:sm use:dragOut={() => dragSrc}>
  <button class="pl-btn ic" class:playing aria-label={playing ? t('暂停') : t('播放')} onclick={toggle}>
    {@html icon(playing ? 'pause' : 'play', sm ? 21 : 28)}
  </button>
  <div class="pl-track-wrap">
    {#if wave}
      <div class="wave">{#each bars as h, i (i)}<i class:lit={total > 0 && i / bars.length < cur / total} style="height:{h}%"></i>{/each}</div>
    {/if}
    <div class="pl-track" role="presentation" onclick={seek}>
      <div class="pl-fill" style="width:{total ? (cur / total) * 100 : 0}%"></div>
    </div>
    <div class="pl-time"><span>{fmtT(cur)}</span><span>{total ? fmtT(total) : '–:––'}</span></div>
  </div>
  <audio
    bind:this={audio}
    {src}
    preload="metadata"
    onplay={() => (playing = true)}
    onpause={() => (playing = false)}
    ontimeupdate={() => { if (audio) cur = audio.currentTime || 0; }}
    onloadedmetadata={() => { if (audio && isFinite(audio.duration)) total = audio.duration; }}
    ondurationchange={() => { if (audio && isFinite(audio.duration)) total = audio.duration; }}
    onended={() => { playing = false; cur = 0; }}
  ></audio>
</div>
