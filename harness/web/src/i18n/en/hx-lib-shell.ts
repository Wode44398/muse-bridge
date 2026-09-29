// dimensio 英文界面文案 · hx-lib-shell：工具动词、厂商与问候、档位胶囊、停靠卡提示、通知、分屏、斜杠命令、任务状态、
// 设备名、本机 AI、附件、复制、会话引用、应用壳（App / Hero / ChatPane / DragLayer / ProjectDialog / Sheet）
//（键 = 中文原文，见 lib/i18n.ts）
export default {
  // ── lib/icons.ts：工具动词（活动行、工具行共用）──
  "执行命令": "Run command",
  "读取文件": "Read file",
  "写入文件": "Write file",
  "编辑文件": "Edit file",
  "匹配文件": "Find files",
  "搜索内容": "Search files",
  "更新计划": "Update plan",
  "预览验证": "Verify preview",
  "操作浏览器": "Use browser",
  "读取页面": "Read page",
  "页内执行": "Run JavaScript",
  "审计请求": "Inspect requests",
  "抓取网页": "Fetch page",
  "联网搜索": "Web search",
  "委托子任务": "Delegate task",
  "编排工作流": "Run workflow",
  "询问确认": "Ask question",
  "写入记忆": "Save memory",
  "检索记忆": "Search memory",
  "载入技能": "Load skill",
  "提交计划": "Submit plan",
  "记忆审计": "Audit memory",
  "汇报目标": "Report on goal",
  "查看连接器": "Inspect connector",
  "调用连接器": "Call connector",

  // ── lib/theme.ts：厂商副标题、时段问候 ──
  "阿里云 · 通义": "Alibaba Cloud · Qwen",
  "智谱 · Z.ai": "Zhipu · Z.ai",
  "月之暗面": "Moonshot AI",
  "小米 · Xiaomi": "Xiaomi",
  "dimensio::本机": "Local",
  "llama.cpp · 离线": "llama.cpp · Offline",
  "夜深了": "Up late?",
  "早上好": "Good morning",
  "中午好": "Good afternoon",
  "下午好": "Good afternoon",
  "晚上好": "Good evening",

  // ── lib/card-dock.ts：停靠在输入框上方的卡片 ──
  "发送 = 拒绝这一步，并把这段话告诉它": "Send to deny this step and tell the agent why",
  "发送 = 用这段话回答上面的问题": "Send to answer the question above with this message",
  "发送 = 退回计划，附上这段修改意见": "Send to request changes to the plan with this feedback",
  "要拒绝就写一句为什么（文字只会拒绝、不会批准）": "Type a reason to deny (a reply can’t approve)…",
  "直接写你的回答，或点上面的选项": "Type your answer, or pick an option above…",
  "写修改意见就是退回；批准请点卡片上的按钮": "Type feedback to request changes, or approve on the card…",
  "一次操作等你批准": "An action is waiting for your approval",
  "一个问题等你回答": "A question is waiting for your answer",
  "一份计划等你审": "A plan is waiting for your review",
  "{what}——在输入框上方": "{what}. It’s above the composer.",
  "{what}——停下输入后出现在输入框上方": "{what}. It’ll appear above the composer when you stop typing.",
  "{what}——排在上一张之后": "{what}. It’s queued after the previous card.",

  // ── lib/feed-units.ts：折叠行上的用时 ──
  "用时 {d}": "Worked for {d}",
  "用时 {d}（等你的 {w}不算）": "Worked for {d} (not counting {w} waiting for you)",
  // 紧凑用时走语境键：bridge 与 dimensio 的字典在 bridge 里合并成一份，plain「{n} 秒 / {n} 小时」在 bridge 是
  // 整写的 sec / hr（设置里的运行时长、播放器快进），同键会互相覆盖
  "dimensio::{n} 秒": "{n}s",
  "{n} 分": "{n}m",
  "{m} 分 {s} 秒": "{m}m {s}s",
  "dimensio::{n} 小时": "{n}h",
  "{h} 小时 {m} 分": "{h}h {m}m",

  // ── lib/mode-chip.ts：输入框左下的档位胶囊 ──
  "自主": "Auto",
  "只读": "Read-only",
  "计划": "Plan",
  "仅工作空间": "Workspace only",
  "+{n} 目录": { one: "+{n} folder", other: "+{n} folders" },
  "离开": "Away",
  "目标": "Goal",

  // ── lib/notify-policy.ts：系统通知 / 应用内提示 ──
  "dimensio · 在等你批准": "dimensio · Waiting for your approval",
  "dimensio · 在等你回答": "dimensio · Waiting for your answer",
  "dimensio · 提交了计划，等你审": "dimensio · Plan ready for your review",
  "dimensio · 完成": "dimensio · Done",
  "{name}在等你批准（{tool}）": "{name} is waiting for your approval ({tool})",
  "{name}在等你批准": "{name} is waiting for your approval",
  "{name}在等你回答": "{name} is waiting for your answer",
  "{name}提交了计划，等你审": "{name} submitted a plan for your review",
  "{name}这一轮跑完了": "{name} is done",
  "「{title}」": "“{title}”",
  "一个对话": "A chat",

  // ── lib/split.ts：拖会话进正文区时幽灵下方的提示 ──
  "打开这个对话": "Open this chat",
  "在左边分屏打开": "Open in split view on the left",
  "在右边分屏打开": "Open in split view on the right",
  "在左格打开": "Open in left pane",
  "在右格打开": "Open in right pane",
  "换到左格": "Move to left pane",
  "换到右格": "Move to right pane",

  // ── lib/slash.ts：/ 面板里的内置命令与技能包 ──
  "开一个新对话（同一个项目）": "New chat in this project",
  "立即压缩：较早的对话换成摘要，接着在这里聊": "Compact now: summarize earlier messages and keep chatting here",
  "带摘要开新会话：整段写成摘要带过去，原会话留着": "New session with summary: start fresh with a summary of this one; the original stays",
  "把这条作为目标：没达成会自动一轮轮接着做": "Set this as a goal: keeps working turn after turn until it’s achieved",
  "<目标>": "<goal>",
  "技能包 · {n} 个技能，点包名让它挑": {
    one: "Bundle · {n} skill · Select it to let the agent choose",
    other: "Bundle · {n} skills · Select it to let the agent choose",
  },

  // ── lib/tasks.ts：任务面板 / 工作流卡 / Agent 卡 ──
  "运行中": "Running",
  "已完成": "Completed",
  "失败": "Failed",
  "已停止": "Stopped",
  "工作流": "Workflow",
  "子 agent": "Subagent",

  // ── lib/client-id.ts：回执上「在哪台设备上定的」──
  "在手机上": "on your phone",
  "在平板上": "on your tablet",
  "在电脑上": "on your computer",
  "在{label}上": "on {label}",

  // ── lib/localai.svelte.ts：本机 AI 状态 ──
  "状态不可用": "Status unavailable",
  "加载中": "Loading…",
  "未运行": "Not running",

  // ── lib/attach.svelte.ts：粘贴 / 拖入附件 ──
  "文件过多，只取前 {n} 个": "Too many files. Only the first {n} were added.",
  "{n} 个文件上传失败": { one: "Couldn’t upload {n} file", other: "Couldn’t upload {n} files" },

  // ── lib/copy-click.ts、lib/markdown.ts：代码块复制钮 ──
  "复制": "Copy",
  "已复制": "Copied",

  // ── lib/session-refs.ts：引用会话 ──
  "不能引用对话自己": "A chat can’t reference itself",
  "一条消息最多引用 {n} 个对话": {
    one: "A message can reference up to {n} chat",
    other: "A message can reference up to {n} chats",
  },

  // ── App.svelte：分栏手柄、抽屉、灯箱 ──
  "拖拽调整两格的宽度（双击复位）": "Drag to resize panes (double-click to reset)",
  "拖拽调整左右占比（双击复位）": "Drag to resize (double-click to reset)",
  "关闭侧栏": "Close sidebar",
  "查看大图": "View image",
  "关闭大图": "Close image",
  "大图": "Image",
  "关闭": "Close",

  // ── components/shell/Hero.svelte：空态首屏 ──
  "正在连接…": "Connecting…",
  "连不上服务器，检查连接设置": "Can’t reach the server. Check your connection settings.",
  "App 版本过旧，服务端已不再支持，请更新到最新版": "This app version is no longer supported by the server. Update to the latest version.",
  "服务端版本较旧，部分功能可能用不了，请更新服务端": "The server is out of date, so some features may not work. Update the server.",
  "先在设置里填 {name} 的 API Key": "Add your {name} API key in Settings first",

  // ── components/shell/ChatPane.svelte：分屏每一格的读屏名 ──
  "第 {n} 格：{title}": "Pane {n}: {title}",
  "第 {n} 格：{title}（当前）": "Pane {n}: {title} (current)",
  "新对话": "New chat",

  // ── components/shell/DragLayer.svelte ──
  "（空会话）": "(Empty session)",

  // ── components/shell/ProjectDialog.svelte：新建项目（兜底目录选择器）──
  "导入失败：{reason}": "Couldn’t import: {reason}",
  "新建项目": "New project",
  "选择一个文件夹作为项目工作空间": "Choose a folder to use as the project workspace",
  "此文件夹内没有子文件夹": "This folder has no subfolders",
  "取消": "Cancel",
  "创建中…": "Creating…",
  "使用此文件夹": "Use this folder",

  // ── components/ui/Sheet.svelte ──
  "返回": "Back",
};
