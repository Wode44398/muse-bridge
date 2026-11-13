<script>
  // 画布上一件作品下面那一行（v3，方案 §9.2「画布」）：mono text3 元信息（模型 · 尺寸 / 时长 · 用时）+ 操作
  // （复用参数 / 接着做 / 下载 / …）。操作桌面悬停浮现（透明度，占位不变不跳）、触屏常显。
  import { t } from '../../../lib/i18n.js';
  import { studio, modelLabelOf, reuseParams, continueActions, mediaSrc } from '../../../modules/studio/media.svelte.js';
  import { icon } from '../../../modules/studio/icons.js';
  import WorkMenu from '../WorkMenu.svelte';

  let { asset, job = null } = $props();

  const fmtDur = (s) => (s >= 60 ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : (Math.round(s * 10) / 10) + 's');
  const took = $derived.by(() => {
    const j = job || studio.jobs.find((x) => x.id === asset?.jobId);
    const a = Date.parse(j?.createdAt) || j?.createdAt, b = Date.parse(j?.finishedAt) || j?.finishedAt;
    return a && b && b > a ? fmtDur((b - a) / 1000) : '';
  });
  const bits = $derived([
    modelLabelOf(asset),
    asset?.w && asset?.h && (asset.kind === 'image' || asset.kind === 'video') ? `${asset.w}×${asset.h}` : '',
    asset?.duration && asset.kind === 'video' ? fmtDur(asset.duration) : '',   // 配音 / 音乐的时长播放器里有，不重复
    took,
  ].filter(Boolean));
  const conts = $derived(continueActions(asset));
  let menu = $state(null);   // { anchor, mode }
  function download() {
    const el = document.createElement('a');
    el.href = mediaSrc(asset); el.download = (asset.prompt || 'studio').slice(0, 40);
    document.body.appendChild(el); el.click(); el.remove();
  }
</script>

<div class="art-foot">
  <span class="art-meta">{#each bits as b, i}{#if i}<i aria-hidden="true">·</i>{/if}<span class:mono={i > 0}>{b}</span>{/each}</span>
  <span class="art-acts">
    <button class="art-b tx" title={t('复用参数')} aria-label={t('复用参数')} onclick={() => reuseParams(asset)}>{@html icon('reuse')}<span>{t('复用参数')}</span></button>
    {#if conts.length}
      <button class="art-b tx" title={t('接着做')} aria-label={t('接着做')} aria-haspopup="menu" onclick={(e) => (menu = { anchor: e.currentTarget, mode: 'continue' })}>{@html icon('next')}<span>{t('接着做')}</span></button>
    {/if}
    <button class="art-b" title={t('下载')} aria-label={t('下载')} onclick={download}>{@html icon('download')}</button>
    <button class="art-b" title={t('更多')} aria-label={t('更多')} aria-haspopup="menu" onclick={(e) => (menu = { anchor: e.currentTarget, mode: 'all' })}>{@html icon('more')}</button>
  </span>
</div>
{#if menu}
  <WorkMenu {asset} anchor={menu.anchor} only={menu.mode === 'continue' ? 'continue' : ''} align="end" onclose={() => (menu = null)} />
{/if}
