// 长按菜单里插件登记的文件处理器（「用「X」打开」）：点了签句柄并打开应用，签句柄与打开在 lib/pluginUi.svelte.js。
// P 是外壳（FilesPanel.svelte）交出来的状态与动作视图，见那边的 P。
import { t } from '../../../lib/i18n.js';
import { fileHandlersFor, fileHandlerTitle, openFileWithHandler } from '../../../lib/pluginUi.svelte.js';
import { IS_SOLO } from '../../../lib/solo.js';

export function panelPluginOpenItems(P, it) {
  const L = [];
  // 只给服务端够得着的文件（服务器工作区 / 桌面壳本机根）——
  // 手机本地（SAF）与桌面额外授权位置服务端读不到，签不出句柄，不出这一项。
  // 单开对话页（分屏格、拖出的窗口）也不出：那里没有应用分页可落脚，打开应用会把 ui.screen 改走，
  // 而这一页的直播挂载与工作台快捷键都按 ui.screen 判活
  if (!it.isDir && !P.readonly && !P.guest && !P.isLocal && !P.desktopExtra && !IS_SOLO) {
    for (const h of fileHandlersFor(it.name)) {
      L.push({ label: t('用「{name}」打开', { name: fileHandlerTitle(h) }), symbol: 'arrow.up.forward.app',
        onclick: () => { P.menu = null; openFileWithHandler(h, { rel: P.itemRel(it), ws: P.desktopNative ? '' : P.cloudRoot }); } });
    }
  }
  return L;
}
