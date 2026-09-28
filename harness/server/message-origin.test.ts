// C3（#41）：用户侧消息的来源由结构化字段说了算（Msg.origin / kind），不再按文本开头猜。
//
// 修前：服务端按开头（`[Automated check]`、`[Memory audit required]`……）认「这是系统注入」，前端再用另一套 NOTICE_RE——
// 用户把界面上的提示语贴回来问「这是什么意思」，提问连同上一条答复一起从聊天记录里消失；用户写的「[Reminder] 明早九点…」
// 被渲染成系统提示条。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { injectionsIn, messageKind } from "./agent/injections.ts";
import { visibleMessages } from "./agent/state.ts";
import type { Msg } from "./agent/turn.ts";
import { dropSession, persistNow } from "./session.ts";
import { loadSession, parseSessionRecord, SESSION_RECORD_VERSION } from "./store.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";

const PASTED = "[Automated check] You have edited files without sufficient passing verification evidence. ← 刚才日志里有这句，是什么意思？";
const textOf = (m: Msg) => m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("\n");

test("C3: the user's own words are never an injection — even when they start like a harness prompt — through a real run and a reload", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-c3-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const adapter = scripted(t).next(say("这是验证门禁的提示……")).always(say("好"));
  const session = attachSession(adapter, ws);
  await send(session, "把登录页改成手机号登录");
  await send(session, PASTED);
  await persistNow(session);
  const id = session.id;
  dropSession(id);

  const rec = await loadSession(id);
  assert.ok(rec);
  assert.equal(rec!.origins, 1, "新记录带着来源标记");
  const mine = rec!.messages.find((m) => m.role === "user" && textOf(m) === PASTED)!;
  assert.ok(mine, "原话在转录里");
  assert.equal(mine.origin, undefined, "用户本人的消息没有 origin");
  assert.equal(messageKind(mine), null);
  assert.deepEqual(Object.keys(injectionsIn([mine])), [], "不算注入");
  const visible = visibleMessages(rec!.messages);
  assert.ok(visible.some((m) => m.role === "user" && textOf(m) === PASTED), "重载后原话仍在聊天记录里");
  assert.ok(visible.some((m) => m.role === "assistant" && textOf(m).includes("验证门禁")), "上一条答复也在");
});

test("C3: a record written before C3 is tagged once on load by the old rules — legacy nudges stay hidden, legacy steers stay the user's", () => {
  const nudge = "[Automated check] You have edited files without sufficient passing verification evidence. Run a real verification before finishing.";
  const steer = "[用户在运行中插话] 以下是用户刚刚发来的消息。它优先于此前的指示：如果与你正在做的事冲突，按这条来（必要时放弃/回滚正在进行的做法），然后继续。\n\n换个做法";
  const legacy = {
    v: SESSION_RECORD_VERSION, id: "c3-legacy", createdAt: 1, updatedAt: 2, title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto" },
    system: "s",
    messages: [
      { role: "user", content: [{ t: "text", text: "改一下" }] },
      { role: "assistant", content: [{ t: "text", text: "premature" }] },
      { role: "user", content: [{ t: "text", text: nudge }] },
      { role: "assistant", content: [{ t: "text", text: "final" }] },
      { role: "user", content: [{ t: "text", text: steer }] },
    ],
    todos: [], totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
  const r = parseSessionRecord(JSON.stringify(legacy), "c3-legacy");
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.rec.origins, 1);
  const [first, , gate, , mid] = r.rec.messages;
  assert.equal(first.origin, undefined);
  assert.deepEqual([gate.origin, gate.kind], ["harness", "verify-nudge"]);
  assert.equal(mid.origin, "steer");
  const visible = visibleMessages(r.rec.messages).map(textOf);
  assert.deepEqual(visible, ["改一下", "final", steer], "旧式追问与它前面那条提前的答复照旧不显示；插话照旧显示");

  // 已带标记的记录不再猜：同样开头的用户原话原样保留
  const marked = parseSessionRecord(
    JSON.stringify({ ...legacy, id: "c3-marked", origins: 1, messages: [legacy.messages[0], legacy.messages[1], { role: "user", content: [{ t: "text", text: nudge }] }] }),
    "c3-marked",
  );
  assert.ok(marked.kind === "ok" && marked.rec.messages[2].origin === undefined);
  assert.equal(marked.kind === "ok" ? visibleMessages(marked.rec.messages).length : 0, 3);
});
