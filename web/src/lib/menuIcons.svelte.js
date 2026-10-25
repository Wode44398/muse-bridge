// 加号菜单 / 输入框的小图标（viewBox 0 0 20 20、fill currentColor）。用法：<path d={menuIcon('feather')} />
// Muse Bridge 直接用 lib/icons.js 里的原版 SVG path。
import { ICON_PAPERCLIP, ICON_RESEARCH, ICON_FEATHER } from './icons.js';

const table = { paperclip: ICON_PAPERCLIP, research: ICON_RESEARCH, feather: ICON_FEATHER };

export const menuIcon = (key) => table[key] || '';
