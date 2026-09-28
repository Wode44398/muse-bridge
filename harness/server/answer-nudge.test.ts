// R19（hermes N23 的 reasoning-only 分流）：只写了思考、没给答复就收尾。
//
// 修前：一轮只有思考（没正文、没工具调用）就当答完收尾——用户那头只看得见一段思考。实际使用中 1825 次模型回合里出现过 2 次，
// 其中一次（kimi）就这样收了尾：用户看到八千多字的思考、没有答复，只好再发一条。R17 只兜「什么都没回来」（连思考也没有）。
// 修后：追一句「把答复写出来」（每条用户消息最多一次；追问是 internal，聊天记录里不显示），放在验证 / 记忆审计门禁之前；
// 还是没有就照旧收尾。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { ANSWER_NUDGE } from "./agent/loop.ts";
import { visibleMessages } from "./agent/state.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";

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
// 只有思考、没有正文的一轮
const thinkOnly = (text: string): StreamEvent[] => [{ e: "thinking_delta", text }, { e: "turn_done", stopReason: "end" }];
const textOf = (m: { content: { t: string; text?: string }[] }) => m.content.filter((b) => b.t === "text").map((b) => b.text).join("");

test("R19 只写了思考就要收尾：追一句把答复写出来，答复照常交付；追问不进聊天记录", async (t) => {
  const adapter = scripted(t).next(thinkOnly("先想想怎么回答……"), say("答复：用 sqlite 就够了"));
  const session = attachSession(adapter, tmp("dimensio-r19-"));
  await send(session, "用哪个数据库？");
  const msgs = session.state!.messages;
  const nudges = msgs.filter((m) => m.role === "user" && m.origin === "harness" && m.kind === "answer-nudge");
  assert.equal(nudges.length, 1, "追问了一次");
  assert.equal(textOf(nudges[0]), ANSWER_NUDGE);
  assert.equal(nudges[0].internal, true);
  const visible = visibleMessages(msgs);
  assert.ok(!visible.some((m) => m.kind === "answer-nudge"), "追问不进聊天记录");
  assert.ok(visible.some((m) => m.role === "assistant" && textOf(m).includes("用 sqlite 就够了")), "答复交付了");
  assert.equal(adapter.callCount, 2);
});

test("R19 追问之后还是只有思考：不再追问，照旧收尾（不报错、不空转）", async (t) => {
  const adapter = scripted(t).next(thinkOnly("想一想"), thinkOnly("再想一想"));
  const session = attachSession(adapter, tmp("dimensio-r19-twice-"));
  await send(session, "在吗");
  assert.equal(adapter.callCount, 2, "只追问一次");
  const nudges = session.state!.messages.filter((m) => m.kind === "answer-nudge");
  assert.equal(nudges.length, 1);
  assert.ok(!JSON.stringify(session.state!.messages).includes("empty_model_response"), "有思考就不是空响应");
});

test("R19 有正文的一轮不追问；下一条用户消息重新计数", async (t) => {
  const adapter = scripted(t).next(say("好的"), thinkOnly("嗯……"), say("第二个答复"));
  const session = attachSession(adapter, tmp("dimensio-r19-count-"));
  await send(session, "第一问");
  assert.equal(session.state!.messages.filter((m) => m.kind === "answer-nudge").length, 0);
  await send(session, "第二问");
  assert.equal(session.state!.messages.filter((m) => m.kind === "answer-nudge").length, 1, "新的一条用户消息又能追问一次");
  assert.equal(adapter.callCount, 3);
});
