// Q3（X11）：请求不变量校验器。#11 这类「发出去的请求本身不合法」以前只能等 provider 回 400 才发现——400 判为
// 不可重试，坏形状一旦落盘就每轮重放、会话报废。这里在 provider 边界（loop 调 adapter.stream 之前）统一查：
//   - 结构（checkTurn，每次请求各查各的）：工具调用 / 结果双向成对、位置正确（与 R5 的出口修复同一套判定，
//     见 pairing.ts）；tool_call id 非空且整条请求内唯一；没有空消息、空文本块；媒体块到了边界必须带数据
//     （只剩 asset 引用说明 materialize 漏了）；工具名非空且不重复。
//   - 稳定（RunInvariants，同一次 runAgent 之内）：工具定义不变；system 只在改写者报备时变——C4 起只剩压缩成功后的
//     重建走 AgentState.rewriteSystem（切模式、切访问范围改为追加 World State 片段）。没报备的改写会悄悄打断缓存前缀
//     （跨 run 的部分归 Q4 的前缀判定器）。
// 测试里违反即失败：脚本化 provider 默认拿 checkTurn 验每次输入，loopState 收尾核对 loop 记下的违规数。
// 生产上只计数、告警一次，绝不抛——抛进 loop 会被重试吞掉，检查本身也不该挡住用户。
import { createHash } from "node:crypto";
import { pairingProblems } from "./pairing.ts";
import type { Block, Turn } from "./turn.ts";

function blockProblems(b: Block, where: string, out: string[]): void {
  if (b.t === "text" && b.text === "") out.push(`${where}: empty text block`);
  if ((b.t === "image" || b.t === "video" || b.t === "audio") && !b.data && !b.url) {
    out.push(`${where}: ${b.t} block carries no data at the provider boundary${b.asset ? ` (asset ${b.asset} was not materialized)` : ""}`);
  }
  if (b.t === "tool_result") {
    if (!b.id) out.push(`${where}: tool_result with an empty id`);
    b.content.forEach((c, k) => blockProblems(c, `${where} > block ${k + 1}`, out));
  }
}

export function checkTurn(turn: Turn): string[] {
  const out: string[] = [];
  if (!turn.messages.length) out.push("request has no messages");
  const callIds = new Set<string>();
  turn.messages.forEach((m, i) => {
    const at = `message ${i + 1}`;
    if (!m.content.length) out.push(`${at}: empty ${m.role} message`);
    m.content.forEach((b, k) => {
      if (b.t === "tool_call") {
        if (m.role !== "assistant") out.push(`${at}: tool_call ${b.id || b.name} inside a user message`);
        if (!b.id) out.push(`${at}: tool_call ${b.name} with an empty id`);
        else if (callIds.has(b.id)) out.push(`${at}: tool_call id ${b.id} is used more than once in the request`);
        else callIds.add(b.id);
      }
      if (b.t === "tool_result" && m.role !== "user") out.push(`${at}: tool_result ${b.id} inside an assistant message`);
      blockProblems(b, `${at} block ${k + 1}`, out);
    });
  });
  out.push(...pairingProblems(turn.messages));
  const names = new Set<string>();
  for (const tool of turn.tools) {
    if (!tool.name) out.push("tool definition with an empty name");
    else if (names.has(tool.name)) out.push(`tool ${tool.name} is defined more than once`);
    else names.add(tool.name);
  }
  return out;
}

const digest = (v: unknown): string => createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

// 一次 runAgent 一个实例。systemRewrites 是 AgentState 上「报备过的 system 改写」计数。
export class RunInvariants {
  private last: { system: string; tools: string; rewrites: number } | null = null;

  check(turn: Turn, systemRewrites: number): string[] {
    const out = checkTurn(turn);
    const now = { system: digest(turn.system), tools: digest(turn.tools), rewrites: systemRewrites };
    if (this.last) {
      if (now.system !== this.last.system && now.rewrites === this.last.rewrites) {
        out.push("system prompt changed within the run without a declared rewrite (only the post-compaction rebuild may rewrite it mid-run)");
      }
      if (now.tools !== this.last.tools) out.push("tool definitions changed within the run");
    }
    this.last = now;
    return out;
  }
}
