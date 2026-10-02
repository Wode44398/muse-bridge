// 英文界面文案 · home-assistant-shell（主页、全局助手玻璃球、桌面 Dock / 命令面板 / Quick Ask、账户菜单、顶栏与外壳）（键 = 中文原文，见 lib/i18n.js）
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

  // —— 全局助手 · 玻璃球 ——
  '呼出助手（双击摄像头）': 'Open Assistant (double-tap the camera)',
  '问助手…': 'Ask Assistant…',
  // 思考态提示（最后调用的工具）
  '跳转中…': 'Opening…',
  '转交中…': 'Handing off…',
  '召唤 Claude…': 'Handing off to Claude…',
  '生成图片…': 'Generating image…',
  '生成视频…': 'Generating video…',
  '合成语音…': 'Generating speech…',
  '生成音乐…': 'Generating music…',
  '切换模型…': 'Switching model…',
  '保存文件…': 'Saving file…',
  '查询任务…': 'Checking tasks…',
  '记住偏好…': 'Saving preference…',
  '搜索文件…': 'Searching files…',
  '读取文件…': 'Reading file…',
  '搜索历史…': 'Searching history…',
  '打开对话…': 'Opening chat…',
  '调整设置…': 'Changing settings…',
  '查看定时…': 'Checking routines…',
  '启停定时…': 'Toggling routine…',
  // 挖孔定位诊断叠层（设置里打开的调试信息）
  '竖条': 'Strip',
  '真圆': 'Circle',
  '缓存': 'Cache',
  '屏': 'screen',
  '壳': 'Shell',
  'win偏移': 'win offset',
  '画层': 'layer',
  '原生': 'Native',
  '未运行（开「悬浮外壳」后再看橙圆）': 'Not running (turn on “Floating capsule” to see the orange circle)',
  '读取中…（旧 apk 无 getCutoutDebug 则一直为空）': 'Loading… (stays empty on older APKs without getCutoutDebug)',
  // 挖孔手动校准
  '拖动屏幕移动绿环，调直径，把环套准真实摄像头后保存': 'Drag the screen to move the green ring, then adjust the diameter. Save when the ring fits around the camera.',
  '直径 {n}px': 'Diameter {n}px',
  '归零': 'Reset',

  // —— 全局助手 · 控制器（toast / 系统通知）——
  '这个分页没有对你开放': 'This page isn’t available to you',
  '先在「设置→通用→手机操控」开启并授权，Claude 才能真正操作手机': 'Set up Phone control in Settings → General so Claude can control your phone',
  '已召唤 Claude 操作手机': 'Handed off to Claude to control your phone',
  '已配好视频参数，点「生成」开始': 'Video parameters set. Tap “Generate” to start.',
  '已配好音乐参数，点「生成」开始': 'Music parameters set. Tap “Generate” to start.',
  '内容.md': 'content.md',
  '暂存失败': 'File preparation failed',   // 只作「下载失败：{reason}」的 reason 出现
  '已下载到手机：{name}': 'Downloaded to your phone: {name}',
  '下载失败：{reason}': 'Couldn’t download: {reason}',
  '已存到手机本地：{name}': 'Saved on your phone: {name}',
  '写入失败': 'Couldn’t write the file',
  '引擎': 'Engine',
  '任务中断': 'Task interrupted',
  '{name} 没能完成「{task}」': '{name} couldn’t finish “{task}”',
  '{name} 没能完成任务，后续已取消': '{name} couldn’t finish the task. Follow-up canceled.',
  '{name} 写完了，对我说「继续」就处理结果': '{name} is done. Say “continue” to process the result.',
  '助手已完成': 'Assistant is done',
  '已处理结果': 'Result processed',
  // —— 主页明暗（iOS 没有流光动态壁纸）——
  '暗色主页需要先在设置 · 壁纸里选一张图片': 'To use the dark home screen, pick an image in Settings · Wallpaper first',
};
