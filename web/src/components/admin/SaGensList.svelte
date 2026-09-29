<script>
  // 活跃生成列表（总览/活跃进程共用）。withStop 时带「中止」按钮。
  import { api } from '../../lib/api.js';
  import { liveGens, fmtDur, saToast, loadActive } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let { gens = [], withStop = false } = $props();
  const live = $derived(liveGens(gens));

  async function stopGen(g) {
    try {
      const r = await api.post('/api/admin/stop', { key: g.key, sessionId: g.sessionId || undefined });
      saToast(r.ok ? t('已中止 {key}', { key: g.key }) : (tr(r.error) || t('中止失败')), !r.ok);
    } catch (e) { saToast(t('中止失败：{reason}', { reason: tr(e?.message || e) }), true); }
    setTimeout(loadActive, 350);
  }
</script>

{#if !live.length}
  <div class="sa-empty">{t('当前没有正在运行的 Agent 对话')}</div>
{:else}
  <div class="glist">
    {#each live as g (g.key + (g.sessionId || ''))}
      <div class="grow">
        {#if g.key === 'admin'}<span class="sa-badge blue">admin</span>
        {:else}<span class="sa-badge purple">{(g.key || '').replace(/^u:/, '')}</span>{/if}
        <span class="sa-mono sa-dim sid">{(g.sessionId || '').slice(0, 8) || '—'}</span>
        <span class="sa-trunc req" title={g.userText || ''}>{g.userText || '—'}</span>
        <span class="sa-mono elapsed"><span class="sa-live"></span>{fmtDur(g.elapsedMs)}</span>
        <span class="sa-mono sa-dim subs" title={t('订阅连接数')}>{g.subscribers}</span>
        {#if withStop}
          <button class="sa-btn sm dgr" onclick={() => stopGen(g)}>{t('中止')}</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .glist { padding: 4px 18px 8px; display: flex; flex-direction: column; }
  .grow { display: flex; align-items: center; gap: 12px; padding: 10px 0; position: relative; font-size: 13.5px; }
  .grow + .grow::before { content: ''; position: absolute; top: 0; left: 0; right: -18px; height: .5px; background: rgba(255,255,255,.08); }
  .sid { width: 72px; flex: none; }
  .req { flex: 1; min-width: 0; color: rgba(255,255,255,.85); }
  .elapsed { flex: none; display: inline-flex; align-items: center; gap: 7px; }
  .subs { width: 22px; text-align: right; flex: none; }
</style>
