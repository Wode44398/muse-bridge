// 文本选中：选区画成一块会流动的墨、右键按点中的东西给菜单。实现在 ./selection/。
// 入口引入即启动（要在 nativeMenu.js 之前引入：两边都在 document 上听右键，先登记的先跑，
// 这边接管了的右键 nativeMenu 看到 defaultPrevented 就让位；认不出的照旧交给桌面壳的系统菜单）。
import { initSelection } from './selection/controller.js';

export { attachSelectionDoc } from './selection/controller.js';
// 对话的滚动容器常驻挂：<div class="scroll" use:touchGuard>（触屏长按后接着拖时不让页面滚，见 selection/touch.js）
export { touchGuard } from './selection/touch.js';

initSelection();
