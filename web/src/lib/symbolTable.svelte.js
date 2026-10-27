// 设置页符号表的取用口：公开版用 lib/sfSymbols.js（Lucide 字形），维护者的私有 overlay 提供了另一套
// （清单 modules.sfSymbols，导出同格式的 SF）时换成它。Sym / IconTile 经 symTable() 取，换表时自己重画。
import { SF as PUBLIC_SF } from './sfSymbols.js';
import { ovModule } from './overlay.svelte.js';

let table = $state.raw(PUBLIC_SF);
ovModule('sfSymbols').then((m) => { if (m && m.SF && typeof m.SF === 'object') table = m.SF; });

/** 当前生效的符号表：{ 'name@weight': [墨迹宽, 墨迹高, 路径] } */
export function symTable() { return table; }
