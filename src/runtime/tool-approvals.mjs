// 需要用户逐次批准的 bridge 自有工具调用 + 「审批卡已经批过这一次」的台账（2026-10-21 整合）。
//
// 官方 Claude Desktop 的 ccd_pr 工具里，开长期授权的那几样（Tp 集合）走权限审批：手动 / 接受编辑 / 计划模式弹卡，
// auto 模式由分类器定、可能免问，bypass 模式不问（A2 §1.9）。bridge 的对应物：
//   · mcp__pr__set_auto_merge { enabled: true }   —— 就绪后自动合进基线分支
//   · mcp__pr__set_monitor   { auto_fix: true }   —— 让 CI / 第三方评审意见能叫醒会话去改代码并推送
// 这两样不进 permissions.mjs 的 ownMcp 免审，走同一张逐次审批卡（不给「始终允许」：每次都要人点头）。
// 批准后按 tool_use_id 记一笔；工具 handler 从 extra._meta['claudecode/toolUseId'] 拿到同一个 id，takeToolApproval
// 命中 = 用户已经在审批卡上允许过，不再弹兜底确认。没命中（auto 分类器放行 / bypass / 旧路径）时工具自己用问答卡兜底
// （pr-tools.mjs confirmByUser）——比官方多问一次，是有意的：这类授权的诱因常是文件 / 网页 / GitHub 评论里的提示注入。

const APPROVAL_TTL_MS = 10 * 60_000;
const approvals = new Map();   // toolUseId -> { name, ownerKey, at }

/** 这次调用是否要用户逐次批准（只看 bridge 自有工具；入参按开启方向判，关掉永远不用问）。 */
export function needsUserApproval(name, input) {
  if (name === 'mcp__pr__set_auto_merge') return !!(input && input.enabled === true);
  if (name === 'mcp__pr__set_monitor') return !!(input && input.auto_fix === true);
  return false;
}

/** 审批卡批准了这一次调用（permissions.mjs permCard 调）。 */
export function noteToolApproval(toolUseId, name, ownerKey) {
  if (!toolUseId || !name) return;
  const now = Date.now();
  for (const [k, v] of approvals) if (now - v.at > APPROVAL_TTL_MS) approvals.delete(k);
  approvals.set(String(toolUseId), { name: String(name), ownerKey: ownerKey || null, at: now });
}

/** 工具 handler 取一次：同一个 tool_use_id、同一个工具、同一个身份、没过期才算；取过即作废（一次批准只管一次调用）。 */
export function takeToolApproval(toolUseId, name, ownerKey) {
  if (!toolUseId) return false;
  const k = String(toolUseId);
  const v = approvals.get(k);
  if (!v) return false;
  approvals.delete(k);
  if (v.name !== name) return false;
  if ((v.ownerKey || null) !== (ownerKey || null)) return false;
  return Date.now() - v.at <= APPROVAL_TTL_MS;
}

export function _resetToolApprovals() { approvals.clear(); }
