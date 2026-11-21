<script>
  // 插件应用的全屏分页：上面一条 bridge 自己画的标题栏，下面是插件页面（kind:'page' → PluginFrame 占满）
  // 或声明式应用（kind:'view' → AppView 用 bridge 自己的积木画）。
  // 标题栏插件藏不掉——返回、它是谁、来自哪个插件，使用者永远看得见；插件页面只管内容区。
  // 声明式应用的分页整页换成设置页同一套底色（手机 iOS 27 分组卡 / 桌面壳墨与象牙，令牌见 appview/appview.css），
  // 标题栏跟着同一层底色，不在卡片画布上头压一条别的颜色。
  // App.svelte 按应用键保活最近两个（.keep / dormant），所以这里不在卸载时清什么状态，切回来对话 / 滚动都还在。
  // 转场：pageMorph 用 [data-app-page=<键>] 找这一页的根盒，入口方块长成它、返回时收回入口。
  import { untrack } from 'svelte';
  import { ui, rootScreen } from '../../lib/state.svelte.js';
  import { closePage } from '../../lib/pageMorph.js';
  import { appByKey, parseAppKey, appIconUrl, appContexts } from '../../lib/pluginApps.svelte.js';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import { homeView, setHomeHidden } from '../../lib/homeLayout.svelte.js';
  import { openPluginDetail, canOpenPluginDetail } from '../../lib/extensionsNav.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { openPageGrants } from '../../lib/pageGrantsNav.svelte.js';
  import { reloadView } from '../../lib/appView.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import { t } from '../../lib/i18n.js';
  import PluginFrame from '../ext/PluginFrame.svelte';
  import '../appview/appview.css';

  let { appKey } = $props();

  const app = $derived(appByKey(appKey));
  const pk = $derived(parseAppKey(appKey));
  const kind = $derived(app?.kind || 'page');
  const light = $derived(ui.theme === 'light');
  const iconUrl = $derived(app ? appIconUrl(app, light) : null);
  // 单页模式没有主页：「从主页隐藏」没有意义，菜单里不给
  const hasHome = $derived(rootScreen() === 'home');
  const hidden = $derived(hasHome && homeView().hidden.has(appKey));

  // 刷新：插件页 = 整个 iframe 重挂（插件页自己的状态全丢，等于重新打开）；声明式应用 = 带着现有 state 重拉一次 view
  let gen = $state(0);
  const isView = $derived(kind === 'view');
  const desk = isNativeDesktop();
  // 声明式应用的界面代码按需加载（主包不背积木组件）；首个应用打开时才拉这一块
  const loadAppView = () => import('../appview/AppView.svelte');
  let appViewMod = $state(null);
  // 分块没拉下来（弱网、隧道断了）：不兜的话内容区永远空白、也没法重来，所以给一句说明和「重试」
  let viewLoad = $state('');   // '' | 'loading' | 'failed'
  function fetchAppView() {
    viewLoad = 'loading';
    loadAppView().then((m) => { appViewMod = m.default; viewLoad = ''; }, () => { viewLoad = 'failed'; });
  }
  $effect(() => { if (isView && !appViewMod && untrack(() => viewLoad) === '') fetchAppView(); });

  let menuOpen = $state(false);
  let moreBtn = $state(), menuEl = $state();
  $effect(() => { if (menuOpen) return pushBackLayer(() => (menuOpen = false)); });
  // 键盘用户：菜单一开焦点落到第一项（同账户菜单）
  $effect(() => { if (menuEl) menuEl.querySelector('.ap-mi')?.focus({ preventScroll: true }); });
  const menuItems = $derived([
    { id: 'reload', label: t('刷新'), run: () => (isView ? reloadView(app) : gen++) },
    // 这个应用拿过哪些页面权限（会话 / 文件 / 对话…），去设置里看、能收回
    ...(app?.perms?.length ? [{ id: 'grants', label: t('页面权限'), run: () => openPageGrants() }] : []),
    ...(canOpenPluginDetail() && pk ? [{ id: 'detail', label: t('插件详情'), run: () => openPluginDetail(pk.plugin) }] : []),
    ...(hasHome ? [{ id: 'home', label: hidden ? t('在主页显示') : t('从主页隐藏'), run: () => setHomeHidden(appKey, !hidden) }] : []),
  ]);
  function pick(it) { menuOpen = false; it.run(); }
  function onMenuKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menuOpen = false; moreBtn?.focus(); }
  }

  function back() { menuOpen = false; closePage(appKey); }
</script>

<section class="app-page" class:av={isView} class:av-touch={isView && !desk} class:av-desk={isView && desk}
  class:av-dark={isView && !light} class:av-light={isView && light} data-app-page={appKey}>
  <header class="ap-bar">
    <button class="ap-btn" type="button" onclick={back} aria-label={hasHome ? t('返回主页') : t('返回')}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    {#if app}
      <span class="ap-ic" aria-hidden="true">
        {#if iconUrl}<img src={iconUrl} alt="" draggable="false" />{:else}{@html uiIcon(app.icon?.name)}{/if}
      </span>
      <div class="ap-t">
        <span class="ap-title">{app.title || app.id}</span>
        <span class="ap-from">{t('来自 {name}', { name: app.pluginName || app.plugin })}</span>
      </div>
    {:else}
      <div class="ap-t"></div>
    {/if}
    <button class="ap-btn" type="button" bind:this={moreBtn} aria-label={t('更多操作')} aria-haspopup="menu" aria-expanded={menuOpen}
      onclick={() => (menuOpen = !menuOpen)} disabled={!app}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="15.5" cy="10" r="1.5" fill="currentColor"/></svg>
    </button>
  </header>

  <div class="ap-body">
    {#if app && pk}
      {#if kind === 'page'}
        {#key gen}
          <PluginFrame id={pk.plugin} page={app.page} mode="panel" app={pk.id} context={appContexts[appKey] ?? null} onBack={back} />
        {/key}
      {:else if isView}
        {#if appViewMod}
          {@const AppView = appViewMod}
          <AppView {app} onBack={back} />
        {:else if viewLoad === 'failed'}
          <div class="ap-note ap-fail" role="alert">
            <p>{t('这个应用没能加载')}</p>
            <button class="ap-retry" type="button" onclick={fetchAppView}>{t('重试')}</button>
          </div>
        {/if}
      {:else}
        <!-- 不认识的 kind（更新的服务端给的新形态）：先说清楚，别留一块空白 -->
        <p class="ap-note">{t('这个应用要更新 bridge 之后才能打开')}</p>
      {/if}
    {/if}
  </div>

  {#if menuOpen}
    <button class="ap-menu-bd" type="button" tabindex="-1" aria-label={t('关闭菜单')} onclick={() => (menuOpen = false)}></button>
    <div class="ap-menu" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={onMenuKey}>
      {#each menuItems as it (it.id)}
        <button class="ap-mi" type="button" role="menuitem" onclick={() => pick(it)}>{it.label}</button>
      {/each}
    </div>
  {/if}
</section>

<style>
  /* 整屏、跟随明暗：底色先到位，iframe 还没 hello 时内容区露的就是它（PluginFrame 的 .wait） */
  .app-page {
    position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text); font-family: var(--sans);
  }
  .ap-bar {
    flex: none; display: flex; align-items: center; gap: 8px;
    height: 52px; padding: var(--sat, 0px) 8px 0; box-sizing: content-box;
    border-bottom: 1px solid var(--divider);
  }
  /* 桌面壳（frameless + WCO）：标题栏就是窗口顶带——高度对齐顶带，右侧让出系统窗控按钮；按钮的免拖洞由 app.css 统一打 */
  :global(html[data-wco="1"]) .ap-bar { height: var(--wco-h, 40px); padding-top: 0; padding-right: calc(8px + var(--wco-right, 0px)); }
  .ap-btn {
    flex: none; width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center;
    color: var(--text); background: none; border: 0; padding: 0; cursor: pointer;
    transition: background var(--mo-micro, .14s) var(--ea-fade, ease), transform var(--mo-tap, .09s) var(--ea-out, ease-out);
  }
  .ap-btn:active { background: var(--hover); transform: scale(.94); }
  .ap-btn:disabled { opacity: .35; cursor: default; }
  @media (hover: hover) { .ap-btn:not(:disabled):hover { background: var(--hover); } }
  :global(html[data-wco="1"]) .ap-btn { width: 32px; height: 32px; border-radius: 8px; }
  .ap-ic { flex: none; width: 24px; height: 24px; display: grid; place-items: center; color: var(--text); }
  .ap-ic img { width: 100%; height: 100%; object-fit: contain; }
  .ap-ic :global(svg) { width: 20px; height: 20px; }
  .ap-t { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
  .ap-title { font-size: 15px; line-height: 19px; font-weight: 600; letter-spacing: -.1px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ap-from { font-size: 11.5px; line-height: 14px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  :global(html[data-wco="1"]) .ap-t { flex-direction: row; align-items: baseline; gap: 8px; }

  .ap-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .ap-body > :global(.pf.panel) { flex: 1; height: auto; min-height: 0; }
  /* 声明式应用：整页底色 / 字色 / 字体换成积木令牌（--av-*），标题栏的分隔线用卡片同一档发丝线 */
  .app-page.av { background: var(--av-bg); color: var(--av-ink); }
  .app-page.av .ap-bar { border-bottom-color: var(--av-sep); }
  .app-page.av .ap-btn, .app-page.av .ap-ic { color: var(--av-ink); }
  .app-page.av .ap-btn:active { background: var(--av-press); }
  @media (hover: hover) { .app-page.av .ap-btn:not(:disabled):hover { background: var(--av-hover); } }
  .app-page.av .ap-from { color: var(--av-ink2); }
  .ap-note { margin: auto; padding: 24px; color: var(--muted); font-size: 14px; text-align: center; }
  .app-page.av .ap-note { color: var(--av-ink2); font-size: var(--av-fs-sub); }
  .ap-fail { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  /* 同 AppView 出错页的「重试」 */
  .ap-retry {
    height: var(--av-btn-h, 36px); padding: 0 22px; border: 0; border-radius: var(--av-btn-r, 18px);
    background: var(--av-accent, var(--text)); color: var(--av-on-accent, var(--bg)); font: inherit; font-size: var(--av-btn-fs, 14px); font-weight: 600; cursor: pointer;
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out), opacity var(--av-t, .15s);
  }
  .ap-retry:active { transform: scale(.97); opacity: .86; }
  .ap-retry:focus-visible { outline: none; box-shadow: var(--av-focus); }

  /* ⋯ 菜单：账户菜单同一套令牌（--st-menu 底、描边 + 双层投影、行高 32 / 圆角 8） */
  .ap-menu-bd { position: fixed; inset: 0; z-index: 41; border: 0; padding: 0; background: transparent; cursor: default; }
  .ap-menu {
    position: fixed; z-index: 42; right: 8px; top: calc(var(--sat, 0px) + 50px); min-width: 180px; max-width: calc(100vw - 16px);
    padding: 4px; border-radius: 12px; background: var(--st-menu); box-shadow: var(--st-menu-shadow);
    transform-origin: top right; animation: ap-menu-in var(--mo-quick, .2s) var(--ea-decel, ease-out); outline: none;
  }
  :global(html[data-wco="1"]) .ap-menu { top: calc(var(--wco-h, 40px) + 4px); right: calc(8px + var(--wco-right, 0px)); }
  @keyframes ap-menu-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
  .ap-mi {
    display: flex; align-items: center; width: 100%; height: 32px; padding: 6px 10px; border: 0; border-radius: 8px;
    background: none; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; white-space: nowrap;
  }
  .ap-mi:focus-visible, .ap-mi:active { background: var(--st-hover); outline: none; }
  @media (hover: hover) { .ap-mi:hover { background: var(--st-hover); } }
  @media (pointer: coarse) { .ap-mi { height: 42px; font-size: 15px; } }
</style>
