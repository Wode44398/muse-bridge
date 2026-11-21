// 插件插槽：文件「用「X」打开」、Ctrl+K 里的插件命令、Claude 侧栏「应用」组、插件市场的分类筛选
// 出现在 lib/pluginUi（签句柄失败的提示）、FilesPanel / FilesDesktop（文件菜单）、components/apps/SidebarAppHost、ext/PluginsPanel
export default {
  // 文件菜单（FilesPanel 长按 / FilesDesktop 右键）
  '用「{name}」打开': 'Open with “{name}”',
  '没能把文件交给「{name}」': 'Couldn’t hand the file to “{name}”',
  // 插件市场分类筛选（ext/PluginsPanel）
  '市场里暂时没有可装的应用。': 'No apps to install in the market yet.',
  '这一类里暂时没有可装的插件。': 'Nothing to install in this category yet.',
};
