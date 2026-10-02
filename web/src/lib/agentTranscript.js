// 子 agent 转录的增量拼接：服务端 /api/claude/agent-transcript?from=<offset> 只回新追加的条目，前端把它们
// 接在已有条目后面。合并规则与服务端 routes/claude-tasks.mjs pushEntry 同构——相邻正文并段（段间空一行，
// 并起来超过 TEXT_CAP 就另起一段）、相邻工具并成一组——所以「整读」和「多次增量」拼出来的结果一致。
// 不改入参（入参多半是 $state 代理）：边界那条换成新对象，返回新数组。
export const TEXT_CAP = 20000;
export const MAX_ENTRIES = 2000;

export function mergeEntries(prev, delta) {
  const list = Array.isArray(prev) ? prev.slice() : [];
  for (const en of Array.isArray(delta) ? delta : []) {
    if (!en) continue;
    const last = list[list.length - 1];
    if (en.kind === 'text') {
      const text = String(en.text || '');
      if (last && last.kind === 'text' && last.text.length + text.length + 2 <= TEXT_CAP) {
        list[list.length - 1] = { kind: 'text', text: last.text + (last.text ? '\n\n' : '') + text };
        continue;
      }
      if (list.length < MAX_ENTRIES) list.push({ kind: 'text', text });
    } else if (en.kind === 'tools') {
      const tools = Array.isArray(en.tools) ? en.tools : [];
      if (last && last.kind === 'tools') { list[list.length - 1] = { kind: 'tools', tools: [...last.tools, ...tools] }; continue; }
      if (list.length < MAX_ENTRIES) list.push({ kind: 'tools', tools: tools.slice() });
    }
  }
  return list;
}
