// 英文界面文案 · model-hub-chatgpt（模型中心的「ChatGPT 订阅」服务：添加页的登录面板 HsChatgptLogin、账号面板 HsChatgptConn、
// chatgptKit 的状态与报错、首页行上的提醒）（键 = 中文原文，见 lib/i18n.js）
// 套餐额度 = Plan usage（GLOSSARY「订阅额度 / 账号额度」）；「Continue with ChatGPT」是官方规范的按钮文案，源码里直接写英文
export default {
  // —— 入口与登录面板 ——
  'ChatGPT 订阅': 'ChatGPT plan',
  '登录即用，不用 Key': 'Sign in, no key needed',
  'ChatGPT 订阅：登录账号用套餐额度，不用 API Key': 'ChatGPT plan: sign in and use your plan usage, no API key needed',
  '登录 ChatGPT 账号，用它的套餐额度给 Claude、dimensio、Codex 调模型，不用 API Key。':
    'Sign in with your ChatGPT account and let Claude, dimensio and Codex use its plan usage. No API key needed.',
  '套餐额度与 ChatGPT、Codex 共用；需要 Plus / Pro 等付费套餐。': 'Plan usage is shared with ChatGPT and Codex. Requires a paid plan such as Plus or Pro.',
  '用 {email} 重新登录一次，额度就能接着用。': 'Sign in again as {email} to keep using its plan usage.',
  '再登录一个 ChatGPT 账号：一个账号额度用完时自动换下一个。': 'Sign in with another ChatGPT account. When one runs out of usage, the next one takes over.',
  '改用 API Key 接入': 'Use an API key instead',
  '正在打开登录页…': 'Opening the sign-in page…',
  '在打开的页面里登录并同意': 'Sign in and allow access on the page that opened',
  '正在完成登录…': 'Finishing sign-in…',
  '{n} 分钟内有效': { one: 'Expires in {n} minute', other: 'Expires in {n} minutes' },
  '请用 {email} 登录。': 'Sign in as {email}.',
  '登录后浏览器停在打不开的 127.0.0.1 页面？把地址栏整段复制到这里':
    'Browser stuck on a 127.0.0.1 page that won’t load after signing in? Copy the whole address bar here',
  '登录已过期，重新开始一次': 'Sign-in expired. Start again.',
  '你正在使用 ChatGPT 套餐额度': 'You’re using your ChatGPT plan usage',
  '在 ChatGPT 设置里管理用量': 'Manage usage in ChatGPT settings',
  '这个账号没有能用的模型': 'This account has no models available',

  // —— 登录报错（chatgptKit.loginErrText / pasteProblem）——
  '你在登录页拒绝了授权': 'You declined access on the sign-in page',
  '这个账号没开通套餐额度授权': 'This account hasn’t granted access to its plan usage',
  '这个账号不能用套餐额度（需要付费套餐）': 'This account can’t use plan usage (a paid plan is required)',
  '登录已过期': 'Sign-in expired',
  '登录没有完成': 'Sign-in didn’t finish',
  '先把地址粘贴进来': 'Paste the address first',
  '这不像登录后停住的那个地址：要从地址栏整段复制，以 http://127.0.0.1 开头':
    'That doesn’t look like the address you were left on. Copy the whole address bar; it starts with http://127.0.0.1',

  // —— 账号面板（HsChatgptConn）与账号状态 ——
  'ChatGPT 账号': 'ChatGPT account',
  '多个账号的用法': 'Account rotation',
  '重新登录': 'Sign in again',
  '启用这个账号': 'Enable this account',
  '至少要留一个账号；不用了就删除服务': 'Keep at least one account. To stop using it, delete the provider.',
  '添加 ChatGPT 账号': 'Add ChatGPT account',
  '管理用量': 'Manage usage',
  '移除账号「{name}」？': 'Remove account “{name}”?',
  '这个账号的登录凭据会一并作废，之后要用得重新登录。': 'Its sign-in will be revoked. You’ll need to sign in again to use it.',
  '已移除账号': 'Account removed',
  '已添加 {email}': 'Added {email}',
  '{email} 已重新登录': '{email} signed in again',
  '需要重新登录': 'Needs to sign in again',
  '凭据丢失，需要重新登录': 'Sign-in is missing. Sign in again.',
  '没授权套餐额度': 'Plan usage not granted',
  '{email} 等 {n} 个账号': { one: '{email}', other: '{email} and {n} accounts' },

  // —— 首页行上的提醒 ——
  '要重新登录': 'Sign in again',
  '{n} 个账号要重新登录': { one: '{n} account needs to sign in again', other: '{n} accounts need to sign in again' },
  '{n} 个账号没授权套餐额度': { one: '{n} account hasn’t granted plan usage', other: '{n} accounts haven’t granted plan usage' },
  '账号已全部停用': 'All accounts disabled',
  '{n} 个账号冷却中': { one: '{n} account cooling down', other: '{n} accounts cooling down' },

  // —— 服务端发来、经 tr() 显示的（runtime/model-hub/chatgpt 的账号状态与登录报错）——
  '这个账号的登录凭据不见了，请重新登录': 'This account’s sign-in is missing. Sign in again.',
  '这个账号没有授权使用 ChatGPT 套餐额度，请重新登录并同意': 'This account hasn’t granted access to its ChatGPT plan usage. Sign in again and allow it.',
  '没有这次登录（可能已过期），请重新开始': 'This sign-in no longer exists (it may have expired). Start again.',
  '这个 ChatGPT 订阅服务已经被删掉了': 'This ChatGPT plan provider has been deleted',
  '没有这个 ChatGPT 订阅服务': 'No such ChatGPT plan provider',
  '这个账号已经从服务里删掉了': 'This account has been removed from the provider',
  '这个服务里没有这个账号': 'This provider has no such account',
  '这次登录是给已有服务加账号的，不能用来新建服务': 'This sign-in was for adding an account to an existing provider and can’t create a new one',
  '这次登录失败了': 'This sign-in failed',
  '还没登录完成': 'Sign-in isn’t finished yet',
};
