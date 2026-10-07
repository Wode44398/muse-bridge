// changedPathsSince 的 skipNestedRepos：工作区里 git clone 下来的仓库，影子 git 的 `add -A` 只记成一个 gitlink
// （模式 160000、路径就是目录名、没有后缀），验证门禁曾把它当成「改了代码」，撤回了只读分析的整份答复
// （分析刚 clone 下来的仓库时）。门禁那条路径跳过它；回退提示那条照旧列出。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { changedPathsSince, takeCheckpoint } from "./checkpoints.ts";
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
