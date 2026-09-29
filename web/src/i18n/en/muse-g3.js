// 英文界面文案 · muse-g3 （键 = 中文原文，见 lib/i18n.js）
// Muse Bridge 自有文案：设置（通用 / Agent / 连接 / 关于）、账户卡与菜单、登录框、扫码登录、离线提示条。
export default {
  // —— 设置外壳（Settings.svelte）：分区名与搜索索引 ——
  '关于': 'About',
  '连接 服务器 域名 地址': 'connection server domain address URL',
  '在线 离线 网络': 'online offline network',
  '版本 about': 'version about',
  'agent claude dimensio 启用 关闭 认证': 'agent claude dimensio enable disable sign-in auth',

  // —— 设置 · 连接（SecConnection.svelte）——
  '网页连的就是当前这台服务器': 'The web app connects to this server.',
  '连接状态': 'Connection status',
  '连不上服务器，正在浏览本地缓存；恢复网络后自动重连': 'Can’t reach the server. Showing cached content. Reconnects automatically.',
  '与服务器连接正常': 'Connected to the server',
  '用户、会话、订阅账号与日志': 'Users, sessions, subscription accounts, and logs',

  // —— 设置 · Agent（SecAgents.svelte）——
  '关掉的 agent，所有人都不再看到它的分页。只开一个时打开网页直接就是那一页；注册用户能用哪些，另在「服务端控制台 → 用户」里按人勾选。':
    'Agents you turn off are hidden from everyone. With only one on, the web app opens straight to that page. Choose which agents each registered user can use in Admin console → Users.',
  '关掉的 agent，所有人都不再看到它的分页。只开一个时打开网页直接就是那一页；再开一个就回到主页。':
    'Agents you turn off are hidden from everyone. With only one on, the web app opens straight to that page. Turn on another to bring back Home.',

  // —— 设置 · 关于（SecAbout.svelte）——
  '网页版 · 界面由服务器直接提供，刷新页面即是最新': 'Web · Served by your server. Refresh the page to get the latest version.',
  '在浏览器里使用 Claude Code 与 dimensio：多用户登录、按人授权、工作空间文件管理与服务端控制台。':
    'Use Claude Code and dimensio in your browser, with multi-user sign-in, per-user access, workspace file management, and an admin console.',

  // —— 登录（LoginDialog / LoginCard）与扫码登录（PairScan）——
  '在已登录的手机浏览器里打开本站，在账户菜单点「扫一扫」': 'Open this site in a signed-in browser on your phone, then tap “Scan” in the account menu.',
  '在已登录的手机浏览器里打开本站，在账户菜单里点「扫一扫」': 'Open this site in a signed-in browser on your phone, then tap “Scan” in the account menu.',
  '登录 Muse Bridge，继续你的工作': 'Sign in to Muse Bridge to continue your work.',
  '相机权限被拒绝。请在浏览器 / 系统设置里允许本站使用相机，或从相册选择二维码截图。':
    'Camera access was denied. Allow this site to use the camera in your browser or system settings, or choose a screenshot of the QR code from your gallery.',
  '这不是 Muse Bridge 的登录二维码': 'This isn’t a sign-in QR code for Muse Bridge',
  '确认后，那台设备将以「{ident}」的身份登录 Muse Bridge。': 'Once you confirm, that device will be signed in to Muse Bridge as “{ident}”.',

  // —— 离线提示条（App.svelte）——
  '离线 · 连不上服务器；可浏览本地缓存，恢复网络后自动重连': 'Offline: can’t reach the server. Showing cached content. Reconnects automatically.',
};
