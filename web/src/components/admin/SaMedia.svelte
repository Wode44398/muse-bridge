<script>
  // 媒体库：按用户 × 类型（图片/视频/语音/音乐）浏览生成媒体。
  // admin 走 /api/vertex/*；其他用户走 /api/admin/user/media(-file)。
  // 点任一张 / 一条 = 统一查看器，在当前列表里左右翻（视频打开即播、音频有波形与时长、都能下载）。
  import { api } from '../../lib/api.js';
  import { openPreview, vertexFileName } from '../../lib/preview.svelte.js';
  import { viewerSvg } from '../../lib/viewerIcons.js';
  import { sa, userMediaUrl } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  // [类型, 分段标签, 空态里的名词]
  const KINDS = [['image', t('图片'), t('图片类媒体')], ['video', t('视频'), t('视频类媒体')], ['audio', t('语音'), t('语音类媒体')], ['music', t('音乐'), t('音乐类媒体')]];
  let user = $state('admin');
  let kind = $state('image');
  let list = $state([]);
  let loading = $state(true);
  let denied = $state('');            // 成员没允许管理员看内容（S2-7）：服务端回 403 + 原因
  const userList = $derived([{ name: 'admin' }, ...sa.users]);
  const kindIdx = $derived(Math.max(0, KINDS.findIndex(([k]) => k === kind)));

  $effect(() => { sa.tick; user; kind; load(); });
  async function load() {
    loading = true; denied = '';
    try {
      const d = user === 'admin'
        ? await api.get('/api/vertex/' + kind + 's')
        : await api.get('/api/admin/user/media?name=' + encodeURIComponent(user) + '&kind=' + kind);
      list = d?.media || [];
    } catch (e) { list = []; if (e?.body?.code === 'consent') denied = tr(e.body.error); }
    loading = false;
  }
  const murl = (id) => userMediaUrl(user, id);

  const NO_PROMPT = '(无提示词)';   // i18n-ignore 服务端列表对没有提示词的记录给的占位（比对用，不显示）
  const viewKind = (k) => (k === 'image' ? 'image' : k === 'video' ? 'video' : 'audio');
  function descOf(m) {
    const k = viewKind(m.kind || kind);
    const prompt = m.title && m.title !== NO_PROMPT ? tr(m.title) : '';
    // 自己的媒体走媒体库通道（有 1280 衍生图、缓存键）；别的用户的只能经管理员通道取原件
    if (user === 'admin') return { origin: 'vertex', id: m.id, kind: k, prompt, ext: m.ext || '' };
    return { origin: 'url', key: 'sa:' + user + ':' + m.id, url: murl(m.id), kind: k, prompt, name: vertexFileName({ prompt, ext: m.ext, kind: k }) };
  }
  function openAt(i, el) {
    const r = el?.getBoundingClientRect?.();
    const items = list.map((m, j) => {
      const d = descOf(m);
      return j === i && r && r.width ? { ...d, originRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } } : d;
    });
    openPreview(items, i);
  }
  const ICON_PLAY = viewerSvg('play');
</script>

<div class="sa-chips" style="margin-bottom:10px">
  {#each userList as u (u.name)}
    <button class="sa-chip-btn" class:on={u.name === user} onclick={() => { user = u.name; }}>{u.name === 'admin' ? t('admin（我）') : u.name}</button>
  {/each}
</div>

<div class="sa-seg" style="--n:4;margin-bottom:14px">
  <div class="sa-seg-knob" style:transform="translateX({kindIdx * 100}%)"></div>
  {#each KINDS as [k, label] (k)}
    <button class="sa-seg-btn" class:on={kind === k} onclick={() => { kind = k; }}>{label}</button>
  {/each}
</div>

{#if loading}
  <div class="sa-empty">{t('加载中…')}</div>
{:else if denied}
  <div class="sa-empty">{denied}</div>
{:else if !list.length}
  <div class="sa-empty">{user === 'admin' ? t('我 还没有{media}', { media: KINDS[kindIdx][2] }) : t('{user} 还没有{media}', { user, media: KINDS[kindIdx][2] })}</div>
{:else if kind === 'image'}
  <div class="sa-media-grid">
    {#each list as m, i (m.id)}
      <button type="button" class="sa-mtile" title={tr(m.title) || ''} onclick={(e) => openAt(i, e.currentTarget)}>
        <img src={murl(m.id)} alt={tr(m.title) || ''} loading="lazy" decoding="async" draggable="false" />
      </button>
    {/each}
  </div>
{:else if kind === 'video'}
  <div class="sa-media-grid">
    {#each list as m, i (m.id)}
      <!-- 网格里只当静态封面（第一帧，无控件、不在格子里播）；点开进查看器播 -->
      <button type="button" class="sa-mtile" title={tr(m.title) || ''} aria-label={tr(m.title) || t('视频')} onclick={(e) => openAt(i, e.currentTarget)}>
        <video src={murl(m.id) + '#t=0.1'} muted playsinline preload="metadata" disablepictureinpicture tabindex="-1"></video>
        <span class="sa-mplay" aria-hidden="true">{@html ICON_PLAY}</span>
      </button>
    {/each}
  </div>
{:else}
  <div class="alist">
    {#each list as m, i (m.id)}
      <button type="button" class="sa-card arow" title={tr(m.title) || ''} onclick={(e) => openAt(i, e.currentTarget)}>
        <span class="arow-play" aria-hidden="true">{@html ICON_PLAY}</span>
        <span class="sa-trunc arow-t">{tr(m.title) || m.id}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .alist { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .arow { padding: 10px 14px 10px 10px; display: flex; align-items: center; gap: 10px; min-height: 52px; border: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .arow-t { flex: 1; min-width: 0; font-size: 13px; }
  /* 媒体播放钮：暗底白标（与查看器、聊天里的播放条同一套） */
  .arow-play { flex: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #18181a; color: #fff; }
  .arow-play :global(svg) { width: 14px; height: 14px; margin-left: 1px; }
  .sa-mtile { position: relative; display: block; padding: 0; border: 0; background: none; cursor: pointer; border-radius: 14px; -webkit-tap-highlight-color: transparent; }
  .sa-mtile video { pointer-events: none; }
  .sa-mtile:focus-visible { outline: 2px solid var(--sa-ink, currentColor); outline-offset: 2px; }
  .sa-mplay { position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .45); color: #fff; pointer-events: none; }
  .sa-mplay :global(svg) { width: 18px; height: 18px; margin-left: 2px; }
</style>
