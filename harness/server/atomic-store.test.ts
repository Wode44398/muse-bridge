// M6（#25）：统一原子写 + 事实文件损坏隔离。改写自探针 03-hermes-agent/笔记/probe-concurrent-save-real.ts。
//
// 修前：saveSession 用固定的 `${file}.tmp` 临时名、不串行、不 fsync——同一会话的两次保存重叠时互相踩，
// 实测 30 轮里会话文件消失 9 次；读不出来的会话文件（生产上 d2341d9d 是 246KB 全零）直接从列表里静默消失，
// 而检查点里有它三份完整副本。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { listSessions, loadSession, saveSession, type PersistedSession } from "./store.ts";

const roots: string[] = [];
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function sessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m6-"));
  roots.push(dir);
  process.env.SESSIONS_DIR = dir;
  return dir;
}

const rec = (id: string, text: string, title = "t"): PersistedSession => ({
  v: 1, id, createdAt: 1, updatedAt: Date.now(), title,
  config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto" },
  system: "s",
  messages: [{ role: "user", content: [{ t: "text", text }] }],
  todos: [],
  totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
  gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
  counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
});

test("同一会话的两次保存重叠：文件永远在、永远是一份完整的记录", async () => {
  const dir = sessionsDir();
  const big = "x".repeat(800_000);
  for (let i = 0; i < 30; i++) {
    const id = `m6-save-${i}`;
    await saveSession(rec(id, big));
    await Promise.all([saveSession(rec(id, big)), saveSession(rec(id, big + "y".repeat(300)))]);
    const back = await loadSession(id);
    assert.ok(back, `round ${i}: the session file vanished or is torn`);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "不留临时文件");
});

test("全零的会话文件：隔离成 .corrupt-*，从最新的检查点记录副本恢复", async () => {
  const dir = sessionsDir();
  const id = "d2341d9d-like";
  fs.mkdirSync(path.join(dir, "checkpoints"));
  fs.writeFileSync(path.join(dir, "checkpoints", `${id}.1.json`), JSON.stringify(rec(id, "older", "旧标题")));
  fs.writeFileSync(path.join(dir, "checkpoints", `${id}.3.json`), JSON.stringify(rec(id, "newest copy", "旧标题")));
  fs.writeFileSync(path.join(dir, `${id}.json`), Buffer.alloc(4096)); // 246KB 全零的缩小版

  const listed = await listSessions();
  const item = listed.find((m) => m.id === id);
  assert.ok(item, "不再从列表里消失");
  assert.match(item.title, /^\[已从检查点恢复\] 旧标题/);
  const back = await loadSession(id);
  assert.equal(back?.messages[0].content[0].t === "text" && back.messages[0].content[0].text, "newest copy", "用的是最新一份副本");
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.json.corrupt-`)).length, 1, "坏文件原样隔离留证");
});

test("坏了又没有副本：只隔离，列表里每次都留一条「已损坏」", async () => {
  const dir = sessionsDir();
  const id = "hopeless";
  fs.writeFileSync(path.join(dir, `${id}.json`), "{ not json");
  await saveSession(rec("fine", "ok"));

  for (let pass = 0; pass < 2; pass++) {
    const listed = await listSessions();
    const stub = listed.find((m) => m.id === id);
    assert.ok(stub?.corrupt, `pass ${pass}: 损坏条目看得见`);
    assert.match(stub.title, /会话文件已损坏/);
    assert.ok(listed.find((m) => m.id === "fine" && !m.corrupt), "别的会话照常");
  }
  assert.equal(await loadSession(id), null);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.json.corrupt-`)).length, 1);
});
