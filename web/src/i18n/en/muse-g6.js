// 英文界面文案 · muse-g6 （键 = 中文原文，见 lib/i18n.js）
// Muse Bridge 自有文案：问题反馈（报告对话框、设置 → 反馈、出错提示上的「报告问题」）。
export default {
  '反馈': 'Feedback',
  '报告问题': 'Report a problem',
  '报告': 'Report',
  '报告问题或提建议': 'Report a problem or suggest something',
  '一句话就行，不用 GitHub 账号': 'One sentence is enough; no GitHub account needed',
  '出错时自动发送错误报告': 'Send error reports automatically',
  '服务崩溃、接口出错、更新失败时自动报给开发者，不用你动手。同一个错误每个版本只报一次。':
    'When the server crashes, a request fails or an update fails, the developers get a report without you doing anything. Each error is reported once per version.',
  '报告会提交到项目公开的 GitHub Issues（github.com/Wode44398/muse-bridge），安全问题私下发给维护者。只附版本、服务状态和程序自己的报错位置，不含对话、文件、key 和地址；发送前可以先看内容。':
    'Reports go to the project’s public GitHub issues (github.com/Wode44398/muse-bridge); security problems go privately to the maintainers. Only the version, service status and where the program itself failed are attached, never chats, files, keys or addresses. You can see the content before sending.',
  '发过的报告': 'Sent reports',
  '{n} 份在等联网补发': { one: '{n} report waiting to be sent', other: '{n} reports waiting to be sent' },
  '反馈服务暂时连不上，恢复后会自动发出': 'The feedback service can’t be reached right now; they will be sent automatically once it can',
  '私下报告': 'Reported privately',
  '已有人报过，已 +1': 'Already reported; added +1',
  '没改成，稍后再试': 'Couldn’t change it. Try again later',
  '反馈 bug 问题 报错 建议 issue github 报告': 'feedback bug problem error suggestion issue github report',
  '反馈 自动上报 错误报告 崩溃 隐私': 'feedback automatic error report crash privacy',

  '出错提示：{msg}': 'Error shown: {msg}',
  '出问题了': 'Something’s wrong',
  '功能建议': 'Suggestion',
  '安全问题': 'Security issue',
  '出错了，稍后再试': 'Something went wrong. Try again later',
  '草稿过期了，再点一次发送': 'The draft expired. Press Send again',
  '已私下报告': 'Reported privately',
  '别人也遇到了': 'Others ran into this too',
  '已提交，谢谢': 'Sent. Thank you',
  '安全问题不公开，维护者会私下处理。': 'Security issues stay private; the maintainers will handle it privately.',
  '同一个问题已经有人报告过，已经替你在原报告上 +1，修好的时候你会知道。':
    'Someone already reported the same problem, so we added your +1 to it. You’ll hear when it’s fixed.',
  '修好的时候，更新说明里会提到它。': 'When it’s fixed, the update notes will mention it.',
  '在 GitHub 上查看 #{n}': 'View #{n} on GitHub',
  '报告已存好': 'Report saved',
  '现在连不上反馈服务，联网后会自动补发，不用再操作。': 'The feedback service can’t be reached right now. The report will be sent automatically later; you don’t need to do anything.',
  '等不及：自己在 GitHub 上提交': 'Submit it on GitHub yourself now',
  '这次没能提交': 'Couldn’t send this time',
  '改用 GitHub 自己提交（内容已填好）': 'Submit on GitHub instead (already filled in)',
  '说一句发生了什么就行，版本、报错这些会自动附上。': 'Just say what happened. The version and error details are attached automatically.',
  '想要什么功能？': 'What would you like it to do?',
  '比如：点发送之后一直转圈（可以不写）': 'For example: it keeps spinning after I press Send (optional)',
  '查看会发送的内容': 'See what will be sent',
  '安全问题会私下发给维护者，不公开。': 'Security issues go privately to the maintainers and are not made public.',
  '会提交到项目公开的 GitHub Issues，不含对话、文件、key 和地址。': 'This goes to the project’s public GitHub issues. Chats, files, keys and addresses are never included.',

  // 服务端报错（显示处用 tr()）
  '写一句发生了什么吧（这次没有自动收集到报错）': 'Write a sentence about what happened (no errors were collected automatically this time)',
  '草稿过期了，重新写一份吧': 'The draft expired. Please write it again',
  '只有管理员能改': 'Only the admin can change this',
};
