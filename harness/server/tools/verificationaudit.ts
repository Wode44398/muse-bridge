import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";

// Explicit, honest alternative to machine verification. The gate accepts this
// only with a concrete reason and deliberately keeps dirtySinceVerify set.
export const verificationAuditTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "VerificationAudit",
    description:
      "Close the post-edit verification gate only when automated verification is genuinely not applicable or is blocked. " +
      "Provide a concrete reason and disclose the limitation in the final answer. This never marks changes as verified.",
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["not_applicable", "blocked"],
          description: "not_applicable when no meaningful executable check exists; blocked when a required dependency or environment is unavailable.",
        },
        reason: {
          type: "string",
          description: "Concrete explanation of what could not be checked and why.",
        },
      },
      required: ["decision", "reason"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const decision = String(args.decision ?? "") as "not_applicable" | "blocked";
    const reason = String(args.reason ?? "").replace(/\s+/g, " ").trim();
    if (decision !== "not_applicable" && decision !== "blocked") {
      return fail("verification audit", "decision must be not_applicable or blocked.");
    }
    if (!ctx.completeVerificationAudit) {
      return fail("verification audit", "Verification audit is unavailable in this agent context.");
    }
    const result = ctx.completeVerificationAudit(decision, reason);
    return result.ok
      ? ok(`verification audit: ${decision}`, result.message)
      : fail("verification audit rejected", result.message);
  },
};
