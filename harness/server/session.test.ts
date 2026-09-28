import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { setConfig } from "./config.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import {
  answerAsk,
  createSession,
  dropSession,
  getOrLoadSession,
  readGuide,
  startRun,
  stopSession,
  watchSession,
  type Session,
} from "./session.ts";
import { deleteSessionFile, loadSession } from "./store.ts";
import { loadSessionImageBase64, sniffImageMime, storeSessionImage } from "./image-assets.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { askUserQuestionTool } from "./tools/ask.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// 基线来自 test-setup.ts 的全局临时目录——还原而不是 delete，否则后续用例落回生产 sessions/。
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  delete process.env.CHECKPOINTS;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for session event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function attachState(session: Session, adapter: ProviderAdapter, root: string): AgentState {
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: adapter.capabilities.image,
    completeMemoryAudit: (decision, reason) => state.completeMemoryAudit(decision, reason),
  };
  state = new AgentState({
    adapter,
    system: "test",
    tools: [memoryAuditTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map([[memoryAuditTool.def.name, memoryAuditTool]]),
    permissionMode: "auto",
    resolveImageAsset: (assetId) => loadSessionImageBase64(session.id, assetId),
    storeImageAsset: (block) => {
      const bytes = Buffer.from(block.data ?? "", "base64");
      const mime = sniffImageMime(bytes);
      if (!mime) throw new Error("invalid test image");
      return storeSessionImage(session.id, bytes, mime, block.name);
    },
  });
  session.state = state;
  return state;
}

const capabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 1000,
  thinking: false,
  image: false,
  video: false,
  cache: false,
  parallelToolCalls: false,
};

test("detaching the originating watcher keeps the run alive and a new watcher replays then follows it", async () => {
  const root = temp("dimensio-session-detach-");
  const release = deferred();
  let turn = 0;
  let observedSignal: AbortSignal | undefined;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream(_turn, signal) {
      turn++;
      observedSignal = signal;
      if (turn === 1) {
        yield { e: "text_delta" as const, text: "started" };
        await release.promise;
        yield { e: "text_delta" as const, text: "finished" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      } else if (turn === 2) {
        yield {
          e: "tool_call" as const,
          id: "audit",
          name: "MemoryAudit",
          args: { decision: "none", reason: "The synthetic detach test creates no durable project knowledge." },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "final" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };
  const session = createSession();
  attachState(session, adapter, root);
  const run = startRun(session, "continue after disconnect");
  assert.equal(run.started, true);

  const first: any[] = [];
  const unsubscribeFirst = watchSession(session, (event) => first.push(event));
  await waitFor(() => first.some((event) => event.e === "text_delta" && event.text === "started"));
  unsubscribeFirst();
  assert.equal(session.running, true);
  assert.equal(observedSignal?.aborted, false);

  const resumed: any[] = [];
  watchSession(session, (event) => resumed.push(event));
  assert.ok(resumed.some((event) => event.e === "text_delta" && event.text === "started"));
  release.resolve();
  await run.done;

  assert.equal(session.running, false);
  assert.equal(observedSignal?.aborted, false);
  assert.equal(first.some((event) => event.e === "text_delta" && event.text === "finished"), false);
  assert.ok(resumed.some((event) => event.e === "text_delta" && event.text === "finished"));
  assert.ok(resumed.some((event) => event.e === "mirror_end"));
  dropSession(session.id);
});

test("only explicit stop aborts a detached run", async () => {
  const root = temp("dimensio-session-stop-");
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream(_turn, signal) {
      yield { e: "text_delta" as const, text: "waiting" };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  const session = createSession();
  attachState(session, adapter, root);
  const events: any[] = [];
  const run = startRun(session, "wait until stopped");
  const unsubscribe = watchSession(session, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.e === "text_delta"));
  unsubscribe();
  assert.equal(session.running, true);
  // stopSession now reports what it actually stopped (turn + owned jobs/servers).
  assert.deepEqual(stopSession(session.id), {
    stopped: true,
    turnAborted: true,
    jobsKilled: 0,
    servicesStopped: 0,
  });
  await run.done;
  assert.equal(session.running, false);
  assert.ok(session.runLog.some((event) => event.e === "error" && event.message === "aborted"));
  dropSession(session.id);
});

test("deleting a running background session cannot recreate its persisted record", async () => {
  const root = temp("dimensio-session-delete-work-");
  process.env.SESSIONS_DIR = temp("dimensio-session-delete-state-");
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream(_turn, signal) {
      yield { e: "text_delta" as const, text: "persisted" };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  const session = createSession();
  attachState(session, adapter, root);
  session.cfg = {
    provider: "openai",
    model: "fake",
    thinking: "off",
    permissionMode: "auto",
    workspace: root,
    access: "workspace",
  };
  const run = startRun(session, "delete while running");
  await waitFor(() => session.runLog.some((event) => event.e === "text_delta"));
  assert.ok(await loadSession(session.id));
  dropSession(session.id);
  await deleteSessionFile(session.id);
  await run.done;
  assert.equal(await loadSession(session.id), null);
});

test("concurrent resumes of one persisted session share a single instance", async () => {
  const root = temp("dimensio-session-race-work-");
  process.env.SESSIONS_DIR = temp("dimensio-session-race-state-");
  // Hydration rebuilds the adapter, which needs a key. envKeys is captured at
  // module load, so set the runtime override instead of process.env.
  setConfig({ provider: "openai", apiKey: "sk-test-resume" });
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream() {
      yield { e: "text_delta" as const, text: "persisted" };
      yield { e: "turn_done" as const, stopReason: "end" as const };
    },
  };
  const session = createSession();
  attachState(session, adapter, root);
  session.cfg = {
    provider: "openai",
    model: "fake",
    thinking: "off",
    permissionMode: "auto",
    workspace: root,
    access: "workspace",
  };
  const id = session.id;
  await startRun(session, "persist me").done;
  assert.ok(await loadSession(id));

  // Evict from memory so the next access has to hydrate from disk — the state
  // both a server restart and a cold mirror attach land in.
  dropSession(id);

  // Two devices resume the same session at once. Before the in-flight dedup each
  // call built its OWN Session, the second sessions.set() evicted the first, and
  // startRun's per-object `running` guard let both run — two agents on one
  // transcript, each persist clobbering the other.
  const [a, b] = await Promise.all([getOrLoadSession(id), getOrLoadSession(id)]);
  assert.ok(a, "first resume returns a session");
  assert.strictEqual(a, b, "both resumes must observe the very same Session object");
  // And the resident instance is that same object, so a later attach joins it too.
  assert.strictEqual(await getOrLoadSession(id), a);
  dropSession(id);
});

test("a delete landing mid-hydration does not resurrect the session", async () => {
  const root = temp("dimensio-session-tomb-work-");
  process.env.SESSIONS_DIR = temp("dimensio-session-tomb-state-");
  // Hydration rebuilds the adapter, which needs a key. envKeys is captured at
  // module load, so set the runtime override instead of process.env.
  setConfig({ provider: "openai", apiKey: "sk-test-resume" });
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream() {
      yield { e: "text_delta" as const, text: "persisted" };
      yield { e: "turn_done" as const, stopReason: "end" as const };
    },
  };
  const session = createSession();
  attachState(session, adapter, root);
  session.cfg = {
    provider: "openai",
    model: "fake",
    thinking: "off",
    permissionMode: "auto",
    workspace: root,
    access: "workspace",
  };
  const id = session.id;
  await startRun(session, "persist me").done;
  dropSession(id);

  // Start hydrating, then delete before it registers.
  const pending = getOrLoadSession(id);
  dropSession(id);
  await deleteSessionFile(id);
  assert.equal(await pending, undefined, "a session deleted mid-load must not register");
  assert.equal(await loadSession(id), null, "and must not be persisted back to disk");
});

test("image attachments persist as asset refs and materialize for a multimodal provider", async () => {
  const root = temp("dimensio-session-image-work-");
  process.env.SESSIONS_DIR = temp("dimensio-session-image-state-");
  process.env.CHECKPOINTS = "off";
  fs.writeFileSync(path.join(root, "screen.png"), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
  ]));
  let providerTurn: any;
  let turnNo = 0;
  const adapter: ProviderAdapter = {
    id: "qwen",
    model: "qwen3.7-plus",
    capabilities: { ...capabilities, image: true },
    async *stream(turn) {
      turnNo++;
      if (turnNo === 1) {
        providerTurn = turn;
        yield { e: "text_delta" as const, text: "I can see it." };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      } else {
        yield {
          e: "tool_call" as const,
          id: "audit-image",
          name: "MemoryAudit",
          args: { decision: "none", reason: "The synthetic image test adds no durable project knowledge." },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      }
    },
  };
  const session = createSession();
  const state = attachState(session, adapter, root);
  session.cfg = {
    provider: "qwen",
    model: "qwen3.7-plus",
    thinking: "off",
    permissionMode: "auto",
    workspace: root,
    access: "workspace",
  };

  const run = startRun(session, "Inspect the screenshot", undefined, ["screen.png"]);
  await run.done;

  const storedImage = state.messages[0].content.find((block) => block.t === "image") as any;
  assert.match(storedImage.asset, /^[a-f0-9]{64}\.png$/);
  assert.equal(storedImage.data, undefined);
  assert.deepEqual(state.messages[0].attachments, [{ path: "screen.png", kind: "image" }]);
  const providerImage = providerTurn.messages[0].content.find((block: any) => block.t === "image");
  assert.equal(providerImage.asset, undefined);
  assert.equal(providerImage.data, "iVBORw0KGgoBAgME");

  const persisted = await loadSession(session.id);
  const persistedImage = persisted?.messages[0].content.find((block) => block.t === "image") as any;
  assert.equal(persistedImage.asset, storedImage.asset);
  assert.equal(persistedImage.data, undefined);
  state.appendUserBlocks([{ t: "image", mime: "image/png", data: "iVBORw0KGgoBAgME", name: "tool.png" }]);
  const toolFeedbackImage = state.messages.at(-1)?.content[0] as any;
  assert.match(toolFeedbackImage.asset, /^[a-f0-9]{64}\.png$/);
  assert.equal(toolFeedbackImage.data, undefined, "tool image feedback must also leave the transcript as an asset ref");
  dropSession(session.id);
});

test("image attachments stay as Read paths for a text-only main model", async () => {
  const root = temp("dimensio-session-text-image-");
  process.env.SESSIONS_DIR = temp("dimensio-session-text-image-state-");
  process.env.CHECKPOINTS = "off";
  fs.writeFileSync(path.join(root, "screen.png"), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9,
  ]));
  let firstTurn: any;
  let turnNo = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "deepseek-v4-pro",
    capabilities,
    async *stream(turn) {
      turnNo++;
      if (turnNo === 1) {
        firstTurn = turn;
        yield { e: "text_delta" as const, text: "I will use Read." };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      } else {
        yield {
          e: "tool_call" as const,
          id: "audit-text-image",
          name: "MemoryAudit",
          args: { decision: "none", reason: "The fallback routing test adds no durable project knowledge." },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      }
    },
  };
  const session = createSession();
  const state = attachState(session, adapter, root);
  const run = startRun(session, "Inspect this", undefined, ["screen.png"]);
  await run.done;

  assert.equal(firstTurn.messages[0].content.some((block: any) => block.t === "image"), false);
  assert.match(
    firstTurn.messages[0].content.map((block: any) => block.t === "text" ? block.text : "").join("\n"),
    /text-only; call Read/,
  );
  assert.deepEqual(state.messages[0].attachments, [{ path: "screen.png", kind: "image" }]);
  dropSession(session.id);
});

test("AskUserQuestion blocks the run, fans the question out, and resumes on answer", async () => {
  const root = temp("dimensio-session-ask-");
  process.env.SESSIONS_DIR = temp("dimensio-session-ask-store-");
  process.env.CHECKPOINTS = "off";
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream() {
      turn++;
      if (turn === 1) {
        yield {
          e: "tool_call" as const,
          id: "ask-1",
          name: "AskUserQuestion",
          args: { questions: [{ header: "库", question: "用哪个数据库？", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] }] },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "选 PostgreSQL，继续。" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };

  const session = createSession();
  // Own state: the ask tool + memory gate off (a successful ask re-arms the gate
  // and would stall this fake run, which never calls MemoryAudit).
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };
  session.state = new AgentState({
    adapter,
    system: "test",
    tools: [askUserQuestionTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map([[askUserQuestionTool.def.name, askUserQuestionTool]]),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });

  const events: any[] = [];
  watchSession(session, (event) => events.push(event));
  const run = startRun(session, "pick a database");
  assert.equal(run.started, true);

  // The run blocks: the question is fanned out and registered as pending.
  await waitFor(() => events.some((e) => e.e === "ask"));
  const ask = events.find((e) => e.e === "ask");
  assert.equal(ask.questions.length, 1);
  assert.equal(ask.questions[0].id, `${ask.id}:0`);
  assert.equal(session.pendingAsks.size, 1);
  // No generic tool chrome leaked for AskUserQuestion.
  assert.ok(!events.some((e) => e.e === "tool_start"));

  // Answer it — the resolution fans out and the run resumes to completion.
  assert.equal(answerAsk(session, ask.id, [{ selected: ["PostgreSQL"], custom: false }]), true);
  assert.ok(events.some((e) => e.e === "ask_answer" && e.id === ask.id));
  // A stale/duplicate answer is a no-op, not an error.
  assert.equal(answerAsk(session, ask.id, [{ selected: ["SQLite"] }]), false);

  await run.done;

  assert.equal(session.pendingAsks.size, 0);
  assert.equal(turn, 2, "the model got a second turn after the answer");
  const result = session.state!.messages
    .flatMap((m) => m.content)
    .find((b: any) => b.t === "tool_result" && b.id === "ask-1") as any;
  assert.ok(result, "the ask tool_result is in the transcript");
  assert.match(result.content.map((c: any) => (c.t === "text" ? c.text : "")).join(""), /PostgreSQL/);
  // Structured selections persist on the block for exact history reconstruction.
  assert.deepEqual(result.meta, { ask: { answers: [{ selected: ["PostgreSQL"], custom: false }] } });
  assert.ok(events.some((e) => e.e === "done"));
  dropSession(session.id);
});

test("readGuide merges machine-global + workspace guides, global first", () => {
  const root = temp("harness-guide-ws-");
  const globalFile = path.join(temp("harness-guide-global-"), "GUIDE.md");
  const saved = process.env.DIMENSIO_GLOBAL_GUIDE;
  try {
    fs.writeFileSync(globalFile, "GLOBAL RULES");
    process.env.DIMENSIO_GLOBAL_GUIDE = globalFile;

    // Workspace without its own GUIDE.md still gets the machine-global guide.
    assert.equal(readGuide(root), "GLOBAL RULES");

    // Both present: merged global-first so the project guide has the final word.
    fs.writeFileSync(path.join(root, "GUIDE.md"), "PROJECT RULES");
    assert.equal(readGuide(root), "GLOBAL RULES\n\nPROJECT RULES");

    // Global guide missing entirely: workspace guide alone.
    process.env.DIMENSIO_GLOBAL_GUIDE = path.join(root, "no-such-file.md");
    assert.equal(readGuide(root), "PROJECT RULES");

    // Neither present: no guide section at all.
    fs.rmSync(path.join(root, "GUIDE.md"));
    assert.equal(readGuide(root), undefined);
  } finally {
    if (saved === undefined) delete process.env.DIMENSIO_GLOBAL_GUIDE;
    else process.env.DIMENSIO_GLOBAL_GUIDE = saved;
  }
});
