<script>
  // 总览：统计瓦片 + 服务进程（含公网访问一行）+ 用量额度环 + 活跃 agent。
  import { sa, liveGens, fmtUptime, fmtDur, saToast } from '../../lib/serverAdmin.svelte.js';
  import SaGensList from './SaGensList.svelte';
  import { t, tc, tr } from '../../lib/i18n.js';

  const ov = $derived(sa.overview);
  const svc = $derived(ov?.service || {});
  const tunnel = $derived(svc.tunnel || {});
  const server = $derived(svc.server || {});
  const auto = $derived(svc.autostart || {});
  const gens = $derived(sa.gens.length ? sa.gens : (ov?.gens || []));
  const liveN = $derived(liveGens(gens).length);
  const svcUnavailable = $derived(!!svc.unavailable);
  // admin.ps1 出错（查不到）：不能当成「全停了」显示「已停止」，徽标写「状态未知」
  const svcErr = $derived(!!svc.error);
  // 公网访问摘要：完整状态（控制台打开时拉过）优先，没有就用 overview 里带的
  const pub = $derived(sa.publicAccess || ov?.publicAccess || null);
  const PUB = { running: ['green', t('已连通')], starting: ['amber', t('启动中')], error: ['red', t('有问题')], stopped: ['gray', t('未开启')] };
  // 隧道归外部托管（本机脚本 / 系统服务）而这里是 off：徽标中性，别写「未开启」——机器其实正经那条隧道对外服务（说明在 hint 里）
  const pubBadge = $derived(pub?.managedBy && pub?.mode === 'off' ? ['blue', t('外部托管')] : (PUB[pub?.status] || PUB.stopped));

  const ringPct = (o) => (o && o.pct != null ? Math.round(o.pct) : 0);
  // Claude 限额状态 → 人话（未知值原样透传）
  const STATUS_TX = { allowed: t('额度正常'), allowed_warning: t('接近上限'), rejected: t('已达上限') };
  const ringStatus = (o) => (o ? (STATUS_TX[o.status] || o.status || '') : t('无数据'));
  function copyTunnel() {
    if (!tunnel.url) return;
    navigator.clipboard?.writeText(tunnel.url).then(() => saToast(t('隧道地址已复制'))).catch(() => {});
  }
</script>

{#snippet badge(o)}
  {#if svcErr}<span class="sa-badge gray" title={svc.error}>{t('状态未知')}</span>
  {:else if o && o.running}<span class="sa-badge green"><span class="sa-live"></span>{t('运行中')}</span>
  {:else}<span class="sa-badge red">{t('已停止')}</span>{/if}
{/snippet}

{#if !ov}
  <div class="sa-empty">{t('正在连接本机服务…')}</div>
{:else}
  <div class="tiles">
    <div class="sa-card sa-stat">
      <div class="k">{t('活跃 Agent')}</div>
      <div class="v">{liveN}</div>
      <div class="x">{t('{n} 个会话槽', { n: gens.length })}</div>
    </div>
    <div class="sa-card sa-stat">
      <div class="k">{tc('admin', '用户')}</div>
      <div class="v">{ov.userCount || 0}</div>
      <div class="x">{t('含 admin 自己')}</div>
    </div>
    <div class="sa-card sa-stat">
      <div class="k">{t('定时任务运行中')}</div>
      <div class="v">{(ov.routinesRunning || []).length}</div>
      <div class="x">{t('调度器 30s tick')}</div>
    </div>
  </div>

  <div class="two">
    <div class="sa-card">
      <div class="sa-card-h">{t('服务进程')}</div>
      {#if svcUnavailable}
        <div class="sa-rows">
          <div class="sa-row">
            <span class="sa-row-tx">{t('桌面壳托管')}<small>{t('本机 bridge 由桌面应用守护运行，进程细节见「服务控制」页')}</small></span>
            <span class="sa-badge green"><span class="sa-live"></span>{t('本页可达即在跑')}</span>
          </div>
        </div>
        <div style="height:10px"></div>
      {:else}
        <div class="sa-rows">
          <div class="sa-row">
            <span class="sa-row-tx">{t('主服务')}</span>
            {@render badge(server)}
            <span class="sa-mono sa-dim pid">PID {server.pid || '—'}</span>
            <span class="sa-mono sa-dim">{fmtUptime(server.uptimeSec)}</span>
          </div>
          <div class="sa-row">
            <span class="sa-row-tx">{t('Cloudflare 隧道')}</span>
            {@render badge(tunnel)}
            <span class="sa-mono sa-dim pid">PID {tunnel.pid || '—'}</span>
            <span class="sa-mono sa-dim">{fmtUptime(tunnel.uptimeSec)}</span>
          </div>
          <div class="sa-row">
            <span class="sa-row-tx">{t('开机自启')}</span>
            {#if svcErr}<span class="sa-badge gray">{t('状态未知')}</span>
            {:else}
              {#if auto.server && auto.tunnel}<span class="sa-badge green">{t('已装')}</span>{:else}<span class="sa-badge gray">{t('未装')}</span>{/if}
              <span class="sa-dim pid" style="font-size:12px">server:{auto.server ? '✓' : '✗'} tunnel:{auto.tunnel ? '✓' : '✗'}</span>
            {/if}
          </div>
          {#if svcErr}
            <div class="sa-row"><span class="sa-row-tx"><small title={svc.stderr || svc.error}>{t('查不到进程状态（admin.ps1 出错），稍后自动重试。')}</small></span></div>
          {/if}
          {#if tunnel.url}
            <div class="sa-row">
              <span class="sa-row-tx">{t('隧道地址')}<small class="sa-mono">{tunnel.url}</small></span>
              <button class="sa-btn sm" onclick={copyTunnel}>{t('复制')}</button>
            </div>
          {/if}
        </div>
        <div style="height:10px"></div>
      {/if}
      {#if pub && pub.available !== false}
        <div class="sa-rows pubrow">
          <div class="sa-row">
            <span class="sa-row-tx">{t('公网访问')}<small class:sa-mono={!!pub.url} class="sa-trunc">{pub.url || tr(pub.hint)}</small></span>
            <span class="sa-badge {pubBadge[0]}">{#if pub.status === 'running'}<span class="sa-live"></span>{/if}{pubBadge[1]}</span>
            {#if !pub.managedBy?.locked}<button class="sa-btn sm" onclick={() => { sa.page = 'control'; }}>{t('设置')}</button>{/if}
          </div>
        </div>
        <div style="height:10px"></div>
      {/if}
    </div>

    <div class="sa-card">
      <div class="sa-card-h">{t('用量额度')}</div>
      <div class="rings">
        <div class="ring-row">
          <div class="sa-ring" style="--p:{ringPct(sa.limits?.five_hour)};--rc:var(--sa-accent)" data-l={sa.limits?.five_hour?.pct != null ? ringPct(sa.limits.five_hour) + '%' : '—'}></div>
          <div>
            <div class="rl">{t('5 小时窗口')}</div>
            <div class="sa-dim" style="font-size:12px">{ringStatus(sa.limits?.five_hour)}</div>
          </div>
        </div>
        <div class="ring-row">
          <div class="sa-ring" style="--p:{ringPct(sa.limits?.seven_day)};--rc:var(--sa-accent)" data-l={sa.limits?.seven_day?.pct != null ? ringPct(sa.limits.seven_day) + '%' : '—'}></div>
          <div>
            <div class="rl">{t('7 天窗口')}</div>
            <div class="sa-dim" style="font-size:12px">{ringStatus(sa.limits?.seven_day)}</div>
          </div>
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
  .two { display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; }
  .rings { display: flex; flex-direction: column; gap: 16px; padding: 14px 18px 18px; }
  .ring-row { display: flex; align-items: center; gap: 16px; }
  .pubrow { border-top: 1px solid var(--sa-sep); }
  .rl { font-size: 14.5px; font-weight: 600; }
  @media (max-width: 1080px) { .two { grid-template-columns: 1fr; } }
  /* 手机：三块瓦片仍并排（数字短），缩内距；进程行藏 PID / 自启明细，免得把状态挤没 */
  @media (max-width: 699px) {
    .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .tiles .sa-stat { padding: 12px 13px; }
    .tiles :global(.sa-stat .v) { font-size: 24px; }
    .tiles :global(.sa-stat .k) { margin-bottom: 6px; line-height: 1.35; }
    .pid { display: none; }
  }
</style>
