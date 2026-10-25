// 英文界面文案 · 成员边界与号池份额（开源路线 S2-5 / S2-6 / S2-7）：管理员可见性、成员的高消耗功能、
// 媒体 / 视频次数额度、每人并发与定时任务数（键 = 中文原文，见 lib/i18n.js）
export default {
  // —— 管理员可见性（lib/adminAccess.js、desktop/settings/AdminAccessSection.svelte、Settings.svelte）——
  '管理员可见性': 'Admin visibility',
  '管理员的访问记录': 'Admin access history',
  '还没有记录': 'Nothing yet',
  '允许查看对话内容': 'Let the admin read my chats',
  'Claude 与 Gemini 的对话正文、生成的媒体、定时任务的提示词和结果': 'Claude and Gemini conversations, media you generated, and routine prompts and results',
  '允许代聊与代答': 'Let the admin act for me',
  '管理员可以在你的空间里代你发消息、替你回答提问和审批；代发的消息开头标着「【管理员代发】」。接着聊你自己的会话，还要你允许查看对话内容':
    'The admin can send messages in your space and answer questions and approvals for you. Messages they send start with a 【…】 tag marking them as sent by the admin. Continuing one of your own chats also needs permission to read your chats.',
  '允许查看我的电脑': 'Let the admin see my computer',
  '管理员可以对你登记的电脑截屏、读取系统信息或派发操作': 'The admin can take screenshots of your registered computer, read its system info, or send it actions.',
  '服主（管理员）默认只能看到你的会话标题、时间和用量。下面三项由你决定；管理员每次查看或代你操作，都会记在最下面。服主管理着这台服务器，技术上仍能读到服务器上的文件——这里约束的是控制台的默认行为。':
    'By default, the server’s admin can only see your chat titles, times, and usage. You decide the three items above, and every time the admin looks or acts for you, it’s logged below. The admin runs this server and can still technically read files on it; these settings control what the admin console does by default.',
  '查看了你的一段 Claude 对话': 'Viewed one of your Claude chats',
  '查看了你生成的媒体': 'Viewed media you generated',
  '查看了你的一段 Gemini 对话': 'Viewed one of your Gemini chats',
  '查看了你的定时任务内容': 'Viewed your routines’ contents',
  '以管理员身份在你的空间里代发了一条消息': 'Sent a message in your space as admin',
  '替你回答了一个提问或审批': 'Answered a question or approval for you',
  '查看或操作了你的电脑': 'Viewed or operated your computer',
  '服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。': 'By default the admin only sees your chat titles, times, and usage. Reading your chats requires your permission in Settings.',
  '管理员刚刚{what}。可在设置 › 账户 › 管理员的访问记录里查看。': 'Admin activity: {what}. See Settings › Account › Admin access history.',
  '连续 {n} 次': '{n} times in a row',
  // 桌面设置搜索（SettingsDesktop.svelte）
  '管理员 隐私 访问记录 查看 代聊 电脑': 'admin visibility privacy access history read act for me computer',

  // 服务端拒绝（src/runtime/admin-access.mjs，经 tr() 显示）
  '这个成员没有允许管理员查看对话内容（成员在自己的「设置 › 账户 › 管理员可见性」里打开后才能看）。': 'This member hasn’t allowed the admin to read their chats. They can turn it on in Settings › Account › Admin visibility.',
  '这个成员没有允许管理员代聊或代答（成员在自己的「设置 › 账户 › 管理员可见性」里打开后才能用）。': 'This member hasn’t allowed the admin to act for them. They can turn it on in Settings › Account › Admin visibility.',
  '这个成员没有允许管理员查看他的电脑（成员在自己的「设置 › 账户 › 管理员可见性」里打开后才能截屏或派操作）。': 'This member hasn’t allowed the admin to see their computer. They can turn it on in Settings › Account › Admin visibility.',
  '这个成员没有允许管理员查看对话内容，接着聊他的会话会读到里面的内容。可以接着聊你代发开的会话，或开新会话。':
    'This member hasn’t allowed the admin to read their chats, and continuing one of their chats would show you what’s in it. You can continue a chat you started for them, or start a new one.',
  '消息是空的': 'The message is empty.',

  // —— 控制台（SaUsers / SaSessions / SaRoutines / SaGensList）——
  '他允许管理员做什么': 'What they allow the admin to do',
  '看对话内容': 'Read chats',
  '代聊与代答': 'Act for them',
  '看他的电脑': 'See their computer',
  '已允许：{list}': 'Allowed: {list}',
  '只看得到元数据（会话标题、时间、用量）': 'Metadata only (chat titles, times, usage)',
  '由成员在自己的「设置 › 账户 › 管理员可见性」里决定；你每次查看内容、代聊代答或看他的电脑，他那边都有记录。服务账号默认全允许。':
    'Each member decides this in their own Settings › Account › Admin visibility. Every time you read their content, act for them, or look at their computer, it’s logged on their side. Service accounts allow everything by default.',
  '额度': 'Usage limits',
  '每天媒体次数': 'Media per day',
  '每天视频条数': 'Videos per day',
  '（内容未授权查看）': '(Content not shared with admin)',
  '这个成员没有允许你查看对话内容，这里只列标题和时间。': 'This member hasn’t allowed you to read their chats. Only titles and times are shown.',
  '这个成员没有允许代聊（在他自己的设置里打开）': 'This member hasn’t allowed you to act for them (they can turn it on in their Settings)',
  '代 {user} 发消息续聊…（Enter 发送，他那边会标「管理员代发」）': 'Continue as {user}… (Enter to send; on their side it starts with a 【…】 “sent by admin” tag)',
  '他没允许查看内容：只能接着聊你代发开的会话，或点「新会话」另开': 'They haven’t allowed you to read their chats. You can only continue chats you started for them, or select New session.',

  // —— 额度与注册（SaPolicy.svelte）——
  '每天最多生成几次图片、语音、音乐': 'Images, speech, and music per day',
  '每天最多生成几条视频': 'Videos per day',
  '次': 'times',
  '条': 'items',
  '每人同时最多几轮': 'Turns at once per person',
  '每人最多几条启用中的定时任务': 'Active routines per person',
  '改用推荐值': 'Use recommended',
  '改用推荐的额度？': 'Use the recommended limits?',
  '默认额度、全服与每人并发、每人定时任务数和成员的高消耗功能都换成推荐值（给别人用的服务器的稳妥起点）。单独给某个人设过的额度不受影响。':
    'Default limits, server-wide and per-person concurrency, routines per person, and members’ high-cost features all switch to the recommended values, a safe starting point for a shared server. Limits you set for individual people stay as they are.',
  '已改用推荐值': 'Switched to recommended limits',
  '{names} 手上有聊天快照，但还不是服务账号：改了之后它和它铸的快照也会按成员限额。给程序用的号请先到「用户」里标成服务账号。':
    'Open chat snapshots belong to accounts that aren’t service accounts: {names}. They and their snapshots would get member limits too. Mark accounts used by programs as service accounts on the Users page first.',
  '给程序用的号（例如 QQ 机器人）请先到「用户」里标成服务账号，否则它和它铸的聊天快照也会按成员限额。':
    'Mark accounts used by programs (such as a QQ bot) as service accounts on the Users page first, or they and their chat snapshots will get member limits too.',
  '留空或填 0 = 不限。Claude 对话、Gemini 对话和定时任务都算轮数；图片、语音、音乐、视频按次数另算。管理员不受限，服务账号不吃默认额度（要限就单独设）。':
    'Leave blank or enter 0 for no limit. Claude chats, Gemini chats, and routines all count as turns; images, speech, music, and video are counted separately. Admins aren’t limited, and service accounts skip the defaults (set limits for them individually).',
  '轮数在开跑时记（同时发几轮也绕不过去），花费按每轮结束时 Claude 报的金额、取这一轮新增的那部分记。某个人要多给或少给，到「用户」页他的「管理」里单独设。':
    'Turns count when they start, so sending several at once doesn’t get around the limit. Spending is recorded when each turn ends, counting only what that turn added. To give someone more or less, set it under Manage on the Users page.',
  '花费按 API 价估算：大家共用订阅号池时，它反映用了多少，不是真花出去的钱。': 'Spending is estimated at API prices. When everyone shares a subscription pool, it shows how much was used, not money actually spent.',
  '成员能用的高消耗功能': 'High-cost features for members',
  '快速模式（fast）': 'Fast mode',
  '同样的回答更快出来，但按更高的价格计用量': 'Same answers, faster, but usage is counted at a higher price',
  '常驻动态工作流，一轮会派一群子 agent，用量成倍增加；关着时降到 Extra': 'Always-on dynamic workflows that send out many subagents per turn and multiply usage. When off, it drops to Extra.',
  '1M 上下文': '1M context',
  '长对话超过 20 万 token 后按长上下文价格计；关着时到 20 万就自动压缩': 'Long chats past 200K tokens are counted at long-context prices. When off, chats compact automatically at 200K.',
  '生成图片、语音、音乐': 'Generate images, speech, and music',
  '媒体页和 Claude 的媒体工具，按次计到服务器的 Google Cloud 账单': 'The Media page and Claude’s media tools, billed per use to the server’s Google Cloud account',
  '生成视频': 'Generate video',
  'Veo 视频，单次花费最高': 'Veo video, the most expensive per use',
  '已对成员关闭': 'Turned off for members',
  '已对成员开放': 'Turned on for members',
  '只管注册用户（服务账号除外）；管理员自己与管理员代发的轮不受限。关掉的功能，成员那边按钮照常在，但发出去会按关着的处理。':
    'Applies to registered users only (not service accounts). The admin’s own turns and turns sent as admin aren’t limited. Members still see the controls, but turned-off features are treated as off when they send.',

  // —— 成员自己的额度（lib/me.js）——
  '今天的图片、语音、音乐': 'Images, speech, music today',
  '今天的视频': 'Videos today',
  '未开放': 'Not available',
  '{used} / {n} 次': '{used} / {n}',

  // —— 服务端额度提示（src/runtime/quota.mjs、routes/routines.mjs，经 tr() 显示）——
  '没有开放图片、语音和音乐生成': 'Image, speech, and music generation isn’t available',
  '没有开放视频生成': 'Video generation isn’t available',
  '这台服务器没有给成员开放图片、语音和音乐生成。需要更多额度请联系管理员。': 'This server hasn’t made image, speech, and music generation available to members. Contact your admin if you need more.',
  '这台服务器没有给成员开放视频生成。需要更多额度请联系管理员。': 'This server hasn’t made video generation available to members. Contact your admin if you need more.',
  '今天已经用了 {used} 次图片、语音和音乐，每天上限 {cap} 次，明天 0 点恢复。需要更多额度请联系管理员。': 'You’ve generated {used} of your {cap} daily images, speech, and music. It resets at midnight. Contact your admin if you need more.',
  '今天已经用了 {used} 条视频，每天上限 {cap} 条，明天 0 点恢复。需要更多额度请联系管理员。': 'You’ve generated {used} of your {cap} daily videos. It resets at midnight. Contact your admin if you need more.',
  '每人最多 {cap} 条启用中的定时任务。先停用或删掉一条再加。': 'Each person can have up to {cap} active routines. Turn one off or delete one first.',
};
