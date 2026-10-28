// 英文界面文案 · 后端下发的文案（tr() 运行时匹配；键 = 后端原文）
//
// 来源：src/**/*.mjs 里会到达界面的中文——HTTP 报错 JSON（{ error }）、SSE error 事件（title / message / hint）、
// 路由转发的 Error.message、能力表标签（src/config/capabilities.mjs）、状态 / 说明文字。
// 带 {占位} 的键是模式：tr() 精确不中时按整句匹配，占位符懒惰匹配、字面部分须 ≥ 2 个汉字，占位符取到的片段
// 会再过一遍 tr()（所以「X失败：{reason}」里的 reason 若也是后端中文会一并翻译）。
// 只发给 AI 的文字（工具结果、拒绝理由、系统提示）、日志、测试、CLI 输出不在这里。
export default {
  // ——— Claude 对话：SSE error 事件（src/agents/claude.mjs）———
  '上一轮仍在停止': 'The previous turn is still stopping',
  '上一轮尚未安全退出，没有启动新的同会话请求。稍等片刻再重试，或先到该会话点「停止」。': 'The previous turn hasn’t exited safely yet, so no new request was started for this session. Try again in a moment, or tap “Stop” in that session first.',
  '快照通道繁忙': 'Snapshot chats are busy',
  '现在同时进行的快照对话太多，稍等片刻再发送。': 'Too many snapshot chats are running right now. Wait a moment, then send again.',
  '服务器正忙': 'The server is busy',
  '现在大家同时在跑的对话已经到上限（{n} 个），稍等片刻再发送这条消息。': {
    one: 'The server is at its limit of {n} running session. Wait a moment, then send this message again.',
    other: 'The server is at its limit of {n} running sessions. Wait a moment, then send this message again.',
  },
  '会话正在启动': 'The session is starting',
  '这个会话已有一轮刚刚开始，请稍后再试。': 'A turn just started in this session. Try again in a moment.',
  // 停放的 CLI 刚接住另一个 Claude 会话发来的消息（claude.mjs parkWarm）
  '会话正在处理别的消息': 'The session is handling another message',
  '这个会话刚收到另一个 Claude 会话发来的消息，正在处理。等这一轮结束再发，或者在它进行中插话。': 'This session just received a message from another Claude session and is handling it. Send yours when that turn ends, or add it while it runs.',
  '并行对话已满': 'Too many sessions running',
  '同时最多 {n} 个对话在跑。等一个完成，或到带呼吸点的对话里按「停止」，再重发这条消息。': {
    one: 'Only {n} session can run at a time. Wait for it to finish, or tap “Stop” in the session with the pulsing dot, then send this message again.',
    other: 'Up to {n} sessions can run at once. Wait for one to finish, or tap “Stop” in a session with a pulsing dot, then send this message again.',
  },
  '思考块遇到 SDK 已知问题，已自动清理': 'Thinking blocks hit a known SDK issue and were cleaned up',
  '再发一次；若仍旧，调低思考强度或换 4.7/Sonnet': 'Send again. If it keeps happening, lower the effort or switch to 4.7/Sonnet.',
  '这一轮的思考块遇到 SDK 已知问题（高思考强度 + 多工具并行时偶发，思考块被写坏）——已自动清理本会话。请再发一次刚才的消息；若仍报错，把思考强度调低一档（如 Max→High）或换 Opus 4.7 / Sonnet。': 'This turn’s thinking blocks hit a known SDK issue (it happens occasionally with high effort and parallel tool calls, and corrupts the thinking blocks). This session was cleaned up automatically. Send your last message again. If the error comes back, lower the effort one level (e.g. Max → High) or switch to Opus 4.7 / Sonnet.',

  // ——— 错误分类（src/runtime/status.mjs classifyError）：标题、提示，以及「标题 — 提示」合成的整句 ———
  '5 小时使用额度已达上限': '5-hour limit reached',
  '本周使用额度已达上限': 'Weekly limit reached',
  'Opus 本周额度已达上限': 'Weekly Opus limit reached',
  'Sonnet 本周额度已达上限': 'Weekly Sonnet limit reached',
  'Fable 本周额度已达上限': 'Weekly Fable limit reached',
  '用量信用（extra usage）额度已用尽': 'Out of extra usage',
  '使用额度已达上限': 'Usage limit reached',
  '约 {time} 恢复（{n} 分钟后）': 'Resets around {time} (in {n} min).',
  '约 {time} 恢复（{n} 小时后）': 'Resets around {time} (in {n} hr).',
  '额度恢复后即可继续。': 'You can continue once your limit resets.',
  '出海请求被网关拒绝（不是账号问题）': 'Outbound request blocked by the gateway (not an account problem)',
  '这是出口 IP 被拒，不是 token 失效。': 'The outbound IP address was rejected. This isn’t an expired token.',
  '这是出口 IP 被拒，不是 token 失效。（出站正走代理 {proxy}，但仍被网关拒绝——多半是代理节点所在地区不被支持，换个节点试试）': 'The outbound IP address was rejected. This isn’t an expired token. (Traffic goes through the proxy {proxy} but is still rejected. The proxy node’s region probably isn’t supported. Try another node.)',
  '这是出口 IP 被拒，不是 token 失效。（当前是直连出站且已验证可出海，但仍被网关拒绝——多半是出口 IP 所在地区不被支持）': 'The outbound IP address was rejected. This isn’t an expired token. (Traffic goes out directly and the connection was verified, but it’s still rejected. The outbound IP’s region probably isn’t supported.)',
  '这是出口 IP 被拒，不是 token 失效。（当前没有已验证的出口：本地代理端口探不到、直连也打不通探针。请开启 Clash 的 TUN 模式或让混合端口可用，bridge 会在 1 分钟内自动接上）': 'The outbound IP address was rejected. This isn’t an expired token. (No verified outbound route: no local proxy port was found and a direct connection can’t reach the probe. Turn on Clash TUN mode or make its mixed port available. The Bridge reconnects automatically within 1 minute.)',
  '登录已失效': 'Sign-in expired',
  '令牌过期或被撤销：重新运行 claude setup-token，到「设置 › Claude › 订阅号池」（或服务端控制台「Claude 账号」）里更新这个号的令牌，即时生效；也可以运行 npm run set-auth -- <新令牌> 后重启服务。': 'The token expired or was revoked. Run claude setup-token again, then update this account’s token in Settings › Claude › Subscription Pool (or Claude accounts in the admin console). It takes effect right away. You can also run npm run set-auth -- <new token> and restart the service.',
  '服务端还没配置 Claude 认证': 'Claude sign-in isn’t set up on the server',
  '二选一：claude setup-token 生成的订阅令牌，或 Anthropic API key（ANTHROPIC_API_KEY）。订阅令牌直接加到「设置 › Claude › 订阅号池」（或服务端控制台「Claude 账号」）里，即时生效；也可以 Docker 写进 .env 的 CLAUDE_CODE_OAUTH_TOKEN 后 docker compose up -d，直接部署用 npm run set-auth -- <令牌> 后重启服务。': 'Use either a subscription token from claude setup-token or an Anthropic API key (ANTHROPIC_API_KEY). Add the subscription token in Settings › Claude › Subscription Pool (or Claude accounts in the admin console). It takes effect right away. Docker: you can also put it in CLAUDE_CODE_OAUTH_TOKEN in .env and run docker compose up -d. Direct install: run npm run set-auth -- <token>, then restart the service.',
  // 桌面客户端托管的本机服务端（BRIDGE_SUPERVISED=desktop）：指到托盘里的重新配置（runtime/status.mjs）
  '令牌过期或被撤销：重新运行 claude setup-token，到「设置 › Claude › 订阅号池」里更新这个号的令牌，即时生效；也可以在托盘「本机服务端 › 重新配置…」里重填。': 'The token expired or was revoked. Run claude setup-token again, then update this account’s token in Settings › Claude › Subscription Pool. It takes effect right away. You can also re-enter it from the tray: Local server › Reconfigure…',
  '二选一：claude setup-token 生成的订阅令牌，或 Anthropic API key。在托盘「本机服务端 › 重新配置…」里填写；订阅令牌也可以直接加到「设置 › Claude › 订阅号池」里，即时生效。': 'Use either a subscription token from claude setup-token or an Anthropic API key. Enter it from the tray: Local server › Reconfigure… A subscription token can also go straight into Settings › Claude › Subscription Pool, effective right away.',
  // 正在用按量 API Key 时失效的是 key（runtime/status.mjs，按 apiKeyMode 分说法）
  'API Key 无效': 'Invalid API key',
  'API Key 无效或已被撤销：在托盘「本机服务端 › 重新配置…」里换一个 key，或改选订阅令牌。': 'The API key is invalid or was revoked. Enter a different key from the tray (Local server › Reconfigure…), or switch to a subscription token.',
  'API Key 无效或已被撤销：换一个有效的 ANTHROPIC_API_KEY（Docker 改 .env 后 docker compose up -d，直接部署改服务的环境变量）后重启服务。设着它的时候，号池里的订阅令牌不会生效。': 'The API key is invalid or was revoked. Set a valid ANTHROPIC_API_KEY (Docker: edit .env and run docker compose up -d; direct install: change the service’s environment variable), then restart the service. While it’s set, subscription tokens in the pool aren’t used.',
  'config.json 里的 anthropicApiKey 无效或已被撤销：换一个 key 后重启服务；或者把订阅令牌加到「设置 › Claude › 订阅号池」里，加上就改用订阅号，即时生效。': 'The anthropicApiKey in config.json is invalid or was revoked. Replace it and restart the service, or add a subscription token in Settings › Claude › Subscription Pool to switch to the subscription right away.',
  '令牌过期或被撤销：重新运行 claude setup-token，到「设置 › Claude › 订阅号池」（或服务端控制台「Claude 账号」）里更新这个号的令牌，即时生效。config.json 里的 anthropicApiKey 没在用：号池里有订阅令牌时优先用订阅号；要改用 API Key，把它设成环境变量 ANTHROPIC_API_KEY（Docker 写进 .env）后重启服务。': 'The token expired or was revoked. Run claude setup-token again, then update this account’s token in Settings › Claude › Subscription Pool (or Claude accounts in the admin console). It takes effect right away. The anthropicApiKey in config.json isn’t being used: subscription tokens in the pool take priority. To use the API key instead, set it as the ANTHROPIC_API_KEY environment variable (Docker: put it in .env), then restart the service.',
  '账户额度 / 计费异常':'Billing or usage problem',
  '检查 Claude 订阅或额度状态。': 'Check your Claude subscription and usage.',
  'Claude 服务器暂时不可用': 'Claude’s servers are temporarily unavailable',
  '通常是临时过载，过一会儿再发一次。': 'This is usually a temporary overload. Send again in a moment.',
  '连不上 Claude 服务器': 'Can’t reach Claude’s servers',
  '检查家里 PC 的网络 / 隧道，或当前所在地区能否访问 api.anthropic.com。': 'Check the host computer’s network or tunnel, and whether api.anthropic.com is reachable from your region.',
  '所选模型不可用': 'The selected model is unavailable',
  '在右上角换一个模型再试。': 'Choose another model in the top-right corner and try again.',
  '回答达到长度上限': 'The response hit the length limit',
  '让我「继续」即可接着输出。': 'Say “Continue” to keep going.',
  '出错了': 'Something went wrong',
  // 合成整句：title + ' — ' + hint（hint 再过一遍 tr）
  '5 小时使用额度已达上限 — {hint}': '5-hour limit reached. {hint}',
  '本周使用额度已达上限 — {hint}': 'Weekly limit reached. {hint}',
  'Opus 本周额度已达上限 — {hint}': 'Weekly Opus limit reached. {hint}',
  'Sonnet 本周额度已达上限 — {hint}': 'Weekly Sonnet limit reached. {hint}',
  'Fable 本周额度已达上限 — {hint}': 'Weekly Fable limit reached. {hint}',
  '用量信用（extra usage）额度已用尽 — {hint}': 'Out of extra usage. {hint}',
  '使用额度已达上限 — {hint}': 'Usage limit reached. {hint}',
  '出海请求被网关拒绝（不是账号问题） — {hint}': 'Outbound request blocked by the gateway (not an account problem). {hint}',
  '登录已失效 — {hint}': 'Sign-in expired. {hint}',
  '服务端还没配置 Claude 认证 — {hint}': 'Claude sign-in isn’t set up on the server. {hint}',
  'API Key 无效 — {hint}': 'Invalid API key. {hint}',
  '账户额度 / 计费异常 — {hint}': 'Billing or usage problem. {hint}',
  'Claude 服务器暂时不可用 — {hint}': 'Claude’s servers are temporarily unavailable. {hint}',
  '连不上 Claude 服务器 — {hint}': 'Can’t reach Claude’s servers. {hint}',
  '所选模型不可用 — {hint}': 'The selected model is unavailable. {hint}',
  '回答达到长度上限 — {hint}': 'The response hit the length limit. {hint}',
  '出错了 — {hint}': 'Something went wrong: {hint}',

  // ——— 号池智能路由换号（src/agents/claude.mjs 撞墙换号的错误卡；{why} 来自 account-router.mjs reasonText）———
  '账号「{from}」{why}，已自动切到「{to}」': '“{from}”: {why}. Switched to “{to}” automatically',
  '额度已满，已自动切换到号池里的另一个账号': 'Usage limit reached. Switched to another account in the pool automatically',
  '正在用新账号重发这条消息…': 'Resending this message on the new account…',
  '正在用新账号接着做…': 'Continuing on the new account…',
  '重试这条消息，或发「继续」接着做。': 'Retry this message, or send “Continue” to keep going.',
  '账号「{from}」{why}，已自动切到「{to}」 — {hint}': '“{from}”: {why}. Switched to “{to}” automatically. {hint}',
  '额度已满，已自动切换到号池里的另一个账号 — {hint}': 'Usage limit reached. Switched to another account in the pool automatically. {hint}',

  // ——— 注册用户额度（src/runtime/quota.mjs）———
  '今天的额度用完了': 'Daily limit reached',
  '这 7 天的额度用完了': '7-day limit reached',
  '需要更多额度请联系管理员。': 'Contact your admin if you need more.',
  '今天已经跑了 {used} 轮，每天上限 {n} 轮，明天 0 点恢复。需要更多额度请联系管理员。': {
    one: 'You’ve used {used} of your {n} daily turn. It resets at midnight. Contact your admin if you need more.',
    other: 'You’ve used {used} of your {n} daily turns. They reset at midnight. Contact your admin if you need more.',
  },
  '今天已用 {used}，每天上限 {max}，明天 0 点恢复。需要更多额度请联系管理员。': 'You’ve spent {used} of your {max} daily limit. It resets at midnight. Contact your admin if you need more.',
  '最近 7 天已经跑了 {used} 轮，上限 {n} 轮；最早那天的用量滑出 7 天窗口后逐步恢复。需要更多额度请联系管理员。': {
    one: 'You’ve used {used} of {n} turn in the last 7 days. Usage frees up as the oldest day leaves the 7-day window. Contact your admin if you need more.',
    other: 'You’ve used {used} of {n} turns in the last 7 days. Usage frees up as the oldest day leaves the 7-day window. Contact your admin if you need more.',
  },
  '最近 7 天已用 {used}，上限 {max}；最早那天的用量滑出 7 天窗口后逐步恢复。需要更多额度请联系管理员。': 'You’ve spent {used} of {max} in the last 7 days. Usage frees up as the oldest day leaves the 7-day window. Contact your admin if you need more.',

  // ——— 服务进程中途退出（src/runtime/inflight.mjs、routes/overview.mjs）———
  '这一轮被中断': 'This turn was interrupted',
  '服务进程在执行中途退出了': 'The service process exited mid-turn',
  '服务已恢复，马上自动继续': 'The service is back — resuming automatically',
  '⚠️ 这一轮没跑完：bridge 服务进程在它执行到一半时退出了（崩溃或重启）。服务已经恢复，马上会自动让 Claude 从中断的地方接着做。': '⚠️ This turn didn’t finish: the Bridge service process exited partway through (a crash or restart). The service is back, and Claude will automatically pick up from where it left off in a moment.',
  '⚠️ 这一轮没跑完：bridge 服务进程在它执行到一半时退出了（崩溃或重启），本轮被中断。已经落盘的文件和已经写进记录的内容都还在——说一句「继续」就能从这里接着往下做。': '⚠️ This turn didn’t finish: the Bridge service process exited partway through (a crash or restart), so the turn was interrupted. Files already saved and everything already recorded are still here. Say “Continue” to pick up from here.',

  // ——— 回滚（routes/sessions.mjs、agents/claude-rewind.mjs）———
  '回滚引擎初始化超时，请重试': 'The rewind engine timed out while starting. Try again.',
  '参数不合法': 'Invalid parameters',
  '会话不存在': 'Session not found',
  '这个会话正在生成中，先「停止」再回滚。': 'This session is still responding. Stop it before rewinding.',
  '找不到这条消息的回滚锚点（会话记录可能已变化，重新打开会话再试）': 'Couldn’t find a rewind point for this message (the session record may have changed). Reopen the session and try again.',
  '这是会话的第一条消息，对话没有更早处可回。': 'This is the first message in the session. There’s no earlier point in the conversation to rewind to.',
  '仅回滚了对话，文件未改动。': 'Rewound the conversation only. Files weren’t changed.',
  '没有可回滚的文件检查点': 'No file checkpoint to rewind to',
  '文件回滚失败：{reason}': 'Couldn’t rewind files: {reason}',
  '没有可回滚的内容：这条消息之后没有文件改动的检查点（回滚功能上线前的旧轮，或这轮没改过文件）。': 'Nothing to rewind: there’s no file checkpoint after this message (the turn is from before rewind was available, or it didn’t change any files).',
  '没有可回滚的内容：这条消息之后没有文件改动的检查点（回滚功能上线前的旧轮，或这轮没改过文件），而且它是会话的第一条消息，对话没有更早处可回。': 'Nothing to rewind: there’s no file checkpoint after this message (the turn is from before rewind was available, or it didn’t change any files), and it’s the first message in the session, so there’s no earlier point in the conversation either.',
  '这条消息之后没有文件改动的检查点，仅回滚了对话。': 'No file checkpoint after this message. Rewound the conversation only.',
  '这是会话的第一条消息，对话没有更早处可回，仅回滚了文件。': 'This is the first message in the session, so there’s no earlier point in the conversation. Rewound files only.',

  // ——— 会话 / 项目（routes/chat.mjs、routes/sessions.mjs、claude-projects.mjs、codex-projects.mjs、claude-quick.mjs）———
  '(无标题)': 'Untitled',
  '（进行中…）': '(In progress…)',
  '操作失败': 'Something went wrong',
  '不能把已有会话切换到另一个项目': 'An existing session can’t be moved to another project',
  '请先选择或创建项目': 'Choose or create a project first',
  '项目不存在或无权访问': 'Project not found, or you don’t have access',
  '项目路径不可用': 'The project path is unavailable',
  '{agent} 未启用，或你的账号没有使用权限': '{agent} isn’t enabled, or your account doesn’t have access',
  '项目': 'Project',
  '工作空间': 'Workspace',
  '主目录': 'Home folder',
  '快照对话': 'Snapshot chat',
  '项目数量已达上限': 'Project limit reached',
  '项目不存在': 'Project not found',
  '请输入项目名称': 'Enter a project name',
  '工作空间项目不可删除': 'The Workspace project can’t be deleted',
  'ids 必须是数组': 'ids must be an array',
  '该身份不支持快照对话': 'Snapshot chats aren’t available for this account',
  '快照已经换过了，请刷新后再试': 'The snapshot has already changed. Refresh and try again.',
  '这个快照已经存为工作空间了': 'This snapshot is already saved as a workspace',
  // 临时对话（原「快照对话」，src/claude-quick.mjs；S1-6 改名）
  '该身份不支持临时对话': 'Temporary chats aren’t available for this account',
  '这个临时对话已经不在了，请刷新后再试': 'This temporary chat is gone. Refresh and try again.',
  '这个临时对话已经存为工作空间了': 'This temporary chat is already saved as a workspace',
  '回收站里已经没有这个临时对话了': 'This temporary chat is no longer in the recycle bin',
  '这个临时对话已经在列表里了': 'This temporary chat is already in the list',
  '读取回收站失败': 'Couldn’t read the recycle bin',
  '参数不对': 'Invalid request',
  '请选择项目路径': 'Choose a project path',
  '路径不存在': 'Path doesn’t exist',
  '无法访问该路径': 'Can’t access this path',
  '无法读取该路径': 'Can’t read this path',
  '请选择文件夹': 'Choose a folder',
  '项目路径必须位于你的工作空间内': 'The project path must be inside your workspace',
  '无法创建项目': 'Couldn’t create project',

  // ——— Codex（agents/codex.mjs、codex.mjs、routes/codex.mjs）———
  '已有 Codex 任务正在执行，请等待完成或先停止当前任务': 'A Codex task is already running. Wait for it to finish or stop it first.',
  'Codex 仅对 Pro 用户开放': 'Codex is available to Pro users only',
  'Codex 调用失败：{reason}': 'Codex request failed: {reason}',
  'Codex 未生成最终答复': 'Codex didn’t produce a final answer',
  'Codex App Server 错误': 'Codex App Server error',
  'Codex App Server 启动失败：{reason}': 'Couldn’t start Codex App Server: {reason}',
  'Codex App Server stdin 错误：{reason}': 'Codex App Server stdin error: {reason}',
  'Codex App Server 进程错误：{reason}': 'Codex App Server process error: {reason}',
  'Codex App Server 已退出': 'Codex App Server exited',
  'Codex App Server 已退出（{code}）': 'Codex App Server exited ({code})',
  'Codex App Server 已退出：{detail}': 'Codex App Server exited: {detail}',
  'Codex App Server 已退出（{code}）：{detail}': 'Codex App Server exited ({code}): {detail}',
  'Codex App Server 初始化失败：{reason}': 'Couldn’t initialize Codex App Server: {reason}',
  'Codex 已中断': 'Codex was interrupted',
  'Codex App Server 未运行': 'Codex App Server isn’t running',
  '{method} 请求超时': '{method} request timed out',
  'Codex App Server 未返回 thread id': 'Codex App Server didn’t return a thread ID',
  '该 Codex 会话已有任务正在执行': 'This Codex chat already has a task running',
  'Codex 无输出': 'Codex returned no output',
  'Codex 超时（{n}s）': 'Codex timed out ({n}s)',
  'Codex App Server 未返回 turn id': 'Codex App Server didn’t return a turn ID',
  '该 Codex 会话仍在执行': 'This Codex chat is still running',
  'Codex App Server 已关闭': 'Codex App Server closed',
  'Codex App Server 调用失败': 'Codex App Server request failed',

  // ——— Gemini ———
  'Gemini 调用失败：{reason}': 'Gemini request failed: {reason}',

  // ——— 媒体生成（routes/media.mjs、imagen / veo / omni / tts / music.mjs、vertex-media.mjs）———
  '图像生成失败：{reason}': 'Couldn’t generate image: {reason}',
  '对话式图像失败：{reason}': 'Couldn’t generate image: {reason}',
  '视频生成失败：{reason}': 'Couldn’t generate video: {reason}',
  '语音生成失败：{reason}': 'Couldn’t generate speech: {reason}',
  '音乐生成失败：{reason}': 'Couldn’t generate music: {reason}',
  'Imagen 未返回图片': 'Imagen didn’t return an image',
  'Nano Banana 未返回图片（可能被安全策略拦截或只回了文字）': 'Nano Banana didn’t return an image (it may have been blocked by safety filters or replied with text only)',
  'Veo 没有返回视频': 'Veo didn’t return a video',
  'Veo 没有返回视频 / no video returned': 'Veo didn’t return a video',
  'Veo 生成失败：{detail}': 'Veo generation failed: {detail}',
  'Veo 返回里既没有 videoBytes 也没有 uri': 'Veo’s response had neither videoBytes nor uri',
  'Omni 需要 Gemini API key（config.geminiApiKey），且该 key 的项目要开通付费': 'Omni needs a Gemini API key (config.geminiApiKey) whose project has billing enabled',
  'Omni 生成失败：status={detail}': 'Omni generation failed: status={detail}',
  'Omni 未返回视频（可能被安全策略拦截或只回了文本）': 'Omni didn’t return a video (it may have been blocked by safety filters or replied with text only)',
  'Omni 视频下载失败 HTTP {status}': 'Couldn’t download the Omni video: HTTP {status}',
  'TTS 未返回音频（可能被安全策略拦截）': 'TTS didn’t return audio (it may have been blocked by safety filters)',
  'lyria-3 需要 Gemini API key（config.geminiApiKey），且该 key 的项目要开通付费': 'lyria-3 needs a Gemini API key (config.geminiApiKey) whose project has billing enabled',
  'lyria-3 多次未返回音频，多为偶发，请再试一次或换个描述': 'lyria-3 didn’t return audio after several tries. This is usually intermittent. Try again or change the description.',
  'lyria-3 多次未返回音频（模型只回了文本「{text}」），多为偶发，请再试一次或换个描述': 'lyria-3 didn’t return audio after several tries (the model replied with text only: “{text}”). This is usually intermittent. Try again or change the description.',
  '拿不到 Vertex 访问令牌（ADC 未配置？）': 'Couldn’t get a Vertex access token (is ADC set up?)',
  'Lyria 未返回音频': 'Lyria didn’t return audio',
  'Gemini 未启用，或你的账号没有使用权限': 'Gemini isn’t enabled, or your account doesn’t have access',
  '(无提示词)': '(No prompt)',

  // ——— 能力表标签（src/config/capabilities.mjs，前端 tr(x.name / x.hint / x.description)）———
  '对话': 'Chat',
  '图像': 'Image',
  '视频': 'Video',
  '语音': 'Speech',
  '音乐': 'Music',
  '自动': 'Auto',
  '低 · 最省': 'Low · Cheapest',
  '中': 'Medium',
  '高 · 看清小字': 'High · Reads small text',
  '默认': 'Default',
  // 比例胶囊里已经画了横 / 竖的形状，英文按 Vertex AI Studio 只写比例，免得三颗胶囊折成两行
  '16:9 横': '16:9',
  '9:16 竖': '9:16',
  '3 秒': '3s',
  '4 秒': '4s',
  '5 秒': '5s',
  '6 秒': '6s',
  '7 秒': '7s',
  '8 秒': '8s',
  '9 秒': '9s',
  '10 秒': '10s',
  '带音频': 'With audio',
  '无音频': 'No audio',
  // 任务类型是两列网格里的双行胶囊（.seg-b2 继承 nowrap）：名字 ≤ 16 字符、说明 ≤ 22 字符，否则撑破网格
  '文生视频': 'Text to video',
  '只给文字描述': 'Text prompt only',
  '图生视频': 'Image to video',
  '从一张首帧图动起来': 'Animate a first frame',
  '首尾插值': 'Frames to video',
  '给定首帧与尾帧，中间自动补': 'Fill in between frames',
  '参考图生成': 'Reference images',
  '带入主体/风格，最多 3 张': 'Subject/style, up to 3',
  '标准 · 体积小': 'Standard · Smaller',
  '无损 · 体积大': 'Lossless · Larger',
  '允许（含儿童）': 'Allow people',
  '仅成人': 'Allow adults only',
  '不生成人物': 'Don’t allow',
  // Gemini TTS 预置音色：特点词取 Google 官方音色表的英文
  'Zephyr · 明亮': 'Zephyr · Bright',
  'Puck · 轻快': 'Puck · Upbeat',
  'Charon · 知性': 'Charon · Informative',
  'Kore · 沉稳': 'Kore · Firm',
  'Fenrir · 激昂': 'Fenrir · Excitable',
  'Leda · 年轻': 'Leda · Youthful',
  'Orus · 坚定': 'Orus · Firm',
  'Aoede · 轻盈': 'Aoede · Breezy',
  'Callirrhoe · 随和': 'Callirrhoe · Easy-going',
  'Autonoe · 明快': 'Autonoe · Bright',
  'Enceladus · 气声': 'Enceladus · Breathy',
  'Iapetus · 清晰': 'Iapetus · Clear',
  'Umbriel · 从容': 'Umbriel · Easy-going',
  'Algieba · 顺滑': 'Algieba · Smooth',
  'Despina · 柔滑': 'Despina · Smooth',
  'Erinome · 清亮': 'Erinome · Clear',
  'Algenib · 沙哑': 'Algenib · Gravelly',
  'Rasalgethi · 讲解': 'Rasalgethi · Informative',
  'Laomedeia · 欢快': 'Laomedeia · Upbeat',
  'Achernar · 柔和': 'Achernar · Soft',
  'Alnilam · 果断': 'Alnilam · Firm',
  'Schedar · 平稳': 'Schedar · Even',
  'Gacrux · 成熟': 'Gacrux · Mature',
  'Pulcherrima · 外放': 'Pulcherrima · Forward',
  'Achird · 友好': 'Achird · Friendly',
  'Zubenelgenubi · 随意': 'Zubenelgenubi · Casual',
  'Vindemiatrix · 温柔': 'Vindemiatrix · Gentle',
  'Sadachbia · 活泼': 'Sadachbia · Lively',
  'Sadaltager · 博识': 'Sadaltager · Knowledgeable',
  'Sulafat · 温暖': 'Sulafat · Warm',
  // TTS 风格（显示名；id 是拼进正文的中文指令，不翻）
  '轻松': 'Cheerful',
  '严肃': 'Serious',
  '温柔': 'Gentle',
  '激动': 'Excited',
  '耳语': 'Whisper',
  '播报': 'Newscaster',
  'Lyria 3 Pro · 最长3分钟': 'Lyria 3 Pro · Up to 3 min',
  // Codex 模型说明
  '复杂推理、编程与专业工作': 'Complex reasoning, coding, and professional work',
  '复杂、开放式任务': 'Complex, open-ended tasks',
  '日常通用工作': 'Everyday work',
  '快速、清晰任务': 'Quick, well-defined tasks',

  // ——— 登录 / 注册 / 账号 / 改密码（routes/auth.mjs、users.mjs、routes/me.mjs）———
  '登录尝试过多，请稍后再试': 'Too many sign-in attempts. Try again later.',
  '这台主机只接受访问令牌登录': 'This host only accepts sign-in with an access token',
  '这台主机不开放注册': 'Sign-ups aren’t available on this host',
  '注册已关闭，请联系管理员为你开账号': 'Sign-ups are closed. Ask your admin to create an account for you.',
  '注册尝试过多，请稍后再试': 'Too many sign-up attempts. Try again later.',
  '用户名只能是 2-32 位的字母/数字/下划线/连字符，且不能以 _ 或 - 开头': 'Usernames must be 2–32 letters, numbers, underscores, or hyphens, and can’t start with _ or -',
  '用户名只能是 2-32 位的字母/数字/下划线/连字符': 'Usernames must be 2–32 letters, numbers, underscores, or hyphens',
  '密码至少 8 位': 'Password must be at least 8 characters',
  '两次输入的密码不一致': 'Passwords don’t match',
  '该用户名已存在': 'That username is already taken',
  '邀请码无效或已被使用': 'This invite code is invalid or has already been used',
  '用户不存在': 'User not found',
  '用户名或密码错误': 'Incorrect username or password',
  '账号已被禁用，请联系管理员': 'This account has been disabled. Contact your admin.',
  '管理员用访问令牌登录，没有密码可改': 'Admins sign in with an access token and have no password to change',
  '原密码错太多次，10 分钟后再试': 'Too many incorrect attempts. Try again in 10 min.',
  '新密码至少 8 位': 'New password must be at least 8 characters',
  '原密码不对': 'Current password is incorrect',

  // ——— 扫码登录 / 设备名（routes/pair.mjs）———
  '请先在手机上登录': 'Sign in on your phone first',
  '配对请求过多，请稍后再试': 'Too many pairing requests. Try again later.',
  '二维码无效或已过期，请在网页上刷新后重扫': 'This QR code is invalid or expired. Refresh it on the web page and scan again.',
  '二维码已过期，请在网页上刷新后重扫': 'This QR code has expired. Refresh it on the web page and scan again.',
  '这张二维码已经用过了': 'This QR code has already been used',
  '服务端未配置访问令牌': 'No access token is set up on the server',
  '二维码无效或已过期': 'This QR code is invalid or expired',
  'Bridge 桌面版': 'Bridge desktop app',
  '{os} · Bridge 桌面版': '{os} · Bridge desktop app',
  '未知设备': 'Unknown device',
  '{label}（扫码）': '{label} (QR sign-in)',

  // ——— 服务端控制台（routes/admin.mjs、agents.mjs、desktop-host.mjs、runtime/*）———
  '这台主机没开多用户，不能注册；要给程序用的账号请直接「新建服务账号」': 'Multi-user mode is off on this host, so sign-ups aren’t possible. For an account a program will use, choose “New service account”.',
  '该 key 无活跃生成': 'No active generation for this key',
  '该用户没有这个 agent 的权限，或它未启用': 'This user doesn’t have access to this agent, or it isn’t enabled',
  '未知探查：{what}': 'Unknown probe: {what}',
  'Agent 设置仅对管理员开放': 'Only admins can change agent settings',
  '仅管理员可注册桌面浏览器宿主': 'Only admins can register a desktop browser host',
  '未知 agent：{id}': 'Unknown agent: {id}',
  '没找到 Codex CLI': 'Codex CLI not found',
  '程序目录里缺 harness': 'harness is missing from the app folder',
  '这台机器上不可用': 'Not available on this computer',
  '还没配认证': 'Not signed in yet',
  '默认账号': 'Default account',
  '无此账号': 'Account not found',
  'token 不能为空（在该账号下跑 claude setup-token 获取）': 'Token can’t be empty. Run claude setup-token under that account to get one.',
  '至少保留一个账号': 'Keep at least one account',
  '不认识的时区：{tz}': 'Unrecognized time zone: {tz}',
  '清单缺字段或格式不对': 'The manifest is missing fields or is malformed',
  // 服务控制 / 更新（runtime/service-control.mjs）
  '主机端走 git + admin.ps1，不在这里更新': 'The host edition updates through git and admin.ps1, not here',
  'Docker 部署：在服务器上 git pull && docker compose up -d --build': 'Docker deployment: run git pull && docker compose up -d --build on the server',
  '没有守护进程托管，更新后没法自动重启': 'No supervisor is managing the service, so it can’t restart automatically after an update',
  '不是 git 部署（找不到 .git）': 'Not a git deployment (.git not found)',
  '缺少 scripts/server/update.sh': 'scripts/server/update.sh is missing',
  '没有被 Windows 启动器托管（老的计划任务部署走 git + admin.ps1，不在这里更新）；要在控制台更新，用 scripts/server/install-windows.ps1 装成计划任务': 'Not managed by the Windows launcher (older scheduled-task setups update through git and admin.ps1, not here). To update from the console, install it as a scheduled task with scripts/server/install-windows.ps1',
  '缺少 scripts/server/update.ps1': 'scripts/server/update.ps1 is missing',
  '由桌面客户端托管：在那台电脑的桌面客户端里「设置 › 连接与更新 › 软件更新」更新（服务端随客户端安装包一起换）': 'Managed by the desktop app: update it in the desktop app on that computer under Settings › Connection & updates › Software Update (the server ships with the app installer)',
  '已经在更新了':'An update is already running',
  '没有守护进程托管（systemd / Docker / pm2），重启后不会自己起来——请在服务器上手动重启。': 'No supervisor (systemd / Docker / pm2) is managing the service, so it won’t come back on its own after a restart. Restart it manually on the server.',
  // 中继 / 反向控制（runtime/remote-control-host.mjs、remote-control-client.mjs、remote-control-desktop.mjs；控制台审计日志）
  '本机中继版本过旧，没有管理接口——重启一次中继即可（relay-server.vbs）': 'The local relay is too old and has no admin API. Restart the relay once (relay-server.vbs).',
  '中继回 {status}': 'Relay returned {status}',
  '中继无响应（超时）——本机中继在跑吗？': 'The relay isn’t responding (timed out). Is the local relay running?',
  '连不上本机中继（{origin}）——确认已启用中继主机（服务端 relayHost），或用 relayControlOrigin 指对端口。': 'Can’t reach the local relay ({origin}). Make sure the relay host is enabled (relayHost on the server), or point relayControlOrigin at the right port.',
  'config.json 读不出来，拒绝改写：{reason}': 'Couldn’t read config.json, so it wasn’t changed: {reason}',
  '客户端执行失败': 'The client couldn’t complete the action',
  '无法启动 shell：{reason}': 'Couldn’t start the shell: {reason}',
  'fs.read 需要 path': 'fs.read requires path',
  'fs.write 需要 path': 'fs.write requires path',
  'fs.delete 需要 path': 'fs.delete requires path',
  '文件过大（{size} 字节 > {max}）——请用 shell 分段处理': 'File is too large ({size} bytes > {max}). Use the shell to process it in chunks.',
  '本机 Node 不支持 fs.glob，请改用 shell（如 Get-ChildItem -Recurse）': 'This computer’s Node doesn’t support fs.glob. Use the shell instead (e.g. Get-ChildItem -Recurse).',
  '未知 fs op：{op}': 'Unknown fs op: {op}',
  '未知 op：{op}': 'Unknown op: {op}',
  '这台客户端的桌面壳不支持远程更新（客户端版本过旧，或不是打包安装的客户端）——需要对方手动更新一次。': 'This client’s desktop app doesn’t support remote updates (it’s too old, or not an installed build). It needs to be updated manually once.',
  '向中继查询最新版失败（HTTP {status}）': 'Couldn’t check the relay for the latest version (HTTP {status})',
  '对方未开启「允许远程桌面控制」——请对方在客户端托盘勾选「允许远程桌面控制」后重试。': 'Remote desktop control is off on that computer. Ask them to turn on “Allow remote desktop control” in the client’s system tray menu, then try again.',
  '无法启动 PowerShell 桌面宿主：{reason}': 'Couldn’t start the PowerShell desktop host: {reason}',
  '桌面控制宿主已退出（{code}）': 'The desktop control host exited ({code})',
  '桌面控制宿主启动失败（退出码 {code}）；确认在交互式桌面会话中运行。': 'The desktop control host couldn’t start (exit code {code}). Make sure it runs in an interactive desktop session.',
  '桌面控制宿主启动超时': 'The desktop control host timed out while starting',
  '桌面操作超时（{op}）': 'Desktop action timed out ({op})',
  '桌面操作失败': 'Desktop action failed',
  '桌面控制目前仅支持 Windows 客户端': 'Desktop control currently supports Windows clients only',
  '未知桌面动作：{action}': 'Unknown desktop action: {action}',

  // ——— 工作空间文件（routes/file-core.mjs、file-derived.mjs、file-preview.mjs、runtime/deliverables.mjs）———
  '路径越界,拒绝': 'Path is outside the workspace',
  '路径越界，拒绝': 'Path is outside the workspace',
  '文件不存在': 'File doesn’t exist',
  '这是一个文件夹,不是文件': 'This is a folder, not a file',
  '不是文本/代码文件,读不了(图片、视频、压缩包等请在工作空间里打开)': 'This isn’t a text or code file, so it can’t be read here. Open images, videos, archives, and similar files in Workspace.',
  '文件太大({size}KB,上限 {max}KB),请在工作空间里打开': 'File is too large ({size} KB, limit {max} KB). Open it in Workspace.',
  '读取失败': 'Couldn’t load',
  '缺少文件名': 'File name is missing',
  '文件名无效': 'Invalid file name',
  '不能写进 bridge 的系统目录': 'Can’t write to The Bridge’s system folder',
  '内容太大（上限 {max}KB）': 'Content is too large (limit {max} KB)',
  '写入失败：{reason}': 'Couldn’t write the file: {reason}',
  '路径不能含 ..（只能在工作空间内移动）': 'Paths can’t contain .. (you can only move items within the workspace)',
  '路径越界或涉及 bridge 系统目录，拒绝': 'Path is outside the workspace or inside The Bridge’s system folder',
  '源路径不存在': 'The source path doesn’t exist',
  '目标与源相同': 'The destination is the same as the source',
  '不能移动到自身内部': 'Can’t move a folder into itself',
  '目标已存在（换个名字或先删掉它）': 'The destination already exists. Use another name or delete it first.',
  '移动失败：{reason}': 'Couldn’t move: {reason}',
  '不能移动/复制到自身或其子目录': 'Can’t move or copy a folder into itself or one of its subfolders',
  '已在该目录': 'Already in this folder',
  '文件太大（附件上限 60MB）': 'File is too large (60 MB attachment limit)',
  '解压超时': 'Extraction timed out',
  '不能操作 bridge 的系统目录': 'Can’t change The Bridge’s system folder',
  '这是文件夹，不是压缩包': 'This is a folder, not an archive',
  '不是支持的压缩包格式（支持 rar/zip/7z/tar/gz 等）': 'Unsupported archive format (rar, zip, 7z, tar, gz, and similar are supported)',
  '电脑上没有可用的解压工具（装 WinRAR 或 7-Zip）': 'No extraction tool is available on the computer. Install WinRAR or 7-Zip.',
  '解出的目录是空的': 'The extracted folder is empty',
  '解压失败（{reason}）——若压缩包有密码暂不支持': 'Couldn’t extract ({reason}). Password-protected archives aren’t supported yet.',
  '不支持的压缩格式': 'Unsupported archive format',
  '电脑上没有装 WinRAR，不能压成 rar': 'WinRAR isn’t installed on the computer, so RAR isn’t available',
  '电脑上没有可用的压缩工具': 'No compression tool is available on the computer',
  '要压缩的项数不对': 'Invalid number of items to compress',
  '不能压缩这一项': 'This item can’t be compressed',
  '只能压缩同一个文件夹里的项': 'Only items in the same folder can be compressed together',
  '不能写到这里': 'Can’t write here',
  '压缩超时': 'Compression timed out',
  '任务不存在': 'Job not found',
  'LibreOffice 未安装': 'LibreOffice isn’t installed',
  '未产出 PDF': 'No PDF was produced',
  '打包工具不可用（没找到 tar.exe）': 'Packaging tool unavailable (tar.exe not found)',
  '文件夹打包失败': 'Couldn’t package the folder',

  // ——— 分享（routes/share.mjs、share-space.mjs）———
  '密码过长（上限 64 字符）': 'Password is too long (64-character limit)',
  '没有可分享的文件': 'No files to share',
  '「{name}」里有 bridge 自己的数据目录（含登录令牌等机密），不能公开分享，请挑选里面的内容分享': '“{name}” contains The Bridge’s own data folder (with secrets such as sign-in tokens), so it can’t be shared publicly. Share items inside it instead.',
  '「{name}」里的文件太多（超过 {n} 项），不适合整夹分享，请挑选里面的内容分享': '“{name}” has too many files (over {n}) to share as a whole folder. Share items inside it instead.',
  '分享内容过大（超过上限 {limit}），请减少或挑小一点的内容': 'Too much to share (over the {limit} limit). Share fewer or smaller items.',
  '标出的文件都找不到': 'None of the selected files could be found',
  '拷贝失败': 'Couldn’t copy',
  '只能分享文件，不能分享文件夹': 'Only files can be shared, not folders',
  '文件太大（分享上限 2GB）': 'File is too large (2 GB share limit)',
  '密码不正确': 'Incorrect password',
  '尝试太频繁，请稍后再试': 'Too many attempts. Try again later.',

  // ——— 聊天快照（routes/chat-snapshot.mjs、mcp/snapshot.mjs）———
  '这个账号没有铸聊天快照的权限': 'This account isn’t allowed to create chat snapshots',
  'Claude 未启用': 'Claude isn’t enabled',
  '同时最多 {n} 个活跃快照，稍后再试': {
    one: 'Only {n} snapshot can be active at a time. Try again later.',
    other: 'Up to {n} snapshots can be active at once. Try again later.',
  },
  '建桶失败': 'Couldn’t create snapshot storage',
  '快照不存在': 'Snapshot not found',
  '快照已被关停': 'Snapshot shut down',
  '快照已过期': 'Snapshot expired',
  '恶意使用': 'Malicious use',

  // ——— Claude 工作台（routes/claude-dock.mjs、runtime/cdp.mjs、claude-term.mjs）———
  '该功能仅对完整权限用户开放': 'This feature is available to full-access users only',
  'git diff 失败': 'git diff failed',
  '浏览器未启动': 'The browser isn’t running',
  '请输入网址': 'Enter a URL',
  '终端数量已达上限': 'Terminal limit reached',
  '未知 preset: {preset}（可用 mobile / tablet / desktop）': 'Unknown preset: {preset} (use mobile, tablet, or desktop)',
  'resize 需要 preset（mobile/tablet/desktop）或正数的 width / height': 'resize needs a preset (mobile/tablet/desktop) or a positive width / height',
  'scheme 只能是 light / dark / auto': 'scheme must be light, dark, or auto',
  'dpr 只能在 1~3 之间': 'dpr must be between 1 and 3',
  '本机未找到 Chrome/Edge，无法启动浏览器': 'Chrome or Edge wasn’t found on this computer, so the browser can’t start',
  '桌面浏览器 broker 未启动': 'The desktop browser broker isn’t running',
  '桌面浏览器既没有 CDP 转发也没有调试端口': 'The desktop browser has neither CDP forwarding nor a debugging port',
  '桌面浏览器 broker 没有返回 targetId': 'The desktop browser broker didn’t return a targetId',
  'Electron browser target 未暴露调试连接': 'The Electron browser target didn’t expose a debugging connection',
  '浏览器启动失败：{reason}': 'Couldn’t start the browser: {reason}',
  '浏览器进程在暴露调试端口前退出了': 'The browser process exited before exposing its debugging port',
  '等待浏览器调试端口超时': 'Timed out waiting for the browser’s debugging port',
  '浏览器未暴露 page target': 'The browser didn’t expose a page target',
  '该浏览器不支持标签页管理': 'This browser doesn’t support tab management',
  '标签 {id} 已不存在': 'Tab {id} no longer exists',
  '没有前台标签': 'No active tab',
  '桌面壳版本过旧，不支持改视口（更新 bridge-client 后重开）': 'The desktop app is too old to change the viewport. Update bridge-client and reopen it.',
  '桌面壳 HTTP {status}': 'Desktop app HTTP {status}',
  '桌面壳没有应答：{reason}': 'The desktop app didn’t respond: {reason}',

  // ——— 扩展中心（extensions.mjs、extension-secrets.mjs、routes/extensions.mjs）———
  '文件超出大小上限': 'File exceeds the size limit',
  '扩展管理仅对管理员开放': 'Only admins can manage extensions',
  '空文件': 'Empty file',
  '扩展不存在': 'Extension not found',
  '不是 JSON 对象': 'Not a JSON object',
  'registry.json 解析失败（{reason}）': 'Couldn’t parse registry.json ({reason})',
  '{error}。为了不把它覆盖掉，扩展中心暂停写入——修好或挪走 extensions/registry.json 后再试': '{error}. To avoid overwriting it, Extensions has paused saving changes. Fix or move extensions/registry.json, then try again.',
  '{error}：列表暂时显示为空，扩展中心暂停写入（不会覆盖它）；修好或挪走 extensions/registry.json 后恢复': '{error}: the list shows as empty for now and Extensions has paused saving changes (the file won’t be overwritten). Fix or move extensions/registry.json to restore it.',
  '压缩包无法解开（支持 .zip / .skill）：{reason}': 'Couldn’t open the archive (.zip and .skill are supported): {reason}',
  '该扩展没有文件目录': 'This extension has no files folder',
  '扩展数量已达上限': 'Extension limit reached',
  '包里找不到 SKILL.md（需在根目录或一级子目录）': 'SKILL.md wasn’t found in the package (it must be at the root or one folder down)',
  'SKILL.md 缺少 YAML frontmatter 的 name / description': 'SKILL.md is missing name / description in its YAML frontmatter',
  '已存在同名技能「{name}」，可在其详情页选择「替换」': 'A skill named “{name}” already exists. To overwrite it, choose “Replace” on its details page.',
  '要替换的技能不存在': 'The skill to replace doesn’t exist',
  '包里找不到 .claude-plugin/plugin.json（不是有效的 Claude Code 插件）': '.claude-plugin/plugin.json wasn’t found in the package (not a valid Claude Code plugin)',
  'plugin.json 不是有效 JSON': 'plugin.json isn’t valid JSON',
  'plugin.json 缺少 name': 'plugin.json is missing name',
  '已存在同名插件「{name}」，可在其详情页选择「替换」': 'A plugin named “{name}” already exists. To overwrite it, choose “Replace” on its details page.',
  '要替换的插件不存在': 'The plugin to replace doesn’t exist',
  '连接器不存在': 'Connector not found',
  '请输入连接器名称': 'Enter a connector name',
  '连接器凭据的加密存储打不开（{reason}），这次没保存': 'Couldn’t open encrypted storage for connector credentials ({reason}). Nothing was saved.',
  'stdio 连接器需要启动命令': 'A stdio connector needs a command',
  '请填写有效的 http(s) 地址': 'Enter a valid http(s) URL',
  '已存在同名连接器「{name}」': 'A connector named “{name}” already exists',
  '连接器凭据加密保存失败（{reason}），这次没保存': 'Couldn’t encrypt and save connector credentials ({reason}). Nothing was saved.',
  '该类型扩展不支持 {agent}': 'This type of extension doesn’t support {agent}',
  'Codex 仅支持 stdio 连接器': 'Codex supports only stdio connectors',
  '没有找到该包里的扩展': 'No extensions found in this bundle',
  '未知的包操作：{action}': 'Unknown bundle action: {action}',
  '路径越界': 'Path is out of scope',
  '文件过大，不支持预览': 'File is too large to preview',
  '有连接器的凭据还是明文存的，挪进加密存储没成功：{reason}': 'Some connector credentials are still stored as plain text and couldn’t be moved to encrypted storage: {reason}',
  '连接器凭据解不开（{reason}）——换了 Windows 账户或机器时会这样；这些连接器眼下不带凭据，请重新填写它们的环境变量 / 请求头：{names}': 'Couldn’t decrypt connector credentials ({reason}). This happens after switching Windows accounts or computers. These connectors have no credentials for now. Enter their environment variables / request headers again: {names}',
  '连接器「{name}」的 {keys} 在加密存储里找不到，请重新填写': '{keys} for connector “{name}” couldn’t be found in encrypted storage. Enter them again.',
  '技能「{name}」的 {entry} 不在了，勾给的 agent 拿不到它': '{entry} for skill “{name}” is missing, so the agents it’s enabled for can’t use it',
  '技能「{name}」的 {entry} 不在了，（已停用）': '{entry} for skill “{name}” is missing (disabled)',
  '插件「{name}」的 {entry} 不在了，勾给的 agent 拿不到它': '{entry} for plugin “{name}” is missing, so the agents it’s enabled for can’t use it',
  '插件「{name}」的 {entry} 不在了，（已停用）': '{entry} for plugin “{name}” is missing (disabled)',
  'DPAPI 加密失败：{reason}': 'DPAPI encryption failed: {reason}',
  'DPAPI 解密失败：{reason}': 'DPAPI decryption failed: {reason}',
  '{file} 读不出来': 'Couldn’t read {file}',
  '{file} 格式不认识': '{file} has an unrecognized format',
  '数据密钥写入后校验不一致': 'The data key didn’t match after it was written',
  '密文还在，但数据密钥 {file} 不见了': 'The encrypted data is still there, but the data key {file} is missing',
  '{file} 解不开（数据密钥对不上）': 'Couldn’t decrypt {file} (the data key doesn’t match)',
  '凭据写入后校验不一致': 'The credentials didn’t match after they were written',

  // ——— dimensio 入口（routes/harness.mjs）———
  'dimensio 未启用': 'dimensio isn’t enabled',
  '同时在用 dimensio 的人太多了（上限 {n}），请稍后再试': 'Too many people are using dimensio right now (limit {n}). Try again later.',
  'harness 启动失败': 'Couldn’t start the dimensio service',
  'dimensio 正在把旧数据复制到新的数据目录（只有这一次），请稍候再试': 'dimensio is copying its existing data to the new data folder (this happens only once). Try again in a moment.',

  // ——— 定时路由（routes/routines.mjs、routines.mjs、runtime/routines-runner.mjs）———
  '定时路由不支持 Ultracode（无人值守跑动态工作流，成本不可控）。请改选 Extra 或 Max。': 'Routines don’t support Ultracode (unattended dynamic workflows have unbounded cost). Choose Extra or Max instead.',
  'prompt 不能为空': 'Prompt can’t be empty',
  '未命名路由': 'Untitled routine',
  '{agent} 未启用或没有权限，这次没有运行。': '{agent} isn’t enabled or you don’t have access, so this run was skipped.',
  '（这条路由没有写 prompt）': '(This routine has no prompt)',

  // ——— 空间壁纸（routes/wallpapers.mjs）———
  '我的壁纸': 'My wallpaper',

  // ——— 手机操控：危险动作确认卡（mcp/phone-control-tools.mjs；问题卡 / 悬浮胶囊）———
  '确认执行': 'Confirm',
  '执行这个动作': 'Perform this action',
  '取消': 'Cancel',
  '不执行；让 Claude 换个方式或先停下': 'Don’t do it. Claude will try another way or stop.',
  '发送短信': 'Send text',
  '确认用 {device} 给 {to} 发这条短信吗？': 'Send this text message to {to} from {device}?',
  // 键很泛（字面只有「内容」两字）：译成中性的 Content，免得 AI 自己写的「内容：…」被错译成 Message
  '内容：{body}': 'Content: {body}',
  '拨打电话': 'Place call',
  '确认用 {device} 拨打 {number} 吗？': 'Call {number} from {device}?',
  '会立即拨出。': 'The call will be placed immediately.',
  '确认操作': 'Confirm action',
  '{device}（安卓 {version}）': '{device} (Android {version})',
  '{device}（{model}，安卓 {version}）': '{device} ({model}, Android {version})',

  // ——— 手机端「有新版本」说明（src/config/versions.mjs APP_RELEASE_NOTES，每次出包会换，换了就回退中文原文）———
  'dimensio 也能帮你操作 bridge、上报 bug 了：和 Claude 一样，它会查 bridge 的项目手册回答「这个功能在哪、怎么用」，替你管文件、定时任务、插件等（删除这类不可撤回的操作每次都先弹卡请你批准）；跟它说「是不是出 bug 了」，它先看现场、跟你确认报告内容和去向后才上报。给 agent 用的接口也跟上了新功能：能读和改 设置 › Claude 里的选项（比如「服务意外重启时 › 自动继续被中断的对话」）、列出能用的模型（含你自己在模型服务里接的），被服务重启打断的对话会单独标出来，并说明是否已排上自动继续。': 'dimensio can now operate bridge for you and report bugs. Like Claude, it looks things up in the bridge project manual to answer “where is this / how does it work”, and manages files, routines, plugins and more on your behalf (anything irreversible, such as deleting, asks for your approval every time). Ask it “is this a bug?” and it checks what’s going on first, then confirms the report’s contents and destination with you before sending it. The agent API also covers the new features: it can read and change the options under Settings › Claude (for example “If the service restarts unexpectedly › Resume interrupted conversations”), list the models you can use (including ones you connected under Model services), and flags conversations interrupted by a service restart, saying whether an automatic resume is already scheduled.',
  'Claude 的对话不怕服务器意外重启了：以前 bridge 服务中途崩溃、被结束或电脑重启时，正在跑的对话会停在一半，只留一句「这一轮没跑完」，得你自己回来说「继续」。现在服务恢复后十几秒，会自动让 Claude 从中断的地方接着做，正看着这个对话的设备会弹出提示并接上直播；手机锁屏、网页关着也照样续。设置 › Claude 里新增「服务意外重启时 › 自动继续被中断的对话」，默认打开，不想要可以关掉。为了不陷入「一跑就崩」的循环，同一件事最多连着自动继续 3 次；中断超过 12 小时、或你已经先发了消息，就不会再自动发。': 'Claude conversations now survive an unexpected server restart. Before, if the bridge service crashed, was stopped or the computer restarted mid-turn, the conversation stopped halfway with only a note saying the turn didn’t finish, and you had to come back and say “Continue”. Now, a dozen or so seconds after the service is back, Claude automatically picks up from where it left off; a device viewing that conversation shows a notice and reconnects to the live output, even with the phone locked or the web page closed. A new setting, Settings › Claude › If the service restarts unexpectedly › Resume interrupted conversations, is on by default and can be turned off. To avoid a crash loop, the same task is resumed automatically at most 3 times in a row, and nothing is sent if the interruption was more than 12 hours ago or you’ve already sent a message yourself.',
  '设置 › 扩展 › 功能扩展 多了「插件市场」：bridge 官方发布的插件在这里一点就装，不用等 bridge 升级就能用上新功能。插件有新版本时，功能扩展页顶上和设置里的「扩展」会提示（只提示，不会自动装），点「更新」才装，装完不满意可以一键回退到上一版，也能挑指定版本装。定时任务、分享链接这些内置功能的修复也能从市场单独更新：换上的市场版万一起不来，会自动退回内置版，也可以随时「恢复内置版」。市场里的插件都由 bridge 官方签名，下载后逐个校验，对不上就不装。': 'Settings › Extensions › Features now has a Plugin market: install plugins published by bridge with one tap and get new features without waiting for a bridge upgrade. When a plugin has a new version, the Features page and Extensions in Settings tell you (nothing installs automatically); tap Update to install it, roll back to the previous version in one tap if you don’t like it, or pick a specific version. Fixes to built-in features such as scheduled tasks and share links can also come from the market on their own. If a market version fails to start, bridge falls back to the built-in one automatically, and you can restore the built-in version any time. Every market plugin is signed by bridge and checked after download; anything that doesn’t match isn’t installed.',
  '修好对话状态显示和实际不符：以前切换对话、或从后台切回 App 时，明明 Claude 还在干活，界面却先显示成已结束（出现复制、重试按钮和发送键），要等十来秒才冒出转圈。现在在跟服务器确认之前，最后一轮只显示「正在同步状态…」，发送键也换成缓冲圈，确认在跑就直接接上直播，确认结束才出现复制和重试，不会再先显示错的状态。网络一卡住，App 会更快重试，不再干等；在线时每 20 秒还会自动核对一次。': 'Fixed chats showing the wrong status: when you switched chats or came back to the app, a turn Claude was still working on could show as finished (copy and retry buttons, the send button) for ten seconds or so before the spinner appeared. Now, until the server confirms, the last turn just says “Syncing status…” and the send button shows a small spinner. If Claude is still working, the live view picks up right away; copy and retry only appear once the turn is confirmed finished. If the network stalls, the app retries sooner instead of waiting, and while you’re on a chat it double-checks the status every 20 seconds.',
  '遇到像 bug 的情况，现在可以直接问 Claude 了：跟它说「是不是出 bug 了」，它会先看现场（版本；管理员还能看服务器最近的报错和崩溃记录），确认是 bridge 的问题后，先跟你说清要报什么、发到哪，你同意了才上报——报告存进这台服务器的反馈库，管理员开着「发给 bridge 开发者」时也会一起发给开发者，不带你的用户名和服务器地址。另外，界面上弹出红字报错时，提示条右边多了「问 Claude」：点一下会开一个新对话，把报错和出错的界面填进输入框，补一句就能发。':
    'When something looks like a bug, you can now just ask Claude: say “is this a bug?” and it checks what’s going on first (the version, and for admins the server’s recent errors and crash records). If it really is a problem with bridge, it tells you what it will report and where it will go, and only reports it once you agree. The report is saved in this server’s feedback library, and if the admin has turned on “send to the bridge developers” it goes to them too, without your username or server address. Also, red error messages now have an “Ask Claude” button on the right: tap it to open a new chat with the error and the screen it happened on already filled in, add a line and send.',
  '这一版主要给服务器部署和别的发行版铺路，平时用起来变化不大：多人共用的服务器修了一个安全问题——成员没填自己的 API Key 时，不能再改 dimensio 的模型服务地址，服务器共用的 Key 不会被发到别处。没装浏览器的服务器上，dimensio 不再提供浏览器工具，不会反复尝试打开浏览器白费功夫。只开了 dimensio 的服务器，打开网址直接就是 dimensio。装在 Linux 服务器上时，设置里做不到的「保持唤醒」「跟随 Claude Desktop 的归档」会自动藏起来，连不上时提示说的是「服务器」而不是「电脑」。插件的面板可以带英文名字。':
    'This version mostly prepares for server deployments and other distributions; day-to-day use barely changes. Shared multi-user servers get a security fix: members who haven’t entered their own API key can no longer change dimensio’s model service address, so the server’s shared key can’t be sent elsewhere. On servers without a browser, dimensio no longer offers browser tools, so it stops trying to open a browser in vain. A server with only dimensio turned on now opens straight into dimensio. On Linux servers, settings that can’t work there (Keep awake, Follow Claude Desktop’s archive) are hidden, and the offline notice says “server” instead of “computer”. Plugin panels can have an English name.',
  '多人共用的服务器上，成员现在也能接自己的模型了：设置 › Claude › 模型服务 › 自定义 API，填上自己的 API Key 就能用 DeepSeek、Kimi、智谱 GLM、小米 MiMo、百炼、OpenRouter 等服务，在输入框模型菜单的 More models 里选用。每个人的服务和 Key 只有自己看得到、用得到（加密存在服务器上，服主也看不到 Key），用自己的 Key 聊天不占本站额度。为了安全，成员接的地址只能是公网地址，不能接服务器本机或局域网里的服务。':
    'On shared servers, members can now bring their own models: Settings › Claude › Model providers › Custom API — add your own API key to use DeepSeek, Kimi, Zhipu GLM, Xiaomi MiMo, Bailian, OpenRouter and more, then pick them under More models in the message box’s model menu. Each person’s providers and keys are visible and usable only by them (stored encrypted on the server; even the server owner can’t see the key), and chats on your own key don’t count against this site’s quota. For safety, members can only use public API addresses — not services on the server itself or its local network.',
  '插件能做的事多了一大截，而且有了自己的界面：第三方插件现在可以带一个控制面板，出现在设置里新的「插件」一组，点进去就是插件自己的页面（手机 App 里在单独的页面打开）；插件详情页多了运行状态、操作按钮、它拉起的后台程序和日志；设置表单能分组、按条件显示、做列表和按群/按项的表、下拉选模型和账号。插件还能以你授权的账号跑 Claude（比如 QQ 群机器人替群友提问：同一个群自动接着上次聊，不弹审批），能托管外部程序、接收外部平台的消息推送。装插件多了「GitHub 地址」：填仓库就能装，装好后能检查更新。插件页面一律在隔离环境里运行，碰不到你的登录信息，也碰不到手机和电脑上的原生功能。仓库里附了一个 QQ 机器人示例插件。':
    'Plugins can do a lot more now, and they get their own UI: a third-party plugin can ship a control panel that appears in a new “Plugins” group in Settings (opened on its own page in the phone app); a plugin’s details page now shows its status, action buttons, the background programs it runs and their logs; settings forms support sections, conditional fields, lists and per-item tables, and pickers for models and accounts. Plugins can also run Claude as an account you authorize (say, a QQ group bot asking on members’ behalf: each group continues its own conversation, with no approval prompts), manage external programs, and receive messages pushed from outside services. Installing gains “GitHub repo”: enter a repository to install, then check for updates later. Plugin pages always run isolated and can’t touch your sign-in or the native features of your phone or computer. The repo includes an example QQ bot plugin.',
  '修好手机 App 里预览网页文件（.html）报 Webpage not available / ERR_BLOCKED_BY_CSP 打不开：App 的安全策略以前只允许框入自己内置的页面，把从你电脑上加载的网页预览也拦了。现在只放行你自己电脑上的网页预览地址，其他外部网页照旧拦着；万一还是被拦（比如刚改过服务器地址），预览会自动改用备用方式打开，单文件网页照样能看。': "Fixed HTML file previews in the phone app failing with \"Webpage not available / ERR_BLOCKED_BY_CSP\": the app's security policy only allowed its own built-in pages in frames, so previews loaded from your computer were blocked too. It now allows only your own computer's preview addresses and keeps blocking other outside pages; if a preview is still blocked (e.g. right after changing the server address), it automatically falls back to another way of opening it, so single-file pages still work.",
  'bridge 改成了插件结构：设置 › 扩展 › 功能扩展 现在就是插件管理。除了 Gemini、ChatGPT · Codex、dimensio 三个 agent 扩展，定时任务、分享链接、设备、手机操控、内置浏览器、共享终端、内嵌图表、公网预览等 20 项内置功能也都列在这里，默认全开，用不上的可以单独关掉：关掉后它在界面上的入口、接口和 Claude 的对应工具一起消失，再打开就回来（少数几项要重启后生效，卡片上会写）。点进每一项能看说明、改它的设置。还能装第三方插件：上传插件的 zip，或填一个本机插件目录；插件可以给 Claude 加工具、加接口、加 agent 操作、跑定时的后台任务，设置表单自动生成。想要 bridge 没有的能力时，可以直接让 Claude 帮你写一个插件并装上。':
    'bridge is now built from plugins: Settings › Extensions › Modules is the plugin manager. Besides the three agent modules (Gemini, ChatGPT · Codex, dimensio), about 20 built-in features are listed there too, including Routines, Share links, Devices, Phone control, the built-in browser, the shared terminal, inline visuals and public preview. They are all on by default, and you can turn off any you don’t use: its entry points, endpoints and Claude tools go away together and come back when you turn it on again (a few need a restart, and their cards say so). Open any of them to read what it does and change its settings. You can also install third-party plugins by uploading a plugin zip or adding a local plugin folder. A plugin can give Claude new tools, add endpoints and agent operations, or run scheduled background jobs, and its settings form is generated for you. When you want something bridge can’t do yet, you can ask Claude to write a plugin and install it.',
  'dimensio 也能操作你的电脑了，能力和 Claude 一样：看屏幕、点程序、用那台电脑上带登录态的浏览器、在上面跑命令、读写文件、在电脑和服务器之间拷文件、把电脑上的本机端口接到服务器。输入框左下多了一颗「电脑」胶囊，选这个会话连哪台电脑（自动 / 某一台 / 不连电脑）；多人共用的服务器上，成员也能让 dimensio 操作自己的电脑，只能碰自己名下的那几台，电脑那边照旧按「关闭 / 只看 / 操作」自己把关。':
    'dimensio can now operate your computer too, just like Claude: see the screen, click programs, use that computer’s browser with your logins, run commands, read and write files, copy files between the computer and the server, and reach local ports on it from the server. A “Computer” chip at the bottom left of the input box picks which computer this chat uses (Automatic / a specific one / No computer). On shared servers, members can let dimensio operate their own computers too, only the ones registered to them, and each computer still guards itself with Off / View only / Operate.',
  '扩展 › 功能扩展可以一键安装了：用电脑客户端里的本机服务端时，Gemini · Vertex、dimensio 的卡片上直接有「安装」按钮，点一下就从 GitHub 下载和你这一版配套的扩展包，卡片上有进度条，装完点「立即重启」就能用；装着的扩展和主程序对不上时按钮是「更新到 x」。不用再找离线包手动上传了（手动上传仍然保留）。装不了的时候卡片上会写明原因，比如源码部署的服务器扩展本来就是内置的、连不上 GitHub 等。':
    'Settings › Extensions › Modules now installs with one tap: on the local server inside the desktop client, the Gemini · Vertex and dimensio cards have an “Install” button that downloads the matching package for your version from GitHub, with a progress bar on the card; tap “Restart now” when it’s done. If an installed module doesn’t match the main program, the button reads “Update to x”. No more hunting for offline packages to upload (manual upload is still there). When a module can’t be installed, the card says why — for example, on a source-deployed server modules are already built in, or GitHub can’t be reached.',
  '全局助手（玻璃球）下线了，换成两样更实在的：一是 设置 › Agent 接入——生成一把密钥交给别的 agent（Claude Code、Codex、脚本都行），它拿着服务器地址就能直接查项目手册、给 Claude 派活、管文件和定时任务、把你的界面带到某一页，不用再开浏览器对着截图点；二是 bridge 里的 Claude 自己也会查这本手册、替你操作 bridge（找历史会话、建或停定时任务、带你去某一页），以前问玻璃球的事，直接问 Claude 就行。':
    'The global assistant (the glass orb) is gone, replaced by two more useful things: Settings › Agent access lets you create a key for another agent (Claude Code, Codex, a script): with the server address it can read the project handbook, give Claude work, manage files and routines, and bring your screen to a page, with no browser clicking needed. And Claude in bridge now reads the same handbook and can operate bridge for you (find past sessions, create or pause routines, take you to a page), so just ask Claude what you used to ask the orb.',
  'Claude 用你自己接的模型（设置 › 模型服务）时也能开 Ultracode 了：推理强度拉到最右就是它，主对话按这个模型的最高档跑，复杂任务会自己派一群子 agent 并行干。另外，设置 › Claude › 对话 › 动态工作流下面多了「子 agent 调度偏好」：用大白话写你希望子 agent 怎么挑模型和推理强度，比如「简单任务用 mimo-v2.6-flash，普通构建用 deepseek-v4.1-flash」，Claude 派活时就照着办，子 agent 会被送到对应的模型服务上。就算不写，Claude 现在也会按每个子任务的难度分别定推理强度，不再一律照搬主对话的档位。':
    'Ultracode now works when Claude runs on your own models (Settings › Model services): drag effort all the way right, the main chat runs at that model’s highest level, and complex tasks fan out to parallel subagents. Also new under Settings › Claude › Conversation › Dynamic workflows: “Subagent dispatch preferences”. Describe in plain words how subagents should pick a model and effort — e.g. “mimo-v2.6-flash for simple tasks, deepseek-v4.1-flash for ordinary builds” — and Claude follows it, with each subagent sent to the matching model service. Even if you leave it empty, Claude now sets effort per subtask by difficulty instead of copying the main chat’s level.',
  'Claude 侧栏的「临时对话」区更清爽了：平时只显示最近的一条，其余的（包括只有文件、还没对话的）都收进「显示更多」，点开再看，看完可以收起。':
    'The Temporary chats section in the Claude sidebar is tidier: it now shows only the most recent chat; the rest (including ones that only have files) are tucked under “Show more” and can be collapsed again.',
  '修好 Claude 新对话页的字符风背景一直定住不动：以前背景只画出第一帧就停了，现在会照官方桌面版那样随风流动，鼠标划过会搅动，点一下荡开波纹；连续三分钟没人操作会慢慢静下来，动一下鼠标或打字就接着动。':
    'Fixed the character-wind background on the Claude new-chat page being stuck: it used to draw only the first frame and stop. It now flows like the official desktop app — moving the mouse stirs it and clicking sends out a ripple; after three minutes with no activity it slowly settles, and moving the mouse or typing starts it again.',
  'Claude 接官方 Anthropic API（设置 › 模型服务里填 api.anthropic.com 的服务）时，fast mode 不用再手写参数了：点输入框右下角的型号名，支持 fast 的型号（如 Opus 5.5）菜单底部会出现「Enable fast mode」开关，用法和 Claude 账号一样，开着时型号旁写「Fast」。哪些型号支持是 bridge 自己去官方测出来的，不支持的不显示开关。同时修好了这类服务每条消息都报「API Error: 400 context_management」的问题。':
    'When Claude uses the official Anthropic API (a model service set to api.anthropic.com in Settings › Model services), you no longer have to hand-write parameters for fast mode: tap the model name at the bottom right of the input box, and models that support fast (such as Opus 5.5) show an “Enable fast mode” switch at the bottom of the menu — it works just like with a Claude account, and “Fast” appears next to the model name while it is on. bridge tests against the official API which models support it; models that don’t get no switch. Also fixed every message on such services failing with “API Error: 400 context_management”.',
  '深色流体壁纸的默认样子换成短点阵：线段变短变细、不再放大，满屏是随水流起伏的细小光点。在设置里点「恢复默认参数」就能切到这个样子。':
    'The dark fluid wallpaper now defaults to a short-dot look: shorter, thinner strokes with no zoom, so the screen fills with small points of light drifting with the flow. Tap “Restore defaults” in settings to switch to it.',
  '修好深色流体壁纸变成一格一格乱线：「流体尺寸」只有取 32、64、128、256、512 时引擎才算得对，以前滑条能拖到 96 这类中间值，整个壁纸就乱了。现在这根滑条只有这五档，以前存下的中间值会自动归到最近的一档。':
    'Fixed the dark fluid wallpaper breaking into a grid of tangled lines: the engine only works when “Fluid size” is 32, 64, 128, 256 or 512, but the slider used to allow in-between values like 96, which scrambled the whole wallpaper. The slider now has just these five steps, and any in-between value saved earlier snaps to the nearest one.',
  'Claude 输入框旁权限模式的图标换成了官方桌面版的原版图标：手动是手掌、接受编辑是代码符号、计划是卷轴、自动是圆角闪电、绕过权限是警示三角，线条粗细和官方一致。':
    'The permission mode icons next to the Claude composer now use the official desktop app icons: a hand for Manual, a code symbol for Accept edits, a scroll for Plan, a rounded lightning bolt for Auto and a warning triangle for Bypass permissions, with the same stroke weight as the official app.',
  '修好设置里的滑条：以前在手机上上下滑动设置页，手指扫过滑条就会把数值改掉，流体壁纸因此常被改成一片黑。现在和 iPhone 一样，要按住圆钮左右拖才会改，上下滑动只滚动页面，点滑条别处也不会跳值。另外修好深色流体壁纸偶尔变成一格一格乱线的问题（超宽屏拖窗口时最容易出现）。':
    'Settings sliders are fixed: scrolling the settings page on your phone used to change any slider your finger passed over, which often turned the fluid wallpaper black. Now, like on an iPhone, a value changes only when you hold the knob and drag sideways — swiping up and down just scrolls, and tapping elsewhere on a slider no longer jumps. Also fixed the dark fluid wallpaper sometimes breaking into a grid of tangled lines (most likely when resizing the window on an ultrawide screen).',
  '内部代码整理：用量统计和后台任务面板换成了自己写的实现，功能和界面都没有变化。':
    'Internal cleanup: usage statistics and the background tasks panel now run on our own implementation. Nothing changes in features or the interface.',
  '手机 App 恢复了原版液态玻璃、入口图标和字体（6.53 打包时漏掉了），明亮壁纸恢复为多洛米蒂。新增扫码连接：电脑或网页上出示二维码，手机扫一下就连上服务器，不用手抄地址和令牌。服务器更新会等正在跑的对话结束再重启，断开的手机和电脑会自己重连。多人共用的服务器：「Pro」改名为「完全信任」，发出前要确认；服主默认只看得到会话标题、时间和用量，看对话内容要成员自己在设置里允许。':
    'The phone app has its original liquid glass, entry icons and fonts back (6.53 left them out of the package), and the light wallpaper is the Dolomites again. New: connect by scanning — show a QR code on your computer or the web app and scan it with your phone to connect, no more copying addresses and tokens. Server updates now wait for running chats to finish before restarting, and disconnected phones and computers reconnect on their own. On shared servers, “Pro” is now called “Full trust” and needs a confirmation before it’s granted; the server owner sees only chat titles, times and usage by default, and can see chat content only if the member allows it in their settings.',
  '新增「新对话」入口；「快照」改名为「临时对话」，改为按时间回收、回收前提醒，不再悄悄删掉。服务器地址变了（比如临时地址重启）手机会自动找回；手机 App 现在直接由你连的服务器提供下载和更新。提交反馈默认只留在服务器上，开服者打开后才会同时发给开发者。离线提示会写明电脑从几点起没有应答，错过的定时任务会标出来。':
    'There’s now a New chat button, and Snapshots are renamed Temporary chats: they’re cleaned up by age with a heads-up first, instead of disappearing silently. If your server’s address changes (for example after a temporary address restarts), your phone finds it again on its own, and the phone app now downloads and updates directly from the server you use. Feedback stays on your server by default and only goes to the developers if the server owner turns that on. The offline banner shows since when your computer stopped responding, and missed scheduled tasks are marked.',
  '一次大修：自定义模型的「自动识别」现在真的会识别上下文、思考和看图能力，语音类模型不再混进来；推理强度按模型自己的档位来，什么都不选也能正常对话；自定义模型统一收进「更多模型」，每个服务可以设成不显示，地址或协议配错会直接告诉你哪里不对，还能一键检测。dimensio 的自定义服务也换成了同一套识别。Markdown 里 Obsidian 的图片嵌入在阅读和编辑时都能显示，插图恢复正常；单个「-」不再把上一行变成标题，Tab 能做列表缩进，列表里回车能回到顶格。打开会话、会话列表和改动审阅明显变快，修掉了几处会反复重试的请求。设置统一成一种样式（只装 Claude 时也一样）。服务端控制台新增「公网访问」：临时地址、自己的 Cloudflare 隧道或自填地址，自带看门狗。提交反馈时可以同时发给 bridge 开发者（开服的人可以关掉）。':
    'A big round of fixes: auto-detection for custom models now really detects context size, thinking and image support, and voice models no longer get mixed in; reasoning effort follows each model’s own levels, and chatting works even if you pick nothing; custom models now live under More models, each service can be hidden, and a wrong URL or protocol tells you exactly what’s wrong, with one-click detection. dimensio’s custom services use the same detection. Obsidian image embeds in Markdown now show in both reading and editing, and inserting images works again; a lone “-” no longer turns the line above into a heading, Tab indents list items, and pressing Enter in a list can take you back to the left edge. Opening chats, the chat list and change review are noticeably faster, and several requests that kept retrying are fixed. Settings now use one style everywhere (also when only Claude is installed). The server console has a new Public access section: a temporary address, your own Cloudflare tunnel, or your own URL, with a built-in watchdog. Feedback can also go to the Bridge developers (server owners can turn this off).',
  '去掉了「远程协助」：设置和服务端控制台的「设备」里不再有生成配对码，帮别人看电脑的免安装小工具也下线了。自己的电脑照旧装 bridge 桌面客户端、登录同一个账号就会出现在「设备」里；端口转发、设备终端不受影响。':
    'Remote assist has been removed: Devices in Settings and in the server console no longer create pairing codes, and the no-install helper for other people’s computers is gone. Your own computers still show up under Devices once you install the Bridge desktop app and sign in with the same account; port forwarding and the device terminal are unchanged.',
  '你的电脑接进来了：Claude 跑在服务器上，你登记过的电脑（装上 bridge 桌面客户端、登录同一个账号就会出现）成了「设备」——输入框上方多了一个电脑芯片，选好这个会话连哪台电脑，Claude 就能看它的屏幕、点它的程序、在它上面跑命令、读写它的文件；电脑那边按「关闭 / 只看 / 操作」三档自己把关，只看档下要动手会先在那台电脑上问你。工作台的终端左下角可以从「服务器」切到你的电脑，在手机上直接用电脑的终端。设置里新增「设备」：看各台电脑在不在线、改名、断开、吊销；「端口转发」能把电脑上跑着的网页或本机模型接口接到服务器，手机上也能打开，Claude 也能用；「远程协助」生成配对码，帮别人的电脑临时连进来。服务端控制台的「客户端配对」页换成了「设备」页。另外去掉了 Antigravity。':
    'Your computers are now part of Bridge: Claude runs on the server, and computers you’ve registered (install the Bridge desktop app and sign in with the same account) become devices. A computer chip above the input box picks which computer this chat uses, so Claude can see its screen, click its apps, run commands and read or write its files. Each computer guards itself with three levels — Off, View only and Control — and in View only it asks you on that computer before acting. The terminal in the workbench can switch from Server to your computer, so you can use your computer’s terminal from your phone. Settings has a new Devices section: see which computers are online, rename, disconnect or revoke them; Port forwarding puts a web page or local model API running on your computer onto the server, so you can open it on your phone and Claude can use it; Remote assist creates a pairing code to connect someone else’s computer for a while. In the server console, Client pairing is now Devices. Antigravity has been removed.',
  'Claude 侧栏里工作空间的「显示更多」不再怪了：组里只剩 1 条没放出来时直接列出来，不再用一行「显示更多（1）」把它藏起来；整组会话都比较老、侧栏里一条都没列出来的工作空间，会自动把会话取回来显示，不用再点。':
    'The "Show more" row in the Claude sidebar is less odd now: when only one session is left in a workspace it is simply listed instead of being hidden behind "Show more (1)", and a workspace whose sessions are all older and showed none in the sidebar now fetches them automatically, no click needed.',
  '设置 → Claude → 模型服务里的厂商图标换成了各家官方 logo（DeepSeek、Kimi、智谱、阿里云百炼、MiniMax、OpenRouter、硅基流动、OpenAI、Anthropic、Ollama），明暗主题下都清楚；自己从头配置的服务，只要接口地址是这些厂商的，也会自动显示对应 logo。':
    'Provider icons under Settings → Claude → Model providers now use each company’s official logo (DeepSeek, Kimi, Zhipu, Alibaba Bailian, MiniMax, OpenRouter, SiliconFlow, OpenAI, Anthropic, Ollama), clear in both light and dark themes. Providers you set up from scratch also get the matching logo when their base URL belongs to one of these companies.',
  'Claude 能接你自己的模型了：设置 → Claude → 模型服务 → 自定义 API。兼容 Anthropic 或 OpenAI 接口的服务都能接（DeepSeek、Kimi、智谱 GLM、阿里云百炼、MiniMax、OpenRouter、硅基流动、OpenAI、本机 Ollama 等有现成预设），填上 API Key、点「从服务拉取」就能列出型号，之后在输入框的模型菜单「自定义 API」里选用；Claude Code 的工具、子 agent、工作区照常能用。各种调用参数都能调：最大输出、temperature、top_p、top_k、思考（跟着推理强度换预算，或固定开关）、停止序列、额外请求体，还能给单个模型单独覆盖；连接上能改鉴权方式、加请求头、设超时和重试、选择走不走代理；第三方不认的字段可以在「兼容」里一键去掉。每个服务都能一键发测试请求，并查看最近请求的耗时与用量。API Key 加密存在电脑上，不会发到手机或网页；订阅账号的登录凭证也不会发给第三方。':
    'Claude can now use your own models: Settings → Claude → Model providers → Custom API. Any service with an Anthropic- or OpenAI-compatible API works (presets for DeepSeek, Kimi, Zhipu GLM, Alibaba Bailian, MiniMax, OpenRouter, SiliconFlow, OpenAI and a local Ollama). Add your API key, choose Fetch from service to list the models, then pick one under Custom API in the message box’s model menu — Claude Code’s tools, subagents and workspace keep working. Every request parameter is adjustable: max output, temperature, top_p, top_k, thinking (budget follows the effort level, or always on/off), stop sequences and an extra request body, with per-model overrides; the connection lets you change authentication, add headers, set timeouts and retries, and choose whether to use the proxy; fields a third party rejects can be switched off under Compatibility. Each provider has a one-click test and a log of recent requests with latency and usage. API keys are stored encrypted on the computer and never sent to your phone or the web app, and your subscription’s sign-in is never sent to third parties.',
  '设置里左侧的 agent 列表跟着「扩展 › 功能扩展」的开关走了：关掉某个扩展，左侧对应那一项直接消失，不再变灰挂着；打开后立刻回来，不用重开设置。开着但这台电脑跑不起来的（比如没装 CLI）仍会列出并变灰，点进去能看到原因。':
    'The agent list on the left of Settings now follows the switches under Extensions › Feature extensions: turn an extension off and its entry disappears instead of staying greyed out; turn it back on and it reappears right away, without reopening Settings. Agents that are on but can’t run on this computer (for example, the CLI isn’t installed) are still listed in grey — open them to see why.',
  'Claude 分页补齐了官方桌面版的一大批功能：① 权限模式——输入框旁可选手动 / 接受编辑 / 计划 / 自动（绕过权限要先在设置的「安全」里打开），Claude 改文件、跑命令前会弹审批卡（允许一次 / 始终允许 / 拒绝），计划模式会出计划卡，可以批准、退回修改或拒绝；② 拉取请求——会话信息面板新增 PR 卡，能看状态和检查项，能合并、标为可审查、开自动合并、同步基线分支，CI 失败或有评审意见时可自动叫醒会话去修；③ 侧栏能归档会话（也能按天数自动归档、跟随官方桌面版的归档，已归档的在「已归档」里找回），新增全文搜索（电脑上按 Ctrl+K），会话标题改用自动生成的短标题；④ Claude 想另开会话时可选「先问我 / 直接开始 / 只在我要求时」，子会话能开独立工作树，还能和官方桌面版、终端里的 Claude 会话互发消息；⑤ Claude 能在对话里直接画交互图表（手机上显示静态版）；⑥ 设置 → Claude 照官方重新排版，新增输出风格、回复语言、被拦时自动换模型、提问超时、分支前缀、提交署名、分类通知、工作时保持电脑唤醒等设置。':
    'The Claude page now matches a big batch of the official desktop app’s features: (1) Permission modes — next to the message box choose Manual, Accept edits, Plan or Auto (Bypass permissions must first be enabled under Safety in Settings); before Claude edits files or runs commands you get an approval card (Allow once / Always allow / Deny), and Plan mode shows a plan card you can approve, send back for revision or reject; (2) Pull requests — a PR card in the session panel shows status and checks, and lets you merge, mark ready, turn on auto-merge and sync with the base branch; when CI fails or reviewers comment, Claude can be woken up automatically to fix it; (3) the sidebar can archive sessions (manually, after a number of idle days, or following the official desktop app — archived ones live under Archived), there is full-text search (Ctrl+K on desktop), and session titles now use short auto-generated titles; (4) when Claude wants to start another session you can pick Ask me / Just start / Only when I ask, child sessions can get their own worktree, and sessions can message Claude sessions in the official desktop app or a terminal; (5) Claude can draw interactive charts right in the conversation (a static preview on phones); (6) Settings → Claude has been reorganized like the official app, with new settings for output style, reply language, switching models when a message is flagged, question timeout, branch prefix, commit attribution, per-type notifications and keeping the computer awake while Claude works.',
  '快照存为工作空间后不会再丢文件了：以前存好的快照工作空间还留在快照文件夹里，开发测试时起的临时服务清理旧快照，会把它当成旧快照删掉（对话记录还在，但文件夹没了，右侧「文件」打不开）。现在一存为工作空间，它就搬到主目录下的「Bridge Workspaces」文件夹（如 snapshot-1），对话和里面的文件链接跟着一起搬，任何清理都不会碰它；以前存过的也会自动搬过去。每个服务也各管各的快照，互不干扰。另外，工作空间的文件夹真的不存在时，右侧「文件」会直接说「文件夹已不存在」，不再误报「在云端文件区之外」。':
    'Saved snapshot workspaces no longer lose their files: they used to stay inside the snapshot folder, where temporary test servers cleaning up old snapshots could delete them (the conversations survived, but the folder was gone and the Files panel couldn’t open it). Now, as soon as you save a snapshot as a workspace, it moves to the “Bridge Workspaces” folder in your home directory (e.g. snapshot-1), with its conversations and file links moved along, and no cleanup ever touches it; ones you saved earlier are moved there automatically. Each server also manages only its own snapshots. And when a workspace’s folder really is missing, the Files panel now says so instead of claiming it’s outside your file area.',
  'Claude 工作台里的浏览器卡片重新设计了：① 工具栏只剩一行——后退、前进、刷新、地址栏和一个设备键；地址栏里站点名加粗、路径变淡，https 显示小锁，加载时底边有一根细线在走；只有一个标签页时不再多占一行标签条。② 桌面 / 平板 / 手机、自定义尺寸、横竖屏、触屏、配色和关闭浏览器都收进设备键的菜单里，电脑和手机是同一个菜单。③ 修好电脑客户端里点开这个菜单会被网页挡住的问题：菜单打开时网页先定格成一张图，菜单收起再恢复。④ 手机上按钮和菜单项都放大了，画面贴边显示更大；在手机上从地址栏打开网页，会直接用手机尺寸打开。':
    'The browser card in the Claude workbench has been redesigned: (1) one toolbar row — back, forward, reload, the address bar and a device button; the site name is bold and the path dimmed, https shows a small lock, and a thin line runs along the bottom while loading; with a single tab there is no extra tab row. (2) Desktop / tablet / phone, custom size, orientation, touch, color scheme and closing the browser all live in the device button menu, the same menu on desktop and phone. (3) Fixed the desktop client showing this menu behind the web page: the page now freezes into a still image while the menu is open and comes back when it closes. (4) On phones, buttons and menu items are larger and the page fills more of the screen; opening a page from the address bar on a phone starts in phone size.',
  '手机上操作 Claude 工作台里的浏览器顺手多了：① 修好轻点一下会被当成点两下的问题——以前点开关、菜单这类按钮常常是点开又立刻关上，看起来像没反应；② 电脑客户端开着时，浏览器切到手机视口后点什么都没反应，现在修好了（需要重启一次电脑客户端）；③ 画面不再越积越慢：网络差时只发最新的画面，点完马上能看到结果；④ 手指拖动滚动更跟手，甩一下会带惯性继续滚；⑤ 点到网页里的输入框会自动弹出手机键盘，打字、删除、回车都能直接输进网页，中文输入法也行；导航栏多了一个键盘按钮，可以手动唤出或收起。':
    'Using the browser in the Claude workbench from your phone is much smoother: (1) a single tap is no longer sent as two taps — toggles and menus used to open and immediately close, looking unresponsive; (2) with the desktop client running, taps did nothing once the browser was in phone view — fixed (restart the desktop client once); (3) the picture no longer falls further and further behind: on a slow connection only the newest frame is sent, so you see the result of a tap right away; (4) dragging to scroll follows your finger and a flick keeps scrolling with momentum; (5) tapping a text field in the page brings up your phone keyboard, and typing, deleting and Enter go straight into the page (Chinese input methods work too); a keyboard button in the toolbar lets you show or hide it manually.',
  '侧栏底部账户卡的弹出菜单精简了：去掉了「账户」这一项，菜单里只剩主页、设置、工作空间（手机上还有扫一扫）。账户资料、用量、切换账号和退出登录都在「设置」最上面的账户卡里，点「设置」进去就能看到。':
    'The pop-up menu on the account card at the bottom of the sidebar is simpler: the Account item is gone, leaving Home, Settings and Workspace (plus Scan on phones). Your profile, usage, account switching and sign-out are all in the account card at the top of Settings.',
  'Claude 号池的用量显示改了：以前某个号撞过一次上限后，账号名旁边会挂一个红色的「几点前不用」，额度早就刷新了它还挂着，看着像这个号还不能用；现在这个标签去掉了。改成在每个号的「5 小时 / 每周 / Fable」三条用量下面，直接写上这一项什么时候重置——一天之内写几点（比如「18:20 重置」），更远的写星期几几点（比如「周三 02:00 重置」），不到一小时写「几分钟后重置」。电脑设置、手机设置和服务端控制台都一样。':
    "Changed how usage is shown in the Claude account pool: after an account hit a limit once, a red “Paused until …” tag used to stay next to its name even after the usage had reset, making it look unusable. That tag is gone. Instead, each account’s 5-hour / Weekly / Fable meters now show when that limit resets — a time of day within the next 24 hours (e.g. “Resets 18:20”), a weekday and time further out (e.g. “Resets Wed 02:00”), or minutes left when under an hour. This applies to desktop Settings, phone Settings and the server console.",
  '修好电脑上设置里的下拉选择框点不动：以前点开「思考动画」这类下拉菜单后，用鼠标点选项没有任何反应，菜单直接收起、设置还是原来的值（只有键盘上下键加回车能选）。现在鼠标点哪项就切到哪项，Claude 的思考动画可以在「新版 Claude Code / 新版聊天页 / 经典星标」之间正常切换了，设置里其它下拉框也一并修好。':
    "Fixed dropdowns in desktop Settings not responding to clicks: after opening a dropdown such as \"Thinking animation\", clicking an option did nothing — the menu just closed and the setting stayed the same (only arrow keys + Enter worked). Now clicking an option switches to it, so the Claude thinking animation can be switched between New Claude Code / New chat page / Classic star again, and the other dropdowns in Settings are fixed too.",
  'Claude 号池的「额度用尽自动换号」新增一个开关「会话中无缝换号」（设置 → Claude → 智能路由，打开自动换号后出现）：打开后，当前账号的额度快用满（98%）或撞到上限时，bridge 会在 Claude 两步操作之间悄悄换到号池里下一个还有余量的账号，正在进行的对话不中断、不报错、也不用重发或补一句「接着做」，一个长任务可以跨好几个号一口气做完；手机没开、页面关着时也照样接得上。换号时发起对话的那台设备上会弹一个小提示，「最近的自动切换」里也有记录。只是快满的号不会在几个同样快满的号之间来回倒。注意：换号后新账号的第一步要重新读一遍对话上下文，会多用一点额度。':
    'The Claude account pool’s automatic switching has a new option, “Switch accounts mid-conversation” (Settings → Claude → Smart routing, shown once automatic switching is on). When it’s on and the active account is almost at its limit (98%) or hits it, The Bridge quietly moves to the next account with usage left between Claude’s steps. The conversation in progress keeps going with no error, no resend and no need to say “continue”, so a long task can run across several accounts in one go, even with your phone off or the page closed. The device that started the conversation shows a small notice when this happens, and it’s listed under “Recent automatic switches”. Accounts that are only almost full won’t be swapped back and forth. Note: the first step on the new account rereads the conversation, which uses a little extra usage.',
  'Claude 侧栏里会话很多的工作空间不再把整条列表撑得老长了：每个工作空间默认只列最新的 10 条会话，底下多一行「显示更多（剩余条数）」，点一下再往下放 20 条，全部放完变成「收起」，点一下收回到 10 条。正打开着的那条会话即使排在后面，也会单独显示在这一组末尾，不会在侧栏里找不到；一家子的父子会话不会被从中间截断。':
    'Workspaces with lots of sessions no longer stretch the Claude sidebar: each workspace lists only its 10 most recent sessions, with a “Show more (n)” row below that reveals 20 more per tap; once everything is shown it turns into “Collapse” to go back to 10. The session you have open still shows at the end of its group even if it’s further down, and parent/child session families are never split in the middle.',
  '工作空间新增两件事：① 能直接新建 Markdown 笔记了——手机上点右上角「＋」→「新建 Markdown 文件」，起好名字（不写扩展名会自动补 .md）就直接打开编辑器开写；电脑上在空白处右键或点「＋」选「新建 Markdown 文件」，会像资源管理器那样先建好「未命名.md」并让你当场改名。② 文件和文件夹能压缩了：电脑客户端里右键选「压缩…」（可以多选一起压），会直接弹出 Windows 自带的「创建存档」窗口，格式（7z / zip / tar）、压缩方式、级别都在里面选，存档默认放在同一个文件夹；手机和网页上长按文件或文件夹选「压缩…」，可以改存档名、选 ZIP / 7Z / TAR.GZ（电脑装了 WinRAR 时还有 RAR）和压缩级别，压好会出现在同一个文件夹里。大文件夹压得久时可以直接关掉窗口，电脑会在后台继续压完。zip 里的中文文件名在 Mac、手机上解开也不会乱码。另外修好电脑工作空间里按 F2 改名时没有自动选中文件名、一打字就接在旧名字后面的问题。':
    'Workspace adds two things: ① You can now create Markdown notes directly. On your phone, tap + in the top-right corner → New Markdown file, give it a name (.md is added if you leave it off), and the editor opens so you can start writing. On the computer, right-click an empty area or click + and choose New Markdown file. Like File Explorer, it creates “Untitled.md” and lets you rename it right away. ② Files and folders can be compressed. In the desktop app, right-click and choose Compress… (multiple items work too) to open the Windows Create archive window, where you pick the format (7z, zip, or tar), method, and level. The archive goes in the same folder by default. On your phone or the web, press and hold a file or folder and choose Compress… to set the archive name, pick ZIP, 7Z, or TAR.GZ (plus RAR if WinRAR is installed on the computer) and a compression level. The archive appears in the same folder. If a large folder takes a while, you can close the window and the computer keeps compressing in the background. Chinese file names inside zip archives no longer turn into garbled text on Mac or phones. Also fixed: pressing F2 to rename in the desktop workspace now selects the name, so typing replaces it instead of adding to the end.',
  'dimensio 的浏览器扩展修了两个问题：① 电脑上 Edge 和 Chrome 都装了扩展时，以前两个浏览器每隔一分钟就互相抢连接，dimensio 操作到一半标签页会突然断掉，也没法指定用哪一个；现在两个可以同时连着、互不干扰，你说「用我的 Chrome」它就去 Chrome、说 Edge 就去 Edge，扩展弹窗里也会正确显示是 Chrome 还是 Edge（扩展会自动更新到 0.2.0）。② dimensio 在你自己的 Edge / Chrome 里操作时，不会再把右侧的内置浏览器面板拉出来挡视线；它干活时你手动关掉右侧面板，这一轮也不会再自己弹出来。另外连接断了时，它会去重新连你的浏览器，不会错开一个没登录的内置浏览器接着干。':
    "Two fixes for dimensio's browser extension: ① With the extension installed in both Edge and Chrome, the two browsers used to steal the connection from each other about once a minute, so dimensio's tab could drop mid-task and there was no way to pick one. Now both stay connected side by side; say “use my Chrome” and it goes to Chrome, say Edge and it goes to Edge, and the extension popup shows which browser it is (the extension updates itself to 0.2.0). ② When dimensio works in your own Edge / Chrome, it no longer pops open the built-in browser panel on the right; if you close that panel while it is working, it stays closed for the rest of that turn. Also, if the connection drops, it reconnects to your browser instead of carrying on in a built-in browser that isn't signed in.",
  'Claude 能自己开子会话、和别的会话互相说话了（和官方桌面版一样）：让它「另开一个会话去做某件事」或「这几件事并行做」，它会给那件事开一个真正的新会话，在左侧栏里缩进挂在当前会话下面，你随时能点开看它在干什么、直接在里面接着聊。子会话做完这一轮，会自动把结果汇报回来，原来的会话收到汇报后接着往下做或者跟你说结论，不用你来回切换传话；对话里会出现一张「子会话的汇报」卡片，点标题就能跳过去。会话之间也能互发消息：父会话可以给子会话追加要求，子会话卡住了也会主动来问，对方空闲时会被自动叫醒处理。右上角「会话信息」里多了「相关会话」一栏，列出父会话、子会话和兄弟会话，正在干活的会亮一个小点。为防止两个会话没完没了地互相叫醒，连续自动跑了几轮之后会先停下，等你下次发话时再一起处理。':
    "Claude can now start its own sub-sessions and talk to other sessions, like the official desktop app: ask it to “do this in a separate session” or “do these in parallel”, and it opens a real new session for that piece of work, nested under the current one in the sidebar, so you can open it any time to see what it’s doing or keep chatting there. When a sub-session finishes its turn it reports back automatically, and the original session picks up from there or tells you the outcome, with no copying messages back and forth; a “Report from a session” card appears in the conversation, and tapping its title jumps there. Sessions can also message each other: the parent can send a sub-session more instructions, a stuck sub-session can ask the parent, and an idle session is woken up to handle the message. Session info (top right) has a new “Linked sessions” section listing the parent, child and sibling sessions, with a small dot on the ones that are working. To keep two sessions from waking each other up forever, after several automatic turns in a row they pause until you next send a message.",
  '扩展页重新做了，直接并进设置里，样子和官方 Claude 桌面 App 的「自定义」一模一样：顶上是「技能 / 连接器 / 插件 / 功能扩展」和「我的 / 发现」，旁边有搜索、筛选、排序和「添加」菜单。「发现」里就是官方同一套默认市场——Anthropic 官方插件目录、Anthropic 知识工作插件和 Anthropic 官方技能，一共三百多个技能、九十多个连接器、四百多个插件，按「推荐给您」和「全部」两栏卡片排好，点卡片右上角的「+」就能一键装上，装好变成对勾；顶上的大卡片推荐一套现成的（比如 Productivity），点「添加」整套装好。「我的」里是已经装上的，同样的卡片，右上角是开关，点进去能选对哪些 agent 生效、看文件、替换、下载、卸载。「添加」菜单里还能上传自己的技能和插件、手动加连接器，或者加别的 GitHub 市场。电脑上在设置左栏的「扩展」，手机上在设置 → 服务器 → 扩展。':
    'The Extensions page has been rebuilt right into Settings and now looks just like Customize in the official Claude desktop app: across the top are Skills / Connectors / Plugins / Feature extensions and Mine / Discover, next to search, filter, sort and an Add menu. Discover shows the same default marketplaces as the official app — the Anthropic plugin directory, Anthropic knowledge-work plugins and Anthropic’s own skills, over 300 skills, 90+ connectors and 400+ plugins — laid out as “Recommended for you” and “All” cards. Tap the + on a card to install it in one go; it turns into a check mark. The big card at the top suggests a ready-made set (such as Productivity) that Add installs whole. Mine lists what you’ve installed with the same cards and a switch in the corner; open one to choose which agents it applies to, browse its files, replace, download or uninstall it. The Add menu also lets you upload your own skills and plugins, add a connector by hand, or add another GitHub marketplace. On the computer it’s Extensions in the Settings sidebar; on the phone, Settings → Server → Extensions.',
  '壁纸两处调整：① 修好电脑客户端里选了自己上传的壁纸后主页一片黑——现在选上就能正常显示，底部 Dock 的玻璃也照常透出壁纸。② 空间壁纸（随视角产生景深）不再由电脑现场生成：默认的多洛米蒂照旧可以直接打开；自己上传的壁纸，上传时同时选中原图和它的深度图（深度图文件名带 depth，白色近、黑色远），就会出现「空间壁纸」开关；只传一张照片就是普通壁纸，不再显示这个开关。以前已经做好景深的上传壁纸不受影响。':
    'Two wallpaper changes: ① Fixed the home screen turning black in the desktop app after you chose a wallpaper you uploaded. It now shows right away, and the Dock glass shows the wallpaper through it as before. ② Spatial wallpaper (depth that shifts with your view) is no longer generated on your computer. The default Dolomites wallpaper still works as before. For your own wallpaper, choose the photo and its depth map together when uploading (put “depth” in the depth map’s file name; white is near, black is far) and the Spatial wallpaper switch appears. Upload just a photo and it’s a regular wallpaper without that switch. Uploaded wallpapers that already have depth aren’t affected.',
  "Claude 用到额度上限时，现在会出现一张和官方桌面版一样的限额卡：标题写明是「已达到 5 小时限额」还是「已达到每周限额」（或某个模型的限额），下面告诉你几点重置；点「查看详情」能看到原始提示，点「重试」就接着来——这一轮什么都还没做就原样重发，做了一半就让 Claude 从中断的地方继续。以前这种情况要么只冒出一句英文，要么这一轮看起来像是悄无声息地结束了。5 小时限额的卡片上还有一个「限额重置后自动继续」的勾选框，默认勾着：到了重置时间，电脑会自动让 Claude 接着把活干完，卡片上会写「将于 几点 自动继续」。手机锁屏、App 退到后台、网页关掉都不影响；你提前自己发了消息，它就不再自动发。取消勾选后会记住，以后撞到限额默认都不自动继续，想要时再勾上。":
    "When Claude hits a usage limit, you now get a limit card just like the official desktop app: the title says whether you reached your session (5-hour) limit, your weekly limit or a model’s limit, and below it tells you when it resets. “View details” shows the original message, and “Try again” picks things back up — if nothing had been done yet it resends your message, and if Claude was halfway through it asks Claude to continue from where it stopped. Before, you either got a single line of English or the turn just seemed to end silently. Cards for the 5-hour limit also have an “Auto-continue when limits reset” checkbox, ticked by default: when the limit resets, your computer automatically tells Claude to finish the job, and the card shows “Auto-resuming at …”. It works even if your phone is locked, the app is in the background or the web page is closed; if you send something yourself first, it won’t send anything. Unticking it is remembered, so later limits won’t auto-continue until you tick it again.",
  "Claude 输入框会记住你没发出去的内容了：在一个对话里打了一半的提示词、加好的附件（图片、文件、文件夹），切到别的对话、最小化、关掉窗口甚至划掉 App 都不会丢，回到这个对话时原样都在。每个对话各存各的，切到别的对话不会把这边的内容带过去；还没发第一条的新对话也单独记一份。附件还在上传时切走也没关系，它会在后台传完，回来就能看到。发出去之后这份草稿自动清掉，30 天没动过的草稿也会自动清理。":
    "The Claude message box now remembers what you haven't sent yet: a half-written prompt and the attachments you added (images, files, folders) stay put when you switch to another conversation, minimize, close the window or even swipe the app away — come back to that conversation and it's all still there. Each conversation keeps its own draft, so switching doesn't carry this one over, and a new chat that hasn't been sent yet keeps one of its own. If an attachment is still uploading when you switch away, it finishes in the background and is there when you return. The draft clears itself once you send, and drafts untouched for 30 days are cleaned up automatically.",
  "手机上 Claude 工作台的卡片（文件、审阅、任务这些）下拉收起更跟手了：以前只有卡片顶上那根小横条能拖，手指放在内容上往下拉，卡片纹丝不动。现在和手机原生 App 一样，内容已经滚到最顶上时，在卡片任何地方往下拉都能把它拉下来，卡片紧贴着手指走，背后的遮罩跟着慢慢变淡；松手时拉得够远或甩得够快就收起，否则弹回原位。内容还没滚到顶时往下拉照常是滚动内容。终端、浏览器画面、编辑器和卡片里打开的预览不受影响，长按文件拿起来拖也照旧。":
    "Pulling down Claude's workbench card on the phone (Files, Review, Tasks and so on) now follows your finger: before, only the small bar at the very top of the card could be dragged — putting your finger on the content and pulling down did nothing. Now it works like native phone apps: once the content is scrolled all the way to the top, pulling down anywhere on the card drags it down, right under your finger, while the dimmed background fades. Let go after pulling far enough, or with a quick flick, and it closes; otherwise it springs back. If the content isn't at the top yet, pulling down still just scrolls it. The terminal, the browser view, editors and previews opened inside the card aren't affected, and long-pressing a file to pick it up works as before.",
  "工作台里的「文件」卡片和其它卡片长得一样了：以前只有它右上角没有放大、关闭按钮，要点左上角的返回才能收起，不好上手；现在电脑上右上角同样是「放大铺满 / 关闭」，Codex 工作区的文件视图顶栏也和其它工具一致。手机上工作台顶部那排工具切换条，右边的收起按钮固定在最右侧，不会再被挤出屏幕；当前选中的工具会自动滚到能看见的位置。另外，文件页里的 ↑（电脑）和 ‹（手机）现在只管「回到上一级」：以前在工作空间或对话文件夹的根目录上它就点不动了，现在只要上面还有文件夹就能一路往上走，直到盘符根目录。":
    "The Files card in the workbench now looks like every other card: it used to be the only one without Maximize and Close buttons in its top-right corner, and you had to tap Back at the top left to close it. On desktop it now has the same Maximize / Close buttons, and the Files view in the Codex workspace keeps the same top bar as the other tools. On phones, the Collapse button at the right end of the workbench tool bar stays pinned to the right edge instead of being pushed off screen, and the selected tool scrolls into view automatically. In addition, ↑ (desktop) and ‹ (phone) in the file browser now only mean \"go up one level\": they used to stop working at the root of the workspace or the conversation folder, and now they keep going up as long as there is a parent folder, all the way to the drive root.",
  "修好聊天里 Claude 生成的图片经常丢失：① 以前在家连着 WiFi 时，图片有时直接显示成一个破图标和一长串英文描述，现在加载不出来会自动换一条线路重试几次；实在加载不了，会显示一张小卡片「图片加载失败 · 重试」，点一下重新加载，不再是破图。② 以前重新打开对话、或者这一轮结束后界面刷新时，之前生成的图会整张消失；现在图会跟着对话一起保存，重新打开也都在——包括 Claude 派出去的子任务生成的图，以及生成失败的提示。另外点一下聊天里的图可以全屏放大查看、下载。":
    "Fixed images that Claude generates in chat often going missing: (1) On home Wi-Fi an image would sometimes show up as a broken icon with a long English description. Now, if it doesn't load, the app automatically switches to the other connection and retries a few times; if it still can't load, you get a small \"Couldn't load image · Try again\" card you can tap, instead of a broken image. (2) Images used to vanish when you reopened a conversation or when the screen refreshed after a turn finished. Now they're saved with the conversation and are still there when you reopen it — including images made by sub-tasks Claude sent off, and the messages for images that failed to generate. You can also tap an image in chat to view it full screen and download it.",
  '修好 bridge 里打开网页文件（.html）经常黑屏、加载不出来：以前只把这一个文件的文字拿去显示，页面旁边的脚本、样式、图片、音视频（比如课件文件夹里的 app.js、assets）全都找不到，所以电脑上双击能开、bridge 里却一直转圈。现在会把整个文件夹一起交给页面，和电脑上打开一个样；页面需要记设置、记进度也不会再出错。网页阅读器也重新设计了：顶上换成一条跟随明暗主题的细工具栏，不再是一条大白条；加载时只在工具栏底边走一根细线，页面出来前不闪白；右边多了刷新、全屏、在浏览器中打开和下载；打开后键盘直接交给页面，课件和幻灯片用方向键、空格就能翻页。':
    "Fixed web pages (.html) often opening to a black screen in bridge: only the page's own text used to be loaded, so the scripts, styles, images and media next to it (like app.js and assets/ in a courseware folder) were never found — the page opened fine when you double-clicked it on the computer but spun forever in bridge. Now the whole folder is handed to the page, just like opening it on the computer, and pages that save settings or progress no longer break. The web page viewer was also redesigned: the top is a slim toolbar that follows the light/dark theme instead of a big white bar; while loading, only a thin line runs along its bottom edge and there is no white flash before the page appears; on the right are Refresh, Full screen, Open in browser and Download; and the keyboard goes straight to the page, so slides and courseware can be paged with the arrow keys or Space.",
  '手机上的设置页重新设计了一遍，看起来更安静、更耐看：① 配色换成和 App 图标同一套的「墨色 + 象牙白」，不再是一排五颜六色的图标块；开关、勾选和主按钮都用同一种墨色，红、黄、绿只在提示状态时出现。② 图标统一成一套细线图标；Claude、Gemini、Antigravity、ChatGPT · Codex、dimensio 换成了它们自己的真实标志。③ 重新分组：账户在最上面，「软件更新 / 提交反馈 / 关于」收在最后一组，「通知」挪进了「通用」；点进某个 agent 时，顶上是它的标志和名字。④ 「外观」里可以直接选明亮或深色了。⑤ Claude 号池里当前在用的号标「使用中」，刷新用量换成一枚小刷新按钮，调整账号顺序从两整行合成一行上下箭头。':
    'The Settings page on your phone has been redesigned to look calmer and more polished: (1) The colors now match the app icon — ink and ivory — instead of a row of brightly colored icon tiles. Switches, check marks and main buttons all use the same ink color; red, amber and green only appear to show a status. (2) Icons are now one consistent set of fine line icons, and Claude, Gemini, Antigravity, ChatGPT · Codex and dimensio show their real logos. (3) Things are regrouped: your account is at the top, Software Update / Send Feedback / About are together at the bottom, and Notifications moved into General. When you open an agent, its logo and name are shown at the top. (4) You can now pick Light or Dark directly in Appearance. (5) In the Claude account pool, the account you’re using is marked “In use”, refreshing usage is a small refresh button, and reordering accounts is one row with up and down arrows instead of two full rows.',
  'Claude 新对话的第一条回复更快了：在新对话的输入框里点一下或开始打字时，电脑就提前把 Claude 准备好，发出去后不用再等它启动，第一句话出来快一两秒（只对你自己电脑上的主账号生效）。另外手机通知栏更有用了：Claude 主动给你发的提醒（比如「构建跑完了」「需要你确认一下」）现在真的会弹到手机通知栏；它在等你回答问题时，通知栏也会弹出「Claude 在等你回答」和问题原文，答完自动消失——不用一直盯着屏幕。App 开在前台时不弹，免得重复。':
    "The first reply in a new Claude chat now arrives sooner: as soon as you tap into a new chat’s input box or start typing, your computer gets Claude ready in advance, so after you send there’s no startup wait — the first words appear a second or two earlier (for the main account on your own computer). Phone notifications are more useful too: reminders Claude sends you on purpose (like “the build finished” or “I need you to confirm something”) now actually pop up in your phone’s notification shade, and when Claude is waiting for you to answer a question you get a “Claude is waiting for your answer” alert with the question, which goes away once you answer — no need to keep watching the screen. Nothing pops up while the app is open in front of you.",
  '手机上的工作空间页重新排了版：① 顶栏返回键右边多了一枚位置按钮（比如「主目录 ⌃⌄」），在任何一层文件夹里点它都能直接换到工作空间、主目录或任意一个盘，不用再先退回根目录找那排位置；从对话打开时，菜单最下面还有「对话文件夹」，走远了一下就能回去。② 路径条永远只占一行：名字太长的自动省略，层级太深时中间收成「…」，点一下列出所有上级文件夹、直接跳过去。③ 以「.」开头的隐藏文件夹和文件（.android、.cache、.git 这类）默认收起，「文件夹」标题右边的「显示隐藏项」能随时放出来，搜索时照常能搜到。在工作台里打开时，退到位置的根目录再按返回就直接收起，不再绕回主工作空间。':
    'The Workspace page on your phone has a cleaner layout: ① A location button now sits next to Back in the top bar (e.g. “Home ⌃⌄”) — from any folder, tap it to jump straight to the workspace, your home folder or any drive, instead of backing out to the root first. When opened from a conversation, the menu also has “Conversation folder” to get back in one tap. ② The path bar always stays on one line: long names are shortened, and deep paths collapse the middle into “…”, which lists every enclosing folder when tapped. ③ Hidden items starting with “.” (.android, .cache, .git…) are tucked away by default; “Show hidden” next to the Folders heading brings them back, and search still finds them. In the side panel, pressing Back at a location’s root now closes the panel instead of detouring through the main workspace.',
  '手机上工作台侧栏里的「工作空间」现在任何对话都能看全盘了：以前对话的文件夹不在主工作空间里时（比如快照对话），侧栏只能看到这一个文件夹，没有「位置」、也没有「本地」页签；现在和其它对话一样——打开时直接落在这个对话的文件夹（比如「主目录 › .bridge-quickchat › …」），点路径最前面一段回到这个位置的根，就能在「位置」里换到工作空间、主目录或任意一个盘。':
    'The Workspace in the side panel on your phone can now browse the whole computer from any conversation: before, a conversation whose folder was outside the main workspace (snapshot chats, for example) only showed that one folder, with no Locations and no Local tab. Now it works like every other conversation — it opens right in that conversation’s folder (e.g. “Home › .bridge-quickchat › …”), and tapping the first part of the path takes you to that location’s root, where Locations lets you switch to the workspace, your home folder, or any drive.',
  '电脑客户端的四个功能改成了可选扩展：Gemini（含图像 / 视频 / 语音 / 音乐生成）、ChatGPT · Codex、Antigravity、dimensio 不再装在主程序里，在「设置 → 扩展 → 功能扩展」里用随安装包附带的离线包安装，装好重启一下就出现对应的分页；没装的就是只有 Claude 的精简版，打开直接进 Claude。扩展可以随时卸载、撤销，开关就是这个功能的总开关。电脑客户端更新时，已经装好的扩展会一起换成新版。你自己电脑上的 bridge 照旧四样全有，用起来和以前一样。另外修好了 Antigravity 选不到模型的问题（模型换成了它现在提供的 Gemini 3.8 Flash 等），也修好了只剩 Claude 时打开扩展中心背后透出设置窗口的问题。':
    'Four features of the desktop app are now optional modules: Gemini (including image / video / speech / music generation), ChatGPT · Codex, Antigravity and dimensio no longer ship inside the main program. Install them under Settings → Extensions → Modules from the offline packages that come with the installer, restart once, and their pages appear; without them you get a lean Claude-only edition that opens straight into Claude. Modules can be uninstalled or undone at any time, and the switch turns the feature on or off. When the desktop app updates, installed modules are updated along with it. Bridge on your own computer still has all four and works exactly as before. Also fixed: Antigravity couldn’t find a usable model (the list now matches what it offers, such as Gemini 3.8 Flash), and with only Claude enabled, the Settings window no longer shows through behind the Extensions page.',
  '设置重新整理了，按 agent 分开放：设置首页多了一组「Agent」，Claude、Gemini、Antigravity、ChatGPT · Codex、dimensio 和全局助手各占一行，点进去就是它自己的设置——开关、有没有配好认证，以及只属于它的选项。Claude 那页能直接管订阅号池了：每个号的 5 小时、每周、Fable 用量一眼看清，点一下切换当前号，还能添加、改名、换 token、删除、调整顺序，「额度用尽自动换号」也在这里开关；原先放在「通用」里的输入建议和思考动画也挪到了这一页。管理员在手机上还多了「额度与注册」（注册开关、注册用户默认额度、换日时区）和 Antigravity 的「重启常驻进程」。这些以前只能在电脑的服务端控制台里改，现在出门在外也能改；会影响连接的服务启停、隧道和客户端配对仍只在电脑上。另外，设置里的大段解释小字基本都去掉了，只留状态和必要的一句提示，页面清爽很多。':
    'Settings are reorganized by agent: the Settings home now has an Agents group with a row each for Claude, Gemini, Antigravity, ChatGPT · Codex, dimensio and the global assistant. Open one to find its own settings — whether it’s on, whether it’s signed in, and the options that belong only to it. The Claude page now manages the subscription pool directly: see each account’s 5-hour, weekly and Fable usage at a glance, tap to switch the active account, and add, rename, replace the token of, delete or reorder accounts; “Switch accounts when a limit is reached” is here too, and prompt suggestions and the thinking animation have moved here from General. Admins also get Quotas & sign-ups (registration, default quotas for registered users, the time zone for daily resets) and Antigravity’s Restart Background Process on the phone. These used to be changeable only in the admin console on the computer; now you can change them on the go. Things that can affect the connection — starting and stopping the service, the tunnel and client pairing — stay on the computer. The long explanatory text throughout Settings is mostly gone too, leaving just status and a short note where it matters.',
  '修好电脑客户端右上角的按钮和系统按钮叠在一起：以前把窗口最大化、拖宽或贴边后，Claude 页右上角那排按钮（终端、审阅、浏览器、更多）会滑到最小化/最大化/关闭按钮底下，点不到也看不清。现在无论怎么调整窗口大小，这排按钮都会停在系统按钮左边。':
    'Fixed the buttons in the top-right corner of the desktop app overlapping the system buttons: after maximizing, widening or snapping the window, the row of buttons on the Claude page (Terminal, Review, Browser, More) could slide underneath the minimize/maximize/close buttons, making them hard to see and click. They now always stay to the left of the system buttons, however you resize the window.',
  'Claude 号池新增「智能路由」（可选，默认关）：在电脑的服务端控制台 →「Claude 账号」页打开「额度用尽自动换号」后，当前账号的 5 小时、每周或所用模型的额度用满（或 token 失效）时，bridge 会自动换到号池里还有余量的账号。开聊前就知道当前号满了的，会先查一遍其余各号此刻的余量、直接用能用的号回答；聊到一半撞上限的，会立刻换号并自动用新号重发这条消息（已经做了一半的任务就让它接着做），你什么都不用点。额度按本轮用的模型判断：Opus 用满不影响用 Fable，Pro 号没有 Fable 额度也不会被选来跑 Fable。还可以再打开「额度恢复后回到首选号」：主号额度一恢复就自动切回来，备用号只在主号用满期间顶上，列表顺序就是优先级，用 ↑↓ 调整。定时任务同样会自动换号。':
    'Claude account pool now has “Smart routing” (optional, off by default). In the server console on your computer, go to Claude accounts and turn on “Switch accounts when a limit is reached”. When the active account hits its 5-hour, weekly, or model-specific limit (or its token stops working), The Bridge switches to an account in the pool that still has usage left. If the account is already known to be at its limit before a chat turn starts, The Bridge checks the other accounts live and answers with one that has room. If a limit is hit mid-turn, it switches right away and resends your message on the new account automatically (or picks up where it stopped if a task was already underway), so you don’t have to tap anything. Limits are checked for the model in use: a full Opus limit doesn’t block Fable, and Pro accounts, which have no Fable usage, are never picked for Fable. You can also turn on “Return to the first account when its limit resets”: The Bridge switches back to your main account as soon as it resets, and backups only fill in while it’s at its limit. The list order sets the priority, so use ↑↓ to change it. Routines switch accounts automatically too.',
  'dimensio 的 fast mode 不会再卡住了：上一版打开 fast mode 后，如果你的 Anthropic 账号没有 fast mode 额度，对话会一直显示「被限流，N 秒后重试」、一个字也不出。现在遇到这种情况会立刻改用普通速度回答，对话里出现一行「Fast mode 被限流，已改用普通速度，15 分钟内不再尝试」，15 分钟后再自动试一次 fast。':
    'Fast mode in dimensio no longer gets stuck: in the previous version, if your Anthropic account had no fast mode quota, a conversation with fast mode on kept showing “Rate limited, retrying in N seconds” and never produced any text. Now it immediately answers at normal speed instead, a line in the conversation says “Fast mode is rate-limited — switched to normal speed; won’t retry fast for 15 min”, and it tries fast again automatically after 15 minutes.',
  'dimensio 用 Claude 时可以开 fast mode 了：在输入框右下角点型号名，选 Opus 5.5、Opus 5 或 Opus 4.8 时，菜单里多了一个「Fast mode」开关，打开后回答输出更快，但按 Anthropic 更高的单价计费。开着时型号旁边会写「Fast」。开关会一直记着：切到不支持的型号（比如 Sonnet、Haiku）时自动不生效，切回来照旧开着；关掉后，正在进行的对话从下一次请求起就按普通速度计费。':
    'dimensio can now use fast mode with Claude: tap the model name at the bottom right of the input box, and with Opus 5.5, Opus 5 or Opus 4.8 selected the menu has a new Fast mode switch. Turned on, answers stream out faster but are billed at Anthropic’s higher rate. While it is on, “Fast” appears next to the model name. The switch is remembered: it simply has no effect on models that do not support it (such as Sonnet or Haiku) and is still on when you switch back; turning it off makes conversations already in progress use normal speed from the next request.',
  '修好安卓手机上看不到新对话空白页的动态字符背景：上一版在部分安卓手机（比如三星折叠屏）上，因为浏览器内核少了一项后台编译功能，背景直接不显示。现在这些手机上也能看到了：满屏淡字符像被风吹过一样亮起流动，手指点一下空白处会荡开一圈蓝光波纹。':
    'Fixed the animated character background not showing on the blank page of a new conversation on some Android phones (such as Samsung foldables): the previous version gave up because the phone’s browser engine lacks a background shader-compilation feature. It now shows on those phones too: faint characters light up and drift as if blown by wind, and tapping empty space sends out a ripple with a blue glow.',
  'Claude 新对话的空白页换上了官方桌面版同款的动态背景：满屏淡淡的等宽字符，像被风吹过一样一阵阵亮起、流动，字符自己也在慢慢变换。鼠标划过会把那一片「吹亮」，点一下空白处会荡开一圈带蓝光的波纹（连点三下，第三下是一颗心形）。输入框和用量卡周围会自动变淡，不影响看字。为了省电，它跑三分钟左右就会慢慢停下来，鼠标一动又会继续；窗口切到后台也会停。只在还没开始聊的空白页显示，一发消息就消失；不支持的设备（比如 iPhone 的 Safari、没有显卡加速的电脑）不显示。':
    'The blank page of a new Claude conversation now has the same animated background as the official desktop app: a field of faint monospace characters that light up and drift in waves, as if blown by wind, while the characters slowly change. Moving the mouse brightens the area it passes, and clicking empty space sends out a ripple with a blue glow (every third click makes a heart). It fades around the input box and the usage card so text stays readable. To save power it slows to a stop after about three minutes and resumes when you move the mouse, and it pauses when the window is in the background. It only appears on the blank page before you start chatting and disappears once you send a message; it does not show on devices that cannot support it (such as Safari on iPhone, or computers without graphics acceleration).',
  'Claude 回答的过程中也能接着发消息了（和官方桌面版一样）：① 直接按回车（手机上点发送）是「插话」——这句话立刻送到 Claude 那里，它做完手头这一步就会读到并照着调整，不用停下来重来，插话会以一个小气泡夹在回答里。② 按 Ctrl+Enter（手机上点发送键右边的小箭头，选「稍后发送」）是「排队」——等 Claude 这一轮做完再自动发出，排了好几条会合并成一条一起发。排着的消息显示在输入框上方，可以立即发送、放回输入框改、删掉或拖动调整顺序；输入框空着时按 ↑ 也能把最后一条取回来改。排队消息存在电脑上，手机和电脑看到的是同一份，页面关了也照样会发。另外，电脑上右上角那排按钮最前面多了一个「会话信息」：一列卡片显示这个对话的环境（文件夹、分支）、上下文用了多少（可以一键压缩）、连接的工具状态、这个对话产出的文件（点开直接预览），以及改了多少代码，点「提交更改」就让 Claude 自己把改动提交。':
    'You can now keep sending messages while Claude is answering, just like the official desktop app. (1) Press Enter (or tap Send on the phone) to steer: the message reaches Claude right away, and it reads it as soon as it finishes the current step and adjusts, without stopping. It shows up as a small bubble inside the answer. (2) Press Ctrl+Enter (on the phone, tap the small arrow next to Send and choose Queue for later) to queue it: it is sent automatically once Claude finishes this turn, and several queued messages are combined into one. Queued messages appear above the input box, where you can send one now, move it back into the input box to edit, remove it, or drag to reorder; with the input box empty, press ↑ to bring back the last one. The queue is kept on your computer, so your phone and computer see the same list, and it is still sent if you close the page. On desktop there is also a new Session details button at the front of the top-right buttons: cards showing the session’s environment (folder, branch), how much context is used (with one-click compact), connector status, the files this session produced (click to preview), and how much code changed. Commit changes asks Claude to commit them.',
  'Claude 侧栏能看出会话之间的「父子关系」了（和官方桌面版新出的子会话树一样）：在官方 Claude 桌面版里，由一个会话派生出去的会话（让 Claude 另开的新会话、点建议任务卡开的、从某处分叉出来的），现在会缩进挂在原来那个会话下面，左边一根细线串起来，一眼就知道哪些是同一件事的分支；一家子按其中最新的那条排位置。另外，桌面版这类会话很多是在单独的 worktree 副本里跑的，以前在 bridge 里根本看不到，现在会列在所属项目下面，点开能看完整记录、接着聊。':
    'Claude’s sidebar now shows which sessions came from which (the same session tree the official desktop app just added): sessions spun off from another one in the official Claude desktop app — new sessions Claude started, ones opened from a suggested-task card, or forks — are now indented under the session they came from, joined by a thin line on the left, so you can see at a glance which ones belong to the same piece of work. Each family sits where its most recent session would. Many of these sessions run in their own worktree copy and used to be invisible in bridge; they now appear under their project, and you can open them to read the full history and keep chatting.',
  'Gemini 对话上架 Google 最新的 Gemini 4 Argon（dimensio 的 Gemini 里也能选）。另外 Gemini 的设置全部收进了顶部的模型菜单：点模型名，同一张菜单里就能选模型、思考等级（直接点 Low / Medium / High），开关联网搜索、读取网址、代码执行，选识图清晰度，改系统提示词；输入框上原来的「工具」按钮去掉了。电脑上菜单分左右两栏，左边模型、右边设置，不用滚动就能看全。':
    'Gemini chat now offers Google’s latest Gemini 4 Argon (also available under Gemini in dimensio). All Gemini settings now live in the model menu at the top: tap the model name to pick a model and thinking level (tap Low / Medium / High), toggle Google Search, URL context and code execution, choose media resolution, and edit the system prompt — all in one menu. The separate Tools button on the input box is gone. On desktop the menu has two columns, models on the left and settings on the right, so everything is visible without scrolling.',
  '界面上的按钮、菜单、选择器、设置项不会再被拖选成一块块灰底了：以前在电脑客户端里拖动鼠标或按 Ctrl+A，模型和思考深度选择器、设置页、主页 Dock 图标都会被选中变灰。现在全站统一成原生 App 的做法——只有正文能选中复制：Claude、dimensio、Gemini、Antigravity 的回答和你发的消息，思考过程，工具的参数和输出，各种报错，文件和 Office 预览，扩展说明，服务日志，以及设置和管理台里的地址、版本号、邀请码、路径这类值。拖选回答时，代码块上的复制按钮也不会再被一起选进去。':
    'Buttons, menus, pickers and settings rows no longer get dragged into grey selection blocks: in the desktop client, dragging the mouse or pressing Ctrl+A used to select the model and effort pickers, the settings page and the home Dock icons. Now the whole app works like a native app — only content can be selected and copied: replies and your messages in Claude, dimensio, Gemini and Antigravity, thinking, tool inputs and outputs, error messages, file and Office previews, extension descriptions, service logs, plus values such as addresses, version numbers, invite codes and paths in Settings and the admin console. Copy buttons on code blocks are no longer swept into a selection of a reply either.',
  'dimensio 左侧列表和真实的对话对齐了：① 快照对话不会再莫名消失——以前只要在别的设备（或别的窗口）点了「新建快照」，正在进行的那条快照对话就从所有侧栏里不见了；现在它会留在「快照对话」下面，跑完后还会再保留半小时。② 在任意一台设备上新建或删除对话、新建快照、存为工作空间、新建或改名项目，其他开着的手机和电脑会马上跟着更新，不用再手动刷新；手机从后台切回来时也会自动对一遍。':
    'The dimensio sidebar now matches your actual chats: ① Snapshot chats no longer vanish — before, tapping “New snapshot” on another device (or another window) made the snapshot chat in progress disappear from every sidebar; now it stays under “Snapshot chat”, and remains for half an hour after it finishes. ② Creating or deleting a chat, starting a new snapshot, saving a snapshot as a workspace, or adding or renaming a project on any device now updates every other open phone and computer right away, no manual refresh needed; your phone also catches up when you switch back to the app.',
  'dimensio 两处修正：① 新对话发出第一句后，左侧列表里马上就能看到它（以前要等这一轮回答完才出现，中途刷新也看不到）。② 切换模型服务时会沿用你在这家上次用的型号和思考深度——比如常用 Opus 5.5，切回 Claude 默认就是 Opus 5.5；从没用过的话，Claude 默认也换成了当前主力 Opus 5.5，不再是老的 Sonnet 4.6。':
    'Two dimensio fixes: ① After you send the first message of a new chat, it shows up in the left-hand list right away (before, it only appeared once the reply finished, and refreshing midway didn’t help). ② Switching model providers now keeps the model and thinking level you last used with that provider — if you usually use Opus 5.5, switching back to Claude defaults to Opus 5.5. If you’ve never used it, Claude now defaults to the current flagship Opus 5.5 instead of the older Sonnet 4.6.',
  '快照对话现在能留下来了：Claude 里在快照那条对话上点右边的「⋮」或直接右键，选「存为工作空间」；dimensio 里右键快照那一块（手机上点快照行右边的「⋯」）。存好的快照会变成项目列表里一个普通工作空间，名字叫「快照会话 1」「快照会话 2」……对话原样留在里面、可以接着聊，以后再新建快照也不会把它顶掉，Claude 那边「快照只保留最近 10 条」的自动清理也不会动它；快照位置同时换成一个全新的空快照。另外工作空间可以改名了：Claude 里点项目右边的「⋮」或右键项目选「重命名」，默认的那个工作空间也能改；dimensio 里右键项目或点「⋯」选「重命名」，直接在侧栏里改。只改显示的名字，文件夹和对话都不动，名字清空就恢复成文件夹名。':
    'Snapshot chats can now be kept: in Claude, click the “⋮” next to the snapshot chat or right-click it and choose “Save as workspace”; in dimensio, right-click the snapshot section (on a phone, tap the “⋯” on the snapshot row). The saved snapshot becomes a regular workspace in the project list, named “Snapshot session 1”, “Snapshot session 2” and so on. Its chats stay inside and you can keep going; new snapshots won’t replace it, and Claude’s “keep only the latest 10 snapshots” cleanup leaves it alone. The snapshot slot gets a fresh, empty snapshot. Workspaces can also be renamed: in Claude, click the “⋮” next to a project or right-click it and choose “Rename” (the default workspace too); in dimensio, right-click a project or tap “⋯” and choose “Rename” to edit it right in the sidebar. Only the displayed name changes; folders and chats stay as they are, and clearing the name brings back the folder name.',
  'Claude 新对话的空白页换成了官方桌面版同款：左上角写着「接下来做什么？」，下面是一张用量统计卡——会话数、消息数、Token 总数、活跃天数、最常用的时段、用得最多的模型，加上最近半年每天的活跃热力图（鼠标停在格子上看当天多少条消息），还有一句「你用掉的 token 约等于几本书」。右上角可以切全部 / 30 天 / 7 天；点「模型」看每天各模型用了多少 token 的柱状图，以及每个模型的输入输出量和占比。输入框挪到了页面底部，和聊天时的位置一样，样子没变。数据来自这台电脑上的 Claude Code 对话记录，和官方桌面版统计口径一致。':
    'New Claude chats now open on the same start page as the official desktop app: “What’s up next?” at the top left, with a usage card underneath — sessions, messages, total tokens, active days, peak hour and your favorite model, plus a heatmap of daily activity over the last six months (hover a square to see that day’s message count) and a line comparing your tokens to a well-known book. Switch between All, 30d and 7d at the top right; the Models tab shows a chart of daily tokens by model and each model’s input, output and share. The composer has moved to the bottom of the page, where it sits during a chat, and looks the same. The numbers come from this computer’s Claude Code history, counted the same way as the official desktop app.',
  '服务端控制台的「Claude 账号」页能一眼看清每个号还剩多少额度了：每个账号下面多了三根进度条——5 小时、每周、Fable（Max 才有，Pro 号显示「Pro 无此额度」），写着用了百分之几、多久后重置，快满变黄、满了变红并标「已达上限」；账号名旁边标出是 Max 还是 Pro。数据打开页面时自动读取、5 分钟内不重复读，右上角「刷新用量」可以马上重读。另外修好了切换账号对 Claude 对话不生效的问题：以前开着「主机管理员的 Edge」时，对话其实一直在用电脑上登录的那个号，切到别的号照样报限额；现在切到哪个号就用哪个号，Edge 操控照常可用。':
    'The Claude accounts page in the server console now shows how much of each account’s usage limit is left: every account has three bars — 5-hour, weekly and Fable (Max only; Pro accounts show “Not on Pro”) — with the percent used and when it resets. Bars turn amber when nearly full and red with “Limit reached” when full, and each account is tagged Max or Pro. Usage loads when you open the page and is cached for 5 minutes; tap “Refresh usage” to reload now. Also fixed: switching accounts didn’t apply to Claude chats. While “your Edge” was on, chats kept using the account signed in on the computer, so they still hit the limit after you switched; they now use whichever account you pick, and Edge control still works.',
  'dimensio 换到别家模型也不用开新对话了：在「切换模型服务」里点另一家（比如从 MiMo 换到 Claude），就在当前对话里直接换过去，聊过的内容、读过的文件都接着用，下一条消息就由新的模型回答，它也知道前面的回答是别的模型写的、不会认错自己。如果它正在回答，这一轮照旧跑完，从你的下一条消息起换。换到不能看图的模型时，之前发过的图片会告诉它「这里有张图你看不到」，换回能看图的模型照样能看。还没开始聊的新对话，换家和以前一样。':
    'dimensio no longer starts a new chat when you switch to another provider: pick a different one under “Switch model service” (say, from MiMo to Claude) and the current conversation switches over in place — everything said so far and the files it has read carry over, your next message is answered by the new model, and it knows earlier replies were written by other models, so it won’t mistake who it is. If it is in the middle of answering, that turn finishes first and the switch applies from your next message. When you switch to a model that can’t see images, it is told there was an image it can’t view; switch back to a vision model and it can see it again. For a brand-new chat that hasn’t started yet, switching providers works as before.',
  'dimensio 现在能在对话中途换模型了：以前在输入框的模型菜单里换了型号或思考深度，已经开始的对话其实还是用原来的模型回答，只有新对话才生效。现在换完当场生效，下一条消息就由新模型来答，之前的对话内容、读过的文件都接着用；问它是什么模型也会如实答新的。如果它正在回答，这一轮照旧跑完，从你的下一条消息起换成新的。换的是同一家服务里的型号（比如 DeepSeek 内部、或你自己加的模型服务内部）；要换到别家仍需开新对话。':
    'dimensio can now switch models mid-conversation: before, changing the model or thinking effort in the input box menu only affected new conversations — an ongoing one kept answering with the original model. Now the change takes effect right away: your next message is answered by the new model, with the conversation so far and the files it has read carried over, and it will correctly say which model it is. If it is in the middle of answering, that turn finishes as is and the new model takes over from your next message. This switches models within the same provider (e.g. within DeepSeek, or within a model service you added yourself); switching to a different provider still starts a new conversation.',
  'Claude 的自动压缩点可以自己定了：点开输入框左下角的用量圆环，「Context window」那根进度条上多了一根竖条手柄，拖到哪里，对话上下文涨到哪里就自动压缩——比如 1M 的窗口拖到正中间，就是到 500k 自动压缩。拖动时下面会实时写着「到 500k 自动压缩」，拖回最右边就恢复默认。改完从下一条消息起生效，所有对话通用。':
    'You can now choose where Claude auto-compacts: open the usage ring at the bottom left of the input box, and the “Context window” bar has a new handle. Drag it to set how full the context gets before it auto-compacts — on a 1M window, the middle means auto-compact at 500k. While dragging, the line below shows “Auto-compact at 500k”; drag it all the way right to go back to the default. Changes apply from your next message, in every conversation.',
  'dimensio 用起来更顺了：① 长命令（打包、全量测试）跑着时，即使工作过程是精简显示，那一行下面也会显示「已运行多久 · 最新一行输出」，不用点开就知道它在动。② 后台任务结束的通知不再每轮把以前结束过的也重报一遍。③ 每轮自动附带的「相关资料」更准了：工作区里的 git worktree 副本不再被当成项目内容，没点名的代码文件也不会被关键词硬凑进来。④ 它看本机窗口的截图不再被盖在上面的别的窗口挡住，缩放屏上也不会截偏。⑤ 安全拦截更讲理：命令里顺带探一下 bridge 端口不再连累同一句里结束普通进程；删深层目录改成弹卡问你（删根目录、整个用户目录、系统目录照旧直接拒）；只检查某个密钥文件在不在、不读内容的命令放行。':
    'dimensio is smoother to work with: ① While a long command runs (packaging, a full test suite), its row shows “Running 2m 10s · latest output line” even in compact mode, so you can see it is moving without expanding it. ② Background-job notices no longer repeat jobs that already finished earlier. ③ The automatically attached context is more relevant: git worktree copies inside the workspace are no longer indexed as project content, and code files you didn’t mention are no longer pulled in by loose keyword matches. ④ Screenshots it takes of a desktop window are no longer blocked by windows on top, and no longer land off-target on scaled displays. ⑤ Safety checks are more reasonable: briefly probing the bridge port no longer blocks stopping an ordinary process in the same command; deleting a deep folder now asks you first (deleting a drive root, a whole user folder or system folders is still refused); commands that only check whether a key file exists, without reading it, are allowed.',
  'Claude 输入框左下角的用量圆环里多了一个「压缩会话」按钮（和官方 Claude Code 同款）：点开圆环，在「Context window」那一栏下面，左边写着离自动压缩还剩多少（比如「距自动压缩还有 420k」，快到了会显示「即将自动压缩」），右边一点就把当前对话的上下文压缩成摘要，腾出空间继续聊，不用再手打 /compact。Claude 正在回复时按钮是灰的，等这一轮结束就能点。':
    'The usage ring at the bottom-left of the Claude composer now has a “Compact session” button, just like official Claude Code: open the ring and, under “Context window”, the left side shows how much room is left before auto-compact (e.g. “420k until auto-compact”, or “Auto-compacts soon” when close), and one click on the right compacts the current conversation into a summary to free up space—no need to type /compact. The button is greyed out while Claude is replying and becomes available when the turn ends.',
  '电脑上工作台侧栏里的「工作空间」现在任何对话都能看全盘了：以前对话的项目文件夹不在主工作空间里时，侧栏只能看到这一个文件夹，左边的位置栏也没了；现在一律是完整版——左边照样有「位置」（主工作空间、各个盘），打开时直接落在这个对话的项目文件夹，「通用」里多了一行随时回到它。顶部地址栏改为显示完整路径（比如 E: › Vault › Claude › bridge build），点任意一级都能跳过去；点地址栏空白处（或按 Ctrl+L）能看到、复制完整路径，也能直接输入路径回车跳转。侧栏拖窄、位置栏收起时，地址栏左边会出现一个位置按钮，照样能换盘。':
    'The workspace in the desktop side panel now shows your whole PC in every conversation: before, if a conversation’s project folder lived outside the main workspace, the panel only showed that one folder and the Locations sidebar disappeared. Now it’s always the full version — Locations (main workspace and every drive) stays on the left, it opens straight to the conversation’s project folder, and Quick access has a shortcut back to it. The address bar now shows the full path (for example E: › Vault › Claude › bridge build); click any level to jump there, or click an empty spot in the address bar (or press Ctrl+L) to see or copy the full path, or type a path and press Enter. When the panel is too narrow for the Locations sidebar, a Locations button appears next to the address bar so you can still switch drives.',
  'Claude 上架 Haiku 5.5：模型菜单里 Haiku 换成了新一代 Haiku 5.5（Haiku 4.5 收进「更多模型」）。它又快又便宜，默认就有 1M 上下文，思考等级五档都能选，不选时按 Medium 跑。dimensio 的模型列表也加上了它。内置的 Claude Code 同时升到 2.1.293。':
    'Claude now offers Haiku 5.5: the Haiku slot in the model menu is the new Haiku 5.5 (Haiku 4.5 moves under “More models”). It is fast and cheap, has a 1M context window out of the box, supports all five effort levels and runs at Medium when you don’t pick one. dimensio’s model list has it too. The built-in Claude Code is updated to 2.1.293.',
  '修好网速慢时大文件上传传不完：通过慢的网络（比如隧道或开着代理）往工作空间传大文件，以前进度会走到 100% 后一直显示「网络不稳，重连中…」、反复重传，永远传不完（其实电脑早就收到了）。现在会耐心等电脑确认收到，网页和手机 App 的后台上传都修好了。':
    'Fixed big uploads never finishing on slow connections: uploading a large file to the workspace over a slow link (a tunnel, or with a proxy on) used to reach 100%, then show “Connection unstable, reconnecting…” and resend forever even though the computer already had the file. It now waits for the computer to confirm. Fixed for both the web page and background uploads in the phone app.',
  'dimensio 可以接自己的模型服务了：在「模型服务」面板最后多了一张虚线的「＋」空卡片，点开填三样——备注（卡片上显示的名字）、接口地址、API Key，任何兼容 OpenAI 的接口都行（中转站、OpenRouter、自己部署的 vLLM / Ollama……）。保存时会先连一下这个接口，自动取回它有哪些模型、顺便验证地址和 Key 对不对；接口列不出模型的，会让你手填一个模型 ID。加好的服务和官方几家一样平铺成卡片，图标是备注的第一个字，点一下就切过去用；卡片右下角的铅笔可以改名、换地址、换 Key 或删除（删除要点两下确认）。Key 加密存在你的电脑上，重启后还在，不会传回手机。另外修了面板底部那行说明文字紧贴卡片的问题。': 'dimensio can now connect to your own model provider. At the end of the Providers panel there’s a new dashed “＋” card. Open it and fill in three things: a note (the name shown on the card), the base URL, and the API key. Any OpenAI-compatible API works (relay services, OpenRouter, your own vLLM / Ollama…). When you save, dimensio connects to the API first to fetch its models and check that the URL and key are correct. If the API can’t list its models, you’ll be asked to enter a model ID. Added providers appear as cards alongside the official ones, with the first character of the note as the icon. Tap one to switch to it. The pencil in the card’s bottom-right corner lets you rename it, change the URL or key, or delete it (tap twice to confirm). The key is stored encrypted on your computer, survives restarts, and is never sent back to your phone. Also fixed the description line at the bottom of the panel sitting too close to the cards.',
  // —— 更新说明（设置 → 关于与更新，经 tr() 显示；每次发版把新 notes 的英文补在这里）——
  '设置 → 通用 → 思考动画 多了第三个选项「新版聊天页」：用 claude.ai 聊天页的同款动画——还没出字时是一颗会变形的 Claude 星形，开始干活后星形散开成几颗连线的节点，等你回答问题时变成一个方块、隔几秒轻轻抖一下。原来的「新版 Claude Code」（默认）和「经典星标」都还在，随时可以换。': 'Settings → General → Thinking animation has a third option, Chat (new), which uses the same animation as claude.ai chat: a shape-shifting Claude spark until the first words arrive, then the spark breaks into a few connected nodes while Claude works, and a square that gives a little shake every few seconds while it waits for your answer. Claude Code (new, the default) and Classic spark are still there, and you can switch at any time.',
  'dimensio 变得更省、更快：日常提问不再在答完之后多跑一轮「记忆审计」，回答完就结束；值得长期记住的东西（你说的偏好、踩过的坑）改由后台在每轮结束后整理，不占你的等待时间，用量面板里会多一行「记忆沉淀」。每次请求固定带上的系统说明也精简了一半多：网页、桌面应用、安卓的验证步骤和本地服务的安全规矩改成做到那一步时才给，长任务里的待办提醒不再一份份堆进对话。同样的任务实测少用约两成 token，简单问答约少一半。': 'dimensio is leaner and faster. Everyday questions no longer end with an extra “memory audit” turn — once it has answered, it’s done. Anything worth remembering long-term (preferences you state, pitfalls it runs into) is now filed in the background after each turn, so you don’t wait for it; the usage panel shows it as a “Memory filing” row. The instructions sent with every request are now less than half their former size: the verification steps for web, desktop and Android apps and the safety rules for local servers arrive only when the work gets there, and to-do reminders in long tasks no longer pile up in the conversation. In our tests the same tasks used about 20% fewer tokens, and simple questions about half.',
  'Claude 回复时对话底部那颗标记换成了新版 Claude Code 桌面端的同款动画：它会跟着 Claude 正在做的事变化——思考时几颗圆点绕圈，搜索、读文件、跑命令、写文件各有一套动作，写文档时是一支羽毛笔，等你回答问题时变成带圈的琥珀色圆点；切换时会等动作告一段落再衔接，不会生硬跳变。喜欢原来的星标可以在 设置 → 通用 → 思考动画 里换回「经典星标」（电脑客户端在 设置 → 通用 → 行为）。': 'The mark at the bottom of the chat while Claude is replying now uses the same animation as the new Claude Code desktop app. It follows what Claude is doing: dots circling while it thinks, a different motion for searching, reading files, running commands and writing files, a quill when it writes a document, and an amber dot with a ring when it’s waiting for your answer. It waits for a natural break before switching, so changes never jump. If you prefer the original spark, switch back to Classic spark in Settings → General → Thinking animation (in the desktop app: Settings → General → Behavior).',
  '设置里去掉了「液态玻璃」那一页（画质预设和光感、折射、色散三个滑块）：主页、Dock 和各处按钮现在用的都是新版玻璃，这些选项早就调不动它了。电脑客户端设置里的「个性化」也一起去掉，深色主题的流体壁纸参数挪进了「壁纸」。另外，Claude 工作台里打开「文件」时，顶上的返回、添加、传输三个圆钮不再紧贴着上方的「审阅 / 终端 / 浏览器 / 文件」那一栏，中间留出了一点空隙，看起来不那么挤。': 'Removed the Liquid Glass page from Settings (the quality presets and the Glow, Refraction and Dispersion sliders): Home, the Dock and buttons throughout the app now all use the new glass, which those options no longer affected. The Personalization section in the desktop app’s settings is gone too; the fluid wallpaper settings for the dark theme moved to Wallpaper. Also, when you open Files in the Claude workbench, the Back, Add and Transfers buttons at the top no longer sit flush against the Review / Terminal / Browser / Files bar above them; there’s now a little space in between, so it feels less cramped.',
  '设置里去掉了「液态玻璃」那一页（画质预设和光感、折射、色散三个滑块）。主页、Dock 和各处按钮现在用的都是新版玻璃，这些选项早就调不动它了，留着只会让人以为调了没反应。电脑客户端设置里的「个性化」也一起去掉，深色主题的流体壁纸参数挪进了「壁纸」。全局助手也不再接「切到性能模式 / 原画」这类指令。': 'Removed the Liquid Glass page from Settings (the quality presets and the Glow, Refraction and Dispersion sliders). Home, the Dock and buttons throughout the app now all use the new glass, which those options no longer affected, so keeping them only made it look like your changes did nothing. The Personalization section in the desktop app’s settings is gone too; the fluid wallpaper settings for the dark theme moved to Wallpaper. The global assistant also no longer takes commands like “switch to performance mode / original quality”.',
  '修好工作空间上传：以前进度条会一直停在 0%（其实在传），传完或出错后那一行直接消失、也不报错。现在上传全面重做：「传输」面板里每个文件实时显示已传大小 / 总大小和速度，失败了会留在面板里写明原因，点「重试」从断开的地方接着传。手机 App 上选的文件改由 App 自己在后台传，退到后台、锁屏也不会中断，通知栏有进度条；大文件分成几块同时传，网络卡住会自动重连，断网会等网络回来再继续，在家开始传的出门后会自动换线路。下载到手机也提速了：大文件分 4 段同时下，面板和通知栏同样显示已下大小 / 总大小和速度，锁屏照样下完。':
    'Fixed workspace uploads: the progress bar used to stay stuck at 0% (even though the file was uploading), and the row vanished without an error when the upload finished or failed. Uploads have been rebuilt: the Transfers panel now shows the uploaded size, the total size and the speed for each file in real time. A failed upload stays in the panel with the reason, and Retry continues from where it stopped. Files you pick in the phone app are now uploaded by the app itself, so they keep going in the background and with the screen locked, with a progress bar in the notification. Large files are sent in several parts at once. A stalled connection reconnects automatically, the upload waits for the network to come back after a drop, and an upload started at home switches connections when you leave. Downloads to your phone are faster too: large files download in 4 parts at once, the panel and notification show the downloaded size, the total size and the speed, and downloads continue with the screen locked.',
  'Nano Banana 2.1 现在能出 2K 和 4K 了：Google 的 Vertex 接口目前只给它出 1K，所以选 2K / 4K 时改由 Gemini API 生成（扣 Gemini API 的预付费额度，图片是 JPEG；这两档暂不支持人物生成设置），1K 照旧。Gemini 对话的输入框「＋」旁边多了一个「工具」按钮：联网搜索、读取网址、代码执行、识图清晰度和系统提示词都在这里，开了几项按钮上就显示几；模型菜单恢复成只选模型和思考等级。':
    'Nano Banana 2.1 can now make 2K and 4K images. Google’s Vertex API currently gives it 1K only, so 2K and 4K are made through the Gemini API instead (this uses your prepaid Gemini API credit, returns JPEG, and doesn’t support the people setting for now). 1K works as before. In Gemini chat, a new Tools button next to + in the input box holds Search, URL context, Code execution, Media resolution and System instructions, and shows how many are on. The model menu goes back to just the model and thinking level.',
  'Vertex 的图片、视频、语音、音乐四个模块换成同一套操作：结果和历史在上面，输入框固定在底部，常用参数变成输入框上方的一排小标签，点一下打开设置（电脑上设置仍在右栏）。视频不用再先选「任务类型」：点「＋」加首帧、尾帧或参考图，模式会自动切换，缺什么会在输入框下面提示；语音的朗读文本在底部输入，音色单独一个面板挑；音乐的负面提示收进设置，灵感词放在空白页。Gemini 对话的模型菜单新增四项：系统提示词、读取网址（打开你消息里的链接来读）、代码执行（写代码算数、画图表，图表直接显示在回答里）、识图清晰度（低 / 中 / 高）。':
    'Vertex’s Image, Video, Voice and Music modules now work the same way: results and history at the top, the input box pinned to the bottom, and the main settings as a row of chips above it. Tap a chip to open the settings (on desktop they stay in the right panel). Video no longer asks for a “task type” first. Tap + to add a first frame, last frame or reference images and the mode switches on its own, with a hint under the input if anything is missing. Voice takes its text in the bottom input and picks voices in their own panel. Music moves the negative prompt into settings and shows inspiration ideas on the empty page. The Gemini chat model menu adds four options: System instructions, URL context (reads links in your message), Code execution (writes and runs code to calculate or draw charts, shown right in the answer) and Media resolution (low / medium / high).',
  'Vertex 图像生成上架 Nano Banana 2.1（Google 10 月 6 日刚发布的新款）：在图像页的模型列表里选它，支持思考、联网搜索和图片搜索，还独有 4:1、1:4、8:1、1:8 四种超宽 / 超长比例，适合做横幅和长条图。注意目前 Google 那边它只出 1K 图，所以分辨率只给 1K；要 2K / 4K 请继续用 Nano Banana Pro 或 Flash。':
    'Vertex image generation now has Nano Banana 2.1, the new model Google released on October 6. Pick it in the model list on the Image page. It supports thinking, web search and image search, and it’s the only model with the ultra-wide and ultra-tall ratios 4:1, 1:4, 8:1 and 1:8, good for banners and long strips. Note that Google currently returns only 1K images from it, so 1K is the only resolution offered. For 2K or 4K, keep using Nano Banana Pro or Flash.',
  'dimensio「本机」的 Strata 能识图了：装好了官方版的识图模块，在底栏「本机」面板打开「视觉（识图）」就能给它发图片，实测图形、颜色和图中文字都认得准，开着识图出字也不变慢。另外 Strata 的上下文去掉了 32k 这一档——dimensio 自带的提示词加上给回答留的长度就超过 32k，选了第一句就会报错；以前存成 32k 的会自动按 128k 启动。':
    'Strata under dimensio’s Local can now read images. The official vision add-on is installed: turn on “Vision” in the Local panel in the bottom bar and you can send it pictures. In testing it got shapes, colors and the text in the image right, and output speed stays the same with vision on. Strata’s 32k context option is gone too: dimensio’s built-in prompt plus the room reserved for the answer already exceeds 32k, so the first message would fail. Settings saved as 32k now start at 128k.',
  'dimensio「本机」的第二台引擎 Strata 换成了官方的 Qwen3.8 Flash Next（IQ3_S）：同一套难题实测正确率和 Qwen 27B 持平，读长文快约 3 倍，最高思考档也能正常给出答案（之前的版本会一直想下去停不下来）。Qwen 27B 那台换了新版推理程序，出字快了约 5–8%。另外修正了「本机」面板里两句过时的提示。':
    'Strata, the second engine under dimensio’s Local, now runs the official Qwen3.8 Flash Next (IQ3_S). On the same set of hard questions it scores the same as Qwen 27B, reads long texts about 3× faster, and gives answers at the highest thinking level too (the previous version kept thinking without stopping). The Qwen 27B engine got a newer inference build and writes about 5–8% faster. Two outdated hints in the Local panel are fixed too.',
  'dimensio 的「本机」多了第二台引擎：除了 Qwen 27B，现在还能在自己电脑上跑 Qwen3.8 Flash Next 125B（Strata 引擎，无审查版）。在模型列表里选「Qwen3.8 Flash Next 125B」就能用；底栏「本机」面板顶上可以在两台之间切换，各自启停，各自调上下文、缓存精度、KV 流式和识图。两台共用一张显卡，启动一台会先停掉另一台。模型文件还没下全时，面板会列出缺哪些文件。':
    'dimensio’s Local now has a second engine. Besides Qwen 27B, you can run Qwen3.8 Flash Next 125B (Strata engine, uncensored) on your own computer. Pick “Qwen3.8 Flash Next 125B” in the model list. At the top of the Local panel in the bottom bar, switch between the two engines to start or stop each one and set its own context, cache precision, KV streaming and vision. Both share one graphics card, so starting one stops the other first. If the model files aren’t all downloaded yet, the panel lists what’s missing.',
  '手机上「下载到本地」不再跳到浏览器了：App 自己把文件下到手机的「下载」文件夹，进度在工作空间右上角的「传输」里看——每个文件显示速度和百分比，可以随时取消，下完点「打开」直接用别的 App 打开，失败了点「重试」。退到后台或锁屏也会接着下（通知栏有进度条，下完有提醒）；网络断了会自动重连、从断开的地方接着下，在家开始下的大文件出门后会自动换线路继续。文件预览里的下载按钮、助手「存到手机」也一样。':
    'Download on your phone no longer sends you to the browser. The app now saves files straight to your phone’s Downloads folder, and you can follow along in Transfers at the top right of your workspace: each file shows its speed and progress, you can cancel at any time, tap Open when it’s done to open it in another app, or tap Retry if it fails. Downloads keep going in the background or with the screen locked, with a progress bar in your notifications and an alert when they finish. If the connection drops, the download reconnects and picks up where it left off, and a large file you started at home switches connections automatically when you head out. The download button in file previews and the assistant’s save-to-phone work the same way.',
  '修复：在屏幕较窄的手机上，工作空间底部的搜索框点开输入时会超出屏幕右边，现在会完整显示在屏幕内；更窄的屏幕上底部的「工作空间 / 本地」标签也会相应收窄，不再挤到搜索按钮。':
    'Fixed: on phones with narrower screens, the search field at the bottom of your workspace could extend past the right edge of the screen while you typed. It now stays fully on screen, and on the narrowest screens the Workspace / Local tabs shrink so they no longer crowd the Search button.',
  '工作空间换上了和设置页同一套 iOS 27 外观：顶部的返回、添加、传输按钮是液态玻璃圆钮，内容滚上去时顶栏会柔和地模糊；底部的「工作空间 / 本地」标签栏和搜索按钮按 iOS 27 的标签栏重做，选中的标签垫着一枚浅色胶囊；长按文件弹出的菜单、右上角「＋」菜单、传输列表都换成了玻璃面板；重命名、新建文件夹是 iOS 风格的对话框；分享链接、发送给 AI、移动到、显示简介改成从底部升起的表单页，密码开关和过期时间也是系统样式的开关和分段选择；文件列表的字号、分隔线、多选勾选和位置切换按钮都对齐了 iOS 27。嵌在 Claude 等页面右侧时，这些外观会跟着页面的明暗一起变。':
    "Your workspace now has the same iOS 27 look as Settings. The Back, Add and Transfers buttons at the top are Liquid Glass buttons, and the top bar softly blurs content as you scroll. The Workspace / Local tab bar and the Search button at the bottom follow the iOS 27 tab bar, with a light capsule behind the selected tab. The long-press menu, the + menu and the transfers list are now glass panels; Rename and New Folder use iOS-style alerts; Share Link, Send to AI, Move To and Get Info open as sheets that rise from the bottom, with system-style switches and segmented controls for the password and expiry options. Font sizes, separators, selection checkmarks and location buttons in the file list now match iOS 27. When the workspace is shown beside Claude and other pages, it follows that page’s light or dark appearance.",
  '账户搬进了设置：打开设置，最上面多了一张账户卡片（头像、用户名、身份），点进去能看到用量和额度、进工作空间、扫码登录网页版、修改密码，最下面是「切换账号」和「退出登录」，点了会先确认。没登录时这一页就是登录页，可以用账号密码、邀请码注册或访问令牌登录；登录过的账号名会记在「最近登录」里，点一下就填好（只记名字，不存密码）。主页右上角的账户卡片和 Claude 侧边栏的菜单里不再放「退出登录」，改成一个「账户」入口直接跳到这一页。另外，点主页右上角胶囊展开账户卡片的动画在手机上更流畅了，不再掉帧。':
    'Your account now lives in Settings. Open Settings and you’ll find an account card at the top (avatar, username, and role). Tap it to see your usage and limits, open your workspace, scan to sign in on the web, or change your password; Switch Account and Sign Out are at the bottom and ask for confirmation first. When you’re signed out, this page is the sign-in page: use your username and password, register with an invite code, or sign in with an access token. Usernames you’ve signed in with appear under Recent Accounts so you can fill them in with one tap (only the name is saved, never the password). Sign Out is no longer in the home screen account card or the Claude sidebar menu; both now have an Account entry that takes you straight to this page. Also, tapping the capsule in the top-right corner of the home screen now opens the account card smoothly on phones, without dropped frames.',
  'Markdown 笔记里的图片可以调大小了（和 Obsidian 一样）：在图片名后面加「|宽度」就按这个宽度显示，比如 ![[截图.png|300]]，也可以写 ![[截图.png|300x200]] 同时定宽高，标准写法 ![说明|300](截图.png) 同样认；阅读和编辑模式都生效。编辑模式里更直接：鼠标移到图片上，右下角会出现一个小圆点，按住拖动就能缩放，松手后宽度自动写进笔记，Ctrl+Z 可以撤销；手机上光标停在图片那一行时圆点一直显示，用手指拖。另外，电脑客户端里把工作空间里已有的文件（从文件面板或资源管理器）拖进笔记，现在直接插入指向它的链接，不再复制一份到 attachments：图片显示成图，笔记插入成 [[笔记名]]；不在这个工作空间里的文件仍按原来的方式存一份副本。':
    'You can now resize images in Markdown notes, just like in Obsidian. Add “|width” after the image name to set its display width, for example ![[screenshot.png|300]], or use ![[screenshot.png|300x200]] to set both width and height; the standard form ![caption|300](screenshot.png) works too. This applies in both reading and edit mode. In edit mode it’s even easier: hover over an image and a small dot appears in its bottom-right corner. Drag it to resize, and when you let go the width is written into the note (Ctrl+Z undoes it). On your phone, the dot stays visible while the cursor is on the image’s line, so you can drag it with your finger. Also, in the desktop app, dragging a file that’s already in the workspace (from the Files panel or File Explorer) into a note now inserts a link to it instead of copying it into attachments: images show as images and notes are inserted as [[note name]]. Files from outside the workspace are still saved as a copy, as before.',
  'Markdown 笔记可以插图了（和 Obsidian 一样）：在编辑模式里直接粘贴截图，或者把图片、文件拖进正文，它会自动存进笔记所在文件夹下的 attachments 文件夹，并在光标处插入 ![[图片名]]，图片当场显示出来。也可以从菜单里选：电脑上右键 → 插入 → 图片或附件…；手机上光标停在正文里时，屏幕底部的小工具条多了一个图片按钮，点开从相册或文件里选（工具条上的「⋯」也能打开插入、段落设置等菜单）。截图自动命名为「Pasted image 日期时间.png」，其他文件保留原名，重名会自动加编号；保存期间光标处显示「正在保存…」，可以接着打字。图片、音视频和 PDF 嵌入显示，其他文件插入为链接。手机本地文件夹里的笔记：有 attachments 文件夹就放进去，没有就放在笔记旁边。':
    'You can now add images to Markdown notes, just like in Obsidian. In edit mode, paste a screenshot or drag images and files into the note: they’re saved to an attachments folder inside the note’s folder, and ![[image name]] is inserted at the cursor, with the image shown right away. You can also pick files from a menu: on desktop, right-click → Insert → Image or attachment…; on your phone, when the cursor is in the text, the small toolbar at the bottom of the screen now has an image button for choosing from your photos or files (its “⋯” button also opens the Insert and Paragraph menus). Screenshots are named “Pasted image <date and time>.png”, other files keep their names, and duplicates get a number added. While a file is saving, “Saving…” appears at the cursor and you can keep typing. Images, audio, video, and PDFs are embedded; other files are inserted as links. For notes in a folder on your phone, attachments go into its attachments folder if there is one, or next to the note otherwise.',
  '修 PDF 预览：在较窄的地方看 PDF（手机竖屏、折叠屏工作台、电脑上拖窄的右侧面板）时，页面不再被横向压扁、字变得又瘦又长，而是整页按比例缩小、完整显示；拖动面板宽窄时页面跟着重新排。放大后页面比屏幕宽，可以左右滑动查看，不会再被挤扁。':
    'Fixed PDF preview: in narrow spaces (a phone in portrait, the workbench on a foldable, or a narrowed side panel on desktop), pages are no longer squeezed sideways into tall, skinny text. The whole page now scales down proportionally and stays fully visible, and it re-fits when you resize the panel. When you zoom in past the screen width, you can scroll left and right instead of the page getting squashed.',
  'dimensio 派出去的子 agent 有自己的卡片了（结构和 Claude 分页一样）：① 对话里每个子 agent 是一张卡片——标题、用的模型、已经跑了多久，下面一行写着它此刻在做哪一步（比如「第 5 步 · 读取文件 src/auth/session.ts」）；一次并行派出好几个时合成一张叠卡，一个一行、各看各的进度；跑完卡片不消失，停在结果上（调了几次工具、用了多少 token，失败会写原因）。以前它们混在「执行了 N 步」那一行里，得点开才看得到。② 点卡片进右侧「任务」里的子 agent 面板，这一页重新做过：顶上是状态和四个读数（用时、tokens、工具调用、回合），往下依次是派给它的提示词（太长先折叠，可以复制）、一步步的过程、它改过的文件（可以直接跳去「审阅」）、最后的答复；右上角的箭头可以在同一批子 agent 之间上一个 / 下一个切换。③ 工作流的卡片跑完也留着，显示最终状态、每个 agent 的结果和用时。':
    'Subagents in dimensio now get their own cards, with the same structure as the Claude tab. ① In the conversation, each subagent is a card showing its title, model, and elapsed time, plus a line for the step it’s on right now (for example, “Step 5 · Read file src/auth/session.ts”). Several subagents launched in parallel share one stacked card, one row each, so you can follow each one’s progress. Cards stay after the run and settle on the outcome: tool calls and tokens used, or the reason it failed. Previously they were buried inside the “Ran N steps” line and you had to expand it to see them. ② Tapping a card opens the redesigned subagent panel under Tasks in the side panel: status and four readouts at the top (elapsed, tokens, tool calls, turns), then the prompt it was given (long prompts start collapsed, and you can copy it), its steps, the files it changed (with a shortcut to Review), and its final response. The arrows at the top right move between subagents in the same batch. ③ Workflow cards also stay after the run, showing the final status, each agent’s result, and the elapsed time.',
  'Claude 动态工作流的卡片更完整了：① 跑完的工作流也留一张卡片（以前跑完只剩一行灰字「Ran workflow …」，和「Ran 5 commands」混在一起认不出来）：卡片上写着完成 / 失败 / 已停止、用了几个 agent、花了多久，底下的小方格是每个 agent 的最终状态，没跑完的标红，失败时附一行原因；点开仍是右侧「任务」里的阶段和 agent 明细。② 再修一处卡片消失：工作流在后台跑时，手机切走一会儿再回来，对话里的卡片可能不见、右侧「任务」只剩一句描述——上一版漏掉的这种情况也修好了。另外，Claude 同时进行的对话不再限制最多 3 个。':
    'Claude’s dynamic workflow cards are more complete. ① Finished workflows now keep a card (previously they shrank to a gray “Ran workflow …” line that looked just like “Ran 5 commands”). The card shows Completed / Failed / Stopped, how many agents ran, and how long it took; the small squares show each agent’s final state, with unfinished ones in red, and a failed workflow adds a one-line reason. Tapping it still opens the phases and agent details in the Tasks panel. ② Fixed another case where the card vanished: if you switched away from the app while a workflow was running and came back later, the card could disappear from the conversation and the Tasks panel showed only a one-line description. The previous update missed this case. Also, Claude no longer limits you to 3 conversations running at the same time.',
  '修 Claude 动态工作流的显示：工作流在后台跑的时候，手机切到后台再回来（或网络断了重连）后，对话里那张工作流卡片会消失，右侧「任务」里对应的一栏也只剩一句描述、看不到阶段和各个子 agent 的进度。现在重连后卡片和进度都保留，任务面板照常显示阶段、agent 列表和实时进度。':
    'Fixes how Claude’s dynamic workflows are shown. While a workflow was running in the background, switching the phone away and back (or reconnecting after a network drop) made the workflow card disappear from the conversation, and its entry in the Tasks panel showed only a one-line description with no phases or subagent progress. The card and progress now survive reconnects, and the Tasks panel keeps showing phases, the agent list, and live progress.',
  'Claude 被安全机制拦下时，改成和官网一样「先暂停、由你决定」：以前一条消息被标记后，会自动换成别的模型（比如 Opus 4.8）接着回答；现在这一轮会停下来，输入框上方出现一张「Session paused」卡片，写明是哪个模型的安全机制标记了这条消息，给你两个选择——「Edit prompt and retry with 原模型」：撤回这条消息、把原文放回输入框，改一改再用原来的模型发；「Switch to Opus 4.8」（或其他备用模型）：换到备用模型把这条消息重新回答，之后这个对话就一直用它。点右上角的 × 则不换模型，按原样结束这一轮。等你选择时，对话列表里会亮「待回答」，换台设备也能接着选；10 分钟没选按 × 处理。':
    'When Claude’s safeguards flag a message, Claude now pauses and lets you decide, just like on claude.ai. Previously a flagged message was automatically answered by another model (such as Opus 4.8). Now the turn stops and a “Session paused” card appears above the message box, saying which model’s safeguards flagged the message, with two choices: “Edit prompt and retry with <original model>” takes the message back and puts its text in the message box so you can reword it and resend with the original model; “Switch to Opus 4.8” (or another fallback model) answers the message again with that model, and the conversation keeps using it. Tap × in the corner to keep the model and end the turn as is. While it is waiting for you, the conversation shows as awaiting your answer in the list, so you can also choose from another device; if nothing is chosen within 10 minutes it is treated as ×.',
  'Markdown 笔记两处改进：① 编辑时如果 Claude（或别的设备）同时改了这篇，不会再被你的自动保存整篇覆盖——两边改的不是同一处就自动合在一起；改到了同一处，顶部会出提示让你选「保留我的」还是「用最新版」（选了最新版也能撤销回来）。以前只要手上有没保存的字，别处的修改就会被下一次自动保存直接盖掉。② 查看器顶栏重新设计：去掉了绿色的「已保存」按钮，改成文件名下方一行小字——保存中、未保存（点一下立刻保存）、已保存，平时显示所在文件夹；阅读 / 编辑 / 源码切换改成胶囊样式，返回键改成圆形按钮；草稿和冲突提示改到顶栏下方的提示条里，不再浮在正文上。':
    'Two improvements to Markdown notes. ① If Claude (or another device) changes a note while you are editing it, your autosave no longer overwrites those changes: edits to different parts are merged automatically, and if both sides changed the same lines, a notice at the top lets you choose Keep mine or Use latest (Use latest can be undone). Previously, whenever you had unsaved edits, anything changed elsewhere was silently replaced by your next autosave. ② The viewer’s top bar has been redesigned: the green Saved button is gone, replaced by a small status line under the file name (saving, unsaved — tap to save now, saved, or the folder the note is in); the Read / Edit / Source switch is now a capsule, the back button is round, and draft and conflict notices sit in a bar under the top bar instead of floating over the text.',
  'Markdown 笔记的编辑体验大幅打磨，手感向 Obsidian 看齐：① 编辑模式里的列表和阅读模式长得一模一样——圆点不再歪、不再偏下，各级实心点 / 空心圈 / 小方块、有序序号（珊瑚色、右对齐）、待办框都和阅读模式在同一位置；一项写长了换行，第二行对齐正文而不是跑到圆点底下；嵌套几级就缩进几级，不管源码里用的是两个空格、四个空格还是 Tab。② 光标不会再停到圆点或引用竖线前面：按 Home 回到正文开头，点圆点也落到正文前，打字不会把列表打散。③ 回车更顺：空的一项回车一次就退出列表（嵌套时先退一级），在正文开头回车会在上面插一个新项，引用里空行回车一次就退出；Shift+回车换行后自动对齐正文；有序列表增删、移动后序号自动重排。④ Tab / Shift+Tab 缩进、取消缩进会带着子项一起走；手机上光标停在列表里时，屏幕底部会出现一条小工具条，可以缩进、取消缩进、切换待办。⑤ 选中文字后输入 * = ~ ` [ 等符号会把选中的内容包起来（连按两次得到粗体、高亮、双链），括号自动配对，中文输入法打「【【」自动变成 [[；Ctrl+K 插链接、Ctrl+L 切换待办、Ctrl+/ 注释、Ctrl+D 删行、Alt+回车打开光标处的链接。⑥ 输入 [[ 会弹出笔记名补全（[[# 列出本篇标题，# 列出用过的标签）。⑦ 修好了几处会改坏笔记的问题：在行内代码或标题旁用中文输入法打字会吞字、漏拼音字母；在圆点旁打字会吞掉「-」；双击粗体后面的标点再打字会删掉粗体里的字；文首是表格时打的字会丢。⑧ 观感：刚切到编辑模式不再先露一截源码；嵌套引用显示多根竖线；代码块底部不再多一行空白；标注（callout）编辑时保持原来的颜色；公式和独占一行的图片编辑时源码下面同时显示预览，点图片不会让图消失；行内的 <kbd> 等 HTML 标签在编辑模式也渲染出来；脚注两种模式都正常显示（阅读模式文末有脚注列表，可点击跳转）；阅读模式的代码块有了语法高亮，引用、表格、标题间距与编辑模式对齐，切换模式时首屏不再上下跳。⑨ 长笔记里打字、移动光标明显更快。':
    'Big upgrade to editing Markdown notes, now much closer to Obsidian. ① Lists in edit mode look exactly like reading mode: bullets are no longer lopsided or sitting too low; filled dots / hollow circles / small squares for each level, coral right-aligned numbers and task boxes all sit where they do in reading mode. When an item wraps, the second line lines up with the text instead of sliding under the bullet, and every nesting level indents by the same amount whether the source uses two spaces, four spaces or a tab. ② The cursor can no longer end up in front of a bullet or a quote bar: Home goes to the start of the text, tapping a bullet puts the cursor before the text, and typing no longer breaks the list. ③ Enter behaves better: Enter on an empty item leaves the list in one press (nested items step out one level first), Enter at the start of an item inserts a new item above it, one Enter on an empty quote line leaves the quote, Shift+Enter starts a new line aligned with the text, and numbered lists renumber themselves after you add, remove or move items. ④ Tab / Shift+Tab indent and outdent an item together with its sub-items; on phones, a small toolbar appears at the bottom when the cursor is in a list, with indent, outdent and toggle-task buttons. ⑤ Typing * = ~ ` [ with text selected wraps the selection (press twice for bold, highlight or a [[link]]), brackets are auto-paired, and typing 【【 with a Chinese IME turns into [[. New shortcuts: Ctrl+K insert link, Ctrl+L toggle task, Ctrl+/ comment, Ctrl+D delete line, Alt+Enter open the link under the cursor. ⑥ Typing [[ now suggests note names ([[# lists this note’s headings, # lists tags you have used). ⑦ Fixed several ways a note could get damaged: typing with a Chinese IME next to inline code or a heading could swallow characters or leave stray pinyin letters; typing next to a bullet could eat the "-"; double-clicking punctuation right after bold text and typing deleted the bold text; typing in a note that starts with a table could lose the text. ⑧ Looks: switching to edit mode no longer flashes raw source for the first block; nested quotes show one bar per level; code blocks no longer have an empty line at the bottom; callouts keep their colour while you edit them; formulas and standalone images show a live preview under the source while you edit, and tapping an image no longer makes it disappear; inline HTML such as <kbd> is rendered in edit mode too; footnotes display correctly in both modes (reading mode lists them at the end with clickable links); code blocks in reading mode are syntax-highlighted, and quotes, tables and heading spacing now match edit mode, so the page no longer jumps when you switch modes. ⑨ Typing and moving the cursor in long notes is noticeably faster.',
  '设置页按 iOS 27 官方界面重做：结构和 iPhone 的「设置」App 一样——首页是带彩色图标的分组列表，点进去是各自的子页（通用、外观、壁纸、液态玻璃、全局助手、手机操控……），每页顶上是大标题，往上滚会收成顶栏中间的小标题；从屏幕左边缘往右划返回上一页，在首页右划回主页。尺寸、字号、颜色和开关、滑块、分段按钮都取自 Apple 官方的 iOS 27 设计资源，明暗两套配色跟着界面主题走；返回钮、弹窗、反馈面板和菜单是官方同款液态玻璃，按住开关或拖动滑块时旋钮会变成一颗玻璃透镜。原来的功能都还在：拖液态玻璃的滑块时设置页会暂时退开、直接在主页上看效果；壁纸页点预览进入实景。':
    'Settings has been redesigned to match iOS 27. It’s now laid out like the Settings app on iPhone: the first page is a grouped list with colored icons, and each item opens its own page (General, Appearance, Wallpaper, Liquid Glass, Assistant, Phone control, and more). Every page has a large title that shrinks into the toolbar as you scroll; swipe from the left edge to go back, or back to Home from the first page. Sizes, fonts, colors, switches, sliders and segmented controls come from Apple’s official iOS 27 design resources, with light and dark versions that follow the app’s appearance. The back button, alerts, the feedback sheet and menus use the official Liquid Glass, and switch and slider knobs turn into a glass lens while you touch them. Everything else works as before: dragging a Liquid Glass slider still steps Settings aside so you can see the effect on Home, and tapping a wallpaper preview opens the live preview.',
  '手机上选中 Markdown 笔记的长段文字时，把选择柄往屏幕底部（或顶部）拖，页面会自动往下（往上）滚，选区跟着一路延长，不用再松手去翻页。越往边上拉滚得越快、稍微退回来就放慢，松手或手指挪开边缘就停。阅读、编辑、源码三种模式都支持；编辑时键盘弹起，拉到键盘上方就开始滚。': 'When selecting long passages in a Markdown note on a phone, drag a selection handle toward the bottom (or top) of the screen and the page now scrolls on its own, extending the selection as it goes, so you no longer have to let go and scroll. The closer you pull to the edge, the faster it scrolls; ease back and it slows down; let go or move away from the edge and it stops. Works in reading, edit and source modes; while editing with the keyboard up, it starts scrolling just above the keyboard.',
  '手机上 Claude 工作台里看文件更宽敞了：打开 HTML、Markdown、PDF、Office 等文件预览时，工作台自动升到屏幕顶端、上方的工具切换条先收起来，文件标题栏也压矮了一截，正文能多显示大约四分之一；点左上角返回退出预览，工具条就回来。另外去掉了工作台里文件列表和预览顶上那条多余的空白带（以前在工作台里又把手机状态栏的高度空了一遍）。':
    'Viewing files in the Claude workspace panel on phones now gets much more room: when you open a preview (HTML, Markdown, PDF, Office and more), the panel rises to the top of the screen, the tool switcher above it tucks away, and the file’s title bar is slimmer, so about a quarter more of the content fits on screen. Tap back in the top-left to leave the preview and the tool switcher returns. Also removed the empty band at the top of the file list and previews inside the panel (it used to leave room for the phone’s status bar a second time).',
  '主页的玻璃统一了：安卓手机和电脑浏览器上的主页，四个入口方块和右上角的账户胶囊也换成了 iPhone 上那一版液态玻璃（和电脑客户端主页底栏同一种，取自 Figma 官方 iOS 27 组件库、用它自己的渲染程序画出来）：边缘有立体高光，透出来的风景带着折射和柔和的模糊，按下去玻璃跟着一起缩。深色主题的「流光」壁纸上也是这块玻璃，玻璃里透出的线条跟着壁纸一起流动。手机或浏览器不支持 WebGPU 时，仍是原来的玻璃效果。':
    'The home screen glass is now the same everywhere: on Android phones and in desktop browsers, the four entry tiles and the account pill in the top-right now use the same liquid glass as on iPhone (the same kind as the dock on the desktop app’s home screen, taken from Figma’s official iOS 27 kit and drawn with Figma’s own renderer): a dimensional highlight around the edge, with the scenery showing through refracted and softly blurred, and the glass shrinks with your press. The dark theme’s animated “Flow” wallpaper gets the same glass too, and the lines seen through it move with the wallpaper. On phones or browsers without WebGPU, the glass stays as before.',
  'dimensio 的对话里，干活的过程默认收起来了（和 Claude 分页一样）：连着调用的好几步工具合成一行——正在跑时写着此刻在做什么（比如「执行命令 npm test」），做完变成一句「读取了 3 个文件，编辑了 1 个文件，执行了 2 条命令」，有失败的那部分标红；点一下这一行才展开每一步，每一步还能再点开看参数和输出。单独的一步也只留一行，不再多挂一行结果。想要原来那样每一步都平铺开，到 dimensio 的设置 → 对话，打开「显示全部工作过程」（默认关）。':
    'In dimensio chats, the work steps are now collapsed by default (like the Claude page): several tool calls in a row become one line. While they run, it shows what’s happening right now (for example “Run command npm test”); when they finish, it becomes a summary such as “Read 3 files, edited 1 file, ran 2 commands”, with any failed part in red. Click the line to see each step, and click a step to see its arguments and output. A single step also takes just one line now, without an extra result line. To lay out every step in full as before, go to dimensio Settings → Chat and turn on “Show all work steps” (off by default).',
  '接着修手机上选中 Markdown 长段文字：在 Claude 工作台里看笔记时，把选中的开头滚到上方工具栏底下、再拖选择柄往下选，选区不会再一下子被取消（以前经常拖一下就只剩一个光标、选择柄也没了）；选区很长、开头早已滚出屏幕时也能一路接着拖。': 'More fixes for selecting long passages in Markdown notes on phones: when reading a note in the Claude workspace panel, scrolling the start of your selection up under the toolbar and then dragging the handle no longer cancels the selection (it used to collapse to a single cursor and lose its handles), and very long selections whose start is far off screen keep extending as you drag.',
  'Claude 回答时，底部那颗星标旁边除了用时和 token 数，现在还会写出它此刻在干什么（和 Claude 官方桌面版一样）：刚发出去是「发送中…」，等模型开口是「等待 Claude…」，在想是「思考中…」（想得久了会变成「仍在思考…」「深入思考中…」），想完短暂显示「已思考 N 秒」，调工具时是「运行工具中…」；上下文压缩时显示「压缩会话中…」，遇到限流或服务过载自动重试时显示「重试中（第几次 / 共几次）」，等你回答它的提问时显示「等待你的回答…」。以前模型接口临时重试会让整行变成「重连中…」，现在不会了。':
    'While Claude is answering, the line next to the star at the bottom now says what it’s doing, besides the elapsed time and token count (like the official Claude desktop app): “Sending…” right after you send, “Waiting for Claude…” until the model starts, “Thinking…” while it thinks (becoming “Still thinking…” and “Thinking more…” on long thoughts), a brief “Thought for Ns” afterwards, and “Running tools…” while tools run. It also shows “Compacting session…” during context compaction, “Retrying (n/m)” when it retries after a rate limit or an overloaded server, and “Waiting for your answer…” when it has asked you a question. A temporary API retry no longer turns the whole line into “Reconnecting…”.',
  '手机上选中 Markdown 笔记里的长段文字顺了：阅读模式下拖选择柄，选区不会再突然跳到文章开头、溢出到旁边的聊天里，也不会拖着拖着突然没了；「全选」只选中这篇笔记。编辑和源码模式下，长按终于能正常选中文字、出现选择柄和系统的「复制 / 粘贴」菜单（以前会弹出编辑器自己的菜单、还弹键盘，根本选不上）；加粗、斜体等格式按钮挪到键盘上方，不再和系统菜单叠在一起；拖选时文字不会再忽然冒出 ** 之类的标记而跳动，长长的一段也能一路往下拖，复制拿到的是完整内容。电脑上用鼠标选择的方式不变。': 'Selecting long passages in Markdown notes on phones works properly now. In reading mode, dragging the selection handles no longer makes the selection jump to the top of the note, spill into the chat beside it, or suddenly disappear, and Select all selects just the note. In edit and source modes, touch and hold now selects text with the system handles and the Copy / Paste menu (it used to open the editor’s own menu and the keyboard, so you couldn’t select anything). The bold, italic and other formatting buttons now sit above the keyboard instead of overlapping the system menu. Text no longer jumps around while you drag because markup like ** stays hidden, long passages can be dragged all the way through, and Copy gets the full text. Mouse selection on computers is unchanged.',
  'Claude 输入框「＋」菜单多了一项「Add photos」：点它直接打开手机系统的照片选择器，相册照片按时间排好、可以一次多选，不用再进文件管理器一层层翻文件夹（电脑上是只显示图片的选文件窗口）。原来那项改叫「Add files」，修了它在手机上每次都打开到工作空间常驻文件夹的问题：现在会停在你上一次选文件的那个文件夹，第一次用从「下载」开始。':
    'The “＋” menu in the Claude composer has a new “Add photos” item. On your phone it opens the system photo picker, with your photos sorted by date and multi-select, so you no longer have to dig through folders in the file manager (on a computer it opens a file dialog that shows only images). The old item is now called “Add files”, and it no longer always opens in your workspace’s default folder on the phone: it now opens in the folder you last picked a file from, starting from Downloads the first time.',
  'Claude 跑动态工作流时，右侧「任务」里每个子 agent 现在一开跑就能点开看：顶部是它收到的完整提示词（去掉了工作流系统自动加的那段说明，显示字数，太长会先折叠，点「展开完整提示词」看全文，右上角一键复制），下面是它一步步在做什么——调了哪些工具、写了什么，跑着的时候每两秒自动接上新内容，并显示它此刻正在调的工具；还在排队的 agent 先显示前 400 字预览，一启动就自动换成全文。只有打开这个页面时才会同步，关掉就停，不额外耗流量。跑完之后点开仍是同一个页面、看完整记录。另修两处：以前点开子 agent 后状态、token 数、结果不会跟着更新；子 agent 很长的回答超过 4000 字会被截断，现在完整显示。':
    'When Claude runs a dynamic workflow, you can now open any sub-agent in the Tasks panel as soon as it starts. At the top is the full prompt it received (without the note the workflow system adds automatically), with a character count; long prompts start folded, tap “Show full prompt” to read it all, and copy it with the button in the corner. Below that you see what the agent is doing step by step: the tools it calls and what it writes. While it runs, new activity appears every two seconds and the tool it is using right now is shown. Queued agents show a 400-character preview first, which switches to the full prompt once they start. It only syncs while this view is open and stops when you close it. After the agent finishes, the same view shows the complete record. Also fixed: a sub-agent’s status, token count and result didn’t update after you opened it, and very long sub-agent replies were cut off at 4,000 characters; they now show in full.',
  'Claude 分页可以「引用」别的对话了：把侧栏里的一个对话拖进正在聊的对话，它就作为一张对话卡片挂进输入框（写着标题和有几条消息），发出去后 Claude 会先读完那段对话的完整记录、再结合你这条消息回答——适合「接着上次那个话题继续」「对照另一个对话里的方案」。电脑上按住对话拖到输入框上松手，或者拖到侧栏另一个对话上（会切过去再引用）；分屏时拖到哪一格的输入框就引用进哪一格。手机上长按对话拿起，往右拖出侧栏它会自动收起，松在聊天区就行；长按后原地松手仍是原来的「更多」菜单。消息里的对话卡片点一下能打开被引用的那段对话。原来拖到正文左右两边分屏、拖出窗口的用法不变。': 'Claude can now quote other chats. Drag a chat from the sidebar into the one you’re in and it’s added to the message box as a chat card (with its title and message count). When you send, Claude first reads that chat’s full history, then answers with it in mind—handy for picking up where an earlier chat left off or comparing against a plan from another chat. On a computer, drag the chat onto the message box, or onto another chat in the sidebar (it switches to that chat and quotes there); in split view, drop it on the message box of the side you want. On a phone, touch and hold a chat to pick it up, drag it out of the sidebar (the sidebar closes on its own), and drop it on the conversation; touching and holding without moving still opens the More menu. Tap a chat card in a message to open the quoted chat. Dragging to the left or right half for split view, and dragging out to a new window, work as before.',
  'Claude 输入框上方的归属芯片多了一个「worktree」勾选框（和 Claude 官方桌面 App 一样）：在项目里开新对话时，把分支名右边那个小方框勾上再发第一条消息，Claude 会先从当前分支复制出一份独立的工作副本（git worktree，放在项目的 .claude/worktrees 下，新建一个 claude/ 开头的分支），整段对话都在这份副本里改代码，原来的项目文件一个字节都不动——适合同一个项目同时开几个对话各改各的、互不打架。勾选会被记住，下次开新对话还是勾着；对话开始后芯片上显示这个对话用的分支，右侧审阅、文件、终端也都自动指向这份副本。只有 git 仓库项目才会出现这个勾选框。':
    "The workspace chips above the Claude composer now have a \"worktree\" checkbox, like the official Claude desktop app. When starting a new conversation in a project, tick the small box next to the branch name before sending your first message: Claude first makes an isolated copy of the repo from the current branch (a git worktree under the project's .claude/worktrees, on a new claude/… branch) and does all its work there, leaving your original files untouched — handy for running several conversations on the same project without them stepping on each other. The checkbox is remembered for new conversations; once a conversation starts, the chips show its branch and the Review, Files and Terminal panels point at the worktree. The checkbox only appears for projects that are git repositories.",
  'Claude 的输入框换成 claude.ai 官网同款：卡片圆角和官网一致、四周一圈很淡的细边；点进去打字时细边加深、底下的阴影也略微加重，一眼能看出输入框正处在编辑状态（电脑上鼠标移上去细边也会加深）。另外点输入框里的空白处（比如按钮之间的空档）也能直接开始打字。亮色、暗色主题都一样。':
    'The Claude input box now matches claude.ai: the same card shape with a faint hairline border. When you click in to type, the border darkens and the shadow underneath deepens slightly, so it is obvious the box is in editing mode (on a computer the border also darkens on hover). You can also click any empty spot inside the box, such as the gap between the buttons, to start typing. Works the same in light and dark themes.',
  '电脑上 Claude 页右上角那组按钮（终端 / 审阅 / 浏览器 / 更多），以及侧栏收起时左上角的菜单钮，不再用液态玻璃，改成和页面同色的扁平底加一道细边，更清爽。手机、折叠屏和平板上仍是原来的液态玻璃，没有变化。': 'On computers, the button group at the top right of the Claude page (terminal / review / browser / more), and the menu button at the top left when the sidebar is collapsed, no longer use liquid glass: they are now a flat, page-colored surface with a thin outline. Phones, foldables and tablets keep the liquid glass, unchanged.',
  'iPhone / iPad 上的主页换了玻璃：四个入口方块和右上角的账户胶囊，改用和电脑客户端主页底栏同一种液态玻璃（取自 Figma 官方 iOS 27 组件库、用它自己的渲染程序画出来），边缘有立体高光，透出来的风景带着折射和柔和的模糊，按下去玻璃跟着一起缩。需要 iOS 26 及以上；更早的系统仍是原来的折射效果，并修好了它有时整屏发黑的问题。用 iPhone 上的 Chrome、Edge 打开时，入口方块的玻璃以前会整个消失，现在和 Safari 一样。iPhone / iPad 上不再提供动态的「流光」壁纸：暗色主页需要先在设置 · 壁纸里上传一张图片，没选时点左上角 THE BRIDGE 会提示。安卓和电脑上的主页不变。': 'The home screen on iPhone and iPad has new glass: the four app tiles and the account pill in the top-right now use the same liquid glass as the home-screen dock in the desktop app (taken from Figma\'s official iOS 27 component library and drawn with Figma\'s own renderer). The edges have a raised highlight, and the scenery behind shows through with refraction and a soft blur; the glass shrinks with the tile when you press it. Requires iOS 26 or later; older versions keep the previous refraction effect, which no longer occasionally turns the whole screen black. Opened in Chrome or Edge on iPhone, the tiles used to lose their glass entirely; they now look the same as in Safari. The animated “Flux” wallpaper is no longer offered on iPhone and iPad: to use the dark home screen, upload an image in Settings · Wallpaper first; tapping THE BRIDGE in the top-left will remind you if none is picked. The home screen on Android and desktop is unchanged.',
  '界面新增英文版：设置 → 通用 → 语言 里选 English，整个 App 就切成英文（切换后自动重新加载一次；默认仍是简体中文，不选就和以前完全一样）。覆盖所有页面——主页、Claude、ChatGPT / Codex、dimensio、Vertex、Antigravity、工作空间与文件预览、Markdown 编辑器、设置、扩展中心、例程、服务端控制台，以及手机通知、悬浮胶囊和电脑客户端的托盘菜单。译法对照各家官方原文：Claude 页用 Anthropic 的说法，ChatGPT 页用 OpenAI 的说法，文件管理用 Windows 资源管理器和 iOS「文件」的说法，编辑器用 Obsidian 的说法；服务器返回的报错与状态也会显示成英文。别人打开你分享的链接时，如果对方浏览器不是中文，分享页会自动显示英文。':
    'The app is now available in English. Go to Settings → General → Language and choose English, and the whole app switches over (it reloads once to apply the change; Simplified Chinese is still the default, so nothing changes unless you pick English). This covers every page—Home, Claude, ChatGPT / Codex, dimensio, Vertex, Antigravity, the workspace and file previews, the Markdown editor, Settings, Extensions, Routines, and the server admin console—plus phone notifications, the floating capsule, and the desktop app’s tray menu. Wording follows each product’s official English: Anthropic’s on the Claude page, OpenAI’s on the ChatGPT page, Windows File Explorer and iOS Files for file management, and Obsidian for the editor. Error and status messages from the server appear in English too. When someone opens a link you’ve shared and their browser isn’t set to Chinese, the share page appears in English automatically.',

  // —— 功能扩展（routes/modules.mjs、modules/manage.mjs、modules/registry.mjs、runtime/agent-status.mjs）——
  '与当前主程序版本不匹配（需要同一次打包的离线包）': 'Doesn’t match the current program build (needs the offline package from the same build)',
  '未安装「{name}」扩展': 'The “{name}” module isn’t installed',
  '离线包解不开（要 .zip）：{reason}': 'Couldn’t open the offline package (needs a .zip): {reason}',
  '这不是功能扩展的离线包（里面没有 bridge-module.json）': 'This isn’t a module offline package (no bridge-module.json inside)',
  '不认识的功能扩展：{id}': 'Unknown module: {id}',
  '离线包缺入口文件': 'The offline package is missing its entry file',
  '这个离线包和当前主程序不是同一次打包的（离线包 {a}，主程序 {b}），请用随这一版安装包一起发的离线包': 'This offline package is from a different build than the program (package {a}, program {b}). Use the offline packages shipped with this installer.',
  '「{name}」是主程序内置的，随主程序一起更新，不用另装': '“{name}” is built into the program and updates with it — no separate install needed',
  '「{name}」是主程序内置的，不能卸载（可以在「Agent」里关掉）': '“{name}” is built into the program and can’t be uninstalled (you can turn it off under Agents)',
  '这个功能扩展没装': 'This module isn’t installed',
  '离线包超出大小上限': 'The offline package is too large',
  '没收到文件': 'No file received',
  '功能扩展管理仅对管理员开放': 'Only administrators can manage modules',

  // ——— 反馈汇总通道（src/routes/feedback.mjs；设置里提交反馈的去向说明、提交人的勾选与管理员开关，iOS / 桌面两份设置共用）———
  // 默认不外发：管理员打开「把用户反馈同时发给 bridge 开发者」+ 提交人勾「这条也发给 bridge 开发者」才发
  'enabled 必须是 true / false': 'enabled must be true or false',
  '这台服务器没配反馈中继地址，开不了': 'This server has no feedback relay configured, so this can’t be turned on',
  '把用户反馈同时发给 {to}': 'Share user feedback with {to}',
  '默认关。打开后，提交页会多一个「这条也发给 {to}」，提交的人自己勾了才发。': 'Off by default. When it’s on, the feedback form shows an “Also send this to {to}” switch, and feedback is sent only if the person submitting turns it on.',
  '发往 {host}。': 'Sent to {host}.',
  '这条也发给 {to}': 'Also send this to {to}',
  '勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址；图片最多 3 张，原样发出，截图里能看到的开发者也能看到；视频不发。': 'When this is on, your feedback is also sent to {to}: your text, the screen you were on, the app version, and the system. Your account name and the server URL are not included. Up to 3 images are sent as they are, so the developer can see everything in your screenshots. Videos are not sent.',
  '勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址。这是公开发布：内容任何人都能看到，请别写隐私、账号、密钥；图片不会公开发布（只记张数），视频不发。': 'When this is on, your feedback is also sent to {to}: your text, the screen you were on, the app version, and the system. Your account name and the server URL are not included. This is published publicly, so anyone can read it: please don’t include anything private, such as account details or keys. Images are not published (only their count is recorded), and videos are not sent.',
  '这个去向是公开的：提交的内容任何人都能看到，请提醒大家别写隐私、账号和密钥。': 'This destination is public: anyone can read what gets submitted, so remind people not to include anything private, such as account details or keys.',
  '反馈 推送 开发者 汇总 关闭': 'feedback send developer share off',
  '没改成：{reason}': 'Couldn’t change it: {reason}',
  '这台服务器没开「把用户反馈同时发给 {to}」，反馈只留在服务器上，由管理员查看。': 'This server doesn’t share feedback with {to}. Your feedback stays on the server for the admin to read.',
  '这台服务器没开「把用户反馈同时发给 {to}」。': 'Sharing user feedback with {to} is off on this server.',
  '反馈只留在这台服务器上，由管理员查看。': 'Your feedback stays on this server for the admin to read.',
  '反馈只留在这台服务器上，存放在 {dir}。': 'Feedback stays on this server, in {dir}.',
  '这台是汇总端，但没配中继地址，拉不了外部反馈：在 config.json 写 feedbackRelay，或设环境变量 BRIDGE_FEEDBACK_RELAY。': 'This server collects feedback from other servers, but no relay is configured, so nothing can be fetched. Set feedbackRelay in config.json or the BRIDGE_FEEDBACK_RELAY environment variable.',
  '还有 {n} 条没发出去，连上后自动补发。': '{n} not sent yet. They’ll be sent automatically when the connection is back.',
  '关掉后，这台服务器上的反馈只留在本机，还没发出去的也一并取消。': 'When off, feedback stays on this server, and anything not sent yet is canceled.',
  '遇到的问题、想要的功能、体验吐槽都行，可附图片/视频。': 'Report a problem, request a feature, or share any other thoughts. You can attach images or videos.',
  '已记下，也会转给 {to}。': 'Saved. It will also be sent to {to}.',
  '已记下，服务器管理员会看到。': 'Saved. The server admin will see it.',
  '这台是汇总端，拉取外部反馈出错（{at}）：{err}': 'This server collects feedback from other servers, but the last fetch failed ({at}): {err}',
  '收件令牌（config.json 的 feedbackInbox.token）和中继的 INBOX_TOKEN 对不上。': 'The inbox token (feedbackInbox.token in config.json) doesn’t match the relay’s INBOX_TOKEN.',
  '中继还没部署收件箱，或没配 INBOX_TOKEN。': 'The relay inbox isn’t deployed yet, or INBOX_TOKEN isn’t set.',
  '这台是汇总端：上次拉取 {at}，累计收到 {n} 条外部反馈。': 'This server collects feedback from other servers. Last fetched {at}; {n} received so far.',
  '这台是汇总端：启动后约 20 秒第一次拉取外部反馈。': 'This server collects feedback from other servers. The first fetch runs about 20 seconds after startup.',

  // ——— 桌面客户端设置页 › 连接：退出 App 时本机服务端（壳托管）怎么办——先问，默认隐藏到托盘（S1-3）———
  '退出前确认': 'Confirm before quitting',
  '点「退出」先问一句，默认隐藏到托盘、服务端照常运行；关掉后「退出」直接退出并停止本机服务端': 'Ask before quitting. By default the app hides to the tray and the server keeps running. When off, Quit closes the app and stops the local server.',
  '退出 关闭 停止 本机服务端 quit': 'quit close stop local server exit',

  // ——— 桌面客户端设置页 › 连接：本机服务端插电时保持在线（S1-3，壳的 keep-online）———
  '插电时保持在线': 'Stay online when plugged in',
  '睡眠 休眠 唤醒 电源 常驻 在线 本机服务端 sleep awake': 'sleep hibernate wake power always on online local server awake',
  '这台电脑当服务器：插着电时不会闲置睡眠（屏幕照常关），手机随时连得上；用电池时照常睡眠': 'While this computer is your server, it won’t sleep when idle as long as it’s plugged in (the screen still turns off), so your phone can always connect. On battery, it sleeps as usual.',
  '现在在用电池：照常睡眠，插上电再接着保持在线': 'On battery now: it sleeps as usual and stays online again once plugged in.',
  '关着：插电闲置 {n} 分钟后电脑会睡眠，睡着时手机连不上': {
    one: 'Off: plugged in, this computer sleeps after {n} minute idle, and your phone can’t connect while it’s asleep.',
    other: 'Off: plugged in, this computer sleeps after {n} minutes idle, and your phone can’t connect while it’s asleep.',
  },
  '关着：电源计划本来就不让电脑自动睡眠，手机随时连得上': 'Off: your power plan already keeps this computer from sleeping, so your phone can always connect.',
  '关着：电脑按电源计划睡眠，睡着时手机连不上': 'Off: this computer sleeps according to its power plan, and your phone can’t connect while it’s asleep.',

  // ——— 桌面客户端设置页 › 连接：本机服务端的访问信息与重新配置（打开壳自己的本地页，见 client/desktop/server-setup.html）———
  '本机服务端访问信息': 'Local server access details',
  '访问令牌、局域网与公网地址': 'Access token, local and public addresses',
  '重新配置本机服务端': 'Reconfigure the local server',
  '工作空间、端口、Claude 账号': 'Workspace, port, Claude account',
  '访问令牌 token 局域网 地址 公网 重新配置 端口': 'access token local network address public reconfigure port',

  // ——— Codex 分页：这次构建没带 ChatGPT 页面（ChatGPTPage.svelte 探不到 chatgpt/index.html 时；管理员多看一句原因）———
  '此版本未包含 ChatGPT 页面': 'This version doesn’t include the ChatGPT page',
  '这次前端构建没有接上私有 overlay（环境变量 BRIDGE_OVERLAY_DIR，或数据根 config.json 的 overlayDir）。配好后重新构建前端即可恢复。':
    'This frontend build wasn’t connected to the private overlay (the BRIDGE_OVERLAY_DIR environment variable, or overlayDir in config.json in the data root). Set it up and rebuild the frontend to restore the page.',
  '这个部署没有附带 Codex 分页的界面。': 'This deployment doesn’t come with the Codex page’s interface.',

  // ——— 更新不把自己踢下线（开源路线 S1-5）：服务器要重启 / 装更新时推给所有设备的提示（lib/appUpdate.js 末尾）———
  '服务器有 {n} 个对话在跑，跑完后会自动更新并重启，期间照常用': {
    one: 'The server has {n} conversation running. It will update and restart once that finishes. Keep using it as usual until then.',
    other: 'The server has {n} conversations running. It will update and restart once they finish. Keep using it as usual until then.',
  },
  '服务器有 {n} 个对话在跑，跑完后会自动重启，期间照常用': {
    one: 'The server has {n} conversation running. It will restart once that finishes. Keep using it as usual until then.',
    other: 'The server has {n} conversations running. It will restart once they finish. Keep using it as usual until then.',
  },
  '服务器正在更新，一两分钟后自动重连': 'The server is updating. You’ll reconnect automatically in a minute or two.',
  '服务器正在重启，几秒后自动重连': 'The server is restarting. You’ll reconnect automatically in a few seconds.',
  '等了 30 分钟一直有对话在跑，服务器这次没有更新': 'Conversations kept running for 30 minutes, so the server didn’t update this time.',
  '等了 30 分钟一直有对话在跑，服务器这次没有重启': 'Conversations kept running for 30 minutes, so the server didn’t restart this time.',
  '服务器取消了这次更新': 'The server canceled this update.',
  '服务器取消了这次重启': 'The server canceled this restart.',
  '服务器已更新到 v{v}': 'The server was updated to v{v}.',
  '服务器已更新到 v{v}，刷新页面就能用上新版': 'The server was updated to v{v}. Refresh the page to use the new version.',
  '服务器已经回来了': 'The server is back.',
  // 桌面设置「连接与更新 › 软件更新」：托管着本机服务端、等对话跑完再装
  '等 {n} 个对话跑完后自动安装': {
    one: 'Installs once {n} conversation finishes',
    other: 'Installs once {n} conversations finish',
  },
  '等服务器空闲后自动安装…': 'Installs once the server is idle…',
  'update::取消等待': 'Stop waiting',
  '立即安装（会中断）': 'Install now (interrupts)',
  // 壳写在更新状态里的说明（client/desktop/update-gate.cjs，tr() 运行时匹配）
  '等了 30 分钟一直有对话在跑，这次没有装。空闲时再点「一键更新」，或选「立即更新」。':
    'Conversations kept running for 30 minutes, so the update wasn’t installed. Click “Update” again when things are quiet, or choose “Update now”.',
  '服务端那边取消了等待，这次没有装。': 'The wait was canceled on the server, so the update wasn’t installed.',
  '已取消等待，这次没有装。': 'Stopped waiting. The update wasn’t installed.',
  '服务端没接下「空闲后自动更新」，这次没有装。可以选「立即更新」。':
    'The server didn’t accept “Update when idle”, so the update wasn’t installed. You can choose “Update now” instead.',
  '服务端没应答，这次没有装。稍后再点「一键更新」。': 'The server didn’t respond, so the update wasn’t installed. Click “Update” again in a moment.',
  '已下载的更新不见了（可能被杀毒软件隔离），这次没有装；服务端照常重启。':
    'The downloaded update is gone (an antivirus program may have quarantined it), so it wasn’t installed. The server restarts as usual.',
  '安装程序没能启动，这次没有装。': 'The installer couldn’t start, so the update wasn’t installed.',
  '服务端已经在退出去装更新了，取消不了。': 'The server is already shutting down to install the update, so this can’t be canceled.',
  // 控制台「设备」远程更新：那台电脑已在下载 / 等对话跑完 / 交接安装（壳回 busy 带的原因）
  '这台电脑已在等对话跑完后安装更新': 'This computer is already waiting for conversations to finish before installing an update',
  '这台电脑正在下载或安装更新': 'This computer is already downloading or installing an update',
  '这台电脑托管着 bridge 服务端，用的是临时地址：更新后地址会变，远程连着的手机和网页会连不回来。请在这台电脑上更新，或先换成固定地址。':
    'This computer hosts the bridge server on a temporary URL. Updating changes the URL, so phones and browsers connected remotely can’t reconnect. Update on this computer instead, or switch to a fixed URL first.',
  // 服务端控制台：服务控制 / 设备
  '现在有 {n} 轮对话在跑，不会被打断。': {
    one: '{n} turn is running right now and won’t be interrupted.',
    other: '{n} turns are running right now and won’t be interrupted.',
  },
  '等空闲中：还有 {n} 轮在跑，跑完就更新并重启（最多等 30 分钟）': {
    one: 'Waiting for idle: {n} turn still running. The server updates and restarts once it finishes (waits up to 30 minutes).',
    other: 'Waiting for idle: {n} turns still running. The server updates and restarts once they finish (waits up to 30 minutes).',
  },
  '桌面客户端已下好新版，等 {n} 轮对话跑完就装；装完服务端自动回来。': {
    one: 'The desktop client has downloaded the new version and installs it once {n} turn finishes. The server comes back on its own afterwards.',
    other: 'The desktop client has downloaded the new version and installs it once {n} turns finish. The server comes back on its own afterwards.',
  },
  '客户端会下载 v{version} 并静默安装，装完自动重新上线（控制通道断开约一两分钟）。如果这台电脑托管着服务端，会等所有对话跑完再装；它用的是临时地址时会拒绝远程更新。':
    'The client downloads v{version}, installs it silently, and comes back online by itself (the control channel drops for a minute or two). If this computer hosts the server, it waits for every conversation to finish first. If it uses a temporary URL, it declines remote updates.',
  '已下达：v{from} → v{to}，下载完等对话都跑完再装，装完服务端自动回来': 'Sent: v{from} → v{to}. It installs after downloading, once all conversations finish, and the server comes back on its own.',
  // ——— 部署形态（src/config/deploy-profile.mjs 的 label，经 /api/admin/service 下发；控制台「服务控制」的小卡片）———
  '本机桌面': 'Desktop',
  '无界面服务器': 'Headless server',
  'Docker 容器': 'Docker container',
  '部署形态 · 监听 {host}': 'Deployment · listening on {host}',
  '给谁用、监听地址、Claude in Chrome、保持唤醒的默认值按部署形态定；显式设置优先': 'Defaults for who can use it, the listen address, Claude in Chrome, and keeping the computer awake follow the deployment type. Explicit settings take priority.',
};
