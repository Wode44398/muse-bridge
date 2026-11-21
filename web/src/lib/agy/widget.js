// Antigravity 对话里的内嵌图表：bridge 工具中枢的 visualize_show_widget（服务端 modules/agy/server/mcp/hub.mjs）。
// agy 的工具事件带完整参数（rawInput），直接从工具调用记录拼出 WidgetFrame 的段（形状见 lib/widgetSeg.js）。

const WIDGET_NAME_RE = /(?:^|_)show_widget$/i;

export function isWidgetTool(tool) {
  return !!tool && WIDGET_NAME_RE.test(String(tool.name || '')) && typeof tool.args?.widget_code === 'string';
}

export function widgetSegOf(tool) {
  if (!isWidgetTool(tool)) return null;
  const a = tool.args;
  const st = String(tool.status || '');
  // 用户在审批卡上拒绝了（或被取消）：这张图不算画出来过，不留在对话里
  if (st === 'cancelled' || tool.approvalState === 'denied') return null;
  const failed = st === 'failed' || st === 'error';
  return {
    kind: 'widget',
    id: String(tool.toolCallId || a.title || 'widget'),
    title: typeof a.title === 'string' ? a.title : '',
    loading: Array.isArray(a.loading_messages) ? a.loading_messages.map(String).slice(0, 4) : [],
    code: a.widget_code,
    // 参数到齐就能画；工具报错（关了图表开关等）照 Claude 的样子出错误卡
    status: failed ? 'error' : (st === 'completed' || a.widget_code ? 'ready' : 'loading'),
    error: failed ? String(tool.output || '').slice(0, 300) : '',
  };
}
