// P10（ZCode E1、Codex X39、hermes N43、ZCode D9）：等人处理的卡停在输入框上方 + 防误触 + 输入框里的话落到卡上 + 多端落定
// 显示是谁定的。
//
// 修前：权限 / 提问 / 计划卡插在时间线里——人往上翻着看记录时新卡在屏幕外，几张卡同时在等时散落各处，手机上卡片刚冒出来
// 正好落在指尖要点的位置；卡片等着的时候在输入框里写的话进插话队列，要等卡片落定、下一个回合边界才被读到（写「别推，先跑
// 测试」，卡片那头什么也收不到）；另一台设备先点了，这边只看到结果、不知道是在哪定的。
// 修后：交互态的卡只停在输入框上方一份（一次一张、最早的那张；正在打字就等停下 1 秒；停进来 400ms 内的点击不算），时间线
// 原位留占位；草稿开始写时卡已经停着，发送就回应它（权限 = 拒绝并附言、提问 = 作答、计划 = 退回并附意见），之后才停进来的
// 卡不算；落定事件带上设备（id + 「手机 / 电脑」），别的设备的回执写「在手机上」，拒绝附言与退回意见也一并广播。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { decidedBy, resolvePermission, resolvePlan, answerAsk, startRun, watchSession, type Session } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { askUserQuestionTool } from "./tools/ask.ts";
import { ok, type Tool } from "./tools/types.ts";
import { DOCK_IDLE_MS, isPendingCard, nextDocked, pendingCards, replyTarget, slotText, type CardItem } from "../web/src/lib/card-dock.ts";
import { clientId, clientLabel, decidedElsewhere } from "../web/src/lib/client-id.ts";
import { pushItem, reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";
import type { AskItem, Item, PermissionItem, PlanItem } from "../web/src/lib/timeline-types.ts";

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

const perm = (id: string, extra: Partial<PermissionItem> = {}): PermissionItem => ({ kind: "permission", id, tool: "Bash", subject: "git push", decided: null, ...extra });
const ask = (id: string, extra: Partial<AskItem> = {}): AskItem => ({ kind: "ask", id, questions: [], answered: false, selected: {}, ...extra });
const plan = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({ kind: "plan", id, plan: "1. 改", decided: null, ...extra });

test("P10 停靠：一次只停一张（最早的）；停着的那张落定前不换；正在打字就等输入停下 1 秒", () => {
  const timeline: Item[] = [perm("p1", { decided: "once" }), ask("a1"), perm("p2"), plan("x1", { cancelled: true }), plan("x2")];
  const pending = pendingCards(timeline, true);
  assert.deepEqual(pending.map((c) => c.id), ["a1", "p2", "x2"], "已落定 / 已作废的不算");
  assert.deepEqual(pendingCards(timeline, false), [], "这一轮不在跑：没有交互态的卡");
  assert.deepEqual(nextDocked(pending, null, 60_000), { id: "a1", wait: 0 });
  assert.deepEqual(nextDocked(pending, "p2", 0), { id: "p2", wait: 0 }, "停着的那张还在等：不换，打字也不影响它");
  assert.deepEqual(nextDocked(pending, null, 300), { id: null, wait: DOCK_IDLE_MS - 300 }, "正在打字：先不停靠");
  assert.deepEqual(nextDocked(pending, "p1", 5_000), { id: "a1", wait: 0 }, "停着的落定了：换最早的下一张");
  assert.deepEqual(nextDocked([], "a1", 5_000), { id: null, wait: 0 });
  // 时间线里的占位行
  assert.match(slotText(pending[0], true, false), /在输入框上方/);
  assert.match(slotText(pending[1], false, false), /排在上一张之后/);
  assert.match(slotText(pending[0], false, true), /停下输入后/);
  assert.equal(isPendingCard(perm("p9", { decided: "deny" }), true), false);
});

test("P10 输入框里的话落到哪张卡：草稿开始写时就停着的那张才算；之后才停进来的、已落定的、改回插话的都不算", () => {
  const pending: CardItem[] = [perm("p1"), ask("a1")];
  assert.equal(replyTarget("p1", "p1", pending)?.id, "p1");
  assert.equal(replyTarget(undefined, "p1", pending), null, "草稿开始写时没有卡停着（草稿写到一半卡才停进来）");
  assert.equal(replyTarget(null, "p1", pending), null, "点了「改为插话」");
  assert.equal(replyTarget("p1", "a1", pending), null, "草稿开始时停着的那张已经换走了");
  assert.equal(replyTarget("p1", "p1", [ask("a1")]), null, "那张已经落定了（在别处点掉了）");
});

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

test("P10 谁定的：落定事件带回设备与附言，回执里别的设备定的写「在手机上」，这台设备自己点的不啰嗦", () => {
  const m = newModel();
  reduceTimeline(m, { e: "permission_ask", id: "p1", tool: "Bash", subject: "git push --force" }, effects);
  reduceTimeline(m, { e: "permission_resolved", id: "p1", decision: "deny", by: { id: "dev-phone-1", label: "手机" }, note: "先跑测试" }, effects);
  const p = m.permRefs.get("p1")!;
  assert.equal(p.decided, "deny");
  assert.deepEqual(p.by, { id: "dev-phone-1", label: "手机" });
  assert.equal(p.note, "先跑测试");
  reduceTimeline(m, { e: "ask", id: "a1", questions: [{ id: "a1:0", header: "H", question: "Q", multiSelect: false, options: [] }] }, effects);
  reduceTimeline(m, { e: "ask_answer", id: "a1", answers: [{ questionId: "a1:0", selected: ["用 sqlite"], custom: true }], by: { id: "dev-pc-1", label: "电脑" } }, effects);
  assert.deepEqual(m.askRefs.get("a1")!.by, { id: "dev-pc-1", label: "电脑" });
  reduceTimeline(m, { e: "plan_ask", id: "x1", plan: "1. 改" }, effects);
  reduceTimeline(m, { e: "plan_resolved", id: "x1", approved: false, note: "第二步用 sqlite", by: { id: "dev-phone-1", label: "手机" } }, effects);
  const x = m.planRefs.get("x1")!;
  assert.equal(x.decided, "returned");
  assert.equal(x.note, "第二步用 sqlite");
  // 形状不对的 by 不落
  pushItem(m, perm("p2"));
  m.permRefs.set("p2", m.timeline.at(-1) as PermissionItem);
  reduceTimeline(m, { e: "permission_resolved", id: "p2", decision: "once", by: { id: 42 } }, effects);
  assert.equal(m.permRefs.get("p2")!.by, undefined);
  // 回执文字
  assert.equal(decidedElsewhere({ id: "dev-phone-1", label: "手机" }), "在手机上");
  assert.equal(decidedElsewhere({ id: clientId(), label: "电脑" }), "", "这台设备自己点的");
  assert.equal(decidedElsewhere(undefined), "");
  assert.equal(clientLabel("Mozilla/5.0 (Linux; Android 16; SM-S948B) AppleWebKit/537.36 Mobile Safari/537.36"), "手机");
  assert.equal(clientLabel("Mozilla/5.0 (Linux; Android 16; SM-X910) AppleWebKit/537.36 Safari/537.36"), "平板");
  assert.equal(clientLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/37.0"), "电脑");
});

// 借 Bash 的名字、只记下自己被调用的探针（规则按 Bash 的 command 比对）
function probeBash(ran: string[]): Tool {
  return {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Bash", description: "probe", parameters: { type: "object", properties: { command: { type: "string" } } } },
    async run(args) {
      ran.push(String(args.command));
      return ok("ran", "ok");
    },
  };
}

async function runWith(session: Session, onEvent: (ev: Record<string, unknown>) => void): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "干活");
  assert.ok(run.started);
  watchSession(session, (ev) => {
    events.push(ev);
    onEvent(ev);
  });
  await run.done;
  return events;
}

test("P10 服务端：落定请求里的设备原样广播（格式不对就不带），拒绝附言一并广播并交给模型；问答、计划同样带设备", async (t) => {
  assert.deepEqual(decidedBy({ id: "dev-abc123", label: " 手机\u0007 " }), { id: "dev-abc123", label: "手机" });
  assert.deepEqual(decidedBy({ id: "dev-abc123" }), { id: "dev-abc123", label: "另一台设备" });
  assert.equal(decidedBy({ id: "x", label: "手机" }), undefined, "id 太短");
  assert.equal(decidedBy({ id: "dev abc/..", label: "手机" }), undefined, "id 带怪字符");
  assert.equal(decidedBy("dev-abc123"), undefined);

  // 权限卡：在手机上拒绝并附言
  const ran: string[] = [];
  const adapter = scripted(t).next(calls(call("b1", "Bash", { command: "git push --force origin main" })), say("好的，先不推"));
  const session = attachSession(adapter, tmp("dimensio-p10-"), { tools: [probeBash(ran)] });
  session.state!.permissionRules = { allow: [], deny: [], ask: ["Bash(git push:*)"] };
  const phone = decidedBy({ id: "dev-phone-1", label: "手机" });
  const events = await runWith(session, (ev) => {
    if (ev.e === "permission_ask") resolvePermission(session, String(ev.id), "deny", "先跑测试再推", undefined, phone);
  });
  const resolved = events.find((e) => e.e === "permission_resolved");
  assert.deepEqual(resolved?.by, { id: "dev-phone-1", label: "手机" });
  assert.equal(resolved?.note, "先跑测试再推");
  assert.deepEqual(ran, [], "拒了就没跑");
  const result = session.state!.messages.flatMap((m) => m.content).find((b) => b.t === "tool_result" && b.id === "b1");
  assert.match(result && result.t === "tool_result" ? JSON.stringify(result.content) : "", /先跑测试再推/, "附言交给了模型");

  // 问答卡：在电脑上作答
  const adapter2 = scripted(t).next(
    calls(call("q1", "AskUserQuestion", { questions: [{ header: "库", question: "用哪个库？", options: [{ label: "sqlite" }, { label: "postgres" }] }] })),
    say("好"),
  );
  const session2 = attachSession(adapter2, tmp("dimensio-p10-ask-"), { tools: [askUserQuestionTool] });
  const pc = decidedBy({ id: "dev-pc-1", label: "电脑" });
  const events2 = await runWith(session2, (ev) => {
    if (ev.e === "ask") answerAsk(session2, String(ev.id), [{ selected: ["就用 sqlite，别引新依赖"], custom: true }], pc);
  });
  assert.deepEqual(events2.find((e) => e.e === "ask_answer")?.by, { id: "dev-pc-1", label: "电脑" });

  // 计划卡：退回带意见（没带设备的旧客户端：事件里就没有 by）
  const session3 = attachSession(scripted(t), tmp("dimensio-p10-plan-"), { tools: [] });
  session3.pendingPlans.set("x1", { resolve: () => {}, plan: "1. 改" });
  const seen: Record<string, unknown>[] = [];
  watchSession(session3, (ev) => seen.push(ev));
  assert.equal(resolvePlan(session3, "x1", false, "第二步用 sqlite"), true);
  const planEv = seen.find((e) => e.e === "plan_resolved");
  assert.equal(planEv?.note, "第二步用 sqlite");
  assert.equal("by" in (planEv ?? {}), false);
});
