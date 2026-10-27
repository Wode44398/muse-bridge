<script>
  // 扩展中心 ·「功能扩展」：Vertex / Codex / dimensio 三个可选模块。
  // 数据面 = /api/modules*（admin）。两种装法：从 GitHub 上和主程序同一版的发版一键安装 / 更新（/api/modules/install，
  // 进度经总线 modules.job 推、每项的 remote 说明能不能装或为什么不能），或上传随安装包附的离线 .zip。装、换、卸都排进
  // 待生效、重启 bridge 后生效（正在用的扩展目录不动——Codex 的 exe 跑着就删不掉）；开关 = 这个扩展撑着的 agent 的
  // 总开关（/api/agents，即时生效）。
  // 只挂在扩展面板（ext/Customize.svelte）里，卡片 / 开关 / 按钮用它的 .cz-* 样式（ext/cz.css）。
  import { untrack } from 'svelte';
  import { api, authHeaders } from '../lib/api.js';
  import { busOn } from '../lib/bus.js';
  import { me } from '../lib/state.svelte.js';
  import { apiUrl } from '../lib/server.js';
  import { t, tr } from '../lib/i18n.js';

  let { toast = () => {}, confirm = async () => true } = $props();

  // 三个扩展的展示信息（顺序同服务端目录；状态以 /api/modules 为准）
  const INFO = {
    vertex: { c: '#4285f4', desc: t('Gemini 分页与媒体生成（图像 / 视频 / 语音 / 音乐），以及 Claude 的媒体工具') },
    codex: { c: '#10a37f', desc: t('ChatGPT · Codex 分页（本机常驻 Codex，含 Codex 程序）') },
    dimensio: { c: '#ff9f0a', desc: t('dimensio 分页（独立的多模型 agent 底座）') },
  };
  const GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 4.5 7.3v9.4L12 20.5l7.5-3.8V7.3z"/><path d="m4.5 7.3 7.5 3.8 7.5-3.8M12 11.1v9.4"/></svg>';

  let data = $state(null);
  let loadErr = $state('');
  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));
  async function load(refresh = false) {
    try { data = await api.get('/api/modules' + (refresh ? '?refresh=1' : '')); loadErr = ''; settle(); }
    catch (e) { loadErr = errMsg(e); }
  }
  // agent 名单变了（别处拨了开关 / 别的设备改了，App 经总线 agents.changed 刷 me）就重拉，开关状态别停在旧值
  $effect(() => { JSON.stringify(me.agents); untrack(load); });

  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  function statusText(m) {
    if (m.pending?.action === 'install') return t('重启后安装 {version}', { version: m.pending.version || '' }).trim();
    if (m.pending?.action === 'remove') return t('重启后卸载');
    if (m.error) return tr(m.error);
    if (!m.installed) return [t('未安装'), m.remote?.action && m.remote.size ? fmtSize(m.remote.size) : ''].filter(Boolean).join(' · ');
    return [m.version && m.version !== 'dev' ? m.version : '', m.builtin ? t('内置') : t('已安装')].filter(Boolean).join(' · ');
  }

  // —— 从 GitHub 安装 / 更新：POST 后 2 秒内装完直接回结果，否则后台接着下，进度看 m.job（总线 modules.job 即时推，
  //    总线没连上时靠下面的轮询兜底）——
  const jobOn = (j) => !!j && j.phase !== 'error';
  const pct = (j) => (j.total ? Math.min(100, Math.floor((j.received / j.total) * 100)) : 0);
  function jobText(j) {
    if (j.phase === 'download') return j.total ? t('正在下载 {p}%', { p: pct(j) }) : t('正在下载…');
    if (j.phase === 'install') return t('正在安装…');
    return t('正在准备…');
  }
  // 不能从 GitHub 装的理由（服务端回 code，按 code 出译文；不认识的 code 原样显示服务端那句）
  function whyText(r) {
    switch (r.code) {
      case 'source': return t('源码部署：功能扩展随主程序代码一起更新，不用另装');
      case 'feed-off': return t('更新源已关闭，不从 GitHub 拉；可以手动上传离线包');
      case 'feed-custom': return t('更新源不是 GitHub 发布仓库；可以手动上传离线包');
      case 'not-found': return t('GitHub 上没有这一版的公开发版（私有版匿名下不了），请手动上传离线包');
      case 'offline': return t('连不上 GitHub，稍后重试，或手动上传离线包');
      case 'mismatch': return t('GitHub 上这一版的发版和本机不是同一次打包，请手动上传离线包');
      case 'bad-manifest': return t('GitHub 上这一版的发版清单读不懂，请手动上传离线包');
      case 'absent': return t('这一版的发版里没有这个扩展');
      case 'untrusted': return t('发版清单里没有 GitHub 的下载地址');
      case 'not-offered': return t('这一版不提供这个扩展');
      case 'remove': return t('已排队卸载，先撤销再装');
      default: return tr(r.reason || '');
    }
  }
  // 理由只在用户可能想装的时候显示（没装 / 装了但用不了）；内置、已排队的不啰嗦
  const showWhy = (m) => !!(m.remote && !m.remote.action && !m.remote.checking && m.remote.code && m.remote.code !== 'builtin'
    && !m.builtin && !m.pending && !jobOn(m.job) && (!m.installed || m.error));

  let busy = $state({});        // id → POST 还没回
  const waiting = new Set();    // 这台设备发起、还在后台装的（装完由这台提示一句）
  async function install(m) {
    busy[m.id] = true;
    try {
      const r = await api.post('/api/modules/install', { id: m.id });
      if (r.overview) data = r.overview;
      if (r.started) waiting.add(m.id);
      else toast(t('已排队安装「{name}」，重启后生效', { name: m.label }));
    } catch (e) {
      toast(errMsg(e), true);
      load();
    } finally { busy[m.id] = false; }
  }
  // 后台装的那些结束了没有：job 没了（装完，看 pending）或报错
  function settle() {
    if (!data || !waiting.size) return;
    for (const m of data.modules) {
      if (!waiting.has(m.id) || jobOn(m.job)) continue;
      waiting.delete(m.id);
      if (m.job?.phase === 'error') toast(tr(m.job.error || '') || t('安装失败'), true);
      else if (m.pending?.action === 'install') toast(t('已排队安装「{name}」，重启后生效', { name: m.label }));
    }
  }
  $effect(() => busOn((ev) => {
    if (ev?.type !== 'modules.job' || !data) return;
    const m = data.modules.find((x) => x.id === ev.id);
    if (!m) return;
    if (ev.phase === 'done' || ev.phase === 'error') { untrack(() => load()); return; }
    m.job = { phase: ev.phase, received: ev.received, total: ev.total, version: ev.version };
  }));
  // 兜底轮询：有在装的（总线断了也能看到进度和结果）；第一次查 GitHub 还没回（服务端先回 checking）
  let checks = 0;
  $effect(() => {
    if (!data) return;
    const active = data.modules.some((m) => jobOn(m.job));
    const checking = !!data.release?.checking && checks < 6;
    if (!active && !checking) return;
    const tm = setTimeout(() => { if (checking) checks++; load(); }, active ? 1500 : 2500);
    return () => clearTimeout(tm);
  });

  // —— 安装：选 .zip → XHR 上传（要进度：Codex 包好几百 MB）→ 排进待生效 ——
  let fileInput;
  let upPct = $state(-1);   // -1 = 没在传；0~100 上传中；100 之后是服务端解包校验
  function pick() { if (upPct < 0) fileInput?.click(); }
  function upload(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { toast(t('离线包是 .zip 文件'), true); return; }
    upPct = 0;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/modules/upload?name=' + encodeURIComponent(file.name)));
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) upPct = Math.min(100, Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      upPct = -1;
      let r = null; try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && r?.ok) {
        if (r.overview) data = r.overview;
        const name = r.overview?.modules?.find((m) => m.id === r.id)?.label || r.id;
        toast(t('已排队安装「{name}」，重启后生效', { name }));
      } else {
        toast(tr(r?.error || '') || t('安装失败（HTTP {code}）', { code: xhr.status }), true);
      }
    };
    xhr.onerror = () => { upPct = -1; toast(t('上传中断，请重试'), true); };
    xhr.send(file);
  }

  async function uninstall(m) {
    const ok = await confirm({ title: t('卸载「{name}」？', { name: m.label }), desc: t('重启 bridge 后删除它的程序文件；它的会话记录与数据留着，重装后还在。'), yes: t('卸载'), danger: true });
    if (!ok) return;
    try { const r = await api.post('/api/modules/uninstall', { id: m.id }); data = r.overview || data; }
    catch (e) { toast(errMsg(e), true); }
  }
  async function cancel(m) {
    try { const r = await api.post('/api/modules/cancel', { id: m.id }); data = r.overview || data; }
    catch (e) { toast(errMsg(e), true); }
  }
  async function toggle(m) {
    const on = !m.enabled;
    try {
      for (const a of m.agents) await api.post('/api/agents', { id: a, enabled: on });
      await load();
    } catch (e) { toast(errMsg(e), true); }
  }

  // —— 重启：先交给守护进程等空闲重启（桌面托管的服务端 supervisor 是 desktop：排空后以 75 退出、由壳拉起，不打断对话；
  //    Linux / Docker 服务端同理）；服务端回「没有守护进程」（附着形态的主机等）时，桌面壳才退回重拉本地运行时 ——
  let restarting = $state(false);
  async function restart() {
    restarting = true;
    const rt = typeof window !== 'undefined' ? window.BridgeDesktop?.runtime : null;
    try {
      try {
        await api.post('/api/admin/service/restart', { mode: 'idle' });
        toast(t('将在空闲时重启（没有在跑的对话时）'));
        return;
      } catch (e) {
        if (!rt?.restart) throw e;
      }
      await rt.restart();
    } catch (e) { toast(errMsg(e), true); }
    finally { restarting = false; }
  }
</script>

<input bind:this={fileInput} type="file" accept=".zip" hidden onchange={(e) => { upload(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />

{#if loadErr}
  <div class="cz-empty">{loadErr}</div>
{:else if !data}
  <div class="cz-empty">{t('载入中…')}</div>
{:else}
  {#if data.restartNeeded}
    <div class="cz-mp-banner">
      <span>{t('有改动等重启生效')}</span>
      <button class="cz-btn sm pri" disabled={restarting} onclick={restart}>{restarting ? t('正在重启…') : t('立即重启')}</button>
    </div>
  {/if}

  <div class="cz-grid">
    {#each data.modules as m (m.id)}
      <div class="cz-card static" class:off={!m.loaded}>
        <span class="cz-tile">{@html GLYPH}</span>
        <div class="cz-body">
          <b class="cz-name">{m.label}</b>
          <p class="cz-desc">{INFO[m.id]?.desc || ''}</p>
          {#if jobOn(m.job)}
            <span class="cz-foot">{jobText(m.job)}</span>
            <span class="mp-bar" class:indet={m.job.phase !== 'download' || !m.job.total}><i style:width={m.job.phase === 'download' && m.job.total ? pct(m.job) + '%' : null}></i></span>
          {:else}
            <span class="cz-foot" class:err={m.error && !m.pending}>{statusText(m)}</span>
            {#if m.job?.phase === 'error'}<span class="mp-why err">{tr(m.job.error || '')}</span>
            {:else if showWhy(m)}<span class="mp-why">{whyText(m.remote)}</span>
            {:else if m.remote?.checking && !m.builtin && !m.installed}<span class="mp-why">{t('正在查询 GitHub…')}</span>{/if}
          {/if}
          {#if !jobOn(m.job) && (m.remote?.action || m.pending || (m.installed && !m.builtin) || (showWhy(m) && m.remote.code === 'offline'))}
            <span class="mp-acts">
              {#if m.remote?.action}
                <button class="cz-btn sm pri" disabled={busy[m.id]} onclick={() => install(m)}>
                  {m.remote.action === 'update' ? t('更新到 {version}', { version: m.remote.version }) : t('安装')}
                </button>
              {:else if showWhy(m) && m.remote.code === 'offline'}
                <button class="cz-btn sm" onclick={() => load(true)}>{t('重试')}</button>
              {/if}
              {#if m.pending}<button class="cz-btn sm" onclick={() => cancel(m)}>{t('撤销')}</button>
              {:else if m.installed && !m.builtin}<button class="cz-btn sm" onclick={() => uninstall(m)}>{t('卸载')}</button>{/if}
            </span>
          {/if}
        </div>
        {#if m.loaded}
          <button class="cz-sw" class:on={m.enabled} role="switch" aria-checked={m.enabled} onclick={() => toggle(m)} aria-label={t('启用 {name}', { name: m.label })}><span></span></button>
        {/if}
      </div>
    {/each}
  </div>

  <div class="cz-mp-acts">
    <button class="cz-btn" disabled={upPct >= 0} onclick={pick}>
      {#if upPct >= 0}{upPct < 100 ? t('正在上传 {p}%', { p: upPct }) : t('正在安装…')}{:else}{t('安装离线包')}{/if}
    </button>
  </div>
  <p class="cz-note">
    {t('功能扩展装上才有对应的分页。可以从 GitHub 上和主程序同一版的发版一键安装，也可以上传随安装包一起发的离线包（.zip），离线包要和主程序是同一次打包。装、换、卸都在重启 bridge 后生效。开关 = 这个扩展的 agent 总开关，即时生效。')}
    {#if data.buildId}<br />{t('主程序打包号 {id}', { id: data.buildId })}{/if}
  </p>
{/if}

<style>
  .mp-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .mp-why { margin-top: 2px; font-size: 13px; line-height: 1.45; color: var(--cz-ink3); overflow-wrap: anywhere; }
  .mp-why.err { color: var(--cz-crit); }
  .mp-bar { position: relative; display: block; height: 4px; margin-top: 8px; border-radius: 2px; overflow: hidden; background: var(--cz-hover); }
  .mp-bar i { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--cz-ink2); transition: width .3s ease; }
  .mp-bar.indet i { width: 30%; animation: mp-slide 1.1s ease-in-out infinite; }
  @keyframes mp-slide { from { left: -30%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .mp-bar.indet i { animation: none; width: 100%; opacity: .5; } }
</style>
