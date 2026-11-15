// 协调者的只读命令判法（tools/readonly-shell.ts，用例抄自 bridge 的 src/runtime/readonly-shell.test.mjs）与协调者的 Bash 工具
//（tools/project.ts coordinatorBashTool）：拦下的不执行、不弹卡；放行的按 read 判，计划 / 只读档也能跑，用户的 deny 规则照样管。
import assert from "node:assert/strict";
import test from "node:test";
import { readonlyCommandVerdict as v, shellWords } from "./tools/readonly-shell.ts";
import { coordinatorBashTool } from "./tools/project.ts";
import { decide } from "./agent/permissions.ts";
import { Sandbox } from "./sandbox.ts";
import type { Tool, ToolContext } from "./tools/types.ts";
import os from "node:os";

const ok = (c: string) => {
  const r = v(c);
  assert.equal(r.ok, true, `${c} 应放行：${r.ok ? "" : r.reason}`);
  return r.ok ? r.command : "";
};
const no = (c: string, re?: RegExp) => {
  const r = v(c);
  assert.equal(r.ok, false, `${c} 应拦下`);
  if (re && !r.ok) assert.match(r.reason, re);
};

test("拆词：成对引号、引号里的空格；引号外的控制符和通配一律拒", () => {
  assert.deepEqual(shellWords(`git log --grep="fix(api) x" -- 'src/*.mjs'`).words, ["git", "log", "--grep=fix(api) x", "--", "src/*.mjs"]);
  assert.match(shellWords('git log "a').error ?? "", /双引号/);
  assert.match(shellWords('git log "$HOME"').error ?? "", /双引号里/);
  assert.match(shellWords("git status\nrm -rf x").error ?? "", /换行/);
});

test("git 只读查询放行，并补上 --no-optional-locks", () => {
  assert.equal(ok("git status"), "git --no-optional-locks status");
  assert.equal(ok("git --no-optional-locks status -s"), "git --no-optional-locks status -s");
  ok("git log --oneline -20 main..claude/foo-1a2b");
  ok("git diff main...claude/foo-1a2b --stat");
  ok("git -C C:/Users/x/repo/.claude/worktrees/foo diff");
  ok("git -C 'C:\\Users\\x\\repo' status");
  ok("git show HEAD~1 --stat");
  ok("git branch -a -vv");
  ok("git branch --merged main");
  ok("git branch --list 'claude/*'");
  ok("git tag -l");
  ok("git stash list");
  ok("git worktree list");
  ok("git remote -v");
  ok("git rev-parse --abbrev-ref HEAD");
  ok("git log --format=%h%x09%s -5");
});

test("git 有写副作用的一律拦", () => {
  no("git commit -m x", /不是只读/);
  no("git push origin main", /不是只读/);
  no("git checkout main", /不是只读/);
  no("git branch new-feature", /新建/);
  no("git branch -D old", /改动分支/);
  no("git tag v1.0", /新建/);
  no("git stash", /stash 只放行/);
  no("git stash pop", /stash 只放行/);
  no("git worktree add ../x", /worktree 只放行/);
  no("git remote add up https://x", /remote 只放行/);
  no("git reflog expire --all", /reflog/);
  no("git diff --output=x.patch", /写文件/);
  no("git grep -O foo", /拉起/);
  no("git -c core.pager=evil log", /全局选项/);
  no("git --exec-path=/x log", /全局选项/);
});

test("串联、管道、重定向、替换、通配、别的程序都拦", () => {
  no("git status; rm -rf .", /「;」/);
  no("git status && npm test", /「&」/);
  no("git log | head", /「\|」/);
  no("git diff > out.patch", /「>」/);
  no("git log $(whoami)", /「\$」/);
  no("git log `whoami`", /「`」/);
  no("git diff *", /「\*」/);
  no("npm test", /只放行 git \/ gh/);
  no("GIT_DIR=x git status", /只放行/);
  no("ls -la", /只放行/);
  no("git status # 注释", /「#」/);
  no("", /空的/);
});

test("gh 只认查看类", () => {
  ok("gh pr view 12 --json state,mergeable");
  ok("gh pr checks 12");
  ok("gh pr diff 12");
  ok("gh run view 123 --log-failed");
  ok("gh pr list --state open");
  no("gh pr merge 12", /不是查看类/);
  no("gh pr create --fill", /不是查看类/);
  no("gh api repos/x/y/pulls -X POST", /不放行/);
  no("gh pr view 12 --web", /浏览器/);
  no("gh pr checks 12 --watch", /挂着/);
  no("gh auth token", /不放行/);
  no("gh constructor", /不放行/); // 原型链上的名字不算白名单
});

test("协调者的 Bash：拦下的在弹卡前就否决、run 也不执行；放行的按 read 判（计划档也能跑），deny 规则照样管", async () => {
  const ctx = { sandbox: new Sandbox(os.tmpdir()), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false } as ToolContext;
  const veto = await coordinatorBashTool.prepare!({ command: "npm test" }, ctx);
  assert.match(veto?.veto?.content ?? "", /Not run: 只放行 git \/ gh[\s\S]*read-only git \/ gh queries/);
  const ran = await coordinatorBashTool.run({ command: "echo hi > x.txt" }, ctx);
  assert.equal(ran.ok, false);
  assert.match(ran.content.map((b) => (b.t === "text" ? b.text : "")).join(""), /Not run: 引号外不能有「>」/);
  // 权限判定：只读查询在计划档、只读档也放行（不弹卡）；用户写的 deny 规则仍然拦得住
  const tools = new Map<string, Tool>([["Bash", coordinatorBashTool]]);
  assert.equal(decide("plan", "Bash", tools, { command: "git log --oneline -5" }).effect, "allow");
  assert.equal(decide("read-only", "Bash", tools, { command: "gh pr checks 12" }).effect, "allow");
  assert.equal(decide("auto", "Bash", tools, { command: "git status" }, { allow: [], ask: [], deny: ["Bash(git log:*)"] }).effect, "allow");
  assert.equal(decide("auto", "Bash", tools, { command: "git log -3" }, { allow: [], ask: [], deny: ["Bash(git log:*)"] }).effect, "deny");
  // 说明与参数：没有后台 / 轮询那一套
  assert.deepEqual(Object.keys(coordinatorBashTool.def.parameters.properties).sort(), ["command", "timeout"]);
});
