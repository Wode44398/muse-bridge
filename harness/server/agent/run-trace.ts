// 瘦身 P0-1：一段转录里的工具轨迹，一次调用一行「名字(主要参数) → ok / FAILED: 报错开头」。run 之后的记忆沉淀拿它当摘要
// （memory-extract.ts）；整段压缩前也先记一份（context.ts），压缩掉的那部分干过什么，沉淀时还看得到。
import type { Msg } from "./turn.ts";

// 这些工具是流程或记忆本身，不进轨迹
const SKIP_TOOLS = new Set(["Remember", "Recall", "MemoryAudit", "VerificationAudit", "TodoWrite", "ProjectKnowledge"]);

export const isTraceWorthy = (name: string): boolean => !SKIP_TOOLS.has(name);

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export const blocksText = (blocks: Msg["content"]): string =>
  blocks.flatMap((b) => (b.t === "text" ? [b.text] : b.t === "tool_result" ? [blocksText(b.content)] : [])).join("\n");

function argSummary(args: Record<string, unknown>): string {
  for (const key of ["command", "path", "file_path", "url", "query", "pattern", "action", "name", "prompt"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return `${key}=${clip(oneLine(v), 160)}`;
  }
  return clip(oneLine(JSON.stringify(args)), 120);
}

export function traceLines(messages: readonly Msg[]): string[] {
  const results = new Map<string, { ok: boolean; text: string }>();
  for (const m of messages) for (const b of m.content) if (b.t === "tool_result") results.set(b.id, { ok: b.ok, text: blocksText(b.content) });
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.t !== "tool_call" || !isTraceWorthy(b.name)) continue;
      const r = results.get(b.id);
      const tail = !r ? "(no result)" : r.ok ? "ok" : `FAILED: ${clip(oneLine(r.text), 200)}`;
      out.push(`${b.name}(${argSummary((b.args ?? {}) as Record<string, unknown>)}) → ${tail}`);
    }
  }
  return out;
}
