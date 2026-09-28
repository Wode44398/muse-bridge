// U2 第二步（X36、hermes N18 / N17a）：待送达托盘——插话没被读到之前不进时间线，可以撤回，也可以立即中断这一轮按这句重开。
//
// 修前：插话一落地就进时间线——模型还在跑一个十分钟的工作流时，气泡早早排在上面，看着像已经被读到了；想收回或者
// 等不及了，只能按停止（连后台的 dev server 和命令一起收掉）再重打一遍。
// 修后：steer_queued 进托盘（写明送达时机），steer_applied 才挪进时间线；POST …/steer/withdraw 撤回（没送达才撤得回），
// POST …/steer/interrupt 撤回 + 只停这一轮 + 以这句开新一轮。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Block, Msg } from "./agent/turn.ts";
import { interruptWithSteer, startRun, steerSession, withdrawSteer } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { readTool } from "./tools/read.ts";
import { reduceTimeline, steerDeliveryHint, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";

const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? textOf(b.content) : "")).join("");
const inputText = (msgs: Msg[]) => msgs.map((m) => textOf(m.content)).join("\n");
function workspace(t: import("node:test").TestContext): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u2m-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, "a.txt"), "a\n");
  return ws;
}

test("U2 撤回：还没送达的插话从队列里拿掉、广播 steer_withdrawn，模型读不到；已经送达 / 不认识的撤不回来", async (t) => {
  const ws = workspace(t);
  const adapter = scripted(t);
  const session = attachSession(adapter, ws, { tools: [readTool] });
  const results: unknown[] = [];
  adapter.next(
    function* () {
      steerSession(session, "改成用 pnpm", undefined, "steer-u2-aaaa1");
      results.push(withdrawSteer(session, "steer-u2-aaaa1"));
      results.push(withdrawSteer(session, "steer-u2-nope0"));
      yield* calls(call("r1", "Read", { path: "a.txt" }));
    },
    say("好了"),
  );
  await startRun(session, "读一下 a.txt").done;
  assert.deepEqual(results, [{ ok: true, text: "改成用 pnpm" }, { ok: false, reason: "delivered" }]);
  assert.ok(session.runLog.some((ev) => ev.e === "steer_withdrawn" && ev.id === "steer-u2-aaaa1"));
  assert.ok(!inputText(adapter.inputs[1].messages).includes("改成用 pnpm"), "撤回的插话没送进模型");
  assert.deepEqual(withdrawSteer(session, "steer-u2-aaaa1"), { ok: false, reason: "not_running" });
});

test("U2 立即中断并发送：撤回这条、停下这一轮、以这句开新一轮；新一轮的第一条就是这句原话", async (t) => {
  const ws = workspace(t);
  const adapter = scripted(t);
  const session = attachSession(adapter, ws, { tools: [readTool] });
  let interrupting: Promise<{ ok: boolean; reason?: string }> | null = null;
  adapter.next(
    async function* (_turn: unknown, _n: number) {
      steerSession(session, "别读了，直接回答", undefined, "steer-u2-bbbb2");
      interrupting = interruptWithSteer(session, "steer-u2-bbbb2");
      await new Promise((r) => setTimeout(r, 50));
      yield* calls(call("r1", "Read", { path: "a.txt" }));
    },
    say("好，直接回答：没问题"),
  );
  const first = startRun(session, "读一下 a.txt 再说");
  await first.done;
  assert.ok(interrupting, "中断发起了");
  const r = await interrupting!;
  assert.deepEqual(r, { ok: true });
  await session.runPromise;
  const msgs = session.state!.messages;
  const last = msgs.filter((m) => m.role === "user" && !m.origin).at(-1)!;
  assert.equal(textOf(last.content), "别读了，直接回答", "新一轮的用户消息就是这句原话（不是插话）");
  assert.ok(!msgs.some((m) => m.origin === "steer"), "这句没有再当插话注入一遍");
  assert.match(textOf(msgs.at(-1)!.content), /直接回答：没问题/);
});

function model(): TimelineModel {
  return {
    id: "s1", runId: "r1", title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0, pendingSteers: [],
  };
}
function fx(log: string[]): TimelineEffects {
  return {
    foreground: true, scheduleFlush: () => {}, cancelFlush: () => {}, toast: (m) => log.push(`toast ${m}`),
    rememberSession: () => {}, openBrowserPane: () => {}, setGlobal: () => {}, refill: (t) => log.push(`refill ${t}`), setBrowser: () => {},
  };
}

test("U2 托盘归约：落地进托盘不进时间线、送达才挪进时间线、撤回 / 退回都从托盘拿掉；送达时机按在跑的工具写", () => {
  const log: string[] = [];
  const m = model();
  const f = fx(log);
  reduceTimeline(m, { e: "tool_start", id: "w1", name: "Workflow", args: { script: "x" } }, f);
  reduceTimeline(m, { e: "steer_queued", text: "顺便看看测试", id: "sa" }, f);
  reduceTimeline(m, { e: "steer_queued", text: "顺便看看测试", id: "sa" }, f); // 本机乐观放过一次 / 重放：按 id 去重
  reduceTimeline(m, { e: "steer_queued", text: "算了别动数据库", id: "sb" }, f);
  assert.deepEqual(m.pendingSteers!.map((p) => p.id), ["sa", "sb"]);
  assert.ok(!m.timeline.some((it) => it.kind === "user"), "还没送达的不进时间线");
  assert.equal(steerDeliveryHint(m.timeline), "等「编排工作流」跑完后送达");

  reduceTimeline(m, { e: "steer_withdrawn", id: "sb" }, f);
  assert.deepEqual(m.pendingSteers!.map((p) => p.id), ["sa"]);
  reduceTimeline(m, { e: "tool_end", id: "w1", name: "Workflow", ok: true, summary: "done", content: [] }, f);
  assert.equal(steerDeliveryHint(m.timeline), "下一步送达");
  reduceTimeline(m, { e: "steer_applied", text: "顺便看看测试", id: "sa" }, f);
  assert.deepEqual(m.pendingSteers, []);
  const bubble = m.timeline.at(-1) as { kind: string; text?: string; steer?: boolean; steerId?: string };
  assert.deepEqual([bubble.kind, bubble.text, bubble.steer, bubble.steerId], ["user", "顺便看看测试", true, "sa"], "送达时挪进时间线，落在被读到的位置");

  reduceTimeline(m, { e: "steer_queued", text: "最后一句", id: "sc" }, f);
  reduceTimeline(m, { e: "steer_returned", texts: ["最后一句"], ids: ["sc"] }, f);
  assert.deepEqual(m.pendingSteers, []);
  assert.ok(log.includes("refill 最后一句"), "没送出的放回输入框");
});
