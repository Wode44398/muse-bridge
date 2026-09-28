// P9（三）N26（HT3）：破坏性命令前的轮内快照。
//
// 修前：唯一能退的点是这一轮开跑之前——长任务中途一条 `git checkout -- .`、`git reset --hard`、`rm -rf src`，
// 抹掉的是这一轮前面的全部改动，回滚也找不回来。
// 修后：这种命令跑之前（这个 agent 上一张之后写过东西时）给工作区拍一张只有文件的快照；回滚到它只还原文件、对话不动。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { listCheckpoints } from "./checkpoints.ts";
import { createSession, dropSession, rollbackSession, startRun } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { loadSession } from "./store.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { bashTool } from "./tools/bash.ts";
import { destructiveView } from "./tools/shell-policy.ts";
import { parseShell, type ShellDialect } from "./tools/shell-words.ts";

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

test("N26: 认得出删文件、丢弃 git 工作区改动的命令；切分支、只读、干跑不算", () => {
  const view = (cmd: string, dialect: ShellDialect = "bash") => destructiveView(parseShell(cmd, dialect), cmd);
  const destroys: [string, ShellDialect?][] = [
    ["rm a.txt"],
    ["rm -rf src"],
    ["sudo rm -rf build"],
    ["bash -c 'rm -rf dist'"],
    ["npm test && rm -rf coverage"],
    ["find . -name '*.tmp' -delete"],
    ["find . -name '*.log' -exec rm {} +"],
    ["git reset --hard"],
    ["git reset --hard HEAD~1"],
    ["git checkout -- ."],
    ["git checkout ."],
    ["git checkout HEAD src/app.ts"],
    ["git checkout -f main"],
    ["git -C sub checkout -- ."],
    ["git restore src/app.ts"],
    ["git restore --staged --worktree a.ts"],
    ["git clean -fd"],
    ["git clean --force -x"],
    ["git stash"],
    ["git stash push -u"],
    ["git switch --discard-changes main"],
    ["git rm old.ts"],
    ["Remove-Item -Recurse -Force build", "powershell"],
    ["del /s /q build", "cmd"],
  ];
  for (const [cmd, dialect] of destroys) assert.equal(view(cmd, dialect).destroys, true, cmd);
  const keeps = [
    "ls -la",
    "git status",
    "git checkout -b feat/x",
    "git checkout main",
    "git switch main",
    "git stash list",
    "git stash pop",
    "git clean -n",
    "git clean -nd",
    "git restore --staged a.ts",
    "git rm --cached secret.env",
    "echo rm -rf /",
    "npm run build",
    "find . -name '*.ts'",
  ];
  for (const cmd of keeps) assert.equal(view(cmd).destroys, false, cmd);

  // 只删不写（导航、只读之外全是删）：它自己不算「又写过新东西」
  assert.equal(view("rm -rf dist").onlyDestroys, true);
  assert.equal(view("cd build && rm -rf out").onlyDestroys, true);
  assert.equal(view("git checkout -- . && git status").onlyDestroys, true);
  assert.equal(view("npm run build && rm -rf tmp").onlyDestroys, false);
});

test("N26: 破坏性命令前拍一张只有文件的轮内快照；没写过新东西就不再拍；回滚到它只还原文件、对话不动", async (t) => {
  process.env.SESSIONS_DIR = temp("dimensio-n26-state-");
  const ws = temp("dimensio-n26-ws-");
  const a = path.join(ws, "a.txt");
  fs.writeFileSync(a, "v1\n");

  const adapter = scripted(t)
    .next(
      useTool("b1", "Bash", { command: "echo agent-v2 > a.txt" }),
      useTool("b2", "Bash", { command: "rm a.txt" }), // 前面写过东西 → 先拍（a.txt 还是 agent-v2）
      useTool("b3", "Bash", { command: "rm -f nothing.txt" }), // 上一张之后没写过 → 不拍
      say("清理好了"),
    )
    .always(say("好了"));
  const session = createSession();
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: [bashTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: {
      sandbox: new Sandbox(ws),
      readFileState: new Map(),
      setTodos: () => {},
      limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 },
      agentSeesImages: false,
    },
    toolMap: new Map([[bashTool.def.name, bashTool]]),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" };
  const id = session.id;
  const run = startRun(session, "把 a.txt 改了再清掉");
  await run.done;
  dropSession(id);
  assert.equal(fs.existsSync(a), false, "rm 真跑了");

  const cps = await listCheckpoints(id);
  assert.equal(cps.length, 2, "开跑检查点 + 一张轮内快照（第二条 rm 前没写过东西，不再拍）");
  const snap = cps[1];
  assert.equal(snap.kind, "files");
  assert.equal(snap.run, cps[0].n);
  assert.match(snap.label, /rm a\.txt/);

  const before = (await loadSession(id))?.messages.length;
  assert.ok(before && before > 2);
  assert.deepEqual(await rollbackSession(id, snap.n), { ok: true }, "agent 自己的改动，不必确认");
  assert.equal(fs.readFileSync(a, "utf8"), "agent-v2\n", "回到 rm 之前：这一轮写的内容找回来了（不是开跑前的 v1）");
  assert.equal((await loadSession(id))?.messages.length, before, "对话一条没动");
});
