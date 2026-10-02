<script>
  // 设置（按 claude.ai 设置做的那一版）：
  //   宽屏（≥700）：claude.ai 同款居中对话框——左栏 = 搜索 + 「设置」「自定义」两组导航，右栏 = 当前分区；
  //   手机（<700）：Claude app 同款整页——根页 = 账户卡 + 分组列表，点进分区从右侧推入，左上返回。
  // 分区内容是独立组件（Sec*.svelte），两种外壳共用；样式令牌 --st-* 在 app.css。
  // 入口：侧栏账户卡菜单（设置 / 账户 / 关于）、主页账户胶囊；直达分区走 lib/settingsNav。
  import { ui, me } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { registerCloser } from '../../lib/nav.js';
  import { settingsNav } from '../../lib/settingsNav.svelte.js';
  import { extensionsNav } from '../../lib/extensionsNav.svelte.js';
  import { api } from '../../lib/api.js';
  import { t, tc } from '../../lib/i18n.js';
  import SecGeneral from './SecGeneral.svelte';
  import SecAccount from './SecAccount.svelte';
  import SecConnection from './SecConnection.svelte';
  import SecAbout from './SecAbout.svelte';
  import SecAgents from './SecAgents.svelte';
  import SecAndroid from './SecAndroid.svelte';

  // 扩展中心只对管理员开放：探针过了才出「自定义」那一组
  let extOk = $state(false);
  api.get('/api/extensions').then(() => { extOk = true; }).catch(() => {});
  // 「Agent」分区：同样是 admin 门、可远程；探针过了才出
  let agentsOk = $state(false);
  api.get('/api/agents').then(() => { agentsOk = true; }).catch(() => {});

  // icon = Anthropicons 字形码位；svg = 字体里没挑到合适字形时的线稿（20px 格、1.5 描边，与字形同粗细）
  const SV = (d) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const SECTIONS = $derived([
    { key: 'general', label: t('通用'), icon: '' },
    { key: 'account', label: t('账户'), icon: '' },
    ...(agentsOk ? [{ key: 'agents', label: tc('settings', 'Agent'), svg: SV('<rect x="3" y="3" width="5.5" height="5.5" rx="1.4"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.4"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.4"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.4"/>') }] : []),
    { key: 'connection', label: tc('名词', '连接'), icon: '' },
    { key: 'android', label: t('安卓 app'), svg: SV('<rect x="5.5" y="2.5" width="9" height="15" rx="2"/><path d="M8.75 15h2.5"/>') },
    { key: 'about', label: t('关于'), icon: '' },
  ]);
  const CUSTOM = [
    { type: 'skill', label: t('技能'), icon: '' },
    { type: 'connector', label: t('连接器'), icon: '' },
    { type: 'plugin', label: t('插件'), icon: '' },
  ];
  const titleOf = (k) => SECTIONS.find((s) => s.key === k)?.label || t('设置');

  const compact = $derived(layout.compact);
  function takeNav() { const s = settingsNav.sec; settingsNav.sec = null; return s; }
  let sec = $state(takeNav() || (layout.compact ? null : 'general'));
  let dir = $state(1);             // 手机推入方向：1 = 进分区，-1 = 回根页
  let scrollEl = $state();
  // 开着时外部又点了「直达某分区」（比如菜单里的「关于」）
  $effect(() => { if (settingsNav.sec) go(takeNav()); });
  // 窗口从手机宽度拉宽：宽屏没有「根页」，落到通用
  $effect(() => { if (!compact && !sec) sec = 'general'; });

  function go(k) {
    if (!k) return;
    if (!SECTIONS.some((s) => s.key === k)) k = 'general';
    dir = 1;
    if (k !== sec) { sec = k; if (scrollEl) scrollEl.scrollTop = 0; }
  }
  function toRoot() { dir = -1; sec = null; }
  function openExt(type) { extensionsNav.type = type; ui.extensionsOpen = true; }

  let closing = $state(false);
  function close() {
    if (closing) return;
    closing = true;
    setTimeout(() => { ui.settingsOpen = false; }, 150);
  }
  // 系统返回：手机上先退回根页，再关设置
  function back() { if (compact && sec) { toRoot(); return; } close(); }
  $effect(() => registerCloser('settings', back));
  function onKey(e) {
    if (e.key !== 'Escape' || ui.extensionsOpen || ui.serverAdminOpen) return;
    if (query) { query = ''; return; }
    e.preventDefault();
    close();
  }

  // —— 搜索（宽屏左栏顶部，claude.ai 同款）：扁平索引 → 跳分区 + 命中行闪一下 ——
  let query = $state('');
  const INDEX = [
    { sec: 'general', sid: 'theme', label: t('主题'), keys: t('外观 深色 浅色 暗色 跟随系统 明暗 theme') },
    { sec: 'general', sid: 'lang', label: t('语言'), keys: t('界面语言 中文 英文 English language i18n') },
    { sec: 'general', sid: 'notify', label: t('任务通知'), keys: t('通知 提醒 notification') },
    { sec: 'general', sid: 'suggest', label: t('输入建议'), keys: t('提示词 预测 下一句 Tab 补全 填入') },
    { sec: 'general', sid: 'fullres', label: t('原图加载'), keys: t('图片 画质 流量') },
    { sec: 'account', sid: 'username', label: t('用户名与身份'), keys: t('账户 账号 管理员 头像 account') },
    { sec: 'account', sid: 'usage', label: t('用量'), keys: t('额度 5小时 本周 订阅 quota usage') },
    { sec: 'account', sid: 'workspace', label: t('工作空间'), keys: t('文件 分享 上传') },
    { sec: 'account', sid: 'scan', label: t('扫码登录网页版'), keys: t('扫一扫 二维码'), only: 'touch' },
    { sec: 'account', sid: 'logout', label: t('退出登录'), keys: t('登出 logout') },
    { sec: 'connection', sid: 'addr', label: t('服务器地址'), keys: t('连接 服务器 域名 地址') },
    { sec: 'connection', sid: 'status', label: t('连接状态'), keys: t('在线 离线 网络') },
    { sec: 'connection', sid: 'srvadmin', label: t('服务端控制台'), keys: t('admin 管理 用户 日志') },
    { sec: 'android', sid: 'android-download', label: t('下载安卓 app'), keys: t('安卓 手机 apk 应用 安装 android app 下载') },
    { sec: 'android', sid: 'android-server', label: t('app 的服务器地址'), keys: t('安卓 手机 app 更换 地址 android') },
    { sec: 'about', sid: 'about', label: t('关于'), keys: t('版本 about') },
    { sec: 'agents', sid: 'agent-claude', label: t('Agent 开关'), keys: t('agent claude dimensio 启用 关闭 认证') },
  ];
  const touch = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const hits = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const secs = new Set(SECTIONS.map((s) => s.key));
    return INDEX.filter((e) => secs.has(e.sec) && (!e.only || (e.only === 'touch' && touch))
      && (e.label + ' ' + e.keys + ' ' + titleOf(e.sec)).toLowerCase().includes(q)).slice(0, 12);
  });
  function jump(h) {
    query = '';
    go(h.sec);
    // 等分区渲染完再找行：两帧（{#key} 重建 + 子组件首轮 effect）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = scrollEl?.querySelector(`[data-sid="${h.sid}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('st-flash');
      void el.offsetWidth;
      el.classList.add('st-flash');
    }));
  }
  function onSearchKey(e) { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); jump(hits[0]); } }

  const roleLabel = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' ? t('Pro 用户') : t('普通用户')) : '');
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'admin' : ''));
  const initial = $derived((shownName || '?').trim().charAt(0).toUpperCase());
</script>

<svelte:window onkeydown={onKey} />

{#snippet section(k)}
  {#if k === 'general'}<SecGeneral />
  {:else if k === 'account'}<SecAccount onclose={close} />
  {:else if k === 'connection'}<SecConnection />
  {:else if k === 'about'}<SecAbout />
  {:else if k === 'agents'}<SecAgents />
  {:else if k === 'android'}<SecAndroid />{/if}
{/snippet}
{#snippet icon(s)}{#if s.svg}{@html s.svg}{:else}{s.icon}{/if}{/snippet}

{#if !compact}
  <div class="stg wide" class:closing>
    <button class="bd" aria-label={t('关闭设置')} tabindex="-1" onclick={close}></button>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={t('设置')}>
      <nav class="side">
        <label class="srch">
          <span class="srch-ic" aria-hidden="true">&#xe0d3;</span>
          <input placeholder={t('搜索')} bind:value={query} onkeydown={onSearchKey} spellcheck="false" autocomplete="off" />
        </label>
        <div class="side-scroll">
          {#if query.trim()}
            <div class="grp-l">{t('搜索结果')}</div>
            {#if hits.length}
              <ul class="nav">
                {#each hits as h (h.sec + h.sid)}
                  <li><button class="ni hit" onclick={() => jump(h)}><span class="ni-l">{h.label}</span><span class="ni-s">{titleOf(h.sec)}</span></button></li>
                {/each}
              </ul>
            {:else}
              <p class="none">{t('没有匹配的设置')}</p>
            {/if}
          {:else}
            <div class="grp-l">{t('设置')}</div>
            <ul class="nav">
              {#each SECTIONS as s (s.key)}
                <li><button class="ni" class:on={sec === s.key} aria-current={sec === s.key ? 'page' : undefined} onclick={() => go(s.key)}>
                  <span class="ni-ic" aria-hidden="true">{@render icon(s)}</span><span class="ni-l">{s.label}</span>
                </button></li>
              {/each}
            </ul>
            {#if extOk}
              <div class="grp-l">{tc('settings', '自定义')}</div>
              <ul class="nav">
                {#each CUSTOM as c (c.type)}
                  <li><button class="ni" onclick={() => openExt(c.type)}><span class="ni-ic" aria-hidden="true">{c.icon}</span><span class="ni-l">{c.label}</span></button></li>
                {/each}
              </ul>
            {/if}
          {/if}
        </div>
      </nav>
      <div class="main">
        <div class="main-bar"><button class="x" onclick={close} aria-label={t('关闭')} title={t('关闭 (Esc)')}>&#xe10f;</button></div>
        <div class="main-scroll" bind:this={scrollEl}>
          <div class="main-in">{#key sec}{@render section(sec)}{/key}</div>
        </div>
      </div>
    </div>
  </div>
{:else}
  <div class="stg compact" class:closing>
    {#key sec}
      <div class="pg" style:--dx="{dir * 28}px">
        <header class="bar">
          <button class="bar-b" onclick={sec ? toRoot : close} aria-label={t('返回')}>&#xe029;</button>
          <h1 class="bar-t">{sec ? titleOf(sec) : t('设置')}</h1>
          <span class="bar-sp"></span>
        </header>
        <div class="pg-scroll" bind:this={scrollEl}>
          {#if !sec}
            <button class="acct" onclick={() => go('account')}>
              <span class="av" aria-hidden="true">{me.kind === 'none' ? '?' : initial}</span>
              <span class="acct-tx">
                <b>{me.kind === 'none' ? t('未登录') : shownName}</b>
                <i>{me.kind === 'none' ? t('登录后才能使用对话与工作空间') : roleLabel}</i>
              </span>
              <span class="chev" aria-hidden="true">&#xe02a;</span>
            </button>
            <div class="list">
              {#each SECTIONS.filter((s) => s.key !== 'account') as s (s.key)}
                <button class="li" onclick={() => go(s.key)}>
                  <span class="li-ic" aria-hidden="true">{@render icon(s)}</span><span class="li-l">{s.label}</span>
                  <span class="chev" aria-hidden="true">&#xe02a;</span>
                </button>
              {/each}
            </div>
            {#if extOk}
              <div class="list-h">{tc('settings', '自定义')}</div>
              <div class="list">
                {#each CUSTOM as c (c.type)}
                  <button class="li" onclick={() => openExt(c.type)}>
                    <span class="li-ic" aria-hidden="true">{c.icon}</span><span class="li-l">{c.label}</span>
                    <span class="chev" aria-hidden="true">&#xe02a;</span>
                  </button>
                {/each}
              </div>
            {/if}
          {:else}
            {@render section(sec)}
          {/if}
        </div>
      </div>
    {/key}
  </div>
{/if}

<style>
  /* ============ 宽屏：claude.ai 设置对话框 ============ */
  .stg { position: fixed; inset: 0; z-index: 60; font-family: var(--sans); color: var(--text); }
  .stg.wide { display: flex; align-items: center; justify-content: center; padding: 16px; animation: st-fade .16s var(--ea-fade); }
  .stg.closing { opacity: 0; transition: opacity .15s var(--ea-fade); pointer-events: none; }
  @keyframes st-fade { from { opacity: 0; } }
  .bd { position: absolute; inset: 0; background: var(--st-backdrop); border: 0; cursor: default; }
  .dlg { position: relative; display: flex; width: min(1000px, 100%); height: min(760px, 100%); overflow: hidden;
    border-radius: 12px; background: var(--st-surface);
    box-shadow: 0 0 0 1px var(--st-line), 0 24px 64px rgba(0, 0, 0, .28);
    animation: st-pop .2s var(--ea-decel); }
  @keyframes st-pop { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  .stg.closing .dlg { transform: scale(.985); transition: transform .15s var(--ea-accel); }

  /* 左栏（官方：#fcfcfb 底、右侧 1 物理像素描边、内边距 0 12px 12px、搜索框 32px） */
  .side { flex: none; width: 220px; display: flex; flex-direction: column; min-height: 0;
    background: var(--st-side); border-right: 1px solid var(--st-line); padding: 12px 12px 12px; }
  .srch { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px; border-radius: 8px; flex: none;
    background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); cursor: text; }
  .srch:focus-within { box-shadow: inset 0 0 0 1px var(--st-accent), 0 0 0 3px color-mix(in srgb, var(--st-accent) 22%, transparent); }
  .srch-ic { font-family: var(--icons); font-size: 18px; font-weight: 433; line-height: 1; color: var(--st-muted); }
  .srch input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: none; color: var(--text); font: inherit; font-size: 14px; }
  .srch input::placeholder { color: var(--st-muted); }
  .side-scroll { flex: 1; min-height: 0; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
  .grp-l { font-size: 12px; line-height: 17px; color: var(--st-muted); padding: 16px 8px 6px; }
  .nav { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .ni { width: 100%; height: 32px; display: flex; align-items: center; gap: 10px; padding: 0 8px; border: 0; border-radius: 8px; cursor: pointer;
    background: none; color: var(--st-text2); font: inherit; font-size: 14px; text-align: left; transition: background-color .12s ease, color .12s ease; }
  .ni.on { background: var(--st-sel); color: var(--text); font-weight: 500; }
  @media (hover: hover) { .ni:not(.on):hover { background: var(--st-hover); color: var(--text); } }
  .ni:focus-visible { outline: 2px solid var(--st-accent); outline-offset: -2px; }
  .ni-ic { width: 20px; flex: none; font-family: var(--icons); font-size: 20px; font-weight: 433; line-height: 1; color: var(--st-text2); }
  .ni.on .ni-ic { color: var(--text); }
  .ni-ic :global(svg), .li-ic :global(svg) { display: block; width: 20px; height: 20px; }
  .ni-l { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ni.hit { height: auto; min-height: 32px; padding: 6px 8px; }
  .ni-s { flex: none; font-size: 12px; color: var(--st-muted); }
  .none { font-size: 13px; color: var(--st-muted); padding: 6px 8px; margin: 0; }

  /* 右栏：关闭钮一行 + 滚动内容（官方：内容左右 40px、标题从顶部约 60px 开始） */
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .main-bar { flex: none; height: 52px; display: flex; align-items: center; justify-content: flex-end; padding: 0 12px; }
  .x { width: 32px; height: 32px; border: 0; border-radius: 8px; background: none; cursor: pointer; color: var(--st-text2);
    font-family: var(--icons); font-size: 20px; font-weight: 433; line-height: 1; transition: background-color .12s, color .12s; }
  @media (hover: hover) { .x:hover { background: var(--st-hover); color: var(--text); } }
  .main-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 40px 40px; }
  .main-in { max-width: 760px; margin: 0 auto; animation: st-in .18s var(--ea-decel); }
  @keyframes st-in { from { opacity: 0; transform: translateY(4px); } }
  .side-scroll::-webkit-scrollbar, .main-scroll::-webkit-scrollbar { width: 6px; }
  .side-scroll::-webkit-scrollbar-thumb, .main-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }

  /* ============ 手机：Claude app 式整页 ============ */
  .stg.compact { background: var(--bg); animation: st-slide .26s var(--ea-decel); }
  @keyframes st-slide { from { transform: translateX(36px); opacity: 0; } }
  .stg.compact.closing { transform: translateX(36px); transition: opacity .15s var(--ea-fade), transform .15s var(--ea-accel); }
  .pg { position: absolute; inset: 0; display: flex; flex-direction: column; animation: pg-in .24s var(--ea-decel); }
  @keyframes pg-in { from { transform: translateX(var(--dx, 28px)); opacity: 0; } }
  .bar { flex: none; display: flex; align-items: center; height: calc(52px + var(--sat)); padding: var(--sat) 6px 0; }
  .bar-b { width: 44px; height: 44px; border: 0; border-radius: 12px; background: none; color: var(--text); cursor: pointer;
    font-family: var(--icons); font-size: 22px; font-weight: 433; line-height: 1; }
  .bar-b:active { background: var(--st-hover); }
  .bar-t { flex: 1; min-width: 0; margin: 0; text-align: center; font-size: 17px; font-weight: 600; color: var(--text);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .bar-sp { width: 44px; flex: none; }
  .pg-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
    padding: 8px 16px calc(28px + var(--sab)); }

  .acct { width: 100%; display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin: 0 0 24px; border: 0; border-radius: 14px;
    background: var(--st-surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .acct:active { background: color-mix(in srgb, var(--st-surface) 88%, var(--text)); }
  .av { width: 44px; height: 44px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--avatar-bg); color: var(--text); font-size: 18px; font-weight: 560; }
  .acct-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .acct-tx b { font-size: 17px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .acct-tx i { font-style: normal; font-size: 13px; color: var(--st-muted); }
  .chev { flex: none; font-family: var(--icons); font-size: 16px; line-height: 1; color: var(--st-muted); }

  .list-h { font-size: 13px; font-weight: 500; color: var(--st-muted); margin: 0 4px 8px; }
  .list { display: flex; flex-direction: column; margin: 0 0 26px; padding: 0 16px; border-radius: 14px; background: var(--st-surface); }
  .li { position: relative; display: flex; align-items: center; gap: 14px; min-height: 52px; padding: 0; border: 0; background: none;
    color: var(--text); font: inherit; font-size: 16px; text-align: left; cursor: pointer; }
  .li + .li::before { content: ''; position: absolute; top: 0; left: 34px; right: -16px; height: 1px; background: var(--st-hair); }
  .li:active { opacity: .7; }
  .li-ic { width: 20px; flex: none; font-family: var(--icons); font-size: 20px; font-weight: 433; line-height: 1; color: var(--st-text2); }
  .li-l { flex: 1; min-width: 0; }
</style>
