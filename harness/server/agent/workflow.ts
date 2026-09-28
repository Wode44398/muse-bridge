import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { AgentEvent, WorkflowPhaseMeta } from "./events.ts";
import type { ThinkingLevel } from "./turn.ts";
import type {
  SubAgentRequest,
  SubAgentResult,
  SubAgentTrailStep,
  WorkflowAgentSummary,
  WorkflowRequest,
  WorkflowResult,
} from "../tools/types.ts";
import { normalizeObjectSchema } from "./schema.ts";
import { atomicWriteFile } from "../atomic-write.ts";

// Workflow executor: a deterministic JavaScript script orchestrates many
// sub-agents (fan-out, pipelines, loops) instead of the model driving each
// step by hand. Split in two:
//   workflow-sandbox.ts — runs the script (a locked-down child process + vm)
//                         and turns every agent()/phase()/log() into a message;
//   this file          — owns everything with side effects: the sub-agent
//                        runner, the concurrency gate, agent/token caps, the
//                        abort/deadline, the journal (resume), and the event
//                        stream the UI renders.
//
// Journal: each completed agent() call is stored under a key derived from
// (prompt, opts) plus its occurrence index, so a resumed run answers unchanged
// calls from the journal instantly and only runs the edited/new ones.

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases: WorkflowPhaseMeta[];
}

export interface WorkflowLimits {
  maxConcurrency: number;
  maxAgents: number;
  tokenBudget: number;
  deadlineMs: number;
}

export const WORKFLOW_DEFAULTS: WorkflowLimits = {
  maxConcurrency: 3,
  maxAgents: 60,
  tokenBudget: 8_000_000,
  deadlineMs: 60 * 60_000,
};
const LIMIT_CAPS: WorkflowLimits = {
  maxConcurrency: 8,
  maxAgents: 300,
  tokenBudget: 50_000_000,
  deadlineMs: 6 * 60 * 60_000,
};
// R18（hermes HM08）：到时限只是「软停」——不再派新 agent（还没开始的 agent() 返回 null，和失败的 agent 同一约定，
// 脚本照常拿着已有结果收尾），已在跑的再给这么久跑完；超了才整个中止。以前到点直接 abort，做了一半的 agent 全扔了，
// 和默认规模（60 个 agent、coder 各 30 分钟、并发 3）自相矛盾。
export const DEADLINE_GRACE_MS = 10 * 60_000;
const FINISH_AFTER_DEADLINE_MS = 30_000; // 到点后最后一个在跑的 agent 也完了，脚本还有这么久收尾
const RESULT_CAP = 200_000; // chars of JSON kept for the result value
const LOG_CAP = 300;
const ID_RE = /^wf_[a-z0-9]{6,32}$/;
const DETAIL_TEXT_CAP = 4_000;
const DETAIL_RESULT_CAP = 20_000;

// Note appended to every workflow agent's system prompt: its output is data.
const WORKFLOW_AGENT_NOTE =
  "You are one step of an automated workflow script. Your deliverable is consumed by code, not read by a person: " +
  "return raw data in the shape the task asks for (no greeting, no preamble, no markdown decoration unless asked).";

// ── meta extraction (static: no script execution) ───────────────────────────

// Find the `export const meta = { … }` statement and return the literal's
// span. Balanced-brace scan that skips strings, template literals and comments.
function findMetaLiteral(script: string): { start: number; end: number; exportAt: number } | null {
  const m = /(^|\n)[ \t]*export\s+const\s+meta\s*=\s*/.exec(script);
  if (!m) return null;
  const exportAt = m.index + m[1].length;
  const start = m.index + m[0].length;
  if (script[start] !== "{") return null;
  let depth = 0;
  let i = start;
  while (i < script.length) {
    const c = script[i];
    if (c === "/" && script[i + 1] === "/") {
      i = script.indexOf("\n", i);
      if (i < 0) return null;
      continue;
    }
    if (c === "/" && script[i + 1] === "*") {
      const close = script.indexOf("*/", i + 2);
      if (close < 0) return null;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < script.length && script[i] !== c) {
        if (script[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1, exportAt };
    }
    i++;
  }
  return null;
}

// Evaluate the literal on its own in a bare context (no host globals, tiny
// timeout). Anything that is not a pure literal — variables, calls into the
// script — simply fails to evaluate there, which is exactly the contract.
function evalLiteral(literal: string): unknown {
  return vm.runInNewContext(`(${literal})`, {}, { timeout: 200 });
}

export function extractWorkflowMeta(
  script: string,
): { ok: true; meta: WorkflowMeta; body: string } | { ok: false; error: string } {
  if (typeof script !== "string" || !script.trim()) return { ok: false, error: "script is empty" };
  const span = findMetaLiteral(script);
  if (!span) {
    return { ok: false, error: "script must begin with `export const meta = { name, description, phases? }` (a pure object literal)" };
  }
  let raw: unknown;
  try {
    raw = evalLiteral(script.slice(span.start, span.end));
  } catch (e) {
    return { ok: false, error: `meta must be a pure literal (no variables, calls or interpolation): ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "meta must be an object literal" };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 80) : "";
  const description = typeof r.description === "string" ? r.description.trim().slice(0, 300) : "";
  if (!name) return { ok: false, error: "meta.name (string) is required" };
  if (!description) return { ok: false, error: "meta.description (string) is required" };
  const phases: WorkflowPhaseMeta[] = [];
  if (r.phases !== undefined) {
    if (!Array.isArray(r.phases)) return { ok: false, error: "meta.phases must be an array of { title, detail? }" };
    for (const p of r.phases) {
      const title = typeof (p as { title?: unknown })?.title === "string" ? String((p as { title: string }).title).trim() : "";
      if (!title) return { ok: false, error: "every meta.phases entry needs a string title" };
      const detail = (p as { detail?: unknown }).detail;
      const model = (p as { model?: unknown }).model;
      phases.push({
        title: title.slice(0, 120),
        ...(typeof detail === "string" ? { detail: detail.slice(0, 300) } : {}),
        ...(typeof model === "string" ? { model } : {}),
      });
    }
  }
  const meta: WorkflowMeta = {
    name,
    description,
    ...(typeof r.whenToUse === "string" ? { whenToUse: r.whenToUse.slice(0, 300) } : {}),
    phases,
  };
  // `export` cannot appear inside the async wrapper the worker builds; keep
  // the declaration itself so the script can still read `meta`.
  const body = script.slice(0, span.exportAt) + script.slice(span.exportAt).replace(/^export\s+/, "");
  return { ok: true, meta, body };
}

// O5（H3）：沙箱子进程执行脚本时的包装。沙箱只被允许读它自己那一个入口文件（--allow-fs-read），不能 import 这里——
// workflow-sandbox.ts 里是逐字同一份，workflow-precompile.test.ts 核对两处一致（行号换算靠它对得上）。
export const WORKFLOW_WRAP_PREFIX = "(async () => {\n";
export const wrapWorkflowBody = (body: string): string => `${WORKFLOW_WRAP_PREFIX}${body}\n})()`;

// O5（H3）：弹确认卡之前先只编译、不执行——编不过就直接把诊断还给模型，不让用户在手机上批准一段根本跑不起来的脚本。
// 行号按用户写的脚本算（扣掉包装的一行，再加回 meta 之前被剥掉的 `export ` 不影响行号）。
export function compileWorkflowBody(body: string): { ok: true } | { ok: false; line?: number; message: string; snippet?: string } {
  try {
    new vm.Script(wrapWorkflowBody(body), { filename: "workflow.js" });
    return { ok: true };
  } catch (e) {
    const err = e as Error;
    const at = /workflow\.js:(\d+)/.exec(String(err.stack ?? ""));
    const wrappedLine = at ? Number(at[1]) : undefined;
    const line = wrappedLine !== undefined ? wrappedLine - 1 : undefined; // 包装占了第 1 行
    const snippet = line !== undefined && line >= 1 ? body.split(/\r?\n/)[line - 1]?.trim().slice(0, 200) : undefined;
    return { ok: false, message: `${err.name}: ${err.message}`, ...(line !== undefined && line >= 1 ? { line } : {}), ...(snippet ? { snippet } : {}) };
  }
}

// ── journal ─────────────────────────────────────────────────────────────────

interface JournalEntry {
  key: string;
  label: string;
  phase?: string;
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  at: number;
  // O4：coder 条目——它改过的文件在它做完那一刻的内容哈希（文件不在 = null）。续跑时磁盘对得上才回放。
  edited?: { path: string; hash: string | null }[];
  // K9（X55）：这个 agent 读过外部内容（网页 / 浏览器）。续跑回放它的结果时，父会话照样要被标上。
  external?: true;
}

// O4（H5）：回放的副作用安全。续跑时从日志回放 coder 条目，等于断言「它改的那些文件现在还是它改完的样子」——检查点回滚、
// 用户手改、上一次续跑里别的 coder 都可能让这句话不成立，脚本却照着一个不存在的状态往下走。所以：coder 条目只有它改过的文件
// 哈希全对得上才回放；这次续跑里一旦有 coder 真跑并写了文件，之后的 coder 条目一律不再回放（只放行 research 条目）；旧日志里
// 没记改动的 coder 条目核对不了，也重跑。
function fileHash(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function replayBlocker(hit: JournalEntry, coder: boolean, liveWrites: boolean): string | null {
  if (!coder) return null;
  if (liveWrites) return "a coder agent already wrote files live in this run, so coder results from the journal no longer describe the disk";
  if (!hit.edited) return "the journal entry has no record of the files it edited, so its effect on disk cannot be checked";
  const changed = hit.edited.filter((e) => fileHash(e.path) !== e.hash).map((e) => e.path);
  if (!changed.length) return null;
  return `files it edited have changed since (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""})`;
}

interface Journal {
  v: 1;
  id: string;
  name: string;
  createdAt: number;
  resumedFrom?: string;
  scriptHash: string;
  args?: unknown;
  entries: JournalEntry[];
  ok?: boolean;
  error?: string;
  result?: unknown;
  finishedAt?: number;
  // agentId → what that agent did; not used by resume (entries are).
  agents?: Record<string, WorkflowAgentDetail>;
  // O1（#9）：发起它的 Workflow 工具调用 id，与已开跑的 agent() 调用数。进程死在中途时，恢复路径凭 toolId
  // 找回这份 journal，如实告诉模型「完成 N/M，用 resumeFromRunId 只跑剩下的」。
  toolId?: string;
  startedAgents?: number;
}

function journalFile(dir: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  return path.join(dir, `${id}.json`);
}

function loadJournal(dir: string, id: string): Journal | null {
  const file = journalFile(dir, id);
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
    return j && j.v === 1 && Array.isArray(j.entries) ? j : null;
  } catch {
    return null;
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// O1（#9）：按发起它的工具调用 id 找一次 Workflow 运行（只看最近的一批 journal）。finished=false 表示
// 没跑完就断了——进程死在中途，或还在跑。
export function findWorkflowRunByToolId(
  dir: string,
  toolId: string,
): { id: string; completed: number; started: number; finished: boolean } | undefined {
  let files: { name: string; at: number }[];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 200);
  } catch {
    return undefined;
  }
  for (const { name } of files) {
    const j = loadJournal(dir, name.slice(0, -5));
    if (!j || j.toolId !== toolId) continue;
    return { id: j.id, completed: j.entries.length, started: j.startedAgents ?? j.entries.length, finished: j.finishedAt !== undefined };
  }
  return undefined;
}

// Per-agent detail (prompt, tool trail, answer) for the task panel's transcript
// view. Lives in the journal file, not in the transcript's tool_result meta: a
// 16-agent run's trails would bloat every session load, and the panel only
// needs one agent's detail when someone opens it
// (GET /api/sessions/:id/workflows/:wfId).
export interface WorkflowAgentDetail {
  label: string;
  phase?: string;
  tier: string;
  model: string;
  provider: string;
  ok: boolean;
  cached: boolean;
  error?: string;
  prompt: string;
  text: string;
  result?: unknown;
  trail: SubAgentTrailStep[];
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  durationMs: number;
}

function detailResult(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return (JSON.stringify(v) ?? "").length <= DETAIL_RESULT_CAP ? v : undefined;
  } catch {
    return undefined;
  }
}

export function loadWorkflowDetail(
  dir: string,
  id: string,
): { id: string; name: string; agents: Record<string, WorkflowAgentDetail> } | null {
  const j = loadJournal(dir, id);
  return j ? { id: j.id, name: j.name, agents: j.agents ?? {} } : null;
}

// Canonical JSON (sorted keys) so `{a,b}` and `{b,a}` opts hash the same.
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

// ── agent() option parsing ──────────────────────────────────────────────────

interface AgentOpts {
  label?: string;
  phase?: string;
  tools: "research" | "coder";
  schema?: ReturnType<typeof normalizeObjectSchema>;
  model?: string;
  effort?: ThinkingLevel;
  maxTurns?: number;
  system?: string;
}

const EFFORTS: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];

function parseAgentOpts(raw: unknown): AgentOpts | { error: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: AgentOpts = { tools: o.tools === "coder" ? "coder" : "research" };
  if (o.label !== undefined) out.label = String(o.label).slice(0, 80);
  if (o.phase !== undefined) out.phase = String(o.phase).slice(0, 120);
  if (o.schema !== undefined && o.schema !== null) {
    const s = normalizeObjectSchema(o.schema);
    if (!s) return { error: "opts.schema must be a JSON object schema ({type:\"object\", properties, required?})" };
    out.schema = s;
  }
  if (o.model !== undefined) out.model = String(o.model);
  if (o.effort !== undefined) {
    const e = String(o.effort).toLowerCase();
    const mapped = e === "xhigh" ? "max" : e;
    if (!(EFFORTS as string[]).includes(mapped)) return { error: `opts.effort must be one of ${EFFORTS.join("/")}` };
    out.effort = mapped as ThinkingLevel;
  }
  if (o.maxTurns !== undefined) {
    const n = Number(o.maxTurns);
    if (!Number.isFinite(n) || n <= 0) return { error: "opts.maxTurns must be a positive number" };
    out.maxTurns = Math.floor(n);
  }
  if (o.system !== undefined) out.system = String(o.system).slice(0, 4000);
  return out;
}

// ── concurrency gate ────────────────────────────────────────────────────────

// O2（KM-1）：自适应并发闸（run 内 AIMD）。起步先放 RAMP_BURST 个，之后每 RAMP_STEP_MS 再放一个（不一下子打满限流 / 本机
// slot 有限的端点）；子 agent 因限流挂起就缩一格（每 SHRINK_EVERY_MS 最多缩一次，至少留 1）；连续 GROW_AFTER_MS 没有挂起
// 就加回一格，直到回到原来的上限——能复位（kimi 的限流模式不复位是个缺陷）。
export const GATE_TIMING = { rampBurst: 4, rampStepMs: 700, shrinkEveryMs: 2_000, growAfterMs: 180_000 };

export class AdaptiveGate {
  private queue: Array<() => void> = [];
  private active = 0;
  private started = 0;
  private lastStart = 0;
  private lastShrink = 0;
  private lastChange = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly max: number;
  limit: number;
  // No TS parameter properties: node runs these files in strip-only mode.
  constructor(max: number) {
    this.max = Math.max(1, max);
    this.limit = this.max;
  }
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("workflow aborted"));
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.queue = this.queue.filter((g) => g !== grant);
        reject(new Error("workflow aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
      this.pump();
    });
  }
  release(): void {
    this.active--;
    this.pump();
  }
  // 有子 agent 因限流 / 过载挂起了
  suspended(): void {
    const now = Date.now();
    this.lastChange = now;
    if (this.limit > 1 && now - this.lastShrink >= GATE_TIMING.shrinkEveryMs) {
      this.limit--;
      this.lastShrink = now;
    }
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private pump(): void {
    const now = Date.now();
    if (this.limit < this.max && now - this.lastChange >= GATE_TIMING.growAfterMs) {
      this.limit++;
      this.lastChange = now;
    }
    while (this.queue.length && this.active < this.limit) {
      const since = Date.now() - this.lastStart;
      if (this.started >= GATE_TIMING.rampBurst && since < GATE_TIMING.rampStepMs) {
        this.later(GATE_TIMING.rampStepMs - since);
        return;
      }
      this.active++;
      this.started++;
      this.lastStart = Date.now();
      this.queue.shift()!();
    }
  }
  private later(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, ms);
    this.timer.unref?.();
  }
}

// O2：这几类 provider 错误等多久都没用（key 无效 / 额度用完 / 出口被拒），不当成「这个 agent 没结果」交给脚本（null 会被
// filter(Boolean) 静默吃掉），而是整个 Workflow 停下、说清楚；修好之后原样重跑同一个 Workflow，做完的 agent 从日志里回放。
const STOP_CLASSES = new Set(["auth", "billing", "egress_blocked"]);

// ── runner ──────────────────────────────────────────────────────────────────

export interface WorkflowRunnerDeps {
  runSubAgent: (req: SubAgentRequest) => Promise<SubAgentResult>;
  journalDir: string;
  defaults?: Partial<WorkflowLimits>;
}

function cleanLimits(base: WorkflowLimits, patch?: Partial<WorkflowLimits>): WorkflowLimits {
  const out = { ...base };
  for (const k of Object.keys(LIMIT_CAPS) as (keyof WorkflowLimits)[]) {
    const v = patch?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.min(Math.floor(v), LIMIT_CAPS[k]);
  }
  return out;
}

function capResult(value: unknown): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value: undefined, truncated: false };
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { value: String(value).slice(0, RESULT_CAP), truncated: true };
  }
  if (json.length <= RESULT_CAP) return { value, truncated: false };
  return { value: json.slice(0, RESULT_CAP), truncated: true };
}

// S2 根治（#35）：脚本跑在独立子进程里（workflow-sandbox.ts）。vm 不是安全边界——经注入的宿主函数
// `.constructor` 就能摸回宿主 realm，所以边界放在进程上：Node 权限模型只许读入口文件（读写别的文件、起子进程、
// 起线程、加载原生扩展一律拒），--disallow-code-generation-from-strings 让 .constructor 那条老路在源头失败，
// env 不带凭据（provider key、bridge 注入的内部令牌都不给）——只留几个不敏感的系统变量，Node 自己会读
// （os.tmpdir() 缺 TEMP/SYSTEMROOT 会拼出 undefined\temp）。子进程起不了子进程，它自己就是整棵树。
// 没管住的：网络（Node 24 的权限模型没有网络开关）。子进程里没有任何凭据，本机的控制面也都要令牌。
const SANDBOX_ENV_KEYS = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"] as const;
const SANDBOX_ENTRY = fileURLToPath(new URL("./workflow-sandbox.ts", import.meta.url));
const SANDBOX_HEAP_MB = 512;

export function workflowSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export function workflowSandboxArgs(entry = SANDBOX_ENTRY): string[] {
  return ["--permission", `--allow-fs-read=${entry}`, "--disallow-code-generation-from-strings", `--max-old-space-size=${SANDBOX_HEAP_MB}`, entry];
}

// 脚本宿主：主进程这一侧只用得到收发消息、出错、退出、收掉这几样。
interface ScriptHost {
  onMessage(fn: (m: { t: string; [k: string]: unknown }) => void): void;
  onError(fn: (e: Error) => void): void;
  onExit(fn: (code: number | null, stderr: string) => void): void;
  post(m: unknown): void;
  terminate(): Promise<void>;
}

// 起一个脚本进程：它挂好监听后先报 ready，这边再把脚本发过去（不在监听之前发，免得丢）。
export function startWorkflowSandbox(data: unknown): ScriptHost {
  const child: ChildProcess = spawn(process.execPath, workflowSandboxArgs(), {
    env: workflowSandboxEnv(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 4_000) stderr += d.toString("utf8");
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const messageFns: ((m: { t: string; [k: string]: unknown }) => void)[] = [];
  child.on("message", (m: { t: string; [k: string]: unknown }) => {
    if (m?.t === "ready") {
      child.send({ t: "start", data });
      return;
    }
    for (const fn of messageFns) fn(m);
  });
  return {
    onMessage: (fn) => void messageFns.push(fn),
    onError: (fn) => void child.on("error", fn),
    onExit: (fn) => void child.on("exit", (code) => fn(code, stderr.trim().slice(-1_000))),
    post: (m) => {
      if (child.connected) child.send(m as Parameters<ChildProcess["send"]>[0]);
    },
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) {
        // guard: raw-child-kill ok — 权限模型拒了 child_process，这个进程起不了子进程，它自己就是整棵树
        child.kill();
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000).unref())]);
    },
  };
}

export function makeWorkflowRunner(deps: WorkflowRunnerDeps): (req: WorkflowRequest) => Promise<WorkflowResult> {
  const base = cleanLimits(WORKFLOW_DEFAULTS, deps.defaults);

  return async function runWorkflow(req: WorkflowRequest): Promise<WorkflowResult> {
    const startedAt = Date.now();
    const id = `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const emit = req.onEvent;
    const limits = cleanLimits(base, req.limits);
    const journalPath = journalFile(deps.journalDir, id)!;

    const fail = (error: string, meta?: WorkflowMeta, extra?: Partial<WorkflowResult>): WorkflowResult => ({
      ok: false,
      id,
      name: meta?.name ?? "",
      description: meta?.description ?? "",
      phases: meta?.phases ?? [],
      error,
      agents: [],
      cached: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
      logs: [],
      journalPath,
      ...extra,
    });

    const parsed = extractWorkflowMeta(req.script);
    if (!parsed.ok) return fail(parsed.error);
    const { meta, body } = parsed;

    // Resume: prior journal → cache keyed by call hash.
    const cache = new Map<string, JournalEntry>();
    let liveWrites = false; // O4：这次运行里已经有 coder 真跑并写了文件
    if (req.resumeFromRunId) {
      const prev = loadJournal(deps.journalDir, req.resumeFromRunId);
      if (!prev) return fail(`unknown or unreadable workflow run to resume: ${req.resumeFromRunId}`, meta);
      for (const e of prev.entries) cache.set(e.key, e);
    }

    const journal: Journal = {
      v: 1,
      id,
      name: meta.name,
      createdAt: startedAt,
      ...(req.resumeFromRunId ? { resumedFrom: req.resumeFromRunId } : {}),
      scriptHash: sha(req.script),
      args: req.args,
      entries: [],
      agents: {},
      ...(req.toolId ? { toolId: req.toolId } : {}),
      startedAgents: 0,
    };
    let persistQueue: Promise<void> = Promise.resolve();
    const persist = () => {
      let data: string;
      try {
        data = JSON.stringify(journal);
      } catch {
        return;
      }
      persistQueue = persistQueue
        .then(() => atomicWriteFile(journalPath, data)) // M6：唯一临时名 + fsync
        .catch((e) => console.error(`[workflow] journal write: ${(e as Error).message}`));
    };
    // O1：一开跑就写 journal 头——以前要等第一个 agent 跑完才第一次落盘，死在那之前就无迹可寻。
    persist();

    const wf = new AbortController();
    let deadlineHit = false; // R18：到了时限（软停：不再派新 agent）
    let hardStopWhy = ""; // R18：硬停的原因（到点时没有在跑的 / 宽限用完 / 在跑的都完了脚本还不收尾）
    let skipped = 0; // R18：因为到时限没开始的 agent() 调用
    let running = 0;
    let providerStop: string | null = null; // O2：因为 key / 额度 / 出口被拒整个停下时的说明
    const abortReason = () => providerStop ?? (hardStopWhy || "workflow aborted");
    const hardStop = (why: string) => {
      if (hardStopWhy || wf.signal.aborted) return;
      hardStopWhy = why;
      wf.abort();
    };
    const onParentAbort = () => wf.abort();
    if (req.signal?.aborted) wf.abort();
    else req.signal?.addEventListener("abort", onParentAbort, { once: true });
    let grace: ReturnType<typeof setTimeout> | undefined;
    const armGrace = (ms: number, why: string) => {
      clearTimeout(grace);
      grace = setTimeout(() => hardStop(why), ms);
      grace.unref?.();
    };
    // 宽限不超过时限本身（5 分钟的工作流不会再等 10 分钟）
    const graceMs = Math.min(DEADLINE_GRACE_MS, limits.deadlineMs);
    const finishMs = Math.min(FINISH_AFTER_DEADLINE_MS, limits.deadlineMs);
    const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1_000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
    const deadline = setTimeout(() => {
      deadlineHit = true;
      // 没有在跑的 agent：没什么可等的（脚本多半卡住了），立刻停
      if (running === 0) {
        hardStop("workflow deadline exceeded");
        return;
      }
      log(
        `deadline reached (${minutes(limits.deadlineMs)}): no new agents start — agent() returns null from now on; ` +
          `${running} running agent(s) get up to ${minutes(graceMs)} more to finish`,
      );
      armGrace(graceMs, `workflow deadline exceeded (the running agents did not finish within the ${minutes(graceMs)} grace period)`);
    }, limits.deadlineMs);
    // 到点之后在跑的都完了：脚本拿着结果该收尾了，再给它一小会儿
    const afterLastRunning = () => {
      if (deadlineHit && running === 0) armGrace(finishMs, "workflow deadline exceeded (the script did not finish after its last running agent)");
    };
    // 没开始就碰上时限的 agent() 调用：记一笔、返回 null（不抛——脚本里的 Promise.all 不至于整个失败、把在跑的一起中止）
    const skipForDeadline = (label: string): null => {
      skipped++;
      if (skipped <= 3) log(`agent "${label}" not started: workflow deadline reached`);
      return null;
    };

    const sem = new AdaptiveGate(limits.maxConcurrency);
    const summaries: WorkflowAgentSummary[] = [];
    const logs: string[] = [];
    const keyCounts = new Map<string, number>();
    let agentSeq = 0;
    let cachedCount = 0;
    let inTok = 0;
    let outTok = 0;
    let currentPhase: string | undefined;
    const spent = () => inTok + outTok;

    const log = (text: string) => {
      const t = text.slice(0, 2000);
      if (logs.length < LOG_CAP) logs.push(t);
      emit?.({ e: "workflow_log", id, text: t });
    };

    emit?.({
      e: "workflow_start", id, name: meta.name, description: meta.description, phases: meta.phases,
      toolId: req.toolId, resumedFrom: req.resumeFromRunId, startedAt,
    });

    // One agent() call from the script → one sub-agent run (or a journal hit).
    // Throws only for hard stops (abort, caps); a failed agent resolves null so
    // the script can `.filter(Boolean)` like the authoring guide says.
    async function handleAgent(promptRaw: unknown, optsRaw: unknown): Promise<unknown> {
      if (typeof promptRaw !== "string" || !promptRaw.trim()) throw new Error("agent(): prompt must be a non-empty string");
      const prompt = promptRaw;
      if (wf.signal.aborted) throw new Error(abortReason());
      // R18：到了时限就不再开新 agent——排在额度检查前面：没开始的调用不占「每个工作流最多几个 agent」的额度
      if (deadlineHit) return skipForDeadline(typeof (optsRaw as { label?: unknown })?.label === "string" ? String((optsRaw as { label: string }).label) : prompt.slice(0, 40));
      if (agentSeq >= limits.maxAgents) throw new Error(`agent cap reached (${limits.maxAgents} agents per workflow)`);
      if (limits.tokenBudget && spent() >= limits.tokenBudget) {
        throw new Error(`token budget exhausted (${spent()} of ${limits.tokenBudget})`);
      }
      const opts = parseAgentOpts(optsRaw);
      if ("error" in opts) throw new Error(`agent(): ${opts.error}`);
      const seq = agentSeq++;
      journal.startedAgents = agentSeq;
      persist();
      const agentId = `${id}:${seq}`;
      const label = opts.label ?? `agent ${seq + 1}`;
      const phase = opts.phase ?? currentPhase;
      const baseKey = sha(canonical({ prompt, opts: { ...opts, label: undefined, phase: undefined } }));
      const nth = keyCounts.get(baseKey) ?? 0;
      keyCounts.set(baseKey, nth + 1);
      const key = `${baseKey}#${nth}`;

      const cached = cache.get(key);
      const blocked = cached ? replayBlocker(cached, opts.tools === "coder", liveWrites) : null;
      if (cached && blocked) log(`agent "${label}": not replayed from the journal — ${blocked}; running it again`);
      const hit = blocked ? undefined : cached;
      if (hit) {
        cachedCount++;
        const now = Date.now();
        const model = opts.model ?? "";
        summaries.push({
          id: agentId, label, phase, ok: true, cached: true, inputTokens: 0, outputTokens: 0,
          tier: opts.tools, model, turns: 0, toolCalls: 0, startedAt: now, durationMs: 0,
          ...(hit.external ? { externalContent: true } : {}),
        });
        journal.entries.push({ ...hit, label, phase, at: now });
        journal.agents![agentId] = {
          label, phase, tier: opts.tools, model, provider: "", ok: true, cached: true,
          prompt: prompt.slice(0, DETAIL_TEXT_CAP),
          text: typeof hit.value === "string" ? hit.value.slice(0, DETAIL_TEXT_CAP) : "",
          result: typeof hit.value === "string" ? undefined : detailResult(hit.value),
          trail: [], turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, startedAt: now, durationMs: 0,
        };
        persist();
        emit?.({
          e: "subagent_start", id: agentId, label, tier: opts.tools, model, provider: "",
          prompt: prompt.slice(0, 4000), phase, workflowId: id, cached: true, startedAt: now,
        });
        emit?.({
          e: "subagent_end", id: agentId, ok: true, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
          text: typeof hit.value === "string" ? hit.value.slice(0, 20_000) : "",
          result: typeof hit.value === "string" ? undefined : hit.value, cached: true, durationMs: 0,
        });
        return hit.value;
      }

      // R18：排队等并发名额时到了时限——同样不开
      await sem.acquire(wf.signal);
      if (deadlineHit) {
        sem.release();
        return skipForDeadline(label);
      }
      running++;
      const began = Date.now(); // after the gate: queue time is not the agent's time
      let r: SubAgentResult;
      // A runner that THROWS (as opposed to returning ok:false) is still one
      // failed agent call: record it like any other failure instead of letting
      // it vanish from the summary.
      const thrown = (e: unknown): SubAgentResult => ({
        ok: false, id: agentId, label, tier: opts.tools, model: opts.model ?? "", provider: "",
        text: "", error: `runner threw: ${(e as Error)?.message ?? String(e)}`,
        turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, editedFiles: [], trail: [],
      });
      try {
        r = await deps.runSubAgent({
          prompt,
          tier: opts.tools,
          label,
          phase,
          model: opts.model,
          thinking: opts.effort,
          maxTurns: opts.maxTurns,
          schema: opts.schema ?? undefined,
          system: [WORKFLOW_AGENT_NOTE, opts.system].filter(Boolean).join("\n\n"),
          signal: wf.signal,
          onEvent: emit,
          id: agentId,
          workflowId: id,
          onSuspend: () => sem.suspended(),
        });
      } catch (e) {
        r = thrown(e);
      } finally {
        running--;
        sem.release();
        afterLastRunning();
      }
      inTok += r.inputTokens;
      outTok += r.outputTokens;
      if (r.editedFiles.length) liveWrites = true; // O4：成没成都算——失败的 coder 也可能写了一半
      const startedAt = r.startedAt ?? began;
      const durationMs = r.durationMs ?? Date.now() - began;
      summaries.push({
        id: agentId, label, phase, ok: r.ok, cached: false, error: r.error,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        tier: r.tier, model: r.model, turns: r.turns, toolCalls: r.toolCalls, startedAt, durationMs,
        // V5：coder 改过的文件，父会话的验证门禁要算进去（成没成都算）
        ...(r.editedFiles.length ? { editedFiles: r.editedFiles } : {}),
        // K9：读过外部内容的 agent，成没成都算——失败的那个也可能已经把网页内容写进了文件
        ...(r.externalContent ? { externalContent: true } : {}),
      });
      journal.agents![agentId] = {
        label, phase, tier: r.tier, model: r.model, provider: r.provider, ok: r.ok, cached: false, error: r.error,
        prompt: prompt.slice(0, DETAIL_TEXT_CAP), text: r.text.slice(0, DETAIL_TEXT_CAP), result: detailResult(r.result),
        trail: r.trail, turns: r.turns, toolCalls: r.toolCalls, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        startedAt, durationMs,
      };
      if (wf.signal.aborted) throw new Error(abortReason());
      if (!r.ok) {
        persist();
        log(`agent "${label}" failed: ${r.error ?? "unknown error"}`);
        if (r.errorClass && STOP_CLASSES.has(r.errorClass)) {
          providerStop ??=
            `stopped: the model provider refused agent "${label}" (${r.errorClass}: ${(r.error ?? "").slice(0, 300)}). ` +
            `Fix the key / quota / network, then run the same script again with resumeFromRunId: "${id}" — agents that ` +
            "already finished are replayed from the journal instead of running again.";
          wf.abort();
          throw new Error(providerStop);
        }
        return null;
      }
      const value = opts.schema ? r.result : r.text;
      journal.entries.push({
        key, label, phase, value, inputTokens: r.inputTokens, outputTokens: r.outputTokens, at: Date.now(),
        ...(opts.tools === "coder" ? { edited: r.editedFiles.map((p) => ({ path: p, hash: fileHash(p) })) } : {}),
        ...(r.externalContent ? { external: true as const } : {}),
      });
      persist();
      return value;
    }

    // ── run the script in its sandbox process ──
    let worker: ScriptHost;
    try {
      worker = startWorkflowSandbox({
        body,
        filename: `workflow-${meta.name}.js`,
        args: req.args,
        meta,
        budgetTotal: limits.tokenBudget || null,
      });
    } catch (e) {
      clearTimeout(deadline);
      clearTimeout(grace);
      req.signal?.removeEventListener("abort", onParentAbort);
      return fail(`could not start workflow sandbox: ${(e as Error).message}`, meta);
    }

    const outcome = await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
      let settled = false;
      const settle = (o: { ok: boolean; value?: unknown; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
      const onAbort = () => settle({ ok: false, error: abortReason() });
      if (wf.signal.aborted) onAbort();
      else wf.signal.addEventListener("abort", onAbort, { once: true });

      worker.onMessage((m) => {
        switch (m.t) {
          case "agent": {
            const seq = m.seq as number;
            handleAgent(m.prompt, m.opts).then(
              (value) => worker.post({ t: "agent_result", seq, ok: true, value, spent: spent() }),
              (e) => worker.post({ t: "agent_result", seq, ok: false, error: (e as Error).message, spent: spent() }),
            );
            break;
          }
          case "phase":
            currentPhase = String(m.title);
            emit?.({ e: "workflow_phase", id, title: currentPhase });
            break;
          case "log":
            log(String(m.text));
            break;
          case "done":
            settle({ ok: true, value: m.value });
            break;
          case "fail":
            settle({ ok: false, error: `script error: ${String(m.message)}` });
            break;
        }
      });
      worker.onError((e) => settle({ ok: false, error: `script error: ${e.message}` }));
      worker.onExit((code, stderr) => {
        if (!settled) settle({ ok: false, error: `workflow sandbox exited (code ${code}) before returning${stderr ? `: ${stderr}` : ""}` });
      });
    });

    clearTimeout(deadline);
    clearTimeout(grace);
    sem.close();
    req.signal?.removeEventListener("abort", onParentAbort);
    // Whatever happened, the script process is done: a hung script is killed
    // here, and in-flight sub-agents already hold the aborted signal.
    if (!outcome.ok) wf.abort();
    await worker.terminate().catch(() => {});

    const capped = capResult(outcome.value);
    journal.ok = outcome.ok;
    journal.error = outcome.error;
    journal.result = capped.value;
    journal.finishedAt = Date.now();
    persist();
    await persistQueue;

    emit?.({
      e: "workflow_end", id, ok: outcome.ok, error: outcome.error, agents: summaries.length, cached: cachedCount,
      inputTokens: inTok, outputTokens: outTok, result: capped.value, durationMs: Date.now() - startedAt,
    });
    return {
      ok: outcome.ok,
      id,
      name: meta.name,
      description: meta.description,
      phases: meta.phases,
      error: outcome.error,
      result: capped.value,
      resultTruncated: capped.truncated,
      agents: summaries,
      cached: cachedCount,
      inputTokens: inTok,
      outputTokens: outTok,
      durationMs: Date.now() - startedAt,
      startedAt,
      logs,
      journalPath,
      ...(skipped ? { skipped } : {}),
    };
  };
}
