<script>
  // 控制台 · 设备：各账号登记的电脑——桌面客户端（登录即登记）、老中继迁来的。
  // 数据面 = routes/devices.mjs 的 /api/devices*（管理员身份；开着远程管理时手机 / 网页上也能管）：
  //  · 概况：设备数 / 在线、客户端最新版、服务器地址；
  //  · 设备：主人、在线状态、客户端版本与档位；展开看详情、系统信息、查看屏幕、远程更新、断开、改名、吊销、删除、该设备的记录；
  //  · 记录：设备通道的审计（上线下线、操作、终端、端口转发、更新；老记录里可能还有配对）；
  //  · 迁移与安全：并入老中继的 devices.json、轮换主机密钥。
  // 原「客户端配对」页（直通独立中继 /admin/*）随中继并进服务端下线；远程协助（配对码）也已下线。
  import { untrack } from 'svelte';
  import { api } from '../../lib/api.js';
  import { sa, loadDevs, saToast, saConfirm, fmtAgo, pageVisible } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr, locale, isEn } from '../../lib/i18n.js';
  import SaPairCard from '../pairing/SaPairCard.svelte';

  // 打开即拉、之后每 5s 刷一次（在线状态要跟得上；设备事件只推给设备主人，看所有人的设备只能轮询）；
  // 页面在后台时不拉（R6）。手动刷新走 sa.tick（外层刷新按钮只加 tick，不再另拉一次）。
  $effect(() => {
    sa.tick;
    untrack(loadDevs);
    const timer = setInterval(() => { if (pageVisible()) loadDevs(); }, 5000);
    return () => clearInterval(timer);
  });

  const R = $derived(sa.devs);
  const release = $derived(R?.release || null);
  const devices = $derived(R?.devices || []);
  let showRevoked = $state(false);
  const active = $derived(devices.filter((d) => !d.revoked));
  const revoked = $derived(devices.filter((d) => d.revoked));
  const shown = $derived(showRevoked ? devices : active);
  const onlineN = $derived(active.filter((d) => d.online).length);

  // —— 相对时间 ——
  const ago = (iso) => (iso ? fmtAgo(typeof iso === 'number' ? iso : Date.parse(iso)) : '—');
  const mb = (n) => (n ? (n / 1048576).toFixed(0) + ' MB' : '');
  const err = (e) => tr(e?.body?.error || e?.message || String(e));
  const loc = () => (isEn() ? locale() : undefined);
  function copy(text, msg = t('已复制')) { navigator.clipboard?.writeText(text).then(() => saToast(msg)).catch(() => saToast(t('复制失败'), true)); }
  // owner 键是 'u:<账号 id>'（S2-4：新账号 id = 名字-随机串，老账号 = 用户名）：用户列表拉到过就换成登录名
  const ownerName = (o) => {
    if (!o || o === 'admin') return t('管理员');
    const id = String(o).replace(/^u:/, '');
    return sa.users.find((u) => (u.id || u.name) === id)?.name || id;
  };
  const KIND = { desktop: t('桌面客户端'), legacy: t('老客户端') };
  const TIER = { control: t('可操作'), observe: t('只看'), off: tc('开关', '关') };

  // 版本比较：2026.09.19.1039 逐段按数字
  function cmpVer(a, b) {
    const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  }
  function verState(d) {
    const v = d.client?.version;
    if (!v) return { cls: 'gray', tx: t('版本未上报') };
    if (!release) return { cls: 'gray', tx: 'v' + v };
    return cmpVer(v, release.version) >= 0 ? { cls: 'green', tx: t('v{v} · 最新', { v }) } : { cls: 'amber', tx: t('v{v} · 落后', { v }) };
  }
  const canSee = (d) => d.online && ((d.client?.caps || []).includes('desktop') || d.client?.tier === 'control' || d.client?.tier === 'observe');

  // —— 设备操作 ——
  let openId = $state('');
  let renameOf = $state(null);      // { id, name }
  let detail = $state({});          // id -> { sysinfo, shot, audit, busy }
  const D = (id) => detail[id] || {};
  function patchDetail(id, p) { detail = { ...detail, [id]: { ...D(id), ...p } }; }

  function toggleOpen(d) {
    openId = openId === d.id ? '' : d.id;
    if (openId) loadDeviceAudit(d.id);
  }
  async function loadDeviceAudit(id) {
    try { const r = await api.get('/api/devices/audit?device=' + encodeURIComponent(id) + '&limit=40'); patchDetail(id, { audit: r.entries || [] }); }
    catch (e) { patchDetail(id, { audit: [], auditErr: err(e) }); }
  }
  const act = (id, action, extra = {}) => api.post('/api/devices/action', { id, action, ...extra });
  async function doRename() {
    const { id, name } = renameOf || {};
    if (!name?.trim()) { saToast(t('名字不能为空'), true); return; }
    try { await act(id, 'rename', { name: name.trim() }); renameOf = null; saToast(t('已改名')); loadDevs(); }
    catch (e) { saToast(err(e), true); }
  }
  async function revoke(d) {
    if (!(await saConfirm(t('吊销「{name}」？', { name: d.name }), t('它的设备令牌立即作废，设备通道当场断开；要再连只能在那台电脑的桌面客户端上重新登录。'), { yes: t('吊销'), danger: true }))) return;
    try { await act(d.id, 'revoke'); saToast(t('已吊销 {name}', { name: d.name })); loadDevs(); }
    catch (e) { saToast(err(e), true); }
  }
  async function remove(d) {
    if (!(await saConfirm(t('删除「{name}」的记录？', { name: d.name }), t('只删设备表里这一行（它早已被吊销），连带删掉它的端口转发；审计日志保留。'), { yes: t('删除'), danger: true }))) return;
    try { await act(d.id, 'delete'); if (openId === d.id) openId = ''; saToast(t('已删除')); loadDevs(); }
    catch (e) { saToast(err(e), true); }
  }
  async function kick(d) {
    try { await act(d.id, 'kick'); saToast(t('已断开，客户端会自动重连')); setTimeout(loadDevs, 1200); }
    catch (e) { saToast(err(e), true); }
  }
  async function probe(d, what) {
    // S1-5：托管着本机服务端的那台会等所有对话跑完再装、装完自动回来；它用临时地址时客户端直接拒绝（地址一变远程就连不回来）
    if (what === 'update' && !(await saConfirm(t('远程更新「{name}」？', { name: d.name }), t('客户端会下载 v{version} 并静默安装，装完自动重新上线（控制通道断开约一两分钟）。如果这台电脑托管着服务端，会等所有对话跑完再装；它用的是临时地址时会拒绝远程更新。', { version: release?.version }), { yes: t('开始更新') }))) return;
    patchDetail(d.id, { busy: what });
    try {
      const r = await api.post('/api/devices/probe', { id: d.id, what });
      if (what === 'sysinfo') patchDetail(d.id, { sysinfo: r.result });
      if (what === 'screenshot') patchDetail(d.id, { shot: r.result });
      if (what === 'update') {
        const u = r.result || {};
        saToast(u.status === 'latest' ? t('已是最新（v{v}）', { v: u.current })
          : u.status === 'downloading' ? (u.idle ? t('已下达：v{from} → v{to}，下载完等对话都跑完再装，装完服务端自动回来', { from: u.current, to: u.latest }) : t('已下达：v{from} → v{to}，客户端下载完会自动重启', { from: u.current, to: u.latest }))
          : tr(u.reason || u.status || ''), u.status === 'refused');
      }
    } catch (e) { saToast(err(e), true); }
    patchDetail(d.id, { busy: '' });
    loadDeviceAudit(d.id);
  }

  // —— 记录 ——
  let auditKind = $state('ops');
  let auditRows = $state([]);
  let auditErr = $state('');
  $effect(() => { sa.tick; untrack(loadAudit); });
  async function loadAudit() {
    try { const r = await api.get('/api/devices/audit?limit=200'); auditRows = r.entries || []; auditErr = ''; }
    catch (e) { auditRows = []; auditErr = err(e); }
  }
  const KINDS = {
    ops: (e) => /^(op|term_open|forward_)/.test(e.ev),
    conn: (e) => e.ev === 'attach' || e.ev === 'detach',
    security: (e) => /^(unauthorized|control_unauth|pair_|register|device_|host_secret)/.test(e.ev),
    update: (e) => /^client_update/.test(e.ev),
    '': () => true,
  };
  const auditShown = $derived(auditRows.filter(KINDS[auditKind] || KINDS['']).slice(0, 80));
  const nameOf = (id) => devices.find((d) => d.id === id)?.name || id || '';
  const EV = {
    attach: t('设备通道上线'), detach: t('设备通道下线'), op: t('操作'), term_open: t('打开终端'),
    forward_create: t('建端口转发'), forward_remove: t('删端口转发'), register: t('登记设备'),
    pair_mint: t('生成配对码'), pair_ok: t('配对成功'), pair_reject: t('配对码错误'), pair_locked: t('配对被锁（尝试过多）'),
    client_update_check: tc('admin', '检查更新'), client_update_download: tc('admin', '下载更新包'),
    control_unauth: t('主机密钥无效'), unauthorized: t('未授权访问'), host_secret_rotate: t('轮换主机密钥'),
    device_rename: t('改名'), device_revoke: t('吊销'), device_delete: t('删除设备'), device_kick: t('断开通道'), device_stop: t('急停'),
  };
  function evDetail(e) {
    switch (e.ev) {
      case 'op': return `${e.op}${e.by ? ' · ' + e.by : ''} · ${e.ok ? t('成功') : t('失败')} · ${e.ms}ms${e.err ? ' · ' + tr(e.err) : ''}`;
      case 'attach': return [e.version ? 'v' + e.version : '', e.tier ? TIER[e.tier] || e.tier : '', e.ip || ''].filter(Boolean).join(' · ');
      case 'detach': return e.ms ? t('在线 {n} 分钟', { n: Math.round(e.ms / 60000) }) : '';
      case 'client_update_check': return e.current ? t('v{current}（最新 v{latest}）', { current: e.current, latest: e.version }) : t('最新 v{latest}', { latest: e.version });
      case 'client_update_download': return 'v' + e.version;
      case 'forward_create': case 'forward_remove': return t('端口 {port}', { port: e.port }) + (e.by ? ' · ' + ownerName(e.by) : '');
      case 'register': case 'pair_ok': return [e.name, e.owner ? ownerName(e.owner) : '', e.ip].filter(Boolean).join(' · ');
      case 'pair_mint': return [e.name, e.owner ? ownerName(e.owner) : ''].filter(Boolean).join(' · ');
      case 'unauthorized': case 'control_unauth': case 'pair_reject': case 'pair_locked': return e.ip || '';
      default: return e.by ? ownerName(e.by) : '';
    }
  }
  const evTone = (e) => (e.ev === 'op' && !e.ok) || /unauth|reject|locked/.test(e.ev) ? 'bad' : (e.ev === 'op' || e.ev === 'term_open' || /^forward_/.test(e.ev)) ? 'act' : '';
  const hhmm = (iso) => {
    const d = new Date(iso);
    if (isEn()) return new Intl.DateTimeFormat(locale(), { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // —— 迁移与安全 ——
  let importPath = $state('');
  let importBusy = $state(false);
  async function importRelay() {
    if (!importPath.trim() || importBusy) return;
    importBusy = true;
    try {
      const r = await api.post('/api/devices/import-relay', { path: importPath.trim() });
      saToast(t('已并入 {a} 台，跳过 {b} 台（已存在或缺令牌哈希）', { a: r.added, b: r.skipped }));
      importPath = '';
      loadDevs();
    } catch (e) { saToast(err(e), true); }
    importBusy = false;
  }
  async function rotateSecret() {
    if (!(await saConfirm(t('轮换主机密钥？'), t('生成新的 remotePcSecret，旧的立即失效。设备不受影响（它们用各自的设备令牌）；同机工具 rc.mjs 下次调用自动读新的，Codex / dimensio 要重启后才拿到新密钥。'), { yes: t('轮换') }))) return;
    try { const r = await api.post('/api/devices/rotate-host-secret', {}); saToast(t('已轮换 · {time}', { time: new Date(r.rotatedAt).toLocaleTimeString(loc()) })); }
    catch (e) { saToast(err(e), true); }
  }

</script>

<!-- 接入新手机（S1-2）：配对二维码 + 最近的配对记录 -->
<SaPairCard />

{#if !R}
  <div class="sa-card"><div class="sa-empty">{t('正在读取设备…')}</div></div>
{:else if R.error}
  <div class="sa-card">
    <div class="sa-card-h"><span class="sa-dot bad"></span>{t('读不到设备表')}</div>
    <div class="sa-rows"><div class="sa-row"><span class="sa-row-tx">{tr(R.error)}</span></div></div>
    <div style="height:10px"></div>
  </div>
{:else}
  {#if R.enabled === false}
    <div class="sa-err" style="margin-bottom:12px">{t('这台 bridge 关闭了设备通道（config.json devices=false）：设备连不上，Claude 也拿不到设备工具。')}</div>
  {/if}
  <!-- 概况 -->
  <div class="stats">
    <div class="sa-card sa-stat"><div class="k">{t('设备')}</div><div class="v">{active.length}</div><div class="x">{t('{n} 台在线', { n: onlineN })}{revoked.length ? ' · ' + t('{n} 台已吊销', { n: revoked.length }) : ''}</div></div>
    <div class="sa-card sa-stat"><div class="k">{t('客户端最新版')}</div><div class="v sm sa-trunc">{release ? release.version : t('未发布')}</div><div class="x">{release ? mb(release.size) + ' · ' + (release.mirrors?.length ? t('有 OSS 镜像') : t('仅本服务器下载')) : t('发版目录里没有 latest.json（config.clientDist，默认数据根下 client-dist）')}</div></div>
    <div class="sa-card sa-stat"><div class="k">{t('服务器地址')}</div><div class="v sm sa-trunc">{R.origin || '—'}</div><div class="x">{t('设备都连这里')}</div></div>
  </div>

  <div class="sa-card">
    <div class="sa-card-h">{t('迁移与安全')}</div>
    <div class="sa-rows">
      <div class="sa-row">
        <span class="sa-row-tx">{t('并入老中继的设备')}<small>{t('老中继的 devices.json（client\\host\\devices.json）里配对过的被控端原样并进来，令牌照用、不用重配')}</small></span>
      </div>
      <div class="sa-row">
        <input class="sa-in slim" style="max-width:none;flex:1" bind:value={importPath} placeholder={t('devices.json 的完整路径（服务器上）')} onkeydown={(e) => e.key === 'Enter' && importRelay()} />
        <button class="sa-btn sm pri" onclick={importRelay} disabled={importBusy || !importPath.trim()}>{importBusy ? t('处理中…') : t('并入')}</button>
      </div>
      <div class="sa-row">
        <span class="sa-row-tx">{t('主机密钥')}<small>{t('同机工具（rc.mjs、Codex、dimensio）操作设备时出示的密钥，存在 config.json 的 remotePcSecret；怀疑外泄就轮换')}</small></span>
        <button class="sa-btn sm" onclick={rotateSecret}>{t('轮换')}</button>
      </div>
    </div>
    <div style="height:10px"></div>
  </div>

  <!-- 设备 -->
  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h">{t('全部设备')}
      <span class="sa-sp"></span>
      {#if revoked.length}
        <button class="sa-chip-btn" class:on={showRevoked} onclick={() => { showRevoked = !showRevoked; }}>{t('显示已吊销（{n}）', { n: revoked.length })}</button>
      {/if}
    </div>
    {#if !shown.length}
      <div class="sa-empty">{t('还没有设备——在电脑上装桌面客户端并登录')}</div>
    {:else}
      <div class="dlist">
        {#each shown as d (d.id)}
          {@const vs = verState(d)}
          {@const dt = D(d.id)}
          <div class="dev" class:open={openId === d.id} class:rev={d.revoked}>
            <button class="dev-main" onclick={() => toggleOpen(d)}>
              {#if d.revoked}<span class="sa-dot bad"></span>{:else if d.online}<span class="sa-live"></span>{:else}<span class="sa-dot"></span>{/if}
              <span class="dev-name">
                <b class="sa-trunc">{d.name}</b>
                <small class="sa-mono sa-dim">{ownerName(d.owner)} · {KIND[d.kind] || d.kind} · {d.platform || '—'}{d.hostname ? ' · ' + d.hostname : ''}</small>
              </span>
              <span class="dev-badges">
                {#if d.revoked}<span class="sa-badge red">{t('已吊销')}</span>
                {:else}
                  <span class="sa-badge {vs.cls}">{vs.tx}</span>
                  {#if d.online && d.client?.tier}<span class="sa-badge {d.client.tier === 'control' ? 'purple' : 'blue'}">{TIER[d.client.tier] || d.client.tier}</span>{/if}
                  {#if d.sameMachine}<span class="sa-badge gray">{t('与服务器同机')}</span>{/if}
                {/if}
              </span>
              <span class="dev-when sa-mut">
                {#if d.revoked}{t('已吊销')}
                {:else if d.online}{t('{ago}上线', { ago: ago(d.since) })}
                {:else if d.lastOnlineAt}{t('最后在线 {ago}', { ago: ago(d.lastOfflineAt || d.lastOnlineAt) })}
                {:else}{t('从未连上')}{/if}
              </span>
              <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
            </button>

            {#if openId === d.id}
              <div class="dev-body">
                <div class="kv">
                  <span>{t('主人')}</span><b>{ownerName(d.owner)}</b>
                  <span>{t('登记于')}</span><b>{d.createdAt ? new Date(d.createdAt).toLocaleString(loc()) : '—'}</b>
                  <span>{t('最后请求')}</span><b>{d.lastSeenAt ? t('{time}（{ago}）', { time: new Date(d.lastSeenAt).toLocaleString(loc()), ago: ago(d.lastSeenAt) }) : t('从未')}</b>
                  <span>{t('设备通道')}</span><b>{d.online ? t('在线（{ago}接入）', { ago: ago(d.since) }) : d.lastOfflineAt ? t('离线（{ago}断开）', { ago: ago(d.lastOfflineAt) }) : d.lastOnlineAt ? t('离线') : t('从未接入')}{d.inflight ? ' · ' + t('{n} 个操作进行中', { n: d.inflight }) : ''}</b>
                  <span>{t('客户端')}</span><b>{d.client?.version ? 'v' + d.client.version : t('未上报')}{release && d.client?.version && cmpVer(d.client.version, release.version) < 0 ? t(' → 可更新到 v{v}', { v: release.version }) : ''}</b>
                  {#if d.client?.os}<span>{t('系统')}</span><b>{d.client.os}{d.client.user ? ' · ' + t('用户 {user}', { user: d.client.user }) : ''}</b>{/if}
                  {#if d.client?.caps?.length}<span>{t('能力')}</span><b class="sa-mono">{d.client.caps.join(' · ')}</b>{/if}
                  {#if d.lastOp}<span>{t('最近操作')}</span><b>{d.lastOp} · {ago(d.lastOpAt)}</b>{/if}
                </div>

                {#if !d.revoked}
                  <div class="acts-row">
                    <button class="sa-btn sm" onclick={() => probe(d, 'sysinfo')} disabled={!d.online || !!dt.busy}>{dt.busy === 'sysinfo' ? t('读取中…') : t('系统信息')}</button>
                    <button class="sa-btn sm" onclick={() => probe(d, 'screenshot')} disabled={!canSee(d) || !!dt.busy} title={canSee(d) ? '' : t('设备离线，或对方把档位设成了关闭')}>{dt.busy === 'screenshot' ? t('截屏中…') : t('查看屏幕')}</button>
                    <button class="sa-btn sm pri" onclick={() => probe(d, 'update')} disabled={!d.online || !d.client?.update || !release || !!dt.busy || (d.client?.version && cmpVer(d.client.version, release.version) >= 0)} title={d.client?.update ? '' : t('这台不支持远程更新（客户端太老）')}>{dt.busy === 'update' ? t('下达中…') : t('远程更新')}</button>
                    <button class="sa-btn sm ghost" onclick={() => kick(d)} disabled={!d.online}>{t('断开通道')}</button>
                    <span class="sa-sp"></span>
                    <button class="sa-btn sm" onclick={() => { renameOf = { id: d.id, name: d.name }; }}>{t('改名')}</button>
                    <button class="sa-btn sm dgr" onclick={() => revoke(d)}>{t('吊销')}</button>
                  </div>
                  {#if !d.online}
                    <div class="hint">{t('设备通道离线：桌面客户端没在运行，或那台电脑把档位设成了「关闭」。')}</div>
                  {/if}
                {:else}
                  <div class="acts-row"><span class="sa-sp"></span><button class="sa-btn sm dgr" onclick={() => remove(d)}>{t('删除记录')}</button></div>
                {/if}

                {#if dt.sysinfo}
                  {@const s = dt.sysinfo}
                  <div class="kv sys">
                    <span>{t('主机名')}</span><b>{s.hostname}{s.user ? ' · ' + s.user : ''}</b>
                    <span>{t('系统')}</span><b>{s.os || s.platform} {s.arch}{s.cpus ? ' · ' + t('{n} 核', { n: s.cpus }) : ''}{s.memTotal ? ' · ' + t('内存 {free} / {total} GB 空闲', { free: (s.memFree / 1073741824).toFixed(1), total: (s.memTotal / 1073741824).toFixed(1) }) : ''}</b>
                    {#if s.uptimeSec}<span>{t('开机')}</span><b>{t('{n} 小时', { n: Math.round(s.uptimeSec / 3600) })}</b>{/if}
                    {#if s.home}<span>{t('主目录')}</span><b class="sa-mono">{s.home}</b>{/if}
                    {#if s.terminals != null}<span>{t('终端')}</span><b>{t('{n} 个开着', { n: s.terminals })}</b>{/if}
                  </div>
                {/if}
                {#if dt.shot}
                  <button class="shot" onclick={() => patchDetail(d.id, { shot: null })} title={t('点击收起')}>
                    <img alt={t('远程屏幕')} src={'data:' + (dt.shot.mimeType || 'image/jpeg') + ';base64,' + dt.shot.image} />
                    <span class="sa-mono sa-dim">{dt.shot.fw || dt.shot.w}×{dt.shot.fh || dt.shot.h} · {t('点击收起')}</span>
                  </button>
                {/if}

                <div class="sub-h">{t('最近记录')}</div>
                {#if dt.audit?.length}
                  <div class="ev-list">
                    {#each dt.audit as e, i (i)}
                      <div class="ev {evTone(e)}"><span class="sa-mono sa-dim">{hhmm(e.t)}</span><span>{EV[e.ev] || e.ev}</span><span class="sa-mut sa-trunc">{evDetail(e)}</span></div>
                    {/each}
                  </div>
                {:else}
                  <div class="sa-dim" style="font-size:12.5px;padding:4px 0 2px">{dt.audit ? t('没有记录') : t('读取中…')}</div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <div style="height:8px"></div>
    {/if}
  </div>

  <!-- 记录 -->
  <div class="sa-card" style="margin-top:12px">
    <div class="sa-card-h">{t('设备记录')}<span class="sa-sp"></span>
      <div class="sa-chips">
        {#each [['ops', t('操作')], ['conn', t('上下线')], ['security', t('安全')], ['update', t('更新')], ['', t('全部')]] as [k, l] (k)}
          <button class="sa-chip-btn" class:on={auditKind === k} onclick={() => { auditKind = k; }}>{l}</button>
        {/each}
      </div>
    </div>
    {#if auditErr}<div class="sa-err" style="margin:10px 18px 0">{tr(auditErr)}</div>{/if}
    {#if auditShown.length}
      <div class="ev-list pad">
        {#each auditShown as e, i (i)}
          <div class="ev {evTone(e)}">
            <span class="sa-mono sa-dim">{hhmm(e.t)}</span>
            <span>{EV[e.ev] || e.ev}{e.device ? ' · ' + nameOf(e.device) : ''}</span>
            <span class="sa-mut sa-trunc">{evDetail(e)}</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="sa-empty small">{t('没有记录')}</div>
    {/if}
    <div style="height:8px"></div>
  </div>
{/if}

{#if renameOf}
  <button class="sa-mask" aria-label={t('取消')} onclick={() => { renameOf = null; }}></button>
  <div class="sa-modal">
    <h3>{t('设备改名')}</h3>
    <input class="sa-in" bind:value={renameOf.name} maxlength="60" onkeydown={(e) => e.key === 'Enter' && doRename()} />
    <div class="acts">
      <button class="sa-btn" onclick={() => { renameOf = null; }}>{t('取消')}</button>
      <button class="sa-btn pri" onclick={doRename}>{t('保存')}</button>
    </div>
  </div>
{/if}

<style>
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
  .stats .v.sm { font-size: 19px; display: flex; align-items: center; gap: 8px; min-height: 28px; }
  .stats .x { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sa-chip.sm { width: 22px; height: 22px; border-radius: 6px; }
  .sa-chip.sm :global(svg) { width: 14px; height: 14px; }
  .acts-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 18px 2px; }

  .sa-empty.small { padding: 20px 18px; }
  .sa-in.slim { height: 34px; font-size: 13px; max-width: 280px; }

  /* 设备列表 */
  .dlist { padding: 6px 8px 0; display: flex; flex-direction: column; gap: 2px; }
  .dev { border-radius: 16px; transition: background .18s ease; }
  .dev.open { background: var(--sa-soft); box-shadow: inset 0 0 0 .5px var(--sa-hair); }
  .dev.rev { opacity: .62; }
  .dev-main { width: 100%; display: flex; align-items: center; gap: 12px; padding: 11px 10px; border: 0; background: none; color: inherit;
    font: inherit; text-align: left; cursor: pointer; border-radius: 16px; }
  .dev-main:hover { background: var(--sa-press); }
  .dev-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .dev-name b { font-size: 14.5px; }
  .dev-name small { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dev-badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .dev-when { font-size: 12px; width: 118px; text-align: right; flex: none; }
  .chev { width: 16px; height: 16px; flex: none; color: var(--sa-tx3); transition: transform .2s ease; }
  .dev.open .chev { transform: rotate(90deg); }
  .dev-body { padding: 2px 12px 14px 32px; display: flex; flex-direction: column; gap: 4px; }
  .dev-body .acts-row { padding: 8px 0 2px; }
  .kv { display: grid; grid-template-columns: 76px 1fr; gap: 5px 12px; font-size: 12.5px; padding: 4px 0; }
  .kv span { color: var(--sa-tx3); }
  .kv b { font-weight: 500; color: var(--sa-tx2); min-width: 0; overflow-wrap: anywhere; }
  .kv.sys { margin-top: 6px; padding: 10px 12px; border-radius: 12px; background: var(--sa-soft); }
  .hint { font-size: 12px; line-height: 1.5; color: var(--sa-tx3); padding: 4px 0; }
  .shot { margin-top: 8px; border: 0; padding: 0; background: none; cursor: zoom-out; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .shot img { max-width: 100%; max-height: 420px; border-radius: 12px; box-shadow: inset 0 0 0 .5px var(--sa-hair), 0 6px 20px rgba(0,0,0,.2); }
  .shot span { font-size: 11px; }
  .sub-h { font-size: 12px; font-weight: 650; color: var(--sa-tx3); margin-top: 10px; }

  /* 记录行 */
  .ev-list { display: flex; flex-direction: column; max-height: 360px; overflow-y: auto; }
  .ev-list.pad { padding: 8px 18px 0; }
  .ev { display: grid; grid-template-columns: 76px auto 1fr; gap: 10px; align-items: baseline; font-size: 12.5px; padding: 5px 0;
    border-top: 1px solid var(--sa-sep); }
  .ev:first-child { border-top: 0; }
  .ev.bad > span:nth-child(2) { color: var(--sa-red); }
  .ev.act > span:nth-child(2) { color: var(--sa-tx); font-weight: 600; }

  /* 英文界面：标签/时间/状态列更长，只在 :lang(en) 下放宽，中文外观不变 */
  .ev:lang(en) { grid-template-columns: 112px auto 1fr; }
  .kv:lang(en) { grid-template-columns: 112px 1fr; }
  .dev-when:lang(en) { width: 150px; }

  @media (max-width: 1180px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) {
    .dev-badges, .dev-when { display: none; }
    .dev-body { padding-left: 12px; }
  }
</style>
