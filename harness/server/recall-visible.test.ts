// N45：召回对人可见。
//
// 修前：每轮开跑时自动召回的记忆与项目知识只作为一条 internal 消息进了模型的上下文，界面上一点痕迹都没有——
// 模型为什么「知道」某件事、是不是被一条过时的记忆带偏了，人看不出来。
// 修后：本轮用户消息挂上召回清单（标题、类别、为什么命中；不含正文，正文照旧只进给模型的 internal 消息），随会话落盘；
// 在看的设备收到 recall 事件；前端挂到这条气泡下（「召回 N 条」），翻历史也在。续跑轮、寒暄轮、已经召回过的不重复。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Msg } from "./agent/turn.ts";
import { dropSession, persistNow, startRun, watchSession, type Session } from "./session.ts";
import { loadSession } from "./store.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { itemFp } from "../web/src/lib/timeline-merge.ts";
import { recallRefsFrom, reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
// 带一条路由、一个模块的小工作区：问 /health 路由时项目知识一定召回得到
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-n45-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src", "api.ts"), "const port = process.env.PORT;\napp.get('/health', handler);\nvoid port;\n");
  return root;
}
async function runWith(session: Session, text: string): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, text);
  assert.ok(run.started);
  watchSession(session, (ev) => events.push(ev));
  await run.done;
  return events;
}
const ownUserMessages = (msgs: Msg[]) => msgs.filter((m) => m.role === "user" && !m.internal && !m.origin && m.content.some((b) => b.t === "text"));

function newModel(): TimelineModel {
  return {
    id: "s1", runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
}
const effects: TimelineEffects = {
  foreground: true,
  scheduleFlush: () => {},
  cancelFlush: () => {},
  toast: () => {},
  rememberSession: () => {},
  openBrowserPane: () => {},
  setGlobal: () => {},
  refill: () => {},
  setBrowser: () => {},
};

test("N45 本轮用户消息挂上召回清单（标题、类别、理由，不含正文）并落盘；在看的设备收到 recall 事件；前端挂到这条气泡下，历史重建同一份", async (t) => {
  const session = attachSession(scripted(t).next(say("看完了")), workspace());
  const events = await runWith(session, "看一下 src/api.ts 里的 /health 路由");
  await persistNow(session);

  const [mine] = ownUserMessages(session.state!.messages);
  assert.ok(mine.recall?.length, "前提：这一轮真的召回到了东西");
  for (const r of mine.recall!) {
    assert.ok(r.id && r.title && r.kind, "每条都有 id、标题、类别");
    assert.equal("text" in r, false, "不含正文");
  }
  assert.ok(session.state!.messages.some((m) => m.internal && m.kind === "recall"), "给模型的召回正文照旧是 internal 消息");

  const ev = events.find((e) => e.e === "recall");
  assert.deepEqual(ev?.items, mine.recall, "在看的设备收到同一份");

  const rec = await loadSession(session.id);
  assert.deepEqual(ownUserMessages(rec!.messages)[0].recall, mine.recall, "随会话落盘");

  // 前端：发送时先放气泡，recall 事件到了挂上去；历史重建（recall 字段）得到同一份、同一个指纹
  const m = newModel();
  m.timeline.push({ kind: "user", text: "看一下 src/api.ts 里的 /health 路由" });
  reduceTimeline(m, ev, effects);
  const live = m.timeline[0];
  assert.equal(live.kind, "user");
  assert.deepEqual(live.kind === "user" ? live.recall : null, recallRefsFrom(mine.recall));
  const rebuilt = { kind: "user" as const, text: "看一下 src/api.ts 里的 /health 路由", attachments: [], recall: recallRefsFrom(rec!.messages.find((x) => x === ownUserMessages(rec!.messages)[0])!.recall) };
  assert.equal(itemFp(rebuilt), itemFp({ ...live, attachments: [] }), "对账认得出是同一条");
  dropSession(session.id);
});

test("N45 同一会话再问同样的事：已经召回过的不重复算，这一轮没有新召回就不挂；寒暄不召回", async (t) => {
  const session = attachSession(scripted(t).next(say("看完了"), say("还是那个路由"), say("不客气")), workspace());
  await runWith(session, "看一下 src/api.ts 里的 /health 路由");
  const again = await runWith(session, "再看一下 src/api.ts 里的 /health 路由");
  const thanks = await runWith(session, "谢谢");
  const [first, second, third] = ownUserMessages(session.state!.messages);
  assert.ok(first.recall?.length);
  assert.equal(second.recall, undefined, "召回过的文档这一轮不再注入，也就不再挂");
  assert.equal(again.some((e) => e.e === "recall"), false);
  assert.equal(third.recall, undefined, "寒暄不召回");
  assert.equal(thanks.some((e) => e.e === "recall"), false);
  dropSession(session.id);
});

test("N45 前端清单只收形状对的条目、最多 12 条；插话气泡不挂", () => {
  assert.deepEqual(recallRefsFrom(undefined), []);
  assert.deepEqual(
    recallRefsFrom([{ id: "a", title: "A", kind: "memory", why: "标题命中 1 个词" }, { id: "b" }, "x", { title: "no id" }, { id: "c", title: "C" }]),
    [{ id: "a", title: "A", kind: "memory", why: "标题命中 1 个词" }, { id: "c", title: "C", kind: "" }],
  );
  assert.equal(recallRefsFrom(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, title: `T${i}` }))).length, 12);
  const m = newModel();
  m.timeline.push({ kind: "user", text: "原来的问题" }, { kind: "user", text: "插一句", steer: true });
  reduceTimeline(m, { e: "recall", items: [{ id: "a", title: "A", kind: "memory" }] }, effects);
  const [own, steer] = m.timeline;
  assert.equal(own.kind === "user" && own.recall?.length, 1, "挂在本轮那条（不是插话）上");
  assert.equal(steer.kind === "user" ? steer.recall : "x", undefined);
});
