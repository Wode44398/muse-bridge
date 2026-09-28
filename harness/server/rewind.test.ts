// U9（X41、K23、D7）：「从这里改写」——只退对话、文件不动、原话由界面回填、可撤销。
//
// 修前：想改一句之前说过的话重来，只能整个回滚（文件一起退回去），或者在后面接着说——前面那段错的上下文一直带着。
// 修后：POST /api/sessions/:id/rewind 按「第几个用户气泡 + 气泡上的字」认出那条消息，对话退到它之前，文件一概不动；
// 之后改过的文件附一条 harness 说明告诉模型；改写前的现场拍成检查点，撤销 = 把那份对话原样换回来（改写后又发过消息就不许）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { listCheckpoints } from "./checkpoints.ts";
import type { Msg } from "./agent/turn.ts";
import { locateRewind, PRE_REWIND_LABEL, REWIND_KIND, rewindSession, sessionRecord, undoRewind, type Session } from "./session.ts";
import { loadSession } from "./store.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { todoTool } from "./tools/todo.ts";
import { writeTool } from "./tools/write.ts";

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
const userTexts = (msgs: readonly Msg[] | undefined) =>
  (msgs ?? []).filter((m) => m.role === "user" && !m.origin && !m.content.some((b) => b.t === "tool_result"))
    .map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));

// 两轮：第一轮写了 notes.md、列了待办；第二轮只回话
async function twoTurns(t: test.TestContext): Promise<{ root: string; session: Session }> {
  const root = tmp("dimensio-u9-");
  const adapter = scripted(t).next(
    calls(
      call("t1", "TodoWrite", { todos: [{ content: "写笔记", status: "completed" }] }),
      call("w1", "Write", { path: "notes.md", content: "第一轮写的\n" }),
    ),
    say("写好了"),
    say("第二条的答复"),
  );
  const session = attachSession(adapter, root, { tools: [writeTool, todoTool] });
  await send(session, "第一句：写个笔记");
  await send(session, "第二句：随便聊聊");
  return { root, session };
}

test("U9 退到第二句之前：对话只剩第一轮，文件不动，待办是那一刻的；那之后没改过文件就不附说明", async (t) => {
  const { root, session } = await twoTurns(t);
  const r = await rewindSession(session.id, { ordinal: 1, text: "第二句：随便聊聊" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.changedFiles, [], "第二轮没动文件");
  const rec = await loadSession(session.id);
  assert.deepEqual(userTexts(rec?.messages), ["第一句：写个笔记"]);
  assert.ok(!rec?.messages.some((m) => m.kind === REWIND_KIND), "文件和那一刻一样，不用说明");
  assert.deepEqual(rec?.todos, [{ content: "写笔记", status: "completed" }], "待办按保留下来的那一截重算");
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), "第一轮写的\n", "文件一个字没动");
  const cps = await listCheckpoints(session.id);
  assert.equal(cps.at(-1)?.label, PRE_REWIND_LABEL.slice(0, 60), "改写前的现场拍成了检查点（面板里也看得到）");
  assert.equal(r.undo?.n, cps.at(-1)?.n);
  assert.equal(r.undo?.length, rec?.messages.length);
});

test("U9 退到第一句之前：对话清空，附一条说明告诉模型哪些文件之后改过、没有回退；撤销把对话原样换回来", async (t) => {
  const { root, session } = await twoTurns(t);
  const before = sessionRecord(session)!.messages.length;
  const r = await rewindSession(session.id, { ordinal: 0, text: "第一句：写个笔记" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.changedFiles, ["notes.md"]);
  const rec = await loadSession(session.id);
  assert.deepEqual(userTexts(rec?.messages), []);
  const note = rec?.messages.at(-1);
  assert.equal(note?.origin, "harness");
  assert.equal(note?.kind, REWIND_KIND);
  assert.match(JSON.stringify(note?.content), /NOT rolled back.*notes\.md/);
  assert.deepEqual(rec?.todos, []);
  assert.ok(fs.existsSync(path.join(root, "notes.md")), "文件还在");

  const u = await undoRewind(session.id, r.undo!.n, r.undo!.length);
  assert.equal(u.ok, true, u.error);
  const back = await loadSession(session.id);
  assert.equal(back?.messages.length, before, "整段对话回来了");
  assert.deepEqual(userTexts(back?.messages), ["第一句：写个笔记", "第二句：随便聊聊"]);
});

test("U9 改写之后又有了新消息就不许撤销；在跑的会话不许改写；字对不上 / 找不到报 not_found", async (t) => {
  const { session } = await twoTurns(t);
  const r = await rewindSession(session.id, { ordinal: 1, text: "第二句：随便聊聊" });
  assert.equal(r.ok, true, r.error);
  const moved = await undoRewind(session.id, r.undo!.n, r.undo!.length + 1);
  assert.equal(moved.ok, false);
  assert.equal(moved.code, "moved_on");

  const live = tmp("dimensio-u9-run-");
  const s2 = attachSession(scripted(t).next(say("好")), live);
  await send(s2, "你好");
  s2.running = true;
  const busy = await rewindSession(s2.id, { ordinal: 0, text: "你好" });
  assert.equal(busy.code, "running");
  s2.running = false;
  const missing = await rewindSession(s2.id, { ordinal: 0, text: "没说过这句" });
  assert.equal(missing.code, "not_found");
});

test("U9 认消息：第几个气泡对得上就用它；前面被压缩掉了（界面没刷新）就按字找位置不超过它的；插话不许当改写点", () => {
  const u = (text: string, extra: Partial<Msg> = {}): Msg => ({ role: "user", content: [{ t: "text", text }], ...extra });
  const a = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
  const msgs: Msg[] = [
    u("[Earlier context summary] …", { origin: "harness", kind: "compaction-summary" }),
    u("第三句"), a("答三"),
    u("插一句", { origin: "steer" }), a("好"),
    u("第四句"), a("答四"),
  ];
  // 界面上还显示着被压缩掉的第一、二句：点第四句是第 4 个气泡（0 起：第一句 0、第二句 1、第三句 2、插话 3、第四句 4）
  assert.equal(locateRewind(msgs, { ordinal: 4, text: "第四句" }), 5);
  assert.equal(locateRewind(msgs, { ordinal: 2, text: "第三句" }), 1);
  assert.equal(locateRewind(msgs, { ordinal: 0, text: "第三句" }), 1, "位置对得上就直接用");
  assert.equal(locateRewind(msgs, { ordinal: 0, text: "第一句" }), -1, "压缩掉的找不回来");
  assert.equal(locateRewind(msgs, { ordinal: 2, text: "插一句" }), -1, "插话不许");
});
