// dimensio 英文界面文案 · 项目对话（运行设置的对话形态、上下文面板的项目概览、工具行、后端下发的工具结果行；server/project-mode.ts）。
// 与 bridge 的 web/src/i18n/en/project-mode.js 同名的键沿用同一译法：项目对话 = project conversation（协调者 coordinator），讨论串 = thread。
// 「项目」「项目记忆」「取消」「保存」「进行中」在别的分区里已有译法，这里不重复。
export default {
  // 运行设置（components/sheets/RunSettings.svelte）
  "对话形态": "Conversation type",
  "普通对话": "Chat",
  "这条对话当协调者：只看、只派活，干活的是它开出来的讨论串，你能点开讨论串直接聊。形态在发第一条消息时定下，之后不变。":
    "This conversation becomes the coordinator: it only reads and delegates, and the threads it starts do the work. You can open a thread and talk to it directly. The type is set when you send the first message and doesn’t change afterwards.",
  "dimensio 在这条对话里自己动手。选「项目」就改成协调者 + 讨论串。": "dimensio does the work itself in this conversation. Pick Project for a coordinator with threads.",
  "项目对话：这条对话是协调者，只看、只派活；下面的工作档位给它开出来的讨论串。":
    "Project conversation: this conversation is the coordinator and only reads and delegates. The work mode below applies to the threads it starts.",
  "讨论串的工作档位": "Work mode for threads",
  // 项目概览（components/sheets/ProjectOverview.svelte）
  "项目概览": "Project overview",
  "讨论串": "Threads",
  "等你": "Waiting on you",
  "空闲": "Idle",
  "已解决": "Resolved",
  "正在读项目概览…": "Loading the project overview…",
  "还没有讨论串：在这里说要做什么，协调者会把要动手的活开成讨论串，它们出现在这里和侧栏里。":
    "No threads yet. Tell the coordinator what to do here. It starts threads for the hands-on work, and they show up here and in the sidebar.",
  "打开这条讨论串": "Open this thread",
  "标为已解决": "Mark resolved",
  "重新打开": "Reopen",
  "同时最多 {live} 条在跑，一个项目最多 {all} 条。": "Up to {live} running at once, {all} per project.",
  "项目说明": "Project instructions",
  "协调者和每条讨论串都要遵守的：目标、约定、哪些不许碰……": "What the coordinator and every thread follow: goals, conventions, what not to touch…",
  "改了从下一轮开始生效，正在跑的这一轮不受影响。": "Changes apply from the next turn. A turn that’s already running isn’t affected.",
  "编辑项目说明": "Edit the project instructions",
  "还没有项目说明。点这里写下协调者和讨论串都要遵守的约定。": "No project instructions yet. Click to write the rules the coordinator and every thread follow.",
  "还是空的。你说「记住…」或定下长期有效的决定时，协调者和讨论串会记进来。":
    "Empty so far. When you say “remember…” or settle a lasting decision, the coordinator and threads write it here.",
  // 工具行动词（lib/icons.ts）
  "停下讨论串": "Stop a thread",
  "读项目记忆": "Read project memory",
  "写项目记忆": "Write project memory",
  "删项目记忆": "Delete from project memory",
  // 后端下发的工具结果行（server/tools/sessions.ts、server/tools/project.ts，ToolRow 里 tr()）
  "已停下讨论串「{title}」": "Stopped the thread “{title}”",
  "已把「{title}」标为已解决": "Marked “{title}” resolved",
  "已重新打开「{title}」": "Reopened “{title}”",
  "已写入项目记忆「{name}」": "Saved “{name}” to the project memory",
  "已删掉「{name}」": "Deleted “{name}”",
  "没在跑": "Not running",
  "项目记忆还是空的": "The project memory is empty",
  "{n} 篇": { one: "{n} note", other: "{n} notes" },
};
