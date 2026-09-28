// K6（G4）：记忆审计门禁连败不再杀轮。
//
// 修前：答复在追问之前就给了（界面上已经看见），模型追问 3 次还不交 MemoryAudit，整轮报错——那版答复下面挂一张红卡，
// 这一轮算失败（弱模型三次不交审计是常事）。
// 修后：交付追问之前那版答复，尾注由服务端写明「记忆审计追问 3 次仍没交，已放行」；追问之前一个字都没说的，照旧报错。
import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "./agent/loop.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";

async function collect(state: ReturnType<typeof loopState>["state"]): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const ev of runAgent(state, new AbortController().signal)) events.push(ev as unknown as Record<string, unknown>);
  return events;
}
const text = (m: { content: { t: string; text?: string }[] }) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("");

test("K6 审计追问用尽：交付追问之前那版答复 + 尾注，不再整轮报错", async (t) => {
  // 先答复、不交审计；之后每次追问都只回一句空话
  const adapter = scripted(t).next(say("答案是 42。")).always(say("好的。"));
  const { state } = loopState(t, adapter, { tools: [memoryAuditTool], memoryAudit: true, finalFootnotes: true, user: "算一下" });
  const events = await collect(state);
  assert.ok(!events.some((e) => e.e === "error"), "不再报错");
  assert.equal(events.at(-1)?.e, "done");
  assert.equal(state.memoryAuditGaveUp, true);
  const visible = state.messages.filter((m) => m.role === "assistant" && !m.internal);
  assert.equal(visible.length, 1, "追问轮都是内部的，看得见的只有那版答复");
  assert.match(text(visible[0]), /^答案是 42。/);
  assert.match(text(visible[0]), /记忆审计：追问 3 次仍没交，已放行/, "尾注写在答复上（服务端写的，模型去不掉）");
  const note = events.find((e) => e.e === "text_delta" && String(e.text).includes("记忆审计"));
  assert.ok(note, "尾注也推给了界面");
  assert.equal(adapter.callCount, 4, "答复一次 + 追问三次，不多问");
});

test("K6 追问之前一个字都没说：照旧报错（那确实是没收成尾）", async (t) => {
  const adapter = scripted(t).always(say(""));
  const { state } = loopState(t, adapter, { tools: [memoryAuditTool], memoryAudit: true, finalFootnotes: true, user: "算一下" });
  const events = await collect(state);
  const err = events.find((e) => e.e === "error");
  assert.ok(err, "没有答复可交付，照旧报错");
  assert.notEqual(state.memoryAuditGaveUp, true);
});

test("K6 正常交了审计：没有尾注", async (t) => {
  const { call, calls } = await import("./test-harness/scripted-adapter.ts");
  const adapter = scripted(t).next(say("答案是 42。"), calls(call("m1", "MemoryAudit", { decision: "none", reason: "nothing durable in this exchange" })));
  const { state } = loopState(t, adapter, { tools: [memoryAuditTool], memoryAudit: true, finalFootnotes: true, user: "算一下" });
  const events = await collect(state);
  assert.equal(events.at(-1)?.e, "done");
  assert.notEqual(state.memoryAuditGaveUp, true);
  assert.ok(!events.some((e) => e.e === "text_delta" && String(e.text).includes("记忆审计")));
});
