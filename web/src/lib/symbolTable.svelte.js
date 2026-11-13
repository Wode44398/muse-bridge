// 设置页符号表的取用口：原版符号字形（清单 modules.sfSymbols，导出 SF）。
// Sym / IconTile 经 symTable() 取，模块到了自己重画。
import { ovModule } from './overlay.svelte.js';

let table = $state.raw({});
ovModule('sfSymbols').then((m) => { if (m && m.SF && typeof m.SF === 'object') table = m.SF; });

/** 当前生效的符号表：{ 'name@weight': [墨迹宽, 墨迹高, 路径] } */
export function symTable() { return table; }
