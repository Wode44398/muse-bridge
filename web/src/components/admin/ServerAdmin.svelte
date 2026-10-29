<script>
  // 服务端控制台 — 服务端的全功能管理面，设置 › 服务端设置进入（本机直连；远程管理开着时手机 / 网页上的管理员也能进）。
  // 旧 debug.html 八页全量收编：总览 / 活跃进程 / 用户 / 会话续聊 / 定时任务 / 媒体 /
  // Claude 账号 / 服务控制（含公网访问）；另有「额度与注册」「设备」两页。数据面 = /api/admin/* 与 /api/devices*。
  //
  // v2「墨与象牙」（与设置页 v5 同一套语言，令牌在 admin.css）：本页不透明、跟 ui.theme 明暗，不开 backdrop。
  // 两种骨架，按 layout 断点单源切换：
  //   · compact（手机）：设置 App 式「根列表 → 推入子页」，顶栏用 ios27 玻璃圆钮，大标题滚上去收成顶栏小标题；
  //   · medium / expanded：左侧中性导航栏（线稿图标、分组、选中＝浅墨底）+ 右侧内容。
  // 每页的滚动容器都是 absolute 撑满、自己 overflow——旧版窄屏把内容区放进 flex 列却没给 min-height:0，
  // 内容把容器撑出屏幕，整页滚不动（2026-10-28 用户报的 bug）。
  import './admin.css';
  import { setContext } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { SI, agentMark } from '../../lib/settingsIcons.js';
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  import { sa, loadOverview, loadLimits, loadActive, loadUsers, loadAccounts, loadDevs, loadPublicAccess, watchPublicAccess, pageVisible, liveGens, supervisedBy, saToastState, saConfirmState, saConfirmSettle } from '../../lib/serverAdmin.svelte.js';
  import GlassButton from '../ios27/GlassButton.svelte';
  import SaOverview from './SaOverview.svelte';
  import SaActive from './SaActive.svelte';
  import SaUsers from './SaUsers.svelte';
  import SaSessions from './SaSessions.svelte';
  import SaRoutines from './SaRoutines.svelte';
  import SaMedia from './SaMedia.svelte';
  import SaAccounts from './SaAccounts.svelte';
  import SaDevices from './SaDevices.svelte';
  import SaControl from './SaControl.svelte';
  import SaPolicy from './SaPolicy.svelte';

  const light = $derived(ui.theme === 'light');
  // ios27 GlassButton 读这份 context 取明暗；ink = 墨色模式（与设置页一致）
  setContext('ios27', { get dark() { return !light; }, ink: true });
  const compact = $derived(layout.compact);

  // —— 开关与导航栈（compact 才有栈：根列表 ↔ 子页）——
  let closing = $state(false);
  let pushed = $state(false);     // 子页在场
  let popping = $state(false);    // 子页正在滑出
  let rootY = $state(0);          // 根页滚动量（顶栏小标题 / 渐隐底）
  let subY = $state(0);
  function close() {
    if (closing) return;
    closing = true;
    setTimeout(() => { ui.serverAdminOpen = false; closing = false; }, compact ? 320 : 220);
  }
  function push(key) { sa.page = key; subY = 0; popping = false; pushed = true; }
  function pop() {
    if (!pushed || popping) return;
    popping = true;
    setTimeout(() => { pushed = false; popping = false; }, 300);
  }
  // 宽屏没有栈：从手机宽度拉宽时把栈收掉，再窄回来从根列表开始
  $effect(() => { if (!compact && pushed) { pushed = false; popping = false; } });
  // 系统返回（安卓 / 浏览器）逐级关：确认弹窗 → 子页 → 整页
  function back() {
    if (saConfirmState.open) { saConfirmSettle(false); return; }
    if (compact && pushed) { pop(); return; }
    close();
  }
  $effect(() => pushBackLayer(back));
  function onKey(e) { if (e.key === 'Escape') back(); }

  // 打开即拉全量一轮；随后 overview 30s、活跃 3.5s（总览/活跃页时）、limits 20s——页面在后台（切走标签 / 最小化）
  // 时一律不拉，回到前台补一轮。overview 在 Windows 主机上要跑 admin.ps1 status（冷起 PowerShell + WMI，3–6 秒），
  // 以前 8 秒一次几乎首尾相接（FR3 / S9）；服务端那头另有单飞 + 30 秒缓存。活跃 agent 有 3.5 秒的 loadActive 盖着。
  // 公网访问的状态变化走总线推（快速隧道换了地址也能马上看到）。
  $effect(() => {
    loadOverview(); loadLimits(); loadUsers(); loadAccounts(); loadActive(); loadDevs(); loadPublicAccess();
    const t1 = setInterval(() => { if (pageVisible()) loadOverview(); }, 30000);
    const t2 = setInterval(() => { if (pageVisible() && (sa.page === 'overview' || sa.page === 'active')) loadActive(); }, 3500);
    const t3 = setInterval(() => { if (pageVisible()) loadLimits(); }, 20000);
    const onVis = () => { if (pageVisible()) { loadOverview(); loadLimits(); } };
    document.addEventListener('visibilitychange', onVis);
    const offBus = watchPublicAccess();
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); document.removeEventListener('visibilitychange', onVis); offBus(); };
  });

  // 手动刷新：核心数据 + 页面本地数据（页面 $effect 监听 sa.tick；设备页自己随 tick 重拉，这里不再重复拉）
  function refresh() {
    loadOverview(); loadLimits(); loadPublicAccess();
    if (sa.page === 'active' || sa.page === 'overview') loadActive();
    if (sa.page === 'users') loadUsers();
    if (sa.page === 'accounts') loadAccounts();
    sa.tick = (sa.tick || 0) + 1;
  }

  // —— 图标：设置页同一套 24 网格 1.6 描边线稿（lib/settingsIcons.js），控制台独有的几枚按同一母题补在这里 ——
  const IC = {
    overview: '<rect x="4" y="4" width="7" height="9" rx="2.2"/><rect x="13" y="4" width="7" height="5" rx="2.2"/><rect x="4" y="15" width="7" height="5" rx="2.2"/><rect x="13" y="11" width="7" height="9" rx="2.2"/>',
    active: '<path d="M3.5 12.5h3.6l2.4-5.5 5 11 2.4-5.5h3.6"/>',
    users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.6 5.6a3.3 3.3 0 0 1 0 5.8"/><path d="M17.6 14.4a5.5 5.5 0 0 1 2.9 5.1"/>',
    policy: SI.policy,
    sessions: '<path d="M7 4.5h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5.2l-4.3 3.3v-3.3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z"/><path d="M8.6 10.5h.01M12 10.5h.01M15.4 10.5h.01" stroke-width="2.2"/>',
    routines: '<circle cx="12" cy="12" r="8"/><path d="M12 7.6V12l3 1.9"/>',
    media: SI.wallpaper,
    accounts: SI.agentapi,
    devices: SI.localpc,
    control: SI.server,
    refresh: SI.refresh,
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    chev: '<path d="M9.5 6l6 6-6 6"/>',
  };
  const svg = (k, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${IC[k] || ''}</svg>`;
  // Claude 账号那一行用 Claude 真标（设置页 agent 行同款：品牌只用真标，不自绘）
  const claudeMark = $derived(ovUrl(agentMark('claude', !light)));

  // 各页远程管理时都能进；会把自己关在门外的按钮（停服务 / 停隧道 / 开机自启）在「服务控制」页里按 sa.remote 藏掉，
  // 服务端那头也会拒（routes/admin.mjs 的 R2）。
  const hasShell = typeof window !== 'undefined' && !!window.BridgeDesktop;
  const LABEL = $derived({
    overview: t('总览'),
    active: t('活跃进程'),
    users: sa.multiUser ? tc('admin', '用户') : tc('admin', '服务账号'),
    policy: t('额度与注册'),
    sessions: t('会话 / 续聊'),
    routines: t('定时任务'),
    media: t('媒体'),
    accounts: tc('admin', 'Claude 账号'),
    // 设备：远程管理也能进（接口走管理员身份，不要求本机直连）
    devices: t('设备'),
    // 服务控制任何形态都有：Windows 主机多一套 admin.ps1（进程 / 隧道 / 自启），Linux / Docker 靠守护进程重启
    control: t('服务控制'),
  });
  const GROUPS = $derived([
    { label: t('状态'), keys: ['overview', 'active'] },
    { label: t('成员'), keys: ['users', ...(sa.multiUser ? ['policy'] : []), 'sessions', 'routines', 'media'] },
    { label: t('资源'), keys: ['accounts', 'devices'] },
    { label: t('服务器'), keys: ['control'] },
  ]);
  const KEYS = $derived(GROUPS.flatMap((g) => g.keys));
  $effect(() => { if (!KEYS.includes(sa.page)) sa.page = 'overview'; });

  const title = $derived(LABEL[sa.page] || '');
  const liveN = $derived(liveGens(sa.overview?.gens?.length ? sa.overview.gens : sa.gens).length);
  const activeAcct = $derived(sa.accounts.find((a) => a.active));
  const devList = $derived((sa.devs?.devices || []).filter((d) => !d.revoked));
  const devOnline = $derived(devList.filter((d) => d.online).length);
  const host = $derived(sa.overview?.host || {});
  const addr = $derived(host.lan?.length ? `${host.lan[0]}:${sa.overview?.phonePort || ''}` : sa.overview?.phonePort ? `:${sa.overview.phonePort}` : '');
  // 行尾的小字（导航栏与手机根列表共用）：只放状态，不放说明（设置页的小字纪律）
  const trail = $derived({
    active: liveN ? String(liveN) : '',
    users: sa.users.length ? String(sa.users.length) : '',
    accounts: activeAcct ? tr(activeAcct.label) : '',
    devices: devList.length ? `${devOnline}/${devList.length}` : '',
  });
  const sub = $derived({
    overview: host.name || '',
    active: t('{n} 个运行中', { n: liveGens(sa.gens).length }),
    users: t('{n} 个账号', { n: sa.users.length }),
    policy: t('注册开关 · 默认额度 · 全服并发'),
    sessions: t('预览任意用户的对话，可代发续聊'),
    routines: t('各用户的定时触发一览'),
    media: t('各用户的生成媒体库'),
    accounts: activeAcct ? t('当前：{label}', { label: tr(activeAcct.label) }) : '',
    devices: sa.devs?.error ? t('读不到设备表') : sa.devs ? t('{a} 台设备 · {b} 台在线', { a: devList.length, b: devOnline }) : '',
    control: sa.scriptAvailable ? t('进程 · 隧道 · 开机自启') : hasShell ? t('由桌面壳托管运行时') : sa.supervisor ? t('{by} · 资源 · 日志', { by: supervisedBy(sa.supervisor) }) : t('资源 · 日志'),
  }[sa.page] || '');
</script>

<svelte:window onkeydown={onKey} />

{#snippet icon(k)}
  {#if k === 'accounts' && claudeMark}<img src={claudeMark} alt="" draggable="false" />{:else}{@html svg(k)}{/if}
{/snippet}

{#snippet pageBody()}
  {#if sa.page === 'overview'}<SaOverview />
  {:else if sa.page === 'active'}<SaActive />
  {:else if sa.page === 'users'}<SaUsers />
  {:else if sa.page === 'policy'}<SaPolicy />
  {:else if sa.page === 'sessions'}<SaSessions />
  {:else if sa.page === 'routines'}<SaRoutines />
  {:else if sa.page === 'media'}<SaMedia />
  {:else if sa.page === 'accounts'}<SaAccounts />
  {:else if sa.page === 'devices'}<SaDevices />
  {:else if sa.page === 'control'}<SaControl />
  {/if}
{/snippet}

{#snippet refreshBtn()}
  <GlassButton round aria={t('刷新')} onclick={refresh}><span class="gico">{@html svg('refresh', 1.9)}</span></GlassButton>
{/snippet}

<div class="sa-root sadm" class:light class:compact class:closing>
  {#if compact}
    <!-- 手机：根列表 —— 这台服务器的状态卡 + 分组导航 -->
    <section class="pg" class:under={pushed && !popping} inert={pushed}>
      <div class="pg-scroll" onscroll={(e) => (rootY = e.currentTarget.scrollTop)}>
        <h1 class="lt">{t('服务端控制台')}</h1>
        <div class="pg-body">
          <div class="sa-card hostcard">
            <div class="host-h">
              <span class="sa-chip">{@html svg('control')}</span>
              <span class="host-tx">
                <b class="sa-trunc">{host.name || '…'}</b>
                {#if addr}<small class="sa-mono sa-trunc">{addr}</small>{/if}
              </span>
              {#if sa.ok}<span class="sa-badge green">{t('在线')}</span>{:else}<span class="sa-badge red">{t('连不上')}</span>{/if}
            </div>
            <div class="host-stats">
              <button type="button" class="hs" onclick={() => push('active')}><b>{liveN}</b><small>{t('活跃 Agent')}</small></button>
              <button type="button" class="hs" onclick={() => push('users')}><b>{sa.users.length}</b><small>{tc('admin', '用户')}</small></button>
              <button type="button" class="hs" onclick={() => push('devices')}><b>{devOnline}</b><small>{t('设备在线')}</small></button>
            </div>
          </div>
          {#each GROUPS as g (g.label)}
            <h2 class="ghead">{g.label}</h2>
            <div class="sa-card navcard">
              {#each g.keys as k (k)}
                <button type="button" class="nrow" onclick={() => push(k)}>
                  <span class="sa-chip">{@render icon(k)}</span>
                  <span class="nrow-main">
                    <span class="nrow-tx">{LABEL[k]}</span>
                    {#if trail[k]}<span class="nrow-d sa-trunc">{trail[k]}</span>{/if}
                    <span class="chev" aria-hidden="true">{@html svg('chev', 2)}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/each}
        </div>
      </div>
      <div class="fade" class:on={rootY > 2}></div>
      <div class="bar">
        <GlassButton symbol="chevron.backward" weight={600} aria={t('关闭控制台')} onclick={close} />
        <span class="bar-title" class:on={rootY > 40}>{t('服务端控制台')}</span>
        {@render refreshBtn()}
      </div>
    </section>

    {#if pushed}
      <!-- 手机：子页（从右推入；系统返回 / 左上返回先回根列表） -->
      <section class="pg sub" class:out={popping}>
        <div class="pg-scroll" onscroll={(e) => (subY = e.currentTarget.scrollTop)}>
          <h1 class="lt">{title}</h1>
          {#if sub}<p class="lsub sa-trunc">{sub}</p>{/if}
          <div class="pg-body">{@render pageBody()}</div>
        </div>
        <div class="fade" class:on={subY > 2}></div>
        <div class="bar">
          <GlassButton symbol="chevron.backward" weight={600} aria={t('返回')} onclick={pop} />
          <span class="bar-title" class:on={subY > 40}>{title}</span>
          {@render refreshBtn()}
        </div>
      </section>
    {/if}
  {:else}
    <div class="frame">
      <!-- 宽屏：左侧导航栏 -->
      <aside class="rail">
        <div class="rail-h">
          <span class="sa-chip">{@html svg('control')}</span>
          <span class="rail-id">
            <b>{t('服务端控制台')}</b>
            <small class="sa-trunc"><span class="sa-dot" class:ok={sa.ok} class:bad={!sa.ok}></span>{host.name || '…'}</small>
          </span>
        </div>
        <nav class="nav">
          {#each GROUPS as g (g.label)}
            <div class="ngh">{g.label}</div>
            {#each g.keys as k (k)}
              <button type="button" class="nitem" class:on={sa.page === k} onclick={() => { sa.page = k; }} aria-current={sa.page === k ? 'page' : undefined}>
                <span class="nic">{@render icon(k)}</span>
                <span class="nlab">{LABEL[k]}</span>
                {#if trail[k]}<span class="ntrail sa-trunc">{trail[k]}</span>{/if}
              </button>
            {/each}
          {/each}
        </nav>
        {#if addr}<div class="rail-foot sa-mono sa-trunc">{addr}</div>{/if}
      </aside>

      <main class="main">
        <header class="top">
          <div class="ttl">
            <h1 class="big">{title}</h1>
            {#if sub}<span class="tsub sa-trunc">{sub}</span>{/if}
          </div>
          <button class="sa-cbtn" onclick={refresh} aria-label={t('刷新')} title={t('刷新')}>{@html svg('refresh', 1.8)}</button>
          <button class="sa-cbtn" onclick={close} aria-label={t('关闭控制台')} title={t('关闭')}>{@html svg('close', 1.8)}</button>
        </header>
        <div class="body" class:fill={sa.page === 'sessions'}>
          <div class="body-in">{@render pageBody()}</div>
        </div>
      </main>
    </div>
  {/if}

  <!-- 全局确认弹窗 -->
  {#if saConfirmState.open}
    <button class="sa-mask" aria-label={t('取消')} onclick={() => saConfirmSettle(false)}></button>
    <div class="sa-modal">
      <h3>{saConfirmState.title}</h3>
      {#if saConfirmState.desc}<p>{saConfirmState.desc}</p>{/if}
      <div class="acts">
        <button class="sa-btn" onclick={() => saConfirmSettle(false)}>{t('取消')}</button>
        <button class="sa-btn {saConfirmState.danger ? 'dgr' : 'pri'}" onclick={() => saConfirmSettle(true)}>{saConfirmState.yes}</button>
      </div>
    </div>
  {/if}

  <!-- toast（调用方可能直接塞服务端报错原文，显示处再过一道 tr()） -->
  <div class="sa-toast" class:on={saToastState.on} class:err={saToastState.err}>{tr(saToastState.msg)}</div>
</div>

<style>
  /* 不透明整页：手机从右推入（盖在设置页之上，像设置里又推了一层），宽屏淡入 */
  .sadm {
    position: fixed; inset: 0; z-index: 62; display: flex; overflow: hidden;
    background: var(--sa-bg);
    animation: sadm-in 240ms var(--ea-fade, ease);
    transition: opacity 200ms var(--ea-fade, ease), transform 320ms cubic-bezier(.3, 0, .8, .15), background-color 240ms ease;
  }
  @keyframes sadm-in { from { opacity: 0; transform: scale(.985); } }
  .sadm.closing { opacity: 0; pointer-events: none; }
  .sadm.compact { animation: sadm-push 480ms cubic-bezier(.2, .95, .25, 1); box-shadow: -1px 0 0 var(--sa-hair), -12px 0 32px rgba(0, 0, 0, .12); }
  @keyframes sadm-push { from { transform: translateX(100%); } }
  .sadm.compact.closing { opacity: 1; transform: translateX(100%); }

  /* ── 手机：页面栈 ── */
  .pg { position: absolute; inset: 0; background: var(--sa-bg); will-change: transform;
    transition: transform 460ms cubic-bezier(.2, .95, .25, 1); }
  .pg::after { content: ''; position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; transition: opacity 460ms ease; }
  .pg.under { transform: translateX(-26%); }
  .pg.under::after { opacity: .1; }
  .pg.sub { box-shadow: -1px 0 0 var(--sa-hair), -12px 0 32px rgba(0, 0, 0, .1); animation: pg-in 460ms cubic-bezier(.2, .95, .25, 1); }
  .pg.sub.out { animation: pg-out 300ms cubic-bezier(.3, 0, .8, .15) forwards; }
  @keyframes pg-in { from { transform: translateX(100%); } }
  @keyframes pg-out { to { transform: translateX(100%); } }
  .pg-scroll { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
    scrollbar-width: none; padding: calc(var(--sat, 0px) + 54px) 0 calc(max(16px, var(--sab, 0px)) + 32px); }
  .pg-scroll::-webkit-scrollbar { width: 0; }
  /* 大标题：30/38 Semibold（设置页 .lt 同款），左边与卡内正文对齐 */
  .lt { margin: 0; padding: 4px 32px 6px; font-size: 30px; line-height: 38px; font-weight: 600; letter-spacing: -.2px; color: var(--sa-tx); }
  .lsub { margin: -2px 0 0; padding: 0 32px; font-size: 13.5px; line-height: 19px; color: var(--sa-tx2); }
  .pg-body { padding: 16px 16px 0; }

  /* 顶栏：44 高控件行，滚上去后居中出现小标题；底下一层纯色渐隐（不用 backdrop，免得和弹层叠两层） */
  .bar { position: absolute; left: 0; right: 0; top: var(--sat, 0px); height: 44px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; pointer-events: none; z-index: 2; }
  .bar > :global(*) { pointer-events: auto; }
  .bar-title { position: absolute; left: 76px; right: 76px; text-align: center; font-size: 16px; line-height: 22px; font-weight: 600; letter-spacing: -.1px; color: var(--sa-tx);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; transform: translateY(4px); transition: opacity 180ms linear, transform 220ms ease; pointer-events: none; }
  .bar-title.on { opacity: 1; transform: none; }
  .fade { position: absolute; left: 0; right: 0; top: 0; height: calc(var(--sat, 0px) + 64px); pointer-events: none; z-index: 1; opacity: 0; transition: opacity 200ms linear;
    background: linear-gradient(to bottom, var(--sa-bg) 0%, var(--sa-bg) 55%, color-mix(in srgb, var(--sa-bg) 0%, transparent) 100%); }
  .fade.on { opacity: 1; }
  .gico { display: flex; }
  .gico :global(svg) { width: 19px; height: 19px; }

  /* 根列表：服务器状态卡 */
  .hostcard { margin-bottom: 26px; }
  .host-h { display: flex; align-items: center; gap: 12px; padding: 14px 16px 12px; }
  .host-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .host-tx b { font-size: 16px; line-height: 22px; font-weight: 600; }
  .host-tx small { font-size: 12.5px; color: var(--sa-tx2); }
  .host-stats { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--sa-sep); }
  .hs { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 12px 16px 14px; border: 0; background: none; color: inherit; font: inherit;
    text-align: left; cursor: pointer; transition: background-color 260ms ease; -webkit-tap-highlight-color: transparent; }
  .hs + .hs { border-left: 1px solid var(--sa-sep); }
  .hs:active { background: var(--sa-press); transition-duration: 60ms; }
  .hs b { font-size: 22px; line-height: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .hs small { font-size: 12px; color: var(--sa-tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  /* 分组标题 + 导航行（设置页 .ghead / .r 同尺寸：50 高、左右 16、分隔线从正文起） */
  .ghead { margin: 0; padding: 0 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .2px; color: var(--sa-tx2); }
  .navcard { margin-bottom: 26px; overflow: hidden; }
  .nrow { position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 50px; padding: 0 16px; border: 0; background: none;
    font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color 260ms ease; }
  .nrow:active { background: var(--sa-press); transition-duration: 60ms; }
  .nrow-main { position: relative; flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 8px; min-height: 50px; }
  .nrow + .nrow .nrow-main::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--sa-sep); }
  .nrow-tx { flex: 1; min-width: 0; font-size: 16px; line-height: 22px; letter-spacing: -.1px; }
  .nrow-d { flex: none; max-width: 46%; font-size: 15px; color: var(--sa-tx2); font-variant-numeric: tabular-nums; }
  .chev { flex: none; display: flex; color: var(--sa-tx3); }
  .chev :global(svg) { width: 15px; height: 15px; }

  /* ── 宽屏：导航栏 + 内容 ── */
  .frame { flex: 1; display: flex; min-width: 0; min-height: 0; }
  .rail { width: 252px; flex: none; display: flex; flex-direction: column; min-height: 0;
    padding: max(18px, var(--sat, 0px)) 12px max(14px, var(--sab, 0px)); border-right: 1px solid var(--sa-sep); }
  .rail-h { display: flex; align-items: center; gap: 11px; padding: 6px 8px 16px; }
  .rail-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rail-id b { font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.1px; }
  .rail-id small { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sa-tx2); }
  .rail-id .sa-dot { width: 6px; height: 6px; }
  .nav { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; scrollbar-width: thin; }
  .ngh { padding: 14px 10px 6px; font-size: 12px; font-weight: 500; letter-spacing: .2px; color: var(--sa-tx3); }
  .ngh:first-child { padding-top: 2px; }
  .nitem { display: flex; align-items: center; gap: 11px; min-height: 38px; padding: 0 10px; border-radius: 10px; border: 0; background: none;
    color: var(--sa-tx2); font: inherit; font-size: 14px; cursor: pointer; text-align: left; transition: background-color 140ms ease, color 140ms ease; }
  .nitem:hover { background: var(--sa-press); color: var(--sa-tx); }
  .nitem.on { background: var(--sa-sel); color: var(--sa-tx); font-weight: 600; }
  .nic { width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; }
  .nic :global(svg) { width: 19px; height: 19px; }
  .nic :global(img) { width: 17px; height: 17px; object-fit: contain; }
  .nlab { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ntrail { flex: none; max-width: 76px; font-size: 12.5px; font-weight: 500; color: var(--sa-tx3); font-variant-numeric: tabular-nums; }
  .rail-foot { padding: 12px 10px 2px; font-size: 11.5px; color: var(--sa-tx3); border-top: 1px solid var(--sa-sep); margin-top: 8px; }

  .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .top { flex: none; display: flex; align-items: center; gap: 10px; width: 100%; max-width: 1180px; margin: 0 auto;
    padding: max(18px, var(--sat, 0px)) 28px 14px; }
  .ttl { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 12px; }
  .big { margin: 0; font-size: 26px; line-height: 34px; font-weight: 600; letter-spacing: -.2px; color: var(--sa-tx); white-space: nowrap; }
  .tsub { font-size: 13px; color: var(--sa-tx2); }
  .body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 28px max(28px, var(--sab, 0px)); }
  .body-in { max-width: 1124px; margin: 0 auto; }
  /* 会话页三栏各自滚动：内容区要有确定高度 */
  .body.fill .body-in { height: 100%; }

  /* 折叠屏展开 / 小平板：导航栏收窄 */
  @media (max-width: 1099px) {
    .rail { width: 212px; padding-left: 10px; padding-right: 10px; }
    .top { padding-left: 22px; padding-right: 22px; }
    .body { padding-left: 22px; padding-right: 22px; }
    .ttl { flex-direction: column; align-items: flex-start; gap: 0; }
    .big { font-size: 24px; line-height: 30px; }
  }
  /* 英文 toast 常比中文长一倍多：允许折行、限宽在视口内（中文仍单行不变） */
  .sa-toast:lang(en) { white-space: normal; width: max-content; max-width: calc(100vw - 32px); text-align: center; }
</style>
