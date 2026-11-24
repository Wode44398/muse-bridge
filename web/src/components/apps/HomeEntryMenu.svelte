<script module>
  // 菜单里放哪几项也住在这里：手机 / 网页主页的方块（Home）和桌面主页的 Dock（DesktopHome）共用一份，
  // 免得两边各写一套、加一项漏一边（Dock 当初就是因为没接这份，右键什么都不弹）。
  //   从主页隐藏：任何入口都有（内置的四个也能藏，设置「主页」里找回）；
  //   插件详情：只有插件应用有，且只给能进插件管理的主机（成员的扩展面板没有插件页）。
  import { setHomeHidden } from '../../lib/homeLayout.svelte.js';
  import { openPluginDetail, canOpenPluginDetail } from '../../lib/extensionsNav.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t } from '../../lib/i18n.js';
  import {
    canOpenPageInWindow,
    hasDesktopPageWindows,
    openPageInWindow,
    focusPageWindow,
    closePageWindow,
    pageWindowCount,
  } from '../../lib/windowPage.svelte.js';

  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5l17 17"/><path d="M10.4 5.6A9 9 0 0 1 12 5.5c4.6 0 7.9 3.8 9 6.5-.4 1-1.1 2.2-2.1 3.3M6.8 6.9C4.9 8.1 3.6 10 3 12c1.1 2.7 4.4 6.5 9 6.5 1.7 0 3.2-.5 4.5-1.3"/><path d="M9.9 10a3 3 0 0 0 4.1 4.1"/></svg>';   // i18n-ignore 图标
  const OPEN_WIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M3.5 9.2h17"/><path d="M12.5 15.5l4.2-4.2m0 0h-3.1m3.1 0v3.1"/></svg>';   // i18n-ignore 图标
  const FOCUS_WIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M4 9.5h16"/><path d="M9.5 14.2h5"/></svg>';   // i18n-ignore 图标
  const CLOSE_WIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M9.8 11.8l4.4 4.4m0-4.4l-4.4 4.4"/></svg>';   // i18n-ignore 图标

  /** 主页入口 e（homeView 的一项：{ key, kind: 'builtin' | 'app', label, app? }）的菜单项；「更多」那格没有菜单，回空数组。 */
  export function homeEntryMenuItems(e, opts = null) {
    if (!e || e.kind === 'more') return [];
    const key = e.key, label = e.label;
    const items = [];
    if (canOpenPageInWindow()) {
      const desktop = hasDesktopPageWindows();
      items.push({
        label: desktop ? t('在独立窗口中打开') : t('在新标签页中打开'),
        icon: OPEN_WIN,
        onclick: () => { openPageInWindow(key, { title: label }); },
      });
      if (desktop) {
        const count = pageWindowCount(key);
        if (count > 0) {
          items.push({
            label: t('切换到独立窗口'),
            icon: FOCUS_WIN,
            onclick: () => { focusPageWindow(key); },
          });
          items.push({
            label: count > 1 ? t('关闭全部独立窗口（{n}）', { n: count }) : t('关闭独立窗口'),
            icon: CLOSE_WIN,
            onclick: () => { closePageWindow(key); },
          });
        }
      }
    }
    if (!opts?.noHide) {
      items.push({
        label: t('从主页隐藏'), icon: EYE_OFF,
        onclick: () => {
          setHomeHidden(key, true);
          showToast(t('已从主页隐藏「{name}」，可以在设置「主页」里找回', { name: label }));
        },
      });
    }
    if (e.kind === 'app' && canOpenPluginDetail()) {
      const pid = e.app?.plugin;
      items.push({ label: t('插件详情'), symbol: 'info.circle', onclick: () => openPluginDetail(pid) });
    }
    return items;
  }
</script>

<script>
  // 主页入口的长按 / 右键菜单：ios27 MorphMenu 的长按形态，从按压点弹出。
  // 单拆一个组件只为给 MorphMenu 一份 ios27 上下文（明暗）——直接在 Home 上 setContext 会波及登录卡等别的子组件。
  // 挂的位置：主页根节点（Home 的 .home、DesktopHome 的 .dh：整屏、不透明底色）直属子级，中间别隔建层叠上下文的父级（见 MorphMenu 头注）。
  import { setContext } from 'svelte';
  import MorphMenu from '../ios27/MorphMenu.svelte';

  let { open = false, point = null, title = '', items = [], dark = true, onclose } = $props();
  setContext('ios27', { get dark() { return dark; } });
</script>

<MorphMenu {open} {point} {title} {items} width={240} {onclose} />
