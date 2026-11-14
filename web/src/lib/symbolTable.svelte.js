// 设置页符号表的取用口：原版符号字形（visuals/modules/sf-symbols.js，导出 SF；96KB，懒加载）。
// Sym / IconTile 经 symTable() 取，模块到了自己重画。
let table = $state.raw({});
import('../visuals/modules/sf-symbols.js').then((m) => { table = m.SF; });

/** 当前生效的符号表：{ 'name@weight': [墨迹宽, 墨迹高, 路径] } */
export function symTable() { return table; }
