// 从 transcript（jsonl）里读事实。

import { readFileSync } from 'node:fs';

// 本轮真实用户消息在 transcript 里的 uuid（检查点回滚锚点）：turn 结束后从尾部反扫。
// 不能信 SDK 流里的 user 消息（多为 tool_result 包装，uuid 对不上快照记录）；jsonl 才是真相。
export function lastRealUserUuid(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (!o || o.type !== 'user' || !o.uuid || o.isMeta || o.isSidechain) continue;
      const c = o.message && o.message.content;
      const hasText = typeof c === 'string' ? !!c.trim() : Array.isArray(c) && c.some((b) => b && b.type === 'text');
      // 后台任务完成时 CLI 注入的 <task-notification> 是普通 user 记录（非 isMeta）——
      // 它不是真实用户消息，回滚锚点要跳过（悬停续轮后本轮 transcript 尾部会有它们）。
      const rawText = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') : '');
      if (/^\s*<(?:task|agent|bash)-notification>/.test(rawText)) continue;   // 变体与 tool-summary.mjs / sessions.mjs 的过滤同口径
      // 软停止（interrupt）时 CLI 自己写的打断标记，也不是用户说的话（sessions.mjs SDK_NOISE 同口径）。
      if (/^\s*\[Request interrupted by user/.test(rawText)) continue;
      if (hasText && !(Array.isArray(c) && c.some((b) => b && b.type === 'tool_result'))) return o.uuid;
    }
  } catch {}
  return null;
}
