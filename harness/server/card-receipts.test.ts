// #103：权限卡、计划卡只活在直播里——刷新或换台设备打开会话，「已允许一次 · 在手机上」「计划已批准」这些回执就没了。
//
// 修前：权限卡只由 permission_ask / permission_resolved 事件生成，服务端没把裁决写进消息；计划卡在历史里只剩一行
// ExitPlanMode 工具。工具行还在，丢的是批的哪一档、谁在哪台设备上定的、拒绝时附的话、退回的意见。
// 修后：裁决随 tool_result.meta 落盘（permissions / plan；provider 不发 meta），卡片 id 与直播同一个；历史重建时在工具行
// 后面补上已落定的卡，断线对账（按指纹比）认得出是同一张卡。回执落盘之前的旧记录，计划卡按 ExitPlanMode 结果的原话认。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Msg } from "./agent/turn.ts";
import { decidedBy, resolvePermission, resolvePlan, sessionRecord, startRun, watchSession, type Session } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import { ok, type Tool, type ToolContext } from "./tools/types.ts";
import { insertAfter, permissionItemsFromMeta, planItemFromResult } from "../web/src/lib/card-receipts.ts";
import { itemFp } from "../web/src/lib/timeline-merge.ts";
import { reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";
import type { Item } from "../web/src/lib/timeline-types.ts";

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

// 起一轮、边收事件边按 onEvent 落定卡片（观察者只活到这一轮结束，每轮重新挂）
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

// 落盘记录里某次调用的结果块（前端拿到的就是这份）
function resultBlock(session: Session, id: string): any {
  const msgs: Msg[] = sessionRecord(session)!.messages;
  for (const m of msgs) for (const b of m.content) if (b.t === "tool_result" && b.id === id) return b;
  assert.fail(`记录里没有 ${id} 的结果`);
}

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
// 直播那一份：只把卡片事件喂给前端 reducer
function liveCards(events: Record<string, unknown>[], prefix: "permission_" | "plan_"): Item[] {
  const m = newModel();
  for (const ev of events) if (String(ev.e).startsWith(prefix)) reduceTimeline(m, ev, effects);
  return m.timeline.filter((i) => i.kind === (prefix === "plan_" ? "plan" : "permission"));
}

test("#103 权限卡：裁决随工具结果落盘（id 与直播同一个，档位 / 设备 / 附言 / 记下的规则），重建出来与直播的回执同指纹；没弹卡的没有回执", async (t) => {
  const ran: string[] = [];
  const adapter = scripted(t).next(
    calls(
      call("b1", "Bash", { command: "git push origin main" }),
      call("b2", "Bash", { command: "git push --force origin main" }),
      call("b3", "Bash", { command: "git push origin dev" }),
    ),
    say("好"),
    calls(call("b4", "Bash", { command: "git push origin dev" })),
    say("又推了一次"),
  );
  const session = attachSession(adapter, tmp("dimensio-103-"), { tools: [probeBash(ran)] });
  session.state!.permissionRules = { allow: [], deny: [], ask: ["Bash(git push:*)"] };
  const phone = decidedBy({ id: "dev-phone-1", label: "手机" })!;
  const pc = decidedBy({ id: "dev-pc-1", label: "电脑" })!;
  const events = await runWith(session, (ev) => {
    if (ev.e !== "permission_ask") return;
    const cmd = String(ev.subject);
    if (cmd.includes("--force")) resolvePermission(session, String(ev.id), "deny", "先别强推", undefined, pc);
    else if (cmd.endsWith("main")) resolvePermission(session, String(ev.id), "once", undefined, undefined, phone);
    else resolvePermission(session, String(ev.id), "session", undefined, undefined, phone);
  });
  const asks = events.filter((e) => e.e === "permission_ask");
  assert.equal(asks.length, 3);
  const askOf = (cmd: string) => asks.find((e) => String(e.subject) === cmd)!;

  const r1 = resultBlock(session, "b1").meta?.permissions?.[0];
  assert.ok(r1, "b1 的结果里有回执");
  assert.equal(r1.id, askOf("git push origin main").id, "卡片 id 与直播同一个");
  assert.equal(r1.decided, "once");
  assert.deepEqual(r1.by, phone);
  assert.equal(r1.tool, "Bash");
  assert.equal(r1.subject, "git push origin main");
  assert.equal(r1.preview?.kind, "command", "卡上摆过的执行事实也在");
  const r2 = resultBlock(session, "b2").meta?.permissions?.[0];
  assert.equal(r2?.decided, "deny");
  assert.equal(r2?.note, "先别强推", "拒绝时附的话");
  assert.deepEqual(r2?.by, pc);
  const r3 = resultBlock(session, "b3").meta?.permissions?.[0];
  assert.equal(r3?.decided, "session");
  assert.deepEqual(r3?.rules, askOf("git push origin dev").sessionRules, "「本会话都允许」记下的规则");

  // 重建：从落盘的 meta 生成的卡与直播 reducer 生成的回执同指纹（对账认得出是同一张），内容也对得上
  const rebuilt = ["b1", "b2", "b3"].flatMap((id) => permissionItemsFromMeta(resultBlock(session, id).meta));
  assert.deepEqual(rebuilt.map(itemFp), liveCards(events, "permission_").map(itemFp));
  assert.deepEqual(
    rebuilt.map((p) => (p.kind === "permission" ? [p.decided, p.by?.label, p.note ?? null] : null)),
    [["once", "手机", null], ["deny", "电脑", "先别强推"], ["session", "手机", null]],
  );
  const kept = rebuilt[2];
  assert.ok(kept.kind === "permission" && kept.sessionRules?.length, "重建的回执摆得出记下的规则");

  // 本会话已允许过：直接放行、没弹卡，也就没有回执
  const again = await runWith(session, () => {});
  assert.equal(again.filter((e) => e.e === "permission_ask").length, 0);
  assert.equal(resultBlock(session, "b4").meta?.permissions, undefined);
  assert.deepEqual(ran, ["git push origin main", "git push origin dev", "git push origin dev"]);
});

test("#103 计划卡：退回（意见、设备）与批准落盘，重建出与直播同一张卡；超时没人审的作废回执也在", async (t) => {
  const adapter = scripted(t).next(
    calls(call("x1", "ExitPlanMode", { plan: "1. 改 A" })),
    calls(call("x2", "ExitPlanMode", { plan: "1. 改 A\n2. 用 sqlite" })),
    say("开干"),
  );
  const session = attachSession(adapter, tmp("dimensio-103-plan-"), { tools: [exitPlanModeTool], mode: "plan" });
  const phone = decidedBy({ id: "dev-phone-1", label: "手机" })!;
  const pc = decidedBy({ id: "dev-pc-1", label: "电脑" })!;
  let n = 0;
  const events = await runWith(session, (ev) => {
    if (ev.e !== "plan_ask") return;
    if (n++ === 0) resolvePlan(session, String(ev.id), false, "第二步换 sqlite", false, pc);
    else resolvePlan(session, String(ev.id), true, undefined, false, phone);
  });
  const asks = events.filter((e) => e.e === "plan_ask");
  assert.equal(asks.length, 2);
  const p1 = resultBlock(session, "x1");
  const p2 = resultBlock(session, "x2");
  assert.deepEqual(p1.meta?.plan, { id: asks[0].id, decided: "returned", by: pc, note: "第二步换 sqlite" });
  assert.deepEqual(p2.meta?.plan, { id: asks[1].id, decided: "approved", by: phone });
  // 工具行第二行只说结论（U8 的 outcome）：刷新后重建与直播同一句，不再露出给模型看的英文原文
  assert.equal(p1.meta?.outcome, "被退回修改");
  assert.equal(p2.meta?.outcome, "已批准，接着执行");
  const ends = events.filter((e) => e.e === "tool_end").map((e) => e.outcome);
  assert.deepEqual(ends, ["被退回修改", "已批准，接着执行"], "直播的 tool_end 也带同一句");

  const rebuilt = [planItemFromResult("x1", { plan: "1. 改 A" }, p1), planItemFromResult("x2", { plan: "1. 改 A\n2. 用 sqlite" }, p2)];
  assert.ok(rebuilt.every(Boolean));
  assert.deepEqual(rebuilt.map(itemFp), liveCards(events, "plan_").map(itemFp), "与直播的回执同一张卡");
  assert.equal(rebuilt[0]?.note, "第二步换 sqlite");
  assert.equal(rebuilt[1]?.by?.label, "手机");

  // 超时没人审：卡片作废、计划保持未批准——回执照样落盘
  const prev = process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE;
  process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE = "0.00003"; // 计划卡 60 分钟 → 约 100ms
  t.after(() => {
    if (prev === undefined) delete process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE;
    else process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE = prev;
  });
  const s2 = attachSession(scripted(t).next(calls(call("x3", "ExitPlanMode", { plan: "1. 改 B" })), say("计划如上，等你回来审")), tmp("dimensio-103-plan2-"), {
    tools: [exitPlanModeTool],
    mode: "plan",
  });
  await runWith(s2, () => {});
  const p3 = resultBlock(s2, "x3");
  assert.equal(p3.meta?.plan?.decided, null);
  assert.equal(p3.meta?.plan?.cancelled, "timeout");
  assert.equal(p3.meta?.outcome, "超时没人审，计划保持未批准");
  const item3 = planItemFromResult("x3", { plan: "1. 改 B" }, p3);
  assert.equal(item3?.cancelled, true);
  assert.equal(item3?.cancelReason, "timeout");
});

test("#103 旧记录与重建位置：计划卡按 ExitPlanMode 结果的原话认（离开模式没弹卡就不补）；回执插在它那一行工具后面；形状不对的不要", async () => {
  // 回执落盘之前的结果：工具照常跑、只是没有卡片 id（submitPlan 不带 card）→ 没有 meta，正是旧记录的样子
  const old = async (decision: Awaited<ReturnType<NonNullable<ToolContext["submitPlan"]>>>) => {
    const r = await exitPlanModeTool.run({ plan: "1. 改" }, { submitPlan: async () => decision } as unknown as ToolContext);
    assert.equal(r.meta, undefined);
    return { t: "tool_result", id: "c1", ok: r.ok, content: r.content };
  };
  const approved = planItemFromResult("c1", { plan: "1. 改" }, await old({ approved: true }));
  assert.equal(approved?.decided, "approved");
  assert.equal(approved?.id, "plan:c1");
  const back = planItemFromResult("c1", { plan: "1. 改" }, await old({ approved: false, note: "换 sqlite" }));
  assert.equal(back?.decided, "returned");
  assert.equal(back?.note, "换 sqlite");
  assert.equal(planItemFromResult("c1", { plan: "1. 改" }, await old({ approved: false, handoff: true }))?.decided, "handoff");
  const timedOut = planItemFromResult("c1", { plan: "1. 改" }, await old({ approved: false, unanswered: true, timedOut: true, timeoutMin: 60 }));
  assert.equal(timedOut?.cancelReason, "timeout");
  assert.equal(planItemFromResult("c1", { plan: "1. 改" }, await old({ approved: false, unanswered: true }))?.cancelled, true);
  assert.equal(planItemFromResult("c1", { plan: "1. 改" }, await old({ approved: false, unanswered: true, away: true })), null, "离开模式没弹过卡");
  assert.equal(planItemFromResult("c1", { plan: "  " }, await old({ approved: true })), null, "没有计划正文");

  const a = { kind: "notice", text: "a" } as Item;
  const b = { kind: "notice", text: "b" } as Item;
  const c = { kind: "notice", text: "c" } as Item;
  const x = { kind: "notice", text: "x" } as Item;
  const y = { kind: "notice", text: "y" } as Item;
  const items = [a, b, c];
  insertAfter(items, b, [x, y]);
  assert.deepEqual(items, [a, b, x, y, c], "同一次调用的几张卡按先后插在它那一行后面");
  insertAfter(items, undefined, [a]);
  assert.equal(items.at(-1), a, "找不到那一行就接在末尾");

  assert.deepEqual(
    permissionItemsFromMeta({
      permissions: [
        { id: "p1", tool: "Bash", decided: "maybe" },
        { tool: "Bash", decided: "once" },
        "x",
        { id: "p2", tool: "Bash", decided: null },
        { id: "p3", tool: "Read", decided: null, cancelled: "timeout", subject: "D:/x" },
      ],
    }).map((p) => (p.kind === "permission" ? [p.id, p.decided, p.cancelled ?? false, p.cancelReason ?? null] : null)),
    [["p3", null, true, "timeout"]],
  );
  assert.deepEqual(permissionItemsFromMeta(undefined), []);
});
