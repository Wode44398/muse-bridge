<script>
  // 工作空间素材选择器（真 api.files 浏览）：面包屑 + 文件夹行 + 3 列图片网格。
  // 选中回 onPick(rel, name)。视觉走 vmx 设计语言（替代旧 VMaterialPicker 的 mp-* 样式）。
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';
  import { cloudFileUrl } from '../../lib/preview.svelte.js';
  import { icon } from '../../lib/neoUi.js';
  import NeoSheet from './NeoSheet.svelte';
  import { t } from '../../lib/i18n.js';

  let { onPick, onclose } = $props();

  let path = $state(''), items = $state([]), loading = $state(true);
  const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic'];
  const isImg = (n) => IMG.includes((n.split('.').pop() || '').toLowerCase());
  const segs = $derived(path ? path.split('/').filter(Boolean) : []);
  const folders = $derived(items.filter((i) => i.isDir));
  const images = $derived(items.filter((i) => !i.isDir && isImg(i.name)));

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

<NeoSheet title={t('选择素材图片')} tall {onclose}>
  {#snippet head()}
    <div class="ws-crumb">
      <button class:cur={!segs.length} onclick={() => load('')}>{t('工作空间')}</button>
      {#each segs as s, i}
        <span class="sep">›</span>
        {#if i < segs.length - 1}<button onclick={() => goSeg(i)}>{s}</button>{:else}<span class="cur">{s}</span>{/if}
      {/each}
    </div>
  {/snippet}
  {#if loading}
    <div class="ws-spin"></div>
  {:else}
    {#each folders as f (f.name)}
      <button class="ws-folder" onclick={() => load(relOf(f.name))}>
        <span class="ic">{@html icon('folder', 24)}</span>
        <span class="ws-fname">{f.name}</span>
        <span class="ic" style="opacity:.5">{@html icon('chevR', 18)}</span>
      </button>
    {/each}
    {#if images.length}
      <div class="ws-grid">
        {#each images as im (im.name)}
          <button class="ws-img" aria-label={im.name} onclick={() => onPick?.(relOf(im.name), im.name)}>
            <img src={cloudFileUrl(relOf(im.name), { thumb: true })} alt="" loading="lazy" onerror={(e) => (e.currentTarget.style.opacity = '0')} />
          </button>
        {/each}
      </div>
    {/if}
    {#if !folders.length && !images.length}<div class="ws-empty">{t('这个文件夹里没有图片')}</div>{/if}
  {/if}
</NeoSheet>
