// 设置页（iOS 外壳）的上下文：外壳 components/Settings.svelte 初始化时按原来的先后创建各控制器（本目录的 *.svelte.js），
// 挂成一个对象 S 放进 context；各页组件取出来只管画。S 上的东西：
//   S.nav（导航栈与推入 / 返回）、S.dark / S.single / S.plat / S.sliding（外壳状态），以及各分区的控制器。
import { getContext, setContext } from 'svelte';
import { SI } from '../../../lib/settingsIcons.js';
import { HOME_GLYPH } from '../HomeLayoutPanel.svelte';
import { PAGE_GRANTS_GLYPH } from '../PageGrantsPanel.svelte';

const KEY = Symbol('settings-ios');
export const provideSettings = (S) => setContext(KEY, S);
export const useSettings = () => getContext(KEY);

// 行首图标的线稿（lib/settingsIcons.js 的路径）包成一枚 24 格的 svg
// 'home'（「主页」分区）不在 SI 里：由 HomeLayoutPanel 给，两套设置外壳共用一枚；'page-grants' 的盾牌同理由 PageGrantsPanel 给
export const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || (name === 'home' ? HOME_GLYPH : name === 'page-grants' ? PAGE_GRANTS_GLYPH : '')}</svg>`;
