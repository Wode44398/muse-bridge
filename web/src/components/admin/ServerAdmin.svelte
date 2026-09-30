<script>
  // 服务端控制台 — 管理员的全功能管理面，设置 → 连接 → 服务端控制台进入。
  // 总览 / 活跃进程 / 用户 / 额度与注册 / 会话续聊 / 定时任务 / Claude 账号 / 服务控制。
  // 数据面 = /api/admin/*（管理员门）。
  // 材质：盖在设置对话框之上，自带一层磨砂罩（深色 tint + blur），其上是亮玻璃 chrome + 素卡片。
  import './admin.css';
  import { ui } from '../../lib/state.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  import { sa, loadOverview, loadLimits, loadActive, loadUsers, loadAccounts, accLabel, liveGens, saToastState, saConfirmState, saConfirmSettle } from '../../lib/serverAdmin.svelte.js';
  import SaOverview from './SaOverview.svelte';
  import SaActive from './SaActive.svelte';
  import SaUsers from './SaUsers.svelte';
  import SaSessions from './SaSessions.svelte';
  import SaRoutines from './SaRoutines.svelte';
  import SaAccounts from './SaAccounts.svelte';
  import SaControl from './SaControl.svelte';
  import SaPolicy from './SaPolicy.svelte';

  let closing = $state(false);
  function close() {
    if (closing) return;
    closing = true;
    setTimeout(() => { ui.serverAdminOpen = false; closing = false; }, 260);
  }
  // 系统返回逐级关：确认弹窗 → 整页
  $effect(() => pushBackLayer(() => {
    if (saConfirmState.open) { saConfirmSettle(false); return; }
    close();
  }));

  // 打开即拉全量一轮；随后 overview 8s、活跃 3.5s（总览/活跃页时）、limits 20s。
  $effect(() => {
    loadOverview(); loadLimits(); loadUsers(); loadAccounts(); loadActive();
    const t1 = setInterval(loadOverview, 8000);
    const t2 = setInterval(() => { if (sa.page === 'overview' || sa.page === 'active') loadActive(); }, 3500);
    const t3 = setInterval(loadLimits, 20000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  });

  // 手动刷新：核心数据 + 页面本地数据（页面 $effect 监听 sa.tick）
  function refresh() {
    loadOverview(); loadLimits();
    if (sa.page === 'active' || sa.page === 'overview') loadActive();
    if (sa.page === 'users') loadUsers();
    if (sa.page === 'accounts') loadAccounts();
    sa.tick = (sa.tick || 0) + 1;
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (saConfirmState.open) { saConfirmSettle(false); return; }
    close();
  }

  // —— 导航（29×29 彩色图标方块 = 设置页同款招牌）——
  const G = {
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 12 17 5.5"/><path d="M12 21h.01"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M13 2.5 4 14h6.2L11 21.5 20 10h-6.2L13 2.5z"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.7M17.8 15.1A5.5 5.5 0 0 1 20.8 20"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.2L4 21l1.9-5A8 8 0 1 1 21 12z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15.5" r="4.5"/><path d="m11.5 12 8-8M16 7.5l2.5 2.5M13.5 10l2 2"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 8h14v4H5z"/><path d="M6.5 12v8.5h11V12"/><path d="M12 8c-1.6-2.8-5-3.4-5-1.2C7 8 9 8 12 8zM12 8c1.6-2.8 5-3.4 5-1.2C17 8 15 8 12 8z"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5a4.9 4.9 0 0 0-6.4 6L3 17.6 6.4 21l5.1-5.1a4.9 4.9 0 0 0 6-6.4l-3 3-2.5-.5-.5-2.5 3-3z"/></svg>',
  };
  const PAGES = $derived([
    { key: 'overview', label: t('总览'), c: '#0a84ff', g: G.gauge },
    { key: 'active', label: t('活跃进程'), c: '#34c759', g: G.bolt },
    { key: 'users', label: sa.multiUser ? tc('admin', '用户') : tc('admin', '服务账号'), c: '#ff9f0a', g: G.people },
    ...(sa.multiUser ? [{ key: 'policy', label: t('额度与注册'), c: '#30b0c7', g: G.gift }] : []),
    { key: 'sessions', label: t('会话 / 续聊'), c: '#64d2ff', g: G.chat },
    { key: 'routines', label: t('定时任务'), c: '#ff453a', g: G.clock },
    { key: 'accounts', label: tc('admin', 'Claude 账号'), c: '#bf5af2', g: G.key },
    // 服务控制：有主机管理脚本时多一套进程 / 自启操作；否则靠守护进程（systemd / docker / pm2）重启
    { key: 'control', label: t('服务控制'), c: '#8e8e93', g: G.wrench },
  ]);
  $effect(() => { if (!PAGES.some((p) => p.key === sa.page)) sa.page = 'overview'; });
  const title = $derived(PAGES.find((p) => p.key === sa.page)?.label || '');
  const liveN = $derived(liveGens(sa.overview?.gens?.length ? sa.overview.gens : sa.gens).length);
  const activeAcct = $derived(sa.accounts.find((a) => a.active));
  const sub = $derived({
    overview: sa.overview?.host?.name || '',
    active: t('{n} 个运行中', { n: liveGens(sa.gens).length }),
    users: t('{n} 个账号', { n: sa.users.length }),
    policy: t('注册开关 · 默认额度 · 全服并发'),
    sessions: t('预览任意用户的对话，可代发续聊'),
    routines: t('各用户的定时触发一览'),
    accounts: activeAcct ? t('当前：{label}', { label: accLabel(activeAcct.label) }) : '',
    control: sa.scriptAvailable ? t('进程 · 开机自启') : sa.supervisor ? t('由 {name} 托管 · 资源 · 日志', { name: sa.supervisor }) : t('资源 · 日志'),
  }[sa.page] || '');
</script>

<svelte:window onkeydown={onKey} />

<div class="sa-root sadm" class:closing>
  <div class="frame">
    <!-- 左侧玻璃导航栏（iPad 设置侧栏式：彩色图标方块 + 选中蓝底） -->
    <aside class="rail">
      <div class="brand">
        <span class="sa-dot" class:ok={sa.ok} class:bad={!sa.ok}></span>
        <span class="brand-tx">{t('服务端控制台')}</span>
      </div>
      <div class="brand-sub sa-mono">{sa.overview?.host?.name || '…'} · :{sa.overview?.phonePort || ''}</div>
      <nav class="nav">
        {#each PAGES as p (p.key)}
          <button class="nitem" class:on={sa.page === p.key} onclick={() => { sa.page = p.key; }}>
            <span class="sa-chip" style="--c:{p.c}">{@html p.g}</span>
            <span class="nlab">{p.label}</span>
            {#if p.key === 'active' && liveN}<span class="npill green">{liveN}</span>{/if}
            {#if p.key === 'users' && sa.users.length}<span class="npill">{sa.users.length}</span>{/if}
            {#if p.key === 'accounts' && activeAcct}<span class="ntag sa-trunc">{accLabel(activeAcct.label)}</span>{/if}
          </button>
        {/each}
      </nav>
      <div class="rail-foot sa-mono">
        {sa.overview?.host?.name || '—'}
      </div>
    </aside>

    <!-- 主区 -->
    <main class="main">
      <header class="top">
        <h1 class="big">{title}</h1>
        {#if sub}<span class="sub">{sub}</span>{/if}
        <div class="sa-sp"></div>
        <button class="sa-cbtn" onclick={refresh} aria-label={t('刷新')} title={t('刷新')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11A8.5 8.5 0 1 0 19 16.2"/><path d="M20.8 5.5V11h-5.5"/></svg>
        </button>
        <button class="sa-cbtn" onclick={close} aria-label={t('关闭控制台')} title={t('关闭')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="body">
        {#if sa.page === 'overview'}<SaOverview />
        {:else if sa.page === 'active'}<SaActive />
        {:else if sa.page === 'users'}<SaUsers />
        {:else if sa.page === 'policy'}<SaPolicy />
        {:else if sa.page === 'sessions'}<SaSessions />
        {:else if sa.page === 'routines'}<SaRoutines />
        {:else if sa.page === 'accounts'}<SaAccounts />
        {:else if sa.page === 'control'}<SaControl />
        {/if}
      </div>
    </main>
  </div>

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
  /* 全屏磨砂罩：下层是不透明的设置对话框，不自带磨砂的话它的文字会透上来跟控制台内容叠在一起 */
  .sadm {
    position: fixed; inset: 0; z-index: 62; display: flex;
    background: rgba(9, 11, 16, .74);
    -webkit-backdrop-filter: blur(26px) saturate(1.12);
    backdrop-filter: blur(26px) saturate(1.12);
    animation: sadm-in var(--mo-base) var(--ea-fade);
    transition: opacity var(--mo-quick) var(--ea-fade);
  }
  @keyframes sadm-in { from { opacity: 0; } }
  .sadm.closing { opacity: 0; pointer-events: none; }

  .frame { flex: 1; display: flex; min-width: 0; padding: max(14px, var(--sat)) 16px max(14px, var(--sab)); gap: 14px; }

  /* —— 左侧玻璃导航 —— */
  .rail {
    width: 224px; flex: none; display: flex; flex-direction: column; border-radius: 26px; padding: 16px 10px 12px;
    background: var(--sa-chrome); box-shadow: var(--sa-chrome-hair);
    animation: rail-in var(--mo-base) var(--ea-decel) backwards;
  }
  @keyframes rail-in { from { opacity: 0; transform: translateX(-14px); } }
  .brand { display: flex; align-items: center; gap: 9px; padding: 2px 10px 1px; }
  .brand-tx { font-size: 15.5px; font-weight: 700; letter-spacing: .2px; }
  .brand-sub { font-size: 10.5px; color: var(--sa-tx3); padding: 3px 10px 12px 26px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .nitem { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 13px; border: 0; background: none;
    color: rgba(255,255,255,.88); font: inherit; font-size: 13.5px; cursor: pointer; text-align: left;
    transition: background var(--mo-micro) var(--ea-fade); min-height: 43px; }
  .nitem:hover { background: rgba(255,255,255,.09); }
  .nitem.on { background: var(--sa-blue); color: #fff; font-weight: 600; box-shadow: inset 0 .5px .5px rgba(255,255,255,.3), 0 4px 14px rgba(10,132,255,.28); }
  .nlab { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .npill { min-width: 19px; height: 19px; padding: 0 5px; border-radius: 10px; background: rgba(255,255,255,.2); color: #fff;
    font-size: 11px; font-weight: 700; font-family: var(--sa-mono); display: flex; align-items: center; justify-content: center; flex: none; }
  .npill.green { background: var(--sa-green); }
  .nitem.on .npill { background: rgba(255,255,255,.28); }
  .ntag { max-width: 64px; font-size: 10.5px; color: rgba(255,255,255,.6); flex: none; }
  .nitem.on .ntag { color: rgba(255,255,255,.85); }
  .rail-foot { margin-top: auto; padding: 10px 10px 2px; font-size: 10.5px; color: var(--sa-tx3); border-top: .5px solid rgba(255,255,255,.1); }

  /* —— 主区 —— */
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .top { flex: none; display: flex; align-items: center; gap: 12px; padding: 4px 4px 12px; }
  .big { font-size: 28px; font-weight: 700; letter-spacing: .2px; color: #fff; }
  .sub { font-size: 12.5px; color: var(--sa-tx3); padding-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 4px 10px; overscroll-behavior: contain; }
  /* 英文 toast 常比中文长一倍多：允许折行、限宽在视口内（中文仍单行不变） */
  .sa-toast:lang(en) { white-space: normal; width: max-content; max-width: calc(100vw - 32px); text-align: center; }

  /* —— 窄屏（竖窗/半屏）：侧栏变顶部横滑条 —— */
  @media (max-width: 880px) {
    .frame { flex-direction: column; gap: 10px; padding: max(12px, var(--sat)) 12px max(12px, var(--sab)); }
    .rail { width: 100%; flex-direction: row; align-items: center; border-radius: 20px; padding: 8px 10px; gap: 4px; }
    .brand, .brand-sub, .rail-foot { display: none; }
    .nav { flex-direction: row; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; flex: 1; }
    .nav::-webkit-scrollbar { display: none; }
    .nitem { flex: none; min-height: 38px; padding: 5px 10px; }
    .ntag { display: none; }
    .big { font-size: 22px; }
  }
</style>
