import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";

// Lifecycle checkpoint: a normal finish and a lossy full compaction both wait
// until the model explicitly audits whether this run produced durable knowledge.
export const memoryAuditTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "MemoryAudit",
    description:
      "Complete the mandatory memory audit before finishing a task or before lossy context compaction. " +
      "First inspect the memory index and use Remember to update/create/delete durable notes. " +
      "Then submit decision:'updated' if Remember changed memory, otherwise decision:'none' with a concrete reason. " +
      "This checkpoint does not save knowledge by itself.",
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["updated", "none"],
          description: "updated after a successful Remember change; none when no durable fact was produced.",
        },
        reason: {
          type: "string",
          description: "Concrete justification describing what was saved or why no durable memory is warranted.",
        },
      },
      required: ["decision", "reason"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const decision = String(args.decision ?? "") as "updated" | "none";
    const reason = String(args.reason ?? "").replace(/\s+/g, " ").trim();
    if (decision !== "updated" && decision !== "none") {
      return fail("memory audit", "decision must be updated or none.");
    }
    if (!ctx.completeMemoryAudit) {
      return fail("memory audit", "Memory audit is unavailable in this agent context.");
    }
    const result = ctx.completeMemoryAudit(decision, reason);
    return result.ok
      ? ok(`memory audit: ${decision}`, result.message)
      : fail("memory audit rejected", result.message);
  },
};
