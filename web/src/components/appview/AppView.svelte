<script>
  // 声明式应用的画布：插件只回积木 JSON，这里用 bridge 自己的组件一块块画。
  // 两处用：应用全屏分页（PluginAppPage，kind:'view'）与 Claude 侧栏应用（SidebarAppHost）。
  //   props：app = /api/plugins/ui 的 apps 项；onBack = 插件动作回 nav:'back' 时怎么退（不给就关应用分页）；
  //          embedded = 嵌在别处（侧栏），底色跟宿主走、四周留白收窄。
  // 数据（state / tree / 防连点 / 推送重拉）全在 lib/appView.svelte.js，这里只管画：首屏转圈、出错页、空树、积木列表。
  // 形态：桌面壳 = 桌面设置页的「墨与象牙」扁平卡；手机 / 网页 = 设置页的 iOS 27 分组卡（令牌见 appview.css）。
  import './appview.css';
  import { setContext, untrack } from 'svelte';
  import { me, ui } from '../../lib/state.svelte.js';
  import { appViews, mountAppView, touchAppView, loadView, makeCtx, viewOnScreen } from '../../lib/appView.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import { t } from '../../lib/i18n.js';
  import Block from './Block.svelte';

  let { app, onBack = null, embedded = false } = $props();

  const desk = isNativeDesktop();
  const dark = $derived(ui.theme !== 'light');
  // ios27 套件（Toggle / Segmented）读这个上下文：墨色模式、跟随明暗
  setContext('ios27', { get dark() { return dark; }, ink: true });

  const key = $derived(app ? app.key || 'app:' + app.plugin + ':' + app.id : '');
  const owner = $derived(me.kind && me.kind !== 'none' ? me.kind + ':' + (me.user || '') : '');
  // 换了身份的那一份不算（数据层下次读写时会整份作废，这里先别把上一个人的界面画出来）
  const view = $derived.by(() => { const v = key ? appViews[key] : null; return v && v.owner === owner ? v : null; });
  const tree = $derived(view?.tree || null);
  // 树里只有一块 empty（插件出错时服务端回的就是这种，或者插件自己的空状态）：整屏居中画，不要贴在顶上
  const solo = $derived(!!tree && tree.length === 1 && tree[0]?.type === 'empty');

  // 挂载 = 登记 + 拉一次 view（带着上次的 state）；换了应用 / 换了身份重来一遍
  $effect(() => {
    if (!key) return;
    owner;
    return untrack(() => mountAppView(app));
  });
  // 应用项换了新的一份（pluginUi 重拉过，插件可能 reload 了）：数据层换上新的那份并重拉
  $effect(() => { const a = app; untrack(() => a && touchAppView(a)); });

  let root = $state(null);
  const ctx = makeCtx(() => app, { getOnBack: () => onBack, isFront: () => viewOnScreen(root) });

  function retry() { if (app) loadView(app); }
</script>

<div bind:this={root} class="av {desk ? 'av-desk' : 'av-touch'}" class:av-dark={dark} class:av-light={!dark} class:embedded data-app-view={key}>
  <div class="av-scroll">
    <div class="av-col" class:solo>
      {#if !app}
        <!-- 应用没了（插件被停用 / 卸载）：PluginAppPage 自己会说，这里留空 -->
      {:else if !tree && view?.error && !view.loading}
        <div class="av-state" role="alert">
          <span class="av-state-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 8v5m0 3.2v.3M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20.3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <p class="av-state-t">{t('应用没能打开')}</p>
          <p class="av-state-d">{view.error}</p>
          <button class="av-retry" type="button" onclick={retry}>{t('重试')}</button>
        </div>
      {:else if !tree}
        <div class="av-state" aria-busy="true">
          <span class="av-spin av-load" aria-hidden="true"></span>
          <p class="av-state-d">{t('正在打开…')}</p>
        </div>
      {:else if !tree.length}
        <div class="av-state">
          <span class="av-state-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 13.5 6.4 6a2 2 0 0 1 1.9-1.4h7.4A2 2 0 0 1 17.6 6l2.4 7.5M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5M4 13.5h4.2l1.3 2.2h5l1.3-2.2H20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <p class="av-state-t">{t('这个应用暂时没有内容')}</p>
        </div>
      {:else}
        {#each tree as block, i (i)}
          <Block {block} {ctx} />
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .av {
    position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column;
    background: var(--av-bg); color: var(--av-ink); font-family: var(--av-font);
    -webkit-font-smoothing: antialiased;
  }
  /* 嵌在侧栏里：底色跟宿主走（侧栏自己有底），卡片照旧 */
  .av.embedded { background: transparent; }
  .av-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  /* 内容列：手机贴设置页（左右 16、组间 22）；宽屏居中限宽，表格再宽就在自己的卡里横滚 */
  .av-col {
    display: flex; flex-direction: column; gap: var(--av-gap);
    max-width: 720px; margin: 0 auto; min-height: 100%;
    padding: 18px 16px calc(40px + var(--sab, 0px));
  }
  .av-desk .av-col { padding: var(--dsk-s5, 20px) var(--dsk-s7, 32px) 64px; }
  .av.embedded .av-col { padding: 12px 12px 24px; }
  .av-col.solo { justify-content: center; padding-bottom: calc(80px + var(--sab, 0px)); }

  /* 首屏转圈 / 出错 / 空树：居中一组（图标方块 + 标题 + 说明 + 按钮），字号同设置页 */
  .av-state {
    margin: auto 0; padding: 48px 24px 64px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px;
  }
  .av-state-ic {
    width: 52px; height: 52px; border-radius: 15px; display: grid; place-items: center; margin-bottom: 8px;
    background: var(--av-tile); color: var(--av-ink2);
  }
  .av-desk .av-state-ic { width: 44px; height: 44px; border-radius: 12px; }
  .av-state-t { font-size: calc(var(--av-fs) + 1px); line-height: var(--av-lh); font-weight: 600; color: var(--av-ink); }
  .av-state-d { max-width: 420px; font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); overflow-wrap: anywhere; }
  .av-load { width: 22px; height: 22px; border-width: 2px; margin-bottom: 6px; color: var(--av-ink2); }
  .av-retry {
    margin-top: 14px; height: var(--av-btn-h); padding: 0 22px; border: 0; border-radius: var(--av-btn-r);
    background: var(--av-accent); color: var(--av-on-accent); font: inherit; font-size: var(--av-btn-fs); font-weight: 600; cursor: pointer;
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out), opacity var(--av-t);
  }
  .av-retry:active { transform: scale(.97); opacity: .86; }
  .av-retry:focus-visible { outline: none; box-shadow: var(--av-focus); }
</style>
