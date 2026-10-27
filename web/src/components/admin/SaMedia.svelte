<script>
  // 媒体库：按用户 × 类型（图片/视频/语音/音乐）浏览生成媒体。
  // admin 走 /api/vertex/*；其他用户走 /api/admin/user/media(-file)。
  import { api } from '../../lib/api.js';
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
    {#each list as m (m.id)}
      <img src={murl(m.id)} title={tr(m.title) || ''} alt={tr(m.title) || ''} loading="lazy" />
    {/each}
  </div>
{:else if kind === 'video'}
  <div class="sa-media-grid">
    {#each list as m (m.id)}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={murl(m.id) + '#t=0.1'} muted preload="metadata" onclick={(e) => { const v = e.currentTarget; if (v.paused) v.play(); else v.pause(); }}></video>
    {/each}
  </div>
{:else}
  <div class="alist">
    {#each list as m (m.id)}
      <div class="sa-card arow">
        <div class="sa-trunc sa-mut" style="font-size:12px" title={tr(m.title) || ''}>{tr(m.title) || m.id}</div>
        <audio src={murl(m.id)} controls></audio>
      </div>
    {/each}
  </div>
{/if}

<style>
  .alist { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .arow { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .arow audio { width: 100%; height: 36px; }
</style>
