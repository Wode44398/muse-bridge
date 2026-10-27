<script>
  // 服务控制：
  //  · admin.ps1 在位（附着主机/源码形态）→ 进程控制（主服务/隧道 启停重启）+ 开机自启；
  //  · 打包桌面服务端（无 admin.ps1）→ 运行时由桌面壳托管：显示壳状态 + 一键重启本机服务；
  //  · 设备（各账号的电脑）→ 独立的「设备」页（SaDevices）。
  // 主机信息（主机名/局域网/隧道地址）恒有；「公网访问」（服务端自带的隧道 / 自己的域名，SaPublicAccess）任何形态都有。
  // 远程管理（手机 / 网页 / 经隧道）进来时不摆会把自己关在门外的按钮（停服务、停隧道、开机自启）——服务端那头也会拒（R2）。
  import { api } from '../../lib/api.js';
  import { sa, loadOverview, saToast, saConfirm } from '../../lib/serverAdmin.svelte.js';
  import SaService from './SaService.svelte';
  import SaPublicAccess from './SaPublicAccess.svelte';
  import { t, tc, tr, isEn } from '../../lib/i18n.js';

  const svc = $derived(sa.overview?.service || {});
  const tunnel = $derived(svc.tunnel || {});
  const server = $derived(svc.server || {});
  const auto = $derived(svc.autostart || {});
  const hasScript = $derived(sa.scriptAvailable && !svc.unavailable);
  // admin.ps1 出错（查不到）：徽标写「状态未知」，不摆启动 / 停止 / 全部重启——以前会显示「已停止 + 启动」，而服务其实在跑
  const svcErr = $derived(!!svc.error);
  const remote = $derived(!!sa.remote);

  // —— 桌面壳桥（Electron 窗口内才有）——
  const dsk = typeof window !== 'undefined' ? window.BridgeDesktop : null;
  let rt = $state(null);            // { state, message, logFile }
  $effect(() => {
    if (!dsk?.runtime) return;
    dsk.runtime.state().then((s) => { if (s) rt = s; }).catch(() => {});
    const off = dsk.runtime.onState ? dsk.runtime.onState((s) => { if (s) rt = s; }) : null;
    return () => { try { off && off(); } catch {} };
  });

  // 第三项 = 英文确认钮：中文统一「执行」，英文按规范重复动词（Stop / Remove）
  const DANGER = {
    'stop-server': [t('停止主服务？'), t('手机/网页会立刻断连，可回本页「启动」重新拉起。'), t('停止')],
    'stop-tunnel': [t('停止隧道？'), t('外网将无法访问（同 WiFi 局域网仍可），可回本页「启动」重新拉起。'), t('停止')],
    'remove': [t('移除开机自启？'), t('之后重启电脑不会自动拉起 bridge 与隧道。'), t('移除')],
  };
  async function svcAction(action) {
    const d = DANGER[action];
    if (d && !(await saConfirm(d[0], d[1], { yes: isEn() ? d[2] : t('执行'), danger: true }))) return;
    saToast(t('执行 {action} …', { action }));
    try {
      const r = await api.post('/api/admin/action', { action });
      saToast(r?.error ? t('失败：{error}', { error: tr(r.error) }) : t('完成：{action}', { action }), !!r?.error);
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('执行失败'), true); }
    setTimeout(loadOverview, 1200); setTimeout(loadOverview, 3800);
  }

  async function restartShellRuntime() {
    if (!dsk?.runtime) return;
    if (!(await saConfirm(t('重启本机服务？'), t('桌面壳会重新拉起 bridge 运行时，进行中的对话会中断，几秒内自动恢复。'), { yes: t('重启') }))) return;
    saToast(t('正在重启本机服务…'));
    try { await dsk.runtime.restart(); } catch (e) { saToast(t('重启失败：{error}', { error: tr(e?.message || e) }), true); }
    setTimeout(loadOverview, 1500); setTimeout(loadOverview, 4500);
  }

  function copy(text, msg = t('已复制')) { navigator.clipboard?.writeText(text).then(() => saToast(msg)).catch(() => {}); }

  const rtBadge = $derived(rt?.state === 'ready' ? ['green', t('就绪')] : rt?.state === 'error' ? ['red', t('出错')] : rt?.state ? ['amber', rt.state] : ['gray', '—']);
</script>

{#snippet badge(o)}
  {#if svcErr}<span class="sa-badge gray" title={svc.error}>{t('状态未知')}</span>
  {:else if o && o.running}<span class="sa-badge green"><span class="sa-live"></span>{t('运行中')}</span>
  {:else}<span class="sa-badge red">{t('已停止')}</span>{/if}
{/snippet}

<!-- 运行状态 + 最近日志（任何形态都有）；这台机器另有重启手段（admin.ps1 / 桌面壳）时不在这里摆重启按钮 -->
<SaService otherRestart={hasScript || !!dsk?.runtime} />

<div style="margin-top:12px"><SaPublicAccess /></div>

<div class="grid2" style="margin-top:12px">
  {#if hasScript}
    <div class="sa-card">
      <div class="sa-card-h">{t('进程控制')}</div>
      <div class="sa-rows">
        <div class="sa-row">
          <span class="sa-row-tx">{t('主服务')}</span>
          {@render badge(server)}
          {#if svcErr}
          {:else if server.running}
            <button class="sa-btn sm" onclick={() => svcAction('restart-server')}>{t('重启')}</button>
            {#if !remote}<button class="sa-btn sm dgr" onclick={() => svcAction('stop-server')}>{t('停止')}</button>{/if}
          {:else}
            <button class="sa-btn sm pri" onclick={() => svcAction('start-server')}>{t('启动')}</button>
          {/if}
        </div>
        <div class="sa-row">
          <span class="sa-row-tx">{t('Cloudflare 隧道')}</span>
          {@render badge(tunnel)}
          {#if svcErr}
          {:else if tunnel.running}
            <button class="sa-btn sm" onclick={() => svcAction('restart-tunnel')}>{t('重启')}</button>
            {#if !remote}<button class="sa-btn sm dgr" onclick={() => svcAction('stop-tunnel')}>{t('停止')}</button>{/if}
          {:else}
            <button class="sa-btn sm pri" onclick={() => svcAction('start-tunnel')}>{t('启动')}</button>
          {/if}
        </div>
        <div class="sa-row">
          <span class="sa-row-tx">{t('两者')}</span>
          {#if !svcErr}<button class="sa-btn sm pri" onclick={() => svcAction('restart-both')}>{t('全部重启')}</button>{/if}
        </div>
      </div>
      <div class="sa-foot" style="padding-bottom:14px">{#if svcErr}<span title={svc.stderr || svc.error}>{t('查不到进程状态（admin.ps1 出错），稍后自动重试。')}</span> {/if}{t('重启服务只换 node 进程、不动隧道（地址不变）；重启隧道会换 trycloudflare 地址（固定域名不受影响）。')}{#if remote} {t('远程管理时不能停止服务或隧道（停了就连不回来了），要停请在这台电脑上操作。')}{/if}</div>
    </div>

    <div class="sa-card">
      <div class="sa-card-h">{t('开机自启')}</div>
      <div class="sa-rows">
        <div class="sa-row">
          <span class="sa-row-tx">{tc('admin', '计划任务')}</span>
          {#if !svcErr}<span class="sa-dim" style="font-size:12.5px">server:{auto.server ? '✓' : '✗'} · tunnel:{auto.tunnel ? '✓' : '✗'}</span>{/if}
          {#if svcErr}<span class="sa-badge gray">{t('状态未知')}</span>{:else if auto.server && auto.tunnel}<span class="sa-badge green">{t('已装')}</span>{:else}<span class="sa-badge gray">{t('未装')}</span>{/if}
        </div>
        {#if remote}
          <div class="sa-row">
            <span class="sa-row-tx"><small>{t('开机自启要在这台电脑上装或移除，远程管理时不能改。')}</small></span>
          </div>
        {:else}
          <div class="sa-row">
            <span class="sa-row-tx"></span>
            <button class="sa-btn sm" onclick={() => svcAction('install')}>{t('安装自启')}</button>
            <button class="sa-btn sm dgr" onclick={() => svcAction('remove')}>{t('移除自启')}</button>
          </div>
        {/if}
      </div>
      <div style="height:10px"></div>
    </div>
  {/if}

  {#if dsk?.runtime}
    <div class="sa-card">
      <div class="sa-card-h">{t('桌面壳运行时')}</div>
      <div class="sa-rows">
        <div class="sa-row">
          <span class="sa-row-tx">{t('本机 bridge 服务')}<small>{tr(rt?.message) || t('由桌面应用守护运行')}</small></span>
          <span class="sa-badge {rtBadge[0]}">{rtBadge[1]}</span>
          <button class="sa-btn sm" onclick={restartShellRuntime}>{t('重启服务')}</button>
        </div>
      </div>
      <div class="sa-foot" style="padding-bottom:14px">{hasScript ? t('附着形态下服务生命周期归计划任务托管，壳只探活连接；此按钮等价于重新拉起。') : t('打包服务端的 bridge 由桌面应用托管：退出应用即停止，开机随应用自启。')}</div>
    </div>
  {/if}


  <div class="sa-card">
    <div class="sa-card-h">{t('主机')}</div>
    <div class="sa-rows">
      <div class="sa-row">
        <span class="sa-row-tx">{t('主机名')}</span>
        <span class="sa-mono sa-mut">{sa.overview?.host?.name || '—'}</span>
      </div>
      <div class="sa-row">
        <span class="sa-row-tx">{t('局域网地址')}</span>
        <span class="sa-mono sa-mut lanlist">
          {#if sa.overview?.host?.lan?.length}
            {#each sa.overview.host.lan as ip (ip)}<span>http://{ip}:{sa.overview?.phonePort || ''}</span>{/each}
          {:else}—{/if}
        </span>
      </div>
      {#if tunnel.url}
        <div class="sa-row">
          <span class="sa-row-tx">{t('隧道地址')}</span>
          <span class="sa-mono sa-mut sa-trunc" style="max-width:60%">{tunnel.url}</span>
          <button class="sa-btn sm ghost" onclick={() => copy(tunnel.url)}>{t('复制')}</button>
        </div>
      {/if}
    </div>
    <div style="height:10px"></div>
  </div>
</div>

<style>
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
  .lanlist { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 12.5px; }
  @media (max-width: 1080px) { .grid2 { grid-template-columns: 1fr; } }
</style>
