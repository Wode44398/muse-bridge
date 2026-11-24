// 设置 › 通用 / 外观 / 通知页的开关（手机 / 网页那套 iOS 外壳，components/Settings.svelte 初始化时创建）
import { prefs, savePrefs, applyFollowSys, setTheme } from '../../../lib/state.svelte.js';
import { np, setNoticePref, VIBES, canVibrate } from '../../../lib/notices.svelte.js';
import { t, lang, LANGS } from '../../../lib/i18n.js';

export function createGeneral() {
  // —— 通用：开关 ——
  // 通知总开关（bridge-notify，默认开）：与「通用 › 通知」页、notify.js / notices.svelte.js 同一份
  const notifyOn = $derived(np.on);
  function toggleNotify() { setNoticePref('on', !np.on); }
  const VIBE_HAS = canVibrate();
  const NOTICE_KINDS = [
    { k: 'question', label: () => t('在等你回答') },
    { k: 'permission', label: () => t('需要你批准') },
    { k: 'done', label: () => t('完成') },
    { k: 'error', label: () => t('出错') },
  ];
  const vibeLabel = () => (VIBES.find((x) => x.id === np.vibe) || VIBES[1]).label();
  const hasNotifySys = typeof window !== 'undefined' && !!window.AndroidStore?.openNotificationSettings;
  function openNotifySystem() { try { window.AndroidStore?.openNotificationSettings?.(); } catch {} }
  function toggleFollowSys() { prefs.followSys = !prefs.followSys; savePrefs(); if (prefs.followSys) applyFollowSys(); }
  // 外观页的明暗卡片：手动选一种＝不再跟随系统（同 iOS）；明暗全局统一，主页与各分页一起换
  function pickTheme(th) {
    if (prefs.followSys) { prefs.followSys = false; savePrefs(); }
    setTheme(th);
  }
  function toggleNoAnim() { prefs.noEnterAnim = !prefs.noEnterAnim; savePrefs(); }
  // 「原图加载」：画廊查看器主图直接拉原图（预载也按原图跑）；关=1280 轻量档+缩放时升原图。
  function toggleFullRes() { prefs.fullResMedia = !prefs.fullResMedia; savePrefs(); }
  // 「使用系统的文字选择」：触屏长按改回系统的选择柄和菜单（读屏用户的退路；安卓读屏开着时自动改用系统的）
  function toggleSysSelect() { prefs.sysSelect = !prefs.sysSelect; savePrefs(); }
  const langLabel = $derived((LANGS.find((l) => l.value === lang()) || LANGS[0]).label);
  return {
    get notifyOn() { return notifyOn; }, toggleNotify, VIBE_HAS, NOTICE_KINDS, vibeLabel, hasNotifySys, openNotifySystem,
    toggleFollowSys, pickTheme, toggleNoAnim, toggleFullRes, toggleSysSelect, get langLabel() { return langLabel; },
  };
}
