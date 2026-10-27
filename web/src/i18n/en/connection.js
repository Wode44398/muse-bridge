// 英文界面文案 · 连接与地址自愈、手机 App 由服务端下发（开源路线 S1-1 / S1-4；键 = 中文原文，见 lib/i18n.js）
// 前端：App.svelte 离线提示条、Settings / SettingsDesktop 的「服务器」「手机 App」「更新」、服务端控制台的公网访问与安装包来源；
// 后端：src/runtime/public-access.mjs 的临时地址提示（tr() 运行时匹配）。
export default {
  // ——— 离线提示条（lib/server.js offlineWhy）———
  '离线 · 这台设备没有网络；可浏览本地缓存，联网后自动重连': 'Offline · This device has no network. You can browse cached chats; it reconnects once you’re back online.',
  '连不上 · 服务器的临时地址可能已经变了：回家连上同一个 Wi-Fi 会自动更新，或在电脑上查看新地址': 'Can’t connect · The server’s temporary URL may have changed. Join the same Wi‑Fi as the computer to update it automatically, or check the new URL on the computer.',
  '离线 · 电脑那头没应答：可能睡眠、关机或退出了客户端；恢复后自动重连': 'Offline · The computer isn’t responding. It may be asleep, shut down, or the client was quit. It reconnects once it’s back.',
  '离线 · 电脑从 {time} 起没有应答：可能睡眠、关机或退出了客户端；恢复后自动重连': 'Offline · The computer hasn’t responded since {time}. It may be asleep, shut down, or the client was quit. It reconnects once it’s back.',
  '离线 · {time} 起连不上电脑：可能睡眠、关机或退出了客户端，也可能是网络不通；可浏览本地缓存，恢复后自动重连': 'Offline · Can’t reach the computer since {time}. It may be asleep, shut down, or the client was quit, or the network may be down. You can browse cached chats; it reconnects once things are back.',
  '离线 · 连不上电脑：网络不通，或服务器的临时地址变了；可浏览本地缓存，恢复后自动重连': 'Offline · Can’t reach the computer: either the network is down or the server’s temporary URL changed. You can browse cached chats; it reconnects once things are back.',
  '连不上 · 服务器的临时地址可能已经变了：到电脑上查看新地址，用新地址重新打开，或在设置里填新地址': 'Can’t connect · The server’s temporary URL may have changed. Check the new URL on the computer, then open it again or enter it in Settings.',
  '离线 · 连不上电脑：网络不通，或服务器的临时地址变了（变了要到电脑上查看新地址）；可浏览本地缓存': 'Offline · Can’t reach the computer: either the network is down or the server’s temporary URL changed (if so, check the new URL on the computer). You can browse cached chats.',
  // 服务端跑在服务器上（/api/auth 的 hosting === 'server'）时的说法
  '连不上 · 服务器的临时地址可能已经变了：回家连上同一个 Wi-Fi 会自动更新，或到服务器上查看新地址': 'Can’t connect · The server’s temporary URL may have changed. Join the same Wi‑Fi as the server to update it automatically, or check the new URL on the server.',
  '连不上 · 服务器的临时地址可能已经变了：到服务器上查看新地址，用新地址重新打开，或在设置里填新地址': 'Can’t connect · The server’s temporary URL may have changed. Check the new URL on the server, then open it again or enter it in Settings.',
  '离线 · 服务器从 {time} 起没有应答：可能在重启、关机或出了故障；恢复后自动重连': 'Offline · The server hasn’t responded since {time}. It may be restarting, shut down, or having a problem. It reconnects once it’s back.',
  '离线 · 服务器那头没应答：可能在重启、关机或出了故障；恢复后自动重连': 'Offline · The server isn’t responding. It may be restarting, shut down, or having a problem. It reconnects once it’s back.',
  '离线 · 连不上服务器：网络不通，或服务器的临时地址变了；可浏览本地缓存，恢复后自动重连': 'Offline · Can’t reach the server: either the network is down or the server’s temporary URL changed. You can browse cached chats; it reconnects once things are back.',
  '离线 · 连不上服务器：网络不通，或服务器的临时地址变了（变了要到服务器上查看新地址）；可浏览本地缓存': 'Offline · Can’t reach the server: either the network is down or the server’s temporary URL changed (if so, check the new URL on the server). You can browse cached chats.',
  '离线 · {time} 起连不上服务器：可能在重启、关机或出了故障，也可能是网络不通；可浏览本地缓存，恢复后自动重连': 'Offline · Can’t reach the server since {time}. It may be restarting, shut down, or having a problem, or the network may be down. You can browse cached chats; it reconnects once things are back.',

  // ——— 设置 · 关于 / 连接与更新 ———
  '签名不同，需卸载重装': 'Different signature — reinstall needed',
  '包名不同，不能覆盖安装': 'Different package — can’t update over it',
  '服务器上的这一版是另一个包名的 App（来自另一个发行渠道，或是自己编译的），装上会是另一个 App，不能用来更新这一个。要换用它，装好新的再卸载这个（本机缓存的聊天会清空，服务器上的数据不受影响）。': 'The build on the server is a different app package (it comes from another distribution channel, or was built by someone else). Installing it adds a separate app instead of updating this one. To switch, install it and then uninstall this app. Cached chats on this phone are cleared; data on the server isn’t affected.',
  '服务器没有可发的版本': 'No build on the server',
  'App 比服务器新': 'App is newer than the server',
  '地址类型': 'Address type',
  '临时地址（重启会换）': 'Temporary (changes on restart)',
  '固定地址': 'Fixed',
  '服务器用的是临时地址：电脑或服务重启后会换一个。App 会自动跟过去——在线时立即收到新地址，离线时回家连上同一个 Wi-Fi 就会更新。长期使用建议在服务器上绑定自己的域名。': 'The server uses a temporary URL, which changes when the computer or the service restarts. The app follows it automatically: right away if it’s online, or the next time you join the same Wi‑Fi at home. For long-term use, connect your own domain on the server.',
  '去发布页下载': 'Download from the release page',
  '服务器上的这一版和手机上的 App 签名不同（来自另一个发行渠道，或是自己编译的），不能覆盖安装。要换用它，先卸载手机上的 App 再装（本机缓存的聊天会清空，服务器上的数据不受影响）。': 'The build on the server is signed differently from the app on this phone (it comes from another distribution channel, or was built by someone else), so it can’t be installed over it. To switch, uninstall the app first and then install it. Cached chats on this phone are cleared; data on the server isn’t affected.',
  '这台服务器没有可发的 App 版本：手机 App 由你连着的服务器自己发，服务器那头放上安装包后这里就能更新。': 'This server has no app build to hand out. The phone app comes from the server you’re connected to; once the server has a build, you can update here.',
  '手机上的 App 比服务器新：照常能用，个别新功能要等服务器更新后才有。': 'The app on this phone is newer than the server. It works as usual; a few new features need the server to be updated first.',
  '服务器换了地址时 App 一般会自动跟过去（在家连上同一个 Wi-Fi 时最快）；没跟上、或要改连另一台服务器时，在这里填新地址。': 'When the server’s URL changes, the app usually follows it automatically (fastest when you’re on the same Wi‑Fi at home). If it didn’t, or you want to connect to a different server, enter the new URL here.',
  '临时地址：电脑或服务重启后会换一个。连过的手机 App 会自动跟过去（在线时立即收到，离线时回家连上同一个 Wi-Fi 就会更新）；网页和分享出去的链接要手动改。长期使用建议绑定自己的域名。': 'Temporary URL: it changes when the computer or the service restarts. Phone apps that have connected before follow it automatically (right away if online, otherwise the next time they join the same Wi‑Fi). Web pages and shared links need to be updated by hand. For long-term use, connect your own domain.',
  '手机 App': 'Phone app',
  '用手机相机扫码，下载和这台服务器同一版本的安卓 App；装好后打开 App 连这台服务器。': 'Scan with your phone’s camera to download the Android app that matches this server’s version. After installing, open the app and connect to this server.',
  '改用局域网地址': 'Use the LAN address',
  '改用公网地址': 'Use the public URL',

  // ——— 服务端控制台 · 公网访问 / 服务控制 ———
  '临时地址（试用，重启会换）': 'Temporary URL (trial, changes on restart)',
  '快速隧道一重启就换一个新地址，大约要等 20 秒：新地址连上后先推给在线的手机 App，它们会自动换过去，然后才停用旧地址；网页和分享出去的链接要手动改成新地址。': 'Restarting the quick tunnel gives it a new URL. It takes about 20 seconds: once the new one is up, it’s sent to phone apps that are online so they switch over automatically, and only then is the old URL retired. Web pages and shared links need to be updated by hand.',
  '正在换新地址，大约要等 20 秒…': 'Switching to a new URL. This takes about 20 seconds…',
  '已换成新地址': 'Switched to the new URL',
  '隧道已重启': 'Tunnel restarted',
  '不用注册，马上得到一个 https://….trycloudflare.com 地址，只适合试用：服务端或隧道每次重启都会换地址（连过的手机 App 会自动跟过去，网页和分享链接要手动改），Cloudflare 也不保证它的可用性。长期使用请换成自己的域名。': 'Get an https://….trycloudflare.com URL right away, no sign-up. It’s for trying things out: the URL changes every time the server or tunnel restarts (phone apps that have connected follow it automatically; web pages and shared links need updating by hand), and Cloudflare doesn’t guarantee its availability. For long-term use, switch to your own domain.',
  '手机 App 安装包 · 发布页缓存': 'Phone app build · cached from the release page',
  '手机 App 安装包 · 公开发布页': 'Phone app build · public release page',
  '手机 App 安装包 · 这台服务器没有可发的版本': 'Phone app build · none available on this server',

  // ——— 后端提示（src/runtime/public-access.mjs computeHint）———
  '临时地址只适合试用：免注册即可用，但服务端或隧道每次重启都会换一个新地址。连过的手机 App 会自动换到新地址（在线时立即收到推送；离线时回家连上同一个 Wi-Fi 就会更新），网页和分享出去的链接要手动改。长期使用建议绑定自己的域名（命名隧道）。': 'Temporary URLs are for trying things out: no sign-up needed, but the URL changes every time the server or tunnel restarts. Phone apps that have connected switch to the new URL automatically (instantly if online, or the next time they join the same Wi‑Fi). Web pages and shared links need updating by hand. For long-term use, connect your own domain (named tunnel).',
};
