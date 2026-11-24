// hook 的输入输出协议（照 Claude Code）：
//   stdin  = 一个 JSON：session_id、transcript_path、cwd、hook_event_name、permission_mode，加上各事件自己的字段
//            （tool_name / tool_input / tool_response / tool_use_id、prompt、stop_hook_active、source、trigger）；
//   退出码 0 = 通过（stdout 是 JSON 就按字段认；不是 JSON 的，UserPromptSubmit / SessionStart 把它当附加上下文）；
//   退出码 2 = 阻止，stderr 是原因；
//   其它退出码、超时、起不来 = 记一条警告，不阻止。
// 认的 JSON 字段：decision（"block"；PreToolUse 的旧写法 "approve" / "block"）、reason、additionalContext、
// hookSpecificOutput.{permissionDecision, permissionDecisionReason, updatedInput, additionalContext}。
import type { HookEvent } from "./config.ts";
import type { HookRun } from "./exec.ts";

export type PermissionVerdict = "allow" | "deny" | "ask";

// 一条命令跑完的结论
export interface HookVerdict {
  block?: string; // 阻止（退出码 2 的 stderr，或 decision: block 的 reason）
  permission?: PermissionVerdict;
  permissionReason?: string;
  updatedInput?: Record<string, unknown>;
  context?: string; // 附加上下文
  warning?: string; // 记日志的问题（不阻止）
}

const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(["UserPromptSubmit", "SessionStart"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function parseJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function interpretRun(event: HookEvent, run: HookRun, command: string): HookVerdict {
  const label = command.length > 80 ? `${command.slice(0, 79)}…` : command;
  if (run.error) return { warning: `${event} hook 起不来（${label}）：${run.error.slice(0, 200)}` };
  if (run.timedOut) return { warning: `${event} hook 超时被结束（${label}）` };
  if (run.aborted) return {};
  if (run.code === 2) return { block: run.stderr.trim() || `${event} hook exited with code 2` };
  if (run.code !== 0) {
    return { warning: `${event} hook 退出码 ${run.code ?? "?"}（${label}）${run.stderr.trim() ? `：${run.stderr.trim().slice(0, 300)}` : ""}` };
  }
  const json = parseJson(run.stdout);
  if (!json) return CONTEXT_EVENTS.has(event) && run.stdout.trim() ? { context: run.stdout.trim() } : {};
  const out: HookVerdict = {};
  const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === "object" ? (json.hookSpecificOutput as Record<string, unknown>) : {};
  const reason = str(json.reason);
  const context = str(specific.additionalContext) ?? str(json.additionalContext);
  if (context) out.context = context;
  const pd = specific.permissionDecision;
  if (pd === "allow" || pd === "deny" || pd === "ask") {
    out.permission = pd;
    out.permissionReason = str(specific.permissionDecisionReason) ?? reason;
  } else if (event === "PreToolUse" && (json.decision === "approve" || json.decision === "block")) {
    out.permission = json.decision === "approve" ? "allow" : "deny";
    out.permissionReason = reason;
  } else if (json.decision === "block") {
    out.block = reason ?? `${event} hook blocked this`;
  }
  const updated = specific.updatedInput;
  if (updated && typeof updated === "object" && !Array.isArray(updated)) out.updatedInput = updated as Record<string, unknown>;
  return out;
}

// 同一事件命中的几条命令并行跑，结论合并：阻止原因、上下文都拼起来；权限按 deny > ask > allow；改参数取最后一条给的
export interface HookOutcome {
  block?: string;
  permission?: PermissionVerdict;
  permissionReason?: string;
  updatedInput?: Record<string, unknown>;
  context?: string;
  warnings: string[];
}

const RANK: Record<PermissionVerdict, number> = { allow: 1, ask: 2, deny: 3 };

export function mergeVerdicts(verdicts: HookVerdict[]): HookOutcome {
  const out: HookOutcome = { warnings: [] };
  const blocks: string[] = [];
  const contexts: string[] = [];
  for (const v of verdicts) {
    if (v.warning) out.warnings.push(v.warning);
    if (v.block) blocks.push(v.block);
    if (v.context) contexts.push(v.context);
    if (v.permission && (!out.permission || RANK[v.permission] > RANK[out.permission])) {
      out.permission = v.permission;
      out.permissionReason = v.permissionReason;
    }
    if (v.updatedInput) out.updatedInput = v.updatedInput;
  }
  if (blocks.length) out.block = blocks.join("\n");
  if (contexts.length) out.context = contexts.join("\n\n");
  return out;
}

// 进模型上下文的 hook 文字封顶（与 Claude Code 对 additionalContext 的上限同量级）
export const CONTEXT_CAP = 10_000;
export const capText = (s: string, max = CONTEXT_CAP): string => (s.length <= max ? s : `${s.slice(0, max)}\n[…hook output truncated at ${max} characters]`);
