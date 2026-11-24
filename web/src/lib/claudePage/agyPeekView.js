// Claude 页右侧「Antigravity 对话预览栏」的纯数据部分（不碰网络、不碰 i18n，便于单测）：
//   turnsFromHistory(messages)  /api/agy/session/:id 的 messages → 轮次
//   applyEvent(turns, ev)       SSE 流事件（scope:'agy'）并进轮次，就地改
//   compactItems(turns)         轮次 → 压缩后的显示条目（用户气泡 / 回复正文 / 一行步骤）
//   liveStep(turns)             在跑时末尾那一行说什么
// 轮次形状：{ role:'user', text, mine? } | { role:'assistant', status, blocks:[{ type:'text', text } | { type:'tool', id, label, status }] }

const str = (v) => (typeof v === 'string' ? v : '');
const toolLabel = (t) => str(t?.title).trim() || str(t?.name).trim();

export function turnsFromHistory(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') { out.push({ role: 'user', text: str(m.text).trim() }); continue; }
    const turn = { role: 'assistant', status: m.status === 'error' ? 'error' : m.status === 'interrupted' ? 'interrupted' : 'done', blocks: [] };
    if (Array.isArray(m.blocks) && m.blocks.length) {
      for (const b of m.blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) turn.blocks.push({ type: 'text', text: str(b.text) });
        else if (b.type === 'tool' && b.tool) turn.blocks.push({ type: 'tool', id: str(b.tool.toolCallId), label: toolLabel(b.tool), status: 'completed' });
      }
    } else {
      for (const t of Array.isArray(m.tools) ? m.tools : []) turn.blocks.push({ type: 'tool', id: str(t?.toolCallId), label: toolLabel(t), status: 'completed' });
      if (m.text) turn.blocks.push({ type: 'text', text: str(m.text) });
    }
    out.push(turn);
  }
  return out;
}

function streamingTurn(turns) {
  const last = turns[turns.length - 1];
  if (last && last.role === 'assistant' && last.status === 'streaming') return last;
  const t = { role: 'assistant', status: 'streaming', blocks: [] };
  turns.push(t);
  return turns[turns.length - 1];   // 读回同一个（$state 里是代理）
}

/** 流事件并进轮次。→ true = 这一轮结束了（done / interrupted / error）。 */
export function applyEvent(turns, ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'attach') {
    // 中途挂上在跑的一轮：历史里没有这一轮，用户那句由 attach 带来；之后服务端会把这一轮缓冲的事件重放一遍
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant' && last.status === 'streaming') { last.blocks = []; return false; }
    const ut = str(ev.userText).trim();
    if (ut && !(last && last.role === 'user' && last.text === ut)) turns.push({ role: 'user', text: ut });
    streamingTurn(turns);
    return false;
  }
  if (ev.type === 'text') {
    const d = str(ev.text);
    if (!d) return false;
    const turn = streamingTurn(turns);
    const last = turn.blocks[turn.blocks.length - 1];
    if (last && last.type === 'text') last.text += d; else turn.blocks.push({ type: 'text', text: d });
    return false;
  }
  if (ev.type === 'tool' || ev.type === 'tool-update') {
    const src = ev.tool && typeof ev.tool === 'object' ? ev.tool : ev;
    const id = str(src.toolCallId || ev.toolCallId);
    const turn = streamingTurn(turns);
    const hit = id ? turn.blocks.find((b) => b.type === 'tool' && b.id === id) : null;
    if (hit) {
      const lb = toolLabel(src);
      if (lb) hit.label = lb;
      if (src.status) hit.status = str(src.status);
    } else {
      turn.blocks.push({ type: 'tool', id, label: toolLabel(src), status: str(src.status) || 'in_progress' });
    }
    return false;
  }
  if (ev.type === 'done' || ev.type === 'interrupted' || ev.type === 'error') {
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant' && last.status === 'streaming') last.status = ev.type === 'done' ? 'done' : ev.type;
    return true;
  }
  return false;
}

/**
 * 显示条目：用户一句一个气泡；回复里的正文原样（markdown）；连着的几个工具 / 步骤压成一行灰字（第一步的名字 + 另外几步）。
 * → [{ key, kind:'user', text, mine } | { key, kind:'text', text, first } | { key, kind:'steps', label, more }]
 *   first：这一轮回复的第一条（前面挂「Antigravity」小字）。
 */
export function compactItems(turns) {
  const out = [];
  (Array.isArray(turns) ? turns : []).forEach((turn, ti) => {
    if (turn.role === 'user') { if (turn.text) out.push({ key: `u${ti}`, kind: 'user', text: turn.text, mine: !!turn.mine }); return; }
    let first = true;
    let run = null;
    (turn.blocks || []).forEach((b, bi) => {
      if (b.type === 'tool') {
        if (run) run.more++;
        else { run = { key: `s${ti}-${bi}`, kind: 'steps', label: b.label, more: 0, first }; out.push(run); first = false; }
        return;
      }
      run = null;
      if (!b.text || !b.text.trim()) return;
      out.push({ key: `t${ti}-${bi}`, kind: 'text', text: b.text, first });
      first = false;
    });
  });
  return out;
}

/** 在跑时末尾那一行：正在跑的那一步（工具名）/ 在写回复 / 在想。 */
export function liveStep(turns) {
  const last = Array.isArray(turns) ? turns[turns.length - 1] : null;
  if (!last || last.role !== 'assistant' || last.status !== 'streaming') return { kind: 'think', label: '' };
  for (let i = last.blocks.length - 1; i >= 0; i--) {
    const b = last.blocks[i];
    if (b.type === 'tool' && (b.status === 'in_progress' || b.status === 'pending')) return { kind: 'tool', label: b.label };
    if (b.type === 'text') return { kind: 'write', label: '' };
    if (b.type === 'tool') break;
  }
  return { kind: 'think', label: '' };
}
