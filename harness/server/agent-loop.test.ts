// Q1：迁到共享脚本化 provider（test-harness/）。「模型一共被调了几次」由收尾的 assertDone 兜底——多调、少调都判失败。
import assert from "node:assert/strict";
import test from "node:test";
import { AgentState, healDanglingToolCalls } from "./agent/state.ts";
import type { Msg } from "./agent/turn.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

// These tests isolate loop mechanics rather than the separately-tested mandatory memory lifecycle gate
// (loopState leaves the memory audit gate off by default).

function resultText(state: AgentState, id: string): string {
  for (const message of state.messages) {
    for (const block of message.content) {
      if (block.t !== "tool_result" || block.id !== id) continue;
      return block.content.map((item) => item.t === "text" ? item.text : "").join("\n");
    }
  }
  return "";
}

test("loop feeds malformed, unknown, and thrown tool failures back without executing bad args", async (t) => {
  let knownRuns = 0;
  const schema = { type: "object" as const, properties: {} };
  const known: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Known", description: "known", parameters: schema },
    async run() {
      knownRuns++;
      return ok("known", "should not run with malformed args");
    },
  };
  const throws: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Throws", description: "throws", parameters: schema },
    async run() {
      throw new Error("synthetic tool crash");
    },
  };
  const adapter = scripted(t).next(
    calls(
      { ...call("bad-json", "Known"), argsError: "Unexpected end of JSON input", argsRaw: '{"path":' },
      call("unknown", "Missing"),
      call("throws", "Throws"),
    ),
    say("recovered"),
  );
  const { state } = loopState(t, adapter, { tools: [known, throws], user: "test the loop" });
  await drive(state, adapter);
  assert.equal(knownRuns, 0);
  assert.match(resultText(state, "bad-json"), /not valid JSON/);
  assert.match(resultText(state, "unknown"), /Unknown tool "Missing"/);
  assert.match(resultText(state, "throws"), /synthetic tool crash/);
});

test("loop recovers from a dropped stream and rate limit, then continues a truncated answer", async (t) => {
  const adapter = scripted(t).next(
    { throws: "synthetic connection reset" },
    [{ e: "error", kind: "http_429", retriable: true, retryAfterMs: 1, raw: "rate limited" }],
    say("partial", "length"),
    say("complete"),
  );
  const { state } = loopState(t, adapter, { user: "test the loop" });
  const { events } = await drive(state, adapter);
  assert.ok(events.some((event) => event.e === "context" && event.retry === 1));
  assert.ok(events.some((event) => event.e === "context" && event.retry === 2));
  // Q14（K54）：认结构（harness 注入的 length-continue），不照抄提示语的措辞
  assert.ok(state.messages.some((message) => message.origin === "harness" && message.kind === "length-continue"));
  const assistantText = state.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block): block is Extract<typeof block, { t: "text" }> => block.t === "text")
    .map((block) => block.text)
    .join("|");
  assert.match(assistantText, /partial/);
  assert.match(assistantText, /complete/);
});

test("dangling tool calls from an interrupted session are healed exactly once", () => {
  const messages: Msg[] = [
    {
      role: "assistant",
      content: [{ t: "tool_call", id: "orphan", name: "Read", args: { path: "a.ts" } }],
    },
  ];
  assert.equal(healDanglingToolCalls(messages), true);
  assert.equal(messages.length, 2);
  const healed = messages[1].content[0];
  assert.equal(healed.t, "tool_result");
  if (healed.t === "tool_result") {
    assert.equal(healed.id, "orphan");
    assert.equal(healed.ok, false);
  }
  assert.equal(healDanglingToolCalls(messages), false);
});
