import { randomUUID } from "node:crypto";
import { AgentState } from "./state.ts";
import { runAgent } from "./loop.ts";
import { createAdapter } from "../providers/registry.ts";
import type { AdapterConfig, ProviderAdapter, ProviderId } from "../providers/types.ts";
import type { JsonObjectSchema, ThinkingLevel } from "./turn.ts";
import type { PermissionMode, PermissionRules } from "./permissions.ts";
import type { AgentEvent, SubAgentTier } from "./events.ts";
import { Sandbox } from "../sandbox.ts";
import { memoryGrantDirs, safeMemoryRoot } from "../memory-files.ts";
import { externalReadDirs } from "../external-memory.ts";
import type {
  FileState,
  SubAgentControl,
  SubAgentRequest,
  SubAgentResult,
  SubAgentStarted,
  SubAgentStop,
  SubAgentTrailStep,
  Tool,
  ToolContext,
} from "../tools/types.ts";
import { allProviders, clampEffort, defaultModel, modelSpec } from "../catalog.ts";
import { providerEndpoint, resolveKey } from "../config.ts";
import type { UsageDelta } from "../usage-ledger.ts";
import { AUTO_RE, routeSubAgentModel } from "./dispatch-ladder.ts";
import { resolveProfile, type ModelProfile } from "./profile.ts";
import { describeTools } from "./tool-descriptions.ts";
import { subSystemPrompt } from "./subagent/prompt.ts";
import { customTools, forkToolMap, makeSubmitTool, tierTools, type SubmitHolder } from "./subagent/tools.ts";
import { findAgentDefinition, loadAgentDefinitions, type AgentDefinition } from "./subagent/definitions.ts";
import { createWorktree, finishWorktree, reopenWorktree, type AgentWorktree } from "./subagent/worktree.ts";
import { forkBlocker, forkDirective, forkMessages, FORK_KIND } from "./subagent/fork.ts";
import { wireApprovals } from "./subagent/approvals.ts";
import {
  agentIdTaken,
  describeAgent,
  dropAgent,
  getAgent,
  listAgents,
  MAX_BACKGROUND,
  MAX_KEPT,
  registerAgent,
  runningBackground,
  settleAgent,
  stopAgent,
  type AgentRecord,
  type StopCause,
} from "./subagent/registry.ts";

// A sub-agent is a bounded agent loop the main agent (or a Workflow script) delegates one task to. The point is
// context economy: the child burns its own context on file dumps / build output and hands back only the
// conclusions — as text, or as a schema-validated object.
//
// 这个文件是编排：选类型（内置两档 / 自定义定义 / fork）、选型、建上下文（subagent/ 下各模块），然后驱动 loop 跑完一次。
// 同一个子 agent 可以接着用：上下文（AgentState）留在台账里（subagent/registry.ts），追加一条消息再驱动一次。
// 后台跑的立刻返回 id，收场时经 env.onBackgroundEnd 交给会话层通知父会话。
//
// Tool tiers:
//   research — Read/Grep/Glob/WebFetch(/WebSearch) + read-only Bash, permission mode forced to read-only.
//   coder    — the research set plus Write/Edit/Bash (+VerificationAudit under the hardened posture). Runs in auto
//              mode. Refused unless the PARENT session is in auto (or bypass) mode, and a parent that switches to
//              read-only/plan mid-run clamps every running coder from its next tool call on (P2, only tightens).
// Never inside a child: Agent/Workflow (no recursion), AskUserQuestion (no human attached), memory tools.
//
// Structured output: with `schema`, a SubmitResult tool whose parameters ARE the schema is injected; calling it
// validly is the only way to deliver (the child's loop is stopped right after the accepted call). Invalid
// arguments come back as a tool error listing the problems, up to SUBMIT_ATTEMPTS; finishing without calling it
// earns a nudge, up to SUBMIT_NUDGES.

const TIER_DEFAULTS: Record<SubAgentTier, { maxTurns: number; deadlineMs: number }> = {
  research: { maxTurns: 20, deadlineMs: 10 * 60_000 },
  coder: { maxTurns: 60, deadlineMs: 30 * 60_000 },
};
const MAX_TURNS_CAP = 200;
const DEADLINE_CAP_MS = 2 * 60 * 60_000;
const SUB_MAX_OUTPUT = 65_536;
// 两项都是模型档案 loop.submitAttempts / loop.submitNudges 的默认值（agent/profile.ts）
export const SUBMIT_ATTEMPTS = 3; // first try + 2 retries
export const SUBMIT_NUDGES = 2;

// O2（KM-1 第一步）：子 agent 撞上限流 / 上游过载——不记失败：挂起、退避（3 秒起翻倍、封顶 60 秒，可被中止），然后在同一个
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

const CAUSE_TEXT: Record<StopCause, string> = {
  model: "stopped by you (Agent action \"stop\")",
  user: "stopped because the user stopped this session",
  deleted: "stopped because the session was deleted",
  restart: "stopped because the server restarted",
};

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

// 父 agent 给一个还在跑的子 agent 追加的话：在它下一步之前注入（kind 见 injections.ts）
export const AGENT_MESSAGE_KIND = "agent-message";
const agentMessage = (text: string) => `[Message from the main agent] ${text}`;

export interface SubAgentEnv {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  thinking: ThinkingLevel;
  // fast mode 开关（现读全局设置）；子 agent 换了不支持的型号时适配器自己不发
  fast?: () => boolean;
  sandbox: Sandbox;
  limits: { bashTimeoutMs: number; bashMaxTimeoutMs: number };
  // Live getters, not snapshots: plan approval flips the parent's mode mid-run
  // and "allow for this session" appends rules while the run is going.
  parentMode?: () => PermissionMode;
  permissionRules?: () => PermissionRules;
  // D5：父会话的「这台机器有没有浏览器」（决定子 agent 碰到网页 / 桌面 / 安卓时给哪版 playbook）；不给 = 有
  parentBrowser?: () => boolean;
  // Session id — tags a child's background jobs so stopping the session reaps them too; also the key of the
  // sub-agent registry (resume / list / stop).
  ownerId?: string;
  // N26：父会话这一轮的轮内快照口——子 agent 的破坏性命令前同样先拍（何时拍由子 agent 自己的 loop 判）
  snapshotFiles?: (label: string) => Promise<void>;
  // 同理：父会话这一轮的「改前备份」口（大工作区只备份改过的文件）——子 agent 的 Write / Edit 同样先备份
  beforeFileWrite?: (abs: string) => Promise<void>;
  // C6（G3）：继承的项目指令（AGENTS.md、GUIDE.md 两段，已框定好），拼进子 agent 的 system prompt。每起一个子 agent 现读
  projectInstructions?: () => string | undefined;
  // O8（N39）：父会话的用量账本——子 agent 的每次请求也记进去（任务标 subagent；工作流里起的标 workflow）
  usageSink?: (d: UsageDelta) => void;
  // 父会话此刻的状态（fork 的前缀、批准卡转交、后台子 agent 的实况事件都现取）；没有 = 不能 fork、要批准的一律拒
  parent?: () => AgentState | undefined;
  // fork 的适配器与父会话同样的缓存时长（前缀才对得上）
  cacheTtl?: "1h";
  // 后台子 agent 收场（完成 / 失败 / 被停）：会话层据此通知父会话、更新发起那次调用的卡片
  onBackgroundEnd?: (end: BackgroundEnd) => void;
  // 用户 hooks 的子 agent 视图（父会话配了 hooks 才有）
  hooks?: () => ToolContext["hooks"];
}

export interface BackgroundEnd {
  id: string;
  toolId?: string;
  prompt: string;
  result: SubAgentResult;
  cause?: StopCause;
  schema: boolean;
}

function providerForModel(model: string): ProviderId | undefined {
  return allProviders().find((p) => Boolean(modelSpec(p.id, model)))?.id;
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
    baseUrl = providerEndpoint(provider);
  }
  return { provider, model, apiKey, baseUrl, thinking: clampEffort(provider, model, req.thinking ?? env.thinking) };
}

// 定义文件里写的型号认不认得：auto:<档>、「服务:型号」、目录里有的 id
function knownModel(env: SubAgentEnv, model: string): boolean {
  if (AUTO_RE.test(model) || model === env.model) return true;
  const at = model.indexOf(":");
  const spec = at > 0 ? allProviders().find((p) => p.id === model.slice(0, at)) : undefined;
  if (spec) return Boolean(modelSpec(spec.id, model.slice(at + 1)));
  return Boolean(providerForModel(model));
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

// ── 类型解析 ─────────────────────────────────────────────────────────────────
// 内置两档的名字固定；别家 harness 的名字（Explore、Plan、general-purpose）是别名——除非工作区 / 用户级定义了同名的自定义类型
const ALIASES: Record<string, SubAgentTier> = {
  explore: "research",
  plan: "research",
  "general-purpose": "coder",
  general: "coder",
  code: "coder",
};

type Resolved = { tier: SubAgentTier; type: string; def?: AgentDefinition; alias?: boolean } | { error: string };

function resolveType(req: SubAgentRequest, root: string): Resolved {
  const raw = req.type?.trim();
  if (!raw) {
    const tier: SubAgentTier = req.tier === "coder" ? "coder" : "research";
    return { tier, type: tier };
  }
  const lower = raw.toLowerCase();
  if (lower === "research" || lower === "coder") return { tier: lower, type: lower };
  const def = findAgentDefinition(root, raw);
  if (def) return { tier: "research", type: def.name, def };
  if (ALIASES[lower]) return { tier: ALIASES[lower], type: ALIASES[lower], alias: true };
  const custom = loadAgentDefinitions(root).map((d) => d.name);
  return { error: `unknown subagent_type "${raw}". Available: research, coder${custom.length ? `, ${custom.join(", ")}` : ""}` };
}

// ── 一个子 agent 的上下文（接着用时原样复用）───────────────────────────────────
interface Child {
  id: string;
  label: string;
  tier: SubAgentTier;
  type: string;
  notes: string[];
  target: Target;
  profile: ModelProfile;
  adapter: ProviderAdapter;
  state: AgentState;
  ctx: ToolContext;
  holder: SubmitHolder | null;
  schema?: JsonObjectSchema;
  fork: boolean;
  worktree?: AgentWorktree;
  runs: number;
}

interface Failed {
  error: string;
  model: string;
  provider: string;
  tier: SubAgentTier;
}

interface DriveOpts {
  signal?: AbortSignal;
  onEvent?: (ev: AgentEvent) => void;
  toolId?: string;
  phase?: string;
  workflowId?: string;
  rec?: AgentRecord;
  maxTurns?: number;
  deadlineMs?: number;
  onSuspend?: (reason: string) => void;
}

// The session wires host.run into ToolContext.runSubAgent and host.control into ToolContext.subAgents. The
// optional adapterFactory exists for tests (inject a scripted fake adapter).
export function makeSubAgentHost(
  env: SubAgentEnv,
  adapterFactory: (cfg: AdapterConfig) => ProviderAdapter = createAdapter,
): { run: (req: SubAgentRequest) => Promise<SubAgentResult>; control: SubAgentControl } {
  const owner = env.ownerId ?? `local-${randomUUID()}`;
  const newId = (): string => {
    let id: string;
    do id = randomUUID().replace(/-/g, "").slice(0, 8);
    while (agentIdTaken(owner, id));
    return id;
  };
  const canWrite = (): { ok: boolean; mode: PermissionMode } => {
    const mode = env.parentMode?.() ?? "auto";
    return { ok: !env.parentMode || mode === "auto" || mode === "bypass", mode };
  };

  // 共用父工作区的子 agent 的沙箱跟着父会话此刻的那一份走：父会话换型号 / 回滚后重建了状态（新的 Sandbox），用户之后切访问范围
  // 改的是新的那一份——在跑的后台子 agent 下一次工具调用就按新的边界判。工作区换了（根不同）就留在原来那一份上。
  function followParentSandbox(ctx: ToolContext, own: Sandbox): void {
    if (!env.parent) return;
    Object.defineProperty(ctx, "sandbox", {
      configurable: true,
      enumerable: true,
      get(): Sandbox {
        const live = env.parent?.()?.ctx.sandbox;
        return live && live.root === own.root ? live : own;
      },
      // loop 按调用派生的上下文（以它为原型）会给这一次调用换一个沙箱视图（P13「允许这一次」的只读目录）：落成派生对象自己的属性；
      // 子 agent 自己的上下文不接受赋值（它的沙箱由父会话此刻的状态决定）
      set(this: ToolContext, value: Sandbox) {
        if (this !== ctx) Object.defineProperty(this, "sandbox", { value, writable: true, configurable: true, enumerable: true });
      },
    });
  }

  async function prepare(req: SubAgentRequest, id: string, label: string): Promise<Child | Failed> {
    const notes: string[] = [];
    const resolved = resolveType(req, env.sandbox.root);
    if ("error" in resolved) return { error: resolved.error, model: env.model, provider: env.provider, tier: "research" };
    let { tier } = resolved;
    const def = resolved.def;

    if (req.context === "fork") {
      const parent = env.parent?.();
      const why = !parent
        ? "there is no parent conversation to copy here"
        : req.schema
          ? "a fork cannot return a schema result"
          : def
            ? "a fork always runs as the main agent, not as a custom type"
            : req.isolation
              ? "a fork works in the main agent's workspace, not in a separate worktree"
              : req.model || req.provider
                ? "a fork runs on this session's model"
                : forkBlocker(parent);
      if (!why) return prepareFork(req, id, label, parent!);
      notes.push(`Not forked (${why}); it ran as a fresh sub-agent that sees only its prompt.`);
    }

    const write = canWrite();
    if (!def && tier === "coder" && !write.ok) {
      if (!resolved.alias) {
        return {
          error: `coder sub-agents need the parent session in auto or bypass mode (it is in ${write.mode}); use tools:"research" or switch the session mode first`,
          model: env.model, provider: env.provider, tier,
        };
      }
      tier = "research";
      notes.push(`"${req.type}" ran as a read-only research agent because this session is in ${write.mode} mode.`);
    }

    let wantModel = req.model?.trim() || undefined;
    if (!wantModel && !req.provider && def?.model) {
      if (knownModel(env, def.model)) wantModel = def.model;
      else notes.push(`The definition of "${def.name}" asks for model "${def.model}", which this harness does not know; it ran on ${env.model}.`);
    }
    // 选型阶梯：model 写 auto:<档> 或「服务:型号」时先换成具体的 provider / 型号（auto 连档位一起，压过调用方写的 effort）
    // via：Workflow 的 agent() 带 workflowId，Agent 工具不带——调用策略按这条路看生效范围
    let routedReq: SubAgentRequest = { ...req, model: wantModel };
    const routed = await routeSubAgentModel(wantModel, { provider: env.provider, model: env.model }, undefined, { via: req.workflowId ? "workflow" : "agent" });
    if ("error" in routed) return { error: routed.error, model: wantModel ?? env.model, provider: req.provider ?? env.provider, tier };
    if (routed.model) routedReq = { ...routedReq, model: routed.model, provider: routed.provider, ...(routed.thinking ? { thinking: routed.thinking } : {}) };
    const target = resolveTarget(env, routedReq);
    if ("error" in target) return { error: target.error, model: wantModel ?? env.model, provider: req.provider ?? env.provider, tier };
    // 模型档案按实际答话的型号解析（auto:<档> / 「服务:型号」都已换成具体型号）——Workflow 的 agent() 也走这里
    const profile = resolveProfile(target.provider, target.model, { effort: target.thinking });

    let tools: Tool[];
    if (def) {
      const picked = customTools(def.tools, write.ok ? "coder" : "research", profile.tools.verifyTools);
      tools = picked.tools;
      if (picked.unknown.length) notes.push(`These tools in the definition of "${def.name}" are not available to sub-agents and were skipped: ${picked.unknown.join(", ")}.`);
      tier = picked.writes && write.ok ? "coder" : "research";
      if (picked.writes && !write.ok) notes.push(`"${def.name}" ran read-only because this session is in ${write.mode} mode.`);
    } else {
      tools = tierTools(tier, profile.tools.verifyTools);
    }

    tools = describeTools(tools, profile.tools.descriptions);

    let sandbox = env.sandbox;
    let worktree: AgentWorktree | undefined;
    if (req.isolation === "worktree") {
      if (tier !== "coder" || req.permissionMode === "read-only") {
        notes.push("isolation \"worktree\" was not used: this agent does not write files.");
      } else {
        const wt = await createWorktree(env.sandbox.root, id, env.ownerId);
        if ("error" in wt) notes.push(`Worktree isolation is not available (${wt.error}); it worked in the shared workspace.`);
        else {
          worktree = wt;
          sandbox = new Sandbox(wt.root, "workspace");
          // 记忆目录与外挂库按父会话的工作区挂（记忆按工作区路径分目录，worktree 的路径不是它的键）：能读本工作区的记忆，
          // 写照旧由 Write / Edit 拒（子 agent 的上下文没有 memoryWriter）与权限判定拒
          const parentRoot = env.sandbox.root;
          sandbox.setOwnStateDirs(memoryGrantDirs(parentRoot), safeMemoryRoot());
          sandbox.setExtraReadDirs(externalReadDirs(parentRoot));
        }
      }
    }

    const holder: SubmitHolder | null = req.schema
      ? { value: undefined, attempts: 0, maxAttempts: profile.loop.submitAttempts, exhausted: false, lastErrors: "" }
      : null;
    if (req.schema && holder) tools.push(makeSubmitTool(req.schema, holder));
    const toolMap = new Map<string, Tool>(tools.map((t) => [t.def.name, t]));

    // A fresh adapter per child: adapters may carry per-session state, and parallel children must never share streams.
    const adapter = adapterFactory({ provider: target.provider, apiKey: target.apiKey, model: target.model, baseUrl: target.baseUrl, fast: env.fast });
    const ctx: ToolContext = {
      sandbox,
      // Own read-state: child Reads must not satisfy the parent's Edit gate.
      readFileState: new Map<string, FileState>(),
      setTodos: () => {},
      limits: env.limits,
      agentSeesImages: adapter.capabilities.image,
      agentSeesVideo: adapter.capabilities.video,
      agentHearsAudio: adapter.capabilities.audio === true,
      provider: target.provider,
      ownerId: env.ownerId,
      // worktree 里的改动不在父工作区的检查点范围里：不接父会话这一轮的快照与改前备份
      ...(worktree ? {} : { snapshotFiles: env.snapshotFiles, beforeFileWrite: env.beforeFileWrite }),
      ...(env.hooks ? { hooks: env.hooks() } : {}),
    };
    if (!worktree) followParentSandbox(ctx, sandbox);
    wireApprovals(ctx, env.parent, label);

    // coder 子 agent 继承父会话的全权档：父会话在 bypass 时子 agent 也 bypass（沙箱此刻就是 bypass——整机 + 跳过密钥守卫；
    // 判定层也得 bypass 才不会被卡片 / 规则挡住）。
    const permissionMode: PermissionMode =
      tier === "research" ? "read-only" : req.permissionMode === "read-only" ? "read-only" : write.mode === "bypass" ? "bypass" : "auto";
    const state = new AgentState({
      adapter,
      system: subSystemPrompt({
        root: sandbox.root,
        platform: process.platform,
        tier,
        toolNames: tools.map((t) => t.def.name),
        fullAccess: sandbox.access !== "workspace",
        schema: Boolean(req.schema),
        extra: req.system,
        inherited: env.projectInstructions?.(),
        profile,
        ...(def ? { custom: { name: def.name, prompt: def.prompt } } : {}),
        ...(worktree ? { isolation: { path: worktree.path, branch: worktree.branch, base: worktree.base } } : {}),
      }),
      tools: tools.map((t) => t.def),
      budget: { maxOutputTokens: Math.min(adapter.capabilities.maxOutputTokens, SUB_MAX_OUTPUT), thinking: target.thinking },
      ctx,
      toolMap,
      permissionMode,
      // P2（#18）：父会话运行中切只读/计划，已派出的 coder 下一次工具调用就按只读判（只收紧）。
      modeCeiling: env.parentMode,
      // 父会话的 deny/ask 规则对子 agent 同样生效；ask 在父会话有人在场时经它弹卡，否则按拒绝
      permissionRules: env.permissionRules?.(),
      // This helper cannot write durable memory and intentionally has no Remember/MemoryAudit tools.
      memoryAuditRequired: false,
      browser: env.parentBrowser?.(),
      profile,
    });
    ctx.completeVerificationAudit = (decision, reason) => state.completeVerificationAudit(decision, reason);
    state.usageSink = env.usageSink;
    state.usageTask = req.workflowId ? "workflow" : "subagent";
    return { id, label, tier, type: def?.name ?? tier, notes, target, profile, adapter, state, ctx, holder, schema: req.schema, fork: false, worktree, runs: 0 };
  }

  // fork：父会话的 system、工具表（不能用的换成拒绝）、历史副本；同一个型号与缓存时长
  function prepareFork(req: SubAgentRequest, id: string, label: string, parent: AgentState): Child {
    const mode = parent.effectiveMode();
    const permissionMode: PermissionMode = mode === "plan" ? "read-only" : mode;
    const tier: SubAgentTier = permissionMode === "auto" || permissionMode === "bypass" ? "coder" : "research";
    const adapter = adapterFactory({
      provider: env.provider, apiKey: env.apiKey, model: env.model, baseUrl: env.baseUrl, fast: env.fast,
      ...(env.cacheTtl ? { cacheTtl: env.cacheTtl } : {}),
    });
    const target: Target = { provider: env.provider, model: env.model, apiKey: env.apiKey, baseUrl: env.baseUrl, thinking: parent.budget.thinking ?? env.thinking };
    const ctx: ToolContext = {
      sandbox: parent.ctx.sandbox,
      // 它看得见父会话读过的内容：已读状态一并带上（之后各记各的）
      readFileState: new Map(parent.ctx.readFileState),
      setTodos: () => {},
      limits: env.limits,
      agentSeesImages: adapter.capabilities.image,
      agentSeesVideo: adapter.capabilities.video,
      agentHearsAudio: adapter.capabilities.audio === true,
      provider: env.provider,
      ownerId: env.ownerId,
      snapshotFiles: env.snapshotFiles,
      beforeFileWrite: env.beforeFileWrite,
      ...(parent.ctx.deferredTools ? { deferredTools: parent.ctx.deferredTools } : {}),
      // 用户 hooks：fork 里的工具调用同样过 PreToolUse / PostToolUse，收尾报 SubagentStop
      ...(env.hooks ? { hooks: env.hooks() } : {}),
    };
    followParentSandbox(ctx, parent.ctx.sandbox);
    wireApprovals(ctx, env.parent, label);
    const state = new AgentState({
      adapter,
      system: parent.system,
      tools: [...parent.tools],
      budget: { ...parent.budget },
      ctx,
      toolMap: forkToolMap(parent.toolMap),
      permissionMode,
      modeCeiling: env.parentMode,
      permissionRules: parent.effectiveRules(),
      memoryAuditRequired: false,
      browser: parent.browser,
      profile: parent.profile,
    });
    state.messages = forkMessages(parent, req.toolId);
    state.loadedTools = new Set(parent.loadedTools);
    ctx.completeVerificationAudit = (decision, reason) => state.completeVerificationAudit(decision, reason);
    state.usageSink = env.usageSink;
    state.usageTask = "subagent";
    return { id, label, tier, type: "fork", notes: [], target, profile: parent.profile, adapter, state, ctx, holder: null, fork: true, runs: 0 };
  }

  // Early refusals still announce themselves on the event stream, so the UI shows a failed card instead of a
  // tool row that silently errored.
  function bail(id: string, label: string, req: SubAgentRequest, f: Failed, emit?: (ev: AgentEvent) => void, toolId = req.toolId, background = false): SubAgentResult {
    const startedAt = Date.now();
    emit?.({
      e: "subagent_start", id, label, tier: f.tier, model: f.model, provider: f.provider, prompt: req.prompt.slice(0, PROMPT_EVENT_CAP),
      phase: req.phase, workflowId: req.workflowId, toolId, startedAt, ...(background ? { background: true } : {}),
    });
    emit?.({ e: "subagent_end", id, ok: false, error: f.error, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, text: "", durationMs: 0 });
    return {
      ok: false, id, label, tier: f.tier, model: f.model, provider: f.provider, text: "", error: f.error,
      turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, editedFiles: [], trail: [], startedAt, durationMs: 0,
    };
  }

  async function drive(child: Child, prompt: string, o: DriveOpts): Promise<SubAgentResult> {
    const { state, holder, profile, target, id, label, tier } = child;
    const emit = o.onEvent;
    const startedAt = Date.now();
    // Own abort controller: the caller's signal flows in; the runner also pulls it itself once SubmitResult has
    // been accepted (no wasted turn).
    const ctrl = new AbortController();
    const onCallerAbort = () => ctrl.abort(o.signal?.reason);
    if (o.signal?.aborted) ctrl.abort(o.signal.reason);
    else o.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (o.rec) {
      o.rec.ctrl = ctrl;
      o.rec.status = "running";
      o.rec.startedAt = startedAt;
      o.rec.closing = false;
    }
    child.ctx.signal = ctrl.signal;
    let selfAborted = false;
    if (holder) Object.assign(holder, { value: undefined, attempts: 0, exhausted: false, lastErrors: "" });
    const firstRun = child.runs === 0;
    child.runs++;

    const in0 = state.totalInputTokens;
    const out0 = state.totalOutputTokens;
    if (child.fork && firstRun) {
      state.addUserMessage(forkDirective(prompt));
      const head = state.messages[state.messages.length - 1];
      head.origin = "harness";
      head.kind = FORK_KIND;
    } else {
      state.addUserMessage(prompt);
    }
    const head = state.messages[state.messages.length - 1];
    // 还在准备时收到的追加消息
    for (const m of o.rec?.inbox.splice(0) ?? []) state.queueFamily(m, AGENT_MESSAGE_KIND);
    const defaults = TIER_DEFAULTS[tier];
    state.setRunBudget({
      maxTurns: clampInt(o.maxTurns, defaults.maxTurns, MAX_TURNS_CAP),
      deadlineMs: clampInt(o.deadlineMs, defaults.deadlineMs, DEADLINE_CAP_MS),
    });

    emit?.({
      e: "subagent_start", id, label, tier, model: target.model, provider: target.provider,
      prompt: prompt.slice(0, PROMPT_EVENT_CAP), phase: o.phase, workflowId: o.workflowId, toolId: o.toolId, startedAt,
      ...(o.rec?.background ? { background: true } : {}),
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
      // Outer loop = SubmitResult nudges: runAgent on the same state continues the conversation (the run budget
      // carries across). O2: also the resume point after a rate-limit suspension.
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
              // Our own post-submit abort is not an error — report the run as done instead of relaying "aborted".
              if (selfAborted && holder?.value !== undefined) {
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
          if (ev.e === "tool_end" && ev.name === "SubmitResult" && holder) {
            if (ev.ok && holder.value !== undefined) {
              selfAborted = true;
              ctrl.abort();
            } else if (holder.exhausted) {
              error = `structured result rejected ${holder.maxAttempts} times; last problems:\n${holder.lastErrors}`;
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
            o.onSuspend?.(errorClass);
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
        // 父 agent 追加的话在它最后一步之后才到（loop 收尾前已看过一遍队列）：还能接着跑就再跑一轮读它
        if (!error && !ctrl.signal.aborted && !state.budgetExhausted && holder?.value === undefined && state.hasSteer()) continue;
        if (!child.schema || holder?.value !== undefined || error || ctrl.signal.aborted) break;
        if (state.budgetExhausted) {
          error = "run budget exhausted before SubmitResult was called";
          break;
        }
        if (nudges >= profile.loop.submitNudges) {
          error = "finished without calling SubmitResult";
          break;
        }
        nudges++;
        state.appendUserBlocks([{ t: "text", text: SUBMIT_NUDGE }], false, { origin: "harness", kind: "submit-nudge" });
      }
    } finally {
      o.signal?.removeEventListener("abort", onCallerAbort);
    }
    // 从这里起不再读追加的话（resume 据此明说「它正在收尾」）；已经排着、没读到的如实交代
    if (o.rec) o.rec.closing = true;
    const unread = state.takeFamilyKind(AGENT_MESSAGE_KIND).length;

    // 这一次运行从它收到的那条消息起（fork 的前面是父会话的历史；接着用的前面是上一次）；中途压缩把它摘掉了就看整段
    let from = state.messages.indexOf(head);
    if (from < 0) from = 0;
    const mine = state.messages.slice(from);
    // The text deliverable = text of the last assistant message that has any.
    let text = "";
    for (let i = mine.length - 1; i >= 0; i--) {
      const m = mine[i];
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

    const stopped = ctrl.signal.aborted && !selfAborted;
    const cause = o.rec?.stoppedBy;
    if (stopped && cause) error = CAUSE_TEXT[cause];
    // O3（K62）：交接单。预算用尽不再报成功；每种收场给父 agent 一句下一步怎么办。
    if (!error && state.budgetExhausted && !(child.schema && holder?.value !== undefined)) {
      error = `run budget exhausted before the task was finished (${state.runTurns} turns)`;
    }
    const stopReason: SubAgentStop = !error
      ? "completed"
      : stopped
        ? "aborted"
        : SUSPEND_CLASSES.has(errorClass)
          ? "rate_limited"
          : errorClass
            ? "provider_error"
            : state.budgetExhausted
              ? "budget_exhausted"
              : child.schema && holder?.value === undefined
                ? "no_result"
                : "provider_error";
    const nextStep = nextStepFor(stopReason, errorClass);

    let toolCalls = 0;
    for (const m of mine) for (const b of m.content) if (b.t === "tool_call") toolCalls++;
    if (trailOverflow) trail.push({ name: "…", arg: `${trailOverflow} more calls`, ok: true, summary: "" });

    // worktree：没改动就删掉，有改动就保留（报告里给路径、分支、改动概要）
    let worktree: SubAgentResult["worktree"];
    if (child.worktree) {
      const out = await finishWorktree(child.worktree, { touched: [...state.editedFiles, ...state.createdFiles] });
      worktree = { path: child.worktree.path, branch: child.worktree.branch, kept: out.kept, summary: out.summary };
    }

    const notes = [
      ...(firstRun ? child.notes : []),
      ...(unread ? [`${unread} message${unread === 1 ? "" : "s"} you sent it arrived after it stopped reading and ${unread === 1 ? "was" : "were"} not read; send ${unread === 1 ? "it" : "them"} again with Agent(id, prompt) if still relevant.`] : []),
    ];
    const result: SubAgentResult = {
      ok: !error,
      id,
      label,
      tier,
      type: child.type,
      model: target.model,
      provider: target.provider,
      text,
      result: holder?.value,
      error: error || undefined,
      ...(error && errorClass ? { errorClass } : {}),
      stopReason,
      ...(nextStep ? { nextStep } : {}),
      turns: state.runTurns,
      toolCalls,
      inputTokens: state.totalInputTokens - in0,
      outputTokens: state.totalOutputTokens - out0,
      editedFiles: [...new Set([...state.editedFiles, ...state.createdFiles])],
      trail,
      startedAt,
      durationMs: Date.now() - startedAt,
      // K9（X55）：子 agent 读过网页 / 浏览器内容，它交回的报告就带着外部内容——随结果交给父会话
      ...(state.externalContentSeen ? { externalContent: true } : {}),
      ...(notes.length ? { notes } : {}),
      ...(worktree ? { worktree } : {}),
      ...(o.rec ? { resumable: true } : {}),
    };
    emit?.({
      e: "subagent_end", id, ok: result.ok, error: result.error, turns: result.turns, toolCalls,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      text: text.slice(0, EVENT_TEXT_CAP), result: holder?.value, durationMs: result.durationMs,
      // 子 agent 面板：改过哪些文件、没做完的原因（历史走 tool_result.meta.subagent 的同名字段）
      ...(result.editedFiles.length ? { editedFiles: result.editedFiles } : {}),
      ...(stopReason !== "completed" ? { stopReason } : {}),
    });
    return result;
  }

  const labelOf = (req: SubAgentRequest) => (req.label?.trim() || firstLine(req.prompt) || "sub-agent").slice(0, 80);
  const newRecord = (id: string, label: string, req: SubAgentRequest, background: boolean): AgentRecord => ({
    id, owner, label, type: req.context === "fork" ? "fork" : req.type?.trim() || (req.tier === "coder" ? "coder" : "research"),
    tier: req.tier === "coder" ? "coder" : "research", background, status: "running", startedAt: Date.now(), runs: 0,
    ctrl: null, done: null, inbox: [],
  });
  // 后台子 agent 的实况事件：送到父会话此刻挂着的事件口（父会话这一轮跑着才有；收工之后的实况不发，结局随卡片记录更新）
  const liveEmit = (fallback?: (ev: AgentEvent) => void) => (env.parent ? (ev: AgentEvent) => env.parent!()?.ctx.emit?.(ev) : fallback);

  async function run(req: SubAgentRequest): Promise<SubAgentResult> {
    const id = req.id ?? newId();
    const label = labelOf(req);
    // Agent 工具起的记进台账（可以接着用）；工作流里的 agent() 不记
    const rec = req.workflowId ? undefined : newRecord(id, label, req, false);
    if (rec) registerAgent(rec);
    const prepared = await prepare(req, id, label);
    if ("error" in prepared) {
      if (rec) dropAgent(owner, id);
      return bail(id, label, req, prepared, req.onEvent);
    }
    if (rec) {
      rec.child = prepared;
      rec.type = prepared.type;
      rec.tier = prepared.tier;
    }
    const r = await drive(prepared, req.prompt, {
      signal: req.signal, onEvent: req.onEvent, toolId: req.toolId, phase: req.phase, workflowId: req.workflowId, rec,
      maxTurns: req.maxTurns, deadlineMs: req.deadlineMs, onSuspend: req.onSuspend,
    });
    if (rec) settleAgent(rec, r);
    return r;
  }

  // 后台跑：先登记、立刻返回；准备（选型、建 worktree）与运行都在后面
  function background(rec: AgentRecord, req: SubAgentRequest, work: (signal: AbortSignal, emit?: (ev: AgentEvent) => void) => Promise<SubAgentResult>): SubAgentStarted {
    const outer = new AbortController();
    rec.ctrl = outer;
    rec.status = "running";
    rec.background = true;
    rec.stoppedBy = undefined;
    rec.closing = false;
    const emit = liveEmit(req.onEvent);
    const fail = (e: unknown): SubAgentResult => ({
      ok: false, id: rec.id, label: rec.label, tier: rec.tier, model: env.model, provider: env.provider, text: "",
      error: `sub-agent threw: ${(e as Error)?.message ?? String(e)}`, stopReason: "provider_error",
      turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, editedFiles: [], trail: [], startedAt: rec.startedAt, durationMs: 0,
    });
    rec.done = work(outer.signal, emit)
      .catch(fail)
      .then((r) => {
        const cause = rec.stoppedBy;
        settleAgent(rec, r);
        try {
          env.onBackgroundEnd?.({ id: rec.id, toolId: req.toolId, prompt: req.prompt, result: r, ...(cause ? { cause } : {}), schema: Boolean(req.schema) });
        } catch (e) {
          console.error(`[subagent] background end hook: ${(e as Error).message}`);
        }
        return r;
      });
    return { id: rec.id, label: rec.label };
  }

  const control: SubAgentControl = {
    start(req) {
      if (runningBackground(owner) >= MAX_BACKGROUND) {
        return { error: `${MAX_BACKGROUND} background sub-agents are already running in this session. Wait for one to finish (its report arrives as a notification) or stop one with Agent(action:"stop", id).` };
      }
      const id = newId();
      const label = labelOf(req);
      const rec = newRecord(id, label, req, true);
      registerAgent(rec);
      return background(rec, req, async (signal, emit) => {
        const prepared = await prepare(req, id, label);
        if ("error" in prepared) {
          dropAgent(owner, id);
          return bail(id, label, req, prepared, emit, req.toolId, true);
        }
        rec.child = prepared;
        rec.type = prepared.type;
        rec.tier = prepared.tier;
        return drive(prepared, req.prompt, { signal, onEvent: emit, toolId: req.toolId, rec, maxTurns: req.maxTurns, deadlineMs: req.deadlineMs });
      });
    },

    resume(id, prompt, opts) {
      const rec = getAgent(owner, id);
      if (!rec) {
        return { error: `No sub-agent "${id}" in this session. Contexts of the ${MAX_KEPT} most recent sub-agents are kept in memory and are lost when the server restarts — start a new one with the full task.` };
      }
      if (rec.status === "running") {
        if (rec.closing) {
          return { error: `Sub-agent ${rec.id} is finishing up and no longer reads messages; its report is on the way. Send this again with Agent(id, prompt) after it arrives.` };
        }
        const child = rec.child as Child | undefined;
        if (child) child.state.queueFamily(agentMessage(prompt), AGENT_MESSAGE_KIND);
        else rec.inbox.push(agentMessage(prompt));
        return { queued: `Sent to ${rec.id}, which is still running; it reads the message at its next step.` };
      }
      const child = rec.child as Child | undefined;
      if (!child) return { error: `The context of sub-agent "${rec.id}" is no longer available; start a new one with the full task.` };
      const req: SubAgentRequest = { prompt, toolId: opts.toolId, onEvent: opts.onEvent };
      const go = async (signal: AbortSignal | undefined, emit?: (ev: AgentEvent) => void): Promise<SubAgentResult> => {
        if (child.worktree) {
          const wt = await reopenWorktree(child.worktree, env.ownerId);
          if ("error" in wt) return bail(rec.id, rec.label, req, { error: `its worktree could not be recreated: ${wt.error}`, model: child.target.model, provider: child.target.provider, tier: child.tier }, emit, opts.toolId, rec.background);
          child.worktree = wt;
        }
        return drive(child, prompt, { signal, onEvent: emit, toolId: opts.toolId, rec });
      };
      if (opts.background) {
        if (runningBackground(owner) >= MAX_BACKGROUND) {
          return { error: `${MAX_BACKGROUND} background sub-agents are already running in this session; wait for one or stop one first.` };
        }
        return background(rec, req, go);
      }
      rec.status = "running";
      rec.background = false;
      rec.stoppedBy = undefined;
      rec.closing = false;
      return go(opts.signal, opts.onEvent).then((r) => {
        settleAgent(rec, r);
        return r;
      });
    },

    list() {
      const all = listAgents(owner);
      if (!all.length) return "No sub-agents in this session yet.";
      return `${all.map((r) => describeAgent(r)).join("\n")}\nAgent(id, prompt) continues one in its own context; Agent(action:"stop", id) stops a running one.`;
    },

    stop(id) {
      const rec = getAgent(owner, id);
      if (!rec) return { ok: false, message: `No sub-agent "${id}" in this session.` };
      if (!stopAgent(rec, "model")) return { ok: false, message: `Sub-agent ${rec.id} is not running (${rec.status}).` };
      return { ok: true, message: `Stopping ${rec.id} (${rec.label}); it ends at its next step.${rec.background ? " No notification follows for it." : ""}` };
    },
  };

  return { run, control };
}

// 只要前台运行的地方（测试、旧调用方）：同一个 host 的 run
export function makeSubAgentRunner(
  env: SubAgentEnv,
  adapterFactory: (cfg: AdapterConfig) => ProviderAdapter = createAdapter,
): (req: SubAgentRequest) => Promise<SubAgentResult> {
  return makeSubAgentHost(env, adapterFactory).run;
}
