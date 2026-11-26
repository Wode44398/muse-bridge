// 工具说明、工具返回、转给 agy 的会话消息都是照 Claude 写的（mcp__<服务>__<工具>、AskUserQuestion……），
// 原样给 agy，模型会去找不存在的工具。这里统一改成 agy 这边实际的名字（模型看到的是 mcp_bridge_<下面的名字>）。

const WORDING = [
  [/[；，]?另开并行会话优先用 `?mcp__sessions__start_session`?[；。]?/g, (m) => (m.endsWith('。') ? '。' : m.startsWith('；') && m.endsWith('；') ? '；' : '')],
  [/操作手机用 `?mcp__phoneControl__\*`?(，读写手机文件用 `?mcp__phone__\*`?)?(，这两组只在可用时才有)?/g, '操作手机用 phone_control，读写手机上已授权的文件用 phone_files（这两样只在可用时才有）'],
  [/mcp__phoneControl__phone_([a-z_]+)/g, 'phone_control(action:"$1")'],
  [/mcp__phoneControl__\*/g, 'phone_control'],
  [/mcp__sessions__([a-z_]+)/g, '$1'],
  [/mcp__pr__(get_status|bind_pr|unbind_pr|set_monitor|set_auto_merge|sync_with_base_branch)/g, (m, n) => PR_NAMES[n]],
  [/mcp__project__memory_([a-z]+)/g, 'project_memory(action:"$1")'],
  [/mcp__media__generate_(image|video|speech|music)/g, 'media_$1'],
  [/mcp__media__\*/g, 'media_image / media_video / media_speech / media_music'],
  [/mcp__media__/g, 'media_'],
  [/mcp__device__/g, 'device_'],
  [/mcp__visualize__/g, 'visualize_'],
  [/mcp__bridge__(manual|call)/g, '$1'],
  [/mcp__(browser|terminal|workspace)__\1/g, '$1'],
  [/mcp__(browser|terminal|workspace)__\*/g, '$1'],
  [/mcp__phone__(list|read|write|scan|delete)/g, 'phone_files(action:"$1")'],
  [/mcp__phone__/g, 'phone_'],
];
// 拉取请求组在 agy 这边的名字（groups/pr.mjs 的六样，对 agy 合并成一个 pr 工具，见 catalog.mjs）
export const PR_NAMES = Object.freeze({
  get_status: 'pr(action:"status")', bind_pr: 'pr(action:"bind")', unbind_pr: 'pr(action:"unbind")',
  set_monitor: 'pr(action:"set_monitor")', set_auto_merge: 'pr(action:"set_auto_merge")', sync_with_base_branch: 'pr(action:"sync_base")',
});
// 不带 mcp__ 前缀、但同样只在 Claude 分页成立的说法（工具名、界面位置）
const WORDING_PLAIN = [
  [/先用 AskUserQuestion 确认/g, '先在对话里问用户、得到同意再做'],
  [/用 AskUserQuestion 确认/g, '在对话里问用户确认'],
  [/prefer your own Bash tool/g, 'prefer your own command tool'],
  // 侧边浏览器「用户现在看不到」的提示：Antigravity 页没有 Ctrl+Shift+B，手机上也没有眼睛键
  [/桌面端按 Ctrl\+Shift\+B 或点工作台的浏览器卡片，手机上点顶栏的眼睛键/g, '点右上角侧边工作区里的「浏览器」卡片（手机上先点顶栏的工作区按钮）'],
];

/** 把照 Claude 写的工具名改成 agy 这边实际的名字（工具说明、返回文字都过一遍）。 */
export function agyWording(text) {
  let s = String(text ?? '');
  if (s.includes('mcp__')) for (const [re, to] of WORDING) s = s.replace(re, to);
  for (const [re, to] of WORDING_PLAIN) s = s.replace(re, to);
  return s;
}

export function rewordResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: result.content.map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? { ...c, text: agyWording(c.text) } : c)) };
}
