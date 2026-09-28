// R9：CJK 感知的 token 估算 + 实测锚点加增量 + 按剩余窗口夹住输出上限；另记下 provider 真拒过的窗口（R7 的立刻压缩），
// 主动压缩按它判。
import assert from "node:assert/strict";
import test from "node:test";
import { compactNow, contextTokens, ensureContextFits, estimateTokens } from "./agent/context.ts";
import type { Msg } from "./agent/turn.ts";
import { comparePrefix, fingerprintWire } from "./providers/wire-fingerprint.ts";
import { fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });

test("R9 中日韩文字约 1 个字 1 token，ASCII 约 4 个字符 1 token（以前一律按 4 个字符算，中文低估三四倍）", () => {
  assert.equal(estimateTokens("", [user("你好".repeat(1000))]), 2000);
  assert.equal(estimateTokens("", [user("abcd".repeat(1000))]), 1000);
  assert.equal(estimateTokens("系统提示", []), 4);
  assert.equal(estimateTokens("", [user("修复 bug ok")]), 4, "混排：2 个汉字 + 7 个 ASCII 字符（含空格）= 3.75，向上取整");
});

test("R9 实测锚点 + 之后追加的估算：实测之后新来的内容算进去", (t) => {
  const adapter = scripted(t);
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = [user("task"), reply("ok")];
  state.recordUsage(5_000, 10); // provider 说这次请求用了 5000 个输入 token
  state.messages.push(user("中".repeat(3_000)));
  const used = contextTokens(state);
  assert.ok(used >= 8_000, `锚点 5000 + 追加约 3000，实际 ${used}`);
  assert.ok(used < 8_200);
});

test("R9 历史被就地改写（压缩、修复……）后锚点作废，退回整段估算与上次实测的较大值", (t) => {
  const adapter = scripted(t);
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = [user("task"), reply("ok")];
  state.recordUsage(5_000, 10);
  state.messages.push(user("中".repeat(3_000)));
  state.noteRewrite("micro-compaction");
  assert.equal(state.contextAnchor, null);
  assert.equal(contextTokens(state), Math.max(estimateTokens(state.system, state.messages), state.lastContextTokens));
});

test("R9 provider 真拒过的窗口记下来，主动压缩按它判", async (t) => {
  const adapter = scripted(t, { capabilities: { contextWindow: 200_000 } }).always(say(fakeSummary("前情提要")));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = [user("task"), ...Array.from({ length: 60 }, (_, i) => (i % 2 ? reply("r".repeat(4_000)) : user(`q${i}`)))];
  const before = contextTokens(state); // 约 3 万 token（高于「两倍缓冲」的下限）：provider 就在这儿说超窗了
  assert.ok(before > 26_000);
  assert.ok(await compactNow(state));
  assert.equal(state.observedWindow, before);
  const fit = await ensureContextFits(state);
  assert.equal(fit.limit, before, "之后按真拒过的窗口判，不再按目录里的 20 万");
});

test("R9 离窗口边缘不远时按剩余的地方夹住输出上限；离得远就不动", async (t) => {
  // 窗口 10 万、历史约 8 万 token（主动压缩线是 8.7 万，不会先动手）：剩约 1.9 万，输出上限 3.2 万被夹到这附近
  const near = scripted(t, { capabilities: { contextWindow: 100_000 } }).next(say("好"));
  const a = loopState(t, near, { memoryAudit: false });
  a.state.budget = { maxOutputTokens: 32_000, thinking: "off" };
  a.state.messages = [user("task"), ...Array.from({ length: 80 }, (_, i) => (i % 2 ? reply("r".repeat(8_000)) : user(`q${i}`)))];
  a.state.addUserMessage("接着来");
  await drive(a.state, near);
  const clamped = near.inputs[0].budget.maxOutputTokens;
  assert.ok(clamped < 32_000 && clamped >= 1_024, `夹住了：${clamped}`);
  assert.ok(clamped + contextTokens(a.state) <= 100_000, "输入 + 输出上限不超过窗口");
  assert.equal(a.state.budget.maxOutputTokens, 32_000, "只改这一次请求，不动会话的预算");

  const far = scripted(t, { capabilities: { contextWindow: 100_000 } }).next(say("好"));
  const b = loopState(t, far, { memoryAudit: false, user: "短问题" });
  b.state.budget = { maxOutputTokens: 32_000, thinking: "off" };
  await drive(b.state, far);
  assert.equal(far.inputs[0].budget.maxOutputTokens, 32_000);
});

test("R9 输出上限变了不算前缀断点（各家缓存只认前缀；Gemini 的在 generationConfig 里）", () => {
  const m1 = [{ role: "user", content: "a" }];
  const m2 = [...m1, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
  const openA = fingerprintWire("openai", { model: "x", max_tokens: 32_000, messages: m1 });
  const openB = fingerprintWire("openai", { model: "x", max_tokens: 9_000, messages: m2 });
  assert.equal(comparePrefix(openA, openB).verdict, "append");
  const gemA = fingerprintWire("gemini", { contents: [{ role: "user", parts: [{ text: "a" }] }], generationConfig: { temperature: 1, maxOutputTokens: 32_000 } });
  const gemB = fingerprintWire("gemini", { contents: [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b" }] }], generationConfig: { temperature: 1, maxOutputTokens: 9_000 } });
  assert.equal(comparePrefix(gemA, gemB).verdict, "append");
  const gemC = fingerprintWire("gemini", { contents: [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b" }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 9_000 } });
  assert.equal(comparePrefix(gemA, gemC).at, "params", "别的生成参数变了照样算断点");
});
