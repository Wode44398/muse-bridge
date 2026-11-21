// Claude 页·会话行的应用名小标签：插件应用开的会话（服务端列表多给 app: { plugin, id }，originLabel = 应用标题）行尾一枚应用名。

import { pluginUi } from '../pluginUi.svelte.js';
import { tr } from '../i18n.js';

// 名字优先用主页应用清单里的（按界面语言给的标题），清单里没有（插件关了 / 还没加载）再用服务端记的标题。
export const appTagKey = (s) => (s?.app && typeof s.app === 'object' ? (s.app.plugin || '') + ':' + (s.app.id || '') + ':' + (s.originLabel || '') : '');
export function appTagOf(s) {
  const a = s?.app;
  if (!a || typeof a !== 'object' || !a.plugin) return '';
  const hit = pluginUi.apps.find((x) => x.plugin === a.plugin && x.id === a.id);
  return String(hit?.title || tr(s.originLabel || '') || a.id || a.plugin).slice(0, 40);
}
