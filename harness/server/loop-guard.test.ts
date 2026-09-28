// R15：分级重复熔断——同一个调用连着重复（3/5/8 提醒、12 熔断）、失败维度（同参 2/5、同工具 3/8）、周期（A,B,A,B…）；
// 提醒追加在调用结果末尾；熔断只在无人值守时真停（收尾轮：工具不再执行、给最终总结），有人在场只提醒。
import assert from "node:assert/strict";
import test from "node:test";
import { callKey, LoopGuard } from "./agent/loop-guard.ts";
import type { Msg } from "./agent/turn.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

const notesAt = (g: LoopGuard, n: number, name = "Echo", args: Record<string, unknown> = { x: 1 }, success = true) =>
  Array.from({ length: n }, () => g.observe(name, args, success));

test("R15 同一个调用连着重复：第 3、5、8 次提醒，第 12 次（之后每 4 次）判熔断；换个调用就重新数", () => {
  const v = notesAt(new LoopGuard(), 16);
  const noted = v.map((x, i) => (x.note ? i + 1 : 0)).filter(Boolean);
  assert.deepEqual(noted, [3, 5, 8, 12, 16]);
  assert.deepEqual(v.map((x, i) => (x.stop ? i + 1 : 0)).filter(Boolean), [12, 16]);
  const g = new LoopGuard();
  notesAt(g, 2);
  g.observe("Echo", { x: 2 }, true);
  assert.equal(g.observe("Echo", { x: 1 }, true).note, undefined, "中间换过调用，重新数");
  assert.equal(callKey("Echo", { b: 1, a: [{ d: 2, c: 1 }] }), callKey("Echo", { a: [{ c: 1, d: 2 }], b: 1 }), "参数键的顺序不算");
});

test("R15 失败维度：同参失败第 2 次提醒、第 5 次熔断；同一个工具连着失败第 3 次提醒、第 8 次熔断；成功就清零", () => {
  // 同一个失败的调用中间夹着别的（不算连着重复），第 2 次失败提醒、第 5 次失败熔断
  const same = new LoopGuard();
  const failTest = () => same.observe("Bash", { command: "npm test" }, false);
  const verdicts = [];
  for (let i = 0; i < 5; i++) {
    verdicts.push(failTest());
    same.observe("Read", { path: `f${i}` }, true);
  }
  assert.equal(verdicts[0].note, undefined);
  assert.match(verdicts[1].note ?? "", /failed 2 times/);
  assert.equal(verdicts[3].stop, undefined);
  assert.match(verdicts[4].stop ?? "", /retried 5 times/);

  const tool = new LoopGuard();
  const fails = Array.from({ length: 8 }, (_, i) => tool.observe("Edit", { path: "x", old: `o${i}` }, false));
  assert.match(fails[2].note ?? "", /Edit has failed 3 times in a row/);
  assert.match(fails[7].stop ?? "", /Edit failed 8 times in a row/);
  const reset = new LoopGuard();
  reset.observe("Edit", { n: 1 }, false);
  reset.observe("Edit", { n: 2 }, false);
  reset.observe("Edit", { n: 3 }, true);
  assert.equal(reset.observe("Edit", { n: 4 }, false).note, undefined, "成功一次就从头数");
});

test("R15 周期：同一段 2–4 个调用连着重复 3 遍提醒一次（没断开不重复提醒），第 3 次发现判熔断；轮询不算", () => {
  const g = new LoopGuard();
  const step = (k: string) => g.observe("Read", { path: k }, true);
  const seq = ["a", "b", "a", "b", "a", "b"].map(step);
  assert.match(seq[5].note ?? "", /same sequence of 2 calls/);
  assert.equal(step("a").note, undefined, "还在同一个周期里，不重复提醒");
  let stops = 0;
  for (let round = 0; round < 2; round++) {
    step("z");
    for (const k of ["c", "d", "e", "c", "d", "e", "c", "d", "e"]) if (step(k).stop) stops++;
  }
  assert.equal(stops, 1, "第 3 次发现周期时熔断");
  const poll = new LoopGuard();
  assert.ok(notesAt(poll, 20, "Bash", { poll: "job1" }).every((v) => !v.note && !v.stop), "轮询后台 job 本来就要重复");
});

const echo: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "same output");
  },
};
const toolTexts = (msgs: Msg[]) =>
  msgs.flatMap((m) => m.content).flatMap((b) => (b.t === "tool_result" ? [b.content.map((c) => (c.t === "text" ? c.text : "")).join("\n")] : []));

test("R15 在 loop 里：有人在场只把提醒追加在结果末尾、不停；无人值守到第 12 次熔断——收尾轮工具不执行，给最终总结", async (t) => {
  const repeat = Array.from({ length: 12 }, (_, i) => useTool(`c${i}`, "Echo", { x: 1 }));

  const attendedAdapter = scripted(t).next(...repeat, say("done"));
  const attended = loopState(t, attendedAdapter, { tools: [echo], user: "go" }).state;
  await drive(attended, attendedAdapter);
  const texts = toolTexts(attended.messages);
  assert.equal(texts.length, 12, "有人在场：12 次都执行了");
  assert.deepEqual(texts.map((s, i) => (/\[Loop guard\]/.test(s) ? i + 1 : 0)).filter(Boolean), [3, 5, 8, 12]);
  assert.equal(attended.loopGuardStopped, false);

  // 收尾轮里模型还是调了工具：照旧不执行、这一轮就收工（与预算用尽同一条路）
  const awayAdapter = scripted(t).next(...repeat, useTool("c12", "Echo", { x: 1 }));
  const away = loopState(t, awayAdapter, { tools: [echo], user: "go", ctx: { humanAttended: () => false } }).state;
  const { events } = await drive(away, awayAdapter);
  assert.equal(away.loopGuardStopped, true);
  const stopNote = away.messages.find((m) => m.internal && m.content.some((b) => b.t === "text" && /^\[Loop guard\] Stopping this run/.test(b.text)));
  assert.ok(stopNote, "熔断说明以 internal 消息进转录");
  const skipped = events.filter((ev) => ev.e === "tool_end" && ev.summary === "skipped (loop guard)");
  assert.equal(skipped.length, 1, "熔断之后那一次调用没执行");
  assert.equal(toolTexts(away.messages).filter((s) => s === "same output" || s.startsWith("same output")).length, 12);
});
