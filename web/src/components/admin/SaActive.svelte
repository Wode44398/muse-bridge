<script>
  // 活跃进程：可中止的生成列表 + Antigravity 常驻守护控制 + 运行中的定时任务。
  import { api } from '../../lib/api.js';
  import { sa, loadActive, loadOverview, fmtUptime, saToast } from '../../lib/serverAdmin.svelte.js';
  import SaGensList from './SaGensList.svelte';
  import { t, tr } from '../../lib/i18n.js';

  const agy = $derived(sa.agy || sa.overview?.agy || null);
  let killingAgy = $state(false);

  async function forceKillAgy() {
    if (killingAgy) return;
    killingAgy = true;
    try {
      const r = await api.post('/api/admin/agy/kill', {});
      if (r?.agy) sa.agy = r.agy;
      saToast(r?.ok ? t('已强制终止 Antigravity 常驻进程') : (tr(r?.error) || t('终止失败')), !r?.ok);
    } catch (e) {
      saToast(t('终止失败：{reason}', { reason: tr(e?.message || e) }), true);
    } finally {
      killingAgy = false;
      setTimeout(() => { loadActive(); loadOverview(); }, 300);
    }
  }
</script>

<div class="sa-card">
  <div class="sa-card-h">{t('Agent 对话生成')} <span class="sa-dim" style="font-weight:400;font-size:12px;text-transform:none">· {t('每 3.5s 刷新')}</span></div>
  <SaGensList gens={sa.gens} withStop={true} />
  <div style="height:8px"></div>
</div>

{#if agy}
  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h">Antigravity ACP</div>
    <div class="sa-rows" style="padding-bottom:8px">
      <div class="sa-row">
        <span class="sa-row-tx">
          {t('常驻守护进程')}
          <small>
            {#if agy.running}
              PID {agy.pid || '—'} · {fmtUptime(agy.uptimeSec)} · {t('{live} 轮在跑 / {mounted} 个挂载会话', { live: agy.activeTurns || 0, mounted: agy.mountedSessions || 0 })}
            {:else if agy.stoppedAfterCrashes}
              {t('连续异常退出已停止，可在 Antigravity 分页或设置中手动重启')}
            {:else if !agy.installed}
              {t('当前机器未安装 agy CLI')}
            {:else}
              {t('当前空闲未驻留，下次发起 Antigravity 对话时自动拉起')}
            {/if}
          </small>
        </span>
        {#if agy.running}
          <span class="sa-badge green"><span class="sa-live"></span>{t('运行中')}</span>
          <button class="sa-btn sm dgr" disabled={killingAgy} onclick={forceKillAgy}>
            {killingAgy ? t('终止中…') : t('强制杀进程')}
          </button>
        {:else if agy.stoppedAfterCrashes}
          <span class="sa-badge red">{t('已停止')}</span>
        {:else}
          <span class="sa-badge gray">{t('空闲')}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<div class="sa-card" style="margin-top:12px">
  <div class="sa-card-h">{t('定时任务运行中')}</div>
  <div class="sa-rows" style="padding-bottom:12px">
    {#if (sa.overview?.routinesRunning || []).length}
      {#each sa.overview.routinesRunning as id (id)}
        <div class="sa-row" style="min-height:38px">
          <span class="sa-live"></span>
          <span class="sa-mono sa-mut">{id.slice(0, 8)}…</span>
        </div>
      {/each}
    {:else}
      <div class="sa-row" style="min-height:38px"><span class="sa-dim">{t('无')}</span></div>
    {/if}
  </div>
</div>

<div class="sa-foot" style="margin-top:12px">{t('中止 = 调用该用户活跃生成的 abort（等价于该用户自己点「停止」）。长跑媒体（Veo/Lyria）按秒计费、故意跑完不中断，不在此列。')}</div>
