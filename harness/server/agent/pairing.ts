// 工具调用 / 结果的配对：R5 的出口修复（repairToolPairing）与 Q3 的请求检查（pairingProblems）共用这一份判定
// （wellPaired）——「修」和「查」不能是两套口径：检查说没问题的，修复一定不动；修复要动的，检查一定报出来
// （pairing.test.ts 用一组夹具守着这条等价）。从 state.ts 搬过来，state.ts 照旧导出 repairToolPairing。
import type { Block, Msg } from "./turn.ts";

// 各家 API 对 tool_call / tool_result 的配对都是硬约束：每个 call 的结果必须紧跟在下一条（用户）消息的
// 开头，结果只能回应紧挨着的上一条 assistant 的 call。形状一坏就是 400（判为不可重试），而坏形状一旦
// 落盘，之后每轮都重放、会话报废。来源不止一处（旧版压缩切断配对、中断、旧会话残留），所以在发出去之前
// 统一修：缺的结果补一条明说「结果不在了」的失败结果，孤儿与重复的结果丢掉，散在后面几条消息里的结果
// 挪到紧跟 call 的位置。只改发给 provider 的副本，转录本身不动；形状正确时原样返回（不打乱缓存前缀）。
const MISSING_RESULT_TEXT =
  "Result not available: this tool call's result is missing from the transcript (lost to an interruption or an older context compaction). Re-run the call if you still need it.";

const missingResult = (id: string): Block => ({ t: "tool_result", id, ok: false, content: [{ t: "text", text: MISSING_RESULT_TEXT }] });

type ToolResultBlock = Extract<Block, { t: "tool_result" }>;
const resultsOf = (m: Msg): ToolResultBlock[] => m.content.filter((b): b is ToolResultBlock => b.t === "tool_result");
const callIdsOf = (m: Msg): string[] => m.content.flatMap((b) => (b.t === "tool_call" ? [b.id] : []));

function wellPaired(callIds: string[], group: Msg[]): boolean {
  const first = group[0];
  if (!first) return false;
  const results = resultsOf(first);
  if (results.length !== callIds.length) return false;
  const want = new Set(callIds);
  const seen = new Set<string>();
  for (const r of results) {
    if (!want.has(r.id) || seen.has(r.id)) return false;
    seen.add(r.id);
  }
  // 结果必须排在这条消息最前面（Anthropic 的硬约束），后面几条消息里不许再有结果。
  const firstOther = first.content.findIndex((b) => b.t !== "tool_result");
  if (firstOther >= 0 && first.content.slice(firstOther).some((b) => b.t === "tool_result")) return false;
  return group.slice(1).every((m) => resultsOf(m).length === 0);
}

export function repairToolPairing(messages: Msg[]): { messages: Msg[]; repairs: number } {
  let repairs = 0;
  const out: Msg[] = [];
  // 去掉一条消息里的结果块（它们没有可回应的 call）；剩下的内容照留。
  const stripResults = (m: Msg) => {
    const results = resultsOf(m).length;
    if (!results) return out.push(m);
    repairs += results;
    const rest = m.content.filter((b) => b.t !== "tool_result");
    if (rest.length) out.push({ ...m, content: rest });
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") {
      stripResults(m);
      continue;
    }
    out.push(m);
    const callIds = callIdsOf(m);
    const group: Msg[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === "user") group.push(messages[j++]);
    i = j - 1;
    if (!callIds.length) {
      for (const g of group) stripResults(g);
      continue;
    }
    if (wellPaired(callIds, group)) {
      out.push(...group);
      continue;
    }
    const want = new Set(callIds);
    const found = new Map<string, ToolResultBlock>();
    let stray = 0;
    group.forEach((g, gi) => {
      for (const r of resultsOf(g)) {
        if (!want.has(r.id) || found.has(r.id)) stray++;
        else {
          found.set(r.id, r);
          if (gi > 0) stray++; // 挪位也算一次修复
        }
      }
    });
    const missing = callIds.filter((id) => !found.has(id));
    repairs += Math.max(1, stray + missing.length);
    const lead = group.find((g) => resultsOf(g).length > 0);
    out.push({
      role: "user",
      content: callIds.map((id) => found.get(id) ?? missingResult(id)),
      ...(lead?.internal ? { internal: true } : {}),
    });
    for (const g of group) {
      const rest = g.content.filter((b) => b.t !== "tool_result");
      if (rest.length) out.push(rest.length === g.content.length ? g : { ...g, content: rest });
    }
  }
  return repairs ? { messages: out, repairs } : { messages, repairs: 0 };
}

// Q3：同一套判定，只描述、不修改。空数组 ⟺ repairToolPairing 不需要修。
export function pairingProblems(messages: Msg[]): string[] {
  const out: string[] = [];
  const orphans = (m: Msg, at: number) => {
    for (const r of resultsOf(m)) out.push(`message ${at + 1}: tool_result ${r.id} answers no tool_call in the assistant message right before it`);
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") {
      orphans(m, i);
      continue;
    }
    const at = i;
    const callIds = callIdsOf(m);
    const group: Msg[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === "user") group.push(messages[j++]);
    i = j - 1;
    if (!callIds.length) {
      group.forEach((g, k) => orphans(g, at + 1 + k));
      continue;
    }
    if (wellPaired(callIds, group)) continue;
    const before = out.length;
    const first = group[0];
    const firstResults = first ? resultsOf(first) : [];
    const firstIds = firstResults.map((r) => r.id);
    const missing = callIds.filter((id) => !firstIds.includes(id));
    if (missing.length) out.push(`message ${at + 1}: tool_call ${missing.join(", ")} has no result at the start of the next message`);
    const want = new Set(callIds);
    const seen = new Set<string>();
    for (const id of firstIds) {
      if (!want.has(id)) out.push(`message ${at + 2}: tool_result ${id} answers no tool_call in the message before it`);
      else if (seen.has(id)) out.push(`message ${at + 2}: duplicate tool_result ${id}`);
      seen.add(id);
    }
    if (first) {
      const firstOther = first.content.findIndex((b) => b.t !== "tool_result");
      if (firstOther >= 0 && first.content.slice(firstOther).some((b) => b.t === "tool_result")) {
        out.push(`message ${at + 2}: tool results are not all at the start of the message`);
      }
    }
    group.slice(1).forEach((g, k) => {
      if (resultsOf(g).length) out.push(`message ${at + 3 + k}: tool results spread past the message right after the call`);
    });
    if (out.length === before) out.push(`message ${at + 1}: tool calls and results are not paired`);
  }
  return out;
}
