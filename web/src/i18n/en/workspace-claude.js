// 插件工作区外观的 Claude 页画法：侧栏共用项目块、连接器方块的说明、对方会话那一组、确认框、撤销条、目录芯片后的「与 X 共用」、
// 右侧的 Antigravity 对话预览栏
// 出现在 components/claude/workspace/、claude/page/ClaudeSidebar（会话行「谁开的」、行尾星芒）、lib/claudePage/agyPeek
export default {
  '和 {agent} 共用这个文件夹': 'Shared with {agent}',
  '{agent} 在这里有 {n} 个对话，{m} 个在跑': '{agent} has {n} chats here, {m} running',
  '{agent} 在这里有 {n} 个对话': '{agent} has {n} chats here',
  '共用的文件夹': 'Shared folder',
  '在跑': 'Running',
  '{agent} 开的会话': 'Started by {agent}',
  '正在工作': 'Working',
  '与 {agent} 共用': 'Shared with {agent}',
  // 右侧的 Antigravity 对话预览栏（AgyPeek）
  'Antigravity 的对话': 'Antigravity chat',
  'Antigravity 的对话 · {folder}': 'Antigravity chat · {folder}',
  '在 Antigravity 打开': 'Open in Antigravity',
  '这个对话还没有内容。': 'This chat is empty.',
  '你 · 从 Claude 页发': 'You · sent from Claude',
  '一步操作': 'A step',
  '另 {n} 步': '+{n} more',
  'Antigravity 在跑：{step}': 'Antigravity running: {step}',
  'Antigravity 在跑：在写回复': 'Antigravity running: writing a reply',
  'Antigravity 在跑：在想': 'Antigravity running: thinking',
  '发给这个 Antigravity 对话…': 'Message this Antigravity chat…',
  '以你的名义发出': 'Sent as you',
  '这一轮正在收尾，这句排在后面，收尾后发出': 'This turn is wrapping up; your message is queued and will go out next',
  '到 {name} 的这个文件夹': 'Go to this folder in {name}',
};
