// 设置的跨组件导航句柄：外部入口（侧栏账户菜单、命令面板、桌面壳窗口 chrome、输入框电脑芯片、安全栅门横条…）
// 写 sec 再开 ui.settingsOpen。设置外壳只有两套（2026-10-21 合一，单页模式也用它们）：桌面壳的 SettingsDesktop、
// 手机 / 网页的 iOS 风 components/Settings——哪个在显示就由哪个消费（读完即清；开着时再写也会被接住）。
import { ui } from './state.svelte.js';
import { settingsNav } from '../desktop/settings/settingsNav.svelte.js';
import { IS_SOLO, IS_PANE, PANE_MSG } from './solo.js';

export { settingsNav };

/**
 * 打开设置，可直达分区。分区名两套外壳都认（各自映射到自己的页；外壳里没有的落首页）：
 *   general | appearance | account | about（关于与更新）| connection（服务器地址 / 线路）| devices（设备与端口转发）
 *   | claude（Claude 设置页；agents 同义）| feedback | phone（安卓手机操控）| shortcuts（桌面快捷键）| wallpaper | agentapi（Agent 接入）
 */
export function openSettings(sec = null) {
  settingsNav.sec = sec;
  ui.settingsOpen = true;
}

// 对话里的「打开设置」入口（安全栅门横条、新会话卡「不再询问 → 设置」等）：主页面直接开；分屏格（iframe）里没挂设置外壳，
// 托宿主页开（ClaudePage onPaneMsg 的 settings）；拖出去的独立窗口没有设置页——canOpenSettingsFromChat 为假，调用方别给链接。
export const canOpenSettingsFromChat = !IS_SOLO || IS_PANE;
export function openSettingsFromChat(sec = null) {
  if (IS_PANE) { try { window.parent.postMessage({ [PANE_MSG]: 1, t: 'settings', sec }, location.origin); } catch {} return true; }
  if (IS_SOLO) return false;
  openSettings(sec);
  return true;
}
