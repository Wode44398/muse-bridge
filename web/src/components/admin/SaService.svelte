<script>
  // 服务控制 · 运行状态与日志：进程与机器资源、在跑的轮、最近日志；在这里重启——本进程排空后退出，
  // 交给守护进程（systemd / Docker / pm2）拉起。可以「等空闲再重启」，不打断正在跑的对话。
  import { api } from '../../lib/api.js';
  import { sa, saToast, saConfirm, fmtUptime } from '../../lib/serverAdmin.svelte.js';

  let info = $state(null);
  let logs = $state(null);
  let logsOpen = $state(false);
  let restarting = $state(false);

  async function load() { try { info = await api.get('/api/admin/service'); } catch {} }
  async function loadLogs() { try { logs = (await api.get('/api/admin/logs?n=400')).lines || []; } catch { logs = []; } }
  $effect(() => { sa.tick; load(); if (logsOpen) loadLogs(); });
  // 等空闲重启挂着、或正在更新时，每 5 秒刷一次看进度
  $effect(() => {
    if (!info?.restart?.pending && !info?.update?.running) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
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
      try { await api.get('/api/admin/ping'); if (Date.now() - t0 > 3000) { restarting = false; saToast('服务已重启'); sa.tick++; return; } } catch {}
      if (Date.now() - t0 > 120_000) { restarting = false; saToast('服务还没回来，去服务器上看看日志', true); return; }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2500);
  }
  async function restart(mode) {
    if (mode === 'now') {
      const n = info?.liveTurns || 0;
      if (!(await saConfirm('立即重启服务？', (n ? `现在有 ${n} 轮对话在跑，会被打断（记录会保留，可以接着问）。` : '现在没有在跑的对话。') + '所有人会断开几秒，页面自动重连。', { yes: '立即重启', danger: !!n }))) return;
    }
    try {
      const r = await api.post('/api/admin/service/restart', { mode });
      if (r?.error) throw new Error(r.error);
      if (mode === 'cancel') { saToast('已取消等待重启'); load(); return; }
      if (r.restart?.pending) { saToast(`会在 ${r.live || ''} 轮对话跑完后重启`); load(); return; }
      saToast('正在重启…');
      waitBack();
    } catch (e) { saToast(e?.body?.error || e?.message || '重启失败', true); }
  }

  // 更新：拉代码 → 装依赖 → 重建前端（以服务用户跑 scripts/server/update.sh），有新代码就等空闲重启
  async function doUpdate() {
    if (!(await saConfirm('更新到最新代码？', '在服务器上拉最新代码、装依赖、重建前端（几分钟）；有新代码的话，等所有人的对话都跑完再自动重启。进度在下面的「最近日志」里。', { yes: '开始更新' }))) return;
    try {
      const r = await api.post('/api/admin/service/update', {});
      if (r?.error) throw new Error(r.error);
      saToast('开始更新…');
      logsOpen = true; loadLogs(); load();
    } catch (e) { saToast(e?.body?.error || e?.message || '更新失败', true); }
  }
  const updLine = $derived(!info?.update ? '' : info.update.running ? '正在更新：拉代码、装依赖、重建前端…'
    : info.update.exitCode != null && info.update.exitCode !== 0 ? '上次更新失败（退出码 ' + info.update.exitCode + '），看最近日志'
    : info.update.result === 'updated' ? '新代码已就位' + (info.restart?.pending ? '，等对话跑完就重启' : '')
    : info.update.result === 'unchanged' ? '已经是最新'
    : info.update.blocked || '拉最新代码、装依赖、重建前端，完成后空闲时重启');

  const levelCls = (l) => (l === 'error' ? 'le' : l === 'warn' ? 'lw' : '');
  const hhmmss = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
</script>

{#if info}
  <div class="sa-card">
    <div class="sa-card-h">运行状态</div>
    <div class="stats">
      <div class="st"><b>{fmtUptime(info.uptimeSec)}</b><small>已运行 · PID {info.pid}</small></div>
      <div class="st"><b>{info.liveTurns}</b><small>在跑的对话{info.liveKeys ? ` · ${info.liveKeys} 人` : ''}</small></div>
      <div class="st"><b>{mb(info.rss)}</b><small>本进程内存 · Node {String(info.node).replace(/^v/, '')}</small></div>
      <div class="st"><b>{pct(info.memTotal - info.memFree, info.memTotal)}%</b><small>机器内存 {gb(info.memTotal - info.memFree)} / {gb(info.memTotal)}</small></div>
      <div class="st"><b>{info.loadavg?.[0]?.toFixed(2) ?? '—'}</b><small>负载（1 分钟）· {info.cpus} 核</small></div>
      {#if info.disk}<div class="st"><b>{gb(info.disk.free)}</b><small>数据盘剩余 / {gb(info.disk.total)}</small></div>{/if}
      <div class="st"><b>{info.harnessInstances}</b><small>dimensio 实例</small></div>
    </div>
    <div class="sa-rows">
        <div class="sa-row">
          <span class="sa-row-tx">
            <span>重启服务</span>
            <small>{restarting ? '正在重启，等它回来…'
              : info.restart?.pending ? `等空闲中：还有 ${info.liveTurns} 轮在跑，跑完就重启（最多等 30 分钟）`
              : info.supervisor ? `由 ${info.supervisor} 托管：进程退出后自动拉起，所有人断开几秒`
              : '没检测到守护进程（systemd / Docker / pm2），重启后不会自己起来——请在服务器上操作'}</small>
          </span>
          {#if info.supervisor && !restarting}
            {#if info.restart?.pending}
              <button class="sa-btn sm" onclick={() => restart('cancel')}>取消等待</button>
            {:else}
              <button class="sa-btn sm" onclick={() => restart('idle')}>空闲时重启</button>
            {/if}
            <button class="sa-btn sm dgr" onclick={() => restart('now')}>立即重启</button>
          {/if}
        </div>
        {#if info.update && !info.update.blocked}
          <div class="sa-row">
            <span class="sa-row-tx"><span>更新</span><small>{updLine}</small></span>
            <button class="sa-btn sm pri" disabled={info.update.running || restarting} onclick={doUpdate}>{info.update.running ? '更新中…' : '检查并更新'}</button>
          </div>
        {/if}
      </div>
    <div style="height:8px"></div>
  </div>

  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h">
      <span>最近日志</span>
      <span class="sa-sp"></span>
      {#if logsOpen}<button class="sa-btn sm ghost" onclick={loadLogs}>刷新</button>{/if}
      <button class="sa-btn sm" onclick={() => { logsOpen = !logsOpen; if (logsOpen) loadLogs(); }}>{logsOpen ? '收起' : '展开'}</button>
    </div>
    {#if logsOpen}
      <div class="logs">
        {#if !logs}<div class="sa-dim">读取中…</div>
        {:else if !logs.length}<div class="sa-dim">这次启动以来还没有日志</div>
        {:else}
          {#each logs as l, i (i)}<div class="ln {levelCls(l.level)}"><span class="tm">{hhmmss(l.t)}</span>{l.text}</div>{/each}
        {/if}
      </div>
    {/if}
    <div style="height:8px"></div>
  </div>
  <div class="sa-foot">日志只留本次启动以来最近几百行（内存里，重启即清）；完整日志在服务器上：journalctl -u bridge。</div>
{/if}

<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 12px 18px 6px; }
  .st { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 14px; background: rgba(255, 255, 255, .05); min-width: 0; }
  .st b { font-size: 18px; font-weight: 700; color: var(--sa-tx); font-variant-numeric: tabular-nums; }
  .st small { font-size: 11.5px; color: var(--sa-tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .logs { margin: 10px 18px 0; max-height: 420px; overflow: auto; padding: 10px 12px; border-radius: 12px; background: rgba(0, 0, 0, .35);
    font-family: var(--sa-mono); font-size: 11.5px; line-height: 1.55; color: var(--sa-tx2); }
  .ln { white-space: pre-wrap; word-break: break-all; }
  .ln .tm { color: var(--sa-tx3); margin-right: 8px; }
  .ln.lw { color: #ffd479; }
  .ln.le { color: #ff8078; }
</style>
