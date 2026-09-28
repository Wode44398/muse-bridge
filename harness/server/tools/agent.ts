import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import type { ThinkingLevel } from "../agent/turn.ts";
import { normalizeObjectSchema } from "../agent/schema.ts";
import { SUBAGENT_REPORT_NOTE } from "./untrusted.ts";

// Delegation to a sub-agent (see agent/subagent.ts). The tool itself is a thin
// shell: the session wires the actual runner into ToolContext.runSubAgent.
// concurrencySafe — several Agent calls issued in one turn fan out in parallel,
// each with its own fresh context and adapter. Live progress rides on
// ctx.emit (subagent_start/subagent_event/subagent_end tagged with this call's
// id), and the tool_result's meta keeps a summary + tool trail for history.

const RESULT_TEXT_CAP = 60_000;
const META_TEXT_CAP = 4_000;
const META_RESULT_CAP = 20_000;
const META_PROMPT_CAP = 4_000;

const EFFORTS: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
function parseEffort(v: unknown): ThinkingLevel | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "xhigh") return "max";
  return (EFFORTS as string[]).includes(s) ? (s as ThinkingLevel) : undefined;
}

export const agentTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "Agent",
    description:
      "Delegate a self-contained task to a sub-agent with its own fresh context; it works autonomously and " +
      "hands back only its conclusions, so your context gets results instead of file dumps. Two tiers: " +
      "tools:\"research\" (default) can Read/Grep/Glob and fetch the web but cannot edit or run anything — " +
      "use it when answering would mean reading MANY files (locating an implementation, surveying usages, " +
      "mapping how modules interact). tools:\"coder\" can also Write/Edit/Bash — use it for a well-specified, " +
      "self-contained implementation slice you want done in parallel with other work (it verifies its own " +
      "change; only available while this session is in auto mode). The prompt MUST be self-contained (the " +
      "sub-agent sees nothing of this conversation) and say exactly what to return. Pass `schema` (a JSON object " +
      "schema) to get a validated JSON object back instead of prose — the sub-agent must submit through a " +
      "SubmitResult tool that enforces it. `model`/`effort` override this session's; omit to inherit. Issue " +
      "several Agent calls in ONE turn to run them in parallel. For a single quick lookup you already know how " +
      "to find, use Grep/Read directly instead.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The complete task, self-contained, including what output you expect back (e.g. \"file:line list of every caller of X and what each passes for arg Y\").",
        },
        tools: {
          type: "string",
          enum: ["research", "coder"],
          description: "Tool tier. research = read-only exploration (default). coder = may edit files and run commands.",
        },
        label: {
          type: "string",
          description: "Short display label for this sub-agent (shown to the user). Defaults to the prompt's first line.",
        },
        schema: {
          type: "object",
          description:
            "JSON object schema for a structured result ({type:\"object\", properties:{…}, required:[…]}). When given, the tool returns the validated object as JSON.",
        },
        model: {
          type: "string",
          description: "Catalog model id to run this sub-agent on (e.g. a cheaper model for mechanical work). Omit to inherit this session's model.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "max"],
          description: "Reasoning effort override. Omit to inherit this session's effort.",
        },
        maxTurns: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Cap on model turns (default 20 for research, 60 for coder).",
        },
        permissionMode: {
          type: "string",
          enum: ["auto", "read-only"],
          description: "Coder tier only: run it read-only to get a plan/diff proposal without touching files.",
        },
      },
      required: ["prompt"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return fail("empty prompt", "Provide a self-contained task prompt.");
    if (!ctx.runSubAgent) {
      return fail("unavailable", "Sub-agents are not available in this context.");
    }
    let schema;
    if (args.schema !== undefined && args.schema !== null) {
      schema = normalizeObjectSchema(args.schema);
      if (!schema) {
        return fail("bad schema", "`schema` must be a JSON object schema: {type:\"object\", properties:{…}, required?:[…]}.");
      }
    }
    const tier = args.tools === "coder" ? "coder" : "research";
    const label = typeof args.label === "string" ? args.label.trim() : "";

    let r;
    try {
      r = await ctx.runSubAgent({
        prompt,
        tier,
        label: label || undefined,
        schema,
        model: typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined,
        thinking: parseEffort(args.effort),
        maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
        permissionMode: args.permissionMode === "read-only" ? "read-only" : undefined,
        signal: ctx.signal,
        onEvent: ctx.emit,
        toolId: ctx.callId,
      });
    } catch (e) {
      return fail("sub-agent failed", `Sub-agent threw: ${(e as Error).message}`);
    }

    const stats = `${r.turns} turns, ${r.toolCalls} tool calls, ${r.inputTokens + r.outputTokens} tokens, ${r.model}`;
    let resultJson: string | undefined;
    if (r.result !== undefined) {
      try { resultJson = JSON.stringify(r.result, null, 2); } catch { resultJson = String(r.result); }
    }
    const meta = {
      subagent: {
        id: r.id,
        label: r.label,
        tier: r.tier,
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
        ...(resultJson && resultJson.length <= META_RESULT_CAP ? { result: r.result } : {}),
        // Task panel: the prompt bubble and timers of the transcript view after a reload.
        prompt: prompt.slice(0, META_PROMPT_CAP),
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        editedFiles: r.editedFiles,
      },
    };
    const head = `${r.label} (${stats})`;
    // V5（#20）：coder 改过的文件交给父会话的验证门禁——成没成都算（失败的 coder 也可能写了一半）
    const edited = {
      ...(tier === "coder" && r.editedFiles.length ? { editedFiles: r.editedFiles } : {}),
      // K9（X55）：子 agent 读过网页 / 浏览器内容——它的报告就是外部内容的转述，父会话照样要标上
      ...(r.externalContent ? { externalContent: true } : {}),
    };
    // O3（K62）：交接单——没做完就明说为什么、下一步怎么办（以前一律「写具体点再试」，被限流时是误导）
    const handoff = r.stopReason && r.stopReason !== "completed"
      ? `[The sub-agent did not finish (${r.stopReason}${r.error ? `: ${r.error}` : ""}). Next step: ${r.nextStep ?? "decide whether to retry or do it yourself."}]`
      : "";

    if (schema) {
      if (!r.ok || resultJson === undefined) {
        return {
          ok: false,
          summary: `agent: ${head} — no structured result`,
          content: [{
            t: "text",
            text:
              `Sub-agent did not deliver a valid structured result${r.error ? ` (${r.error})` : ""}.` +
              (r.text ? `\n\nIts last message was:\n${r.text.slice(0, 4000)}` : "") +
              (handoff ? `\n\n${handoff}` : "\n\nConsider a simpler schema or a more specific prompt."),
          }],
          meta,
          ...edited,
        };
      }
      const body = resultJson.length > RESULT_TEXT_CAP ? resultJson.slice(0, RESULT_TEXT_CAP) + "\n…[truncated]" : resultJson;
      return {
        ok: true,
        summary: `agent: ${head}`,
        content: [{ t: "text", text: body }],
        meta,
        createdFiles: tier === "coder" ? r.editedFiles : undefined,
        ...edited,
      };
    }

    if (!r.text) {
      return {
        ok: false,
        summary: `agent: ${head} — no answer`,
        content: [{
          t: "text",
          text:
            handoff
              ? `Sub-agent produced no answer. ${handoff}`
              : `Sub-agent produced no answer${r.error ? ` (error: ${r.error})` : ""}. ` +
                "Consider retrying with a more specific, self-contained prompt, or do the lookup directly with Grep/Read.",
        }],
        meta,
        ...edited,
      };
    }
    const changed = tier === "coder" && r.editedFiles.length
      ? `\n\n[Files this sub-agent changed: ${r.editedFiles.join(", ")}]`
      : "";
    const text =
      `${SUBAGENT_REPORT_NOTE}\n` +
      (r.text.length > RESULT_TEXT_CAP ? r.text.slice(0, RESULT_TEXT_CAP) + "\n…[truncated]" : r.text) +
      changed +
      (handoff
        ? `\n\n${handoff}`
        : r.error
          ? `\n\n[Note: the sub-agent hit an error after the work above: ${r.error}. Treat the findings as possibly incomplete.]`
          : "");
    return {
      // O3：没做完（预算用尽 / 被限流到截止 / provider 出错）不报成功——上面是它做到一半的笔记
      ok: !handoff,
      summary: `agent: ${head}${handoff ? ` — did not finish (${r.stopReason})` : ""}`,
      content: [{ t: "text", text }],
      meta,
      createdFiles: tier === "coder" ? r.editedFiles : undefined,
      ...edited,
    };
  },
};
