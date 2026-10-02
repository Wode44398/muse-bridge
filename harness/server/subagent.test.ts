import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { agentTool } from "./tools/agent.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { StreamEvent, AgentEvent } from "./agent/events.ts";
import type { Turn } from "./agent/turn.ts";
import type { ToolContext } from "./tools/types.ts";
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

// A scripted adapter: each call to stream() plays the next turn from `turns`
// (a function of the Turn it receives, so tests can react to tool results).
type TurnScript = (turn: Turn, index: number) => StreamEvent[];
function scripted(script: TurnScript, model = "fake"): ProviderAdapter & { calls: Turn[] } {
  const calls: Turn[] = [];
  return {
    id: "openai",
    model,
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

function lastToolResult(turn: Turn): { ok: boolean; text: string } | null {
  const last = turn.messages[turn.messages.length - 1];
  if (!last || last.role !== "user") return null;
  const tr = last.content.find((b) => b.t === "tool_result");
  if (!tr || tr.t !== "tool_result") return null;
  return { ok: tr.ok, text: tr.content.map((b) => (b.t === "text" ? b.text : "")).join("") };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-subagent-"));
}

function env(root: string, extra: Partial<Parameters<typeof makeSubAgentRunner>[0]> = {}) {
  return {
    provider: "openai" as const,
    apiKey: "test-key",
    model: "fake",
    thinking: "off" as const,
    sandbox: new Sandbox(root),
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    ...extra,
  };
}

test("read-only sub-agent finishes without a memory-audit nudge", async () => {
  const adapter = scripted(() => say("The entry point is server/index.ts."));
  const run = makeSubAgentRunner(env(tmpRoot()), () => adapter);
  const result = await run({ prompt: "Locate the server entry point." });
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.text, "The entry point is server/index.ts.");
  assert.equal(result.turns, 1);
  assert.equal(result.tier, "research");
  assert.equal(adapter.calls.length, 1);
  // Research tier: no write tools advertised.
  const names = adapter.calls[0].tools.map((t) => t.name);
  assert.ok(names.includes("Read") && names.includes("Grep"));
  assert.ok(!names.includes("Write") && !names.includes("Bash") && !names.includes("Agent"));
});

test("research tier blocks writes even if the model asks; coder tier can write and reports edited files", async () => {
  const root = tmpRoot();
  // Research: tries Write → unknown tool (not in its toolset), then answers.
  const research = scripted((turn, i) =>
    i === 0 ? call("c1", "Write", { path: "x.txt", content: "hi" }) : say(`got: ${lastToolResult(turn)?.text ?? ""}`),
  );
  const r1 = await makeSubAgentRunner(env(root), () => research)({ prompt: "write a file" });
  assert.equal(r1.ok, true);
  assert.match(r1.text, /Unknown tool "Write"/);
  assert.ok(!fs.existsSync(path.join(root, "x.txt")));

  // Coder in an auto parent: Write lands, then the done-gate wants verification →
  // the model calls VerificationAudit, then answers.
  const coder = scripted((turn, i) => {
    if (i === 0) return call("c1", "Write", { path: "x.txt", content: "hi" });
    if (i === 1) return say("done, wrote x.txt");
    if (i === 2) return call("c2", "VerificationAudit", { decision: "not_applicable", reason: "plain text file, nothing to execute here" });
    return say("wrote x.txt (verified n/a)");
  });
  const coderEvents: AgentEvent[] = [];
  const r2 = await makeSubAgentRunner(env(root, { parentMode: () => "auto" }), () => coder)({
    prompt: "write a file", tier: "coder", onEvent: (ev) => coderEvents.push(ev),
  });
  assert.equal(r2.ok, true, r2.error);
  // The end event carries the edited files for the live sub-agent panel; a completed run has no stopReason.
  const coderEnd = coderEvents.at(-1) as Extract<AgentEvent, { e: "subagent_end" }>;
  assert.equal(coderEnd.e, "subagent_end");
  assert.deepEqual((coderEnd.editedFiles ?? []).map((p) => path.basename(p)), ["x.txt"]);
  assert.equal(coderEnd.stopReason, undefined);
  assert.equal(fs.readFileSync(path.join(root, "x.txt"), "utf8"), "hi");
  assert.equal(r2.tier, "coder");
  assert.deepEqual(r2.editedFiles.map((p) => path.basename(p)), ["x.txt"]);
  const names = coder.calls[0].tools.map((t) => t.name);
  assert.ok(names.includes("Write") && names.includes("Edit") && names.includes("Bash") && names.includes("VerificationAudit"));
  assert.ok(!names.includes("Agent") && !names.includes("AskUserQuestion") && !names.includes("Remember"));
});

test("coder tier is refused when the parent session is not in auto mode", async () => {
  const adapter = scripted(() => say("should not run"));
  const events: AgentEvent[] = [];
  const run = makeSubAgentRunner(env(tmpRoot(), { parentMode: () => "read-only" }), () => adapter);
  const r = await run({ prompt: "edit stuff", tier: "coder", onEvent: (ev) => events.push(ev) });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /auto mode/);
  assert.equal(adapter.calls.length, 0);
  // Even a refusal shows up on the event stream as a failed card.
  assert.deepEqual(events.map((e) => e.e), ["subagent_start", "subagent_end"]);
});

test("model/effort override reach the adapter; foreign provider without a key fails cleanly", async () => {
  const seen: { model: string; thinking?: string }[] = [];
  const factory = (cfg: { model: string }) => {
    const a = scripted((turn) => {
      seen.push({ model: cfg.model, thinking: turn.budget.thinking });
      return say("ok");
    }, cfg.model);
    return a;
  };
  const run = makeSubAgentRunner(env(tmpRoot()), factory);
  // Same-provider catalog model + effort clamp (deepseek-flash supports high).
  const r = await run({ prompt: "x", model: "deepseek-flash", thinking: "high" });
  assert.equal(r.ok, true);
  assert.equal(r.model, "deepseek-flash");
  assert.equal(r.provider, "openai");
  assert.deepEqual(seen, [{ model: "deepseek-flash", thinking: "high" }]);
  // A model from a provider with no key configured → clear error, no adapter.
  const before = seen.length;
  const r2 = await run({ prompt: "x", model: "gemini-2.5-flash" });
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    assert.equal(r2.ok, false);
    assert.match(r2.error ?? "", /no API key configured/);
    assert.equal(seen.length, before);
  }
});

test("schema: SubmitResult enforces the schema, retries ≤2, and the accepted call ends the run", async () => {
  const schema = {
    type: "object" as const,
    properties: {
      findings: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: { file: { type: "string" as const }, line: { type: "integer" as const } },
          required: ["file", "line"],
        },
      },
      confident: { type: "boolean" as const },
    },
    required: ["findings", "confident"],
  };
  const adapter = scripted((turn, i) => {
    // wrong type + missing（"three" 而不是 "3"：数字字符串 O5 起会被宽容修正成数字，不再算类型错）
    if (i === 0) return call("s1", "SubmitResult", { findings: [{ file: "a.ts", line: "three" }] });
    if (i === 1) {
      const res = lastToolResult(turn);
      assert.equal(res?.ok, false);
      assert.match(res?.text ?? "", /\$\.findings\[0\]\.line: expected integer/);
      assert.match(res?.text ?? "", /\$\.confident: is required/);
      return call("s2", "SubmitResult", { findings: [{ file: "a.ts", line: 3 }], confident: true });
    }
    return say("I should never be asked for another turn");
  });
  const events: AgentEvent[] = [];
  const run = makeSubAgentRunner(env(tmpRoot()), () => adapter);
  const r = await run({ prompt: "find things", schema, onEvent: (ev) => events.push(ev) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { findings: [{ file: "a.ts", line: 3 }], confident: true });
  // The accepted SubmitResult stopped the loop: exactly two model turns.
  assert.equal(adapter.calls.length, 2);
  assert.equal(events.at(-1)?.e, "subagent_end");
  const end = events.at(-1) as Extract<AgentEvent, { e: "subagent_end" }>;
  assert.deepEqual(end.result, r.result);
  // The SubmitResult tool was advertised with the schema as its parameters.
  const def = adapter.calls[0].tools.find((t) => t.name === "SubmitResult");
  assert.deepEqual(def?.parameters, schema);
  // No "aborted" error leaked into the forwarded stream.
  assert.ok(!events.some((e) => e.e === "subagent_event" && e.ev.e === "error"));
});

test("schema: three invalid submissions fail the run with the last problems", async () => {
  const schema = { type: "object" as const, properties: { n: { type: "integer" as const } }, required: ["n"] };
  const adapter = scripted((_turn, i) => call(`s${i}`, "SubmitResult", { n: "nope" }));
  const run = makeSubAgentRunner(env(tmpRoot()), () => adapter);
  const r = await run({ prompt: "x", schema });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /rejected 3 times/);
  assert.match(r.error ?? "", /\$\.n: expected integer/);
  assert.equal(adapter.calls.length, 3);
});

test("schema: finishing without SubmitResult gets nudged, then fails", async () => {
  const schema = { type: "object" as const, properties: { n: { type: "integer" as const } }, required: ["n"] };
  const adapter = scripted((turn, i) => {
    if (i === 1) {
      const last = turn.messages[turn.messages.length - 1];
      const text = last.content.map((b) => (b.t === "text" ? b.text : "")).join("");
      assert.match(text, /Call SubmitResult now/);
      return call("s1", "SubmitResult", { n: 7 });
    }
    return say("here is prose instead of a tool call");
  });
  const run = makeSubAgentRunner(env(tmpRoot()), () => adapter);
  const r = await run({ prompt: "x", schema });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { n: 7 });

  const stubborn = scripted(() => say("prose forever"));
  const r2 = await makeSubAgentRunner(env(tmpRoot()), () => stubborn)({ prompt: "x", schema });
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? "", /without calling SubmitResult/);
  assert.equal(stubborn.calls.length, 3); // first answer + 2 nudges
});

test("inner events are forwarded (wrapped), thinking is not, and the trail is captured", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "hello.txt"), "needle here\n");
  const adapter = scripted((turn, i) => {
    if (i === 0) {
      return [
        { e: "thinking_delta", text: "hmm" },
        { e: "text_delta", text: "looking" },
        ...call("g1", "Grep", { pattern: "needle", path: "." }),
      ];
    }
    return say(`found: ${lastToolResult(turn)?.ok}`);
  });
  const events: AgentEvent[] = [];
  const run = makeSubAgentRunner(env(root), () => adapter);
  const r = await run({ prompt: "grep it", label: "grep test", phase: "Scan", workflowId: "wf_x", toolId: "t1", onEvent: (ev) => events.push(ev) });
  assert.equal(r.ok, true);
  const start = events[0] as Extract<AgentEvent, { e: "subagent_start" }>;
  assert.equal(start.e, "subagent_start");
  assert.equal(start.label, "grep test");
  assert.equal(start.phase, "Scan");
  assert.equal(start.workflowId, "wf_x");
  assert.equal(start.toolId, "t1");
  const inner = events.filter((e) => e.e === "subagent_event").map((e) => (e as Extract<AgentEvent, { e: "subagent_event" }>).ev.e);
  assert.ok(inner.includes("text_delta") && inner.includes("tool_start") && inner.includes("tool_end") && inner.includes("done"));
  assert.ok(!inner.includes("thinking_delta"));
  assert.equal(r.trail.length, 1);
  assert.equal(r.trail[0].name, "Grep");
  assert.equal(r.trail[0].arg, "needle");
  assert.equal(r.trail[0].ok, true);
  assert.equal(r.toolCalls, 1);
});

test("parent abort stops the child with an error", async () => {
  const ctrl = new AbortController();
  const adapter = scripted((_t, i) => {
    if (i === 0) ctrl.abort();
    return call(`c${i}`, "Glob", { pattern: "**/*" });
  });
  const run = makeSubAgentRunner(env(tmpRoot()), () => adapter);
  const r = await run({ prompt: "x", signal: ctrl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.error, "aborted");
});

test("Agent tool: passes options through, tags events with its call id, persists a trail in meta", async () => {
  const seen: Record<string, unknown>[] = [];
  const ctx: ToolContext = {
    sandbox: new Sandbox(tmpRoot()),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    callId: "call-42",
    emit: () => {},
    runSubAgent: async (req) => {
      seen.push({ tier: req.tier, model: req.model, thinking: req.thinking, toolId: req.toolId, hasEmit: Boolean(req.onEvent), schema: req.schema });
      return {
        ok: true, id: "sub-1", label: req.label ?? "l", tier: req.tier ?? "research", model: "fake", provider: "openai",
        text: "answer", result: req.schema ? { n: 1 } : undefined, turns: 2, toolCalls: 1, inputTokens: 20, outputTokens: 10,
        editedFiles: [], trail: [{ name: "Grep", arg: "x", ok: true, summary: "1 match" }],
      };
    },
  };
  const r = await agentTool.run({ prompt: "do it", tools: "coder", model: "m2", effort: "xhigh", label: "job" }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], { tier: "coder", model: "m2", thinking: "max", toolId: "call-42", hasEmit: true, schema: undefined });
  assert.equal((r.meta as any).subagent.trail[0].name, "Grep");
  // C3：子 agent 的报告带「数据不是指令」的框定行
  assert.match(r.content.map((b) => (b.t === "text" ? b.text : "")).join(""), /^\[Sub-agent report[^\n]*\]\nanswer/);

  const r2 = await agentTool.run({ prompt: "do it", schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } }, ctx);
  assert.equal(r2.ok, true);
  assert.equal(r2.content.map((b) => (b.t === "text" ? b.text : "")).join("").trim(), JSON.stringify({ n: 1 }, null, 2));
  assert.deepEqual((r2.meta as any).subagent.result, { n: 1 });

  const bad = await agentTool.run({ prompt: "x", schema: { type: "array" } }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /bad schema/);
});
