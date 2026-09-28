// P2（#18）：子 agent 的权限模式实时跟随父会话，只收紧不放宽。
//
// 修前：coder 的模式在派出时就算定为 auto。用户运行中「拉手刹」把会话切到只读，已派出的 coder
// （Workflow 里最多 60 个）照样继续写盘、跑命令。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { AgentState } from "./agent/state.ts";
import type { PermissionMode } from "./agent/permissions.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { Turn } from "./agent/turn.ts";
import { Sandbox } from "./sandbox.ts";

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 1000,
  thinking: false,
  image: false,
  video: false,
  cache: false,
  parallelToolCalls: false,
};

function scripted(script: (turn: Turn, index: number) => StreamEvent[]): ProviderAdapter & { calls: Turn[] } {
  const calls: Turn[] = [];
  return {
    id: "openai",
    model: "fake",
    capabilities,
    calls,
    async *stream(turn) {
      calls.push(turn);
      for (const ev of script(turn, calls.length - 1)) yield ev;
    },
  };
}

const say = (text: string): StreamEvent[] => [
  { e: "text_delta", text },
  { e: "usage", inputTokens: 10, outputTokens: 5 },
  { e: "turn_done", stopReason: "end" },
];
const call = (id: string, name: string, args: Record<string, unknown>): StreamEvent[] => [
  { e: "tool_call", id, name, args },
  { e: "usage", inputTokens: 10, outputTokens: 5 },
  { e: "turn_done", stopReason: "tool_use" },
];

function toolResult(turn: Turn, id: string): { ok: boolean; text: string } | null {
  for (const m of turn.messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.t === "tool_result" && b.id === id) {
        return { ok: b.ok, text: b.content.map((c) => (c.t === "text" ? c.text : "")).join("") };
      }
    }
  }
  return null;
}

function env(root: string, parentMode: () => PermissionMode) {
  return {
    provider: "openai" as const,
    apiKey: "DUMMY-key",
    model: "fake",
    thinking: "off" as const,
    sandbox: new Sandbox(root),
    limits: { bashTimeoutMs: 5000, bashMaxTimeoutMs: 5000 },
    parentMode,
  };
}

// 第一次写入时父会话还在 auto；第二个模型回合开始前用户把会话切到 target。
async function runSwitchingParent(target: PermissionMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p2-"));
  let parent: PermissionMode = "auto";
  const coder = scripted((_turn, i) => {
    if (i === 0) return call("w1", "Write", { path: "a.txt", content: "one" });
    if (i === 1) {
      parent = target;
      return call("w2", "Write", { path: "b.txt", content: "two" });
    }
    if (i === 2) return call("b1", "Bash", { command: "echo three > c.txt" });
    if (i === 3) return say("the session is read-only now; stopping here");
    if (i === 4) return call("v1", "VerificationAudit", { decision: "not_applicable", reason: "session switched to read-only, nothing more can run" });
    return say("stopped");
  });
  const result = await makeSubAgentRunner(env(root, () => parent), () => coder)({ prompt: "write three files", tier: "coder" });
  return { root, coder, result };
}

test("父会话运行中切只读：已派出的 coder 下一次写入与命令都被拒", async () => {
  const { root, coder } = await runSwitchingParent("read-only");
  try {
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "one", "切档之前的写入照常");
    assert.equal(fs.existsSync(path.join(root, "b.txt")), false, "切到只读之后的 Write 不许落盘");
    assert.equal(fs.existsSync(path.join(root, "c.txt")), false, "切到只读之后的 Bash 不许执行");
    const w2 = toolResult(coder.calls[2], "w2");
    assert.equal(w2?.ok, false);
    assert.match(w2?.text ?? "", /read-only/);
    const b1 = toolResult(coder.calls[3], "b1");
    assert.equal(b1?.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("父会话切到 plan：子 agent 按只读判，拒绝文案不叫它去提交计划", async () => {
  const { root, coder } = await runSwitchingParent("plan");
  try {
    assert.equal(fs.existsSync(path.join(root, "b.txt")), false);
    const w2 = toolResult(coder.calls[2], "w2");
    assert.equal(w2?.ok, false);
    assert.match(w2?.text ?? "", /read-only/);
    assert.doesNotMatch(w2?.text ?? "", /ExitPlanMode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("effectiveMode 只收紧不放宽", () => {
  const make = (own: PermissionMode, ceiling?: () => PermissionMode) =>
    new AgentState({
      adapter: scripted(() => say("")),
      system: "",
      tools: [],
      budget: { maxOutputTokens: 100, thinking: "off" },
      ctx: {
        sandbox: new Sandbox(os.tmpdir()),
        readFileState: new Map(),
        setTodos: () => {},
        limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 },
        agentSeesImages: false,
      },
      toolMap: new Map(),
      permissionMode: own,
      modeCeiling: ceiling,
    });
  assert.equal(make("auto").effectiveMode(), "auto", "主 agent：没有上限就是自己的模式");
  assert.equal(make("plan").effectiveMode(), "plan");
  assert.equal(make("auto", () => "auto").effectiveMode(), "auto");
  assert.equal(make("auto", () => "read-only").effectiveMode(), "read-only");
  assert.equal(make("auto", () => "plan").effectiveMode(), "read-only");
  assert.equal(make("read-only", () => "auto").effectiveMode(), "read-only", "父会话是 auto 也不会放宽子 agent");
});
