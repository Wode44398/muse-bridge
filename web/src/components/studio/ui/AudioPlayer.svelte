<script module>
  // 全局互斥：同时只放一个音频（新的 play 会暂停上一个）。
  let current = null;
</script>

<script>
  // Studio 的音频播放器（§5.2）：34px 墨色圆钮 + 发丝进度轨（点按跳转）+ 等宽计时；音乐可选一排细波形条
  // （seed 定型、纯装饰，播放进度点亮成 ink）。真 <audio> 驱动（src 带 token），时长从 metadata 读。
  import { dragOut } from '../../../lib/dragOut.js';
  import { t } from '../../../lib/i18n.js';
  import { icon, fmtT } from '../../../modules/studio/icons.js';
  import { heal, retryMedia } from '../../../modules/studio/heal.js';
  // dragSrc：桌面壳里整块播放器可拖出成文件（lib/dragOut.js 来源对象）；进度条上起拖不算。
  // duration：作品记录里的时长（秒），首帧就显示，不先出一排「–:––」等 metadata
  let { src, sm = false, wave = false, seed = 0, duration = 0, dragSrc = null } = $props();

  let audio = $state(null);
  // 加载自愈（同 ui/Img：局域网 → 隧道 → 重试）；实在加载不出来时圆钮变成「重新加载」
  let mstate = $state('');
  $effect(() => { src; mstate = ''; });
  let playing = $state(false), cur = $state(0), total = $state(initialTotal());
  function initialTotal() { return Number(duration) > 0 ? Number(duration) : 0; }

  let bars = [];
  if (wave) {
    let a = (seed | 0) || 7;
    const R = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let z = Math.imul(a ^ (a >>> 15), 1 | a); z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z; return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
    bars = Array.from({ length: sm ? 48 : 72 }, () => 16 + R() * 84);
  }

  function toggle() {
    if (!audio) return;
    if (mstate === 'failed') { retryMedia(audio); return; }
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

<div class="ap" class:sm class:failed={mstate === 'failed'} data-nodrag use:dragOut={() => dragSrc}>
  <button class="ap-btn" class:playing class:failed={mstate === 'failed'} aria-label={mstate === 'failed' ? t('重新加载') : playing ? t('暂停') : t('播放')} onclick={toggle}>{@html icon(mstate === 'failed' ? 'reload' : playing ? 'pause' : 'play')}</button>
  <div class="ap-main">
    {#if wave}
      <div class="ap-wave" role="presentation" onclick={seek}>{#each bars as h, i (i)}<i class:lit={total > 0 && i / bars.length < cur / total} style="height:{h}%"></i>{/each}</div>
    {:else}
      <div class="ap-track" role="presentation" onclick={seek}><span style="transform:scaleX({total ? cur / total : 0})"></span></div>
    {/if}
    {#if mstate === 'failed'}
      <!-- 加载失败：计时那一行换成能点的「加载失败 · 重试」，别再显示一副能播的样子 -->
      <button class="ap-fail" type="button" onclick={toggle}>{t('加载失败')}<i aria-hidden="true">·</i>{t('重试')}</button>
    {:else}
      <div class="ap-time"><span>{fmtT(cur)}</span><span>{total ? fmtT(total) : '–:––'}</span></div>
    {/if}
  </div>
  <audio
    bind:this={audio}
    {src}
    use:heal={{ src, onstate: (s) => (mstate = s) }}
    preload="metadata"
    onplay={() => (playing = true)}
    onpause={() => (playing = false)}
    ontimeupdate={() => { if (audio) cur = audio.currentTime || 0; }}
    onloadedmetadata={() => { if (audio && isFinite(audio.duration)) total = audio.duration; }}
    ondurationchange={() => { if (audio && isFinite(audio.duration)) total = audio.duration; }}
    onended={() => { playing = false; cur = 0; }}
  ></audio>
</div>
