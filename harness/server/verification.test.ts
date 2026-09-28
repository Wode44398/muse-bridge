// Q1：迁到共享脚本化 provider（test-harness/）。模型一共被调了几次由收尾的 assertDone 兜底——多调、少调都判失败。
import assert from "node:assert/strict";
import test from "node:test";
import { visibleMessages } from "./agent/state.ts";
import { tagLegacyOrigins } from "./agent/injections.ts";
import { VERIFY_NUDGE, VERIFY_UNDECLARED_NUDGE } from "./agent/loop.ts";
import type { Msg } from "./agent/turn.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { verificationAuditTool } from "./tools/verificationaudit.ts";
import { ok, fail, type Tool } from "./tools/types.ts";

const emptySchema = { type: "object" as const, properties: {} };

const edit: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Edit", description: "fake edit", parameters: emptySchema },
  async run() {
    return ok("edited", "edited");
  },
};

test("done gate ignores Preview and failed checks, then accepts successful explicit evidence", async (t) => {
  const preview: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Preview", description: "fake preview", parameters: emptySchema },
    async run() {
      return ok("logs", "only inspected logs");
    },
  };
  const bash: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Bash", description: "fake bash", parameters: emptySchema },
    async run(args) {
      const passed = args.pass === true;
      return {
        ...(passed ? ok("test passed", "exit 0") : fail("test failed", "exit 1")),
        verification: { passed, detail: passed ? "npm test (exit 0)" : "npm test (exit 1)" },
      };
    },
  };
  const adapter = scripted(t).next(
    useTool("edit", "Edit", { path: "file.ts" }),
    useTool("preview", "Preview", { action: "logs" }),
    useTool("fail", "Bash", { command: "npm test", verify: true, pass: false }),
    say("premature"),
    useTool("pass", "Bash", { command: "npm test", verify: true, pass: true }),
    useTool("audit", "MemoryAudit", {
      decision: "none",
      reason: "The test changes contain no durable cross-session project knowledge.",
    }),
    say("verified final"),
  );
  const { state } = loopState(t, adapter, {
    tools: [edit, preview, bash, memoryAuditTool],
    memoryAudit: true,
    user: "edit and verify",
  });
  const { events } = await drive(state, adapter);

  assert.equal(state.dirtySinceVerify, false);
  assert.equal(state.verifiedEpoch, state.mutationEpoch);
  assert.match(state.lastVerification, /exit 0/);
  assert.ok(
    state.messages.some((message) =>
      message.content.some((block) => block.t === "text" && block.text.includes("Automated check")),
    ),
  );
  assert.deepEqual(
    events.filter((event) => event.e === "turn_discard").map((event) => event.index),
    [3],
  );
  const visibleAssistantText = visibleMessages(state.messages).flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.t === "text").map((block) => block.text)
      : [],
  );
  assert.deepEqual(visibleAssistantText, ["verified final"]);
});

test("a clean run that was never declared changes the accusation, not the gate", async (t) => {
  // Exit 0, meaningful, and NOT declared with verify:true — exactly the shape
  // of the k3 run's real-device E2E and assembleDebug.
  const bash: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Bash", description: "fake bash", parameters: emptySchema },
    async run() {
      return ok("build ok", "BUILD SUCCESSFUL");
    },
  };
  // The gate is unchanged, so this model would loop forever (always "done"); abort once two nudges prove it.
  const adapter = scripted(t)
    .next(useTool("edit", "Edit", { path: "file.ts" }), useTool("build", "Bash", { command: "./gradlew assembleDebug" }))
    .always(say("done"));
  const { state } = loopState(t, adapter, {
    tools: [edit, bash, memoryAuditTool],
    memoryAudit: true,
    user: "edit and build",
  });
  const abort = new AbortController();
  await drive(state, adapter, {
    signal: abort.signal,
    onEvent: () => {
      if (adapter.callCount >= 5) abort.abort();
    },
  });

  // Q14（K54）：按结构找门禁提示（harness 注入的 verify-nudge），按导出的常量分辨是哪一句——不照抄措辞
  const nudges = state.messages
    .filter((message) => message.origin === "harness" && message.kind === "verify-nudge")
    .flatMap((message) => message.content.filter((block) => block.t === "text"));
  assert.ok(nudges.length > 0, "the gate must still hold");
  const texts = nudges.map((block) => (block.t === "text" ? block.text : ""));
  // Accurate: it ran something, it just never said so.
  assert.ok(texts.some((t) => t.startsWith(VERIFY_UNDECLARED_NUDGE)));
  assert.match(texts.join("\n"), /gradlew assembleDebug/);
  // And it no longer claims nothing was run.
  assert.ok(!texts.some((t) => t.startsWith(VERIFY_NUDGE)));
  assert.equal(state.dirtySinceVerify, true);
});

test("done gate repeats until an explicit verification audit records the limitation", async (t) => {
  const adapter = scripted(t).next(
    useTool("edit", "Edit", { path: "file.ts" }),
    say("still stopping"),
    say("still stopping"),
    useTool("verify-audit", "VerificationAudit", {
      decision: "blocked",
      reason: "The required external test service is unavailable in this isolated test environment.",
    }),
    useTool("memory-audit", "MemoryAudit", {
      decision: "none",
      reason: "This synthetic gate test contains no durable cross-session project knowledge.",
    }),
    say("limited final"),
  );
  const { state } = loopState(t, adapter, {
    tools: [edit, verificationAuditTool, memoryAuditTool],
    memoryAudit: true,
    user: "edit with unavailable verification",
  });
  const { events } = await drive(state, adapter);

  assert.equal(state.verificationAuditCompleted, true);
  assert.equal(state.dirtySinceVerify, true);
  const nudges = state.messages.flatMap((message) =>
    message.content.filter(
      (block): block is Extract<typeof block, { t: "text" }> =>
        block.t === "text" && block.text.includes("Automated check"),
    ),
  );
  assert.equal(nudges.length, 2);
  assert.equal(events.filter((event) => event.e === "turn_discard").length, 2);
  const visibleAssistantText = visibleMessages(state.messages).flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.t === "text").map((block) => block.text)
      : [],
  );
  assert.deepEqual(visibleAssistantText, ["limited final"]);
});

test("visibleMessages removes premature finals around legacy verification nudges", () => {
  const nudge =
    "[Automated check] You have edited files without sufficient passing verification evidence. " +
    "Run a real verification before finishing.";
  const messages: Msg[] = [
    { role: "user", content: [{ t: "text", text: "change it" }] },
    { role: "assistant", content: [{ t: "text", text: "premature one" }] },
    { role: "user", content: [{ t: "text", text: nudge }] },
    {
      role: "assistant",
      content: [{ t: "tool_call", id: "read", name: "Read", args: { path: "result.csv" } }],
    },
    { role: "user", content: [{ t: "tool_result", id: "read", ok: true, content: [] }] },
    { role: "assistant", content: [{ t: "text", text: "premature two" }] },
    { role: "user", content: [{ t: "text", text: nudge }] },
    {
      role: "assistant",
      content: [{ t: "tool_call", id: "verify", name: "Bash", args: { command: "npm test", verify: true } }],
    },
    { role: "user", content: [{ t: "tool_result", id: "verify", ok: true, content: [] }] },
    { role: "assistant", content: [{ t: "text", text: "only final" }] },
  ];

  // C3：C3 之前的旧记录读入时先按开头补标来源（store.ts），这里照样走一遍
  tagLegacyOrigins(messages);
  const visible = visibleMessages(messages);
  const assistantText = visible.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.t === "text").map((block) => block.text)
      : [],
  );
  const toolNames = visible.flatMap((message) =>
    message.content.filter((block) => block.t === "tool_call").map((block) => block.name)
  );
  assert.deepEqual(assistantText, ["only final"]);
  assert.deepEqual(toolNames, ["Read", "Bash"]);
  assert.equal(
    visible.some((message) => message.content.some((block) => block.t === "text" && block.text.startsWith("[Automated check]"))),
    false,
  );
});
