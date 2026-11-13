<script>
  // Studio 作品栏（v3，方案 §9.2「作品栏」）：顶部「作品｜文件」小分段 + 搜索钮，下面是作品流（跨种类 + 血缘「点 + 竖线」）
  // 或工作空间（起点 saveDir）。两个标签首次打开后都常驻、只用 hidden 切换——滚动位置、展开的文件夹、选中项都留着；
  // 外壳切创作页也不碰这棵子树（同一批 DOM 节点）。
  import { t, tc } from '../../lib/i18n.js';
  import { api } from '../../lib/api.js';
  import { studio, saveSide, loadAssets } from '../../modules/studio/media.svelte.js';
  import { icon } from '../../modules/studio/icons.js';
  import Segmented from './ui/Segmented.svelte';
  import WorksStream from './WorksStream.svelte';
  import WorkspaceEmbed from '../dock/WorkspaceEmbed.svelte';

  let { visible = true } = $props();

  // 「文件」首次打开才挂；起点是 saveDir——还没生成过东西时那个目录可能不存在，先探一下，不在就从根开始
  let filesMounted = $state(false);
  let startDir = $state('');
  async function mountFiles() {
    if (filesMounted) return;
    const dir = studio.saveDir || '';
    let ok = false;
    if (dir) { try { await api.files(dir); ok = true; } catch {} }
    startDir = ok ? dir : '';
    filesMounted = true;
  }
  function pick(tab) {
    if (studio.side.tab === tab) return;
    studio.side.tab = tab;
    saveSide();
  }
  $effect(() => { if (studio.side.tab === 'files' && visible) mountFiles(); });
  const target = $derived(studio.filesTarget);
  const TABS = [{ value: 'works', label: t('作品') }, { value: 'files', label: tc('侧栏', '文件') }];

  // 作品筛选：换了就重拉（服务端按 kind / q 过滤，分页游标从头来）。种类只用文字区分，不着色。
  const FILTERS = [
    { id: 'all', label: t('全部') }, { id: 'image', label: t('图像') }, { id: 'video', label: t('视频') },
    { id: 'audio', label: t('配音') }, { id: 'music', label: t('音乐') },
  ];
  function setFilter(id) { if (studio.filter === id) return; studio.filter = id; loadAssets(true); }
  let searching = $state(false), qEl = $state();
  let qT = 0;
  function onQ() { clearTimeout(qT); qT = setTimeout(() => loadAssets(true), 260); }
  function openSearch() { searching = true; requestAnimationFrame(() => qEl?.focus()); }
  function closeSearch() { searching = false; if (studio.q) { studio.q = ''; loadAssets(true); } }
</script>

<div class="sb">
  <div class="sb-top">
    <Segmented options={TABS} value={studio.side.tab} onchange={pick} size="sm" label={t('作品栏')} />
    <span class="sb-gap"></span>
    {#if studio.side.tab === 'works' && !searching}
      <button class="sd-ib sb-qbtn" aria-label={t('搜索作品')} onclick={openSearch}>{@html icon('search')}</button>
    {/if}
  </div>

  <div class="sb-pane" hidden={studio.side.tab !== 'works'}>
    <div class="sb-filter">
      {#if searching}
        <label class="sb-q">
          {@html icon('search')}
          <input bind:this={qEl} bind:value={studio.q} oninput={onQ} placeholder={t('搜提示词')} onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } }} />
          <button class="sd-ib sb-q-x" aria-label={t('关闭搜索')} onclick={closeSearch}>{@html icon('close')}</button>
        </label>
      {:else}
        <div class="sb-chips" role="radiogroup" aria-label={t('按种类筛选')} data-hscroll>
          {#each FILTERS as f (f.id)}
            <button class="chip sb-chip" role="radio" aria-checked={studio.filter === f.id} onclick={() => setFilter(f.id)}>{f.label}</button>
          {/each}
        </div>
      {/if}
    </div>
    <WorksStream />
  </div>

  {#if filesMounted}
    <div class="sb-pane sb-files" hidden={studio.side.tab !== 'files'}>
      <div class="sd-embed">
        {#key target?.seq || 0}
          <WorkspaceEmbed wide ws="" initialPath={target ? target.dir : startDir} initialOpen={target?.open || ''} previewHost="app" onExit={() => pick('works')} />
        {/key}
      </div>
    </div>
  {/if}
</div>
