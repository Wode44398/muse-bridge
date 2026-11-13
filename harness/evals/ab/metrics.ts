// 模型档案 P0：每次运行的细项指标。两路来源——
//   ① /api/run 的事件流（tool_end 带 summary：Edit 的 "no match" / "ambiguous" / "not read"、Bash 的 "(exit 1)" / "(timeout)"、
//      循环的 "bad tool arguments" / "unknown tool" / "denied: …"），错误类别按它分；usage 事件带缓存读；done 带收场原因。
//   ② 落盘的会话记录：步数、注入片段（追问、续写、预算耗尽、loop-guard）、仅思考回合、思考字数（估 token）。
// 只出聚合数字，不含正文。分类口径与 scratchpad 里那份转录统计脚本一致（编辑未命中 / 不唯一、先读后写、参数 / JSON、
// 未知工具、权限拒绝、超时、命令非零退出），以后正式服转录与评测能横比。
import { sessionStats } from "../../server/session-health.ts";
import type { PersistedSession } from "../../server/store.ts";

export const ERROR_CATEGORIES = {
  "edit-nomatch": "编辑未命中",
  "edit-ambiguous": "编辑不唯一",
  "read-gate": "先读后写拦截",
  "bad-args": "参数/JSON",
  "unknown-tool": "未知工具/未加载",
  denied: "权限拒绝",
  timeout: "超时",
  "nonzero-exit": "命令非零退出",
  other: "其他",
} as const;
export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

// 一次失败的工具调用归哪一类。summary 是工具自己给的短语（最可靠），text 是结果正文（兜底）。
export function categorize(name: string, summary: string, text: string): ErrorCategory {
  const s = summary.trim();
  // 命令跑起来了：先按 summary 末尾的状态判（输出正文里什么字样都可能有，不能拿来分类）
  if (/^bash(?: job)?\b/i.test(s)) {
    if (/\(timeout\)\s*$|timed out|killed by timeout/i.test(s)) return "timeout";
    if (/\(exit -?\d+\)\s*$|: exit -?\d+\s*$|\(exit -?\d+\)\)?$/i.test(s)) return "nonzero-exit";
  }
  const both = `${s}\n${text}`;
  if (/^no match$|old_string not found/i.test(both)) return "edit-nomatch";
  if (/^ambiguous$|old_string matches \d+ places/im.test(both)) return "edit-ambiguous";
  if (/^not (fully )?read$|You must Read|Read it before overwriting|only partially Read/im.test(both)) return "read-gate";
  if (/bad tool arguments|not valid JSON|Invalid arguments|line-number prefixes|^no-op edit$|^empty match$|problems?, fix them all|is required\b|must be (?:a|an) |needs an exit status that belongs|needs the expression to evaluate/im.test(both)) return "bad-args";
  if (/^unknown tool$|Unknown tool "|tool instructions not loaded/im.test(both)) return "unknown-tool";
  if (/^denied|Denied by permission|^blocked$|Command blocked by|Blocked by secret guard|escapes the (?:sandbox|workspace)|outside (?:the|your) workspace/im.test(both)) return "denied";
  if (/\(timeout\)\s*$|timed out|killed after \d+ms timeout|^timeout$/im.test(both)) return "timeout";
  if (/\(exit -?\d+\)\s*$|\[exit -?[1-9]\d*\]|: exit -?[1-9]\d*\b|exited immediately \(exit/im.test(both)) return "nonzero-exit";
  return name === "Bash" && /exit/i.test(s) ? "nonzero-exit" : "other";
}

export interface StreamTally {
  tools: Record<string, { calls: number; failed: number }>;
  errors: Partial<Record<ErrorCategory, number>>;
  usage: { calls: number; input: number; output: number; cacheRead: number };
  stopReasons: string[]; // 每条消息的 done.stopReason（多轮就有多个）
  streamErrors: number; // error 事件（provider 报错 / 中断）
  loopGuardNotes: number; // 工具结果里带 [Loop guard] 提醒的次数
}

export const newTally = (): StreamTally => ({ tools: {}, errors: {}, usage: { calls: 0, input: 0, output: 0, cacheRead: 0 }, stopReasons: [], streamErrors: 0, loopGuardNotes: 0 });

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.flatMap((b) => (b && (b as { t?: string }).t === "text" ? [String((b as { text?: string }).text ?? "")] : [])).join("\n") : String(content ?? "");

// 只记主循环自己的事件；子 agent 的包在 subagent_event 里，不混进来（它的 token 进用量账本，另算）。
export function observe(t: StreamTally, ev: Record<string, unknown>): void {
  switch (ev.e) {
    case "tool_start": {
      const name = String(ev.name ?? "?");
      (t.tools[name] ??= { calls: 0, failed: 0 }).calls++;
      break;
    }
    case "tool_end": {
      const name = String(ev.name ?? "?");
      const text = textOf(ev.content);
      if (/\[Loop guard\]/.test(text)) t.loopGuardNotes++;
      if (ev.ok === false) {
        // 静默工具没有 tool_start，失败了也照样记一次调用
        const row = (t.tools[name] ??= { calls: 0, failed: 0 });
        if (row.calls === row.failed) row.calls++;
        row.failed++;
        const cat = categorize(name, String(ev.summary ?? ""), text);
        t.errors[cat] = (t.errors[cat] ?? 0) + 1;
      }
      break;
    }
    case "usage":
      t.usage.calls++;
      t.usage.input += Number(ev.inputTokens ?? 0);
      t.usage.output += Number(ev.outputTokens ?? 0);
      t.usage.cacheRead += Number(ev.cacheReadTokens ?? 0);
      break;
    case "done":
      t.stopReasons.push(String(ev.stopReason ?? "end"));
      break;
    case "error":
      t.streamErrors++;
      break;
  }
}

export interface RunMetrics {
  messages: number; // 这一次发了几条用户消息（多轮题 > 1）
  steps: number; // assistant 回合数
  tools: Record<string, { calls: number; failed: number }>;
  toolCalls: number;
  toolFailed: number;
  editCalls: number; // Edit / MultiEdit / Write
  editFailed: number;
  errors: Partial<Record<ErrorCategory, number>>;
  tokens: { input: number; output: number; cacheRead: number; thinkingEst: number; ledger: number };
  budgetExhausted: boolean; // 撞了 maxTurns / deadline（循环注入了 [Budget exhausted]）
  thinkingOnlyTurns: number; // 只有思考、既没正文也没工具调用的回合
  lengthContinues: number; // 截断续写（输出上限 / 半句话停下）
  nudges: Record<string, number>; // 各类门禁追问（verify / submit / audit / plan / budget …）
  loopGuard: number; // loop-guard 叫停 + 工具结果里的 loop-guard 提醒
  denied: number;
  maxIdenticalStreak: number;
  stopReason: string; // 最后一条消息的收场原因
}

// 从事件流计数 + 会话记录算出这一次的全部细项
export function runMetrics(rec: PersistedSession, tally: StreamTally, messages: number): RunMetrics {
  const s = sessionStats(rec).observed;
  // 事件流里没见到的工具（老记录、静默工具）用记录里的计数兜底
  const tools: Record<string, { calls: number; failed: number }> = {};
  for (const name of new Set([...Object.keys(tally.tools), ...Object.keys(s.toolCalls)])) {
    const a = tally.tools[name] ?? { calls: 0, failed: 0 };
    const b = s.toolCalls[name] ?? { calls: 0, failed: 0 };
    tools[name] = { calls: Math.max(a.calls, b.calls), failed: Math.max(a.failed, b.failed) };
  }
  const sum = (pick: (v: { calls: number; failed: number }, k: string) => number) => Object.entries(tools).reduce((n, [k, v]) => n + pick(v, k), 0);
  let thinkingOnly = 0;
  let thinkingChars = 0;
  for (const m of rec.messages) {
    if (m.role !== "assistant") continue;
    const hasText = m.content.some((b) => b.t === "text" && b.text.trim());
    const hasCall = m.content.some((b) => b.t === "tool_call");
    const think = m.content.flatMap((b) => (b.t === "thinking" ? [b.text ?? ""] : [])).join("");
    thinkingChars += think.length;
    if (!hasText && !hasCall && think.trim()) thinkingOnly++;
  }
  const inj = s.injections;
  const nudges = Object.fromEntries(Object.entries(inj).filter(([k]) => k.endsWith("nudge")));
  const ledgerRows = Object.values((rec as { usage?: Record<string, { input?: number; output?: number }> }).usage ?? {});
  const ledger = ledgerRows.reduce((n, r) => n + (r.input ?? 0) + (r.output ?? 0), 0);
  return {
    messages,
    steps: s.assistantTurns,
    tools,
    toolCalls: sum((v) => v.calls),
    toolFailed: sum((v) => v.failed),
    editCalls: sum((v, k) => (EDIT_TOOLS.has(k) ? v.calls : 0)),
    editFailed: sum((v, k) => (EDIT_TOOLS.has(k) ? v.failed : 0)),
    errors: tally.errors,
    tokens: {
      input: s.tokens.input || tally.usage.input,
      output: s.tokens.output || tally.usage.output,
      cacheRead: s.tokens.cacheRead || tally.usage.cacheRead,
      thinkingEst: Math.ceil(thinkingChars / 4),
      ledger: ledger || s.tokens.input + s.tokens.output,
    },
    budgetExhausted: (inj["budget-exhausted"] ?? 0) > 0,
    thinkingOnlyTurns: thinkingOnly,
    lengthContinues: (inj["length-continue"] ?? 0) + (inj["cutoff-continue"] ?? 0),
    nudges,
    loopGuard: (inj["loop-guard"] ?? 0) + tally.loopGuardNotes,
    denied: s.denied,
    maxIdenticalStreak: s.maxIdenticalStreak,
    stopReason: tally.stopReasons.at(-1) ?? (tally.streamErrors ? "error" : "unknown"),
  };
}
