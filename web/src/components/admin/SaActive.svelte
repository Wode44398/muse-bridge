<script>
  // 活跃进程：可中止的 Claude 生成列表 + 运行中的定时任务。
  import { sa } from '../../lib/serverAdmin.svelte.js';
  import SaGensList from './SaGensList.svelte';
  import { t } from '../../lib/i18n.js';
</script>

<div class="sa-card">
  <div class="sa-card-h">{t('Claude 对话生成')} <span class="sa-dim" style="font-weight:400;font-size:12px;text-transform:none">· {t('每 3.5s 刷新')}</span></div>
  <SaGensList gens={sa.gens} withStop={true} />
  <div style="height:8px"></div>
</div>

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

<div class="sa-foot" style="margin-top:12px">{t('中止 = 调用该用户活跃生成的 abort（等价于该用户自己点「停止」）。')}</div>
