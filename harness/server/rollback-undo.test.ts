// P9（#29）：回滚本身可撤销。改写自探针 03-hermes-agent/笔记/probe-rollback-irreversible.ts。
//
// 修前：回滚前不给当前状态拍快照，还直接覆盖会话文件——第二轮写入的内容在影子仓库里查不到，对话只剩
// 回滚点之前那几条，手机上误触一次回滚就回不来。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { listCheckpoints, takeCheckpoint } from "./checkpoints.ts";
import { PRE_ROLLBACK_LABEL, rollbackSession } from "./session.ts";
import { loadSession, saveSession, type PersistedSession } from "./store.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

test("回滚前先拍「回滚前现场」：回滚到它就把第二轮的文件与整段对话都找回来", async () => {
  process.env.SESSIONS_DIR = temp("dimensio-p9-state-");
  const ws = temp("dimensio-p9-ws-");
  const id = "p9-rollback";
  const rec = (msgs: string[]): PersistedSession => ({
    v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" },
    system: "s",
    messages: msgs.map((text, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ t: "text", text }] })),
    todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  });
  const a = path.join(ws, "a.txt");

  fs.writeFileSync(a, "v0\n");
  await takeCheckpoint(rec([]), ws, "msg1"); // 检查点 1：消息 1 之前
  fs.writeFileSync(a, "v1-run1\n");
  fs.writeFileSync(path.join(ws, "b.txt"), "created-by-run1\n");
  await takeCheckpoint(rec(["msg1", "done1"]), ws, "msg2"); // 检查点 2：消息 2 之前
  fs.writeFileSync(a, "v2-run2\n"); // 第二轮的改动，之后没有检查点
  await saveSession(rec(["msg1", "done1", "msg2", "done2 (run2 transcript)"]));

  const r = await rollbackSession(id, 2); // 手机上点「回滚到消息 2 之前」
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.readFileSync(a, "utf8"), "v1-run1\n");
  assert.equal((await loadSession(id))?.messages.length, 2);

  const cps = await listCheckpoints(id);
  assert.equal(cps.length, 3, "多出一个回滚前现场");
  const undo = cps.at(-1)!;
  assert.equal(undo.label, PRE_ROLLBACK_LABEL.slice(0, 60));

  // 反悔：回滚到回滚前现场
  assert.deepEqual(await rollbackSession(id, undo.n), { ok: true });
  assert.equal(fs.readFileSync(a, "utf8"), "v2-run2\n", "第二轮的文件改动回来了");
  const back = await loadSession(id);
  assert.equal(back?.messages.length, 4, "整段对话回来了");
  assert.match(JSON.stringify(back), /run2 transcript/);
});
