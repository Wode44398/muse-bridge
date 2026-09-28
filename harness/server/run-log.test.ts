// M9（#26、K25、X32、N34）：runLog 压实 + 慢 watcher 有界。
//
// 修前：runLog 逐条存每个 text_delta 和每个转发的子 agent delta——长轮、大工作流很快撞上 20 万条上限，之后附着的设备
// 只能按记录重建（在途正文丢了），常驻内存与每次附着重放穿隧道的量也跟着涨；写不过去的慢连接让数据无限期攒在进程里。
// 修后：delta 按「重放结果等价」合并（主 agent 只与紧挨着的上一条同类合；子 agent 与它自己的上一条事件合），条数只随
// 结构性事件增长；直播积压超限就断开那台设备（它照常断线对账、重新附着），附着时的重放不算积压。
// 等价性用前端真 reducer（web/src/lib/timeline-reducer.ts）核对：压实后的日志与逐条原事件归约出的时间线逐项相同。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { appendRunLog, type LoggedEvent } from "./run-log.ts";
import { dropSession, startRun, watchSession } from "./session.ts";
import { backlogGuard, LIVE_BACKLOG_LIMIT } from "./sse-backlog.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";
import { flushStream, reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";

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
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
}
const fx: TimelineEffects = {
  foreground: true, scheduleFlush: () => {}, cancelFlush: () => {}, toast: () => {}, rememberSession: () => {},
  openBrowserPane: () => {}, setGlobal: () => {}, refill: () => {}, setBrowser: () => {},
};

// 归约一串事件，得到时间线的可比形态（去掉按接收时刻打的时间戳——重放与直播的接收时刻本来就不同）
const CLOCK_KEYS = new Set(["lastAt", "startedAt", "durationMs", "suspendedUntil"]);
function timelineOf(events: readonly LoggedEvent[]): string {
  const m = newModel();
  for (const ev of events) reduceTimeline(m, ev, fx);
  flushStream(m, fx);
  return JSON.stringify({ timeline: m.timeline, activity: m.activity, todos: m.todos, usage: m.usage }, (k, v) => (CLOCK_KEYS.has(k) ? undefined : v), 1);
}

function compact(events: readonly LoggedEvent[], cap = 200_000): LoggedEvent[] {
  const log: LoggedEvent[] = [];
  for (const ev of events) appendRunLog(log, ev, cap);
  return log;
}

const deltas = (e: "text_delta" | "thinking_delta", text: string, n: number): LoggedEvent[] =>
  Array.from({ length: n }, (_, i) => ({ e, text: `${text}${i} ` }));
const sub = (id: string, ev: LoggedEvent): LoggedEvent => ({ e: "subagent_event", id, ev });
const subText = (id: string, text: string, n: number): LoggedEvent[] =>
  Array.from({ length: n }, (_, i) => sub(id, { e: "text_delta", text: `${text}${i} ` }));

test("M9 压实后的日志与逐条原事件归约出同一条时间线；条数只随结构性事件增长", () => {
  const interleave = (a: LoggedEvent[], b: LoggedEvent[]) => a.flatMap((x, i) => (b[i] ? [x, b[i]] : [x]));
  const events: LoggedEvent[] = [
    { e: "turn_start", index: 0 },
    ...deltas("thinking_delta", "想", 40),
    ...deltas("text_delta", "先看看", 60),
    { e: "steer_queued", text: "顺便看下测试", id: "s1" }, // 中间夹了别的事件：两段正文不许合成一段
    ...deltas("text_delta", "接着说", 30),
    { e: "tool_start", id: "t1", name: "Agent", args: { prompt: "调查" } },
    { e: "subagent_start", id: "a1", label: "调查 A", tier: "explore", model: "m", provider: "p", prompt: "A", toolId: "t1" },
    { e: "tool_start", id: "t2", name: "Workflow", args: {} },
    { e: "workflow_start", id: "w1", name: "wf", description: "", phases: [], toolId: "t2" },
    { e: "subagent_start", id: "a2", label: "调查 B", tier: "explore", model: "m", provider: "p", prompt: "B", workflowId: "w1" },
    // 两个子 agent 并行吐字、互相穿插：各自的正文照样能合
    ...interleave(subText("a1", "甲", 50), subText("a2", "乙", 50)),
    sub("a1", { e: "tool_start", id: "a1t1", name: "Read", args: { path: "x" } }),
    sub("a1", { e: "tool_end", id: "a1t1", name: "Read", ok: true, summary: "read x", content: [] }),
    ...subText("a1", "读完了", 20),
    sub("a2", { e: "turn_start", index: 1 }), // 子 agent 自己换轮会清空正文：隔着它的事件绝不能合
    ...subText("a2", "第二轮", 20),
    { e: "workflow_log", id: "w1", text: "进行中" },
    { e: "subagent_end", id: "a2", ok: true, turns: 2, toolCalls: 0, inputTokens: 1, outputTokens: 2, text: "" },
    { e: "subagent_end", id: "a1", ok: true, turns: 1, toolCalls: 1, inputTokens: 1, outputTokens: 2, text: "" },
    { e: "workflow_end", id: "w1", ok: true, agents: 1, cached: 0, inputTokens: 1, outputTokens: 2 },
    { e: "tool_end", id: "t2", name: "Workflow", ok: true, summary: "wf done", content: [] },
    { e: "tool_end", id: "t1", name: "Agent", ok: true, summary: "agent done", content: [] },
    { e: "turn_start", index: 1 },
    ...deltas("text_delta", "被撤回的", 10),
    { e: "turn_discard", index: 1, reason: "门禁没过" },
    { e: "turn_start", index: 2 },
    ...deltas("text_delta", "最终答复", 80),
    { e: "usage", inputTokens: 1, outputTokens: 2, totalInputTokens: 1, totalOutputTokens: 2 },
  ];
  const originals = JSON.stringify(events);
  const log = compact(events);
  assert.equal(timelineOf(log), timelineOf(events), "压实前后归约出的时间线必须逐项相同");
  assert.equal(JSON.stringify(events), originals, "合并只改日志里的副本，不动发给 watcher 的原事件");
  const deltaCount = events.filter((e) => e.e === "text_delta" || e.e === "thinking_delta" || (e.e === "subagent_event" && (e.ev as LoggedEvent).e === "text_delta")).length;
  assert.ok(deltaCount > 300);
  assert.ok(log.length <= events.length - deltaCount + 12, `日志 ${log.length} 条：delta 应当合并成每段一条（原事件 ${events.length} 条，其中 delta ${deltaCount}）`);
  // 夹在中间的事件把正文切成了两段；子 agent 自己换轮前后是两段
  assert.equal(log.filter((e) => e.e === "text_delta").length, 4);
  assert.equal(log.filter((e) => e.e === "subagent_event" && e.id === "a2" && (e.ev as LoggedEvent).e === "text_delta").length, 2);
});

test("M9 日志满了：新条目记不进（报截断），合并照常；cap 只剩兜底意义", () => {
  const log: LoggedEvent[] = [];
  assert.equal(appendRunLog(log, { e: "tool_start", id: "t", name: "Read", args: {} }, 2), true);
  assert.equal(appendRunLog(log, { e: "text_delta", text: "a" }, 2), true);
  assert.equal(appendRunLog(log, { e: "text_delta", text: "b" }, 2), true, "合并不占条数");
  assert.equal(appendRunLog(log, { e: "tool_end", id: "t", name: "Read", ok: true, summary: "", content: [] }, 2), false);
  assert.deepEqual(log.map((e) => e.text ?? e.e), ["tool_start", "ab"]);
});

const echo: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};

test("M9 真会话：长轮中途附着的设备，重放 + 直播归约出的时间线与发起端逐条收到的一致；日志不随 delta 增长", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m9-"));
  roots.push(root);
  const words = (w: string, n: number): StreamEvent[] => Array.from({ length: n }, (_, i) => ({ e: "text_delta", text: `${w}${i} ` }));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let paused!: () => void;
  const atPause = new Promise<void>((r) => (paused = r));
  const adapter = scripted(t).next(
    calls(...words("先读一下", 300), call("c1", "Echo")),
    async function* () {
      paused();
      await released; // 第二次请求已经发出：此刻另一台设备附着
      yield* calls(...words("读完了，结论是", 300));
    },
  );
  const session = attachSession(adapter, root, { tools: [echo] });
  const origin: LoggedEvent[] = [];
  const offOrigin = watchSession(session, (ev) => origin.push(ev)); // 发起端：开跑前就挂着，收逐条原事件
  const run = startRun(session, "读一下再总结");
  assert.ok(run.started);
  const mirror: LoggedEvent[] = [];
  let offMirror = () => {};
  try {
    await atPause;
    assert.ok(session.runLog.length < 20, `300 个 delta 之后日志只有 ${session.runLog.length} 条`);
    offMirror = watchSession(session, (ev) => mirror.push(ev)); // 另一台设备中途附着：先收重放，再收直播
  } finally {
    release();
  }
  await run.done;
  offOrigin();
  offMirror();
  const liveOnly = (evs: LoggedEvent[]) => evs.filter((e) => e.e !== "mirror_end");
  assert.ok(origin.filter((e) => e.e === "text_delta").length >= 600);
  assert.equal(timelineOf(liveOnly(mirror)), timelineOf(liveOnly(origin)), "中途附着的设备看到的必须和发起端一样");
  dropSession(session.id);
});

test("M9（N34）慢 watcher 有界：附着时的重放不算积压；之后直播攒下的超过上限才断", () => {
  let buffered = 0;
  const res = { get writableLength() { return buffered; } };
  const guard = backlogGuard(res);
  buffered = 50 << 20; // 重放一次写进去 50MB
  assert.equal(guard.over(), false, "重放期间不算积压（否则大轮一附着就被自己断开、重连再断，死循环）");
  guard.arm();
  buffered += LIVE_BACKLOG_LIMIT;
  assert.equal(guard.over(), false);
  buffered += 1;
  assert.equal(guard.over(), true, "直播积压超过上限：断开这台设备");
  const drained = backlogGuard(res, 10);
  buffered = 0;
  drained.arm();
  buffered = 11;
  assert.equal(drained.over(), true);
});
