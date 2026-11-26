<script>
  // 窄栏「产物」：Codex 在最近的线程里交出来的图、文件和网页（助手消息上的附件），按线程分组。
  // 翻最近 20 条线程的记录（GET /api/codex/session，限 4 个并发）；同一条线程没改过（mtime 没变）就用这次页面生命周期里拉过的。
  // 图片直接给缩略（codexArtifactUrl 带鉴权参数），点开走 bridge 的统一预览；组标题点开那条线程。
  import { onMount, untrack } from 'svelte';
  import { t, tr } from '../../../lib/i18n.js';
  import { codexArtifactUrl, kindOf, openPreview } from '../../../lib/preview.svelte.js';
  import { codexApi } from '../../../lib/codex/api.js';
  import { codex, openThread } from '../../../lib/codex/store.svelte.js';
  import { anim, EASE, reduced } from '../../../lib/codex/motion.js';
  import { collectArtifacts, pool } from '../../../lib/codex/chrome/logic.js';
  import Icon from '../Icon.svelte';

  const RECENT = 20;
  let st = $state({ loading: true, failed: 0, groups: [] });
  let broken = $state(new Set());
  let inEl = $state(null);

  const recent = $derived([...codex.sessions].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, RECENT));

  function kindInfo(it) {
    const k = it.kind && it.kind !== 'other' ? it.kind : kindOf(it.name);
    const ext = String(it.name).split('.').pop().toLowerCase();
    if (k === 'image') return { k, icon: 'image', label: t('图片') };
    if (k === 'video') return { k, icon: 'play', label: t('视频') };
    if (k === 'audio') return { k, icon: 'wave', label: t('音频') };
    if (ext === 'html' || ext === 'htm') return { k, icon: 'globe', label: t('网页') };
    return { k, icon: 'file', label: t('文件') };
  }

  function preview(g, index, e) {
    const r = e.currentTarget.getBoundingClientRect();
    const items = g.items.map((it) => ({ origin: 'codex', id: g.id, path: it.path, name: it.name, kind: kindInfo(it).k }));
    items[index].originRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    openPreview(items, index);
  }

  function goThread(id) {
    codex.view = 'threads';
    openThread(id);
  }

  async function load() {
    st.loading = true;
    const list = recent;
    let failed = 0;
    const got = await pool(list, 4, async (s) => {
      const hit = cache.get(s.id);
      if (hit && hit.mtime === s.mtime) return hit.data;
      try {
        const d = await codexApi.session(s.id);
        const data = { id: s.id, title: tr(s.title || ''), mtime: s.mtime, messages: d?.messages || [] };
        cache.set(s.id, { mtime: s.mtime, data });
        return data;
      } catch { failed++; return null; }
    });
    st.groups = collectArtifacts(got.filter(Boolean));
    st.failed = failed;
    st.loading = false;
  }

  // 列表还没到（刚进页）就等它到了再翻
  $effect(() => { if (codex.booted) untrack(load); });

  onMount(() => {
    if (!reduced() && inEl) [...inEl.children].forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { dur: 380, delay: i * 40, ease: EASE.out }));
  });
</script>

<script module>
  // 线程 id → { mtime, data }：这次页面生命周期里拉过的线程记录（进出这一页不重拉）
  const cache = new Map();
</script>

<div class="pg-in" bind:this={inEl}>
  <div class="pg-hd">
    <div class="t">
      <h2>{t('产物')}</h2>
      <p>{t('Codex 在最近 {n} 条线程里交出来的图、文件和网页。', { n: RECENT })}</p>
    </div>
    {#if !st.loading}<button class="tbtn" onclick={load}>{t('刷新')}</button>{/if}
  </div>

  {#if st.loading && !st.groups.length}
    <p class="pg-note">{t('正在翻最近的线程…')}</p>
  {:else if !st.groups.length}
    <div class="pg-list sq"><div class="pg-row"><span class="ic sq"><Icon name="image" /></span><span class="tx"><b>{t('还没有产物')}</b><span>{t('Codex 在线程里生成的图片、写出的文件会收在这里')}</span></span></div></div>
  {:else}
    {#each st.groups as g (g.id)}
      <div class="lib-grp">
        <button class="pg-cap lib-cap" title={t('打开这条线程')} onclick={() => goThread(g.id)}>{g.title || t('新线程')}</button>
        <div class="pg-grid">
          {#each g.items as it, i (it.path)}
            {@const k = kindInfo(it)}
            <button class="pg-tile sq" onclick={(e) => preview(g, i, e)}>
              <span class="th">
                {#if k.k === 'image' && !broken.has(g.id + it.path)}
                  <img src={codexArtifactUrl(g.id, it.path, { name: it.name })} alt={it.name} loading="lazy" decoding="async"
                    onerror={() => { broken = new Set([...broken, g.id + it.path]); }} />
                {:else}
                  <Icon name={k.icon} />
                {/if}
              </span>
              <span class="m"><b>{it.name}</b><span>{k.label}</span></span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
  {#if st.failed}<p class="pg-note">{t('有 {n} 条线程的记录没读出来，点「刷新」再试一次。', { n: st.failed })}</p>{/if}
</div>

<style>
  .pg-note { margin: 14px 4px 0; color: var(--fg3); font-size: 12.5px; line-height: 1.55; }
  .lib-grp + .lib-grp { margin-top: 6px; }
  .lib-cap { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 6px; transition: color var(--d-2); }
  .lib-cap:hover { color: var(--fg); }
  .pg-tile .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pg-tile { min-width: 0; }
</style>
