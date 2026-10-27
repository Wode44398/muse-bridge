// 英文界面文案 · 扫码配对（开源路线 S1-2：电脑出码、手机扫码换自己的会话）
// 来源：lib/connectPair.js、components/PairScan.svelte（配对码那一半）、components/ServerConfig.svelte（App 首屏）、
// components/pairing/*（出示卡、控制台卡）、两套设置页与登录框里的入口；以及服务端 routes/pair.mjs、runtime/pair-connect.mjs
// 回到界面的报错（tr() 运行时匹配）。
export default {
  // ——— App 首屏（ServerConfig）———
  '连接你的 bridge 服务器': 'Connect to your bridge server',
  '在已经登录 bridge 的电脑上出示配对二维码，用这台手机扫一下就连上了：':
    'Show a pairing QR code on a computer that’s signed in to bridge, then scan it with this phone to connect:',
  '桌面客户端：「设置 › 连接与更新 › 手机扫码连接」，本机服务端的托盘「访问信息」里也有':
    'Desktop app: Settings › Connection & updates › Connect a phone, or Access details in the local server’s tray menu',
  '网页版：「设置 › 关于 › 让另一台设备扫码连接」': 'Web version: Settings › About › Let another device scan to connect',
  '装在 Linux 上的服务器：在服务器终端运行 bridgectl pair': 'Server installed on Linux: run bridgectl pair in a terminal on the server',
  '扫码连接': 'Scan to connect',
  '手动填写地址（有账号密码 / 配对码）': 'Enter the address manually (with a username and password, or a pairing code)',
  '或者手动填写': 'Or enter it manually',
  '服务器地址，如 192.168.1.5:8787': 'Server address, e.g. 192.168.1.5:8787',
  '8 位配对码（也可填访问令牌）': '8-digit pairing code (or an access token)',
  '配对码和地址显示在电脑上的二维码旁边，3 分钟内有效。不填配对码也能先连上，进去再登录。':
    'The pairing code and address are shown next to the QR code on your computer and are valid for 3 minutes. You can also leave the code blank, connect first and sign in afterwards.',

  // ——— 扫码层（PairScan）———
  '对准电脑上显示的配对二维码': 'Point at the pairing QR code on your computer',
  '对准网页登录页或电脑上的二维码': 'Point at the QR code on the web sign-in page or on your computer',
  '这不是 The Bridge 的配对二维码': 'This isn’t a The Bridge pairing QR code',
  '这是网页的登录二维码：先连上服务器并登录，再扫它': 'This is a web sign-in QR code. Connect to the server and sign in first, then scan it.',
  '连接这台手机': 'Connect this phone',
  '这台手机将连到下面这台服务器，并以出示二维码的那个账号登录；现在的登录会被替换。':
    'This phone will connect to the server below and sign in as the account that showed the QR code. Your current sign-in will be replaced.',
  '这台手机将连到下面这台服务器，并以出示二维码的那个账号登录。':
    'This phone will connect to the server below and sign in as the account that showed the QR code.',
  '只扫你自己电脑上显示的二维码。': 'Only scan QR codes shown on your own computer.',
  '用配对码登录': 'Sign in with a pairing code',
  '这个浏览器将以出示二维码的那个账号登录。': 'This browser will sign in as the account that showed the QR code.',
  '这个浏览器将改为以出示二维码的那个账号登录；现在的登录（{ident}）会被退出。':
    'This browser will switch to the account that showed the QR code. Your current sign-in ({ident}) will be signed out.',
  '只有你刚用这台设备扫了自己电脑上的二维码时才点「连接」；别人发来的链接请点「取消」。':
    'Only tap Connect if you just scanned a QR code on your own computer with this device. If someone sent you this link, tap Cancel.',
  '正在连接…': 'Connecting…',
  '已连接': 'Connected',
  '以管理员身份登录了 {host}。': 'Signed in to {host} as admin.',
  '以 {user} 的身份登录了 {host}。': 'Signed in to {host} as {user}.',

  // ——— 兑换失败 / 网页落地（lib/connectPair.js）———
  '连不上二维码里的地址：手机和电脑在同一个 Wi-Fi 吗？电脑上的 bridge 开着吗？':
    'Couldn’t reach the address in the QR code. Are your phone and computer on the same Wi-Fi, and is bridge running on the computer?',
  '这个地址上的不是出码的那台服务器（局域网里可能有别的 bridge），没有把配对码发过去':
    'The server at this address isn’t the one that showed the code (there may be another bridge on your network), so the pairing code wasn’t sent.',
  '配对码已过期或已用过，请在电脑上刷新后重试': 'The pairing code has expired or was already used. Refresh it on your computer and try again.',
  '尝试次数过多，请稍后再试': 'Too many attempts. Try again later.',
  '服务端版本太旧，不支持扫码配对': 'This server is too old for QR pairing',
  '访问令牌不对。要填配对码的话，配对码是电脑上二维码旁边的 8 位数字':
    'That access token isn’t right. If you meant to enter a pairing code, it’s the 8-digit number next to the QR code on your computer.',
  '配对码是 8 位数字，请对照电脑上显示的配对码重新输入': 'The pairing code has 8 digits. Check the code on your computer and enter it again.',

  // ——— 出示卡（ConnectQr）与入口 ———
  '手机扫码连接': 'Connect a phone',
  '显示配对二维码': 'Show pairing QR code',
  '收起二维码': 'Hide QR code',
  '手机 App 首屏「扫码连接」扫一下就连上这台服务器，并以你现在的身份登录；不用抄地址和令牌。':
    'Tap Scan to connect on the phone app’s first screen to connect to this server and sign in as you, without copying addresses or tokens.',
  '以管理员身份登录': 'Signs in as admin',
  '以 {user} 的身份登录': 'Signs in as {user}',
  '撤销失败': 'Couldn’t revoke',
  '已撤销': 'Revoked',
  '已连接：{device}': 'Connected: {device}',
  '再连一台': 'Connect another',
  '不是你？撤销': 'Not you? Revoke',
  '已撤销这次连接': 'This connection was revoked',
  '那台设备刚拿到的登录已经作废。': 'The sign-in that device just received no longer works.',
  '要收回那台设备的登录：去控制台「管理员登录」或「设备」里单独吊销。':
    'To take back that device’s sign-in, revoke it in the admin console under Admin sign-in or Devices.',
  '要收回那台设备的登录：在「设置 › 账户」改一次密码，别的设备上的登录会全部下线。':
    'To take back that device’s sign-in, change your password in Settings › Account. That signs out all your other devices.',
  '重新出码': 'New code',
  '没出成二维码': 'Couldn’t create a QR code',
  '{t} 后换新码': 'New code in {t}',
  '这台服务器只允许本机访问，手机连不上：先打开公网访问，或允许局域网连接，再出码。':
    'This server only accepts connections from this computer, so phones can’t reach it. Turn on public access or allow LAN connections, then show the code again.',
  '手机会连到 {host}': 'The phone will connect to {host}',
  '用手机上的 The Bridge App 扫码（首屏「扫码连接」）；没装 App 用相机扫，也能直接打开网页版。没有相机就在 App 里填地址和配对码。':
    'Scan it with The Bridge app on your phone (Scan to connect on the first screen). Without the app, scanning with the camera opens the web version. No camera? Enter the address and pairing code in the app.',
  '只给你自己的设备扫：扫到的人会以你的身份登录。': 'Only let your own devices scan it. Whoever scans it is signed in as you.',
  '只给你自己的设备扫：扫到的人会以你的身份登录。3 分钟内有效，只能用一次。':
    'Only let your own devices scan it. Whoever scans it is signed in as you. Valid for 3 minutes, one-time use.',
  '扫码连接服务器': 'Scan to connect to a server',
  '让另一台设备扫码连接': 'Let another device scan to connect',
  '显示二维码': 'Show QR code',
  '二维码 配对码 手机 扫码 连接 App': 'QR code pairing code phone scan connect app',

  // ——— 控制台「接入新手机」（SaPairCard）———
  '接入新手机': 'Connect a new phone',
  '手机 App 首屏「扫码连接」扫一下就连上这台服务器，以管理员身份登录；不用抄地址和访问令牌。':
    'Tap Scan to connect on the phone app’s first screen to connect to this server and sign in as admin, without copying addresses or the access token.',
  '兑换失败': 'Failed attempt',
  '触发限流': 'Rate limited',
  '配对码不对': 'Wrong pairing code',
  '二维码无效': 'Invalid QR code',
  '出码的登录已失效': 'The sign-in that showed the code is no longer valid',
  '同一来源失败太多，封 15 分钟': 'Too many failures from one source, blocked for 15 minutes',
  '数字配对码失败太多，暂停 10 分钟': 'Too many wrong pairing codes, codes paused for 10 minutes',
  '另有 {n} 次失败没有逐条记录': { one: '{n} more failed attempt not logged individually', other: '{n} more failed attempts not logged individually' },

  // ——— 服务端报错（routes/pair.mjs、runtime/pair-connect.mjs，tr() 运行时匹配）———
  '只有登录的账号能出配对码': 'Only signed-in accounts can create pairing codes',
  '配对码领得太频繁，请稍后再试': 'Pairing codes are being created too often. Try again later.',
  '尝试次数过多，请 15 分钟后再试': 'Too many attempts. Try again in 15 minutes.',
  '数字配对码暂时停用（失败太多），请改用扫码，或 10 分钟后再试': 'Pairing codes are paused after too many failures. Scan the QR code instead, or try again in 10 minutes.',
  '配对码不对或已过期，请看电脑上显示的最新配对码': 'Wrong or expired pairing code. Check the latest code on your computer.',
  '配对二维码无效，请在电脑上刷新后重扫': 'This pairing QR code is invalid. Refresh it on your computer and scan again.',
  '配对码已过期，请在电脑上刷新后重试': 'The pairing code has expired. Refresh it on your computer and try again.',
  '这个配对码已经用过或被作废了，请在电脑上刷新后重试': 'This pairing code was already used or cancelled. Refresh it on your computer and try again.',
  '出示这个配对码的登录已失效，请在电脑上重新登录后再出码': 'The sign-in that showed this pairing code is no longer valid. Sign in again on your computer and show a new code.',
  '发放登录失败：{reason}': 'Couldn’t issue a sign-in: {reason}',
  '发放登录失败': 'Couldn’t issue a sign-in',
  '这个实例只允许本机访问，用不着配对': 'This instance only accepts connections from this computer, so it doesn’t need pairing',
  '这次配对已经撤销不了了：去「管理员登录」或「设备」里单独吊销那台设备': 'This pairing can no longer be revoked here. Revoke that device under Admin sign-in or Devices.',
  '这次配对已经撤销不了了：在「设置 › 账户」改一次密码，别的设备上的登录会全部下线':
    'This pairing can no longer be revoked here. Change your password in Settings › Account to sign out all your other devices.',
  '{label}（扫码配对）': '{label} (QR pairing)',
};
