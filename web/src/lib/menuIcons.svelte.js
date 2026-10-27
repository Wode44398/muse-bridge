// 加号菜单 / 输入框的小图标（viewBox 0 0 20 20、fill currentColor）。
// 公开版用 menuIconPaths.js（Lucide 字形）；维护者的私有 overlay 提供另一套时（清单 modules.menuIcons，
// 导出 ICONS = { paperclip, research, feather }）换成它。用法：<path d={menuIcon('feather')} />
import { MENU_ICONS } from './menuIconPaths.js';
import { ovModule } from './overlay.svelte.js';

let table = $state.raw(MENU_ICONS);
ovModule('menuIcons').then((m) => { if (m && m.ICONS && typeof m.ICONS === 'object') table = { ...MENU_ICONS, ...m.ICONS }; });

export const menuIcon = (key) => table[key] || '';
