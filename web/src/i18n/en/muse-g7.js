// 英文界面文案 · Muse Bridge 第六次同步时改写过的句子（本体原句带设备 / 号池 / 浏览器 / 媒体等 Muse 没有的东西，改写后另立键）
export default {
  // —— 服务端控制台 · 用户 / 给别人用 ——
  '马上收回命令行：他正在跑的对话会中止，侧栏终端关掉。账号、对话和文件都保留，以后可以再升回来。':
    'The command line is removed right away: their running chats stop and the side terminal closes. The account, chats, and files are kept, and you can upgrade them again later.',
  '他会立刻被登出、在跑的对话会中止，他发出去的聊天快照链接也会关掉；数据都保留，重新启用后就能照常登录。':
    'They’re signed out right away, their running chats stop, and chat snapshot links they shared are turned off. Their data is kept, and they can sign in again once you re-enable the account.',
  '由成员在自己的「设置 › 账户 › 管理员可见性」里决定；你每次查看内容或代聊代答，他那边都有记录。服务账号默认全允许。':
    'Members decide this in Settings → Account → Admin visibility. Each time you view their content or chat and answer for them, it’s recorded on their side. Service accounts allow everything by default.',
  '他会立刻被登出；在跑的对话中止，他铸的聊天快照、用过的邀请记录和用量一并删除。这个账号 id 以后不再使用：同名的人重新注册，拿不到他的任何东西。':
    'They’re signed out right away. Running chats stop, and their chat snapshots, used invite records, and usage are deleted. This account ID is never reused, so someone who signs up with the same name gets nothing from this account.',
  '只改登录用的名字：他的对话、文件、用量都跟着账号走，不受影响。他下次登录要用新名字。':
    'Only the sign-in name changes. Their chats, files, and usage stay with the account. They’ll sign in with the new name next time.',
  '这台服务端没有守护进程托管：请在服务器上手动重启': 'No supervisor manages this server. Restart it manually on the server.',

  // —— 服务端控制台 · 额度与注册 / 服务控制 ——
  '留空或填 0 = 不限。额度只算 Claude（Claude 对话和定时任务都算轮数），dimensio 不计；管理员不受限，服务账号不吃默认额度（要限就单独设）。':
    'Leave blank or enter 0 for no limit. Limits only count Claude (Claude chats and routines count as turns); dimensio isn’t counted. Admins have no limit, and service accounts don’t use the default limits (set them individually if needed).',
  '给谁用、监听地址等默认值按部署形态定；显式设置优先': 'Defaults such as who can use it and the listen address follow the deployment type. Explicit settings take priority.',
  '由 {name} 托管 · 资源 · 日志': 'Managed by {name} · Resources · Logs',

  // —— 档位叫法：Muse 沿用「Pro」（本体改叫「完全信任」）——
  '作废这些老的 Pro 邀请码？': 'Revoke these old Pro invite codes?',
  '全部确认保留 Pro？': 'Keep Pro for all of them?',
  '升级前发的 Pro 邀请码': 'Pro invite codes from before the upgrade',
  '原生 Windows 只能做到逻辑隔离；进程隔离、容器隔离（Linux）还没接入，接入后 Pro 档才会被关进沙箱。': 'Native Windows only supports logical isolation. Process and container isolation (Linux) aren’t available yet; once they are, Pro accounts will run in a sandbox.',
  'Pro 档：有命令行和终端，跑在服务端同一个系统账户下，能读到服务器上所有人的对话、文件和全部凭据（Claude 登录凭据、各家 API Key），等同管理员——只给你完全信任的人。': 'Pro: a command line and terminal, running under the same system account as the server. It can read every user’s chats, files, and all credentials on the server (Claude sign-in credentials and API keys), the same as an admin. Only give it to people you fully trust.',
  '待确认的 Pro 账号': 'Pro accounts to confirm',
  '打开后可以发邀请码、让别人注册账号。每人有自己的目录和对话，但这台服务端只有「逻辑隔离」：普通档（没有命令行）的人彼此看不到；Pro 档的人能读到服务器上所有人的数据和全部凭据，等同管理员。邀请码默认只发普通档。重启服务端后生效。': 'Once on, you can send invite codes and let others sign up. Everyone gets their own folder and chats, but this server only has logical isolation: Standard accounts (no command line) can’t see each other, while Pro accounts can read everyone’s data and all credentials on the server, the same as an admin. Invite codes are Standard by default. Takes effect after the server restarts.',
  '还有 {n} 张升级前发的 Pro 邀请码没用': { one: '{n} unused Pro invite code from before the upgrade', other: '{n} unused Pro invite codes from before the upgrade' },
  '这些 Pro 账号是升级前开的，还没确认过「等同管理员」，不会自动降级。逐个确认保留，或在「管理」里降为普通。': 'These Pro accounts were created before the upgrade and haven’t been confirmed as admin-equivalent. They won’t be downgraded automatically. Confirm each one, or change it to Standard under “Manage”.',
  '{name} 已升为 Pro': '{name} is now Pro',
  '升级前发的 Pro 码：不过期，用它注册立刻就有命令行、等同管理员。不再需要就作废。': 'A Pro code from before the upgrade: it never expires, and signing up with it gives a command line right away, the same as an admin. Revoke it if you no longer need it.',
  '发 Pro 邀请码？': 'Create a Pro invite code?',
  'Pro 档有命令行和终端，跑在服务端同一个系统账户下：能读到服务器上所有人的对话、文件和全部凭据（Claude 登录凭据、各家 API Key），等同管理员。只给你完全信任的人。': 'Pro accounts get a command line and terminal and run under the same system account as the server. They can read every user’s chats, files, and all credentials on the server (Claude sign-in credentials and API keys), the same as an admin. Only give it to people you fully trust.',
  '建一个 Pro 账号？': 'Create a Pro account?',
  '我了解，给 Pro': 'I understand, give Pro',
  '把 {name} 升为 Pro？': 'Upgrade {name} to Pro?',
  '升级前开的 Pro 账号，等你确认': 'A Pro account created before the upgrade. Waiting for you to confirm.',
  '确认 {name} 保留 Pro？': 'Keep Pro for {name}?',
  '确认保留 Pro': 'Keep Pro',
  '＋ Pro 邀请码': '＋ Pro invite',

  // —— 设置 · Claude / 模型服务 / 账户 · 管理员可见性（Muse 设置外壳）——
  '终端里的 Claude 或这台服务器上别的会话发给这里的消息': 'Messages sent here by Claude in a terminal or by other sessions on this server',
  '打开后，新会话可以选「绕过权限」：Claude 改文件、跑命令都不再问你。只在你清楚后果的环境里用。':
    'Once on, new sessions can use “Bypass permissions”: Claude edits files and runs commands without asking you. Only use it where you understand the consequences.',
  '登录后才能改 Claude 的设置': 'Sign in to change Claude settings',
  '会话里可以单独改：模式在输入框旁的模式菜单，输出风格在会话菜单里。': 'You can change these per session: the mode in the mode menu next to the composer, and the output style in the session menu.',
  '新会话在独立的 git 工作树里干活，不动你当前的分支（这台设备）': 'New sessions work in a separate git worktree and leave your current branch alone (this device)',
  '清空': 'Clear',
  '这三项只管这台设备。': 'These three apply to this device only.',
  '只有管理员能改这里，对这台服务器上所有人生效。': 'Only admins can change these. They apply to everyone on this server.',
  '加好的模型出现在 Claude 页的模型菜单里，和官方模型并列；每个服务可以单独停用或从菜单里隐藏。':
    'Models you add appear in the Claude model menu next to the official models. Each provider can be turned off or hidden from the menu.',
  '读不到模型服务': 'Couldn’t load model providers',
  '只有管理员能管理模型服务': 'Only admins can manage model providers',
  'Claude 的对话正文、定时任务的提示词和结果': 'Claude chat content, and routine prompts and results',
  '服主（管理员）默认只能看到你的会话标题、时间和用量。下面两项由你决定；管理员每次查看或代你操作，都会记在最下面。服主管理着这台服务器，技术上仍能读到服务器上的文件——这里约束的是控制台的默认行为。':
    'By default, the server owner (admin) can only see your session titles, times, and usage. You decide the two options below, and every time the admin views or acts for you, it’s logged at the bottom. The owner runs this server and can still technically read files on it; these settings control what the admin console does by default.',

  // —— 设置搜索的同义词（只用于匹配，英文界面下照样能搜到）——
  '管理员 隐私 访问记录 查看 代聊': 'admin privacy access log view chat on behalf',
  '限额 额度 5 小时 自动继续 续跑': 'limit quota 5-hour auto continue resume',
  '权限 模式 默认 自动 计划 接受编辑 permission': 'permission mode default auto plan accept edits',
  '输出 风格 简洁 解释 学习 output style': 'output style concise explanatory learning',
  '工作流 子 agent 并行 workflow ultracode': 'workflow subagent parallel ultracode',
  '拦截 拒绝 换模型 refusal': 'blocked refusal switch model',
  '提问 超时 等待 question': 'question timeout wait',
  '语言 中文 英文 回复 language': 'language chinese english reply',
  '会话 协作 子会话 新会话 提议': 'session collaboration child session new session proposal',
  'git 分支 工作树 worktree branch': 'git branch worktree prefix',
  'PR 拉取请求 CI auto-fix github': 'PR pull request CI auto-fix github',
  '署名 提交 commit co-authored': 'attribution commit co-authored',
  '归档 会话 不活跃 archive': 'archive session inactive',
  '通知 提醒 权限请求 提问 任务完成': 'notification permission request question task complete',
  '模型服务 自定义 API DeepSeek Kimi OpenRouter 兼容 端点 provider': 'model provider custom API DeepSeek Kimi OpenRouter compatible endpoint',
  'agent 接入 地址 入口 api': 'agent access address endpoint api',
  'agent 密钥 key 令牌 生成': 'agent key token create',
  'agent 密钥 吊销 过期': 'agent key revoke expire',
  '升为 Pro（给命令行）': 'Upgrade to Pro (shell access)',
  'Pro（有命令行）': 'Pro (shell access)',
  'Pro（有命令行）单次邀请码，注册时填入：': 'Single-use Pro invite code (shell access). Enter it when signing up:',
  '邀请码 7 天内有效，没用的可以作废；Pro 码要你确认后才发，默认只发普通档。删掉的账号 id 不再复用：同名的人重新注册拿不到旧人的任何东西。': 'Invite codes are valid for 7 days, and you can revoke unused ones. Pro codes are only created after you confirm; invites are Standard by default. Deleted account IDs are never reused, so someone who signs up with the same name gets nothing from the old account.',

  // —— 控制台 · 服务控制（本体字典 server.js 里的原句，Muse 的 server.js 没带）——
  '现在有 {n} 轮对话在跑，不会被打断。': {
    one: '{n} turn is running right now and won’t be interrupted.',
    other: '{n} turns are running right now and won’t be interrupted.',
  },
  '等空闲中：还有 {n} 轮在跑，跑完就更新并重启（最多等 30 分钟）': {
    one: 'Waiting for idle: {n} turn still running. The server updates and restarts once it finishes (waits up to 30 minutes).',
    other: 'Waiting for idle: {n} turns still running. The server updates and restarts once they finish (waits up to 30 minutes).',
  },
  '要切换，在 Muse 里说「改成多人用」或「改成自己用」。': 'To switch, tell Muse “switch to multi-user” or “switch to just me”.',
};
