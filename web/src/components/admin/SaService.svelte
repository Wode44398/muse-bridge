<script>
  // 服务控制 · 运行状态与日志（三端拆分 P4，任何形态都有）：进程与机器资源、在跑的轮、最近日志；
  // 没有 admin.ps1 / 桌面壳的机器（Linux 服务端、Docker）在这里重启——本进程排空后退出，交给守护进程
  // （systemd / Docker / pm2）拉起。可以「等空闲再重启」，不打断正在跑的对话。
  import { api } from '../../lib/api.js';
  import { sa, saToast, saConfirm, fmtUptime, supervisedBy } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import { createServerUpdate } from '../../lib/serverUpdate.svelte.js';

  // otherRestart：这台机器另有重启手段（admin.ps1 / 桌面壳），这里就不摆重启按钮，免得两套打架
  let { otherRestart = false } = $props();

  let info = $state(null);
  // 服务端更新（与设置「服务端更新」同一套，lib/serverUpdate.svelte.js）：任何形态都摆这一行、管理员从哪进来都能一键——
  // 安装包里的本机服务端交给那台电脑的桌面客户端去装，git 部署跑更新脚本，Docker / 手工部署只说怎么做。
  // 以前这里打包形态只有一句「去更新桌面客户端」、脚本更新按钮又跟着重启按钮一起被 otherRestart 藏掉，手机上进控制台更新不了。
  const srvUpd = createServerUpdate();
  const updView = $derived(srvUpd.view);
  let logs = $state(null);
  let logsOpen = $state(false);
  let restarting = $state(false);

  async function load() { try { info = await api.get('/api/admin/service'); } catch {} }
  async function loadLogs() { try { logs = (await api.get('/api/admin/logs?n=400')).lines || []; } catch { logs = []; } }
  $effect(() => { sa.tick; load(); srvUpd.load(); if (logsOpen) loadLogs(); });
  // 等空闲重启挂着、或正在更新时，每 5 秒刷一次看进度
  $effect(() => {
    if (!info?.restart?.pending && !info?.update?.running) return;
    const timer = setInterval(() => { load(); srvUpd.load(); }, 5000);
    return () => clearInterval(timer);
  });

  const GB = 1024 ** 3, MB = 1024 ** 2;
  const gb = (n) => (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB';
  const mb = (n) => Math.round(n / MB) + ' MB';
  const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);

  // 重启之后等它回来：每 2 秒探一次 ping，回来就提示、刷新数据（最多等 2 分钟）
  function waitBack() {
    restarting = true;
    const t0 = Date.now();
    const tick = async () => {
      try { await api.get('/api/admin/ping'); if (Date.now() - t0 > 3000) { restarting = false; saToast(t('服务已重启')); sa.tick++; return; } } catch {}
      if (Date.now() - t0 > 120_000) { restarting = false; saToast(t('服务还没回来，去服务器上看看日志'), true); return; }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2500);
  }
  // 快速隧道（临时地址）跟着服务端一起重启、地址必变：确认框里说清楚（经这个临时地址远程连着的，服务端直接回 409）
  const withQuickNote = (s) => (sa.publicAccess?.mode === 'quick' ? s + ' ' + t('现在用的是临时地址：服务端重启后会换一个新地址，手机 App 和分享出去的链接要跟着改。') : s);
  async function restart(mode) {
    if (mode === 'now') {
      const n = info?.liveTurns || 0;
      if (!(await saConfirm(t('立即重启服务？'), withQuickNote(n ? t('现在有 {n} 轮对话在跑，会被打断（记录会保留，可以接着问）。所有人会断开几秒，页面自动重连。', { n }) : t('现在没有在跑的对话。所有人会断开几秒，页面自动重连。')), { yes: t('立即重启'), danger: !!n }))) return;
    }
    try {
      const r = await api.post('/api/admin/service/restart', { mode });
      if (r?.error) throw new Error(r.error);
      if (mode === 'cancel') { saToast(t('已取消等待重启')); load(); return; }
      if (r.restart?.pending) { saToast(t('会在 {n} 轮对话跑完后重启', { n: r.live || '' })); load(); return; }
      saToast(t('正在重启…'));
      waitBack();
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('重启失败'), true); }
  }

  // 一键更新 / 检查并更新：先说清此刻有几轮在跑——它们不会被打断，跑完才装、才重启（总线给每台设备推提示）
  async function doUpdate() {
    const v = updView;
    if (!v || !v.action) return;
    if (v.action === 'check') { srvUpd.act('check'); return; }
    const n = info?.liveTurns || 0;
    const body = v.action === 'update'
      ? t('交给服务端所在电脑上的桌面客户端下载新版；下好后等所有对话跑完自动安装，服务端会重启一次。')
      : t('在服务器上拉最新代码、装依赖、重建前端（几分钟）；有新代码的话，等所有人的对话都跑完再自动重启。进度在下面的「最近日志」里。');
    const live = n ? ' ' + t('现在有 {n} 轮对话在跑，不会被打断。', { n }) : '';
    if (!(await saConfirm(v.action === 'update' ? t('更新服务端？') : t('更新到最新代码？'), withQuickNote(body + live), { yes: t('开始更新') }))) return;
    await srvUpd.act(v.action);
    if (srvUpd.err) saToast(srvUpd.err, true);
    else if (srvUpd.note) saToast(srvUpd.note);
    load();
  }
  const updSub = $derived(!updView ? '' : srvUpd.err || srvUpd.note || updView.sub);

  const levelCls = (l) => (l === 'error' ? 'le' : l === 'warn' ? 'lw' : '');
  const hhmmss = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
</script>

{#if info}
  <div class="sa-card">
    <div class="sa-card-h">{t('运行状态')}</div>
    <div class="stats">
      <div class="st"><b>{fmtUptime(info.uptimeSec)}</b><small>{t('已运行 · PID {pid}', { pid: info.pid })}</small></div>
      <div class="st"><b>{info.liveTurns}</b><small>{info.liveKeys ? t('在跑的对话 · {n} 人', { n: info.liveKeys }) : t('在跑的对话')}</small></div>
      <div class="st"><b>{mb(info.rss)}</b><small>{t('本进程内存 · Node {v}', { v: String(info.node).replace(/^v/, '') })}</small></div>
      <div class="st"><b>{pct(info.memTotal - info.memFree, info.memTotal)}%</b><small>{t('机器内存 {used} / {total}', { used: gb(info.memTotal - info.memFree), total: gb(info.memTotal) })}</small></div>
      <div class="st"><b>{info.loadavg?.[0]?.toFixed(2) ?? '—'}</b><small>{t('负载（1 分钟）· {n} 核', { n: info.cpus })}</small></div>
      {#if info.disk}<div class="st"><b>{gb(info.disk.free)}</b><small>{t('数据盘剩余 / {total}', { total: gb(info.disk.total) })}</small></div>{/if}
      <div class="st"><b>{info.harnessInstances}</b><small>{t('dimensio 实例')}</small></div>
      {#if info.deploy}
        <!-- 部署形态（src/config/deploy-profile.mjs，S1-7）：给谁用、监听地址、Claude in Chrome、保持唤醒的默认值按它定 -->
        <div class="st" title={t('给谁用、监听地址、Claude in Chrome、保持唤醒的默认值按部署形态定；显式设置优先')}>
          <b>{tr(info.deploy.label)}</b><small>{t('部署形态 · 监听 {host}', { host: info.deploy.listenHost })}</small>
        </div>
      {/if}
      {#if info.apk}
        <!-- 手机 App 从哪来（src/runtime/apk-source.mjs）：本机出包 → 发布页缓存 → OSS 镜像 → 公开发布页 → 都没有 -->
        <div class="st" title={tr(info.apk.mirror?.error || info.apk.release?.error || info.apk.release?.prefetchError) || ''}>
          <b>{info.apk.local ? info.apk.local.code : info.apk.mirror?.usable ? info.apk.mirror.latest.code : info.apk.release?.usable ? info.apk.release.code : '—'}</b>
          <small>{info.apk.local ? (info.apk.local.source === 'cache' ? t('手机 App 安装包 · 发布页缓存') : t('手机 App 安装包 · 本机出包'))
            : info.apk.mirror?.usable ? t('手机 App 安装包 · OSS 镜像')
            : info.apk.release?.usable ? t('手机 App 安装包 · 公开发布页')
            : info.apk.mirror?.configured ? (info.apk.mirror.latest ? t('镜像里的包比服务端新，先不发') : t('镜像清单拉取失败'))
            : t('手机 App 安装包 · 这台服务器没有可发的版本')}</small>
        </div>
      {/if}
    </div>
    <!-- 服务端更新（任何形态；与设置「服务端更新」同一套）：一键更新 / 检查更新 / 检查并更新，做不了时脚注说怎么更新 -->
    {#if updView}
      <div class="sa-rows">
        <div class="sa-row" title={srvUpd.st?.notes ? tr(srvUpd.st.notes) : ''}>
          <span class="sa-row-tx">
            <span>{t('服务端版本')}</span>
            <small class:warn={updView.tone === 'warn' || !!srvUpd.err}>{updSub}</small>
            {#if updView.how}<small>{updView.how}</small>{/if}
          </span>
          {#if srvUpd.st?.newer}<span class="sa-badge amber">{t('有新版')}</span>{/if}
          {#if updView.action}
            <button class="sa-btn sm" class:pri={updView.action !== 'check'} disabled={srvUpd.busy || srvUpd.loading || restarting} onclick={doUpdate}>{srvUpd.busy || srvUpd.loading ? t('处理中…') : updView.label}</button>
          {/if}
        </div>
        {#if srvUpd.st?.newer && srvUpd.st?.page}
          <a class="sa-row" href={srvUpd.st.page} target="_blank" rel="noopener noreferrer">
            <span class="sa-row-tx"><span>{t('新版本说明')}</span>{#if srvUpd.st.notes}<small>{tr(srvUpd.st.notes).slice(0, 160)}{srvUpd.st.notes.length > 160 ? '…' : ''}</small>{/if}</span>
          </a>
        {/if}
      </div>
    {/if}
    {#if !otherRestart}
      <div class="sa-rows">
        <div class="sa-row">
          <span class="sa-row-tx">
            <span>{t('重启服务')}</span>
            <small>{restarting ? t('正在重启，等它回来…')
              : info.restart?.pending && info.restart?.reason === 'update' ? t('等空闲中：还有 {n} 轮在跑，跑完就更新并重启（最多等 30 分钟）', { n: info.liveTurns })
              : info.restart?.pending ? t('等空闲中：还有 {n} 轮在跑，跑完就重启（最多等 30 分钟）', { n: info.liveTurns })
              : info.supervisor ? t('{by}：进程退出后自动拉起，所有人断开几秒', { by: supervisedBy(info.supervisor) })
              : t('没检测到守护进程（systemd / Docker / pm2），重启后不会自己起来——请在服务器上操作')}</small>
          </span>
          {#if info.supervisor && !restarting}
            {#if info.restart?.pending}
              <button class="sa-btn sm" onclick={() => restart('cancel')}>{t('取消等待')}</button>
            {:else}
              <button class="sa-btn sm" onclick={() => restart('idle')}>{t('空闲时重启')}</button>
            {/if}
            <button class="sa-btn sm dgr" onclick={() => restart('now')}>{t('立即重启')}</button>
          {/if}
        </div>
      </div>
    {/if}
    <div style="height:8px"></div>
  </div>

  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h">
      <span>{t('最近日志')}</span>
      <span class="sa-sp"></span>
      {#if logsOpen}<button class="sa-btn sm ghost" onclick={loadLogs}>{t('刷新')}</button>{/if}
      <button class="sa-btn sm" onclick={() => { logsOpen = !logsOpen; if (logsOpen) loadLogs(); }}>{logsOpen ? t('收起') : t('展开')}</button>
    </div>
    {#if logsOpen}
      <div class="logs sel-text">
        {#if !logs}<div class="sa-dim">{t('读取中…')}</div>
        {:else if !logs.length}<div class="sa-dim">{t('这次启动以来还没有日志')}</div>
        {:else}
          {#each logs as l, i (i)}<div class="ln {levelCls(l.level)}"><span class="tm">{hhmmss(l.t)}</span>{l.text}</div>{/each}
        {/if}
      </div>
    {/if}
    <div style="height:8px"></div>
  </div>
  <div class="sa-foot">{t('日志只留本次启动以来最近几百行（内存里，重启即清）；完整日志在服务器上：systemd 用 journalctl -u bridge，Docker 用 docker compose logs。')}</div>
{/if}

<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 12px 18px 6px; }
  .st { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 14px; background: var(--sa-soft); box-shadow: inset 0 0 0 .5px var(--sa-hair); min-width: 0; }
  .st b { font-size: 18px; font-weight: 600; color: var(--sa-tx); font-variant-numeric: tabular-nums; }
  .st small { font-size: 11.5px; color: var(--sa-tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 英文说明比中文长得多，单行省略会吃掉关键信息：英文下允许折行（中文保持单行） */
  .st small:lang(en) { white-space: normal; }
  /* 英文按钮（Restart when idle / Restart now）宽得多：窄屏上说明独占一行、按钮换到下一行（中文不变） */
  @media (max-width: 560px) {
    .sa-row:lang(en) { flex-wrap: wrap; }
    .sa-row:lang(en) .sa-row-tx { flex-basis: 100%; }
  }
  .logs { margin: 10px 18px 0; max-height: 420px; overflow: auto; padding: 10px 12px; border-radius: 12px; background: var(--sa-code);
    font-family: var(--sa-mono); font-size: 11.5px; line-height: 1.55; color: var(--sa-tx2); }
  .ln { white-space: pre-wrap; word-break: break-all; }
  .ln .tm { color: var(--sa-tx3); margin-right: 8px; }
  .ln.lw { color: var(--sa-warn); }
  .ln.le { color: var(--sa-red); }
  small.warn { color: var(--sa-warn); }
  a.sa-row { text-decoration: none; color: inherit; }
</style>
