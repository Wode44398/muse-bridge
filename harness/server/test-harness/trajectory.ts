// Q1（K45）：事件轨迹——把「模型每次看到的输入（只打印相对上一次新增的部分）」和「loop 产出的事件」交错成
// 一行一条的稳定文本，供门禁先后顺序这类场景做快照（t.assert.snapshot）。
//
// 用法纪律（hermes 修订，写进 harness/AGENTS.md）：快照只用于「一轮之内门禁先后顺序」的场景清单，其余写不变量；
// 快照 diff 必须有人看过——不许为了让测试变绿去 --test-update-snapshots。
//
// 归一化：流式文字的分块边界合并成一行；临时目录、UUID、时间戳、毫秒数换占位符；token 计数这类每次都变的数字
// 不进轨迹（usage 事件整条略过，context 只在压缩 / 重试 / 等待时出现）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { AgentEvent } from "../agent/events.ts";
import { runAgent } from "../agent/loop.ts";
import type { PermissionMode, PermissionRules } from "../agent/permissions.ts";
import { AgentState, type CompactionArchive } from "../agent/state.ts";
import type { Block, Msg, Turn } from "../agent/turn.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { Sandbox } from "../sandbox.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ScriptedAdapter } from "./scripted-adapter.ts";

function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\r?\n/g, "⏎").replace(/[ \t]+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

const TMP_RE = new RegExp(os.tmpdir().replace(/[\\/]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\/g, "[\\\\/]+"), "gi");

export function normalizeTrajectory(s: string): string {
  return s
    .replace(TMP_RE, "<tmp>")
    .replace(/<tmp>[\\/]+dimensio-[A-Za-z0-9-]*-[A-Za-z0-9]{6}/g, "<tmp>/<dir>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/g, "<ms>");
}

function renderBlock(b: Block): string {
  switch (b.t) {
    case "text":
      return `text "${oneLine(b.text)}"`;
    case "thinking":
      return `thinking "${oneLine(b.text, 60)}"`;
    case "tool_call":
      return `call ${b.name}#${b.id} ${oneLine(JSON.stringify(b.args), 80)}`;
    case "tool_result":
      return `result #${b.id} ${b.ok ? "ok" : "fail"} "${oneLine(b.content.map((c) => (c.t === "text" ? c.text : `[${c.t}]`)).join(" "), 100)}"`;
    default:
      return `[${b.t}]`;
  }
}

export function renderMessage(m: Msg): string {
  return `${m.role}${m.internal ? "(internal)" : ""}: ${m.content.map(renderBlock).join(" | ")}`;
}

function renderEvent(ev: AgentEvent): string | null {
  switch (ev.e) {
    case "turn_start":
      return `← turn_start ${ev.index}`;
    case "turn_discard":
      return `← turn_discard ${ev.index}${ev.reason ? ` (${oneLine(ev.reason, 80)})` : ""}`;
    case "tool_start":
      return `← tool_start ${ev.name}#${ev.id}`;
    case "tool_permission":
      return `← tool_permission ${ev.name}#${ev.id} ${ev.decision}`;
    case "tool_end":
      return `← tool_end ${ev.name}#${ev.id} ${ev.ok ? "ok" : "fail"} "${oneLine(ev.summary, 80)}"`;
    case "usage":
      return null; // token 数每次都变
    case "context": {
      const parts = [ev.compacted ? "compacted" : "", ev.retry ? `retry ${ev.retry}` : "", ev.waiting ? `waiting ${ev.waiting}` : ""].filter(Boolean);
      return parts.length ? `← context ${parts.join(" ")}` : null;
    }
    case "todo":
      return `← todo ${ev.items.length} items`;
    case "mode":
      return `← mode ${ev.permissionMode}`;
    case "permission_ask":
      return `← permission_ask ${ev.tool} "${oneLine(ev.subject, 60)}"`;
    case "permission_resolved":
      return `← permission_resolved ${ev.decision}`;
    case "plan_ask":
      return `← plan_ask "${oneLine(ev.plan, 60)}"`;
    case "plan_resolved":
      return `← plan_resolved ${ev.approved ? "approved" : "rejected"}`;
    case "ask":
      return `← ask ${ev.questions.length} question(s)`;
    case "ask_answer":
      return `← ask_answer`;
    case "steer_queued":
    case "steer_applied":
      return `← ${ev.e} "${oneLine(ev.text, 60)}"`;
    case "steer_returned":
      return `← steer_returned ${ev.texts.length}`;
    case "subagent_event":
      return null; // 子 agent 的内部流水太碎，起止两条足够
    case "subagent_start":
      return `← subagent_start ${ev.label} (${ev.tier})`;
    case "subagent_end":
      return `← subagent_end ${ev.ok ? "ok" : "fail"}`;
    case "workflow_start":
      return `← workflow_start ${ev.name}`;
    case "workflow_phase":
      return `← workflow_phase ${ev.title}`;
    case "workflow_log":
      return `← workflow_log "${oneLine(ev.text, 60)}"`;
    case "workflow_end":
      return `← workflow_end ${ev.ok ? "ok" : "fail"}`;
    case "done":
      return `← done ${ev.stopReason}`;
    case "error":
      return `← error "${oneLine(ev.message, 100)}"${ev.retriable ? " (retriable)" : ""}`;
    case "away":
      return `← away ${ev.away}`;
    default:
      return `← ${ev.e}`;
  }
}

export class Recorder {
  private readonly lines: string[] = [];
  private prev: string[] = [];
  private prevSystem = "";
  private prevTools = "";
  private text = "";
  private thinking = "";

  attach(adapter: ScriptedAdapter): this {
    adapter.onCall = (n, turn) => this.onCall(n, turn);
    return this;
  }

  onCall(n: number, turn: Turn): void {
    this.flush();
    const rendered = turn.messages.map(renderMessage);
    let common = 0;
    while (common < this.prev.length && common < rendered.length && this.prev[common] === rendered[common]) common++;
    const system = typeof turn.system === "string" ? turn.system : JSON.stringify(turn.system);
    const tools = turn.tools.map((t) => t.name).join(",");
    this.lines.push(`→ model #${n}`);
    if (n === 1) this.lines.push(`  tools: ${tools}`);
    else {
      if (system !== this.prevSystem) this.lines.push("  ~ system changed");
      if (tools !== this.prevTools) this.lines.push(`  ~ tools: ${tools}`);
    }
    if (common < this.prev.length) {
      this.lines.push(`  ~ history rewritten from message ${common + 1} (${this.prev.length} → ${rendered.length} messages)`);
    }
    for (const r of rendered.slice(common)) this.lines.push(`  + ${r}`);
    this.prev = rendered;
    this.prevSystem = system;
    this.prevTools = tools;
  }

  onEvent(ev: AgentEvent): void {
    if (ev.e === "text_delta") {
      this.text += ev.text;
      return;
    }
    if (ev.e === "thinking_delta") {
      this.thinking += ev.text;
      return;
    }
    this.flush();
    const line = renderEvent(ev);
    if (line) this.lines.push(line);
  }

  private flush(): void {
    if (this.thinking) {
      this.lines.push(`← thinking "${oneLine(this.thinking, 60)}"`);
      this.thinking = "";
    }
    if (this.text) {
      this.lines.push(`← text "${oneLine(this.text)}"`);
      this.text = "";
    }
  }

  toString(): string {
    this.flush();
    return normalizeTrajectory(this.lines.join("\n"));
  }
}

// 跑一次真实的 runAgent，同时记下轨迹。
export async function drive(
  state: AgentState,
  adapter: ScriptedAdapter,
  opts: { signal?: AbortSignal; onEvent?: (ev: AgentEvent, events: AgentEvent[]) => void } = {},
): Promise<{ events: AgentEvent[]; trajectory: string }> {
  const recorder = new Recorder().attach(adapter);
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(state, opts.signal ?? new AbortController().signal)) {
    events.push(ev);
    recorder.onEvent(ev);
    opts.onEvent?.(ev, events);
  }
  return { events, trajectory: recorder.toString() };
}

export interface LoopStateOptions {
  tools?: Tool[];
  system?: string;
  user?: string; // 第一条用户消息；不给就不加（调用方自己加）
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRules;
  // 记忆审计门禁：默认关（多数 loop 测试只测 loop 本身）；要测门禁先后顺序的场景显式打开。
  memoryAudit?: boolean;
  finalFootnotes?: boolean;
  ctx?: Partial<ToolContext>;
  compactionArchive?: CompactionArchive; // R10（二）：压缩归档（测试给内存版）
}

// P11：把工作区里的这些文件记成「已经 Read 过」——Edit / Write 的规划阶段会在弹卡之前否决没读过的改动。拿 Edit 当
// 「会弹权限卡的调用」来测权限流程的场景，先用它让那次 Edit 本身合法。
export function markRead(ctx: Pick<ToolContext, "sandbox" | "readFileState">, rels: string[], content = ""): void {
  for (const rel of rels) {
    ctx.readFileState.set(ctx.sandbox.resolve(rel), { mtimeMs: 0, content, readRanges: [], complete: true });
  }
}

// 真 AgentState + 临时工作区（测试收尾自动删），审计类工具的回调接好。
export function loopState(t: TestContext, adapter: ProviderAdapter, opts: LoopStateOptions = {}): { state: AgentState; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-loop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = opts.tools ?? [];
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    completeMemoryAudit: (decision, reason) => state.completeMemoryAudit(decision, reason),
    completeVerificationAudit: (decision, reason) => state.completeVerificationAudit(decision, reason),
    ...opts.ctx,
  };
  state = new AgentState({
    adapter,
    system: opts.system ?? "test",
    tools: tools.map((tool) => tool.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(tools.map((tool) => [tool.def.name, tool])),
    permissionMode: opts.permissionMode ?? "auto",
    permissionRules: opts.permissionRules,
    memoryAuditRequired: opts.memoryAudit ?? false,
    finalFootnotes: opts.finalFootnotes,
    compactionArchive: opts.compactionArchive,
  });
  if (opts.user) state.addUserMessage(opts.user);
  // Q3：loop 在生产上对请求不变量只计数；测试里收尾核对，违反即失败（含「同一次 run 内 system / tools 被悄悄改了」
  // 这类跨调用的项，脚本化 provider 逐次验输入时看不到）。
  t.after(() => {
    if (state.invariantViolations) {
      assert.fail(`loop 记下了 ${state.invariantViolations} 条请求不变量违规：\n  ${state.invariantSamples.join("\n  ")}`);
    }
  });
  return { state, root };
}
