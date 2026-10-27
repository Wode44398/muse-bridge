// 「有没有新版」的全站共享状态：启动时的自动检查与设置页的手动检查都写这里，
// 侧栏账户卡与菜单里「关于与更新」旁的小圆点读它。只有安卓离线壳会置 available
// （网页刷新即最新，桌面壳有自己的更新流程与托盘提示）。
export const updateInfo = $state({
  latest: null,      // /api/app/version 的最近一次结果
  checkedAt: 0,      // 最近一次检查的时间戳
  available: false,  // 服务器上有比装着的更新、且已出包的版本
  noBuild: false,    // 这台服务器手里没有能发的 App 包（设置里写「这台服务器没有可发的 App 版本」+ 发布页链接）
  blocked: false,    // 服务器上那一版签名和装着的不同（别的发行渠道 / fork 自编译）：装不上，要卸载重装
  blockedReason: '', // blocked 的原因：'signature'（签名不同）| 'package'（包名不同，装上是另一个 App）
  appNewer: false,   // 手机上装的比服务器新（连去了一台旧服务器）：不降级
  // 服务器要重启 / 装更新了（S1-5，总线 server.restart，见 appUpdate.js 末尾）：null，或
  // { phase:'pending'|'going', reason:'restart'|'update', version, live, since, deadline, at }。离线提示条可据此说「服务器正在更新」
  serverRestart: null,
});
