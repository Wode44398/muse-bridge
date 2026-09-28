// S7（#55）：辅助进程 env 收紧 + git 消毒 + 受保护元数据扩围。
//
// 修前：审阅面板的 git status/diff 会执行工作区仓库 config 里的 core.fsmonitor 命令；检查点的
// update-ref 会跑 shadow.git/hooks 里的 reference-transaction；这些 git 还继承完整 process.env
// （全部 provider key）。`.git` 写保护只认名字恰好是 `.git` 的段，sessions/shadow.git 与会话记录
// 在整机模式下 Write/Bash 都能改。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { helperEnv } from "./helper-proc.ts";
import { reviewDiff, reviewOverview } from "./review.ts";
import { checkpointDiff, takeCheckpoint } from "./checkpoints.ts";
import { Sandbox } from "./sandbox.ts";
import { commandScopeViolation } from "./tools/bash.ts";
import type { PersistedSession } from "./store.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const SAVED = ["SESSIONS_DIR", "BRIDGE_DESKTOP_HOST_FILE", "BRIDGE_DESKTOP_BROKER", "S7_FAKE_API_KEY", "S7_FAKE_TOKEN"];
const base = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of SAVED) {
    if (base[k] === undefined) delete process.env[k];
    else process.env[k] = base[k];
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const fwd = (p: string) => p.split(path.sep).join("/");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// 被配置成 fsmonitor / hook 的「命令」：跑了就留下标记文件。
function markerCommand(dir: string): { marker: string; command: string } {
  const marker = path.join(dir, "ran.txt");
  const script = path.join(dir, "mark.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nprocess.exit(1);\n`);
  return { marker, command: `"${fwd(process.execPath)}" "${fwd(script)}"` };
}

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

test("辅助进程的 env 不带凭据：provider key、令牌、桌面壳 broker 地址删掉，真实 HOME/PATH 保留", () => {
  process.env.S7_FAKE_API_KEY = "FAKE-provider-key";
  process.env.S7_FAKE_TOKEN = "DUMMY-token";
  process.env.BRIDGE_DESKTOP_BROKER = "http://127.0.0.1:9/FAKE-broker-secret";
  const env = helperEnv({ EXTRA: "1" });
  assert.equal(env.S7_FAKE_API_KEY, undefined);
  assert.equal(env.S7_FAKE_TOKEN, undefined);
  assert.equal(env.BRIDGE_DESKTOP_BROKER, undefined);
  assert.equal(env.EXTRA, "1");
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH")!;
  assert.equal(env[pathKey], process.env[pathKey]);
  const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  assert.equal(env[homeKey], process.env[homeKey], "真实家目录保留（影子仓库要读用户级 git 配置）");
});

test("审阅面板的 git 不执行工作区仓库 config 里配的 fsmonitor 命令，概览与 diff 照常", async () => {
  const ws = temp("dimensio-s7-review-");
  const side = temp("dimensio-s7-mark-");
  git(ws, "init", "-q");
  git(ws, "config", "user.name", "t");
  git(ws, "config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(ws, "a.txt"), "one\n");
  git(ws, "add", "a.txt");
  git(ws, "commit", "-qm", "init");
  const { marker, command } = markerCommand(side);
  git(ws, "config", "core.fsmonitor", command);
  fs.writeFileSync(path.join(ws, "a.txt"), "two\n");
  fs.writeFileSync(path.join(ws, "b.txt"), "new\n");

  const overview = await reviewOverview(ws);
  assert.equal(overview.git, true);
  assert.deepEqual(overview.files?.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
  const diff = await reviewDiff(ws, "a.txt", "", false);
  assert.ok(diff.ok && /\+two/.test(diff.diff), "diff 照常出来");
  assert.equal(fs.existsSync(marker), false, "仓库里配的 fsmonitor 命令被执行了");
});

test("检查点影子仓库的 git 不跑 shadow.git/hooks，也不调 fsmonitor；快照与 diff 照常", async () => {
  const work = temp("dimensio-s7-cp-work-");
  const sessions = temp("dimensio-s7-cp-state-");
  const side = temp("dimensio-s7-cp-mark-");
  process.env.SESSIONS_DIR = sessions;
  fs.writeFileSync(path.join(work, "a.txt"), "v1\n");
  const first = await takeCheckpoint(record("s7cp", work), work, "turn 1");
  assert.ok(first, "第一个检查点");

  const shadow = path.join(sessions, "shadow.git");
  const hookMarker = path.join(side, "hook-ran.txt");
  fs.writeFileSync(path.join(shadow, "hooks", "reference-transaction"), `#!/bin/sh\necho ran > "${fwd(hookMarker)}"\n`);
  const { marker, command } = markerCommand(side);
  git(sessions, `--git-dir=${shadow}`, `--work-tree=${sessions}`, "config", "core.fsmonitor", command);

  fs.writeFileSync(path.join(work, "a.txt"), "v2\n");
  const second = await takeCheckpoint(record("s7cp", work), work, "turn 2");
  assert.ok(second && second.hash !== first.hash, "第二个检查点照常提交");
  const diff = await checkpointDiff("s7cp", 1, work);
  assert.match(diff, /a\.txt/);
  assert.equal(fs.existsSync(hookMarker), false, "shadow.git/hooks 里的 hook 被执行了");
  assert.equal(fs.existsSync(marker), false, "影子仓库 config 里的 fsmonitor 被执行了");
});

test("Write/Edit：会话目录、影子仓库、*.git 段、桌面宿主描述任何模式都拒写；读会话目录照常", () => {
  const sessions = temp("dimensio-s7-state-");
  const ws = temp("dimensio-s7-ws-");
  const hostFile = path.join(temp("dimensio-s7-host-"), "desktop-host.json");
  fs.writeFileSync(hostFile, JSON.stringify({ cdpPort: 9, brokerUrl: "http://127.0.0.1:9/FAKE" }));
  process.env.SESSIONS_DIR = sessions;
  process.env.BRIDGE_DESKTOP_HOST_FILE = hostFile;
  const full = new Sandbox(ws, "full");
  for (const target of [
    path.join(sessions, "shadow.git", "config"),
    path.join(sessions, "shadow.git", "hooks", "reference-transaction"),
    path.join(sessions, "some-session.json"),
    path.join(sessions, "workflows", "wf.jsonl"),
    hostFile,
  ]) {
    assert.throws(() => full.resolve(target, { forWrite: true }), /session store|desktop host|protected/, target);
  }
  const sessionFile = path.join(sessions, "some-session.json");
  assert.equal(full.resolve(sessionFile), sessionFile, "读会话目录照常");
  assert.throws(() => full.resolve(hostFile), /secret guard/, "宿主描述里带 broker 的 secret，读也拒");

  const inWs = new Sandbox(ws, "workspace");
  assert.throws(() => inWs.resolve("mirror.git/config", { forWrite: true }), /protected/);
  assert.throws(() => inWs.resolve(".git/hooks/pre-commit", { forWrite: true }), /protected/);
  for (const fine of [".github/workflows/ci.yml", ".gitignore", ".gitattributes", "docs/git.md", "src/digit/x.ts"]) {
    assert.doesNotThrow(() => inWs.resolve(fine, { forWrite: true }), fine);
  }
});

test("Bash：非只读命令点名会话目录（含重定向目标、--git-dir=）一律拒，两种模式；纯读放行", () => {
  // 工作区就是 harness 目录的情形：sessions 在工作区里面，用相对路径。
  const root = temp("dimensio-s7-harness-");
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(path.join(sessions, "shadow.git"), { recursive: true });
  process.env.SESSIONS_DIR = sessions;
  const hostFile = path.join(temp("dimensio-s7-host-"), "desktop-host.json");
  fs.writeFileSync(hostFile, "{}");
  process.env.BRIDGE_DESKTOP_HOST_FILE = hostFile;
  for (const access of ["workspace", "full"] as const) {
    for (const cmd of [
      "rm -rf sessions",
      "echo x > sessions/shadow.git/config",
      "cd sessions && rm -rf shadow.git",
      `git --git-dir=${fwd(path.join(sessions, "shadow.git"))} config core.fsmonitor x`,
      `GIT_DIR=${fwd(path.join(sessions, "shadow.git"))} git config core.hooksPath x`,
    ]) {
      assert.match(commandScopeViolation(cmd, root, access) ?? "", /session store/, `${access}: ${cmd}`);
    }
    for (const cmd of ["ls sessions", "cat sessions/x.json | head", "grep -r abc sessions", "npm test", "git status"]) {
      assert.equal(commandScopeViolation(cmd, root, access), null, `${access}: ${cmd}`);
    }
  }
  // 整机模式，另一个工作区用绝对路径
  const other = temp("dimensio-s7-other-");
  assert.match(commandScopeViolation(`rm -rf "${sessions}"`, other, "full") ?? "", /session store/);
  assert.match(commandScopeViolation(`cat "${hostFile}"`, other, "full") ?? "", /secret guard/);
});
