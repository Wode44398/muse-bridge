// 英文界面文案 · 让 Claude 诊断并上报 bug（lib/toast.svelte.js 的「问 Claude」、lib/agentUi.js 的 askClaudeAboutError）
// 键 = 中文原文，见 lib/i18n.js
export default {
  '问 Claude': 'Ask Claude',
  '我刚在「{where}」看到这个报错：「{err}」。帮我看看是不是 bridge 出 bug 了；是的话跟我确认后上报。':
    'I just saw this error in “{where}”: “{err}”. Can you check whether it’s a bug in bridge? If it is, confirm with me and then report it.',
};
