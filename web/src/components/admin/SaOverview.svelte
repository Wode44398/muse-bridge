<script>
  // 总览：统计瓦片 + 用量额度环 + 活跃 agent。
  import { sa, liveGens } from '../../lib/serverAdmin.svelte.js';
  import SaGensList from './SaGensList.svelte';
  import { t, tc } from '../../lib/i18n.js';

  const ov = $derived(sa.overview);
  const gens = $derived(sa.gens.length ? sa.gens : (ov?.gens || []));
  const liveN = $derived(liveGens(gens).length);

  const ringPct = (o) => (o && o.pct != null ? Math.round(o.pct) : 0);
  // Claude 限额状态 → 人话（未知值原样透传）
  const STATUS_TX = { allowed: t('额度正常'), allowed_warning: t('接近上限'), rejected: t('已达上限') };
  const ringStatus = (o) => (o ? (STATUS_TX[o.status] || o.status || '') : t('无数据'));
</script>

{#if !ov}
  <div class="sa-empty">{t('正在连接服务…')}</div>
{:else}
  <div class="tiles">
    <div class="sa-card sa-stat">
      <div class="k">{t('活跃 Agent')}</div>
      <div class="v" style:color={liveN ? 'var(--sa-green)' : '#fff'}>{liveN}</div>
      <div class="x">{t('{n} 个会话槽', { n: gens.length })}</div>
    </div>
    <div class="sa-card sa-stat">
      <div class="k">{tc('admin', '用户')}</div>
      <div class="v">{ov.userCount || 0}</div>
      <div class="x">{t('含 admin 自己')}</div>
    </div>
    <div class="sa-card sa-stat">
      <div class="k">{t('定时任务运行中')}</div>
      <div class="v" style:color={(ov.routinesRunning || []).length ? 'var(--sa-amber)' : '#fff'}>{(ov.routinesRunning || []).length}</div>
      <div class="x">{t('调度器 30s tick')}</div>
    </div>
  </div>

  <div class="sa-card">
    <div class="sa-card-h">{t('用量额度')}</div>
    <div class="rings">
      <div class="ring-row">
        <div class="sa-ring" style="--p:{ringPct(sa.limits?.five_hour)};--rc:var(--sa-blue)" data-l={sa.limits?.five_hour?.pct != null ? ringPct(sa.limits.five_hour) + '%' : '—'}></div>
        <div>
          <div style="font-weight:650">{t('5 小时窗口')}</div>
          <div class="sa-dim" style="font-size:12px">{ringStatus(sa.limits?.five_hour)}</div>
        </div>
      </div>
      <div class="ring-row">
        <div class="sa-ring" style="--p:{ringPct(sa.limits?.seven_day)};--rc:var(--sa-purple)" data-l={sa.limits?.seven_day?.pct != null ? ringPct(sa.limits.seven_day) + '%' : '—'}></div>
        <div>
          <div style="font-weight:650">{t('7 天窗口')}</div>
          <div class="sa-dim" style="font-size:12px">{ringStatus(sa.limits?.seven_day)}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="sa-card" style="margin-top:14px">
    <div class="sa-card-h">{t('活跃 Agent')} <span class="sa-dim" style="font-weight:400;font-size:12px">{t('· 去「活跃进程」页可中止')}</span></div>
    <SaGensList {gens} withStop={false} />
    <div style="height:8px"></div>
  </div>
{/if}

<style>
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
  .rings { display: flex; flex-wrap: wrap; gap: 16px 40px; padding: 14px 18px 18px; }
  .ring-row { display: flex; align-items: center; gap: 16px; }
  @media (max-width: 1080px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
</style>
