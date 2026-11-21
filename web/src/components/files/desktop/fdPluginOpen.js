// 右键菜单里插件登记的文件处理器（「用「X」打开」）：点了签句柄并打开应用，签句柄与打开在 lib/pluginUi.svelte.js。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { t } from '../../../lib/i18n.js';
import { fileHandlersFor, fileHandlerTitle, openFileWithHandler } from '../../../lib/pluginUi.svelte.js';
import { IS_SOLO } from '../../../lib/solo.js';

export function fdPluginOpenEntries(P, it) {
  const entries = [];
  // 只给服务端摸得到的文件（srvRoot 非 null）——这台电脑的额外位置服务端签不出句柄。
  // 单开对话页（分屏格、拖出的窗口）也不出：那里没有应用分页可落脚，打开应用会把 ui.screen 改走，
  // 而这一页的直播挂载与工作台快捷键都按 ui.screen 判活
  if (P.serverOps && !it.isDir && !IS_SOLO) {
    for (const h of fileHandlersFor(it.name)) entries.push({ label: t('用「{name}」打开', { name: fileHandlerTitle(h) }), act: () => openFileWithHandler(h, { rel: it.rel, ws: P.srvRoot || '' }) });
  }
  return entries;
}
