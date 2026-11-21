// 扩展面板的跨组件导航句柄（同 settingsNav 模式）：设置外壳先写 type 再显示「扩展」分区，
// components/ext/Customize 挂载时消费一次（读完即清），实现「直达某个类型」。
//
// id：直达某个 bridge 插件的详情（应用页「⋯ › 插件详情」、页面 nav.settings 等）。
//   - type 照旧由 Customize 消费；id 由 PluginsPanel 消费：挂载时和 id / seq 变化时，插件列表里找得到这个 id 就选中它并清掉 id
//     （列表还没拉到时先别清，拉到了再选；拉到了确实没有也清掉，免得之后误选）。
//   - seq 每次 openPluginDetail 自增：设置已经开在「扩展」上（Customize 不会重挂）时，外壳 / Customize 靠它知道要切到
//     「功能扩展」类型、PluginsPanel 靠它重新选中——同一个 id 连点两次也能再跳一次。
import { me, ui } from './state.svelte.js';
import { openSettings } from './settingsNav.svelte.js';

// landing：这次直达是不是连设置一起打开的（设置原本关着）。是的话系统返回从详情一步收起设置、回到发起的地方
// （应用页 / 主页），而不是沿着 详情 → 扩展列表 → 设置首页 一级级退；详情里的返回钮照旧回列表。
export const extensionsNav = $state({ type: null, id: null, seq: 0, landing: false });

// bridge 插件（PluginsPanel）在扩展面板里的类型键是 'module'（「功能扩展」）；'plugin' 是 Claude Code 插件市场那一类
const BRIDGE_PLUGIN_TYPE = 'module';

/** 能不能跳插件详情：插件管理只有主机有（成员的扩展面板只有技能）。 */
export const canOpenPluginDetail = () => me.kind === 'admin';

/** 打开 设置 › 扩展 › 功能扩展，并选中这个插件。成员没有插件管理，回 false（调用方别给这个入口）。 */
export function openPluginDetail(pluginId) {
  const id = String(pluginId || '');
  if (!id || !canOpenPluginDetail()) return false;
  extensionsNav.type = BRIDGE_PLUGIN_TYPE;
  extensionsNav.id = id;
  extensionsNav.landing = !ui.settingsOpen;
  extensionsNav.seq++;
  openSettings('extensions');
  return true;
}
