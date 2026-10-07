// 英文界面文案 · 设置 → dimensio 分区（SecDimensio.svelte；键 = 中文原文，见 lib/i18n.js）。
// 与 dimensio 字典（harness/web/src/i18n/en/hx-settings-sidebar.ts 等）里的同键同译。
export default {
  // —— 模型服务 · API Key ——
  '模型服务': 'Provider',
  '已配 Key': 'Key set',
  '缺 Key': 'No key',
  'Key 只存于服务端内存，不落盘、不回传浏览器。': 'The key is kept only in server memory. It’s never written to disk or sent to the browser.',
  '自定义服务的 Key 加密存在服务端，不回传浏览器。': 'Keys for custom providers are stored encrypted on the server and never sent to the browser.',
  '••••••••（留空保持不变）': '•••••••• (leave blank to keep current)',
  '粘贴 {name} API Key': 'Paste your {name} API key',
  '换模型服务在 dimensio 输入框旁的型号胶囊里': 'To switch providers, use the model picker next to the dimensio composer',
  '正在连接…': 'Connecting…',
  '连不上 dimensio 服务': 'Can’t reach the dimensio service',

  // —— 记忆 ——
  '记忆': 'Memory',
  '记忆管理': 'Manage memory',
  '模型跨对话记住的事：看、确认、驳回、清理': 'What the model remembers across chats: review, confirm, reject, clean up',
  '{n} 条生效': { one: '{n} active memory', other: '{n} active memories' },
  '{n} 条生效，分布在 {places} 处': { one: '{n} active memory in {places} places', other: '{n} active memories in {places} places' },
  '还没有记忆': 'No memories yet',
  '{n} 条待处理': { one: '{n} pending', other: '{n} pending' },
  '有改动还没保存：先点「保存」，再去看记忆': 'You have unsaved changes. Save them before opening memory.',

  // —— 权限规则 ——
  '权限规则': 'Permission rules',
  '每次问我': 'Always ask',
  '从不允许': 'Never allow',
  '一行一条，如 Bash(git push:*)': 'One per line, e.g. Bash(git push:*)',
  '一行一条，如 Bash(rm -rf:*)': 'One per line, e.g. Bash(rm -rf:*)',
  '规则匹配命令/路径前缀，是减少误操作的软闸，不是对抗性安全沙箱。保存后对所有会话（包括正开着的）下一次调用就生效，重启也不丢。权限卡上的「本会话都允许」只管当前会话，切了运行档位、访问范围或改了这里的规则就失效，会再问一次。运行档位（自主执行 / 只读 / 先出计划）在输入框旁的档位胶囊，随时可切、对当前会话立刻生效。':
    'Rules match command or path prefixes. They’re a safeguard against mistakes, not a security sandbox. Once saved, they apply to every session (including open ones) from the next tool call, and persist across restarts. “Allow for this session” on a permission request covers only the current session. It resets when you switch the mode or access, or edit these rules, and you’ll be asked again. The mode (Auto / Read-only / Plan first) is in the mode picker next to the composer. Switch it anytime; it applies to the current session immediately.',

  // —— 工作空间 · 访问范围 ——
  '默认工作空间': 'Default workspace',
  '新对话没选项目时在这里干活': 'Where new chats work when no project is picked',
  '选择…': 'Choose…',
  '选择默认工作空间': 'Choose default workspace',
  '把文件夹拖进底栏，它就是 dimensio 的默认工作空间': 'Drag a folder into the bar at the bottom to make it dimensio’s default workspace',
  '访问范围': 'Access',
  '整机可访问': 'Full access',
  '仅工作空间': 'Workspace only',
  '“仅工作空间”会拦截明显越界的路径与命令，用于防误操作，不提供对抗恶意命令的强隔离。整机（默认）下 agent 可用绝对路径读写工作空间以外的文件（密钥文件始终封锁）。此设定是新会话的默认，重启也记得；单个对话随时可在输入框的档位胶囊里切。':
    '“Workspace only” blocks paths and commands that are clearly outside the workspace. It guards against mistakes but doesn’t isolate against malicious commands. With Full access (the default), agents can read and write files outside the workspace using absolute paths (secret files are always blocked). This is the default for new sessions and persists across restarts. You can switch it for a single chat anytime in the mode picker next to the composer.',
  'API Key、规则、工作空间与访问范围点「保存」后生效': 'API key, rules, workspace, and access take effect when you save',

  // —— 显示 ——
  '显示': 'Display',
  'dimensio 外观': 'dimensio appearance',
  'dimensio 分页自己的明暗，与 Claude 的主题分开': 'Light or dark for the dimensio page, separate from the Claude theme',
  '显示全部工作过程': 'Show all work steps',
  '关着时，连续的工具调用收成一行：在跑说正在做什么，做完说做了哪些，点开再看每一步。打开后每一步都平铺参数、结果和实时输出。':
    'When off, consecutive tool calls collapse into one line that shows what’s running now, then what was done. Click it to see each step. When on, every step shows its arguments, result, and live output.',

  // —— 诊断 · 版本 ——
  '诊断': 'Diagnostics',
  '导出当前对话的诊断包': 'Export diagnostic report for this chat',
  '先在 dimensio 里打开一个对话': 'Open a chat in dimensio first',
  '导出': 'Export',
  '卡住了、变慢了、报错了，导出这个包发给维护的人：里面是这一轮的事件记录、服务输出、体检结果与版本信息，不含对话正文和任何 key。':
    'If something is stuck, slow, or failing, export this report and send it to the maintainer. It includes this turn’s event log, service output, health check results, and version info. It doesn’t include chat content or any keys.',
  '服务端 {sha}': 'Server {sha}',
  '协议 {n}': 'Protocol {n}',

  // —— 设置搜索 ——
  'dimensio 的 API Key': 'dimensio API key',
  'dimensio 模型 服务 key 密钥': 'dimensio model provider key secret',
  'dimensio 记忆 memory': 'dimensio memory',
  'dimensio 权限 规则 每次问我 从不允许 permission': 'dimensio permission rules always ask never allow',
  'dimensio 工作空间 访问范围 整机 workspace': 'dimensio workspace access full',
  'dimensio 外观 深色 浅色 主题': 'dimensio appearance dark light theme',
  'dimensio 工作过程 工具调用 展开': 'dimensio work steps tool calls expand',
};
