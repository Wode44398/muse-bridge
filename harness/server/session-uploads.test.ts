// U4（K08、N42、#16）：附件归会话。
//
// 修前：粘贴 / 拖拽 / 上传一律落进用户项目的 uploads/（还是全局工作区的，不一定是会话的）——成了项目里的未跟踪文件，
// 出现在审阅面板、被影子检查点快照、可能被 agent 的 git add -A 一并提交；同名互相覆盖；从不回收。
// 修后：落在会话工作区的 .dimensio/uploads/<会话 id 或草稿 id>/，目录里的 .gitignore 让 git 看不见它；同名加序号；影子检查点
// 排除；删会话时连同它引用的附件目录一起删。老路径 uploads/… 的语义不变。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { rollbackPlan, takeCheckpoint } from "./checkpoints.ts";
import { deleteUploadDirs, saveUpload, uploadKeyOf } from "./files.ts";
import { Sandbox } from "./sandbox.ts";
import { deleteSession } from "./session.ts";
import { saveSession, type PersistedSession } from "./store.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function workspace(git = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u4-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  if (git) {
    const g = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  return root;
}
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("U4 会话附件目录：git 看不见（目录里的 .gitignore）、同名不覆盖（加序号）；老的 uploads/ 语义不变", async () => {
  const root = workspace(true);
  const sandbox = new Sandbox(root);
  const first = await saveUpload(sandbox, ".dimensio/uploads/sess-abc123/shot.png", png);
  const second = await saveUpload(sandbox, ".dimensio/uploads/sess-abc123/shot.png", png);
  assert.equal(first.path.replace(/\\/g, "/"), ".dimensio/uploads/sess-abc123/shot.png");
  assert.equal(second.path.replace(/\\/g, "/"), ".dimensio/uploads/sess-abc123/shot-1.png", "同名不覆盖");
  assert.equal(fs.readFileSync(path.join(root, ".dimensio", "uploads", ".gitignore"), "utf8").trim().split("\n").at(-1), "*");
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout;
  assert.equal(status.trim(), "", `附件不该出现在用户仓库的未跟踪文件里：\n${status}`);

  // 老客户端照旧往 uploads/ 传：落在原处、同名覆盖（语义不变）
  await saveUpload(sandbox, "uploads/old.png", png);
  const again = await saveUpload(sandbox, "uploads/old.png", Buffer.from("new"));
  assert.equal(again.path.replace(/\\/g, "/"), "uploads/old.png");
  assert.equal(fs.readFileSync(path.join(root, "uploads", "old.png"), "utf8"), "new");

  assert.equal(uploadKeyOf(".dimensio/uploads/sess-abc123/a/b.png"), "sess-abc123");
  assert.equal(uploadKeyOf(".dimensio\\uploads\\dabc12345\\x.png"), "dabc12345");
  assert.equal(uploadKeyOf("uploads/x.png"), null);
  assert.equal(uploadKeyOf(".dimensio/uploads/../x/y.png"), null);
});

test("U4 影子检查点不收会话附件：回滚计划里没有它（回滚也不会动它）", async () => {
  const root = workspace();
  const id = "u4-checkpoint-session";
  const rec: PersistedSession = {
    v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" },
    system: "s", messages: [], todos: [], totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] }, counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
  const cp = await takeCheckpoint(rec, root, "msg1");
  assert.ok(cp);
  await saveUpload(new Sandbox(root), `.dimensio/uploads/${id}/later.png`, png);
  fs.writeFileSync(path.join(root, "app.ts"), "export const x = 2;\n");
  const plan = await rollbackPlan(id, cp.n, root);
  assert.deepEqual(plan.changes.map((p) => p.replace(/\\/g, "/")), ["app.ts"], "附件不在检查点里");
});

test("U4 删会话连同它的附件目录一起删：会话 id 目录 + 转录里引用到的草稿 id 目录；别的会话的不动", async () => {
  const root = workspace();
  const id = "u4-delete-session";
  const draft = "dk3v9abcd01";
  const sandbox = new Sandbox(root);
  await saveUpload(sandbox, `.dimensio/uploads/${draft}/first.png`, png); // 新对话第一条消息的附件（那时还没有会话 id）
  await saveUpload(sandbox, `.dimensio/uploads/${id}/second.png`, png);
  await saveUpload(sandbox, ".dimensio/uploads/other-session-9/keep.png", png);
  await saveSession({
    v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" },
    system: "s",
    messages: [{ role: "user", content: [{ t: "text", text: "看图" }], attachments: [{ path: `.dimensio/uploads/${draft}/first.png`, kind: "image" }] }],
    todos: [], totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] }, counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  });
  const r = await deleteSession(id);
  assert.equal(r.deleted, true);
  const exists = (key: string) => fs.existsSync(path.join(root, ".dimensio", "uploads", key));
  assert.equal(exists(draft), false, "第一条消息的附件（草稿 id 目录）要删");
  assert.equal(exists(id), false, "会话自己的附件目录要删");
  assert.equal(exists("other-session-9"), true, "别的会话的不许动");
  // 只认 <ws>/.dimensio/uploads/<合法 key>/
  assert.equal(await deleteUploadDirs(root, ["../..", "other-session-9/../../x", ""]), 0);
  assert.equal(exists("other-session-9"), true);
});
