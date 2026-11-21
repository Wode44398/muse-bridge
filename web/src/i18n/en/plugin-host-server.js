// 插件页面宿主能力 · 服务端下发、前端 tr() 现查的文案：
//   plugins/discover.mjs 的页面权限说明（PERMISSIONS）；plugins/page-kv、page-grants、page-host、page-files、page-chat
//   与 routes/plugins.mjs 里 _bridge 页面能力、/api/plugins/grants、/api/plugins/handles、/api/plugins/host-requests 的报错。
// 报错里拼进去的名字、数字写成 {x} 模板。
// 别的字典里已有、译法相同的不在这里重复：「一次最多选 {n} 个文件」（plugin-host.js）。
// 页面权限说明在这里是插件详情、设置「页面权限」列表用的句首大写；授权框里接在 “wants to” 后面的小写版本在 plugin-host.js 的 grant:: 键。
export default {
  // —— 页面权限说明（PERMISSIONS） ——
  '在应用页面里以你的身份和 Claude 对话': 'Chat with Claude as you from the app’s pages',
  '读写你在选择器里选中的文件': 'Read and write the files you pick',

  // —— 身份与请求 ——
  '这个身份用不了插件页面': 'This identity can’t use plugin pages',
  '你用不了这个插件的页面': 'You can’t use this plugin’s pages',
  '没有这个插件': 'No such plugin',
  '认不出你的身份（账号可能已停用），重新登录再试': 'Couldn’t tell who you are (the account may be disabled). Sign in again and retry.',
  '请求体太大了': 'The request body is too large',

  // —— 授权 ——
  '这个身份不能授权插件': 'This identity can’t grant permissions to plugins',
  '「{perm}」不是页面权限（可用：{list}）': '“{perm}” isn’t a page permission (available: {list})',
  '插件没有声明「{perm}」权限': 'The plugin didn’t declare the “{perm}” permission',
  '插件没有声明「{perm}」权限，用不了这个功能': 'The plugin didn’t declare the “{perm}” permission, so it can’t use this feature',
  '插件没有声明「{perm}」这个页面权限': 'The plugin didn’t declare the page permission “{perm}”',
  '要你先同意「{perm}」': 'You need to allow “{perm}” first',

  // —— 宿主请求中转（手机 App） ——
  'nav 的 to 只能是 {list}': 'nav’s to must be one of {list}',
  'nav 到会话要 session（会话 id）': 'Going to a chat needs session (the chat id)',
  "nav 到应用要 app（应用 id，或 '<插件>:<应用 id>'）": "Going to an app needs app (an app id, or '<plugin>:<app id>')",
  'type 只能是 {list}': 'type must be one of {list}',
  '挂着没处理的宿主请求太多了（最多 {n} 个），先处理完前面的': 'Too many host requests are waiting (up to {n}). Finish the earlier ones first.',
  '没有这个宿主请求（不是你的，或已过期）': 'No such host request (it isn’t yours, or it has expired)',
  '没有这个请求（不是你的，或已过期）': 'No such request (it isn’t yours, or it has expired)',
  '这个请求已经处理过了': 'This request has already been handled',

  // —— 文件句柄 ——
  '选项目目录里的文件要有命令行权限（Pro 档）': 'Choosing files in project folders needs command-line access (Pro tier)',
  '这个位置不能选': 'This location can’t be chosen',
  'items 的每一项要是 { rel, ws? }': 'Each entry in items must be { rel, ws? }',
  '要 items：[{ rel, ws? }]': 'items is required: [{ rel, ws? }]',
  '文件「{name}」不在了': 'The file “{name}” no longer exists',
  '「{name}」不是文件': '“{name}” isn’t a file',
  '「{name}」链接到了你的空间以外，不能给插件': '“{name}” links outside your space, so it can’t be given to a plugin',
  '「{name}」在受保护的位置，不能给插件': '“{name}” is in a protected location, so it can’t be given to a plugin',
  '文件句柄失效了（过期、插件停用或授权撤销），请重新选择文件': 'This file handle is no longer valid (it expired, the plugin was turned off, or the permission was revoked). Choose the file again.',
  '「{name}」现在链接到了空间以外': '“{name}” now links outside your space',
  '「{name}」不是文件了': '“{name}” is no longer a file',
  '这个文件是只读打开的，不能存回': 'This file was opened read-only and can’t be saved back',
  '文件所在的空间不在了': 'The space this file was in no longer exists',
  '「{name}」现在在受保护的位置，插件读写不了': '“{name}” is now in a protected location, so the plugin can’t read or write it',
  '「{name}」没存进去：{msg}': 'Couldn’t save “{name}”: {msg}',
  '「{name}」正被别的程序占用，稍后再存': '“{name}” is in use by another program. Try saving again later.',

  // —— 页面对话 ——
  '没有这个会话（不是这个插件替你开的）': 'No such chat (this plugin didn’t start it for you)',
  '这个会话正被电脑上的 Claude Desktop / 命令行占着，等那边结束再发': 'This chat is in use by Claude Desktop / the command line on the computer. Send again once it finishes there.',
  '没能开始这一轮': 'Couldn’t start this turn',
  '等了 90 秒还没开始（服务器可能很忙），稍后再看看': 'Still not started after 90 seconds (the server may be busy). Check back later.',
  '要 prompt：发给 Claude 的第一句话': 'prompt is required: the first message to Claude',
  'prompt 太长了（上限 {n} 字）': 'prompt is too long (limit: {n} characters)',
  '要 text：要发的内容': 'text is required: what to send',
  'text 太长了（上限 {n} 字）': 'text is too long (limit: {n} characters)',
  '这个会话的记录没有了': 'This chat’s history is gone',

  // —— 小数据（kv） ——
  'key 不对：1～128 个字符，只用字母、数字和 . _ : -': 'Invalid key: 1–128 characters, using only letters, digits and . _ : -',
  '要 value（删除请传 null）': 'value is required (pass null to delete)',
  'value 要能存成 JSON': 'value must be storable as JSON',
  '这个值太大了（单个值上限 {n}KB）': 'This value is too large (limit: {n} KB per value)',
  '存的东西太多了（每个插件每人上限 {n}MB），先删掉一些': 'Too much is stored (limit: {n} MB per person per plugin). Delete some first.',
};
