<script>
  // 视频 / 配音 / 音乐三页的画布（v3，方案 §9.2）：「正在看的那一件」（进行中的任务、刚出的结果、或从作品栏点开的作品），
  // 下面在作品栏收起时附上这一类最近的作品（作品栏开着就不重复摆）。什么都没有时是宋体展示句 + 线稿。
  // 版式同图像页：提示词气泡 → 作品落在纸上（圆角 12、细线、浮起投影）→ 一行 mono 元信息 + 操作。配音的正文本身是稿子，留在卡里。
  import { t, tc } from '../../lib/i18n.js';
  import { openPreview } from '../../lib/preview.svelte.js';
  import { dragOut, canDragOut } from '../../lib/dragOut.js';
  import { studio, mediaSrc, assetDragSrc, openAsset, retryJob, currentModel, valuesOf } from '../../modules/studio/media.svelte.js';
  import { assetDrag } from '../../modules/studio/assetDrag.js';
  import { icon } from '../../modules/studio/icons.js';
  import AudioPlayer from './ui/AudioPlayer.svelte';
  import Empty from './ui/Empty.svelte';
  import ErrCard from './ui/ErrCard.svelte';
  import Img from './ui/Img.svelte';
  import ArtFoot from './ui/ArtFoot.svelte';
  import BusyFrame from './ui/BusyFrame.svelte';

  let { page, sideOpen = false } = $props();

  const AK = { video: 'video', voice: 'audio', music: 'music' };
  const focus = $derived(studio.views[page]?.focus || null);
  const job = $derived(focus?.jobId ? studio.jobs.find((j) => j.id === focus.jobId) : null);
  const asset = $derived(focus?.asset || (job?.state === 'done' ? job.result?.[0] : null) || null);
  const busy = $derived(!!job && (job.state === 'queued' || job.state === 'running'));
  const recent = $derived(studio.assets.filter((a) => a.kind === AK[page] && a.id !== asset?.id).slice(0, page === 'video' ? 12 : 8));
  const nativeOut = canDragOut();
  // 长提示词在气泡里先收成 6 行，点一下展开
  let open = $state(false);
  $effect(() => { asset?.id; open = false; });
  function openVideo(a) { openPreview([{ origin: 'vertex', id: a.id, name: a.prompt || tc('名词', '生成视频'), kind: 'video' }], 0); }
  const seedOf = (id) => { let h = 7; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };
  // 视频进行中的占位框按目标比例画
  const ratio = $derived.by(() => {
    if (page !== 'video') return '';
    const vals = valuesOf('video', currentModel('video'));
    for (const k of Object.keys(vals)) { const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(vals[k] || '')); if (m) return `${m[1]} / ${m[2]}`; }
    return '16 / 9';
  });
</script>

<div class="fc" class:solo={!busy && !!asset && (sideOpen || !recent.length)}>
  {#if busy}
    {#if job.prompt && page !== 'voice'}<div class="ch-user"><div class="ch-bubble sel-text clamp"><span>{job.prompt}</span></div></div>{/if}
    <BusyFrame {job} {ratio} flat={page !== 'video'} modelLabel={currentModel(page)?.label || ''} />
  {:else if job && job.state === 'error'}
    <ErrCard error={job.error} {page} prompt={job.prompt || ''} onretry={() => retryJob(job)} />
  {:else if asset}
    {#if (page === 'video' || page === 'music') && asset.prompt}
      <div class="ch-user"><div class="ch-bubble sel-text" class:clamp={!open} role="presentation" onclick={() => (open = true)}><span>{asset.prompt}</span></div></div>
    {/if}
    <figure class="art">
      {#if page === 'video'}
        <div class="fc-media" data-asset={asset.id} role="button" tabindex="0" aria-label={asset.prompt || tc('名词', '生成视频')}
          use:dragOut={() => (nativeOut ? assetDragSrc(asset) : null)}
          onclick={() => openVideo(asset)} onkeydown={(e) => { if (e.key === 'Enter') openVideo(asset); }}>
          <Img src={mediaSrc(asset, 'preview')} alt="" label decoding="async" draggable={nativeOut} width={asset.w || undefined} height={asset.h || undefined} />
          <span class="fc-play">{@html icon('play')}</span>
        </div>
      {:else}
        <div class="fc-audio" data-asset={asset.id}>
          {#if page === 'voice'}<p class="sel-text">{asset.prompt || t('配音')}</p>{/if}
          <AudioPlayer src={mediaSrc(asset)} wave={page === 'music'} seed={seedOf(asset.id)} duration={asset.duration || 0} dragSrc={nativeOut ? assetDragSrc(asset) : null} />
        </div>
      {/if}
      <ArtFoot {asset} {job} />
    </figure>
  {:else if sideOpen || !recent.length}
    <Empty {page} />
  {/if}
</div>
{#if !sideOpen && recent.length}
  <div class="cv-recent">
    {#if page === 'video'}
      <div class="cv-grid wide">
        {#each recent as a (a.id)}
          <div class="cv-thumb" role="button" tabindex="0" use:assetDrag={{ asset: a }} onclick={() => openAsset(a)} onkeydown={(e) => { if (e.key === 'Enter') openAsset(a); }}>
            <Img src={mediaSrc(a, 'thumb')} alt="" loading="lazy" decoding="async" draggable="false" />
            <span class="wr-play">{@html icon('play')}</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="cv-list">
        {#each recent as a (a.id)}
          <div class="cv-row" use:assetDrag={{ asset: a }}>
            <p>{a.prompt || (page === 'voice' ? t('配音') : t('音乐'))}</p>
            <AudioPlayer src={mediaSrc(a)} sm wave={page === 'music'} seed={seedOf(a.id)} duration={a.duration || 0} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
