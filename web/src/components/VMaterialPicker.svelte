<script>
  // 工作空间素材选择器：浏览云端工作空间挑一张图片当生成素材。文件夹可进入；
  // 图片用 ?thumb 缩略图网格；选中回 onPick(rel, name)。Gemini 设计语言（g-* 变量自适应明暗）。
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { cloudFileUrl } from '../lib/preview.svelte.js';
  import { t } from '../lib/i18n.js';

  let { onPick, onClose } = $props();

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
  function enter(name) { load(relOf(name)); }
  function goSeg(i) { load(segs.slice(0, i + 1).join('/')); }
  function pick(name) { onPick(relOf(name), name); }
  onMount(() => load(''));
</script>

<div class="mp-mask" onclick={onClose} role="presentation">
  <div class="mp-sheet" onclick={(e) => e.stopPropagation()} role="presentation">
    <div class="mp-grab"></div>
    <div class="mp-head">
      <span class="mp-title">{t('选择素材图片')}</span>
      <button class="mp-x" aria-label={t('关闭')} onclick={onClose}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="mp-crumb">
      <button class="mp-seg" class:cur={!segs.length} onclick={() => load('')}>{t('工作空间')}</button>
      {#each segs as s, i}<span class="mp-sep">›</span>{#if i < segs.length - 1}<button class="mp-seg" onclick={() => goSeg(i)}>{s}</button>{:else}<span class="mp-seg cur">{s}</span>{/if}{/each}
    </div>
    <div class="mp-body">
      {#if loading}
        <div class="mp-center"><span class="mp-spin"></span></div>
      {:else}
        {#if folders.length}
          <div class="mp-folders">
            {#each folders as f (f.name)}
              <button class="mp-folder" onclick={() => enter(f.name)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>
                <span class="mp-fname">{f.name}</span>
                <svg class="mp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
              </button>
            {/each}
          </div>
        {/if}
        {#if images.length}
          <div class="mp-grid">
            {#each images as im (im.name)}
              <button class="mp-img" onclick={() => pick(im.name)} aria-label={im.name}>
                <img src={cloudFileUrl(relOf(im.name), { thumb: true })} alt="" loading="lazy" onerror={(e) => (e.currentTarget.style.opacity = '0')} />
              </button>
            {/each}
          </div>
        {/if}
        {#if !folders.length && !images.length}<div class="mp-empty">{t('这个文件夹里没有图片')}</div>{/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .mp-mask { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.4); display: flex; align-items: flex-end; justify-content: center; animation: mpfade .2s; }
  @keyframes mpfade { from { opacity: 0; } to { opacity: 1; } }
  .mp-sheet { width: 100%; max-width: 600px; height: 78vh; background: var(--g-bright); border-radius: 22px 22px 0 0; display: flex; flex-direction: column; box-shadow: 0 -10px 40px rgba(0,0,0,.25); animation: mpup .28s cubic-bezier(.22,1,.36,1); overflow: hidden; }
  @keyframes mpup { from { transform: translateY(100%); } to { transform: none; } }
  .mp-grab { width: 36px; height: 4px; border-radius: 2px; background: var(--g-outline-low); margin: 8px auto 2px; flex: none; }
  .mp-head { flex: none; display: flex; align-items: center; padding: 6px 12px 6px 18px; }
  .mp-title { flex: 1; font-size: 17px; font-weight: 600; color: var(--g-on); }
  .mp-x { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--g-on); flex: none; }
  .mp-x svg { width: 20px; height: 20px; }
  .mp-x:active { background: var(--g-hover); }
  .mp-crumb { flex: none; display: flex; align-items: center; gap: 3px; padding: 2px 16px 10px; overflow-x: auto; white-space: nowrap; }
  .mp-seg { font-size: 14px; color: var(--g-primary); flex: none; }
  .mp-seg.cur { color: var(--g-on); font-weight: 600; }
  .mp-sep { color: var(--g-on-low); flex: none; }
  .mp-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 14px max(14px, var(--sab)); }
  .mp-center { display: flex; align-items: center; justify-content: center; padding: 48px; }
  .mp-spin { width: 30px; height: 30px; border-radius: 50%; border: 3px solid var(--g-outline-low); border-top-color: var(--g-primary); animation: mpspin .8s linear infinite; }
  @keyframes mpspin { to { transform: rotate(360deg); } }
  .mp-folders { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
  .mp-folder { width: 100%; display: flex; align-items: center; gap: 13px; padding: 11px 8px; border-radius: 12px; color: var(--g-on); text-align: left; }
  .mp-folder:active { background: var(--g-hover); }
  .mp-folder > svg:first-child { width: 26px; height: 26px; color: var(--g-primary); flex: none; }
  .mp-fname { flex: 1; min-width: 0; font-size: 16px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .mp-chev { width: 18px; height: 18px; color: var(--g-on-low); flex: none; }
  .mp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 8px 0 12px; }
  .mp-img { aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: var(--g-dim); }
  .mp-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mp-img:active { filter: brightness(.92); }
  .mp-empty { text-align: center; color: var(--g-on-low); font-size: 14px; padding: 44px 0; }
</style>
