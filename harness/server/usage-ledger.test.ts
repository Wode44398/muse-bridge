// O8（N39）：用量账本——会话 × 厂商 × 型号 × 任务。
//
// 修前：会话只记主循环那一份；子 agent、工作流里的 agent、压缩摘要的用量都不并入——一个开了几十个 agent 的工作流实际烧了
// 多少，界面上看不到。
// 修后：每次模型请求的用量连同厂商 / 型号 / 任务记一笔，按这三样聚合，随会话落盘、读回；主对话的 totals 含义不变。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { runAgent } from "./agent/loop.ts";
import { summarize } from "./agent/context.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import type { StreamEvent } from "./agent/events.ts";
import { setConfig } from "./config.ts";
import { Sandbox } from "./sandbox.ts";
import { getOrLoadSession, sessionRecord, sessionUsage } from "./session.ts";
import { saveSession, type PersistedSession } from "./store.ts";
import { fakeSummary, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { addUsage, ledgerRows, sanitizeLedger, type UsageDelta, type UsageLedger } from "./usage-ledger.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const withUsage = (text: string, input: number, output: number): StreamEvent[] => [
  { e: "text_delta", text },
  { e: "usage", inputTokens: input, outputTokens: output, cacheReadTokens: 7 },
  { e: "turn_done", stopReason: "end" },
];

test("O8 账本：按厂商|型号|任务累加（次数也记），按任务排序；读回只认形状对的行", () => {
  const l: UsageLedger = {};
  addUsage(l, { provider: "kimi", model: "k2", task: "subagent", input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  addUsage(l, { provider: "kimi", model: "k2", task: "main", input: 50, output: 5, cacheRead: 20, cacheWrite: 0 });
  addUsage(l, { provider: "kimi", model: "k2", task: "main", input: 60, output: 6, cacheRead: 0, cacheWrite: 3 });
  const rows = ledgerRows(l);
  assert.deepEqual(rows.map((r) => `${r.task}:${r.input}/${r.output}/${r.calls}`), ["main:110/11/2", "subagent:100/10/1"]);
  const back = sanitizeLedger({ ...l, bad: { provider: 1 }, odd: { provider: "x", model: "y", task: "nope" } });
  assert.deepEqual(Object.keys(back).sort(), Object.keys(l).sort(), "坏行丢掉");
});

test("O8 主循环的用量经钩子报出（厂商、型号、任务 main）；压缩摘要只进账本、不进主对话的 totals", async (t) => {
  const seen: UsageDelta[] = [];
  const adapter = scripted(t).next(withUsage("好了", 120, 30));
  const { state } = loopState(t, adapter, { user: "hi" });
  state.usageSink = (d) => seen.push(d);
  for await (const _ of runAgent(state, new AbortController().signal)) { /* 跑完 */ }
  assert.deepEqual(seen.map((d) => `${d.task}:${d.input}/${d.output}/${d.cacheRead}`), ["main:120/30/7"]);
  assert.equal(seen[0].provider, adapter.id);
  assert.equal(state.totalInputTokens, 120);

  const side: Array<{ inputTokens?: number }> = [];
  const summarizer = scripted(t, { model: "m" }).next(withUsage(fakeSummary("摘要：做了三件事"), 800, 90));
  const notes = await summarize(summarizer, [{ role: "user", content: [{ t: "text", text: "x" }] }], undefined, (u) => side.push(u));
  assert.match(notes, /摘要/);
  assert.equal(side[0]?.inputTokens, 800, "摘要请求的用量报出来了");
  state.recordSideUsage("compaction", { inputTokens: 800, outputTokens: 90 });
  assert.equal(seen.at(-1)?.task, "compaction");
  assert.equal(state.totalInputTokens, 120, "压缩不进主对话的 totals");
});

test("O8 子 agent 的用量记进父会话的账本：单独派的标 subagent，工作流里起的标 workflow", async (t) => {
  const seen: UsageDelta[] = [];
  const env = {
    provider: "openai" as const, apiKey: "test-key-DUMMY", model: "fake", thinking: "off" as const,
    sandbox: new Sandbox(tmp("dimensio-o8-sub-")), limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    usageSink: (d: UsageDelta) => seen.push(d),
  };
  // 两个子 agent 各调一次模型（同一个脚本化 provider，按调用顺序各吐一步）
  const child = scripted(t, { model: "child-model" }).next(withUsage("找到了", 40, 8), withUsage("找到了", 40, 8));
  const run = makeSubAgentRunner(env, () => child);
  assert.equal((await run({ prompt: "找一下入口" })).ok, true);
  assert.equal((await run({ prompt: "工作流里的一个", workflowId: "wf-1" })).ok, true);
  assert.deepEqual(seen.map((d) => `${d.task}:${d.model}:${d.input}`), ["subagent:child-model:40", "workflow:child-model:40"]);
});

test("O8 随会话落盘、读回；读回之后主状态的钩子还接着这份账本", async () => {
  const ws = tmp("dimensio-o8-ws-");
  const id = `o8-${Date.now().toString(36)}`;
  const usage: UsageLedger = {};
  addUsage(usage, { provider: "openai", model: "m", task: "workflow", input: 900, output: 100, cacheRead: 0, cacheWrite: 0 });
  const rec: PersistedSession = {
    v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" },
    system: "s", messages: [], todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
    usage,
  };
  await saveSession(rec);
  setConfig({ provider: "openai", apiKey: "DUMMY-o8-key" }); // 读回要按记录里的 provider 建 adapter
  const session = await getOrLoadSession(id);
  assert.ok(session?.state);
  assert.deepEqual(sessionUsage(id).map((r) => `${r.task}:${r.input}`), ["workflow:900"]);
  session.state.recordUsage(50, 5);
  assert.deepEqual(sessionUsage(id).map((r) => `${r.task}:${r.input}`), ["main:50", "workflow:900"]);
  assert.equal(Object.keys(sessionRecord(session)!.usage ?? {}).length, 2, "落盘的记录里带着");
});
