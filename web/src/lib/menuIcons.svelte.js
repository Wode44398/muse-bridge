// 加号菜单 / 输入框的小图标（viewBox 0 0 20 20、fill currentColor）：原版字形
// （visuals/modules/menu-icons.js，导出 ICONS = { paperclip, research, feather }，懒加载）。用法：<path d={menuIcon('feather')} />
let table = $state.raw({});
import('../visuals/modules/menu-icons.js').then((m) => { table = m.ICONS; });

export const menuIcon = (key) => table[key] || '';
