// 插件开的会话在列表里的来源标：originLabel = 标签（应用页面开的会话打标时写的就是应用标题）；
// 应用页面开的另带 app: { plugin, id }，前端据此显示应用名小标签、点了能回到那个应用。
export function pluginOriginOf(ps) {
  return {
    originLabel: ps.label || ps.plugin,
    ...(ps.app ? { app: { plugin: ps.plugin, id: ps.app } } : {}),
  };
}
