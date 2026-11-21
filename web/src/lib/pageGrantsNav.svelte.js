// 从应用页「⋯ › 页面权限」直达设置的「页面权限」分区。
// landing：这次是不是连设置一起打开的（设置原本关着）。是的话系统返回一步收起设置、回到应用页，
// 不走设置外壳的逐级后退（那样要先退到设置首页再退一次）。做法同插件详情的直达（lib/extensionsNav.svelte.js）。
import { ui } from './state.svelte.js';
import { openSettings } from './settingsNav.svelte.js';

export const pageGrantsNav = $state({ landing: false });

export function openPageGrants() {
  pageGrantsNav.landing = !ui.settingsOpen;
  openSettings('page-grants');
}
