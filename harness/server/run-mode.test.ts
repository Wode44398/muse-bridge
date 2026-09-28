// 运行档位从设置页搬到输入框旁之后的契约：切档要对【当前这条会话】立刻生效
// （运行中也算），plan 契约要跟着模式走（C4 起以 World State 片段送达，不改写 system），快照配置与所有附着设备都要同步。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { systemPrompt } from "./agent/prompt.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import { createSession, dropSession, setSessionMode, startRun, watchSession, type Session } from "./session.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { lastText, wireWorld } from "./test-harness/session-fixture.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { writeTool } from "./tools/write.ts";
import { readTool } from "./tools/read.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
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

const TOOLS = [memoryAuditTool, writeTool, readTool];

const idleAdapter: ProviderAdapter = {
  id: "openai",
  model: "fake",
  capabilities,
  async *stream() {
    yield { e: "turn_done" as const, stopReason: "end" as const };
  },
};

// 真实形状的 system（带 plan 段标记），否则测不到「plan 段跟着模式走」。
function attach(session: Session, adapter: ProviderAdapter, root: string, mode: "auto" | "read-only" | "plan" = "auto"): AgentState {
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    completeMemoryAudit: (d, r) => state.completeMemoryAudit(d, r),
  };
  state = new AgentState({
    adapter,
    system: systemPrompt({
      root,
      access: "workspace",
      permissionMode: mode,
      shell: "bash",
      platform: "linux",
      provider: "openai",
      model: "fake",
    }),
    tools: TOOLS.map((t) => t.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(TOOLS.map((t) => [t.def.name, t])),
    permissionMode: mode,
    permissionRules: { allow: [], deny: [], ask: [] },
  });
  session.state = state;
  session.cfg = {
    provider: "openai",
    model: "fake",
    thinking: "off",
    permissionMode: mode,
    workspace: root,
    access: "workspace",
  };
  return state;
}

test("切档落到三处：判定用的模式、会话快照配置、附着设备的广播", () => {
  const root = temp("dimensio-mode-");
  const session = createSession();
  const state = attach(session, idleAdapter, root);
  const events: any[] = [];
  watchSession(session, (ev) => events.push(ev));

  assert.deepEqual(setSessionMode(session, "read-only"), { ok: true });
  assert.equal(state.permissionMode, "read-only");
  assert.equal(session.cfg?.permissionMode, "read-only", "快照配置要跟上，否则重开会话又回到旧档");
  assert.ok(events.some((e) => e.e === "mode" && e.permissionMode === "read-only"));

  // 同档重复切 = 幂等，不再广播第二次
  const before = events.filter((e) => e.e === "mode").length;
  assert.deepEqual(setSessionMode(session, "read-only"), { ok: true });
  assert.equal(events.filter((e) => e.e === "mode").length, before);
  dropSession(session.id);
});

test("plan 契约跟着模式走（C4）：切进去以片段补上契约，切出来明说作废；system 一字不动", () => {
  const root = temp("dimensio-mode-plan-");
  const session = createSession();
  const state = wireWorld(attach(session, idleAdapter, root));
  const system = state.system;
  assert.equal(system.includes("PLAN MODE IS ACTIVE"), false);

  setSessionMode(session, "plan");
  assert.equal(state.injectWorldDelta(false), true);
  assert.match(lastText(state), /PLAN MODE IS ACTIVE/, "切进 plan 却不给契约，模型不会想到调 ExitPlanMode");
  assert.match(lastText(state), /ExitPlanMode/);
  assert.equal(state.injectWorldDelta(false), false, "没再变就不重复注入");

  setSessionMode(session, "auto");
  assert.equal(state.injectWorldDelta(false), true);
  assert.match(lastText(state), /no longer apply/, "切出 plan 不明说作废，模型以为自己还只读、会拒绝动手");
  // 以前每切一次就改写 system 的 plan 段，整个前缀缓存作废
  assert.equal(state.system, system, "切档不改写 system");
  assert.equal(state.systemRewrites, 0);
  dropSession(session.id);
});

test("Q3 运行中切出 plan（C4）：下一次请求就带上作废片段，system 不变，请求不变量不记违规", { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-mode-q3-");
  fs.writeFileSync(path.join(root, "a.txt"), "hello");
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const adapter = scripted(t).next(
    async function* () {
      await released; // 第一次请求已经发出，等测试切档
      yield* useTool("r1", "Read", { path: "a.txt" });
    },
    say("好了"),
    useTool("audit", "MemoryAudit", { decision: "none", reason: "Synthetic test turn produces no durable project knowledge." }),
  );
  const session = createSession();
  const state = wireWorld(attach(session, adapter, root, "plan"));
  const run = startRun(session, "看一下 a.txt");
  // 等待失败也必须放行脚本里的第一步，否则整套测试挂死
  try {
    await waitFor(() => adapter.callCount >= 1);
    assert.deepEqual(setSessionMode(session, "auto"), { ok: true });
  } finally {
    release();
  }
  await run.done;
  const systemOf = (call: number) => String(adapter.inputs[call].system);
  const tailOf = (call: number) => JSON.stringify(adapter.inputs[call].messages.at(-1));
  assert.match(systemOf(0), /PLAN MODE IS ACTIVE/);
  assert.equal(systemOf(1), systemOf(0), "切档不改写 system（前缀缓存不断）");
  assert.match(tailOf(1), /no longer apply/, "切档后的下一次请求就该带上作废片段");
  assert.equal(state.systemRewrites, 0);
  assert.equal(state.invariantViolations, 0, `不该记违规：${state.invariantSamples.join(" | ")}`);
  dropSession(session.id);
});

test("非法档位与未开跑的会话都被挡在门外", () => {
  const root = temp("dimensio-mode-bad-");
  const session = createSession();
  assert.deepEqual(setSessionMode(session, "auto"), { ok: false, error: "session has not started" });
  attach(session, idleAdapter, root);
  assert.deepEqual(setSessionMode(session, "bypass"), { ok: false, error: "invalid mode" });
  assert.deepEqual(setSessionMode(session, 3), { ok: false, error: "invalid mode" });
  assert.equal(session.state!.permissionMode, "auto");
  dropSession(session.id);
});

test("运行中切只读 = 给正在跑的 agent 拉手刹，下一次写调用当场被拒", { timeout: 15_000 }, async () => {
  const root = temp("dimensio-mode-live-");
  let turn = 0;
  let held = true;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities,
    async *stream() {
      turn++;
      if (turn === 1) {
        yield { e: "text_delta" as const, text: "开工" };
        while (held) await new Promise((r) => setTimeout(r, 5)); // 等测试切档
        yield { e: "turn_done" as const, stopReason: "end" as const };
      } else if (turn === 2) {
        yield {
          e: "tool_call" as const,
          id: "w1",
          name: "Write",
          args: { path: "out.txt", content: "hello" },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else if (turn === 3) {
        yield {
          e: "tool_call" as const,
          id: "audit",
          name: "MemoryAudit",
          args: { decision: "none", reason: "Synthetic test turn produces no durable project knowledge." },
        };
        yield { e: "turn_done" as const, stopReason: "tool_use" as const };
      } else {
        yield { e: "text_delta" as const, text: "停手了" };
        yield { e: "turn_done" as const, stopReason: "end" as const };
      }
    },
  };
  const session = createSession();
  attach(session, adapter, root);
  const events: any[] = [];
  const run = startRun(session, "写个文件");
  watchSession(session, (ev) => events.push(ev));
  // 等待失败也必须放行假 provider：否则 while(held) 让本测试进程永不退出，全量并发时整套挂死。
  try {
    await waitFor(() => events.some((e) => e.e === "text_delta" && e.text === "开工"));
    assert.deepEqual(setSessionMode(session, "read-only"), { ok: true });
  } finally {
    held = false;
  }
  await run.done;

  const denial = events.find((e) => e.e === "tool_permission" && e.name === "Write");
  assert.ok(denial, "运行中切只读之后，写调用必须被拒");
  assert.match(String(denial.reason), /read-only/);
  assert.equal(fs.existsSync(path.join(root, "out.txt")), false, "被拒的写不能落地");
  dropSession(session.id);
});
