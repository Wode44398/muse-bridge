import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "./agent/loop.ts";
import { AgentState } from "./agent/state.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import { askUserQuestionTool } from "./tools/ask.ts";
import type { AskQuestionSpec, AskResolution, ToolContext } from "./tools/types.ts";

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 1000,
  thinking: false,
  image: false,
  video: false,
  cache: false,
  parallelToolCalls: false,
};

const QUESTIONS = [
  {
    header: "数据库",
    question: "用哪个数据库？",
    options: [{ label: "PostgreSQL" }, { label: "SQLite", description: "零依赖" }],
  },
];

// An adapter that calls AskUserQuestion on turn 1, then answers on turn 2.
function askThenFinish(): { adapter: ProviderAdapter; turns: () => number } {
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream() {
      turn++;
      if (turn === 1) {
        yield { e: "tool_call" as const, id: "ask-1", name: "AskUserQuestion", args: { questions: QUESTIONS } };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "done" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };
  return { adapter, turns: () => turn };
}

function makeState(
  adapter: ProviderAdapter,
  askUser?: ToolContext["askUser"],
): { state: AgentState; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ask-"));
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    askUser,
  };
  const state = new AgentState({
    adapter,
    system: "test",
    tools: [askUserQuestionTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map([[askUserQuestionTool.def.name, askUserQuestionTool]]),
    permissionMode: "auto",
    // Isolate ask mechanics from the memory-audit gate: a successful ask would
    // otherwise re-arm it (noteActivityAfterAudit) and stall this fake run.
    memoryAuditRequired: false,
  });
  state.addUserMessage("pick a database");
  return { state, root };
}

function askResult(state: AgentState, id: string): string {
  for (const message of state.messages) {
    for (const block of message.content) {
      if (block.t === "tool_result" && block.id === id) {
        return block.content.map((c) => (c.t === "text" ? c.text : "")).join("\n");
      }
    }
  }
  return "";
}

test("AskUserQuestion blocks on ctx.askUser and feeds the answer back to the model", async () => {
  const { adapter, turns } = askThenFinish();
  let posed: AskQuestionSpec[] = [];
  const askUser = (questions: AskQuestionSpec[]): Promise<AskResolution> => {
    posed = questions;
    // Resolve asynchronously — proves the loop genuinely awaits it.
    return new Promise((resolve) =>
      setTimeout(
        () => resolve({ cancelled: false, answers: [{ header: "数据库", selected: ["PostgreSQL"], custom: false }] }),
        5,
      ),
    );
  };
  const { state, root } = makeState(adapter, askUser);
  const events: any[] = [];
  try {
    for await (const ev of runAgent(state, new AbortController().signal)) events.push(ev);

    // The tool actually reached the user channel with the parsed question.
    assert.equal(posed.length, 1, "askUser was invoked with the question");
    assert.equal(posed[0].options.length, 2);
    // The run continued after the answer (turn 2 ran) and the result carried it.
    assert.equal(turns(), 2);
    assert.match(askResult(state, "ask-1"), /PostgreSQL/);
    // The persisted block carries the exact selections as structured meta —
    // history reconstruction reads this instead of re-parsing formatted text.
    const block = state.messages
      .flatMap((m) => m.content)
      .find((b) => b.t === "tool_result" && b.id === "ask-1");
    assert.deepEqual((block as any)?.meta, { ask: { answers: [{ selected: ["PostgreSQL"], custom: false }] } });
    // The loop hides AskUserQuestion's generic tool chrome (dedicated card instead).
    assert.ok(!events.some((e) => e.e === "tool_start" && e.name === "AskUserQuestion"));
    assert.ok(!events.some((e) => e.e === "tool_end" && e.name === "AskUserQuestion"));
    assert.ok(events.some((e) => e.e === "done"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AskUserQuestion degrades gracefully when no user channel is wired", async () => {
  const { adapter } = askThenFinish();
  const { state, root } = makeState(adapter, undefined); // no askUser
  try {
    for await (const _ev of runAgent(state, new AbortController().signal)) {
      /* drain */
    }
    assert.match(askResult(state, "ask-1"), /not available in this context/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cancelled ask returns ok with a proceed instruction and cancellation meta", async () => {
  const res = await askUserQuestionTool.run(
    { questions: QUESTIONS },
    {
      sandbox: new Sandbox(os.tmpdir()),
      readFileState: new Map(),
      setTodos: () => {},
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      agentSeesImages: false,
      askUser: async () => ({ cancelled: true, answers: [] }),
    },
  );
  assert.equal(res.ok, true); // cancellation is not a tool failure — the model proceeds
  assert.match(res.content.map((c) => (c.t === "text" ? c.text : "")).join(""), /did not answer/i);
  assert.deepEqual(res.meta, { ask: { cancelled: true } });
});

test("AskUserQuestion rejects malformed questions before reaching the user", async () => {
  let called = false;
  const res = await askUserQuestionTool.run(
    { questions: [{ question: "only one option?", options: [{ label: "A" }] }] },
    {
      sandbox: new Sandbox(os.tmpdir()),
      readFileState: new Map(),
      setTodos: () => {},
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      agentSeesImages: false,
      askUser: async () => {
        called = true;
        return { cancelled: false, answers: [] };
      },
    },
  );
  assert.equal(res.ok, false);
  assert.equal(called, false, "invalid input never reaches the user");
  assert.match(res.content.map((c) => (c.t === "text" ? c.text : "")).join(""), /at least 2/);
});
