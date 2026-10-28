// 英文界面文案 · 服务端更新与客户端跟随服务器版本（设置「连接与更新 / 关于 › 服务端更新」，lib/serverUpdate.svelte.js；
// 服务端 / 桌面客户端回来的原因句经 tr() 匹配，见 src/runtime/server-update.mjs、client-release.mjs）（键 = 中文原文，见 lib/i18n.js）
export default {
  '服务端更新': 'Server update',
  '服务器 版本 升级 GitHub': 'server version upgrade update GitHub',
  '暂时查不到新版本': 'Couldn’t check for new versions',
  '服务端查不到 GitHub 上的新版本：{error}': 'The server couldn’t check GitHub for new versions: {error}',
  '客户端跟随服务器的版本（v{v}）：服务器更新后，这里就能更新到同一版': 'This app follows the server’s version (v{v}). Once the server is updated, you can update to the same version here.',
  '等 {n} 个对话跑完后更新并重启': { one: 'Updates and restarts after {n} conversation finishes', other: 'Updates and restarts after {n} conversations finish' },
  '等服务器空闲后更新并重启…': 'Updates and restarts once the server is idle…',
  '已交给 {name} 下载 v{v}：下好后等所有对话跑完自动安装，服务端会重启一次': 'Handed to {name} to download v{v}. Once downloaded, it installs automatically after all conversations finish, and the server restarts once.',
  'GitHub 上有新版 v{v}（现在是 v{cur}）': 'v{v} is available on GitHub (currently v{cur})',
  'v{cur} · 暂时查不到 GitHub 上的新版本（{error}）': 'v{cur} · Couldn’t check GitHub for new versions ({error})',
  'v{cur} · 已是最新': 'v{cur} · Up to date',
  '上次更新失败（退出码 {code}），看服务端控制台的最近日志': 'The last update failed (exit code {code}). See the recent logs in the server console.',
  '从 git 仓库拉最新代码、装依赖、重建前端，完成后空闲时重启': 'Pulls the latest code from git, installs dependencies and rebuilds the frontend, then restarts when idle',
  '已开始更新，完成后空闲时重启': 'Update started. The server restarts when idle once it’s done.',
  '已开始：{name} 正在下载 v{v}，下好后等所有对话跑完自动安装': 'Started: {name} is downloading v{v} and installs it automatically after all conversations finish',
  '更新没能开始': 'Couldn’t start the update',

  // 服务端回来的说明（tr）
  '这台服务器由那台电脑上的桌面客户端托管，但客户端现在没连上：在那台电脑上打开桌面客户端，「设置 › 连接与更新 › 软件更新」里更新（服务端随客户端安装包一起换）':
    'This server is managed by the desktop app on its computer, but the app isn’t connected right now. Open the desktop app on that computer and update in Settings › Connection & updates › Software Update (the server is updated along with the app).',
  'Docker 部署：在服务器上重建镜像（git pull && docker compose up -d --build），设置里没法替你做': 'Docker deployment: rebuild the image on the server (git pull && docker compose up -d --build). This can’t be done from Settings.',
  '这台服务器的部署方式不支持在设置里更新': 'This server’s deployment can’t be updated from Settings',
  '这台 bridge 还没有可发的桌面客户端': 'This bridge server has no desktop app build to hand out yet',
  '客户端尚未配对': 'The app isn’t paired yet',
  '更新服务返回 {status}': 'The update service returned {status}',
};
