// U10（K38）：审阅面板的「本会话」基线 + 逐文件撤销。
//
// 修前：审阅面板只有「项目 git 基线」——人手改的和 agent 改的混在一起，非 git 的工作区（快照对话桶、临时目录）什么都看
// 不到；要退回一个被改坏的文件只能整树回滚（连对话一起回去）。
// 修后：基线 = 这个会话的第一张检查点。列表只列这个对话改过的文件（人手改的只报个数），标出「改完之后又被别人动过」的；
// 逐文件撤销把文件退回会话开始之前（新建的删掉），规矩照回滚：在跑不做、外部改动要确认、先拍现场可找回、转录附说明。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { injectionKind } from "./agent/injections.ts";
import { listCheckpoints, recordRunEnd, reviewablePath, sessionChangeList, sessionFileDiff, takeCheckpoint } from "./checkpoints.ts";
import { dropSession, PRE_RESTORE_LABEL, RESTORE_KIND, restoreSessionFiles, rollbackSession, sessionReview, startRun } from "./session.ts";
import { loadSession, type PersistedSession } from "./store.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR !== undefined) process.env.SESSIONS_DIR = BASE_SESSIONS_DIR; // 还原，不 delete（见 test-setup.ts）
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const rec = (id: string, ws: string): PersistedSession => ({
  v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
  config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" },
  system: "s",
  messages: [],
  todos: [],
  totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
  gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
  counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
});

test("U10: 「本会话」只列这个对话改过的文件（新建 / 改 / 删）；人手改的只报个数；它改完又被手改的标 external", async () => {
  process.env.SESSIONS_DIR = temp("dimensio-u10-state-");
  const ws = temp("dimensio-u10-ws-");
  const id = "u10-list";
  const w = (rel: string, text: string) => fs.writeFileSync(path.join(ws, rel), text);
  w("keep.txt", "base\n");
  w("edit.txt", "v0\n");
  w("gone.txt", "old\n");

  const cp1 = await takeCheckpoint(rec(id, ws), ws, "msg1"); // 会话第一条消息之前 = 基线
  w("edit.txt", "v1\n");
  w("new.txt", "agent made\n");
  fs.rmSync(path.join(ws, "gone.txt"));
  await recordRunEnd(id, ws, cp1!.n); // 第一轮收尾
  w("keep.txt", "人手改的\n"); // 两轮之间人手改 / 手建，对话没碰过
  w("human.txt", "手建的\n");
  const cp2 = await takeCheckpoint(rec(id, ws), ws, "msg2");
  w("new2.txt", "agent made again\n");
  await recordRunEnd(id, ws, cp2!.n);
  w("new.txt", "agent made\n人又补了一行\n"); // 对话改完之后人又动了

  const list = await sessionChangeList(id, ws);
  assert.ok(list, "有检查点就有基线");
  assert.equal(list.since, cp1!.at);
  const rows = [...list.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path} ${f.st} +${f.add} -${f.del}${f.external ? " external" : ""}`);
  assert.deepEqual(rows, ["edit.txt M +1 -1", "gone.txt D +0 -1", "new.txt A +2 -0 external", "new2.txt A +1 -0"]);
  assert.equal(list.others, 2, "keep.txt、human.txt 是对话之外改的：不列，只报个数");

  // 单文件 diff：基线 → 现在
  const diff = await sessionFileDiff(id, ws, "edit.txt");
  assert.match(diff!.diff, /^-v0$/m);
  assert.match(diff!.diff, /^\+v1$/m);
  assert.equal(diff!.bin, false);
  assert.match((await sessionFileDiff(id, ws, "new.txt"))!.diff, /^\+人又补了一行$/m);

  assert.equal(await sessionChangeList("u10-nobody", ws), null, "没有检查点的会话没有这个视图");
});

test("U10: 路径护栏——绝对路径、越界、凭据文件一律不收", () => {
  assert.equal(reviewablePath("src/a.ts"), true);
  assert.equal(reviewablePath("a b/中文.txt"), true);
  for (const bad of ["", "../x.txt", "a/../../x", "/etc/passwd", "C:/Windows/x", "C:\\x", ".env", "config/.env.local", "id_rsa", "k.pem"]) {
    assert.equal(reviewablePath(bad), false, bad);
  }
});

// 真走一轮：这一轮改了一个已有文件、在新目录里建了一个文件
const scribe: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Scribe", description: "write notes", parameters: { type: "object", properties: {} } },
  async run(_args, ctx) {
    fs.writeFileSync(path.join(ctx.sandbox.root, "notes.txt"), "agent wrote this\n");
    fs.mkdirSync(path.join(ctx.sandbox.root, "out", "deep"), { recursive: true });
    fs.writeFileSync(path.join(ctx.sandbox.root, "out", "deep", "made.txt"), "new file\n");
    return ok("written", "done");
  },
};

test("U10: 逐文件撤销——改的写回原样、新建的删掉（连空了的新目录）；外部改动不带 force 不动；撤销前现场找得回；转录附 restore 说明", async (t) => {
  process.env.SESSIONS_DIR = temp("dimensio-u10-state-");
  const ws = temp("dimensio-u10-ws-");
  const notes = path.join(ws, "notes.txt");
  const made = path.join(ws, "out", "deep", "made.txt");
  fs.writeFileSync(notes, "orig\n");

  const adapter = scripted(t).next(calls(call("s1", "Scribe", {})), say("写好了")).always(say("好了"));
  const session = attachSession(adapter, ws, { tools: [scribe] });
  const id = session.id;
  await send(session, "记一下");
  dropSession(id);

  const view = await sessionReview(id);
  assert.equal(view.available, true);
  if (!view.available) return;
  assert.deepEqual(view.files.map((f) => `${f.path} ${f.st}${f.external ? " external" : ""}`).sort(), ["notes.txt M", "out/deep/made.txt A"]);
  assert.equal(view.busy, false);

  fs.writeFileSync(notes, "agent wrote this\n人又补了一行\n"); // 人手又改了 agent 写的文件

  const refused = await restoreSessionFiles(id, ["notes.txt"]);
  assert.equal(refused.code, "external");
  assert.deepEqual(refused.external, ["notes.txt"]);
  assert.equal(fs.readFileSync(notes, "utf8"), "agent wrote this\n人又补了一行\n", "没确认就一个字节不动");
  assert.equal((await restoreSessionFiles(id, ["keep-out.txt"])).code, "stale", "不在「本会话改动」里的不撤");
  const before = (await listCheckpoints(id)).length;

  const done = await restoreSessionFiles(id, ["notes.txt", "out/deep/made.txt"], { force: true });
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(done.restored, ["notes.txt"]);
  assert.deepEqual(done.removed, ["out/deep/made.txt"]);
  assert.equal(fs.readFileSync(notes, "utf8"), "orig\n", "退回会话开始之前");
  assert.equal(fs.existsSync(made), false, "这个对话新建的删掉");
  assert.equal(fs.existsSync(path.join(ws, "out")), false, "因此空了、基线里本来也没有的目录一起收掉");

  const cps = await listCheckpoints(id);
  assert.equal(cps.length, before + 1);
  assert.equal(cps.at(-1)!.label, PRE_RESTORE_LABEL.slice(0, 60));
  assert.equal(done.undo?.n, cps.at(-1)!.n);

  const saved = await loadSession(id);
  const note = saved!.messages.at(-1)!;
  assert.equal(note.origin, "harness");
  assert.equal(note.kind, RESTORE_KIND);
  const text = note.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.equal(injectionKind(text), "restore");
  assert.match(text, /notes\.txt/);
  assert.match(text, /out\/deep\/made\.txt/);

  const after = await sessionReview(id);
  assert.equal(after.available && after.files.length, 0, "撤完了，列表空了");

  // 找回：回滚到撤销前现场——撤销自己的改动记在这个对话名下，不被当成外部改动拦下
  assert.deepEqual(await rollbackSession(id, done.undo!.n), { ok: true });
  assert.equal(fs.readFileSync(notes, "utf8"), "agent wrote this\n人又补了一行\n");
  assert.equal(fs.readFileSync(made, "utf8"), "new file\n");
});

test("U10: 有会话在跑时不撤（工作区可能是共用的）", async (t) => {
  process.env.SESSIONS_DIR = temp("dimensio-u10-state-");
  const ws = temp("dimensio-u10-ws-");
  let entered!: () => void;
  const inTool = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Slow", description: "slow", parameters: { type: "object", properties: {} } },
    async run(_args, ctx) {
      fs.writeFileSync(path.join(ctx.sandbox.root, "a.txt"), "x\n");
      entered();
      await gate;
      return ok("done", "done");
    },
  };
  const adapter = scripted(t).next(calls(call("s1", "Slow", {})), say("好了")).always(say("好了"));
  const session = attachSession(adapter, ws, { tools: [slow] });
  const run = startRun(session, "慢慢来");
  assert.ok(run.started);
  await inTool;
  try {
    const view = await sessionReview(session.id);
    assert.equal(view.available && view.busy, true, "在跑：撤销按钮先灰着");
    const r = await restoreSessionFiles(session.id, ["a.txt"]);
    assert.equal(r.code, "running");
    assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "x\n");
  } finally {
    release();
    await run.done;
  }
});
