// 工具结果卡片的标记（插件接口四期）：插件工具 render:'card' 时，结果第二段文字是 CARD_MARK + JSON（plugins/claude-tools.mjs toResult）。
// 直播（agents/claude.mjs 的 tool_done）与历史重建（routes/sessions.mjs）都用 cardOf 从 tool_result 里取出卡片对象，带给前端画。
// 单独一个小文件：sessions 路由不用为此引插件内核。
export const CARD_MARK = '[[bridge-card]]';

/** tool_result 块 → 卡片对象（没有 / 坏了回 null）。 */
export function cardOf(blk) {
  const content = Array.isArray(blk?.content) ? blk.content : [];
  for (const c of content) {
    const t = c && c.type === 'text' && typeof c.text === 'string' ? c.text : '';
    if (!t.startsWith(CARD_MARK)) continue;
    try {
      const j = JSON.parse(t.slice(CARD_MARK.length));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch { return null; }
  }
  return null;
}
