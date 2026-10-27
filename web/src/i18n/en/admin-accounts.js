// 英文界面文案 · 服务端控制台「用户」页：给别人用（多用户开关）、隔离等级、完全信任档、账号生命周期（开源路线 S2-2 / S2-3 / S2-4）
// 键 = 中文原文（见 lib/i18n.js）。后半段是这几项功能的服务端报错（tr() 显示在这几页的 toast 里）。
// 档位译名：普通 = Standard（沿用），完全信任 = Full trust（2026-10-22 起取代 Pro）。
export default {
  // —— 给别人用 / 隔离等级（SaAccess.svelte）——
  '给别人用': 'Sharing',
  '开放给其他人使用（多用户）': 'Let other people use this server (multi-user)',
  '开放给其他人使用？': 'Let other people use this server?',
  '打开后可以发邀请码、让别人注册账号。每人有自己的目录和对话，但这台服务端只有「逻辑隔离」：普通档（没有命令行）的人彼此看不到；完全信任档的人能读到服务器上所有人的数据和全部凭据，等同管理员。邀请码默认只发普通档。重启服务端后生效。':
    'You’ll be able to create invite codes so others can sign up. Each person gets their own folder and chats, but this server only has logical isolation: Standard users (no shell) can’t see each other, while Full trust users can read everyone’s data and every credential on the server, the same as an admin. Invites are Standard by default. Takes effect after the server restarts.',
  '打开多用户': 'Turn on',
  '只给自己用？': 'Keep this server to yourself?',
  '关掉后普通账号都登不上了（服务账号除外），已有账号和数据都保留，以后再打开就恢复。重启服务端后生效。':
    'Regular accounts won’t be able to sign in (service accounts still can). Existing accounts and data are kept, and everything comes back if you turn this on again. Takes effect after the server restarts.',
  '关掉': 'Turn off',
  '已保存，重启服务端后生效': 'Saved. Takes effect after the server restarts.',
  '已打开，重启服务端后生效': 'Turned on. Takes effect after the server restarts.',
  '已关闭，重启服务端后生效': 'Turned off. Takes effect after the server restarts.',
  '开着：可以发邀请码、让别人注册；每人有自己的目录和对话': 'On: you can create invite codes for others to sign up. Each person gets their own folder and chats.',
  '关着：只有你（访问令牌 / 扫码）和服务账号能登录': 'Off: only you (access token / QR code) and service accounts can sign in.',
  '重启服务端': 'Restart the server',
  '等没有在跑的对话时自动重启（最多等 30 分钟）': 'Restarts automatically once no chats are running (waits up to 30 minutes).',
  '这台服务端没有守护进程托管：请在托盘里重启本机服务端，或在服务器上手动重启': 'No supervisor manages this server. Restart the local server from the tray, or restart it manually on the server.',
  '空闲时重启': 'Restart when idle',
  '隔离等级：{level}': 'Isolation level: {level}',
  '逻辑隔离': 'Logical isolation',
  '进程隔离': 'Process isolation',
  '容器隔离': 'Container isolation',
  '普通档：没有命令行，Claude 只能在他自己的目录里读写，看不到别人的对话和文件——可以放心发。':
    'Standard: no shell. Claude can only read and write in that person’s own folder and can’t see anyone else’s chats or files. Safe to hand out.',
  '完全信任档：有命令行、终端和浏览器，跑在服务端同一个系统账户下，能读到服务器上所有人的对话、文件和全部凭据（号池令牌、各家 API Key），等同管理员——只给你完全信任的人。':
    'Full trust: shell, terminal, and browser, all running under the server’s own system account. They can read everyone’s chats, files, and every credential on the server (pool tokens, API keys), the same as an admin. Give it only to people you fully trust.',
  '原生 Windows 只能做到逻辑隔离；进程隔离、容器隔离（Linux）还没接入，接入后完全信任档才会被关进沙箱。':
    'Native Windows can only provide logical isolation. Process and container isolation (Linux) aren’t available yet; until they are, Full trust isn’t sandboxed.',
  '进程隔离、容器隔离还没接入：现在的 Docker 镜像里所有成员也是同一个系统用户，只把成员和宿主隔开了。':
    'Process and container isolation aren’t available yet. In the current Docker image every member runs as the same system user, so members are isolated from the host but not from each other.',
  '进程隔离、容器隔离还没接入：所有成员和服务端跑在同一个系统账户下，彼此之间只有逻辑隔离。':
    'Process and container isolation aren’t available yet. Every member runs under the same system account as the server, so they’re only logically isolated from each other.',
  // 升级前发的、还没用的完全信任（Pro）码
  '升级前发的完全信任邀请码': 'Older Full trust invite codes',
  '还有 {n} 张升级前发的完全信任邀请码没用': '{n} older Full trust invite codes haven’t been used',
  '这些码不会过期，发的时候也没经过「等同管理员」的确认：谁拿到都能注册出有命令行、能读到所有人数据和凭据的账号。不再需要就作废。':
    'These codes never expire and were created without confirming that Full trust is the same as admin. Anyone who has one can sign up for an account with shell access that can read everyone’s data and credentials. Revoke them if you no longer need them.',
  '全部作废': 'Revoke all',
  '作废这些老的完全信任邀请码？': 'Revoke these older Full trust invite codes?',
  '作废后这 {n} 张码就不能再注册了；已经用它们注册的账号不受影响。要给人发码，重新生成（新码 7 天内有效、默认普通档）。':
    'These {n} codes will no longer work for sign-up. Accounts already created with them aren’t affected. To invite someone, create a new code (new codes are valid for 7 days and Standard by default).',
  '有 {n} 张没作废成功': '{n} codes couldn’t be revoked',
  '待确认的完全信任账号': 'Full trust accounts to review',
  '这些账号是改名「完全信任」之前开的（Pro 档或没写档位），不会自动降级。逐个确认保留，或在「管理」里降为普通。':
    'These accounts were created before the tier was renamed Full trust (Pro, or no tier set). They won’t be downgraded automatically. Confirm each one, or downgrade it to Standard under “Manage”.',
  '全部确认保留完全信任？': 'Keep Full trust for all of them?',
  '{names} 会继续有命令行，能读到服务器上所有人的数据和全部凭据。只确认你完全信任的人；不确定的，在下面他的「管理」里降为普通。':
    '{names} will keep shell access and can read everyone’s data and every credential on the server. Only confirm people you fully trust; for anyone you’re unsure about, downgrade them to Standard under “Manage” below.',
  '全部确认': 'Confirm all',
  '已确认': 'Confirmed',
  // 「额度与注册」页（SaPolicy.svelte）多用户关着时，指向「用户」页的开关
  '这台主机没开多用户，注册始终关闭；要给别人用，在「用户」页最上面打开「给别人用」':
    'Multi-user mode is off on this host, so sign-ups are always closed. To let other people use it, turn on Sharing at the top of the Users page.',

  // —— 用户（SaUsers.svelte）——
  '普通': 'Standard',
  '完全信任': 'Full trust',
  '完全信任用户': 'Full trust user',   // 设置页「账户」里自己的身份（Settings.svelte / SettingsDesktop.svelte）
  '待确认': 'Review',
  '改名「完全信任」之前开的，等你确认': 'Created before the Full trust rename. Waiting for you to confirm.',
  '账号 id：{id}': 'Account ID: {id}',
  '＋ 完全信任邀请码': '＋ Full trust invite',
  '完全信任档有命令行、终端和浏览器，跑在服务端同一个系统账户下：能读到服务器上所有人的对话、文件和全部凭据（号池令牌、各家 API Key），等同管理员。只给你完全信任的人。':
    'Full trust includes a shell, terminal, and browser that run under the server’s own system account. They can read everyone’s chats, files, and every credential on the server (pool tokens, API keys), the same as an admin. Give it only to people you fully trust.',
  '我了解，给完全信任': 'I understand, grant Full trust',
  '发完全信任邀请码？': 'Create a Full trust invite?',
  '建一个完全信任账号？': 'Create a Full trust account?',
  '把 {name} 升为完全信任？': 'Upgrade “{name}” to Full trust?',
  '{name} 已升为完全信任': '“{name}” now has Full trust',
  '{name} 已降为普通': '“{name}” is now Standard',
  '把 {name} 降为普通？': 'Downgrade “{name}” to Standard?',
  '马上收回命令行：他正在跑的对话会中止，侧栏终端和浏览器关掉。账号、对话和文件都保留，以后可以再升回来。':
    'Shell access is removed right away: their running chats will stop, and their side-panel terminal and browser will close. Their account, chats, and files are kept, and you can upgrade them again later.',
  '降为普通': 'Downgrade',
  '确认 {name} 保留完全信任？': 'Keep Full trust for “{name}”?',
  '确认保留完全信任': 'Keep Full trust',
  '升为完全信任（给命令行）': 'Upgrade to Full trust (shell access)',
  '完全信任（有命令行）': 'Full trust (shell access)',
  '完全信任（有命令行）单次邀请码，注册时填入：': 'Single-use Full trust invite code (shell access). Enter it when signing up:',
  '停用 {name}？': 'Disable “{name}”?',
  '他会立刻被登出、在跑的对话会中止、他登记的电脑断开，他发出去的聊天快照链接也会关掉；数据都保留，重新启用后登录和电脑都恢复。':
    'They’ll be signed out right away, their running chats will stop, their registered computers will disconnect, and any chat snapshot links they shared will be closed. Their data is kept, and they can sign in and use their computers again once you enable the account.',
  '停用': 'Disable',
  '改登录名': 'Change username…',
  '改 {name} 的登录名': 'Change the username for “{name}”',
  '只改登录用的名字：他的对话、文件、设备、用量都跟着账号走，不受影响。他下次登录要用新名字。':
    'Only the sign-in name changes. Their chats, files, devices, and usage stay with the account. They’ll need the new name the next time they sign in.',
  '新登录名（字母 / 数字 / _ -）': 'New username (letters, numbers, _ -)',
  '新登录名不能为空': 'Enter a new username',
  '改名': 'Rename',
  '已改名为 {name}': 'Renamed to “{name}”',
  '他会立刻被登出；在跑的对话中止，他登记的电脑、端口转发、铸的聊天快照、用过的邀请记录和用量一并删除。这个账号 id 以后不再使用：同名的人重新注册，拿不到他的任何东西。':
    'They’ll be signed out right away and their running chats will stop. Their registered computers, port forwards, chat snapshots, used invite records, and usage are deleted too. This account ID is never reused, so someone who signs up later with the same name gets none of it.',
  '连对话、文件、媒体一起删（不可恢复）': 'Also delete their chats, files, and media (can’t be undone)',
  '数据归档：整个目录挪进用户根下的 _archive 文件夹，只有你能找回': 'Archive their data: move the whole folder into _archive in the users folder, where only you can get it back',
  '删除并归档': 'Delete and archive',
  '已删除 {name}，数据已归档': 'Deleted “{name}” and archived their data',
  '已删除 {name}，但数据没处理完：{reason}': 'Deleted “{name}”, but their data wasn’t fully handled: {reason}',
  '已删除 {name}；他还有页面开着，断开后数据自动归档': 'Deleted “{name}”. They still have a page open; their data will be archived once it disconnects.',
  '已删除 {name}；他还有页面开着，断开后数据自动删除': 'Deleted “{name}”. They still have a page open; their data will be deleted once it disconnects.',
  '作废': 'Revoke',
  '已作废': 'Revoked',
  '已过期': 'Expired',
  '{date} 到期': 'Expires {date}',
  '{date} 前有效': 'Valid until {date}',
  '老邀请码，不会过期': 'Older invite code with no expiry',
  '老码·不过期·等同管理员': 'Old code · no expiry · admin-level',
  '升级前发的完全信任码：不过期，用它注册立刻就有命令行、等同管理员。不再需要就作废。':
    'A Full trust code created before the upgrade. It never expires, and signing up with it gives shell access right away, the same as an admin. Revoke it if you no longer need it.',
  '邀请码 7 天内有效，没用的可以作废；完全信任的码要你确认后才发，默认只发普通档。删掉的账号 id 不再复用：同名的人重新注册拿不到旧人的任何东西。':
    'Invite codes are valid for 7 days, and you can revoke unused ones. Full trust codes are only created after you confirm; invites are Standard by default. Deleted account IDs are never reused, so someone who signs up with the same name gets nothing from the old account.',

  // —— 服务端报错（users.mjs / routes/admin-accounts.mjs / runtime/account-lifecycle.mjs / routes/auth.mjs）——
  '完全信任等同管理员：有命令行，能读到服务器上所有人的数据和全部凭据。确认后再给':
    'Full trust is the same as admin: shell access, plus every user’s data and every credential on the server. Confirm before granting it.',
  '该用户名已被占用': 'That username is unavailable',
  '分配账号 id 失败，请重试': 'Couldn’t assign an account ID. Try again.',
  '这个账号不是完全信任档': 'This account doesn’t have Full trust',
  '没有这个邀请码': 'Invite code not found',
  '这个邀请码已经用过了': 'This invite code has already been used',
  '邀请码无效、已过期或已被使用': 'The invite code is invalid, expired, or already used',
  '缺少 multiUser（true / false）': 'multiUser is missing (true / false)',
  '「给别人用」由部署方管理，这里改不了：{hint}': 'Sharing with others is managed by the deployment and can’t be changed here: {hint}',
  '读不了 config.json，没有改：{reason}': 'Couldn’t read config.json, so nothing was changed: {reason}',
  '写 config.json 失败：{reason}': 'Couldn’t write config.json: {reason}',
  '账号目录不在用户根下，没有动它': 'The account folder isn’t inside the users folder, so it was left alone',
  '归档失败（目录被占用？）：{reason}': 'Couldn’t archive the folder (is it in use?): {reason}',
  '没删干净（文件被占用？），剩下的在 {path}': 'Some files couldn’t be deleted (in use?). What’s left is in {path}',
  '这台电脑已被吊销：重新登录后才能再登记': 'This computer was revoked. Sign in again to register it.',
};
