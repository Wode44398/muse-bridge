<script>
  // 工作空间素材选择器（真 api.files 浏览）：面包屑 + 文件夹行 + 图片格（kind='audio' 时是音频行）。
  // 选中回 onPick(rel, name)。
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';
  import { cloudFileUrl } from '../../lib/preview.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { icon } from '../../modules/studio/icons.js';
  import Layer from './ui/Layer.svelte';
  import Img from './ui/Img.svelte';
  import Measure from './ui/Measure.svelte';

  let { onPick, onclose, kind = 'image' } = $props();

  let path = $state(''), items = $state([]), loading = $state(true);
  const EXTS = kind === 'audio' ? ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] : kind === 'video' ? ['mp4', 'mov', 'webm', 'm4v'] : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic'];
  const isHit = (n) => EXTS.includes((n.split('.').pop() || '').toLowerCase());
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const folders = $derived(items.filter((i) => i.isDir));
  const hits = $derived(items.filter((i) => !i.isDir && isHit(i.name)));

  async function load(p) {
    loading = true;
    try { const r = await api.files(p); items = r.items || []; path = r.path ?? p; }
    catch { items = []; }
    loading = false;
  }
  const relOf = (name) => (path ? path + '/' + name : name);
  function goSeg(i) { load(segs.slice(0, i + 1).join('/')); }
  onMount(() => load(''));
</script>

<Layer title={kind === 'audio' ? t('选择音频') : kind === 'video' ? t('选择视频') : t('选择素材图片')} dialog width={560} {onclose}>
  {#snippet head()}
    <nav class="wp-crumb" aria-label={t('位置')}>
      <button class:cur={!segs.length} onclick={() => load('')}>{t('工作空间')}</button>
      {#each segs as s, i}
        <span class="wp-sep" aria-hidden="true">/</span>
        {#if i < segs.length - 1}<button onclick={() => goSeg(i)}>{s}</button>{:else}<span class="cur">{s}</span>{/if}
      {/each}
    </nav>
  {/snippet}
  {#if loading}
    <div class="op-empty"><Measure tone="live" /></div>
  {:else}
    {#if folders.length || (hits.length && kind !== 'image')}
      <div>
        {#each folders as f (f.name)}
          <button class="op" onclick={() => load(relOf(f.name))}>
            <span class="op-ic">{@html icon('folder')}</span>
            <span class="op-tx"><b>{f.name}</b></span>
            <span class="op-ic dim">{@html icon('chevR')}</span>
          </button>
        {/each}
        {#if kind !== 'image'}
          {#each hits as im (im.name)}
            <button class="op" onclick={() => onPick?.(relOf(im.name), im.name)}>
              <span class="op-ic">{@html icon(kind === 'video' ? 'video' : 'audio')}</span>
              <span class="op-tx"><b>{im.name}</b></span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
    {#if hits.length && kind === 'image'}
      <div class="wp-grid">
        {#each hits as im (im.name)}
          <button class="wp-img" aria-label={im.name} title={im.name} onclick={() => onPick?.(relOf(im.name), im.name)}>
            <Img src={cloudFileUrl(relOf(im.name), { thumb: true })} alt="" passive loading="lazy" decoding="async" />
          </button>
        {/each}
      </div>
    {/if}
    {#if !folders.length && !hits.length}<div class="op-empty">{kind === 'audio' ? t('这个文件夹里没有音频') : kind === 'video' ? t('这个文件夹里没有视频') : t('这个文件夹里没有图片')}</div>{/if}
  {/if}
</Layer>
