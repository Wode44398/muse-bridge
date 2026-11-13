// dimensio 英文界面文案 · hx-sessmgmt：会话管理——稍后发送的队列、Tab 输入建议、会话菜单（重命名 / 归档）、已归档区（键 = 中文原文，见 lib/i18n.ts）
export default {
  // ── 稍后发送（QueueTray / ComposerExtras / lib/sessmgmt）──
  "稍后发送": "Send later",
  "稍后发送：等这一轮结束后再发": "Send later: queue it until this turn ends",
  "稍后发送：等这一轮结束后再发（Ctrl+回车）": "Send later: queue it until this turn ends (Ctrl+Enter)",
  "稍后发送：等这一轮结束后再发（⌘+回车）": "Send later: queue it until this turn ends (⌘+Enter)",
  "这一轮结束后发出": "Sends when this turn ends",
  "{n} 条排队，这一轮结束后合并发出": {
    one: "{n} queued message, sent when this turn ends",
    other: "{n} queued messages, sent together when this turn ends",
  },
  "下一条：{text}": "Next: {text}",
  "全部清除": "Clear all",
  "移除这条": "Remove this message",
  "拿回输入框改": "Move back to the input box to edit",
  "立即发送": "Send now",
  "现在就作为插话发出，它会在下一步读到": "Send it now as a steer; the agent reads it at the next step",
  "排队的消息太多了，先等这一轮跑完": "Too many queued messages. Wait for this turn to finish.",
  "没排上队：{reason}": "Couldn’t queue it: {reason}",
  "操作没成功：{reason}": "That didn’t work: {reason}",
  "这条已经发出去了": "That message was already sent",
  "现在发不出去，稍后再试": "Can’t send right now. Try again shortly.",

  // ── Tab 输入建议 ──
  "填入": "Fill",
  "填入建议：{text}": "Fill in suggestion: {text}",
  "把建议填进输入框": "Put the suggestion in the input box",

  // ── 会话菜单与归档（SessionMenu / ArchivedSection / Sidebar）──
  "对话操作": "Chat actions",
  "对话标题": "Chat title",
  "改名没成功：{reason}": "Couldn’t rename: {reason}",
  "归档": "Archive",
  "取消归档": "Unarchive",
  "放回项目列表": "Put it back in the project list",
  "不在列表里显示，可在侧栏底部「已归档」里找回": "Hide it from the list. Find it under Archived at the bottom of the sidebar.",
  "已归档，可在侧栏底部「已归档」里找回": "Archived. Find it under Archived at the bottom of the sidebar.",
  "归档没成功：{reason}": "Couldn’t archive: {reason}",
  "这个对话还在运行、在等你处理或有排队的消息，先不归档": "This chat is running, waiting for you, or has queued messages, so it wasn’t archived",
  "已归档": "Archived",
  "取消归档，放回项目列表": "Unarchive and put it back in the project list",
  "没有匹配的已归档对话": "No matching archived chats",
  "更多": "More",
  "更多操作": "More actions",
};
