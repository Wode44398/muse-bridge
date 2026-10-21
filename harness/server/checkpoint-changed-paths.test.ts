// changedPathsSince 的 skipNestedRepos：工作区里 git clone 下来的仓库，影子 git 的 `add -A` 只记成一个 gitlink
// （模式 160000、路径就是目录名、没有后缀），验证门禁曾把它当成「改了代码」，撤回了只读分析的整份答复
// （分析刚 clone 下来的仓库时）。门禁那条路径跳过它；回退提示那条照旧列出。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { changedPathsSince, rollbackTo, takeCheckpoint } from "./checkpoints.ts";
import type { PersistedSession } from "./store.ts";

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

function record(id: string, workspace: string): PersistedSession {
  return {
    v: 1,
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: id,
    config: { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace, access: "workspace" },
    system: "test",
    messages: [],
    todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

test("门禁视角跳过新克隆的嵌套仓库，真改的文件照旧算；回退视角两样都列", async () => {
  const work = temp("dimensio-cpchg-work-");
  process.env.SESSIONS_DIR = temp("dimensio-cpchg-state-");
  fs.writeFileSync(path.join(work, "notes.txt"), "v0", "utf8");
  const cp = await takeCheckpoint(record("s1", work), work, "turn start");
  assert.ok(cp);

  // 这一轮里：克隆（这里用 init + 一次提交模拟）一个第三方仓库，再真改一个代码文件
  const repo = path.join(work, "strata-repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, "main.cpp"), "int main(){}", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  fs.writeFileSync(path.join(work, "app.ts"), "export {}", "utf8");

  const gate = await changedPathsSince(cp.tree, work, { skipNestedRepos: true });
  assert.deepEqual(gate.sort(), ["app.ts"]);

  const all = await changedPathsSince(cp.tree, work);
  assert.deepEqual(all.sort(), ["app.ts", "strata-repo"]);
});

// 多人模式的租户：工作区是用户主目录，dimensio 数据在它下面的 .bridge/dimensio。以前影子仓库连自己（shadow.git 对象、
// 检查点记录）带 bridge 的 Claude 会话一起拍进快照，门禁每轮都当成「改了代码」、空工作区里永远消不掉。
test("数据目录在工作区里：不进快照、不算改动，回滚也不碰它们", async () => {
  const work = temp("dimensio-cpchg-home-");
  const sessions = path.join(work, ".bridge", "dimensio", "sessions");
  process.env.SESSIONS_DIR = sessions;
  fs.mkdirSync(path.join(work, ".bridge", "claude"), { recursive: true });
  fs.writeFileSync(path.join(work, ".bridge", "claude", "a.jsonl"), "v0", "utf8");
  const cp = await takeCheckpoint(record("s2", work), work, "turn start");
  assert.ok(cp);

  // 这一轮只闲聊：dimensio 写自己的东西、bridge 写 Claude 会话
  fs.writeFileSync(path.join(sessions, "s2.json"), "{}", "utf8");
  fs.writeFileSync(path.join(work, ".bridge", "claude", "a.jsonl"), "v1", "utf8");
  await takeCheckpoint(record("s2", work), work, "turn 2");
  assert.deepEqual(await changedPathsSince(cp.tree, work, { skipNestedRepos: true }), []);

  // 真改一个文件再回滚：文件退回，数据原样
  fs.writeFileSync(path.join(work, "app.ts"), "export {}", "utf8");
  assert.deepEqual(await changedPathsSince(cp.tree, work), ["app.ts"]);
  await rollbackTo("s2", cp.n, work);
  assert.equal(fs.existsSync(path.join(work, "app.ts")), false);
  assert.equal(fs.readFileSync(path.join(work, ".bridge", "claude", "a.jsonl"), "utf8"), "v1");
  assert.ok(fs.existsSync(path.join(sessions, "shadow.git", "HEAD")));
});

test("数据目录不叫 .bridge 也按它在工作区里的位置排除", async () => {
  const work = temp("dimensio-cpchg-nested-");
  process.env.SESSIONS_DIR = path.join(work, "data", "sessions");
  fs.writeFileSync(path.join(work, "notes.txt"), "v0", "utf8");
  const cp = await takeCheckpoint(record("s3", work), work, "turn start");
  assert.ok(cp);
  await takeCheckpoint(record("s3", work), work, "turn 2");
  assert.deepEqual(await changedPathsSince(cp.tree, work, { skipNestedRepos: true }), []);
});

test("旧版本拍进快照的数据目录不算改动", async () => {
  const work = temp("dimensio-cpchg-legacy-");
  const sessions = path.join(work, ".bridge", "dimensio", "sessions");
  process.env.SESSIONS_DIR = sessions;
  fs.mkdirSync(path.join(work, ".bridge", "claude"), { recursive: true });
  fs.writeFileSync(path.join(work, ".bridge", "claude", "a.jsonl"), "v0", "utf8");
  fs.writeFileSync(path.join(work, "notes.txt"), "v0", "utf8");
  assert.ok(await takeCheckpoint(record("s4", work), work, "init")); // 建好影子仓库
  // 模拟旧版本：强行把数据目录拍进一棵树
  const env = { ...process.env, GIT_DIR: path.join(sessions, "shadow.git"), GIT_WORK_TREE: work, GIT_INDEX_FILE: path.join(work, "..", path.basename(work) + ".idx") };
  const run = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  run("add", "-f", "notes.txt", ".bridge/claude/a.jsonl");
  const legacy = run("write-tree");
  fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  assert.deepEqual(await changedPathsSince(legacy, work, { skipNestedRepos: true }), []);
  assert.deepEqual(await changedPathsSince(legacy, work), []);
});
