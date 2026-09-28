// U3（X38、#52）：活动行说真话 + 运行计时（卡片等待期间暂停计时）。
//
// 修前：活动行只在几个时刻被写入——tool_end、turn_start 都不更新它；适配器早就知道模型在写哪个工具调用，却要等参数
// 全部攒齐才发 tool_start；压缩（摘要请求可能要几十秒）完成之后才有一条提示。模型花两三分钟写一个大文件的 Write 参数时，
// 手机上显示的是上一步的「读取文件」；活动行也没有计时，分不清「在干活」和「卡住了」。
// 修后：适配器一知道工具名就发 tool_call_begin（之后按时间节流报参数字数，只发给在看的设备、不进 runLog）；loop 压缩前
// 发 compact_start；前端 turn_start →「等待模型回复」、tool_end 之后不再停在上一个动词上；服务端记运行计时（卡片挂着时
// 暂停），run_clock 下发给所有设备，附着时补一份此刻的。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { AgentEvent, StreamEvent } from "./agent/events.ts";
import { runAgent } from "./agent/loop.ts";
import { createAnthropicAdapter } from "./providers/anthropic.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";
import { dropSession, resolvePlan, startRun, watchSession } from "./session.ts";
import { call, calls, fakeSummary, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { fakeProviderFetch } from "./test-harness/wire-fakes.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { ok, type Tool } from "./tools/types.ts";
import {
  ACTIVITY_COMPACTING, ACTIVITY_WAITING_MODEL, elapsedLabel, reduceTimeline, runElapsedMs, toolDraftActivity,
  type TimelineEffects, type TimelineModel,
} from "../web/src/lib/timeline-reducer.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

function newModel(): TimelineModel {
  return {
    id: null, runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0, clock: null,
  };
}
const fx: TimelineEffects = {
  foreground: true, scheduleFlush: () => {}, cancelFlush: () => {}, toast: () => {}, rememberSession: () => {},
  openBrowserPane: () => {}, setGlobal: () => {}, refill: () => {}, setBrowser: () => {},
};

test("U3 活动行说真话：新请求发出去 → 等待模型；正在写工具参数 → 哪个工具 · 写了多少字；工具都跑完 → 不再停在上一个动词上；整理上下文有说法、整理完就收", () => {
  const m = newModel();
  const feed = (ev: Record<string, unknown>) => reduceTimeline(m, ev, fx);
  feed({ e: "tool_start", id: "t1", name: "Read", args: { path: "a.ts" } });
  feed({ e: "tool_end", id: "t1", name: "Read", ok: true, summary: "read", content: [] });
  assert.notEqual(m.activity, "读取文件", "工具跑完了不能还说「读取文件」");
  feed({ e: "turn_start", index: 1 });
  assert.equal(m.activity, ACTIVITY_WAITING_MODEL);
  feed({ e: "tool_call_begin", id: "c2", name: "Write", chars: 0 });
  assert.equal(m.activity, toolDraftActivity("Write", 0));
  feed({ e: "tool_call_begin", id: "c2", name: "Write", chars: 12_345 });
  assert.match(m.activity, /生成参数（12k 字）/);
  // 两个工具并行：一个跑完、另一个还在跑，就说还在跑的那一个
  feed({ e: "tool_start", id: "b1", name: "Bash", args: { command: "npm test" } });
  feed({ e: "tool_start", id: "g1", name: "Grep", args: { pattern: "x" } });
  feed({ e: "tool_end", id: "g1", name: "Grep", ok: true, summary: "", content: [] });
  assert.equal(m.activity, "执行命令");
  feed({ e: "tool_end", id: "b1", name: "Bash", ok: true, summary: "", content: [] });
  assert.equal(m.activity, "思考中");
  feed({ e: "compact_start" });
  assert.equal(m.activity, ACTIVITY_COMPACTING);
  feed({ e: "context", usedTokens: 10, limitTokens: 100, compacted: true });
  assert.equal(m.activity, "思考中", "整理完就收");
});

test("U3 运行计时：按服务端的钟走（换算时钟差），卡片挂着时停在那一刻；格式 12s / 3:05 / 1:02:03", () => {
  const m = newModel();
  const localNow = Date.now();
  // 服务端的钟比本机快 5 秒；本轮 20 秒前开跑，其中 4 秒在等卡片
  reduceTimeline(m, { e: "run_clock", startedAt: localNow + 5_000 - 20_000, pausedMs: 4_000, pausedSince: null, serverNow: localNow + 5_000 }, fx);
  assert.ok(m.clock);
  const running = runElapsedMs(m.clock!, localNow);
  assert.ok(Math.abs(running - 16_000) < 50, `跑了 ${running}ms`);
  reduceTimeline(m, { e: "run_clock", startedAt: localNow + 5_000 - 20_000, pausedMs: 4_000, pausedSince: localNow + 5_000, serverNow: localNow + 5_000 }, fx);
  assert.equal(runElapsedMs(m.clock!, localNow + 60_000), runElapsedMs(m.clock!, localNow), "卡片挂着：计时停住");
  assert.equal(elapsedLabel(12_400), "12s");
  assert.equal(elapsedLabel(185_000), "3:05");
  assert.equal(elapsedLabel(3_723_000), "1:02:03");
});

test("U3 适配器一知道工具名就报 tool_call_begin，之后按时间节流报参数字数（Anthropic / OpenAI 兼容）", async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, "now", () => (clock += 2_000)); // 每读一次钟前进 2 秒：节流窗口必然已过
  const args = { path: "big.ts", content: "x".repeat(3_000) };
  for (const shape of ["anthropic", "openai"] as const) {
    const baseUrl = `https://${shape}.invalid${shape === "openai" ? "/v1" : ""}`;
    fakeProviderFetch(t, { baseUrl, shape, steps: [calls(call("w1", "Write", args))] });
    const adapter = shape === "anthropic"
      ? createAnthropicAdapter({ provider: "anthropic", model: "claude-test", apiKey: "FAKE-KEY", baseUrl })
      : createOpenAIAdapter({ provider: "openai", model: "fake-model", apiKey: "FAKE-KEY", baseUrl });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.stream({ system: "s", messages: [{ role: "user", content: [{ t: "text", text: "go" }] }], tools: [], budget: { maxOutputTokens: 100 } })) events.push(ev);
    const begins = events.filter((e) => e.e === "tool_call_begin") as Extract<StreamEvent, { e: "tool_call_begin" }>[];
    const at = events.findIndex((e) => e.e === "tool_call");
    assert.ok(begins.length >= 1, `${shape}：没报 tool_call_begin`);
    assert.ok(events.indexOf(begins[0]) < at, `${shape}：要在工具调用攒齐之前报`);
    assert.deepEqual([begins[0].id, begins[0].name], ["w1", "Write"]);
    assert.ok(begins.at(-1)!.chars >= JSON.stringify(args).length, `${shape}：节流后报的字数跟上了`);
  }
});

const echo: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};

test("U3 loop：上下文到线了先报 compact_start，再整理（整段压缩的摘要请求可能要几十秒）", async (t) => {
  const big = "x".repeat(20_000);
  const round = (i: number): StreamEvent[] => calls({ e: "text_delta", text: `${i}${big}` }, call(`c${i}`, "Echo"));
  const adapter = scripted(t, { capabilities: { contextWindow: 30_000 } }).next(
    round(1), round(2), round(3), round(4), say(fakeSummary("SUMMARY: echoed four times")), say("done"),
  );
  const { state } = loopState(t, adapter, { tools: [echo], user: "do a long job" });
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(state, new AbortController().signal)) events.push(ev);
  const start = events.findIndex((e) => e.e === "compact_start");
  const compacted = events.findIndex((e) => e.e === "context" && (e as { compacted?: boolean }).compacted);
  assert.ok(start >= 0 && compacted > start, `compact_start 在第 ${start} 个事件，压缩完成在第 ${compacted} 个`);
});

test("U3 会话层：开跑即开表；卡片挂着暂停、落定接着走；附着时补此刻的计时；tool_call_begin 只发给在看的设备、不进 runLog", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u3-"));
  roots.push(root);
  const adapter = scripted(t).next(
    calls({ e: "tool_call_begin", id: "p1", name: "ExitPlanMode", chars: 0 }, call("p1", "ExitPlanMode", { plan: "改 a.ts" })),
    say("好，按计划做完了。"),
  ).always(useTool("audit", "MemoryAudit", { decision: "none", reason: "Synthetic test turn produces no durable project knowledge." }));
  const session = attachSession(adapter, root, { mode: "plan", tools: [exitPlanModeTool, memoryAuditTool] });
  const seen: Record<string, unknown>[] = [];
  const off = watchSession(session, (ev) => {
    seen.push(ev);
    if (ev.e === "plan_ask") setTimeout(() => resolvePlan(session, String(ev.id), true), 120); // 在卡片上停 120ms 再批
  });
  const run = startRun(session, "改一下 a.ts");
  assert.ok(run.started);
  // 中途附着的设备：重放末尾补一份此刻的计时
  await new Promise((r) => setTimeout(r, 30));
  const mirror: Record<string, unknown>[] = [];
  const offMirror = watchSession(session, (ev) => mirror.push(ev));
  await run.done;
  off();
  offMirror();

  const clocks = seen.filter((e) => e.e === "run_clock") as Array<{ startedAt: number; pausedMs: number; pausedSince: number | null }>;
  assert.ok(clocks.length >= 3, `开表、暂停、继续各一份（收到 ${clocks.length} 份）`);
  assert.equal(clocks[0].pausedSince, null);
  assert.ok(clocks.some((c) => c.pausedSince !== null), "卡片挂着时暂停");
  const resumed = clocks.at(-1)!;
  assert.equal(resumed.pausedSince, null);
  assert.ok(resumed.pausedMs >= 100, `暂停的时长记上了（${resumed.pausedMs}ms）`);
  assert.ok(new Set(clocks.map((c) => c.startedAt)).size === 1, "开跑时刻不变");
  assert.ok(seen.some((e) => e.e === "tool_call_begin"), "在看的设备收到了「正在写工具参数」");
  assert.equal(session.runLog.some((e) => e.e === "tool_call_begin"), false, "不进 runLog");
  const lastReplayed = mirror.find((e) => e.e === "run_clock" && Math.abs(Number(e.serverNow) - Date.now()) < 5_000);
  assert.ok(lastReplayed, "附着的设备拿到了此刻的计时快照");
  dropSession(session.id);
});
