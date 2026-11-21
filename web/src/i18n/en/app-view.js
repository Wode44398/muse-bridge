// 英文界面文案 · 声明式应用：AppView 画布、积木组件、数据层的提示，应用页 ⋯ 菜单的「页面权限」
// （lib/appView.svelte.js、components/appview/*、components/apps/PluginAppPage；键 = 中文原文，见 lib/i18n.js）
// 别的字典里已有、译法相同的通用词（重试、加载中、网络连接失败、服务器返回 {code}、来自插件「{plugin}」、插件动作没有执行成功）不在这里重复。
export default {
  // —— 画布：首屏 / 出错 / 空 ——
  '正在打开…': 'Opening…',
  '应用没能打开': 'The app couldn’t open',
  '这个应用暂时没有内容': 'This app has nothing to show yet',
  '没能刷新这个应用：{msg}': 'Couldn’t refresh this app: {msg}',
  '应用的状态太大了': 'The app’s state is too large',
  '上一个操作还没做完，等它做完再点': 'The previous action is still running — try again when it’s done',
  // —— 积木的空状态（插件没给 empty 文案时） ——
  '还没有内容': 'Nothing here yet',
  '还没有数据': 'No data yet',
  // —— 应用页：界面代码没拉下来 ——
  '这个应用没能加载': 'This app couldn’t load',
  // —— 应用页 ⋯ 菜单 ——
  '页面权限': 'Page permissions',
};
