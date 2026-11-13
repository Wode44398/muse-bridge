// 加号菜单 / 输入框的小图标（viewBox 0 0 20 20、fill currentColor）：原版字形
// （清单 modules.menuIcons，导出 ICONS = { paperclip, research, feather }）。用法：<path d={menuIcon('feather')} />
import { ovModule } from './overlay.svelte.js';

let table = $state.raw({});
ovModule('menuIcons').then((m) => { if (m && m.ICONS && typeof m.ICONS === 'object') table = m.ICONS; });

export const menuIcon = (key) => table[key] || '';
