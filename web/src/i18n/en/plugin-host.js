// 英文界面文案 · 插件页面的宿主能力：授权框、文件 / 会话选择器、交给 Claude、页面跳转
// （lib/grantDialog、components/apps/GrantDialog、lib/filePicker、components/pickers/*、lib/claudeHandoff、lib/pageNav；键 = 中文原文，见 lib/i18n.js）
// 别的字典里已有、译法相同的通用词（取消、允许、加载中…、重试 等）不在这里重复。
export default {
  // —— 授权框 ——
  '「{app}」想要{what}': '“{app}” wants to {what}',
  // 页面权限的说明接在 “wants to” 后面：同一句中文在 plugin-host-server.js 里是给插件详情列表用的句首大写，这里要小写开头
  'grant::在应用页面里以你的身份和 Claude 对话': 'chat with Claude as you from the app’s pages',
  'grant::读写你在选择器里选中的文件': 'read and write the files you pick',
  '来自插件「{plugin}」': 'From the plugin “{plugin}”',
  '没能保存授权：{msg}': 'Couldn’t save the permission: {msg}',
  '授权框没能打开，请刷新页面后再试': 'The permission prompt couldn’t open. Refresh the page and try again.',
  '服务器返回 {code}': 'The server returned {code}',
  '网络连接失败': 'Network connection failed',

  // —— 文件选择器 ——
  '选择一个文件': 'Choose a file',
  '选择文件（可多选）': 'Choose files',
  '已选 {n} 个': '{n} selected',
  '最多选 {n} 个': 'Up to {n}',
  '一次最多选 {n} 个文件': 'You can choose up to {n} files at a time',
  '这里还没有文件': 'No files here yet',
  '这个应用不接受这种文件': 'This app doesn’t accept these files',
  '这个文件夹有 {n} 项，只列出了前 {m} 项': 'This folder has {n} items; only the first {m} are shown',
  '选择': 'Choose',
  '选择（{n}）': 'Choose ({n})',
  '文件选择器没能打开，请刷新页面后再试': 'The file picker couldn’t open. Refresh the page and try again.',

  // —— 会话选择器 ——
  '选择一个对话': 'Choose a chat',
  '对话列表没能加载': 'Couldn’t load your chats',
  '还有 {n} 个对话没列出来，搜一下能找到': '{n} more chats not shown. Search to find them.',
  '会话选择器没能打开，请刷新页面后再试': 'The chat picker couldn’t open. Refresh the page and try again.',

  // —— 页面跳转 ——
  '插件详情只有这台服务器的管理员能打开': 'Only this server’s admin can open plugin details',
  '找不到这个会话': 'Couldn’t find that chat',
};
