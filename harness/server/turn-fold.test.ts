// U8b（ZCode E3）：轮次折叠 + 真实耗时（扣掉等人的时间）。
//
// 修前：长会话里每一轮的过程——几十次工具、思考、中间的叙述——全都平铺着，往上翻找上一轮的结论要翻过一整屏过程；也看不到
// 一轮到底干了多久（等你批卡片的时间和真在干活的时间混在一起）。
// 修后：做完的轮（最近这一轮除外）只要跑过工具，过程收成一行「处理过程 · N 次工具 · 用时 X（等你的 Y 不算）」，点开照原样
// 展开；卡片回执、报错、提示与这一轮最后一段回答照常显示。用时由服务端在卡片挂上 / 落定处计量，盖在这一轮最后一条可见回答
// 上（翻历史也有）、随 done 发出。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { resolvePermission, startRun, watchSession } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";
import { feedUnits, foldTiming, type FeedUnit } from "../web/src/lib/feed-units.ts";
import { reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";
import type { Item } from "../web/src/lib/timeline-types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

const user = (text: string, steer = false): Item => ({ kind: "user", text, ...(steer ? { steer: true } : {}) });
const tool = (id: string, name = "Bash"): Item => ({ kind: "tool", id, name, args: {}, status: "ok", summary: "", output: "", open: false });
const think = (): Item => ({ kind: "thinking", text: "想", open: false, live: false });
const text = (t: string, run?: { durationMs: number; waitedMs: number }): Item => ({ kind: "text", text: t, live: false, ...(run ? { run } : {}) });
const shape = (units: FeedUnit[]) =>
  units.map((u) => (u.f ? `折${u.tools}${u.open ? "开" : ""}` : u.g ? `组${u.items.length}` : u.a ? `卡${u.items.length}` : u.item.kind === "text" ? `文:${u.item.text}` : u.item.kind === "tool" ? `工:${u.item.id}` : u.item.kind));

const TIMELINE: Item[] = [
  user("第一轮"),
  think(), tool("a1"), text("先看看结构"), tool("a2"),
  { kind: "permission", id: "p1", tool: "Bash", subject: "git push --force", decided: "once" },
  tool("a3"), { kind: "error", text: "一次小错" }, text("第一轮的结论", { durationMs: 95_000, waitedMs: 40_000 }),
  user("随便问问"), text("直接回答，没跑工具"),
  user("第三轮"), user("中途插话", true), tool("c1", "Read"), tool("c2", "Grep"), think(), text("第三轮做完了"),
  user("最近这一轮"), tool("d1"), text("最近的结论"),
];

test("U8 轮次折叠：做完的轮过程收成一行，卡片回执 / 报错 / 最后一段回答照常；最近这一轮不折；没跑工具的轮不折", () => {
  assert.deepEqual(shape(feedUnits(TIMELINE, false)), [
    "user", "折3", "permission", "error", "文:第一轮的结论",
    "user", "文:直接回答，没跑工具",
    "user", "user", "折2", "文:第三轮做完了", // 运行中插话不算分界，留在原处
    "user", "工:d1", "文:最近的结论", // 最近这一轮原样
  ]);
  const folds = feedUnits(TIMELINE, false).filter((u) => u.f);
  assert.equal(folds[0].f && folds[0].run?.waitedMs, 40_000, "用时取这一轮最后一段回答上的");
  assert.equal(folds[0].f && folds[0].items.length, 5, "思考、三次工具、中间的一段叙述都收进去");
});

test("U8 点开照原样展开：折叠行在第一个过程条目的位置，后面是原来的条目（只读探索照常收组）", () => {
  const key = feedUnits(TIMELINE, false).filter((u) => u.f)[1].key;
  const units = feedUnits(TIMELINE, false, { [key]: true });
  assert.deepEqual(shape(units).slice(5, 11), ["user", "文:直接回答，没跑工具", "user", "user", "折2开", "组3"]);
  assert.equal(shape(units)[11], "文:第三轮做完了");
});

test("U8 折叠行的用时扣掉等人的时间", () => {
  assert.equal(foldTiming({ durationMs: 95_000, waitedMs: 40_000 }), "用时 55 秒（等你的 40 秒不算）");
  assert.equal(foldTiming({ durationMs: 133_000, waitedMs: 0 }), "用时 2 分 13 秒");
  assert.equal(foldTiming({ durationMs: 3_700_000, waitedMs: 500 }), "用时 1 小时 1 分");
  assert.equal(foldTiming(undefined), "");
});

function probeBash(): Tool {
  return {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Bash", description: "probe", parameters: { type: "object", properties: { command: { type: "string" } } } },
    async run() {
      return ok("ran", "ok");
    },
  };
}
const fx: TimelineEffects = {
  foreground: true, scheduleFlush: () => {}, cancelFlush: () => {}, toast: () => {}, rememberSession: () => {},
  openBrowserPane: () => {}, setGlobal: () => {}, refill: () => {}, setBrowser: () => {},
};

test("U8 用时：服务端盖在这一轮最后一条可见回答上、随 done 发出；挂着卡片等人的时间单独记", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u8b-"));
  roots.push(root);
  const adapter = scripted(t).next(calls(call("b1", "Bash", { command: "deploy prod" })), say("部署完了"));
  const session = attachSession(adapter, root, { tools: [probeBash()] });
  session.state!.permissionRules = { allow: [], deny: [], ask: ["Bash(deploy:*)"] };
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "部署");
  assert.ok(run.started);
  watchSession(session, (ev) => {
    events.push(ev);
    if (ev.e === "permission_ask") setTimeout(() => resolvePermission(session, String(ev.id), "once"), 250); // 人想了一会儿才批
  });
  await run.done;
  const done = events.find((e) => e.e === "done")!;
  assert.equal(typeof done.durationMs, "number");
  assert.ok(Number(done.waitedMs) >= 200, `等卡片的时间单独记：${done.waitedMs}`);
  assert.ok(Number(done.durationMs) >= Number(done.waitedMs));
  const last = [...session.state!.messages].reverse().find((m) => m.role === "assistant" && !m.internal)!;
  assert.deepEqual(last.run, { durationMs: done.durationMs, waitedMs: done.waitedMs }, "盖在这一轮最后一条可见回答上（随会话落盘，翻历史也有）");

  const m: TimelineModel = {
    id: "s1", runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
  for (const ev of events) reduceTimeline(m, ev, fx);
  const answer = [...m.timeline].reverse().find((it) => it.kind === "text");
  assert.deepEqual(answer?.kind === "text" ? answer.run : undefined, { durationMs: done.durationMs, waitedMs: done.waitedMs });
});
