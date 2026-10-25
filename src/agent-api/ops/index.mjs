// 登记全部操作（各文件 import 即登记），并定目录里各组的先后。
import { setGroupOrder } from '../registry.mjs';
import './core.mjs';
import './manual.mjs';
import './chat.mjs';
import './files.mjs';
import './routines.mjs';
import './ui.mjs';
import './keys.mjs';

setGroupOrder(['core', 'projects', 'sessions', 'chat', 'files', 'routines', 'ui', 'keys']);
