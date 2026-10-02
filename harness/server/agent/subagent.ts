import { randomUUID } from "node:crypto";
import { AgentState } from "./state.ts";
import { runAgent } from "./loop.ts";
import { createAdapter } from "../providers/registry.ts";
import type { AdapterConfig, ProviderAdapter, ProviderId } from "../providers/types.ts";
import type { JsonObjectSchema, ThinkingLevel } from "./turn.ts";
import type { PermissionMode, PermissionRules } from "./permissions.ts";
import type { AgentEvent, SubAgentTier } from "./events.ts";
import type { Sandbox } from "../sandbox.ts";
import type {
  FileState,
  SubAgentRequest,
  SubAgentResult,
  SubAgentStop,
  SubAgentTrailStep,
  Tool,
  ToolContext,
} from "../tools/types.ts";
import { fail, ok } from "../tools/types.ts";
import { readTool } from "../tools/read.ts";
import { grepTool } from "../tools/grep.ts";
import { globTool } from "../tools/glob.ts";
import { webfetchTool } from "../tools/webfetch.ts";
import { webSearchTool, webSearchAvailable } from "../tools/websearch.ts";
import { writeTool } from "../tools/write.ts";
import { editTool } from "../tools/edit.ts";
import { bashTool, shell } from "../tools/bash.ts";
import { disabledTools } from "../tenant.ts";
import { verificationAuditTool } from "../tools/verificationaudit.ts";
import { allProviders, clampEffort, defaultModel, providerBaseUrl } from "../catalog.ts";
import { resolveKey } from "../config.ts";
import { coerceToSchema, formatSchemaErrors, validateSchema } from "./schema.ts";
import type { UsageDelta } from "../usage-ledger.ts";

// A sub-agent is a fresh, bounded agent loop the main agent (or a Workflow
// script) delegates one self-contained task to. The point is context economy:
// the child burns its own context on file dumps / build output and hands back
// only the conclusions — as text, or as a schema-validated object.
//
// Two tool tiers:
//   research — Read/Grep/Glob/WebFetch(/WebSearch), permission mode forced to
//              read-only. The original Agent tool.
//   coder    — the research set plus Write/Edit/Bash (+VerificationAudit so the
//              done-gate's escape hatch exists). Runs in auto mode. Refused
//              unless the PARENT session is in auto mode: a read-only/plan
//              parent must never be able to write through a child — and a
//              parent that switches to read-only/plan mid-run clamps every
//              running coder from its next tool call on (P2, only tightens).
// Never inside a child: Agent/Workflow (no recursion), AskUserQuestion (no
// human attached), memory tools (no durable memory; no MemoryAudit gate).
//
// Structured output: with `schema`, a SubmitResult tool whose parameters ARE
// the schema is injected; calling it validly is the only way to deliver (the
// child's loop is stopped right after the accepted call — no wasted "I'm done"
// turn). Invalid arguments come back as a tool error listing the problems, up
// to SUBMIT_ATTEMPTS; finishing without calling it earns a nudge, up to
// SUBMIT_NUDGES. This beats "please answer in JSON" + parse on every provider
// because the argument schema is enforced by the same tool-call channel every
// adapter already speaks.

const TIER_DEFAULTS: Record<SubAgentTier, { maxTurns: number; deadlineMs: number }> = {
  research: { maxTurns: 20, deadlineMs: 10 * 60_000 },
  coder: { maxTurns: 60, deadlineMs: 30 * 60_000 },
};
const MAX_TURNS_CAP = 200;
const DEADLINE_CAP_MS = 2 * 60 * 60_000;
const SUB_MAX_OUTPUT = 65_536;
const SUBMIT_ATTEMPTS = 3; // first try + 2 retries
const SUBMIT_NUDGES = 2;

// O2（KM-1 第一步）：子 agent 撞上限流 / 上游过载——以前 loop 重试完就记失败，在 Workflow 里变成 null、被脚本的 filter(Boolean)
// 静默吃掉（「审了 12 个模块」其实只审了 9 个）。现在不记失败：挂起、退避（3 秒起翻倍、封顶 60 秒，可被中止），然后在同一个
// state 上接着跑，挂起的那一轮不计轮数；只受这个子 agent 自己的截止时间约束。key、额度、请求本身有问题这类错误照旧失败。
const SUSPEND_CLASSES = new Set(["rate_limit", "upstream_busy"]);
const SUSPEND_BASE_MS = 3_000;
const SUSPEND_CAP_MS = 60_000;
const RESUME_AFTER_SUSPEND =
  "[Automated check] The model provider was temporarily unavailable (rate limited or overloaded) and this run was " +
  "paused. Continue the task from where you left off.";
// 测试把节奏调快（与 R8 的重试同一个开关）
const suspendScale = (): number => {
  const s = Number(process.env.DIMENSIO_RETRY_SCALE);
  return Number.isFinite(s) && s > 0 ? s : 1;
};
// O3：交接单里「下一步」的话术
const REFUSED_CLASSES = new Set(["auth", "billing", "egress_blocked"]);
function nextStepFor(stop: SubAgentStop, errorClass: string): string {
  switch (stop) {
    case "completed":
      return "";
    case "budget_exhausted":
      return "It ran out of its turn / time budget before finishing; its last notes are included. Continue from them yourself, " +
        "or dispatch it again with a narrower task or a larger maxTurns.";
    case "rate_limited":
      return "The model provider kept rate-limiting it until its deadline. Wait a little and dispatch it again, or do this step yourself.";
    case "provider_error":
      return REFUSED_CLASSES.has(errorClass)
        ? "The model provider refused the request (key, quota or network). Retrying will not help — tell the user."
        : "The request to the model provider failed. Retry once; if it fails again, do this step yourself.";
    case "no_result":
      return "It finished without delivering the structured result. Retry with a simpler schema or a clearer task, or do the step yourself.";
    case "aborted":
      return "It was stopped before finishing.";
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
  });
}
const TRAIL_CAP = 80;
const EVENT_TEXT_CAP = 20_000;
const PROMPT_EVENT_CAP = 4_000;

// Inner loop events worth relaying to the UI. thinking_delta is skipped for
// volume; context/todo/turn_discard carry nothing an agent card renders.
const FORWARDED = new Set<AgentEvent["e"]>([
  "turn_start",
  "text_delta",
  "tool_start",
  "tool_end",
  "tool_permission",
  "usage",
  "done",
  "error",
]);

const SUBMIT_NUDGE =
  "[Automated check] You have not delivered your result. Call SubmitResult now with arguments that match " +
  "its schema exactly — that call is the only deliverable; plain text is discarded.";

export interface SubAgentEnv {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  thinking: ThinkingLevel;
  sandbox: Sandbox;
  limits: { bashTimeoutMs: number; bashMaxTimeoutMs: number };
  // Live getters, not snapshots: plan approval flips the parent's mode mid-run
  // and "allow for this session" appends rules while the run is going.
  parentMode?: () => PermissionMode;
  permissionRules?: () => PermissionRules;
  // Session id — tags a coder child's background jobs so stopping the session
  // reaps them too.
  ownerId?: string;
  // N26：父会话这一轮的轮内快照口——子 agent 的破坏性命令前同样先拍（何时拍由子 agent 自己的 loop 判）
  snapshotFiles?: (label: string) => Promise<void>;
  // C6（G3）：继承的项目指令（AGENTS.md、GUIDE.md 两段，已框定好），拼进子 agent 的 system prompt。
  // C4：每起一个子 agent 现读——会话中途改了 GUIDE / AGENTS.md，之后起的子 agent 拿到的是新的
  projectInstructions?: () => string | undefined;
  // O8（N39）：父会话的用量账本——子 agent 的每次请求也记进去（任务标 subagent；工作流里起的标 workflow）
  usageSink?: (d: UsageDelta) => void;
}

interface SubmitHolder {
  value: unknown;
  attempts: number;
  exhausted: boolean;
  lastErrors: string;
}

function tierTools(tier: SubAgentTier): Tool[] {
  const tools: Tool[] = [readTool, grepTool, globTool, webfetchTool];
  if (webSearchAvailable()) tools.push(webSearchTool);
  if (tier === "coder") tools.push(writeTool, editTool, bashTool, verificationAuditTool);
  // 关掉的工具子 agent 也不许有（没有命令行的租户，coder 子 agent 同样没有 Bash），见 tenant.ts。
  const off = disabledTools();
  return tools.filter((t) => !off.has(t.def.name));
}

function makeSubmitTool(schema: JsonObjectSchema, holder: SubmitHolder): Tool {
  return {
    effect: "read",
    concurrencySafe: false,
    def: {
      name: "SubmitResult",
      description:
        "Deliver your final result. The arguments MUST match this schema exactly — it is what the caller " +
        "consumes programmatically. Call it once, when you have the data; text outside this call is discarded. " +
        "If the call is rejected, fix the listed problems and call it again.",
      parameters: schema,
    },
    async run(rawArgs) {
      // O5（H4）：先按 schema 宽容修正（JSON 字符串包着的对象 / 数组 parse 一次，数字 / 布尔字符串转回来）——修正本身不算
      // 一次修复机会；修正后还不对，报的是修正后对象上的问题
      const args = coerceToSchema(schema, rawArgs).value as Record<string, unknown>;
      const errors = validateSchema(schema, args);
      if (errors.length) {
        holder.attempts++;
        holder.lastErrors = formatSchemaErrors(errors);
        const left = SUBMIT_ATTEMPTS - holder.attempts;
        if (left <= 0) {
          holder.exhausted = true;
          return fail("result rejected", `Result rejected (no attempts left):\n${holder.lastErrors}`);
        }
        return fail(
          "result rejected",
          `Result rejected (${left} attempt${left === 1 ? "" : "s"} left). Fix these and call SubmitResult again:\n${holder.lastErrors}`,
        );
      }
      holder.value = args;
      return ok("result accepted", "Result accepted. You are done — stop now.");
    },
  };
}

interface PromptEnv {
  root: string;
  platform: string;
  tier: SubAgentTier;
  toolNames: string[];
  fullAccess: boolean;
  schema: boolean;
  extra?: string;
  // C6（G3）：从父会话继承的项目指令（AGENTS.md、GUIDE.md），框定与主会话一致
  inherited?: string;
}

function subSystemPrompt(env: PromptEnv): string {
  const reach = env.fullAccess
    ? " — you may also work on other paths on this machine (absolute paths) when the task points there."
    : " — stay inside it.";
  const role = env.tier === "coder"
    ? "You are a coding sub-agent inside a coding-agent harness. A main agent delegated ONE self-contained implementation task to you; it sees nothing of your work except your final deliverable."
    : "You are a read-only research sub-agent inside a coding-agent harness. A main agent delegated ONE focused task to you; it sees nothing of your work except your final deliverable.";
  const toolsLine = env.tier === "coder"
    ? `${env.toolNames.join(", ")}. You can edit files and run commands. Read a file before you Edit it. Never start a web server or any long-lived process; Bash(background:true) is only for finite long commands. Shell: ${shell.kind}.`
    : `${env.toolNames.join(", ")}. You canNOT edit files or run commands. If the task seems to require an action, report precisely what the caller should do instead.`;
  const work = env.tier === "coder"
    ? `1. Work autonomously. Never ask questions — make reasonable assumptions and state them in your deliverable.
2. Scope first: Grep with mode:"files" or Glob to locate what matters, Read it, then make focused changes (prefer Edit over rewriting files).
3. VERIFY before you finish: run the relevant test/build/program with Bash(verify:true) and read the output. If no executable check exists or the environment blocks it, call VerificationAudit with a concrete reason.
4. Stay on the task. No gold-plating, no unrelated cleanups.`
    : `1. Work autonomously. Never ask questions — make reasonable assumptions and state them in your deliverable.
2. Scope first, then read: Grep with mode:"files" or Glob to locate candidates, then Read what matters. Batch independent lookups into ONE turn — they execute in parallel.
3. Be thorough on the task, and only the task. Stop as soon as you can answer it.`;
  const deliverable = env.schema
    ? `## Deliverable (IMPORTANT)
You MUST deliver by calling the SubmitResult tool — its parameters are the exact schema the caller consumes. Anything you write outside that call is discarded. Gather the data first, then call it once with complete, valid arguments; if it is rejected, fix the listed problems and call it again.`
    : `## Deliverable (IMPORTANT)
Your FINAL message is the entire deliverable, returned verbatim to the caller. Pack it with everything needed to act: concrete file paths with line numbers, exact names/signatures, short verbatim snippets where they matter, ${env.tier === "coder" ? "exactly which files you changed and what you verified (command + outcome), " : ""}and a direct answer to what was asked. No preamble, no questions, no offers of further help.`;
  const extra = env.extra?.trim() ? `\n\n## Additional instructions from the caller\n${env.extra.trim()}` : "";
  const inherited = env.inherited?.trim() ? `\n\n${env.inherited.trim()}` : "";
  return `${role}

## Environment
- Working directory (sandbox root): ${env.root}${reach}
- Platform: ${env.platform}

## Tools
${toolsLine}

## How to work
${work}

${deliverable}${inherited}${extra}`;
}

function providerForModel(model: string): ProviderId | undefined {
  return allProviders().find((p) => p.models.some((m) => m.id === model))?.id;
}

interface Target {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  thinking: ThinkingLevel;
}

// Resolve the child's provider/model/effort. No override = the parent's own
// configuration. A model override is looked up in the catalog for its
// provider; a foreign provider needs its own configured key.
function resolveTarget(env: SubAgentEnv, req: SubAgentRequest): Target | { error: string } {
  const wantModel = req.model?.trim() || undefined;
  const wantProvider = req.provider;
  if (!wantModel && !wantProvider) {
    return {
      provider: env.provider,
      model: env.model,
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      thinking: req.thinking ? clampEffort(env.provider, env.model, req.thinking) : env.thinking,
    };
  }
  const provider: ProviderId =
    wantProvider ?? (wantModel === env.model ? env.provider : providerForModel(wantModel!) ?? env.provider);
  const model = wantModel ?? defaultModel(provider);
  let apiKey = env.apiKey;
  let baseUrl = env.baseUrl;
  if (provider !== env.provider) {
    const key = resolveKey(provider);
    if (!key) return { error: `model "${model}" needs provider "${provider}", which has no API key configured` };
    apiKey = key;
    baseUrl = providerBaseUrl(provider);
  }
  return { provider, model, apiKey, baseUrl, thinking: clampEffort(provider, model, req.thinking ?? env.thinking) };
}

const ARG_KEYS = ["command", "pattern", "path", "url", "query", "prompt", "poll", "kill", "action"];
function argPreview(args: Record<string, unknown>): string {
  for (const k of ARG_KEYS) {
    const v = args?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "";
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function clampInt(v: number | undefined, fallback: number, cap: number): number {
  if (!v || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), cap);
}

// The session wires the returned closure into ToolContext.runSubAgent. The
// optional adapterFactory exists for tests (inject a scripted fake adapter).
export function makeSubAgentRunner(
  env: SubAgentEnv,
  adapterFactory: (cfg: AdapterConfig) => ProviderAdapter = createAdapter,
): (req: SubAgentRequest) => Promise<SubAgentResult> {
  return async function runSubAgent(req: SubAgentRequest): Promise<SubAgentResult> {
    const id = req.id ?? randomUUID();
    const tier: SubAgentTier = req.tier === "coder" ? "coder" : "research";
    const label = (req.label?.trim() || firstLine(req.prompt) || "sub-agent").slice(0, 80);
    const emit = req.onEvent;
    const startedAt = Date.now();

    // Early refusals still announce themselves on the event stream, so the UI
    // shows a failed card instead of a tool row that silently errored.
    const bail = (error: string, model = env.model, provider: string = env.provider): SubAgentResult => {
      emit?.({
        e: "subagent_start", id, label, tier, model, provider, prompt: req.prompt.slice(0, PROMPT_EVENT_CAP),
        phase: req.phase, workflowId: req.workflowId, toolId: req.toolId, startedAt,
      });
      const durationMs = Date.now() - startedAt;
      emit?.({ e: "subagent_end", id, ok: false, error, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, text: "", durationMs });
      return {
        ok: false, id, label, tier, model, provider, text: "", error,
        turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, editedFiles: [], trail: [], startedAt, durationMs,
      };
    };

    if (tier === "coder" && env.parentMode) {
      const mode = env.parentMode();
      if (mode !== "auto") {
        return bail(`coder sub-agents need the parent session in auto mode (it is in ${mode}); use tools:"research" or switch the session mode first`);
      }
    }
    const target = resolveTarget(env, req);
    if ("error" in target) return bail(target.error, req.model ?? env.model, req.provider ?? env.provider);

    // A fresh adapter per child: adapters may carry per-session state, and
    // parallel children must never share streams.
    const adapter = adapterFactory({
      provider: target.provider,
      apiKey: target.apiKey,
      model: target.model,
      baseUrl: target.baseUrl,
    });

    const tools = tierTools(tier);
    const holder: SubmitHolder = { value: undefined, attempts: 0, exhausted: false, lastErrors: "" };
    if (req.schema) tools.push(makeSubmitTool(req.schema, holder));
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.def.name, t]));

    // Own abort controller: the parent's signal flows in; the runner also
    // pulls it itself once SubmitResult has been accepted (no wasted turn).
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (req.signal?.aborted) ctrl.abort();
    else req.signal?.addEventListener("abort", onParentAbort, { once: true });
    let selfAborted = false;

    const ctx: ToolContext = {
      sandbox: env.sandbox,
      // Own read-state: child Reads must not satisfy the parent's Edit gate.
      readFileState: new Map<string, FileState>(),
      setTodos: () => {},
      limits: env.limits,
      agentSeesImages: adapter.capabilities.image,
      agentSeesVideo: adapter.capabilities.video,
      agentHearsAudio: adapter.capabilities.audio === true,
      provider: target.provider,
      signal: ctrl.signal,
      ownerId: env.ownerId,
      snapshotFiles: env.snapshotFiles,
    };

    const permissionMode: PermissionMode =
      tier === "research" ? "read-only" : req.permissionMode === "read-only" ? "read-only" : "auto";
    const state = new AgentState({
      adapter,
      system: subSystemPrompt({
        root: env.sandbox.root,
        platform: process.platform,
        tier,
        toolNames: tools.map((t) => t.def.name),
        fullAccess: env.sandbox.access === "full",
        schema: Boolean(req.schema),
        extra: req.system,
        inherited: env.projectInstructions?.(),
      }),
      tools: tools.map((t) => t.def),
      budget: {
        maxOutputTokens: Math.min(adapter.capabilities.maxOutputTokens, SUB_MAX_OUTPUT),
        thinking: target.thinking,
      },
      ctx,
      toolMap,
      permissionMode,
      // P2（#18）：父会话运行中切只读/计划，已派出的 coder 下一次工具调用就按只读判（只收紧）。
      modeCeiling: env.parentMode,
      // The parent's deny/ask rules apply to the child too (ask degrades to
      // deny — no human is attached to a child).
      permissionRules: env.permissionRules?.(),
      // This helper cannot write durable memory and intentionally has no
      // Remember/MemoryAudit tools. Do not run the main-agent lifecycle gate.
      memoryAuditRequired: false,
    });
    ctx.completeVerificationAudit = (decision, reason) => state.completeVerificationAudit(decision, reason);
    // O8：子 agent 的用量记进父会话的账本
    state.usageSink = env.usageSink;
    state.usageTask = req.workflowId ? "workflow" : "subagent";
    state.addUserMessage(req.prompt);
    const defaults = TIER_DEFAULTS[tier];
    state.setRunBudget({
      maxTurns: clampInt(req.maxTurns, defaults.maxTurns, MAX_TURNS_CAP),
      deadlineMs: clampInt(req.deadlineMs, defaults.deadlineMs, DEADLINE_CAP_MS),
    });

    emit?.({
      e: "subagent_start", id, label, tier, model: target.model, provider: target.provider,
      prompt: req.prompt.slice(0, PROMPT_EVENT_CAP), phase: req.phase, workflowId: req.workflowId, toolId: req.toolId,
      startedAt,
    });

    const trail: SubAgentTrailStep[] = [];
    const openSteps = new Map<string, SubAgentTrailStep>();
    let trailOverflow = 0;
    const forward = (ev: AgentEvent) => {
      if (emit && FORWARDED.has(ev.e)) emit({ e: "subagent_event", id, ev });
    };

    let error = "";
    let errorClass = "";
    let nudges = 0;
    let suspensions = 0;
    try {
      // Outer loop = SubmitResult nudges: runAgent on the same state continues
      // the conversation (the run budget carries across; a user message reset
      // would zero it). O2: also the resume point after a rate-limit suspension.
      while (true) {
        for await (const ev of runAgent(state, ctrl.signal)) {
          switch (ev.e) {
            case "tool_start": {
              const step: SubAgentTrailStep = { name: ev.name, arg: argPreview(ev.args), ok: false, summary: "" };
              if (trail.length < TRAIL_CAP) trail.push(step);
              else trailOverflow++;
              openSteps.set(ev.id, step);
              break;
            }
            case "tool_end": {
              const step = openSteps.get(ev.id);
              if (step) {
                step.ok = ev.ok;
                step.summary = ev.summary.slice(0, 160);
                openSteps.delete(ev.id);
              }
              break;
            }
            case "tool_permission": {
              const step = openSteps.get(ev.id);
              if (step && ev.decision === "deny") step.summary = ev.reason.slice(0, 160);
              break;
            }
            case "error": {
              // Our own post-submit abort is not an error — report the run as
              // done instead of relaying "aborted".
              if (selfAborted && holder.value !== undefined) {
                forward({ e: "done", stopReason: "end" });
                continue;
              }
              if (!error) {
                error = ev.message;
                errorClass = ev.class ?? "";
              }
              break;
            }
          }
          forward(ev);
          if (ev.e === "tool_end" && ev.name === "SubmitResult") {
            if (ev.ok && holder.value !== undefined) {
              selfAborted = true;
              ctrl.abort();
            } else if (holder.exhausted) {
              error = `structured result rejected ${SUBMIT_ATTEMPTS} times; last problems:\n${holder.lastErrors}`;
              selfAborted = true;
              ctrl.abort();
            }
          }
        }
        // O2：限流 / 上游过载 → 挂起、退避、在同一个 state 上接着跑（截止时间之前）
        if (error && SUSPEND_CLASSES.has(errorClass) && !ctrl.signal.aborted) {
          const wait = Math.round(Math.min(SUSPEND_CAP_MS, SUSPEND_BASE_MS * 2 ** suspensions) * suspendScale());
          if (state.deadlineAt === null || Date.now() + wait < state.deadlineAt) {
            suspensions++;
            emit?.({ e: "subagent_suspended", id, reason: errorClass, waitMs: wait, attempt: suspensions });
            req.onSuspend?.(errorClass);
            await pause(wait, ctrl.signal);
            if (!ctrl.signal.aborted) {
              state.runTurns = Math.max(0, state.runTurns - 1);
              state.appendUserBlocks([{ t: "text", text: RESUME_AFTER_SUSPEND }], true, { origin: "harness", kind: "resume-after-suspend" });
              error = "";
              errorClass = "";
              continue;
            }
          }
        }
        if (!req.schema || holder.value !== undefined || error || ctrl.signal.aborted) break;
        if (state.budgetExhausted) {
          error = "run budget exhausted before SubmitResult was called";
          break;
        }
        if (nudges >= SUBMIT_NUDGES) {
          error = "finished without calling SubmitResult";
          break;
        }
        nudges++;
        state.appendUserBlocks([{ t: "text", text: SUBMIT_NUDGE }], false, { origin: "harness", kind: "submit-nudge" });
      }
    } finally {
      req.signal?.removeEventListener("abort", onParentAbort);
    }

    // The text deliverable = text of the last assistant message that has any.
    let text = "";
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role !== "assistant") continue;
      const t = m.content
        .filter((b) => b.t === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
      if (t) {
        text = t;
        break;
      }
    }

    // O3（K62）：交接单。预算用尽不再报成功（以前非 schema 的调用会以 ok:true 交回一段更早的中间文本）；每种收场给父 agent
    // 一句下一步怎么办（以前一律「写具体点再试」，被限流时这话是误导）。
    if (!error && state.budgetExhausted && !(req.schema && holder.value !== undefined)) {
      error = `run budget exhausted before the task was finished (${state.runTurns} turns)`;
    }
    const parentStopped = Boolean(req.signal?.aborted) && !selfAborted;
    const stopReason: SubAgentStop = !error
      ? "completed"
      : parentStopped
        ? "aborted"
        : SUSPEND_CLASSES.has(errorClass)
          ? "rate_limited"
          : errorClass
            ? "provider_error"
            : state.budgetExhausted
              ? "budget_exhausted"
              : req.schema && holder.value === undefined
                ? "no_result"
                : "provider_error";
    const nextStep = nextStepFor(stopReason, errorClass);

    let toolCalls = 0;
    for (const m of state.messages) {
      for (const b of m.content) if (b.t === "tool_call") toolCalls++;
    }
    if (trailOverflow) trail.push({ name: "…", arg: `${trailOverflow} more calls`, ok: true, summary: "" });

    const result: SubAgentResult = {
      ok: !error,
      id,
      label,
      tier,
      model: target.model,
      provider: target.provider,
      text,
      result: holder.value,
      error: error || undefined,
      ...(error && errorClass ? { errorClass } : {}),
      stopReason,
      ...(nextStep ? { nextStep } : {}),
      turns: state.runTurns,
      toolCalls,
      inputTokens: state.totalInputTokens,
      outputTokens: state.totalOutputTokens,
      editedFiles: [...new Set([...state.editedFiles, ...state.createdFiles])],
      trail,
      startedAt,
      durationMs: Date.now() - startedAt,
      // K9（X55）：子 agent 读过网页 / 浏览器内容，它交回的报告就带着外部内容——随结果交给父会话
      ...(state.externalContentSeen ? { externalContent: true } : {}),
    };
    emit?.({
      e: "subagent_end", id, ok: result.ok, error: result.error, turns: result.turns, toolCalls,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      text: text.slice(0, EVENT_TEXT_CAP), result: holder.value, durationMs: result.durationMs,
      // 子 agent 面板：改过哪些文件、没做完的原因（历史走 tool_result.meta.subagent 的同名字段）
      ...(result.editedFiles.length ? { editedFiles: result.editedFiles } : {}),
      ...(stopReason !== "completed" ? { stopReason } : {}),
    });
    return result;
  };
}
