import type { SubAgentRequest, SubAgentResult, Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import type { ThinkingLevel } from "../agent/turn.ts";
import { EFFORT_ORDER } from "../catalog.ts";
import { normalizeObjectSchema } from "../agent/schema.ts";
import { ARG_ALIASES } from "./arg-aliases.ts";
import { reportBody, statsLine, subagentMeta } from "../agent/subagent/report.ts";

// Delegation to a sub-agent (see agent/subagent.ts). The tool itself is a thin shell: the session wires the
// runner into ToolContext.runSubAgent (foreground) and ToolContext.subAgents (background, continue, list, stop).
// concurrencySafe — several Agent calls issued in one turn fan out in parallel. Live progress rides on ctx.emit
// (subagent_start/subagent_event/subagent_end tagged with this call's id), and the tool_result's meta keeps a
// summary + tool trail for history (a background agent's meta is updated by the session when it finishes).

function parseEffort(v: unknown): ThinkingLevel | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return (EFFORT_ORDER as string[]).includes(s) ? (s as ThinkingLevel) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const truthy = (v: unknown): boolean => v === true || v === "true";

// 一个子 agent 跑完（前台）：交给父 agent 的正文、卡片记录、交给门禁的改动
function deliver(r: SubAgentResult, prompt: string, schema: boolean): ToolRunResult {
  const meta = { subagent: subagentMeta(r, prompt) };
  const body = reportBody(r, schema);
  const head = `${r.label} (${statsLine(r)})`;
  // worktree 里的改动不在父工作区：不交给父会话的验证门禁与产物收集
  const gateFiles = r.worktree ? [] : r.editedFiles;
  const writer = r.tier === "coder" && gateFiles.length > 0;
  const delivered = schema ? body.ok : Boolean(r.text);
  return {
    ok: body.ok,
    summary: `agent: ${head}${body.tag}`,
    content: [{ t: "text", text: body.text }],
    meta,
    // V5（#20）：coder 改过的文件交给父会话的验证门禁——成没成都算（失败的 coder 也可能写了一半）
    ...(writer ? { editedFiles: gateFiles } : {}),
    ...(writer && delivered ? { createdFiles: gateFiles } : {}),
    // K9（X55）：子 agent 读过网页 / 浏览器内容——它的报告就是外部内容的转述，父会话照样要标上
    ...(r.externalContent ? { externalContent: true } : {}),
  };
}

function launched(id: string, label: string, prompt: string, tier: string): ToolRunResult {
  const startedAt = Date.now();
  return {
    ok: true,
    summary: `agent: ${label} — started in the background (${id})`,
    content: [{
      t: "text",
      text: `Started sub-agent ${id} (${label}) in the background. Its report arrives as a notification when it finishes; ` +
        `Agent(action:"list") shows what is running, Agent(action:"stop", id:"${id}") stops it.`,
    }],
    meta: {
      subagent: {
        id, label, tier, model: "", provider: "", ok: true, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
        trail: [], text: "", prompt: prompt.slice(0, 4_000), startedAt, background: true, status: "running", editedFiles: [],
      },
    },
  };
}

export const agentTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  aliases: ARG_ALIASES.Agent,
  // list / stop 不要 prompt：缺参由这里自己报
  looseRequired: true,
  def: {
    name: "Agent",
    description:
      "Delegate a task to a sub-agent that works in its own context and returns only its final report. " +
      "subagent_type research (default) reads, searches, fetches the web and runs read-only commands; coder can also " +
      "edit files and run commands (only while this session is in auto mode); custom types listed in the system prompt also work. " +
      "Unless context is \"fork\", it sees nothing of this conversation, so the prompt must carry the whole task and say what to return. " +
      "Several Agent calls in one turn run in parallel.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The complete task, including what to return (with id: the follow-up message).",
        },
        subagent_type: {
          type: "string",
          description: "research (default), coder, or a custom type from the system prompt.",
        },
        label: { type: "string", description: "Short display label shown to the user." },
        background: { type: "boolean", description: "Return an agent id right away; its report arrives later as a notification." },
        id: { type: "string", description: "An earlier sub-agent's id: with prompt, continue it in its own context; with action \"stop\", stop it." },
        action: { type: "string", enum: ["list", "stop"], description: "list = this session's sub-agents; stop = stop the one named by id." },
        context: { type: "string", enum: ["fresh", "fork"], description: "fork = start from a copy of this conversation; only its report comes back." },
        isolation: { type: "string", enum: ["worktree"], description: "Give a writing agent its own git worktree and branch; kept for you to merge if it changed anything." },
        schema: {
          type: "object",
          description: "JSON object schema ({type:\"object\", properties, required}); the tool returns the validated object.",
        },
        model: {
          type: "string",
          description: "Catalog model id, or auto:top|hard|normal|light for that tier's pick. Omit to inherit.",
        },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Reasoning effort override." },
        maxTurns: { type: "integer", minimum: 1, maximum: 200, description: "Cap on model turns (default 20 for research, 60 for coder)." },
        permissionMode: { type: "string", enum: ["auto", "read-only"], description: "read-only: a coder proposes changes without touching files." },
      },
      required: ["prompt"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const control = ctx.subAgents;
    const action = str(args.action)?.toLowerCase();
    const id = str(args.id);
    if (action === "list") {
      if (!control) return fail("unavailable", "Sub-agents are not available in this context.");
      return ok("agent: list", control.list());
    }
    if (action === "stop") {
      if (!control) return fail("unavailable", "Sub-agents are not available in this context.");
      if (!id) return fail("missing id", "Give the id of the sub-agent to stop (Agent(action:\"list\") shows them).");
      const r = control.stop(id);
      return r.ok ? ok(`agent: stop ${id}`, r.message) : fail(`agent: stop ${id}`, r.message);
    }
    if (action) return fail("bad action", `Unknown action "${action}". Use "list" or "stop", or omit action to run a task.`);

    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return fail("empty prompt", "Provide a self-contained task prompt.");
    const background = truthy(args.background);

    // 接着用一个已有的子 agent
    if (id) {
      if (!control) return fail("unavailable", "Sub-agents are not available in this context.");
      let out;
      try {
        out = control.resume(id, prompt, { background, signal: ctx.signal, onEvent: ctx.emit, toolId: ctx.callId });
      } catch (e) {
        return fail("sub-agent failed", `Sub-agent threw: ${(e as Error).message}`);
      }
      if ("error" in out) return fail(`agent: ${id}`, out.error);
      if ("queued" in out) return ok(`agent: message to ${id}`, out.queued);
      if (!(out instanceof Promise)) return launched(out.id, out.label, prompt, "research");
      let r: SubAgentResult;
      try {
        r = await (out as Promise<SubAgentResult>);
      } catch (e) {
        return fail("sub-agent failed", `Sub-agent threw: ${(e as Error).message}`);
      }
      return deliver(r, prompt, false);
    }

    if (!ctx.runSubAgent) return fail("unavailable", "Sub-agents are not available in this context.");
    let schema;
    if (args.schema !== undefined && args.schema !== null) {
      schema = normalizeObjectSchema(args.schema);
      if (!schema) {
        return fail("bad schema", "`schema` must be a JSON object schema: {type:\"object\", properties:{…}, required?:[…]}.");
      }
    }
    const type = str(args.subagent_type);
    const label = str(args.label);
    const req: SubAgentRequest = {
      prompt,
      ...(type ? { type } : {}),
      label,
      schema,
      model: str(args.model),
      thinking: parseEffort(args.effort),
      maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
      permissionMode: args.permissionMode === "read-only" ? "read-only" : undefined,
      ...(args.context === "fork" ? { context: "fork" as const } : {}),
      ...(args.isolation === "worktree" ? { isolation: "worktree" as const } : {}),
      onEvent: ctx.emit,
      toolId: ctx.callId,
    };

    if (background) {
      if (!control) return fail("unavailable", "Background sub-agents are not available in this context.");
      const started = control.start(req);
      if ("error" in started) return fail("agent: not started", started.error);
      return launched(started.id, started.label, prompt, type?.toLowerCase() === "coder" ? "coder" : "research");
    }

    let r: SubAgentResult;
    try {
      r = await ctx.runSubAgent({ ...req, signal: ctx.signal });
    } catch (e) {
      return fail("sub-agent failed", `Sub-agent threw: ${(e as Error).message}`);
    }
    return deliver(r, prompt, Boolean(schema));
  },
};
