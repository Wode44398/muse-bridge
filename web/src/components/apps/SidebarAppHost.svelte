<script>
  // Claude 侧栏「应用」组里点开的插件应用（ctx.ui.app 声明了 pin: 'sidebar' 的）。
  // 形态照定时任务（RoutinesPage）：侧栏常驻（电脑）时 embedded，铺在 Claude 正文区、侧栏照旧可点；手机是全屏页。
  // 上面一条 bridge 自己画的标题栏（图标、名字、来自哪个插件、关闭），插件藏不掉；下面是内容：
  //   · 页面型 → PluginFrame（不透明源 iframe），上下文给当前 Claude 会话（同工作台标签，SDK 的 bridge.context()）；
  //   · 声明式 → AppView。手机 App 里的页面型不会走到这里——ClaudePage 直接 openApp 交给原生干净页。
  // 开关、互斥、切会话收起都归 ClaudePage 管；这里只负责画，以及挂一层「返回」。
  import { untrack } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { preview } from '../../lib/preview.svelte.js';
  import { appByKey, parseAppKey, appIconUrl } from '../../lib/pluginApps.svelte.js';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import { dockContext } from '../../lib/dock.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { t } from '../../lib/i18n.js';
  import PluginFrame from '../ext/PluginFrame.svelte';

  let { appKey, embedded = false, onClose } = $props();

  // 声明式渲染器连同全部积木体量不小，按需加载：静态引入会把它拖进主包，所有页面的首屏都得多下这一块
  let AppViewC = $state(null);

  const app = $derived(appByKey(appKey));
  const pk = $derived(parseAppKey(appKey));
  const kind = $derived(app?.kind || 'page');
  const iconUrl = $derived(app ? appIconUrl(app, ui.theme === 'light') : null);
  // 当前会话 / 工作目录；读的是响应式状态，切了工作目录 PluginFrame 会推 context 给页面（切会话整层就收了）
  const ctx = $derived(dockContext());
  // 图标图片加载失败（插件删了图 / 地址失效）退回内置字形，别留一个破图
  let iconBad = $state(false);
  $effect(() => { iconUrl; iconBad = false; });
  // 分块没拉下来（弱网、隧道断了）：不兜的话侧栏内容区永远空白、也没法重来，所以给一句说明和「重试」
  let viewLoad = $state('');   // '' | 'loading' | 'failed'
  function fetchAppView() {
    viewLoad = 'loading';
    import('../appview/AppView.svelte').then((m) => { AppViewC = m.default; viewLoad = ''; }, () => { viewLoad = 'failed'; });
  }
  $effect(() => { if (kind === 'view' && !AppViewC && untrack(() => viewLoad) === '') fetchAppView(); });

  // 手机系统返回 / 左缘右滑先关这一层（ClaudePage 的左缘右滑守卫也认它，不会把整页划走）。
  // 只在它确实是最上层时挂：Claude 页是保活的，人走到别的分页、或上面盖了设置 / 登录 / 文件预览时，
  // 瞬态层栈排在这些之前，挂着就会让返回先去关这个看不见的应用（设置关不掉、回主页那一下被吞、跳走再回来应用已经没了）
  $effect(() => {
    if (ui.screen === 'claude' && !ui.settingsOpen && !ui.loginOpen && !preview.open) return pushBackLayer(() => onClose?.());
  });
</script>

<section class="sah" class:embedded data-sidebar-app={appKey}>
  <header class="sah-bar">
    {#if !embedded}
      <button class="sah-btn" type="button" onclick={() => onClose?.()} aria-label={t('返回')}>
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    {/if}
    {#if app}
      <span class="sah-ic" aria-hidden="true">
        {#if iconUrl && !iconBad}<img src={iconUrl} alt="" draggable="false" onerror={() => (iconBad = true)} />{:else}{@html uiIcon(app.icon?.name)}{/if}
      </span>
      <div class="sah-t">
        <span class="sah-title">{app.title || app.id}</span>
        <span class="sah-from">{t('来自 {name}', { name: app.pluginName || app.plugin })}</span>
      </div>
    {:else}
      <div class="sah-t"></div>
    {/if}
    {#if embedded}
      <button class="sah-btn" type="button" onclick={() => onClose?.()} aria-label={t('关闭')} title={t('关闭')}>
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    {/if}
  </header>

  <div class="sah-body">
    {#if !app || !pk}
      <!-- 插件被关了 / 撤了固定：说清楚，别留一块空白 -->
      <p class="sah-note">{t('这个应用已经不可用了')}</p>
    {:else if kind === 'page'}
      {#key appKey}
        <PluginFrame id={pk.plugin} page={app.page} mode="panel" app={pk.id} context={ctx} onBack={() => onClose?.()} />
      {/key}
    {:else if AppViewC}
      <!-- 动作回 nav:'back' 时关掉这一层：AppView 自己只认 ui.screen 等于应用键才关分页，侧栏里 ui.screen 是 claude -->
      {#key appKey}<AppViewC {app} embedded onBack={() => onClose?.()} />{/key}
    {:else if kind === 'view' && viewLoad === 'failed'}
      <div class="sah-note sah-fail" role="alert">
        <p>{t('这个应用没能加载')}</p>
        <button class="sah-retry" type="button" onclick={fetchAppView}>{t('重试')}</button>
      </div>
    {/if}
  </div>
</section>

<style>
  /* 手机：盖住整页（同 RoutinesPage 的全屏页）；电脑侧栏常驻：只铺正文区（ClaudePage 的 .panes 里 absolute） */
  .sah {
    position: fixed; inset: 0; z-index: 80; display: flex; flex-direction: column;
    background: var(--bg); color: var(--text); font-family: var(--sans);
  }
  .sah.embedded { position: absolute; z-index: 40; }
  .sah-bar {
    flex: none; display: flex; align-items: center; gap: 8px;
    height: 52px; padding: var(--sat, 0px) 8px 0 12px; box-sizing: content-box;
    border-bottom: 1px solid var(--divider);
  }
  .sah:not(.embedded) .sah-bar { padding-left: 8px; }
  .sah.embedded .sah-bar { padding-top: 0; }
  /* 桌面壳（frameless + WCO）：标题栏贴着窗口顶带，右侧让出系统窗控按钮 */
  :global(html[data-wco="1"]) .sah-bar { height: var(--wco-h, 40px); padding-top: 0; padding-right: calc(8px + var(--wco-right, 0px)); }
  .sah-btn {
    flex: none; width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center;
    color: var(--text); background: none; border: 0; padding: 0; cursor: pointer;
    transition: background var(--mo-micro, .14s) var(--ea-fade, ease), transform var(--mo-tap, .09s) var(--ea-out, ease-out);
  }
  .sah-btn:active { background: var(--hover); transform: scale(.94); }
  @media (hover: hover) { .sah-btn:hover { background: var(--hover); } }
  :global(html[data-wco="1"]) .sah-btn { width: 32px; height: 32px; border-radius: 8px; }
  .sah-ic { flex: none; width: 22px; height: 22px; display: grid; place-items: center; color: var(--text); }
  .sah-ic img { width: 100%; height: 100%; object-fit: contain; border-radius: 5px; }
  .sah-ic :global(svg) { width: 18px; height: 18px; }
  .sah-t { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
  .sah-title { font-size: 14.5px; line-height: 18px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sah-from { font-size: 11.5px; line-height: 14px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sah-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  .sah-body > :global(*) { flex: 1; min-height: 0; }
  .sah-note { flex: none !important; margin: 48px auto; max-width: 320px; text-align: center; color: var(--muted); font-size: 14px; line-height: 1.6; }
  .sah-fail { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .sah-fail p { margin: 0; }
  /* 同应用分页里的「重试」 */
  .sah-retry {
    height: var(--av-btn-h, 36px); padding: 0 22px; border: 0; border-radius: var(--av-btn-r, 18px);
    background: var(--av-accent, var(--text)); color: var(--av-on-accent, var(--bg)); font: inherit; font-size: var(--av-btn-fs, 14px); font-weight: 600; cursor: pointer;
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out), opacity var(--av-t, .15s);
  }
  .sah-retry:active { transform: scale(.97); opacity: .86; }
  .sah-retry:focus-visible { outline: none; box-shadow: var(--av-focus); }
</style>
