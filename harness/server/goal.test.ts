// O7（H8、K64、N61、X58）：目标续跑。
//
// 修前：没有「目标」这回事——一轮做完就停，长任务要人一遍遍说「继续」；模型说「做完了」没有机器判据。
// 修后：发消息时带上 goal，这一轮做完目标还没达成就自动续下一轮；模型用 UpdateGoal(done) 声明达成，声明了验证命令的由
// harness 自己执行、通过才算；出错、被停、要人、连续 3 轮没动手、预算用完一律暂停并写明原因；服务重启后不自动续。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { afterRound, coldGoal, goalContinueText, newGoal, resumeGoal, GOAL_IDLE_LIMIT, type GoalState } from "./goal.ts";
import { goalAction, startRun, stopSession, type Session } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";

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
const probe: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Probe", description: "probe", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("probed", "ok");
  },
};
const touch: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Touch", description: "create ok.txt", parameters: { type: "object", properties: {} } },
  async run(_args, ctx) {
    fs.writeFileSync(path.join(ctx.sandbox.root, "ok.txt"), "ok\n");
    return ok("touched", "created ok.txt");
  },
};

async function settle(session: Session, ms = 20_000): Promise<GoalState> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!session.running && session.goal?.status !== "active") return session.goal!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`goal never settled: ${JSON.stringify(session.goal)}`);
}
function start(session: Session, objective: string, opts: Parameters<typeof newGoal>[1] = {}) {
  session.goal = newGoal(objective, opts); // /api/run 带 goal 时做的就是这一步
  const run = startRun(session, objective);
  assert.ok(run.started);
  return run;
}
const kinds = (session: Session) => session.state!.messages.filter((m) => m.origin === "harness" && m.kind?.startsWith("goal")).map((m) => m.kind);

test("O7 判定：续跑 / 达成 / 要人 / 出错 / 被停 / 没动手 / 预算，冷恢复与继续", () => {
  const g = { ...newGoal("做完它", { maxRounds: 3, maxMinutes: 10 }, 1000), round: 1 };
  assert.equal(afterRound(g, { kind: "done" }, true, 2000).next, "continue");
  assert.equal(afterRound({ ...g, achieved: "达成：npm test 通过" }, { kind: "done" }, true, 2000).goal.status, "done");
  assert.match(afterRound({ ...g, blocked: "要数据库密码" }, { kind: "done" }, true, 2000).goal.reason!, /需要你：要数据库密码/);
  assert.match(afterRound(g, { kind: "error", summary: "欠费" }, true, 2000).goal.reason!, /这一轮出错：欠费/);
  assert.equal(afterRound(g, { kind: "aborted", by: "user" }, true, 2000).goal.reason, "你按了停止");
  assert.equal(afterRound({ ...g, idleRounds: GOAL_IDLE_LIMIT - 1 }, { kind: "done" }, false, 2000).goal.status, "paused");
  assert.match(afterRound({ ...g, round: 3 }, { kind: "done" }, true, 2000).goal.reason!, /轮数用完（3 轮）/);
  assert.match(afterRound(g, { kind: "done" }, true, 1000 + 10 * 60_000).goal.reason!, /时长用完/);
  assert.equal(coldGoal(g).status, "paused", "服务重启后不自动续");
  const resumed = resumeGoal({ ...g, status: "paused", round: 3, reason: "轮数用完（3 轮）" }, 5000);
  assert.equal(resumed.status, "active");
  assert.equal(afterRound({ ...resumed, round: 4 }, { kind: "done" }, true, 6000).next, "continue", "继续再给一份同样的预算");
  assert.match(goalContinueText({ ...g, round: 3 }), /last round/);
  assert.doesNotMatch(goalContinueText({ ...g, round: 2 }), /last round/);
});

test("O7 做了事但没声明达成 → 自动续下一轮（首条是 goal-continue）；声明 done 且没有验证命令 → 达成、不再续", async (t) => {
  const adapter = scripted(t)
    .next(calls(call("p1", "Probe")), say("先做了一部分"), calls(call("g1", "UpdateGoal", { status: "done", summary: "全部做完" })), say("做完了"))
    .always(say("多余的一轮"));
  const session = attachSession(adapter, tmp("dimensio-o7a-"), { tools: [probe] });
  start(session, "把活干完");
  const goal = await settle(session);
  assert.equal(goal.status, "done", JSON.stringify(goal));
  assert.equal(goal.round, 2);
  assert.equal(adapter.callCount, 4, "达成之后没再续");
  assert.deepEqual(kinds(session), ["goal-start", "goal-continue"]);
  assert.equal(session.state!.toolMap.has("UpdateGoal"), true);
});

test("O7 声明了验证命令：harness 自己跑，没过把失败交回、这一轮接着改；过了才达成", async (t) => {
  const ws = tmp("dimensio-o7b-");
  const verify = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 3)"`;
  const adapter = scripted(t)
    .next(
      calls(call("g1", "UpdateGoal", { status: "done", summary: "应该好了" })), // 验证没过
      calls(call("t1", "Touch")),
      calls(call("g2", "UpdateGoal", { status: "done", summary: "补上了" })), // 这次过了
      say("好了"),
    )
    .always(say("多余的一轮"));
  const session = attachSession(adapter, ws, { tools: [touch] });
  start(session, "让 ok.txt 存在", { verify });
  const goal = await settle(session);
  assert.equal(goal.status, "done", JSON.stringify(goal));
  assert.equal(goal.round, 1, "一轮里就改好了");
  assert.match(goal.reason!, /通过/);
  const results = session.state!.messages.flatMap((m) => m.content).filter((b) => b.t === "tool_result");
  const first = results[0] as { ok: boolean; content: Array<{ t: string; text?: string }> };
  assert.equal(first.ok, false);
  assert.match(first.content.map((b) => b.text ?? "").join(""), /Not accepted: .* did not pass \(exit 3\)/);
});

test("O7 熔断：连续 3 轮没动手就暂停；要人（blocked）暂停并写明原因", async (t) => {
  const idle = scripted(t).always(say("我想想"));
  const s1 = attachSession(idle, tmp("dimensio-o7c-"), { tools: [probe] });
  start(s1, "做点什么");
  const g1 = await settle(s1);
  assert.equal(g1.status, "paused");
  assert.equal(g1.reason, `连续 ${GOAL_IDLE_LIMIT} 轮没有动手`);
  assert.equal(g1.round, GOAL_IDLE_LIMIT);

  const blocked = scripted(t).next(calls(call("b1", "UpdateGoal", { status: "blocked", reason: "要生产库的只读账号" })), say("需要账号")).always(say("多余"));
  const s2 = attachSession(blocked, tmp("dimensio-o7d-"), { tools: [probe] });
  start(s2, "查生产数据");
  const g2 = await settle(s2);
  assert.equal(g2.status, "paused");
  assert.equal(g2.reason, "需要你：要生产库的只读账号");
  assert.equal(blocked.callCount, 2, "暂停之后没再续");
});

test("O7 按停止 → 暂停；「继续」再给一份预算、立刻起下一轮；「结束」清掉目标", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Tool = {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Slow", description: "slow", parameters: { type: "object", properties: {} } },
    async run(_a, ctx) {
      await Promise.race([gate, new Promise((r) => ctx.signal?.addEventListener("abort", r, { once: true }))]);
      return ok("slow", "done");
    },
  };
  const adapter = scripted(t)
    .next(calls(call("s1", "Slow")), calls(call("g1", "UpdateGoal", { status: "done" })), say("好了"))
    .always(say("多余"));
  const session = attachSession(adapter, tmp("dimensio-o7e-"), { tools: [slow] });
  start(session, "慢慢做");
  await new Promise((r) => setTimeout(r, 200));
  stopSession(session.id);
  const g = await settle(session);
  assert.equal(g.status, "paused");
  assert.equal(g.reason, "你按了停止");
  release();

  const resumed = await goalAction(session.id, "resume");
  assert.equal(resumed.goal?.status, "active");
  const done = await settle(session);
  assert.equal(done.status, "done", "继续之后接着做完了");
  const cleared = await goalAction(session.id, "clear");
  assert.equal(cleared.goal, null);
  assert.equal(session.goal, undefined);
});
