// 英文界面文案 · home-assistant-shell（主页、桌面 Dock / 命令面板 / Quick Ask、账户菜单、顶栏与外壳）（键 = 中文原文，见 lib/i18n.js）
export default {
  // —— 通用小词 ——
  '取消': 'Cancel',
  '保存': 'Save',
  '发送': 'Send',
  '关闭': 'Close',
  '停止': 'Stop',
  '设置': 'Settings',
  '主页': 'Home',
  '账户': 'Account',
  '登录': 'Sign in',
  '退出登录': 'Sign out',
  '工作空间': 'Workspace',
  '工作台': 'Workbench',
  '背景': 'Background',
  '出错了': 'Something went wrong',
  '需要登录': 'Sign-in required',
  '连接中断，请重试': 'Connection lost. Try again.',
  '重连中…': 'Reconnecting…',
  '思考中…': 'Thinking…',
  '读取中…': 'Loading…',
  '处理中…': 'Working…',

  // —— App 根：离线条、分页被关 ——
  '这个分页已被管理员关闭': 'Turned off by your admin',
  '离线 · 连不上电脑；可浏览本地缓存，恢复网络后自动重连': 'Offline: can’t reach your computer. Showing cached content. Reconnects automatically.',
  '服务控制台': 'Admin console',

  // —— 占位分页 ——
  '该分页正在重做中': 'This page is being rebuilt',
  '返回主页': 'Back to Home',

  // —— Claude 页顶栏 ——
  // Claude 页顶栏菜单钮（官方 Open / Close sidebar，与 claude-chat 的「关闭侧栏」同值）；plain「收起侧栏」与 dimensio 侧栏同为 Collapse sidebar
  'claude::收起侧栏': 'Close sidebar',
  '收起侧栏': 'Collapse sidebar',
  '菜单': 'Menu',
  '切换明暗主题': 'Toggle light/dark theme',

  // —— 账户菜单 ——
  '管理员': 'Admin',
  'Pro 用户': 'Pro user',
  '普通用户': 'Standard user',
  '未登录': 'Not signed in',
  '关闭菜单': 'Close menu',
  '账户菜单': 'Account menu',
  '关于与更新': 'About & updates',
  '新版本': 'New version',
  '扫一扫登录网页版': 'Scan to sign in on the web',

  // —— 品牌标题 ——
  '切换壁纸主题': 'Switch wallpaper theme',
  '点击切换壁纸 / 玻璃方案': 'Switch wallpaper / glass style',

  // —— 手机主页：文件拖到入口上 ——
  '把 {n} 项发给 {name}': { one: 'Send {n} item to {name}', other: 'Send {n} items to {name}' },
  '发给 {name}': 'Send to {name}',

  // —— 桌面主页 Dock ——
  '设置 · Ctrl+K 搜索': 'Settings · Search (Ctrl+K)',

  // —— Ctrl+K 命令面板（keys = 英文搜索关键词）——
  '打开 Claude': 'Open Claude',
  '打开 ChatGPT': 'Open ChatGPT',
  '打开 dimensio': 'Open dimensio',
  '打开 Vertex': 'Open Vertex',
  '打开工作空间': 'Open Workspace',
  'gemini 图片 视频 音乐': 'gemini image video music',
  '文件 files workspace': 'files workspace folders',
  '设置 · 通用': 'Settings · General',
  '通知 明暗 动画': 'notifications theme light dark animation motion',
  '设置 · 个性化': 'Settings · Personalization',
  '玻璃 画质 折射 flux 扩展': 'glass quality refraction flux extensions',
  '设置 · 壁纸': 'Settings · Wallpaper',
  '空间 景深 上传': 'spatial depth upload',
  '设置 · 连接与更新': 'Settings · Connection & updates',
  '服务器 地址 版本 更新': 'server address url version update',
  '设置 · 帮助': 'Settings · Help',
  '反馈 版本': 'feedback version',
  '继续 · {title}': 'Continue · {title}',
  'claude 会话 继续': 'claude session continue resume',
  '搜索 agent、最近会话、设置…': 'Search agents, recent sessions, settings…',
  '没有匹配项': 'No matches',

  // —— Quick Ask ——
  '快速提问': 'Quick Ask',
  '正在用 {tool}': 'Using {tool}',
  '正在用 工具': 'Using a tool',
  '它问了你一个问题，去主窗回答': 'Claude asked you a question. Answer it in the main window.',
  '问点什么…  Enter 发送 · Esc 收起': 'Ask anything · Enter to send · Esc to dismiss',
  '停止这一轮': 'Stop this turn',
  '发送（Enter）': 'Send (Enter)',
  '去主窗回答 →': 'Answer in main window →',
  '在主窗打开 →': 'Open in main window →',
  'claude::新话题': 'New session',
  'Esc 收起，这一轮继续在后台跑': 'Esc to dismiss. The turn keeps running.',

  // —— 下载 / 写入反馈（toast）——
  '下载失败：{reason}': 'Couldn’t download: {reason}',
  '写入失败': 'Couldn’t write the file',
  // —— 主页明暗（iOS 没有流光动态壁纸）——
  '暗色主页需要先在设置 · 壁纸里选一张图片': 'To use the dark home screen, pick an image in Settings · Wallpaper first',
  '通知 语言 自启': 'notifications language startup',
  '设置 · 外观': 'Settings · Appearance',
  '明暗 深色 浅色 动画': 'appearance dark light animation',
  '设置 · Claude': 'Settings · Claude',
  '号池 账号 切号 用量 输入建议 思考动画': 'account pool switch usage suggestions thinking animation',
};
