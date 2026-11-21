// 插件页面宿主（components/ext/PluginFrame.svelte）· 页面宿主能力：选择器 / 授权框、对话订阅、代发请求。
// 「来自插件「{plugin}」」「插件「{name}」没有声明文件权限，选不了文件」「服务器返回 {code}」「网络连接失败」「请求不合法」「请求体太大」
// 「请求太频繁，稍后再试」等别的字典里已有，不在这里重复。
export default {
  '上一个选择框、授权框或确认框还没关': 'Another picker, permission prompt or confirmation is still open',
  '同一个页面最多同时订阅 {n} 个对话': 'A page can follow at most {n} chats at once',
  '选中的文件没能交给插件：{msg}': 'Couldn’t hand the chosen files to the plugin: {msg}',
  '对话事件请用 bridge.chat.on 订阅': 'Subscribe to chat events with bridge.chat.on',
  // 页面在后台（切到了别的分页、被设置盖住、浏览器标签切走）时跳转 / 弹框类调用的报错，给插件页面看
  '页面不在前台': 'The page isn’t in the foreground',
};
