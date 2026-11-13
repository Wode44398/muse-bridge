// dimensio 英文界面文案 · 会话协作（会话消息卡、侧栏子会话、工具行、后端下发的工具结果行）。偏好项的英文在 server/prefs/collab.ts 的 en 里
// 与 bridge 的 web/src/i18n/en/session-family.js 同一批键，译法保持一致。
export default {
  // 会话消息卡（components/feed/SessionCard.svelte）
  "父会话": "parent session",
  "子会话": "child session",
  "兄弟会话": "sibling session",
  "相关会话": "Linked sessions",
  "{rel}派来的任务": "Task from {rel}",
  "来自{rel}": "From {rel}",
  "另一个会话": "Another session",
  "打开这个会话": "Open this session",
  "背景": "Background",
  "展开全部": "Show all",
  "{n} 个子会话的汇报": "Reports from {n} sessions",
  "子会话的汇报": "Report from a session",
  "这一轮已结束": "Turn ended",
  "这一轮出错了": "Turn failed",
  "被停下": "Stopped",
  // 打开 Claude 会话（lib/session-family.svelte.ts、components/shell/FamilyList.svelte）
  "这是 bridge 里的 Claude 会话，到 bridge 的 Claude 页打开它": "This is a Claude session in bridge. Open it from bridge’s Claude page.",
  "在 bridge 的 Claude 页打开": "Open in bridge’s Claude page",
  "Claude 会话": "Claude session",
  // 工具行动词（lib/icons.ts）
  "开新会话": "Start a session",
  "给会话发消息": "Message a session",
  "查看相关会话": "List related sessions",
  "读会话回复": "Read a session’s reply",
  // 后端下发的工具结果行（server/tools/sessions.ts，ToolRow 里 tr()）
  "已开出子会话「{title}」": "Started the child session “{title}”",
  "已开出 Claude 会话「{title}」": "Started the Claude session “{title}”",
  "已送达": "Delivered",
  "{n} 个相关会话": { one: "{n} related session", other: "{n} related sessions" },
  "还没有回复": "No reply yet",
};
