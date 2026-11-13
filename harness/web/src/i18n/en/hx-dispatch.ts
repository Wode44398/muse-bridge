// dimensio 英文界面文案 · 对话内嵌交互图表（WidgetCard）与子 agent 调度偏好（键 = 中文原文，见 lib/i18n.ts）
// 图表卡的文案与 bridge 的 Claude 图表（web/src/i18n/en/claude-widget.js）同一译法
export default {
  // —— 工具动词（活动行）——
  "画图表": "Drawing a visual",
  "准备画图": "Preparing to draw",

  // —— 图表卡 ——
  "正在画图表…": "Making a visual…",
  "图表没有画出来": "Couldn’t make the visual",
  "图表试图跳转到别的网页，已拦截": "This chart tried to navigate to another web page and was blocked.",
  "图表": "Visual",
  "手机上为静态预览": "Static preview on phone",
  "这张图表要在电脑上查看": "Open on a computer to see this visual",
  "更多操作": "More actions",
  "复制为图片": "Copy as image",
  "下载为 PNG": "Download as PNG",
  "下载为 {kind}": "Download as {kind}",
  "无法复制图片，请重试。": "Couldn’t copy image. Try again.",
  "无法下载图片，请重试。": "Couldn’t download image. Try again.",
  "查看代码": "View code",
  "收起代码": "Hide code",
  "图表想替你发送": "The visual wants to send",
  "图表想替你发送：": "The visual wants to send: ",
  "这一轮结束后发送：": "Sends when this turn ends: ",
  "未发送：": "Not sent: ",
  "忽略": "Dismiss",
  "已下载": "Downloaded",

  // —— 偏好设置（服务端 prefs/dispatch.ts 登记，设置页按注册表画）——
  "子 agent 调度": "Sub-agent dispatch",
  "按难度选型阶梯": "Difficulty-based model ladder",
  "派子 agent 时，按模型性价比数据把这台 dimensio 此刻能用的模型排成「最难 / 难 / 常规 / 机械」四档首选与备选，写进系统提示；Agent 工具与工作流脚本可以直接写 auto:top / auto:hard / auto:normal / auto:light。关掉后只保留下面的调度偏好。":
    "When dispatching sub-agents, rank the models this dimensio can use right now into four tiers (hardest / hard / routine / mechanical) with a pick and a fallback each, based on price/performance data, and add it to the system prompt. The Agent tool and workflow scripts can then write auto:top / auto:hard / auto:normal / auto:light. When off, only the dispatch preference below is kept.",
  "子 agent 调度偏好": "Sub-agent dispatch preference",
  "写给 agent 的话，例如「简单检索用 MiMo V2.6 Flash，审查一律用 Opus」。拼进系统提示，与默认分档冲突时以这里为准。":
    "Instructions for the agent, e.g. “Use MiMo V2.6 Flash for simple lookups, always Opus for reviews.” Added to the system prompt; wins over the default tiers where they conflict.",
  "对话内交互图表": "Inline interactive visuals",
  "允许 agent 在对话里直接画 SVG 图表、流程图和可交互的小部件。关掉后新对话不再提供这个工具。":
    "Let the agent draw SVG charts, diagrams and small interactive widgets right in the conversation. When off, new chats don’t get this tool.",
};
