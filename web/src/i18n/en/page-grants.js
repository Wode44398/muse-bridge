// 英文界面文案 · 设置 ›「页面权限」与主页的「新建应用」
// （components/settings/PageGrantsPanel、components/settings/HomeLayoutPanel、components/apps/GrantDialog 的撤销提示、
//  桌面设置的搜索词；键 = 中文原文，见 lib/i18n.js）
// 别的字典里已有、译法相同的通用词（页面权限、已允许、重试、加载中… 等）不在这里重复。
export default {
  // —— 页面权限 ——
  '没有允许': 'Not allowed',
  // 「撤销」在编辑器里是 Undo；这里是收回权限
  '权限::撤销': 'Revoke',
  '{when}允许': 'Allowed {when}',
  '撤销「{name}」的文件权限？': 'Revoke file access for “{name}”?',
  '已经交给页面的文件随之失效：页面里开着的文件读写不了，要再用得重新经你同意。': 'Files already handed to its pages stop working: files open in the page can’t be read or written, and it has to ask you again to use them.',
  '没能撤销：{msg}': 'Couldn’t revoke: {msg}',
  '插件页面以你的身份和 Claude 对话、读写你选的文件之前，都要先经你同意。撤销以后页面再要用，会重新问你。': 'Plugin pages need your OK before they chat with Claude as you or read and write the files you pick. After you revoke a permission, the page asks again the next time it needs it.',
  '没有要过页面权限的插件': 'No plugins have asked for page permissions',
  '装了会向你要权限的插件以后，它们会列在这里。': 'Plugins that ask you for permissions show up here once they’re installed.',
  '没能读到页面权限': 'Couldn’t load page permissions',
  '插件 页面 授权 权限 撤销 文件 对话 grants permissions': 'plugin page grant permission revoke file chat grants permissions',
  // 授权框底下那句（指到这一页）
  '随时可以在 设置 › 页面权限 里撤销。': 'You can revoke this anytime in Settings › Page permissions.',

  // —— 主页 › 新建应用（交给 Claude，不替人发） ——
  '新建应用': 'New app',
  '交给 Claude：说说想要什么，它帮你做成主页上的一个应用': 'Hand it to Claude: describe what you want and it builds it into an app on your home screen',
  '帮我做一个 bridge 应用：': 'Help me build a bridge app: ',
};
