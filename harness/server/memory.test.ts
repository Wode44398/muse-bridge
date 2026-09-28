import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentState, isPureSocialTurn, visibleMessages } from "./agent/state.ts";
import { tagLegacyOrigins } from "./agent/injections.ts";
import type { Msg } from "./agent/turn.ts";

// C3：C3 之前的旧记录读入时先按开头补标来源（store.ts）——测旧记录的可见性要照样走一遍
const legacyLoaded = (messages: Msg[]): Msg[] => (tagLegacyOrigins(messages), messages);
import { ensureContextFits } from "./agent/context.ts";
import { runAgent } from "./agent/loop.ts";
import { refreshMemoryIndex } from "./agent/prompt.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { rememberTool } from "./tools/remember.ts";
import { verificationAuditTool } from "./tools/verificationaudit.ts";
import type { Tool, ToolContext } from "./tools/types.ts";
import { fakeSummary } from "./test-harness/scripted-adapter.ts";
import {
  listMemories,
  memoryDir,
  readMemory,
  renderMemoryForPrompt,
  saveMemory,
} from "./memory.ts";

const tempRoots: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// test-setup.ts 给的基线（临时目录）。收尾还原它，不要 delete——delete 之后的解析会回落到生产目录（#14），Q8 起直接抛错。
const BASE_MEMORY_DIR = process.env.MEMORY_DIR;

afterEach(() => {
  if (BASE_MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = BASE_MEMORY_DIR;
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

test("memory is isolated per workspace and uses structured descriptions", () => {
  process.env.MEMORY_DIR = temp("dimensio-memory-");
  const workspaceA = temp("workspace-a-");
  const workspaceB = temp("workspace-b-");
  writeFileSync(path.join(workspaceA, "package.json"), "{}\n", "utf8");

  const saved = saveMemory(workspaceA, {
    title: "Choose SQLite",
    description: "Relevant when changing the local persistence layer.",
    type: "project",
    topic: "persistence.database",
    status: "active",
    confidence: "verified",
    content: "SQLite was chosen for atomic local writes.\n\nWhy: crash safety.\nHow to apply: keep one database.",
    evidence: ["node --test persistence.test.ts passed"],
    anchors: ["package.json"],
    verifiedAt: "2026-07-16T12:00:00.000Z",
    verifiedCommit: "abcdef1",
  });

  assert.equal(saved.id, "choose-sqlite");
  assert.equal(listMemories(workspaceA).length, 1);
  assert.deepEqual(listMemories(workspaceB), []);
  assert.match(renderMemoryForPrompt(workspaceA)!, /project; active\/verified; topic=persistence\.database/);
  assert.equal(readMemory(workspaceA, saved.id)?.description, "Relevant when changing the local persistence layer.");

  const raw = readFileSync(path.join(memoryDir(workspaceA), `${saved.id}.md`), "utf8");
  assert.match(raw, /schema: 2/);
  assert.match(raw, /description: "Relevant when changing the local persistence layer\."/);
  assert.match(raw, /topic: "persistence\.database"/);
  assert.match(raw, /status: active/);
  assert.match(raw, /metadata:\n  type: project/);
  assert.equal(readdirSync(memoryDir(workspaceA)).some((f) => f.endsWith(".tmp")), false);
});

test("legacy global notes migrate once without leaking into later workspaces", () => {
  const root = temp("dimensio-legacy-");
  process.env.MEMORY_DIR = root;
  writeFileSync(
    path.join(root, "old-note.md"),
    "---\ntitle: Old note\nupdated: 2026-01-01T00:00:00.000Z\n---\nA legacy decision and its reason.\n",
    "utf8",
  );
  const workspaceA = temp("legacy-a-");
  const workspaceB = temp("legacy-b-");

  const legacy = listMemories(workspaceA)[0];
  assert.equal(legacy?.title, "Old note");
  assert.equal(legacy?.status, "proposed");
  assert.equal(legacy?.confidence, "inferred");
  assert.ok(legacy?.issues.includes("legacy-schema"));
  assert.doesNotMatch(renderMemoryForPrompt(workspaceA)!, /A legacy decision/);
  assert.match(renderMemoryForPrompt(workspaceA)!, /1 proposed\/stale\/superseded notes omitted/);
  assert.deepEqual(listMemories(workspaceB), []);
});

test("memory quality gate rejects secrets and ungrounded active claims", () => {
  process.env.MEMORY_DIR = temp("dimensio-quality-");
  const workspace = temp("quality-workspace-");

  assert.throws(
    () =>
      saveMemory(workspace, {
        title: "Provider key",
        description: "Never store this value.",
        type: "reference",
        topic: "provider.api-key",
        status: "proposed",
        confidence: "inferred",
        content: "api_key=sk-1234567890abcdefghijklmnop",
      }),
    /credential or private key/,
  );

  assert.throws(
    () =>
      saveMemory(workspace, {
        title: "Choose a queue",
        description: "Relevant when changing background jobs.",
        type: "project",
        topic: "jobs.queue",
        status: "active",
        confidence: "inferred",
        content: "Use Redis.\n\nWhy: throughput.\nHow to apply: keep one queue.",
      }),
    /cannot have inferred confidence/,
  );

  const legacyDir = memoryDir(workspace);
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    path.join(legacyDir, "legacy-secret.md"),
    "---\ntitle: Leaked token\n---\napi_key=sk-1234567890abcdefghijklmnop\n",
    "utf8",
  );
  const leaked = readMemory(workspace, "legacy-secret");
  assert.equal(leaked?.status, "stale");
  assert.ok(leaked?.issues.includes("sensitive-content"));
  assert.doesNotMatch(leaked?.content ?? "", /sk-1234567890/);
});

test("Remember names every problem in one response instead of one per call", async () => {
  process.env.MEMORY_DIR = temp("dimensio-remember-drip-");
  const workspace = temp("remember-workspace-");
  const ctx: ToolContext = {
    sandbox: new Sandbox(workspace),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };
  const text = (result: Awaited<ReturnType<typeof rememberTool.run>>) =>
    result.content.map((block) => (block.t === "text" ? block.text : "")).join("\n");

  // The shape of the real 2026-08-16 k3 call: no description, verified with
  // neither evidence nor verifiedAt, and an active project note missing its
  // Why/How to apply sections. Reported one at a time, that is four round trips.
  const rejected = await rememberTool.run(
    {
      title: "podstream 构建环境",
      content: "Gradle 必须用工作区 JDK21。",
      type: "project",
      topic: "android-build.environment",
      status: "active",
      confidence: "verified",
    },
    ctx,
  );
  assert.equal(rejected.ok, false);
  for (const expected of [/description/, /evidence/, /verifiedAt/, /Why/, /How to apply/]) {
    assert.match(text(rejected), expected);
  }

  // Everything the one message asked for, supplied in a single retry.
  const saved = await rememberTool.run(
    {
      title: "podstream 构建环境",
      description: "构建 podstream 时须用工作区 JDK21。",
      content: "Gradle 必须用工作区 JDK21。\n\nWhy: 系统 Java 26 会让构建脚本编译失败。\nHow to apply: local.properties 指向 .sdk 与 JDK21。",
      type: "project",
      topic: "android-build.environment",
      status: "active",
      confidence: "verified",
      evidence: ["./gradlew assembleDebug 在 JDK21 下 BUILD SUCCESSFUL"],
      verifiedAt: new Date().toISOString(),
    },
    ctx,
  );
  assert.equal(saved.ok, true, text(saved));
  assert.equal(listMemories(workspace).length, 1);
});

test("active topic conflicts require an explicit superseding decision", () => {
  process.env.MEMORY_DIR = temp("dimensio-conflict-");
  const workspace = temp("conflict-workspace-");
  const base = {
    description: "Relevant when choosing the local database.",
    type: "project" as const,
    topic: "persistence.database",
    status: "active" as const,
    confidence: "user_confirmed" as const,
    content: "Use SQLite.\n\nWhy: the user selected it.\nHow to apply: keep local data in SQLite.",
  };
  const old = saveMemory(workspace, { ...base, title: "Use SQLite" });

  assert.throws(
    () => saveMemory(workspace, { ...base, title: "Use Postgres", content: base.content.replaceAll("SQLite", "Postgres") }),
    /active topic conflict/,
  );

  const replacement = saveMemory(workspace, {
    ...base,
    title: "Use Postgres",
    content: base.content.replaceAll("SQLite", "Postgres"),
    supersedes: old.id,
  });
  assert.equal(readMemory(workspace, old.id)?.status, "superseded");
  assert.equal(readMemory(workspace, old.id)?.supersededBy, replacement.id);
  assert.equal(readMemory(workspace, replacement.id)?.status, "active");
  assert.equal(readMemory(workspace, replacement.id)?.supersedes, old.id);
});

test("expiry and missing anchors quarantine notes from the prompt", () => {
  process.env.MEMORY_DIR = temp("dimensio-expiry-");
  const workspace = temp("expiry-workspace-");
  const common = {
    type: "reference" as const,
    status: "proposed" as const,
    confidence: "inferred" as const,
    content: "A temporary operational pointer.",
  };
  saveMemory(workspace, {
    ...common,
    title: "Expired endpoint",
    description: "Temporary endpoint retained for diagnosis.",
    topic: "ops.endpoint",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  saveMemory(workspace, {
    ...common,
    title: "Missing config anchor",
    description: "Configuration fact whose source file disappeared.",
    topic: "ops.config",
    anchors: ["missing-config.json"],
  });

  const items = listMemories(workspace);
  assert.ok(items.every((m) => m.status === "stale"));
  assert.ok(items.some((m) => m.issues.includes("expired")));
  assert.ok(items.some((m) => m.issues.includes("missing-anchor:missing-config.json")));
  assert.doesNotMatch(renderMemoryForPrompt(workspace)!, /Expired endpoint|Missing config anchor/);
});

test("resumed prompts replace only the memory index", () => {
  const old =
    "core prompt\n\n## Project guide (GUIDE.md)\nkeep this guide\n\n" +
    "## Memory index\nold unsafe memory";
  const refreshed = refreshMemoryIndex(old, "- [safe] current active memory");
  assert.match(refreshed, /core prompt/);
  assert.match(refreshed, /keep this guide/);
  assert.match(refreshed, /\[safe\] current active memory/);
  assert.doesNotMatch(refreshed, /old unsafe memory/);
  assert.equal(refreshMemoryIndex(old), "core prompt\n\n## Project guide (GUIDE.md)\nkeep this guide");
});

function makeState(adapter: ProviderAdapter, workspace: string, extraTools: Tool[] = []): AgentState {
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(workspace),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    completeMemoryAudit: (decision, reason) => state.completeMemoryAudit(decision, reason),
    completeVerificationAudit: (decision, reason) => state.completeVerificationAudit(decision, reason),
    noteMemoryChanged: () => state.noteMemoryChanged(),
  };
  const tools = [memoryAuditTool, ...extraTools];
  state = new AgentState({
    adapter,
    system: "test",
    tools: tools.map((tool) => tool.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(tools.map((tool) => [tool.def.name, tool])),
    permissionMode: "auto",
  });
  return state;
}

test("pure greetings skip memory audit without swallowing requests or preferences", async () => {
  const workspace = temp("social-fast-path-");
  assert.equal(isPureSocialTurn("你好！"), true);
  assert.equal(isPureSocialTurn("Hello"), true);
  assert.equal(isPureSocialTurn("谢谢你～"), true);
  assert.equal(isPureSocialTurn("你好，以后都用中文"), false);
  assert.equal(isPureSocialTurn("hello, remember this"), false);

  let turns = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: {
      contextWindow: 100_000, maxOutputTokens: 1000, thinking: false,
      image: false, video: false, cache: false, parallelToolCalls: false,
    },
    async *stream() {
      turns++;
      yield { e: "text_delta" as const, text: "你好！" };
      yield { e: "turn_done" as const, stopReason: "end" as const };
    },
  };
  const state = makeState(adapter, workspace);
  state.addUserMessage("你好！");
  assert.equal(state.memoryAuditAutoSkipped, true);
  assert.equal(state.memoryAuditCompleted, true);
  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);
  assert.equal(turns, 1);
  assert.equal(state.messages.some((m) => m.content.some((b) => b.t === "tool_call" && b.name === "MemoryAudit")), false);
  assert.equal(state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.includes("Memory audit required"))), false);
  assert.equal(events.filter((event) => event.e === "text_delta").length, 1);

  const preference = makeState(adapter, workspace);
  preference.addUserMessage("你好，以后都用中文");
  assert.equal(preference.memoryAuditAutoSkipped, false);
  assert.equal(preference.memoryAuditCompleted, false);
});

test("agent loop reuses a pre-audit final instead of generating a duplicate", async () => {
  const workspace = temp("audit-workspace-");
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: {
      contextWindow: 100_000,
      maxOutputTokens: 1000,
      thinking: false,
      image: false,
      video: false,
      cache: false,
      parallelToolCalls: false,
    },
    async *stream() {
      turn++;
      if (turn === 1) {
        yield { e: "text_delta" as const, text: "premature final" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      } else if (turn === 2) {
        yield { e: "thinking_delta" as const, text: "I should explain the audit." };
        yield { e: "text_delta" as const, text: "No durable knowledge was produced." };
        yield {
          e: "tool_call" as const,
          id: "audit-1",
          name: "MemoryAudit",
          args: { decision: "none", reason: "Only inspected existing state; no durable fact changed." },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        throw new Error("a successful audit must not trigger a duplicate final turn");
      }
    },
  };
  const state = makeState(adapter, workspace);
  state.addUserMessage("inspect something");
  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);

  assert.equal(turn, 2);
  assert.equal(state.memoryAuditCompleted, true);
  assert.ok(state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.includes("Memory audit required"))));
  assert.ok(state.messages.some((m) => m.internal && m.content.some((b) => b.t === "tool_call" && b.name === "MemoryAudit")));
  const visibleTranscript = visibleMessages(state.messages);
  const visibleAnswers = visibleTranscript.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((b) => b.t === "text").map((b) => b.text) : [],
  );
  assert.deepEqual(visibleAnswers, ["premature final"]);
  assert.equal(visibleTranscript.length, 2);
  // #79：答复留在原位（以前被挪到转录末尾 = 改写模型已经看过的历史），它后面只有 internal 的审计往返
  const answerAt = state.messages.findIndex((m) => m.role === "assistant" && !m.internal);
  assert.ok(answerAt > 0 && state.messages.slice(answerAt + 1).every((m) => m.internal));
  assert.equal(events.filter((event) => event.e === "text_delta").length, 1);
  assert.equal(events.some((event) => event.e === "thinking_delta"), false);
  assert.equal(events.some((event) => event.e === "tool_start" && event.name === "MemoryAudit"), false);
  assert.equal(events.some((event) => event.e === "tool_end" && event.name === "MemoryAudit"), false);
  assert.equal(events.at(-1)?.e, "done");
  const completedTranscriptLength = state.messages.length;
  state.addUserMessage("你好");
  assert.equal(state.messages.length, completedTranscriptLength + 1);
  assert.equal(state.memoryAuditAutoSkipped, true);
});

const FAKE_CAPABILITIES = {
  contextWindow: 100_000,
  maxOutputTokens: 1000,
  thinking: false,
  image: false,
  video: false,
  cache: false,
  parallelToolCalls: false,
};

test("an answer batched with the memory checkpoint finishes on that turn", async () => {
  process.env.MEMORY_DIR = temp("dimensio-memory-");
  const workspace = temp("same-turn-audit-");
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: FAKE_CAPABILITIES,
    async *stream() {
      turn++;
      if (turn > 1) throw new Error("a same-turn audit must not buy a duplicate final turn");
      yield { e: "thinking_delta" as const, text: "plain factual question" };
      yield { e: "text_delta" as const, text: "**RTX 3090 基于 Ampere 架构**，核心代号 GA102。" };
      yield {
        e: "tool_call" as const,
        id: "audit-1",
        name: "MemoryAudit",
        args: { decision: "none", reason: "纯事实问答，没有产生需要跨会话保留的项目知识。" },
      };
      yield { e: "turn_done" as const, stopReason: "tool_use" as const };
    },
  };
  const state = makeState(adapter, workspace);
  state.addUserMessage("3090是什么架构");
  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);

  assert.equal(turn, 1);
  assert.equal(state.memoryAuditCompleted, true);
  assert.equal(events.at(-1)?.e, "done");
  assert.equal(events.filter((event) => event.e === "text_delta").length, 1);
  // The checkpoint stays silent, and no nudge was ever needed.
  assert.equal(events.some((event) => event.e === "tool_start" && event.name === "MemoryAudit"), false);
  assert.equal(
    state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.includes("Memory audit required"))),
    false,
  );
  const visibleAnswers = visibleMessages(state.messages).flatMap((m) =>
    m.role === "assistant" ? m.content.filter((b) => b.t === "text").map((b) => b.text) : [],
  );
  assert.deepEqual(visibleAnswers, ["**RTX 3090 基于 Ampere 架构**，核心代号 GA102。"]);
  // The tool result still closes the transcript so the next run resumes cleanly.
  assert.ok(state.messages.at(-1)?.content.some((b) => b.t === "tool_result" && b.id === "audit-1" && b.ok));
});

test("a Remember that precedes the same-turn checkpoint still finishes there", async () => {
  process.env.MEMORY_DIR = temp("dimensio-memory-");
  const workspace = temp("same-turn-remember-");
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: FAKE_CAPABILITIES,
    async *stream() {
      turn++;
      if (turn > 1) throw new Error("Remember + MemoryAudit in one turn must not buy a duplicate final turn");
      yield { e: "text_delta" as const, text: "记下了，以后都用中文回复。" };
      yield {
        e: "tool_call" as const,
        id: "remember-1",
        name: "Remember",
        args: {
          title: "reply language",
          content: "用户要求一律用中文回复。",
          description: "用户对回复语言的长期偏好。",
          type: "user",
          topic: "user.response-language",
          status: "active",
          confidence: "user_confirmed",
        },
      };
      yield {
        e: "tool_call" as const,
        id: "audit-1",
        name: "MemoryAudit",
        args: { decision: "updated", reason: "保存了用户的长期语言偏好。" },
      };
      yield { e: "turn_done" as const, stopReason: "tool_use" as const };
    },
  };
  const state = makeState(adapter, workspace, [rememberTool]);
  state.addUserMessage("以后都用中文");
  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);

  assert.equal(turn, 1);
  assert.equal(state.memoryAuditCompleted, true);
  assert.ok(state.messages.at(-1)?.content.every((b) => b.t === "tool_result" && b.ok));
  assert.equal(events.at(-1)?.e, "done");
  assert.equal(events.filter((event) => event.e === "text_delta").length, 1);
});

test("a preamble batched with the checkpoint does not end the run", async () => {
  process.env.MEMORY_DIR = temp("dimensio-memory-");
  const workspace = temp("same-turn-preamble-");
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: FAKE_CAPABILITIES,
    async *stream() {
      turn++;
      if (turn === 1) {
        // The shape that truncated a real run: text that only ANNOUNCES the
        // checkpoint, with the actual deliverable still queued behind it.
        yield { e: "text_delta" as const, text: "全部断言通过。执行强制审计收尾：" };
        yield {
          e: "tool_call" as const,
          id: "audit-1",
          name: "MemoryAudit",
          args: { decision: "none", reason: "本轮没有产生需要跨会话保留的项目知识。" },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "交付总结：报告已写入 REVIEW.md，共 11 条问题。" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };
  const state = makeState(adapter, workspace);
  state.addUserMessage("跑完体检并产出报告");

  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);

  assert.equal(turn, 2, "a colon-terminated preamble is not a finished answer");
  assert.equal(events.filter((event) => event.e === "text_delta").length, 2);
  assert.equal(events.at(-1)?.e, "done");
});

test("an open todo list keeps the run going past the checkpoint turn", async () => {
  process.env.MEMORY_DIR = temp("dimensio-memory-");
  const workspace = temp("same-turn-todos-");
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: FAKE_CAPABILITIES,
    async *stream() {
      turn++;
      if (turn === 1) {
        yield { e: "text_delta" as const, text: "审计已记录。" };
        yield {
          e: "tool_call" as const,
          id: "audit-1",
          name: "MemoryAudit",
          args: { decision: "none", reason: "本轮的结论都能从报告文件里读到，没有额外的持久知识。" },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "剩下的收尾也做完了，交付总结如上。" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };
  const state = makeState(adapter, workspace);
  state.addUserMessage("跑完体检并产出报告");
  // The model's own plan says work remains — finishing here would drop it.
  state.todos = [
    { content: "产出评价报告", status: "completed" },
    { content: "MemoryAudit 收尾 + 交付总结", status: "in_progress" },
  ];

  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);

  assert.equal(turn, 2, "an unfinished todo outranks the same-turn closure shortcut");
  assert.equal(events.at(-1)?.e, "done");
});

test("the verification gate outranks a same-turn memory checkpoint", async () => {
  process.env.MEMORY_DIR = temp("dimensio-memory-");
  const workspace = temp("same-turn-dirty-");
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: FAKE_CAPABILITIES,
    async *stream() {
      turn++;
      if (turn === 1) {
        yield { e: "text_delta" as const, text: "改完了。" };
        yield {
          e: "tool_call" as const,
          id: "audit-1",
          name: "MemoryAudit",
          args: { decision: "none", reason: "改动本身可以从代码读出来，没有额外的持久知识。" },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else if (turn === 2) {
        yield {
          e: "tool_call" as const,
          id: "vaudit-1",
          name: "VerificationAudit",
          args: {
            decision: "blocked",
            reason: "这个沙箱工作区里既没有测试框架也没有可运行的构建命令，无法执行任何自动化检查。",
          },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "改完了，但无法在本环境验证。" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };
  const state = makeState(adapter, workspace, [verificationAuditTool]);
  state.addUserMessage("改一下这个文件");
  // Stand in for an Edit/Write earlier in the run: the tree is dirty and
  // nothing has verified it yet.
  state.editedFiles.add(path.join(workspace, "src.ts"));
  state.recordMutation();

  const events = [];
  for await (const event of runAgent(state, new AbortController().signal)) events.push(event);

  // Turn 1 must NOT have finished the run despite the closed memory checkpoint:
  // the dirty tree still owed evidence, so the loop kept going and the model got
  // to record its verification limitation before the real final answer.
  assert.equal(turn, 3);
  assert.equal(state.verificationAuditCompleted, true);
  assert.equal(state.dirtySinceVerify, true); // an audit is not a pass
  assert.equal(events.filter((event) => event.e === "text_delta").length, 2);
  assert.equal(events.at(-1)?.e, "done");
});

test("visible transcript removes legacy audit continuations but preserves ordinary memory tools", () => {
  const legacy = visibleMessages(legacyLoaded([
    { role: "user", content: [{ t: "text", text: "inspect the workspace" }] },
    { role: "assistant", content: [{ t: "text", text: "workspace summary" }] },
    { role: "user", content: [{ t: "text", text: "[Memory audit required] audit now" }] },
    {
      role: "assistant",
      content: [
        { t: "thinking", text: "internal audit thought" },
        { t: "text", text: "Nothing warrants durable storage." },
        { t: "tool_call", id: "old-audit", name: "MemoryAudit", args: { decision: "none" } },
      ],
    },
    { role: "user", content: [{ t: "tool_result", id: "old-audit", ok: true, content: [{ t: "text", text: "ok" }] }] },
    { role: "assistant", content: [{ t: "text", text: "duplicated workspace summary" }] },
  ]));
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map((message) => message.content[0]), [
    { t: "text", text: "inspect the workspace" },
    { t: "text", text: "workspace summary" },
  ]);

  const ordinaryRecall = visibleMessages([
    {
      role: "assistant",
      content: [{ t: "tool_call", id: "recall-1", name: "Recall", args: { query: "architecture" } }],
    },
    { role: "user", content: [{ t: "tool_result", id: "recall-1", ok: true, content: [{ t: "text", text: "result" }] }] },
  ]);
  assert.equal(ordinaryRecall.length, 2);

  const interruptedAudit = visibleMessages(legacyLoaded([
    { role: "user", content: [{ t: "text", text: "first request" }] },
    { role: "user", content: [{ t: "text", text: "[Memory audit required] audit now" }] },
    { role: "assistant", content: [{ t: "text", text: "audit interrupted" }] },
    { role: "user", content: [{ t: "text", text: "next real request" }] },
    { role: "assistant", content: [{ t: "text", text: "next answer" }] },
  ]));
  assert.deepEqual(
    interruptedAudit.flatMap((message) => message.content.filter((block) => block.t === "text").map((block) => block.text)),
    ["first request", "next real request", "next answer"],
  );
});

test("audit decisions must agree with actual Remember activity", () => {
  const workspace = temp("audit-state-");
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: {
      contextWindow: 100_000,
      maxOutputTokens: 1000,
      thinking: false,
      image: false,
      video: false,
      cache: false,
      parallelToolCalls: false,
    },
    async *stream() {},
  };
  const state = makeState(adapter, workspace);
  assert.equal(
    state.completeMemoryAudit("updated", "Saved the durable architecture decision and rationale.").ok,
    false,
  );
  state.noteMemoryChanged();
  assert.equal(
    state.completeMemoryAudit("none", "No durable knowledge needed to be saved during this run.").ok,
    false,
  );
  assert.equal(
    state.completeMemoryAudit("updated", "Saved the durable architecture decision and rationale.").ok,
    true,
  );
});

test("full compaction requires a successful audit first", async () => {
  const workspace = temp("compact-workspace-");
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "summarizer",
    capabilities: {
      contextWindow: 15_000,
      maxOutputTokens: 1000,
      thinking: false,
      image: false,
      video: false,
      cache: false,
      parallelToolCalls: false,
    },
    async *stream() {
      yield { e: "text_delta" as const, text: fakeSummary("preserved summary") };
      yield { e: "turn_done" as const, stopReason: "end" as const };
    },
  };
  const state = makeState(adapter, workspace);
  state.messages = Array.from({ length: 10 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    content: [{ t: "text" as const, text: `${i}:` + "x".repeat(3200) }],
  }));

  const blocked = await ensureContextFits(state);
  assert.equal(blocked.auditRequired, true);
  assert.equal(blocked.compacted, false);

  assert.equal(
    state.completeMemoryAudit("none", "The transcript contains no durable project knowledge.").ok,
    true,
  );
  const compacted = await ensureContextFits(state);
  assert.equal(compacted.auditRequired, undefined);
  assert.equal(compacted.compacted, true);
  assert.ok(state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.includes("Earlier context summary"))));
  assert.equal(state.preCompactAuditPassed, false);
  assert.equal(state.memoryAuditCompleted, false);
});
