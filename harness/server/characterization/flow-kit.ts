// 会话类特征基准共用的场景工具：工作区、全局配置、等待、卡在半路的一步、一个场景的记录（Trace）与「发一条、跑到收尾」。
// 写法与 session-flows.test.ts 里的同名部分相同（那份基准已钉住，不改它）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { setConfig } from "../config.ts";
import { startRun, watchGlobal, watchSession, type Session } from "../session.ts";
import { loadSession } from "../store.ts";
import type { StreamEvent } from "../agent/events.ts";
import type { Turn } from "../agent/turn.ts";
import { scripted, type ScriptedAdapter, type Step } from "../test-harness/scripted-adapter.ts";
import { Normalizer, sha } from "./normalize.ts";

export const BASE_URL = "https://openai.invalid/v1";

export function workspace(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-ws-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "note.md"), "# note\n");
  return root;
}

export function configure(root: string, over: Record<string, unknown> = {}): void {
  setConfig({
    provider: "openai",
    model: "deepseek-flash",
    thinking: "low",
    apiKey: "DUMMY-char-key",
    baseUrl: BASE_URL,
    workspace: root,
    permissionMode: "auto",
    access: "workspace",
    permissionRules: { allow: [], deny: [], ask: [] },
    ...over,
  } as Parameters<typeof setConfig>[0]);
}

export async function waitFor(what: string, pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function gated(then: StreamEvent[]): { step: () => AsyncIterable<StreamEvent>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release: () => release(),
    step: async function* () {
      await gate;
      yield* then;
    },
  };
}

export interface StoreLike {
  check(name: string, value: unknown): void;
}

export class Trace {
  readonly norm: Normalizer;
  readonly global: Record<string, unknown>[] = [];
  private readonly offGlobal: () => void;
  private readonly systems = new Map<string, string>();
  private readonly toolSets = new Map<string, unknown>();
  readonly steps: Record<string, unknown>[] = [];
  readonly t: TestContext;
  private readonly store: StoreLike;

  constructor(t: TestContext, store: StoreLike, norm = new Normalizer()) {
    this.t = t;
    this.store = store;
    this.norm = norm;
    t.mock.method(console, "log", () => {});
    this.offGlobal = watchGlobal((ev) => this.global.push(structuredClone(ev)));
  }

  requests(inputs: readonly Turn[]): unknown[] {
    return inputs.map((turn) => {
      const system = this.norm.str(typeof turn.system === "string" ? turn.system : JSON.stringify(turn.system ?? ""));
      const sysKey = sha(system);
      this.systems.set(sysKey, system);
      const tools = this.norm.value(turn.tools ?? []);
      const toolKey = sha(JSON.stringify(tools));
      this.toolSets.set(toolKey, (turn.tools ?? []).map((d) => d.name));
      const { system: _s, tools: _t, messages, ...rest } = turn;
      return { system: sysKey, tools: toolKey, messages: this.norm.value(messages), rest: this.norm.value(rest) };
    });
  }

  record(rec: unknown): unknown {
    if (!rec || typeof rec !== "object") return rec ?? null;
    const r = rec as Record<string, unknown>;
    const system = this.norm.str(String(r.system ?? ""));
    const key = sha(system);
    this.systems.set(key, system);
    const { system: _s, world, prefixBaseline, ...rest } = r;
    return {
      ...(this.norm.value(rest) as object),
      system: key,
      world: world && typeof world === "object" ? Object.keys(world).sort() : world ?? null,
      prefixBaseline: prefixBaseline ? "<present>" : null,
    };
  }

  async disk(id: string): Promise<unknown> {
    return this.record(await loadSession(id));
  }

  note(label: string, value: unknown): void {
    this.steps.push({ label, value: this.norm.value(value) });
  }

  finish(name: string): void {
    this.offGlobal();
    this.store.check(name, {
      steps: this.steps,
      global: this.norm.value(this.global),
      systems: Object.fromEntries([...this.systems.entries()].sort()),
      toolSets: Object.fromEntries([...this.toolSets.entries()].sort()),
    });
  }
}

export interface TurnOpts {
  attachments?: string[];
  start?: Parameters<typeof startRun>[5];
  // live()：附着之后本轮新到的事件（空闲时附着会先重放上一轮留下的日志尾巴，那部分不算）
  during?: (adapter: ScriptedAdapter, live: () => Record<string, unknown>[]) => Promise<void>;
  adapter?: ScriptedAdapter;
  budget?: { deadlineMs?: number; maxTurns?: number };
}

export async function turn(tr: Trace, session: Session, label: string, message: string, steps: Step[], opts: TurnOpts = {}): Promise<ScriptedAdapter> {
  const events: Record<string, unknown>[] = [];
  const off = watchSession(session, (ev) => events.push(structuredClone(ev)));
  const replayed = events.length;
  const live = () => events.slice(replayed);
  const adapter = opts.adapter ?? scripted(tr.t, { model: "deepseek-flash" });
  adapter.next(...steps);
  const before = adapter.inputs.length;
  const handle = startRun(session, message, opts.budget, opts.attachments ?? [], undefined, opts.start ?? {});
  if (handle.started) session.state!.adapter = adapter;
  if (opts.during) await opts.during(adapter, live);
  await handle.done;
  off();
  tr.note(label, { started: handle.started, events: live() });
  tr.steps.push({ label: `${label}:requests`, value: tr.requests(adapter.inputs.slice(before)) });
  return adapter;
}

export async function calledAtLeast(adapter: ScriptedAdapter, n: number): Promise<void> {
  await waitFor(`模型被调到第 ${n} 次`, () => adapter.callCount >= n);
}

// 最后一条用户侧消息的文字（工具结果也算），给脚本里「按上一步的结果决定下一步」用
export function lastUserText(turn: Turn): string {
  for (let i = turn.messages.length - 1; i >= 0; i--) {
    const m = turn.messages[i];
    if (m.role !== "user") continue;
    return m.content.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? (b.content ?? []).map((c) => (c.t === "text" ? c.text : "")).join("") : "")).join("");
  }
  return "";
}
