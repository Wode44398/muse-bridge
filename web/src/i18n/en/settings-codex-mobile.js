// 英文界面文案 · settings-codex-mobile：手机 / 网页设置（iOS 外壳）› Codex 的正文（components/settings/ios/codex/）。
// 与桌面版共用的键在 settings-codex.js / settings-codex-desktop.js 里，这里只放手机外壳独有的（键 = 中文原文，见 lib/i18n.js）
export default {
  // —— 号池 ——
  '进程': 'Process',
  '进程出错': 'Process error',
  '显示的是上次读到的额度': 'Showing the last known usage limits',
  // —— 加号：设备码登录 ——
  '用 ChatGPT 账号登录': 'Sign in with ChatGPT',
  '复制验证码': 'Copy code',
  '点按复制': 'Tap to copy',
  '打开验证页': 'Open verification page',
  // —— 实验性质功能 / 沙盒 ——
  '目标开着时，没人看着 Codex 也会按目标接着跑，持续消耗额度。': 'With Goal on, Codex keeps working toward the goal even when no one is watching, using up usage limits.',
  'Windows 上没配 Codex 沙盒时，「工作空间写入」会降成只读': 'On Windows, Workspace write falls back to Read only unless the Codex sandbox is set up',
};
