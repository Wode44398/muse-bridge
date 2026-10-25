// 对话内嵌交互图表的段（widget）：直播 widget_* 帧落段。服务端帧见 src/mcp/visualize.mjs makeWidgetStream，
// 段形状与历史重建（src/routes/sessions.mjs → widgetSegFromToolUse）一致：
//   { kind:'widget', id, title, loading:[], code, status, error }
//   status：loading = 还没有代码 | streaming = 代码在长 | ready = 定稿（前端此时才执行脚本）| error = 工具报错
// 渲染：components/claude/WidgetFrame.svelte。
export const WIDGET_EVENTS = new Set(['widget_start', 'widget_delta', 'widget', 'widget_done']);

function findWidget(m, id) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'widget' && s.id === id) return s; }
  return null;
}

// m 是 $state 里的消息（proxy）：push 之后从 m.segments 取回 proxy 再改，否则界面不跟。
export function applyWidgetEvent(m, ev) {
  if (!m || !ev || !ev.id) return;
  let s = findWidget(m, ev.id);
  if (!s) {
    // 收尾帧不新建段：段已被撤回（安全栅门切模型，lib/retract.js）或对账换掉时，别凭空长出一张空卡
    if (ev.type === 'widget_done') return;
    m.segments.push({ kind: 'widget', id: ev.id, title: '', loading: [], code: '', status: 'loading', error: '' });
    s = m.segments[m.segments.length - 1];
  }
  switch (ev.type) {
    case 'widget_delta':
      if (s.status === 'ready' || s.status === 'error') break;
      if (Array.isArray(ev.loading) && ev.loading.length) s.loading = ev.loading.map(String).slice(0, 4);
      if (typeof ev.title === 'string' && ev.title) s.title = ev.title;
      // 只接得上的片段：from 对不上（掉帧 / 重放缺口）就等定稿帧整份覆盖
      if (typeof ev.add === 'string' && ev.add && ev.from === s.code.length) { s.code += ev.add; s.status = 'streaming'; }
      break;
    case 'widget':
      s.code = typeof ev.code === 'string' ? ev.code : s.code;
      if (typeof ev.title === 'string' && ev.title) s.title = ev.title;
      if (Array.isArray(ev.loading) && ev.loading.length) s.loading = ev.loading.map(String).slice(0, 4);
      if (s.status !== 'error') s.status = 'ready';
      break;
    case 'widget_done':
      if (ev.isError) { s.status = 'error'; s.error = String(ev.error || ''); }
      break;
  }
}

// 窄屏（手机浏览器 / 很窄的窗口）：/api/chat 带 narrow:true，服务端让 read_me 按约 380px 宽出图
//（apk 另有 client:'apk' 判定；按 680 宽画的 SVG 缩进 360px 的对话栏，字只剩一半大）。
export function narrowViewport() {
  try { return window.matchMedia('(max-width: 599px)').matches; } catch { return false; }
}
