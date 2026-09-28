// #87：回滚「回到这条消息之前」要真的回到这条消息之前。
//
// 修前：startRun 在追加这条用户消息之前取会话记录，可记录里的 messages 是活数组的引用；检查点在后台排队、几次 await 之后才
// 序列化，写下的已经带上了这条消息。回滚到 #n 之后，对话停在「消息 n 已发、没有回答」。
// 修后：取记录时浅拷一份 messages / todos / ranCommands，检查点里的记录定格在追加之前。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { listCheckpoints } from "./checkpoints.ts";
import { rollbackSession } from "./session.ts";
import { loadSession } from "./store.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

test("#87 回滚到「第二条消息之前」：对话里只剩第一条和它的答复，没有第二条", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-87-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "notes.txt"), "v0\n");
  const adapter = scripted(t).next(say("第一条的答复"), say("第二条的答复"));
  const session = attachSession(adapter, root);
  await send(session, "第一条消息");
  await send(session, "第二条消息");

  const cps = await listCheckpoints(session.id);
  assert.equal(cps.length, 2, "每条消息开跑前各一个检查点");
  const r = await rollbackSession(session.id, cps[1].n); // 界面上「回到第二条消息之前」
  assert.deepEqual(r, { ok: true });

  const rec = await loadSession(session.id);
  const userTexts = (rec?.messages ?? [])
    .filter((m) => m.role === "user" && !m.origin)
    .map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));
  assert.deepEqual(userTexts, ["第一条消息"], "第二条消息不在回滚后的对话里");
  assert.ok(JSON.stringify(rec?.messages).includes("第一条的答复"), "第一条的答复还在");
});
