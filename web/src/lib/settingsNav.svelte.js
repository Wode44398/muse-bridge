// 设置的跨组件导航句柄：外部入口（侧栏账户菜单等）写 sec 再开 ui.settingsOpen，
// 设置页（components/settings/Settings）挂载时消费一次（读完即清），实现「直达某个设置分区」。
import { ui } from './state.svelte.js';

export const settingsNav = $state({ sec: null });

/** 打开设置，可直达分区：general | agents | account | connection | about */
export function openSettings(sec = null) {
  settingsNav.sec = sec;
  ui.settingsOpen = true;
}
