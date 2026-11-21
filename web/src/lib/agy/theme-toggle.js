// 点 agy 标志切明暗：从被点的标志铺开柔边圆波（与 Claude 页点标志同一套 pageMorph.morphPageTheme）。
// agy 设置里外观是「跟随 bridge」时切 bridge 全局主题；单独指定了深 / 浅色时只翻 agy 自己的设置。

import { tick } from 'svelte';
import { ui } from '../state.svelte.js';
import { morphPageTheme } from '../pageMorph.js';
import { switchPageTheme } from '../homeTheme.js';
import { agyPrefs, patchAgySettings } from './settings.svelte.js';

export function agyIsDark() {
  const pref = agyPrefs.settings.theme;
  if (pref === 'azure') return true;
  if (pref === 'daylight') return false;
  return ui.theme !== 'light';
}

export function toggleAgyTheme(originEl) {
  const pref = agyPrefs.settings.theme;
  if (pref === 'azure' || pref === 'daylight') {
    const toLight = pref === 'azure';
    // patchAgySettings 先同步写入本地状态再去存盘，换场回调里不必等网络
    return morphPageTheme(originEl, async () => {
      patchAgySettings({ theme: toLight ? 'daylight' : 'azure' }, 'appearance');
      await tick();
    }, { toLight, style: 'google' }).catch(() => {});
  }
  return switchPageTheme(originEl, { style: 'google' });
}
