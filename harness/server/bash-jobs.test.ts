// U11（MiMo、K63 部分）：会话的 Bash 后台 job 一览。
//
// 修前：job id 只在起 job 的那条工具结果里出现一次——压缩把它压掉、或者模型记岔了，就再也找不回来（poll 报不存在时列出的
// 「Known jobs」也只有 id，没有命令和状态）；界面上 job 一起来就看不见了，只能等模型自己 poll。poll 还被只读档 / 计划档拦着。
// 修后：Bash(jobs:true) 列出本会话的 job（id、状态、时长、命令，新的在前）；/api/sessions/:id/jobs 给任务面板（尾行输出、
// 服务端算好的时长），界面「停止」只认这个会话自己的、还在跑的 job；列 job 与 poll 在只读档 / 计划档也能用，kill 照旧要执行权限。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bashTool, killJobsFor, listJobs, stopJob } from "./tools/bash.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const cleanup = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 刚被杀的子进程在 Windows 上可能还占着目录 */
  }
};
function ctxFor(ownerId: string, root: string): ToolContext {
  return {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 10_000 },
    agentSeesImages: false,
    ownerId,
  };
}
const text = (r: ToolRunResult) => r.content.map((c) => (c.t === "text" ? c.text : "")).join("");
const SLEEP = process.platform === "win32" ? "ping -n 8 127.0.0.1 > NUL" : "sleep 7";
const FAKE_TOKEN = "sk-ant-FAKEFAKEFAKEFAKEFAKE00";

test("U11 Bash(jobs:true) 列出本会话的 job（状态、时长、命令，新的在前）；别的会话看不到", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-u11-"));
  const a = ctxFor("u11-session-A", root);
  const b = ctxFor("u11-session-B", root);
  try {
    const none = await bashTool.run({ jobs: true }, a);
    assert.equal(none.ok, true);
    assert.match(text(none), /No background jobs in this session/);

    const quick = await bashTool.run({ command: "exit 3", background: true }, a);
    const quickId = /job\d+(?:-[a-z0-9]+)?/.exec(text(quick))![0];
    const long = await bashTool.run({ command: SLEEP, background: true }, a);
    const longId = /job\d+(?:-[a-z0-9]+)?/.exec(text(long))![0];

    const listed = await bashTool.run({ jobs: true }, a);
    assert.equal(listed.ok, true);
    const body = text(listed);
    assert.ok(body.indexOf(longId) < body.indexOf(quickId), "新的在前");
    assert.match(body, new RegExp(`${longId} · running for \\d+s · \\$ ${SLEEP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(body, new RegExp(`${quickId} · exit 3 after \\d+s · \\$ exit 3`));
    assert.match(body, /Bash\(poll:"<id>"\)/);

    const info = listJobs("u11-session-A");
    assert.deepEqual(info.map((j) => j.id), [longId, quickId]);
    assert.equal(info[0].state, "running");
    assert.equal(info[1].state, "exited");
    assert.equal(info[1].exitCode, 3);
    assert.ok(info[1].endedAt && info[1].endedAt >= info[1].startedAt);
    assert.ok(info[0].elapsedMs >= 0 && info[1].elapsedMs >= 0);

    // 别的会话：列表是空的，也停不了 A 的 job
    assert.deepEqual(listJobs("u11-session-B"), []);
    assert.match(text(await bashTool.run({ jobs: true }, b)), /No background jobs/);
    assert.equal(stopJob("u11-session-B", longId), false);
    assert.equal(listJobs("u11-session-A")[0].state, "running");
  } finally {
    killJobsFor("u11-session-A");
    killJobsFor("u11-session-B");
    cleanup(root);
  }
});

test("U11 界面「停止」：只停自己会话里还在跑的；停完列表里是 killed，再停返回 false", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-u11-stop-"));
  const a = ctxFor("u11-stop-A", root);
  try {
    const long = await bashTool.run({ command: SLEEP, background: true }, a);
    const id = /job\d+(?:-[a-z0-9]+)?/.exec(text(long))![0];
    assert.equal(stopJob("u11-stop-A", id), true);
    const deadline = Date.now() + 5_000;
    while (listJobs("u11-stop-A")[0]?.state === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const [j] = listJobs("u11-stop-A");
    assert.equal(j.state, "killed");
    assert.ok(j.endedAt, "停了之后记下结束时刻");
    assert.equal(stopJob("u11-stop-A", id), false, "已经结束的不再报「停了」");
    assert.equal(stopJob("u11-stop-A", "job999999"), false);
    assert.match(text(await bashTool.run({ jobs: true }, a)), new RegExp(`${id} · killed after \\d+s`));
  } finally {
    killJobsFor("u11-stop-A");
    cleanup(root);
  }
});

test("U11 列表里的命令与尾行先脱敏", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-u11-redact-"));
  const a = ctxFor("u11-redact-A", root);
  try {
    await bashTool.run({ command: `echo ${FAKE_TOKEN}`, background: true }, a);
    const [j] = listJobs("u11-redact-A");
    assert.ok(!j.command.includes(FAKE_TOKEN), "命令里的令牌抹掉了");
    assert.ok(!j.tail.includes(FAKE_TOKEN), "输出里的令牌抹掉了");
    assert.match(j.command, /REDACTED/);
    assert.ok(!text(await bashTool.run({ jobs: true }, a)).includes(FAKE_TOKEN));
  } finally {
    killJobsFor("u11-redact-A");
    cleanup(root);
  }
});

test("U11 列 job、poll 不跑命令：只读档 / 计划档也能用；kill 仍是动作", () => {
  assert.deepEqual(bashTool.permissionView!({ jobs: true }), { effect: "read" });
  assert.deepEqual(bashTool.permissionView!({ poll: "job1" }), { effect: "read" });
  assert.equal(bashTool.permissionView!({ kill: "job1" }), null);
  assert.equal(bashTool.permissionView!({ jobs: true, command: "rm -rf build" })?.effect, undefined, "带了命令就按命令判");
});
