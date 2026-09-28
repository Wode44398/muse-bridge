// Q11（X45）：前端时间线归约器（web/src/lib/timeline-reducer.ts，纯函数）接在真 loop 的事件流后面：脚本化 provider
// 驱动 runAgent，事件逐条喂给归约器，对「时间线的文本形态」做快照（每条一行：kind(flags): 摘要）。以后改归约器
// （U2 / U3 / U7……），行为一变，快照 diff 就出现在提交里。
// 快照纪律同 loop-gates：只给「顺序本身就是契约」的时间线用；diff 必须有人看过，不许为了变绿去更新。
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "./agent/events.ts";
import { runAgent } from "./agent/loop.ts";
import type { AgentState } from "./agent/state.ts";
import { call, calls, fakeSummary, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { fail, ok, type Tool } from "./tools/types.ts";
import { pushItem, reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";
import type { Item } from "../web/src/lib/timeline-types.ts";

const RAW = { serializers: [(v: unknown) => String(v)] };
const schema = { type: "object" as const, properties: {} };

const edit: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Edit", description: "fake edit", parameters: schema },
  async run() {
    return ok("edited", "edited");
  },
};
const bash: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Bash", description: "fake bash", parameters: schema },
  async run(args) {
    const passed = args.pass === true;
    return { ...(passed ? ok("test passed", "exit 0") : fail("test failed", "exit 1")), verification: { passed, detail: "npm test" } };
  },
};
const echo: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: schema },
  async run() {
    return ok("echoed", "echo result");
  },
};

function newModel(): TimelineModel {
  return {
    id: null, runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
}

// 前台会话；吐字缓冲不设定时器——下一个非增量事件或收尾时自然落地（浏览器上是 90ms 一批，终态一样）。
function effects(log: string[] = []): TimelineEffects {
  return {
    foreground: true,
    scheduleFlush: () => {},
    cancelFlush: () => {},
    toast: (msg) => log.push(`toast ${msg}`),
    rememberSession: (id) => log.push(`remember ${id}`),
    openBrowserPane: () => log.push("open browser pane"),
    setGlobal: (patch) => log.push(`global ${JSON.stringify(patch)}`),
    refill: (text) => log.push(`refill ${text}`),
    setBrowser: (url) => log.push(`browser ${url}`),
  };
}

const oneLine = (s: string, max = 60) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

function renderItem(item: Item): string {
  switch (item.kind) {
    case "user":
      return `user${item.steer ? "(steer)" : ""}: "${oneLine(item.text)}"`;
    case "text":
      return `text${item.live ? "(live)" : ""}: "${oneLine(item.text)}"${item.artifacts?.length ? ` [${item.artifacts.length} artifacts]` : ""}`;
    case "thinking":
      return `thinking${item.live ? "(live)" : ""}: "${oneLine(item.text)}"`;
    case "tool":
      return `tool(${item.status}): ${item.name}#${item.id} "${oneLine(item.summary)}"`;
    case "ask":
      return `ask(${item.answered ? "answered" : "open"}): ${item.id}`;
    case "permission":
      return `permission(${item.decided ?? (item.cancelled ? "cancelled" : "open")}): ${item.tool} ${oneLine(item.subject)}`;
    case "plan":
      return `plan(${item.decided ?? (item.cancelled ? "cancelled" : "open")}): "${oneLine(item.plan)}"`;
    case "error":
      return `error: "${oneLine(item.text)}"`;
    case "notice":
      return `notice: "${oneLine(item.text)}"`;
    case "screenshot":
      return `screenshot: ${item.url}`;
  }
}

const render = (m: TimelineModel) => [...m.timeline.map(renderItem), `— activity: "${m.activity}"`].join("\n");

// 客户端发出一条消息：先乐观上屏用户气泡，再跑 loop，事件逐条归约。onEvent 在每个事件归约之后调用。
async function run(
  state: AgentState,
  m: TimelineModel,
  userText: string,
  onEvent?: (ev: AgentEvent) => void,
): Promise<AgentEvent[]> {
  pushItem(m, { kind: "user", text: userText });
  const fx = effects();
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(state, new AbortController().signal)) {
    events.push(ev);
    reduceTimeline(m, ev, fx);
    onEvent?.(ev);
  }
  return events;
}

function assertSettled(m: TimelineModel) {
  assert.deepEqual(m.timeline.filter((it) => (it as { live?: boolean }).live).map(renderItem), [], "收尾后不许还有在流的条目");
  const onTimeline = new Set(m.timeline);
  assert.ok([...m.toolRefs.values()].every((t) => onTimeline.has(t)), "工具索引不许指着已经不在时间线上的条目");
}

test("Q11 时间线：思考、正文、工具轮、最终答复按事件顺序落位，收尾后没有在流的条目", async (t) => {
  const adapter = scripted(t).next(
    calls({ e: "thinking_delta", text: "先想想" }, { e: "text_delta", text: "先看文件" }, call("r1", "Echo")),
    say("看完了，一切正常"),
  );
  const { state } = loopState(t, adapter, { tools: [echo], user: "看一下" });
  const m = newModel();
  await run(state, m, "看一下");
  t.assert.snapshot(render(m), RAW);
  assertSettled(m);
});

test("Q11 时间线：验证门禁撤回那一版答复时，这一轮里插进来的话留着；撤回的只有模型那段", async (t) => {
  const adapter = scripted(t).next(
    useTool("e1", "Edit", { path: "a.ts" }),
    say("改好了"),
    useTool("v1", "Bash", { command: "npm test", verify: true, pass: true }),
    say("验证通过，改成蓝色了"),
  );
  const { state } = loopState(t, adapter, { tools: [edit, bash], user: "把 a.ts 改一下" });
  const m = newModel();
  let sent = false;
  const fx = effects();
  await run(state, m, "把 a.ts 改一下", (ev) => {
    // 模型说「改好了」的那一刻用户插话：本机乐观上屏，服务端排队并广播 steer_queued（按 id 去重，不重复上屏）
    if (!sent && ev.e === "text_delta" && ev.text === "改好了") {
      sent = true;
      pushItem(m, { kind: "user", text: "改成蓝色", steer: true, steerId: "s1" });
      state.queueSteer("改成蓝色", "s1");
      reduceTimeline(m, { e: "steer_queued", text: "改成蓝色", id: "s1" }, fx);
    }
  });
  t.assert.snapshot(render(m), RAW);
  assert.equal(m.timeline.filter((it) => it.kind === "user" && it.steer).length, 1, "插话气泡只有一条，而且还在");
  assert.ok(!m.timeline.some((it) => it.kind === "text" && it.text === "改好了"), "被撤回的那一版不在了");
  assertSettled(m);
});

test("Q11 时间线：同一句话，别的设备插的照样显示；自己的乐观气泡按 id 去重", () => {
  const m = newModel();
  const fx = effects();
  m.pendingSteers = [{ id: "mine", text: "继续" }]; // 本机乐观放进待送达托盘（U2 第二步：送达前不进时间线）
  reduceTimeline(m, { e: "turn_start", index: 0 }, fx);
  reduceTimeline(m, { e: "steer_queued", text: "继续", id: "mine" }, fx); // 自己那条的回执
  reduceTimeline(m, { e: "steer_queued", text: "继续", id: "other-device" }, fx); // 别的设备也说了「继续」
  assert.deepEqual(m.pendingSteers.map((p) => p.id), ["mine", "other-device"]);
  reduceTimeline(m, { e: "steer_applied", text: "继续", id: "mine" }, fx);
  reduceTimeline(m, { e: "steer_applied", text: "继续", id: "other-device" }, fx);
  assert.deepEqual(m.timeline.map(renderItem), ['user(steer): "继续"', 'user(steer): "继续"']);
});

test("Q11 时间线：上游断流重放（同一个 turn 下标再来一次）——半截正文被替换，不重复", async (t) => {
  const adapter = scripted(t).next(async function* () {
    yield { e: "text_delta" as const, text: "说到一半" };
    throw new Error("synthetic connection reset");
  }, say("完整的答复"));
  const { state } = loopState(t, adapter, { user: "讲讲" });
  const m = newModel();
  const events = await run(state, m, "讲讲");
  assert.equal(events.filter((e) => e.e === "turn_start").length, 2, "前提：同一个下标起了两次");
  t.assert.snapshot(render(m), RAW);
  assertSettled(m);
});

test("Q11 时间线：全量压缩时落一行「上下文已压缩」，位置在压缩发生的那一刻", async (t) => {
  const big = "x".repeat(20_000);
  const round = (i: number) => calls({ e: "text_delta", text: `第 ${i} 轮 ${big}` }, call(`c${i}`, "Echo"));
  const adapter = scripted(t, { capabilities: { contextWindow: 30_000 } }).next(
    round(1), round(2), round(3), round(4),
    say(fakeSummary("SUMMARY: echoed four times")), // 压缩摘要（旁路请求，不产生时间线事件）
    say("做完了"),
  );
  const { state } = loopState(t, adapter, { tools: [echo], user: "干个长活" });
  const m = newModel();
  await run(state, m, "干个长活");
  t.assert.snapshot(render(m), RAW);
  assert.equal(m.timeline.filter((it) => it.kind === "notice").length, 1);
  assertSettled(m);
});

test("R14 时间线：前台 Bash 的实时尾行挂在还在跑的那一行上，跑完清掉；不认识的 id 不理", () => {
  const m = newModel();
  const fx = effects();
  reduceTimeline(m, { e: "tool_start", id: "c1", name: "Bash", args: { command: "npm test" } }, fx);
  reduceTimeline(m, { e: "tool_progress", id: "c1", tail: "ok 1\nok 2", elapsedMs: 12_000, canBackground: true }, fx);
  reduceTimeline(m, { e: "tool_progress", id: "nope", tail: "x", elapsedMs: 1, canBackground: true }, fx);
  const row = m.timeline.find((it) => it.kind === "tool") as { progress?: unknown };
  assert.deepEqual(row.progress, { tail: "ok 1\nok 2", elapsedMs: 12_000, canBackground: true });
  reduceTimeline(m, { e: "tool_end", id: "c1", ok: true, summary: "bash (moved to background as job1)", content: [] }, fx);
  assert.equal(row.progress, undefined, "跑完（或转了后台）就不再显示尾行");
  reduceTimeline(m, { e: "tool_progress", id: "c1", tail: "late", elapsedMs: 13_000, canBackground: true }, fx);
  assert.equal(row.progress, undefined, "迟到的尾行不挂回已经结束的行");
});

test("O2 时间线：子 agent 因限流挂起时挂上「挂起到何时」，任务面板显示为卡住；又有动静就清掉", async () => {
  const { agentDotState } = await import("../web/src/lib/tasks.ts");
  const m = newModel();
  const fx = effects();
  reduceTimeline(m, { e: "tool_start", id: "t1", name: "Agent", args: { prompt: "look" } }, fx);
  reduceTimeline(m, { e: "subagent_start", id: "a1", label: "look", tier: "research", model: "fake", provider: "openai", prompt: "look", toolId: "t1" }, fx);
  const run = m.agentRefs.get("a1")!;
  reduceTimeline(m, { e: "subagent_suspended", id: "a1", reason: "rate_limit", waitMs: 60_000, attempt: 1 }, fx);
  assert.ok((run.suspendedUntil ?? 0) > Date.now());
  assert.equal(run.suspendReason, "rate_limit");
  assert.equal(agentDotState(run, { now: Date.now() }), "stalled");
  reduceTimeline(m, { e: "subagent_event", id: "a1", ev: { e: "turn_start", index: 1 } }, fx);
  assert.equal(run.suspendedUntil, undefined);
  assert.equal(agentDotState(run, { now: Date.now() }), "running");
});

test("P5 时间线：权限卡带着「本会话都允许」会记下的规则与前缀选项；落定时记下选的是哪种", () => {
  const m = newModel();
  const fx = effects();
  reduceTimeline(m, {
    e: "permission_ask", id: "p1", tool: "Bash", subject: "npm run lint", rule: "Bash",
    sessionRules: ["Bash(=npm run lint)"], prefixRules: ["Bash(npm run lint:*)"],
  }, fx);
  reduceTimeline(m, { e: "permission_ask", id: "p2", tool: "Bash", subject: "rm -rf x", rule: "Bash", sessionRules: ["Bash(=rm -rf x)"] }, fx);
  const cards = m.timeline.filter((it) => it.kind === "permission") as { id: string; sessionRules?: string[]; prefixRules?: string[]; decided: unknown; scope?: string }[];
  assert.deepEqual(cards.map((c) => [c.sessionRules, c.prefixRules]), [
    [["Bash(=npm run lint)"], ["Bash(npm run lint:*)"]],
    [["Bash(=rm -rf x)"], undefined],
  ]);
  reduceTimeline(m, { e: "permission_resolved", id: "p1", decision: "session", scope: "prefix" }, fx);
  reduceTimeline(m, { e: "permission_resolved", id: "p2", decision: "session" }, fx);
  assert.deepEqual(cards.map((c) => [c.decided, c.scope]), [["session", "prefix"], ["session", undefined]]);
  // P6：拒绝并停止照原样落定
  reduceTimeline(m, { e: "permission_ask", id: "p3", tool: "Edit", subject: "a.ts", rule: "Edit", sessionRules: ["Edit(=a.ts)"] }, fx);
  reduceTimeline(m, { e: "permission_resolved", id: "p3", decision: "deny_stop" }, fx);
  const third = m.timeline.filter((it) => it.kind === "permission")[2] as { decided: unknown };
  assert.equal(third.decided, "deny_stop");
});

test("P7 时间线：卡片带截止时间；超时作废的卡标成「超时」而不是「这一轮已结束」，agent 接着干", () => {
  const m = newModel();
  const fx = effects();
  m.running = true;
  const deadlineAt = Date.now() + 600_000;
  reduceTimeline(m, { e: "ask", id: "a1", questions: [{ id: "a1:0", header: "方案", question: "走哪条？", multiSelect: false, options: [] }], deadlineAt }, fx);
  reduceTimeline(m, { e: "permission_ask", id: "p1", tool: "Edit", subject: "a.ts", rule: "Edit", deadlineAt, sessionRules: ["Edit(=a.ts)"] }, fx);
  reduceTimeline(m, { e: "plan_ask", id: "l1", plan: "1. 改", deadlineAt }, fx);
  const [ask, perm, plan] = m.timeline as { deadlineAt?: number }[];
  assert.deepEqual([ask.deadlineAt, perm.deadlineAt, plan.deadlineAt], [deadlineAt, deadlineAt, deadlineAt]);
  reduceTimeline(m, { e: "ask_cancelled", id: "a1", reason: "timeout" }, fx);
  reduceTimeline(m, { e: "permission_cancelled", id: "p1", reason: "timeout" }, fx);
  reduceTimeline(m, { e: "plan_cancelled", id: "l1" }, fx);
  const cards = m.timeline as { answered?: boolean; expired?: boolean; cancelled?: boolean; cancelReason?: string }[];
  assert.deepEqual([cards[0].answered, cards[0].expired], [true, true]);
  assert.deepEqual([cards[1].cancelled, cards[1].cancelReason], [true, "timeout"]);
  assert.deepEqual([cards[2].cancelled, cards[2].cancelReason], [true, undefined], "停止 / run 结束的作废不带 reason");
  assert.equal(m.activity, "思考中", "超时落定后 agent 接着干");
});
