// #83：压缩摘要请求以前只有转录本身、没有一句指令，关着思考的本机 Qwen 连跑 5 次有 2 次只回「.」或几十个字（Q6 的
// 压缩召回 eval 在真实会话副本上照出来：生产摘要与空摘要的召回一样是 0）。压缩于是悄悄清空了上下文。
import assert from "node:assert/strict";
import test from "node:test";
import { ensureContextFits, estimateTokens, SUMMARY_INSTRUCTION, summarize } from "./agent/context.ts";
import type { Msg } from "./agent/turn.ts";
import { fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
// 一段渲染后远超 2000 字符的中段
const longMiddle = (): Msg[] =>
  Array.from({ length: 12 }, (_, i) => (i % 2 ? reply(`step ${i}: ${"worked on the parser module and recorded the outcome. ".repeat(8)}`) : user(`continue with part ${i}`)));

test("#83 摘要请求：转录包进 <transcript>，后面明说「现在写摘要」", async (t) => {
  const adapter = scripted(t).next(say(fakeSummary("parser work")));
  await summarize(adapter, longMiddle());
  const text = adapter.inputs[0].messages[0].content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(text, /^<transcript>\n[\s\S]*\n<\/transcript>\n\n/);
  assert.ok(text.endsWith(SUMMARY_INSTRUCTION), "最后一句是明确的指令");
});

test("#83 摘要短得离谱（只回「.」）：重试一次，第二次像样就用它", async (t) => {
  const adapter = scripted(t).next(say("."), say(fakeSummary("parser work")));
  const out = await summarize(adapter, longMiddle());
  assert.equal(adapter.callCount, 2);
  assert.match(out, /^parser work/);
});

// R10 起这条的结局变了：两次都没写出来不再算压缩失败（那样上下文压不下去，最后整轮超窗），而是换成一句确定性的笔记照样压，
// 靠原样保留的用户原话与机械锚点索引兜底——但绝不是一个「.」当摘要。
test("#83 → R10 两次都没写出来：换成确定性笔记照样压，用户原话还在，绝不拿「.」当摘要", async (t) => {
  const adapter = scripted(t, { capabilities: { contextWindow: 20_000 } }).next(say("."), say("ok"));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  // 窗口 2 万、缓冲 1.3 万：约 7000 token（2.8 万字符）就触发；放 4 万字符的纯文本（没有工具结果，微压缩腾不出地方）
  state.messages = [user("task"), ...Array.from({ length: 80 }, (_, i) => (i % 2 ? reply("r".repeat(1_000)) : user(`q${i}`)))];
  const before = estimateTokens(state.system, state.messages);
  const fit = await ensureContextFits(state);
  assert.equal(adapter.callCount, 2, "重试了一次");
  assert.equal(state.compactionFailures, 0);
  assert.equal(fit.compacted, true);
  assert.ok(fit.used < before, "压下去了");
  const summary = state.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).find((s) => s.startsWith("[Earlier context summary]")) ?? "";
  assert.match(summary, /No written summary: the summarizer failed/);
  assert.match(summary, /What the user said[\s\S]*> q2\n/, "被压掉那段里的用户原话原样留着");
  assert.doesNotMatch(summary, /## Notes\n\.\n/);
});

test("#83 短转录配短摘要是正常的：不算没写", async (t) => {
  const adapter = scripted(t).next(say("Read a.ts; nothing else happened."));
  const out = await summarize(adapter, [user("look at a.ts"), reply("done")]);
  assert.equal(adapter.callCount, 1);
  assert.match(out, /a\.ts/);
});
