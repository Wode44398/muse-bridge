// 插件应用 · 服务端下发、前端 tr() 现查的文案：
//   plugins/discover.mjs 的能力声明说明（PERMISSIONS）、plugins/app-spec.mjs 的清单体检、签票与纯页面插件的报错。
// 体检提示是拼出来的（「应用「x」的」+ 原因 +「，用了默认图标」），这里既给整句模板，也给原因片段：
// tr() 先试字面部分长的模板，整句对不上时由「应用「{id}」的{why}，…」接住，再逐段翻 {why}。
// ui 能力的说明改了措辞（多了主页应用），旧键还留在 plugins.js 里，可以一并删掉
export default {
  '往 bridge 的界面里加卡片、菜单项、命令、工作台标签和主页应用（图标 + 全屏页面）': 'Add cards, menu items, commands, workbench tabs and Home Screen apps (icon + full-screen page) to bridge’s interface',

  // 签票 / 纯页面插件
  '打不开这个应用': 'Can’t open this app',
  '这个插件既没有入口文件也没有页面（缺入口文件 index.mjs；只有页面的插件要在清单 ui 里声明 apps / panel / settings）': 'This plugin has neither an entry file nor a page (index.mjs is missing; a page-only plugin must declare apps / panel / settings under ui in its manifest)',

  // 清单体检：丢弃这个应用的
  '应用声明要是一个对象': 'An app declaration must be an object',
  '应用 id「{id}」不对（小写字母开头，只用小写字母、数字、连字符，≤32 字）': 'App id “{id}” is invalid (start with a lowercase letter; use only lowercase letters, digits and hyphens; up to 32 characters)',
  '应用「{id}」的标题要 1～{n} 字': 'App “{id}”: the title must be 1–{n} characters',
  '应用「{id}」的标题「{t}」和 bridge 自带的入口重名，换一个': 'App “{id}”: the title “{t}” is the same as one of bridge’s built-in entries; pick another one',
  '应用「{id}」的 page 要是插件 web/ 下的页面（如 web/app.html）': 'App “{id}”: page must be a page under the plugin’s web/ folder (e.g. web/app.html)',
  '{why}，这个应用没登记': '{why}; this app wasn’t registered',
  '应用 id「{id}」重复，后面那个没登记': 'App id “{id}” is used twice; the later one wasn’t registered',
  '一个插件最多 {n} 个应用，「{id}」没登记': 'A plugin can have at most {n} apps; “{id}” wasn’t registered',
  'ui.apps 应为应用声明的列表': 'ui.apps should be a list of app declarations',

  // 清单体检：不致命的（图标退回默认、英文标题弃用、who 写错）
  '应用「{id}」的图标名「{raw}」不对（内置图标名只用小写字母、数字、连字符），用了默认图标': 'App “{id}”: icon name “{raw}” is invalid (built-in icon names use only lowercase letters, digits and hyphens); using the default icon',
  '应用「{id}」的图标写法不认识，用了默认图标': 'App “{id}”: unrecognized icon format; using the default icon',
  '应用「{id}」的图标没给路径，用了默认图标': 'App “{id}”: the icon has no path; using the default icon',
  '应用「{id}」的{why}，用了默认图标': 'App “{id}”: {why}; using the default icon',
  '图标「{p}」要是插件 web/ 下的 svg / png / webp': 'icon “{p}” must be an svg / png / webp under the plugin’s web/ folder',
  '图标文件 {p} 不存在': 'icon file {p} doesn’t exist',
  '图标文件 {p} 超过 200 KB': 'icon file {p} is larger than 200 KB',
  '应用「{id}」的英文标题「{t}」和 bridge 自带的入口重名，英文界面改用中文标题': 'App “{id}”: the English title “{t}” is the same as one of bridge’s built-in entries; the Chinese title is used in the English interface',
  '应用「{id}」的 who 只能是 host / members，按 host 处理': 'App “{id}”: who can only be host / members; treated as host',
};
