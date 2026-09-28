// R6（#32）：中断与失败说真话。改写自探针 03-hermes-agent/笔记/probe-heal-inflight.ts。
//
// 修前：① 用户在两个工具批次之间停下，loop 直接 return，已经跑完（带副作用）的结果不入转录；
// ② 流到一半被停，已经显示给用户的文字不入转录；③ 失败轮在转录里没有任何痕迹；④ 进程在工具执行
// 中途死掉，恢复时一律回填「Not executed … Re-issue the call」——副作用已经落盘时这是假话，会诱导
// 模型把 git commit / 发版 / 迁移再跑一遍；运行中的记录还要等 2 秒防抖才落盘。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { runAgent } from "./agent/loop.ts";
import { setConfig } from "./config.ts";
import { createSession, dropSession, getOrLoadSession, startRun, stopSession } from "./session.ts";
import { loadSession, saveSession } from "./store.ts";
import { Sandbox } from "./sandbox.ts";
import type { AgentEvent, StreamEvent } from "./agent/events.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { Tool, ToolContext } from "./tools/types.ts";

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
    try {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      /* Windows 句柄占用就留给系统清 */
    }
  }
});

const capabilities = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };

function adapterOf(stream: (turn: Turn, index: number, signal?: AbortSignal) => AsyncGenerator<StreamEvent>): ProviderAdapter {
  let n = 0;
  return { id: "openai", model: "fake", capabilities, stream: (turn, signal) => stream(turn, n++, signal) };
}

function ctxFor(root: string): ToolContext {
  return { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false };
}

function stateWith(adapter: ProviderAdapter, root: string, tools: Tool[]): AgentState {
  return new AgentState({
    adapter,
    system: "test",
    tools: tools.map((t) => t.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: ctxFor(root),
    toolMap: new Map(tools.map((t) => [t.def.name, t])),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
}

function stepTool(onRun: (callNo: number) => void | Promise<void>): Tool & { runs: number } {
  const tool = {
    runs: 0,
    effect: "exec" as const,
    concurrencySafe: false,
    def: { name: "Step", description: "test step", parameters: { type: "object" as const, properties: {} } },
    async run() {
      tool.runs++;
      await onRun(tool.runs);
      return { ok: true, summary: `step ${tool.runs} done`, content: [{ t: "text" as const, text: `step ${tool.runs} done` }] };
    },
  };
  return tool;
}

async function drain(gen: AsyncGenerator<AgentEvent>, onEvent: (ev: AgentEvent) => void = () => {}): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const ev of gen) {
    seen.push(ev);
    onEvent(ev);
  }
  return seen;
}

const textOf = (m: Msg | undefined) => (m?.content ?? []).map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? b.content.map((c) => (c.t === "text" ? c.text : "")).join("") : "")).join("\n");

test("用户在两个批次之间停下：已跑完的结果照实入转录，没轮到的明说没执行、别自动重试", async () => {
  const ctrl = new AbortController();
  const step = stepTool((no) => {
    if (no === 1) ctrl.abort(); // 第一个调用执行期间，用户点了停止
  });
  const adapter = adapterOf(async function* () {
    yield { e: "tool_call", id: "s1", name: "Step", args: {} };
    yield { e: "tool_call", id: "s2", name: "Step", args: {} };
    yield { e: "turn_done", stopReason: "tool_use" };
  });
  const st = stateWith(adapter, temp("dimensio-r6-a-"), [step]);
  st.addUserMessage("do two steps");
  await drain(runAgent(st, ctrl.signal));
  assert.equal(step.runs, 1, "第二个调用没有执行");
  const last = st.messages.at(-1)!;
  assert.equal(last.role, "user");
  const results = last.content.filter((b) => b.t === "tool_result");
  assert.deepEqual(results.map((b) => [b.id, b.ok]), [["s1", true], ["s2", false]]);
  assert.match(textOf(last), /step 1 done/);
  assert.match(textOf(last), /user stopped the run before this call started/);
});

test("流到一半被停：已经显示给用户的文字进转录，并注明被中断", async () => {
  const ctrl = new AbortController();
  const adapter = adapterOf(async function* (_turn, _i, signal) {
    yield { e: "text_delta", text: "Here is the first half of my answer" };
    // 像 fetch 一样：信号已经中止就立刻抛，否则等中止再抛（兜底 5 秒，测试绝不挂死）。
    if (signal?.aborted) throw new Error("aborted");
    await new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      setTimeout(() => reject(new Error("test adapter: abort never arrived")), 5_000).unref();
    });
  });
  const st = stateWith(adapter, temp("dimensio-r6-b-"), []);
  st.addUserMessage("explain");
  await drain(runAgent(st, ctrl.signal), (ev) => {
    if (ev.e === "text_delta") ctrl.abort();
  });
  const last = st.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.ok(!last.internal, "用户看得见的文字，转录里也看得见");
  assert.match(textOf(last), /first half of my answer/);
  assert.match(textOf(last), /\[interrupted by the user\]/);
});

test("失败轮补一条 assistant 边界：写明出了什么错、这一轮已经跑过哪些工具", async () => {
  const step = stepTool(() => {});
  const adapter = adapterOf(async function* (_turn, i) {
    if (i === 0) {
      yield { e: "tool_call", id: "s1", name: "Step", args: {} };
      yield { e: "turn_done", stopReason: "tool_use" };
      return;
    }
    yield { e: "error", kind: "http_400", retriable: false, raw: "bad request from upstream" };
  });
  const st = stateWith(adapter, temp("dimensio-r6-c-"), [step]);
  st.addUserMessage("go");
  const events = await drain(runAgent(st, new AbortController().signal));
  assert.ok(events.some((e) => e.e === "error"));
  const last = st.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.equal(last.internal, true, "只给模型看，聊天记录里已经有错误提示");
  assert.match(textOf(last), /this turn ended on an error: http_400/);
  assert.match(textOf(last), /Tools that ran in this run: Step/);
});

test("有副作用的工具开跑前立即落盘；进程死在执行中途，恢复时说「结果未知、先查状态」并附改动", async () => {
  process.env.SESSIONS_DIR = temp("dimensio-r6-state-");
  setConfig({ provider: "openai", apiKey: "DUMMY-r6-key" });
  const root = temp("dimensio-r6-ws-");
  const marker = path.join(root, "deployed.txt");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const deploy: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Deploy", description: "test deploy", parameters: { type: "object", properties: {} } },
    async run() {
      fs.writeFileSync(marker, "side effect happened\n"); // 副作用先发生……
      await hold; // ……然后还要再跑一会儿
      return { ok: true, summary: "deployed", content: [{ t: "text", text: "deployed" }] };
    },
  };
  const adapter = adapterOf(async function* (_turn, i) {
    if (i === 0) {
      yield { e: "tool_call", id: "d1", name: "Deploy", args: {} };
      yield { e: "turn_done", stopReason: "tool_use" };
      return;
    }
    yield { e: "text_delta", text: "done" };
    yield { e: "turn_done", stopReason: "end" };
  });
  const session = createSession();
  session.state = stateWith(adapter, root, [deploy]);
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const run = startRun(session, "发版");
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(marker)) {
    if (Date.now() > deadline) assert.fail("the tool never ran");
    await new Promise((r) => setTimeout(r, 20));
  }

  // 此刻就读盘（不等 2 秒防抖）：转录里必须已经有这个发出去的调用。
  const inflight = await loadSession(session.id);
  assert.ok(inflight);
  const tail = inflight.messages.at(-1)!;
  assert.equal(tail.role, "assistant");
  assert.ok(tail.content.some((b) => b.t === "tool_call" && b.id === "d1"), "调用在执行前就落盘了");

  stopSession(session.id);
  release();
  await run.done;

  // 模拟「进程死在那一刻」：盘上留下的就是执行中的记录，然后从盘上恢复。
  await saveSession(inflight);
  dropSession(session.id);
  const back = await getOrLoadSession(session.id);
  assert.ok(back?.state);
  const healed = back.state.messages.at(-1)!;
  const text = textOf(healed);
  assert.equal(healed.role, "user");
  assert.doesNotMatch(text, /Not executed/, "不许说没执行");
  assert.match(text, /result unknown/);
  assert.match(text, /Check the current state/);
  assert.match(text, /deployed\.txt/, "附上这一轮开始以来工作区的改动");
  dropSession(session.id);
});
