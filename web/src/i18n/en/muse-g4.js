// 英文界面文案 · muse-g4 （键 = 中文原文，见 lib/i18n.js）
// Muse Bridge 自有文案：服务端控制台（导航 / 总览 / 活跃进程 / 服务控制 / 用户 / 额度）、扩展、定时任务。
export default {
  // —— 服务端控制台（ServerAdmin / SaOverview / SaActive / SaControl / SaService）——
  '进程 · 开机自启': 'Processes · Run on startup',
  '正在连接服务…': 'Connecting to the service…',
  'Claude 对话生成': 'Claude generations',
  '中止 = 调用该用户活跃生成的 abort（等价于该用户自己点「停止」）。':
    '“Stop” calls abort on that user’s active generation (the same as the user stopping it themselves).',
  '访问地址': 'URL',
  '日志只留本次启动以来最近几百行（内存里，重启即清）；完整日志在服务器上：journalctl -u bridge。':
    'Only the last few hundred lines since the service started are kept (in memory, cleared on restart). Full logs are on the server: journalctl -u bridge.',

  // —— 用户 / 额度与注册（SaUsers / SaPolicy）——
  '普通（user）档没有命令行；能用哪些 agent 在「权限」里按人勾选（新账号默认只有 Claude，dimensio 按人放行）。邀请码一次性。':
    'The Standard (user) tier has no shell. Choose which agents each person can use under “Manage” (new accounts get Claude only; turn on dimensio per person). Invite codes are single-use.',
  '留空或填 0 = 不限。额度只算 Claude（大家共用的是服务器上的 Claude 订阅），dimensio 不计；管理员不受限。':
    'Leave blank or enter 0 for no limit. Quotas count Claude only (everyone shares the Claude subscription on the server); dimensio isn’t counted. Admins have no limits.',

  // —— 扩展（ExtensionsPage）——
  '技能是带 YAML frontmatter 的 SKILL.md 指引包（可含脚本等附属文件）。对 Claude Code 下一条消息即生效；对 dimensio 在新会话生效。':
    'A skill is a SKILL.md file of instructions with YAML frontmatter, optionally with scripts and other supporting files. It takes effect on the next message in Claude Code and in new sessions in dimensio.',
  '连接器是外部 MCP 服务，支持 stdio / http / sse 全部传输。对 Claude Code 下一条消息生效，对 dimensio 在新会话生效。':
    'A connector is an external MCP server. All transports are supported (stdio / HTTP / SSE). It takes effect on the next message in Claude Code and in new sessions in dimensio.',
  '对 Claude Code · dimensio 按扩展勾选生效': 'Choose agents per extension: Claude Code · dimensio',

  // —— 定时任务（RoutinesPage）——
  '加载失败：连不上服务器（列表可能不是最新）': 'Couldn’t load: can’t reach the server. The list may be out of date.',
  '切换失败：连不上服务器，请重试': 'Couldn’t update: can’t reach the server. Try again.',
  '运行失败：连不上服务器，请重试': 'Couldn’t run: can’t reach the server. Try again.',
  '删除失败：连不上服务器，请重试': 'Couldn’t delete: can’t reach the server. Try again.',
  // —— Claude 认证报错提示（runtime/status.mjs 里 Muse 版的 hint，跟 server.js 里上游那两句不同）——
  '令牌过期或被撤销：在你自己的电脑上重新运行 claude setup-token，把新令牌更新到「设置 → 连接 → 服务端控制台 → Claude 账号」（在 Muse 上部署的，也可以让 Muse 运行 set-claude-token）。': 'The token expired or was revoked. On your own computer, run claude setup-token again and update the token in Settings → Connection → Admin console → Claude accounts. (On Muse, you can also ask Muse to run set-claude-token.)',
  '在你自己的电脑上运行 claude setup-token 生成订阅令牌，然后在「设置 → 连接 → 服务端控制台 → Claude 账号」里添加；在 Muse 上部署的，也可以把令牌发给 Muse，让它运行 set-claude-token。': 'On your own computer, run claude setup-token to get a subscription token, then add it in Settings → Connection → Admin console → Claude accounts. (On Muse, you can also send the token to Muse and ask it to run set-claude-token.)',
};
