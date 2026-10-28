// 登记全部操作（各文件 import 即登记），并定目录里各组的先后。
import { setGroupOrder, allOps } from '../registry.mjs';
import './core.mjs';
import './manual.mjs';
import './chat.mjs';
import './settings.mjs';
import './files.mjs';
import './routines.mjs';
import './media.mjs';
import './devices.mjs';
import './ui.mjs';
import './modules.mjs';
import './keys.mjs';
import './plugins.mjs';
import './feedback.mjs';

setGroupOrder(['core', 'projects', 'sessions', 'chat', 'settings', 'files', 'routines', 'media', 'devices', 'ui', 'modules', 'plugins', 'keys', 'feedback']);

// 属于可关的内置功能（插件）的整组操作：功能关着时一律报「这台服务器关着」，不用逐条写 need。
const GROUP_PLUGIN = { routines: 'routines', devices: 'devices' };
for (const op of allOps()) {
  const pid = GROUP_PLUGIN[op.group];
  if (pid && !op.need.includes('plugin:' + pid)) op.need = [...op.need, 'plugin:' + pid];
}
