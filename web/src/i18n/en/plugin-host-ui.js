// 插件页面宿主能力 · 手机 App 中转（lib/pluginHostRelay.js）、
// 插件详情「已授予的页面权限」（components/ext/PluginsPanel.svelte）、Claude 页会话行的应用名标签（components/ClaudePage.svelte）。
// 「服务器返回 {code}」「网络连接失败」「已撤销」「重试」「载入中…」等别的字典里已有，不在这里重复。
export default {
  // 手机 App 中转
  '登录后接着处理插件页面的请求': 'Sign in to continue with the plugin page’s request',
  '插件「{name}」没有声明文件权限，选不了文件': 'The plugin “{name}” didn’t declare file access, so it can’t pick files',
  '插件页面的这个请求等太久，已经作废了；回到插件页面再点一次': 'The plugin page’s request waited too long and expired. Go back to the page and try again',

  // 插件详情 › 已授予的页面权限
  '已授予的页面权限': 'Page permissions granted',
  '授权记录没读出来': 'Couldn’t load the permissions',
  '还没有授予过。应用页面要用到时会先问你。': 'Nothing granted yet. The app’s pages will ask you first when they need it.',
  '{at}授予': 'Granted {at}',
  '已授予': 'Granted',

  // Claude 页会话行
  '由插件应用「{app}」开的对话': 'Chat started by the plugin app “{app}”',
};
