// 子 agent 的结果怎么交给父会话：工具结果的正文（前台）与后台收场通知的正文同一套写法，界面卡片的落盘摘要（tool_result.meta.subagent）
// 也在这里拼——后台子 agent 跑完时会话层拿它更新发起那次调用的卡片记录。
import type { SubAgentResult } from "../../tools/types.ts";
import { SUBAGENT_REPORT_NOTE } from "../../tools/untrusted.ts";

export const RESULT_TEXT_CAP = 60_000;
const META_TEXT_CAP = 4_000;
const META_RESULT_CAP = 20_000;
const META_PROMPT_CAP = 4_000;

export function resultJson(r: SubAgentResult): string | undefined {
  if (r.result === undefined) return undefined;
  try {
    return JSON.stringify(r.result, null, 2);
  } catch {
    return String(r.result);
  }
}

/** 卡片的落盘摘要。running = 后台子 agent 刚起、还没有结果。 */
export function subagentMeta(r: SubAgentResult, prompt: string, extra: { background?: boolean; running?: boolean } = {}): Record<string, unknown> {
  const json = resultJson(r);
  return {
    id: r.id,
    label: r.label,
    tier: r.tier,
    ...(r.type ? { type: r.type } : {}),
    model: r.model,
    provider: r.provider,
    ok: r.ok,
    error: r.error,
    stopReason: r.stopReason,
    turns: r.turns,
    toolCalls: r.toolCalls,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    trail: r.trail,
    text: r.text.slice(0, META_TEXT_CAP),
    ...(json && json.length <= META_RESULT_CAP ? { result: r.result } : {}),
    // Task panel: the prompt bubble and timers of the transcript view after a reload.
    prompt: prompt.slice(0, META_PROMPT_CAP),
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    editedFiles: r.editedFiles,
    ...(extra.background ? { background: true } : {}),
    ...(extra.running ? { status: "running" } : {}),
    ...(r.worktree ? { worktree: { path: r.worktree.path, branch: r.worktree.branch, kept: r.worktree.kept } } : {}),
  };
}

// O3（K62）：交接单——没做完就明说为什么、下一步怎么办
export function handoffLine(r: SubAgentResult): string {
  return r.stopReason && r.stopReason !== "completed"
    ? `[The sub-agent did not finish (${r.stopReason}${r.error ? `: ${r.error}` : ""}). Next step: ${r.nextStep ?? "decide whether to retry or do it yourself."}]`
    : "";
}

function tail(r: SubAgentResult): string {
  const parts: string[] = [];
  if (r.worktree) parts.push(`[Worktree] ${r.worktree.summary}`);
  else if (r.tier === "coder" && r.editedFiles.length) parts.push(`[Files this sub-agent changed: ${r.editedFiles.join(", ")}]`);
  if (r.notes?.length) parts.push(...r.notes.map((n) => `[Note: ${n}]`));
  if (r.resumable) parts.push(`[Agent id ${r.id}: Agent(id:"${r.id}", prompt:"…") continues it with its context.]`);
  return parts.length ? `\n\n${parts.join("\n")}` : "";
}

/** 交给父 agent 的正文与成败。schema = 调用方要的是结构化结果。 */
export function reportBody(r: SubAgentResult, schema: boolean): { ok: boolean; text: string; tag: string } {
  const handoff = handoffLine(r);
  const json = resultJson(r);
  if (schema) {
    if (!r.ok || json === undefined) {
      return {
        ok: false,
        tag: " — no structured result",
        text:
          `Sub-agent did not deliver a valid structured result${r.error ? ` (${r.error})` : ""}.` +
          (r.text ? `\n\nIts last message was:\n${r.text.slice(0, 4000)}` : "") +
          (handoff ? `\n\n${handoff}` : "\n\nConsider a simpler schema or a more specific prompt.") +
          tail(r),
      };
    }
    const body = json.length > RESULT_TEXT_CAP ? json.slice(0, RESULT_TEXT_CAP) + "\n…[truncated]" : json;
    return { ok: true, tag: "", text: body + tail(r) };
  }
  if (!r.text) {
    return {
      ok: false,
      tag: " — no answer",
      text:
        (handoff
          ? `Sub-agent produced no answer. ${handoff}`
          : `Sub-agent produced no answer${r.error ? ` (error: ${r.error})` : ""}. ` +
            "Consider retrying with a more specific, self-contained prompt, or do the lookup directly with Grep/Read.") + tail(r),
    };
  }
  const text =
    `${SUBAGENT_REPORT_NOTE}\n` +
    (r.text.length > RESULT_TEXT_CAP ? r.text.slice(0, RESULT_TEXT_CAP) + "\n…[truncated]" : r.text) +
    (handoff
      ? `\n\n${handoff}`
      : r.error
        ? `\n\n[Note: the sub-agent hit an error after the work above: ${r.error}. Treat the findings as possibly incomplete.]`
        : "") +
    tail(r);
  // O3：没做完（预算用尽 / 被限流到截止 / provider 出错）不报成功——上面是它做到一半的笔记
  return { ok: !handoff, tag: handoff ? ` — did not finish (${r.stopReason})` : "", text };
}

export const statsLine = (r: SubAgentResult): string =>
  `${r.turns} turns, ${r.toolCalls} tool calls, ${r.inputTokens + r.outputTokens} tokens, ${r.model}`;
