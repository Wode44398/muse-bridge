// 扩展面板（components/ext/Customize.svelte）：官方「自定义」页同款的「我的 / 发现」与市场
export default {
  // 市场与分类
  'Anthropic 官方目录': 'Anthropic Directory',
  'Anthropic 知识工作': 'Anthropic Knowledge Work',
  '开发': 'Development',
  '效率': 'Productivity',
  '数据库': 'Databases',
  '监控': 'Monitoring',
  '部署': 'Deployment',
  '设计': 'Design',
  '自动化': 'Automation',
  '学习': 'Learning',
  '测试': 'Testing',
  '金融': 'Finance',

  // 头图
  '任务、计划与跟进——每天都用得上的一套工具。': 'Tasks, planning and follow-ups — the everyday toolkit.',
  '把各类库最新版本的文档和代码示例实时拉进对话，开箱即用、不用密钥。': 'Pull up-to-date, version-specific docs and code examples into the conversation. Works out of the box, no key needed.',
  'Word、Excel、PowerPoint、PDF 的读写与排版，一次装齐。': 'Read, write and lay out Word, Excel, PowerPoint and PDF files — all in one go.',

  // 工具条 / 菜单
  '我的': 'Mine',
  '发现': 'Discover',
  '清除': 'Clear',
  '筛选': 'Filter',
  '全部市场': 'All marketplaces',
  '分类': 'Category',
  '推荐': 'Recommended',
  '管理市场…': 'Manage marketplaces…',
  '刷新市场': 'Refresh marketplaces',

  // 列表
  '正在从 GitHub 拉取官方市场…': 'Fetching the official marketplaces from GitHub…',
  '「{name}」没拉下来：{reason}': 'Couldn’t fetch “{name}”: {reason}',
  '推荐给您': 'Recommended for you',
  '全部技能': 'All skills',
  '全部连接器': 'All connectors',
  '全部插件': 'All plugins',
  '{n} 个结果': { one: '{n} result', other: '{n} results' },
  '没有匹配的结果': 'No matches',
  '来自 {list}。': 'From {list}.',
  '正在更新…': 'Updating…',
  '{plugin} 附带的 MCP 服务': 'MCP server bundled with {plugin}',
  '添加 {name}': 'Add {name}',
  '未对任何 agent 生效': 'Not active for any agent',
  '去「发现」里挑现成的，或者自己上传。': 'Pick one from Discover, or upload your own.',
  '浏览发现': 'Browse Discover',

  // 安装
  '添加中…': 'Adding…',
  '已添加 {n} 项': { one: 'Added {n} item', other: 'Added {n} items' },
  '已添加 {n} 项，{m} 项跳过': 'Added {n}, skipped {m}',
  '已添加市场，正在拉取': 'Marketplace added — fetching',

  // 详情
  '详情': 'Details',
  '所属插件': 'Plugin',
  '作者': 'Author',
  '包含技能': 'Skills inside',
  '包含连接器': 'Connectors inside',
  '代码位置': 'Code',
  '外部仓库，添加时下载': 'External repository, downloaded when added',
  '插件里的技能': 'Skills in this plugin',
  '插件是 Claude Code 专属格式，只对 Claude Code 生效；里面的技能想给 dimensio、Codex 用，可以在「技能」里单独添加。': 'Plugins are a Claude Code format and only work with Claude Code. To use the skills inside with dimensio or Codex, add them individually under Skills.',
  '这个连接器要填凭据（${…} 占位），添加后会打开编辑表单。': 'This connector needs credentials (the ${…} placeholders). The edit form opens after adding.',
  '远程连接器若要求 OAuth 登录，需要服务支持令牌请求头，否则添加后连不上。': 'If a remote connector requires OAuth sign-in, it only works when the service also accepts a token header.',
  '技能对 Claude Code 下一条消息生效，对 dimensio 与 Codex 在新会话生效。': 'Skills take effect on the next Claude Code message, and in new dimensio and Codex sessions.',

  // 市场源
  '市场': 'Marketplaces',
  '{a} 插件 · {b} 技能 · {c} 连接器': '{a} plugins · {b} skills · {c} connectors',
  '拉取失败': 'Fetch failed',
  '添加 GitHub 市场': 'Add a GitHub marketplace',
  '仓库根目录要有 .claude-plugin/marketplace.json（Claude Code 插件市场格式）。': 'The repository needs a .claude-plugin/marketplace.json at its root (Claude Code marketplace format).',

  // 服务端（ext-market.mjs）
  '请填 GitHub 仓库：owner/repo': 'Enter a GitHub repository: owner/repo',
  '这个市场已经在列表里了': 'This marketplace is already in the list',
  '自定义市场最多 12 个': 'You can add up to 12 custom marketplaces',
  '市场索引还没建好，稍后再试': 'The marketplace index isn’t ready yet. Try again shortly.',
  '市场里找不到这一项（索引可能已更新，刷新一下）': 'This item is no longer in the marketplace (the index may have changed — refresh)',
  '这个市场的仓库文件列表没拿到（GitHub 限流？），稍后刷新再试': 'Couldn’t get this marketplace’s file list (GitHub rate limit?). Refresh later.',
  '体积超过 40MB 上限': 'Larger than the 40 MB limit',
  '这个插件里没有可单独安装的技能': 'This plugin has no skills that can be installed on their own',
  '市场清单里已经没有这个插件了': 'This plugin is no longer in the marketplace',
  '不支持的插件来源': 'Unsupported plugin source',
  '仓库里没有插件所在的子目录': 'The plugin’s folder isn’t in the repository',
  '仓库压缩包是空的': 'The repository archive is empty',
  '仓库太大': 'The repository is too large',
  '未知的安装类型': 'Unknown install type',

  // 范围：我自用 / 全服统一
  '生效范围': 'Scope',
  '我自用': 'Just me',
  '全服统一': 'Everyone',
  '所有成员下一条消息生效': 'Takes effect on every member’s next message',
  '只对管理员生效 · 新会话': 'Admin only · new sessions',
  '这里加装的扩展给服务器上所有成员用：成员的 Claude 会话和定时任务都会加载，你自己的会话也会。和你自用的那一套互不影响。':
    'Extensions added here are for everyone on this server: every member’s Claude sessions and routines load them, and so do yours. They’re kept separate from your own set.',
  '这台服务器没开多用户，全服扩展眼下只有你自己用得上；开了多用户后所有成员的 Claude 会话都会加载。':
    'Multi-user is off on this server, so for now only you get these. Once it’s on, every member’s Claude sessions load them.',
  '全服连接器：所有成员调用它时用的都是这里填的凭据；凭据加密存在服务端，成员看不到。':
    'Server-wide connector: every member uses the credentials entered here. They’re stored encrypted on the server and members can’t see them.',
  '将删除它的全部文件，所有成员的会话都不再加载它。此操作不可撤销。': 'All its files will be deleted and no member’s sessions will load it anymore. This can’t be undone.',
  '将删除包内 {n} 个扩展的全部文件，所有成员的会话都不再加载它们。此操作不可撤销。': 'All files of the {n} extensions in this package will be deleted and no member’s sessions will load them anymore. This can’t be undone.',
  '给所有成员统一加装：去「发现」里挑现成的，或者自己上传。': 'Add extensions for every member: pick ready-made ones in Discover, or upload your own.',
  '所有成员新会话生效': 'All members · new sessions',
  // 成员自己的技能页
  '服务器统一提供': 'Provided by the server',
  '管理员给所有成员加装的技能，直接可用，不能在这里改动。': 'Skills your admin added for every member. They’re ready to use and can’t be changed here.',
};
