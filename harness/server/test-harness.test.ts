// Q1（K45）：共享脚本化 provider + 事件轨迹测试台自身的契约。
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import { ScriptedAdapter, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { Recorder, drive, loopState, normalizeTrajectory } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

const turn = (text: string): Turn => ({
  system: "s",
  messages: [{ role: "user", content: [{ t: "text", text }] }],
  tools: [],
  budget: { maxOutputTokens: 10 },
});

async function drain(a: ScriptedAdapter, t: Turn): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of a.stream(t)) out.push(ev);
  return out;
}

test("Q1 多调：脚本用完还被调用——抛错且收尾判失败（哪怕抛错被 loop 的重试吞掉）", async () => {
  const a = new ScriptedAdapter().next(say("one"));
  await drain(a, turn("x"));
  await assert.rejects(drain(a, turn("y")), /unexpected model call #2/);
  assert.throws(() => a.assertDone(), /多调了模型：第 2 次调用/);
});

test("Q1 少调：脚本没用完——收尾判失败", async () => {
  const a = new ScriptedAdapter().next(say("one"), say("two"));
  await drain(a, turn("x"));
  assert.throws(() => a.assertDone(), /少调了模型：还有 1 步/);
});

test("Q1 请求检查：违反项记账，收尾判失败", async () => {
  const a = new ScriptedAdapter({ validate: (t) => (t.messages.length > 1 ? ["too many messages"] : []) }).next(say("a"), say("b"));
  await drain(a, turn("x"));
  const two: Turn = { ...turn("x"), messages: [...turn("x").messages, { role: "assistant", content: [{ t: "text", text: "a" }] }] };
  await drain(a, two);
  assert.throws(() => a.assertDone(), /请求检查不过：[\s\S]*第 2 次调用：too many messages/);
});

test("Q1 输入按调用时刻深拷贝；always() 之后一直这样答不算多调；throws 步模拟连接中断", async () => {
  const a = new ScriptedAdapter().next({ throws: "synthetic reset" }).always(say("again"));
  const t = turn("first");
  await assert.rejects(drain(a, t), /synthetic reset/);
  (t.messages[0].content[0] as { text: string }).text = "mutated later";
  assert.equal((a.inputs[0].messages[0].content[0] as { text: string }).text, "first");
  await drain(a, turn("x"));
  await drain(a, turn("y"));
  assert.equal(a.callCount, 3);
  assert.doesNotThrow(() => a.assertDone());
});

test("Q1 scripted(t)：真 loop 跑完、调用次数恰好对上时收尾通过；事件与输入交错成轨迹", async (t) => {
  let runs = 0;
  const echo: Tool = {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
    async run() {
      runs++;
      return ok("echoed", "echo result");
    },
  };
  const adapter = scripted(t).next(useTool("c1", "Echo", { v: 1 }), say("final answer"));
  const { state } = loopState(t, adapter, { tools: [echo], user: "please echo" });
  const { events, trajectory } = await drive(state, adapter);
  assert.equal(runs, 1);
  assert.ok(events.some((e) => e.e === "done"));
  assert.equal(
    trajectory,
    [
      "← turn_start 0",
      "→ model #1",
      "  tools: Echo",
      '  + user: text "please echo"',
      "← tool_start Echo#c1",
      '← tool_end Echo#c1 ok "echoed"',
      "← turn_start 1",
      "→ model #2",
      '  + assistant: call Echo#c1 {"v":1}',
      '  + user: result #c1 ok "echo result"',
      '← text "final answer"',
      "← done end",
    ].join("\n"),
  );
});

test("Q1 轨迹：流式分块合并成一行；历史被改写时标出从哪条开始；临时目录与 UUID 归一", () => {
  const r = new Recorder();
  const t1: Turn = { ...turn("a"), messages: [{ role: "user", content: [{ t: "text", text: "a" }] }, { role: "assistant", content: [{ t: "text", text: "b" }] }] };
  r.onCall(1, t1);
  r.onEvent({ e: "text_delta", text: "hel" });
  r.onEvent({ e: "text_delta", text: "lo" });
  r.onEvent({ e: "done", stopReason: "end" });
  const t2: Turn = { ...turn("a"), messages: [{ role: "user", content: [{ t: "text", text: "summary" }] }] };
  r.onCall(2, t2);
  const text = r.toString();
  assert.match(text, /← text "hello"\n← done end/);
  assert.match(text, /~ history rewritten from message 1 \(2 → 1 messages\)/);
  assert.equal(
    normalizeTrajectory(`${path.join(os.tmpdir(), "dimensio-loop-Ab12Cd", "x.ts")} 123e4567-e89b-12d3-a456-426614174000 took 35ms`),
    "<tmp>/<dir>\\x.ts <uuid> took <ms>".replace("\\", path.sep),
  );
});
