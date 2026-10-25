// 设置的跨组件导航句柄：外部入口（侧栏账户菜单、新会话卡「不再询问 → 设置」、安全栅门横条…）写 sec 再开 ui.settingsOpen，
// 设置页（components/settings/Settings）挂载时消费一次（读完即清；开着时再写也会被接住），实现「直达某个设置分区」。
import { ui } from './state.svelte.js';
import { IS_SOLO, IS_PANE, PANE_MSG } from './solo.js';

export const settingsNav = $state({ sec: null });

// 本体（两套设置外壳）的分区名 → Muse 设置外壳的分区名。Muse 没有的页（设备、手机操控、快捷键、壁纸、单独的外观/语言页）落「通用」。
const ALIAS = {
  appearance: 'general', language: 'general', devices: 'general', phone: 'general', shortcuts: 'general', wallpaper: 'general', localpc: 'general',
  'agent-api': 'agentapi', agent_api: 'agentapi',
  model: 'providers', models: 'providers',
};

/**
 * 打开设置，可直达分区：general | account | claude（Claude 设置）| providers（模型服务）| agents（Agent 开关，管理员）
 *   | connection | dimensio | agentapi（Agent 接入）| android | feedback | about。本体的分区名也认（见 ALIAS）。
 */
export function openSettings(sec = null) {
  settingsNav.sec = sec ? (ALIAS[sec] || sec) : null;
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
