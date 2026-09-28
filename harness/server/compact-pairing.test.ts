// R5（#11）：全量压缩不许产出非法转录 + toTurn 出口统一配对修复。
// 改写自探针 02-kimi-code/笔记/probe-compact-shape.test.ts。
//
// 修前压缩后的形状是 `u:task, a:call(c0), u:摘要, u:res(c6), …`——头部留下的 call(c0) 结果被压进了
// 摘要，尾部从孤儿 res(c6) 开始；各家 API 都回 400（判为不可重试），落盘后每轮重放，会话报废。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentState, repairToolPairing } from "./agent/state.ts";
import { ensureContextFits } from "./agent/context.ts";
import type { Block, Msg } from "./agent/turn.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import { fakeSummary } from "./test-harness/scripted-adapter.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r5-"));
test.after(() => fs.rmSync(ws, { recursive: true, force: true }));

const adapter: ProviderAdapter = {
  id: "openai",
  model: "fake",
  capabilities: { contextWindow: 30_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false },
  async *stream() {
    yield { e: "text_delta", text: fakeSummary("summary of the middle") };
    yield { e: "turn_done", stopReason: "end" };
  },
};

function newState(): AgentState {
  const st = new AgentState({
    adapter,
    system: "test",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(ws), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  return st;
}

const text = (t: string): Block => ({ t: "text", text: t });
const call = (id: string): Block => ({ t: "tool_call", id, name: "Bash", args: { command: "echo " + id } });
const res = (id: string, body = "ok"): Block => ({ t: "tool_result", id, ok: true, content: [text(body)] });

// 与各家 API 同口径的检查：call 的结果必须全部在紧跟的下一条 user 消息里、排在最前；结果只能回应上一条 assistant 的 call。
function pairingProblems(msgs: Msg[]): string[] {
  const problems: string[] = [];
  msgs.forEach((m, i) => {
    const results = m.content.filter((b) => b.t === "tool_result").map((b) => (b as { id: string }).id);
    if (m.role === "user" && results.length) {
      const prev = msgs[i - 1];
      const calls = prev?.role === "assistant" ? prev.content.filter((b) => b.t === "tool_call").map((b) => (b as { id: string }).id) : [];
      for (const id of results) if (!calls.includes(id)) problems.push(`orphan result ${id} at ${i}`);
      const firstOther = m.content.findIndex((b) => b.t !== "tool_result");
      if (firstOther >= 0 && m.content.slice(firstOther).some((b) => b.t === "tool_result")) problems.push(`results not first at ${i}`);
    }
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.t === "tool_call").map((b) => (b as { id: string }).id);
      if (!calls.length) return;
      const next = msgs[i + 1];
      const got = next?.role === "user" ? next.content.filter((b) => b.t === "tool_result").map((b) => (b as { id: string }).id) : [];
      for (const id of calls) if (!got.includes(id)) problems.push(`call ${id} at ${i} has no result right after it`);
    }
  });
  return problems;
}

test("全量压缩后的转录配对完整，出口不用再修（四种尾部长度）", async () => {
  for (const tailSkew of [0, 1, 2, 3]) {
    const st = newState();
    st.preCompactAuditPassed = true;
    const msgs: Msg[] = [{ role: "user", content: [text("task")] }];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "assistant", content: [{ t: "tool_call", id: `c${i}`, name: "Bash", args: { command: "x".repeat(3000 + tailSkew * 1700) } }] });
      msgs.push({ role: "user", content: [res(`c${i}`, "y".repeat(500))] });
    }
    st.messages = msgs;
    st.lastContextTokens = 29_000;
    const fit = await ensureContextFits(st);
    assert.equal(fit.compacted, true, `skew ${tailSkew}`);
    assert.ok(st.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.startsWith("[Earlier context summary]"))), "真的走了全量压缩");
    assert.deepEqual(pairingProblems(st.messages), [], `skew ${tailSkew}: 压缩后的转录`);
    assert.equal(repairToolPairing(st.messages).repairs, 0, `skew ${tailSkew}: 出口不该还要修`);
    assert.deepEqual(pairingProblems(st.toTurn().messages), []);
  }
});

test("出口修复：缺的结果补上、孤儿与重复的结果丢掉、散开的结果挪到紧跟 call 的位置", () => {
  const st = newState();
  st.messages = [
    { role: "user", content: [text("task")] },
    // 缺一个结果
    { role: "assistant", content: [text("two calls"), call("a1"), call("a2")] },
    { role: "user", content: [res("a1")] },
    // 没有 call 的 assistant 后面跟着孤儿结果
    { role: "assistant", content: [text("plain answer")] },
    { role: "user", content: [res("ghost"), text("user says hi")] },
    // 结果散在两条消息里，中间夹着一条插话；外加一个重复结果
    { role: "assistant", content: [call("b1"), call("b2")] },
    { role: "user", content: [res("b1")] },
    { role: "user", content: [text("steer: also check the logs")] },
    { role: "user", content: [res("b2"), res("b1", "dup")] },
    // 末尾的 call 一个结果都没有
    { role: "assistant", content: [call("z1")] },
  ];
  const sent = st.toTurn().messages;
  assert.deepEqual(pairingProblems(sent), []);
  assert.ok(st.pairingRepairs >= 5, `修复次数有记账（${st.pairingRepairs}）`);
  const flat = JSON.stringify(sent);
  assert.match(flat, /Result not available/, "缺的结果补上了明说的失败结果");
  assert.doesNotMatch(flat, /ghost/, "孤儿结果丢掉");
  assert.doesNotMatch(flat, /"dup"/, "重复结果丢掉");
  assert.match(flat, /user says hi/, "孤儿结果旁边的正文保留");
  assert.match(flat, /steer: also check the logs/, "插话保留");
  // 插话排在结果之后
  const steerAt = sent.findIndex((m) => m.content.some((b) => b.t === "text" && b.text.startsWith("steer:")));
  const b2At = sent.findIndex((m) => m.content.some((b) => b.t === "tool_result" && b.id === "b2"));
  assert.ok(b2At >= 0 && b2At < steerAt);
  // 转录本身不动
  assert.equal(st.messages.length, 10);
  assert.equal(st.messages[2].content.length, 1);
});

test("形状正确时出口原样放行，不计修复", () => {
  const st = newState();
  st.messages = [
    { role: "user", content: [text("task")] },
    { role: "assistant", content: [call("k1"), call("k2")] },
    { role: "user", content: [res("k1"), res("k2"), text("[reminder]")] },
    { role: "user", content: [text("steer")] },
    { role: "assistant", content: [text("done")] },
  ];
  const out = repairToolPairing(st.messages);
  assert.equal(out.repairs, 0);
  assert.equal(out.messages, st.messages, "同一个数组，缓存前缀不被打乱");
  st.toTurn();
  assert.equal(st.pairingRepairs, 0);
});
