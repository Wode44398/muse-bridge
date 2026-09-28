// O6（K63，后台化第 0 期速赢）：Bash(wait)、重启失联提醒、压缩后在跑的 job 提醒。
//
// 修前：等一个后台 job 只能一遍遍 poll（或者 sleep 再 poll），每次一轮往返；job id 是进程内计数 job3——harness 重启后又
// 从 job1 编起，拿重启前的 id 去 poll 要么读到别的 job 的输出，要么只得到一句「没有这个 job」；压缩摘要的锚点收不到
// job id，压完模型就不知道自己有什么在跑。
// 修后：Bash(wait:"<id>") 等到跑完（或时限、或这一轮被停止）再交回，和 poll 同样的输出；id 带启动标记（job3-k2x9），
// 不是这个进程的 id 明说「重启丢了」；压缩摘要末尾列出还在跑的 job。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bashTool, killJobsFor, runningJobsSummary } from "./tools/bash.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const cleanup = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 刚被杀的子进程在 Windows 上可能还占着目录 */
  }
};
function ctxFor(ownerId: string, root: string, signal?: AbortSignal): ToolContext {
  return {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 20_000 },
    agentSeesImages: false,
    ownerId,
    signal,
  };
}
const text = (r: ToolRunResult) => r.content.map((c) => (c.t === "text" ? c.text : "")).join("");
const after = (ms: number, out: string) => `node -e "setTimeout(() => console.log('${out}'), ${ms})"`;
const jobId = (r: ToolRunResult) => /job\d+-[a-z0-9]+/.exec(text(r))?.[0] ?? "";

test("O6 Bash(wait) 等到 job 跑完再交回（和 poll 同样的输出），不用一遍遍 poll", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-o6-"));
  const ctx = ctxFor("o6-wait", root);
  try {
    const started = await bashTool.run({ command: after(2500, "done-waiting"), background: true }, ctx);
    const id = jobId(started);
    assert.ok(id, `拿到带启动标记的 id：${text(started)}`);
    const t0 = Date.now();
    const waited = await bashTool.run({ wait: id }, ctx);
    assert.equal(waited.ok, true, text(waited));
    assert.match(text(waited), /\[exit 0\]/);
    assert.match(text(waited), /done-waiting/);
    assert.ok(Date.now() - t0 >= 800, "真的等了");
    assert.deepEqual(bashTool.permissionView!({ wait: id }), { effect: "read" }, "等待不跑命令，按只读判");
  } finally {
    killJobsFor("o6-wait");
    cleanup(root);
  }
});

test("O6 wait 等到时限还没完：照实说还在跑；这一轮被停止就不等了", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-o6b-"));
  const ctl = new AbortController();
  const ctx = ctxFor("o6-timeout", root, ctl.signal);
  try {
    const id = jobId(await bashTool.run({ command: after(15_000, "late"), background: true }, ctx));
    const short = await bashTool.run({ wait: id, timeout: 800 }, ctx);
    assert.match(text(short), /still running after waiting \d+s/);
    setTimeout(() => ctl.abort(), 300);
    const t0 = Date.now();
    const stopped = await bashTool.run({ wait: id, timeout: 15_000 }, ctx);
    assert.ok(Date.now() - t0 < 5_000, "被停止之后没有干等到时限");
    assert.match(text(stopped), /still running/);
  } finally {
    killJobsFor("o6-timeout");
    cleanup(root);
  }
});

test("O6 重启前的 job id：明说是重启丢的；不带标记的旧写法照样认本进程的 job", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-o6c-"));
  const ctx = ctxFor("o6-restart", root);
  try {
    const lost = await bashTool.run({ poll: "job7-zzzz" }, ctx);
    assert.equal(lost.ok, false);
    assert.match(text(lost), /do not survive a harness restart/);
    const id = jobId(await bashTool.run({ command: after(4000, "x"), background: true }, ctx));
    const bare = id.replace(/-[a-z0-9]+$/, "");
    const polled = await bashTool.run({ poll: bare }, ctx);
    assert.equal(polled.ok, true, "job3 按本进程的第 3 个认");
    assert.match(text(polled), /running for/);
  } finally {
    killJobsFor("o6-restart");
    cleanup(root);
  }
});

test("O6 压缩后提醒用的「还在跑的 job」：只列这个会话、还在跑的，带命令", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-o6d-"));
  const a = ctxFor("o6-running-A", root);
  const b = ctxFor("o6-running-B", root);
  try {
    assert.equal(runningJobsSummary("o6-running-A"), "");
    const id = jobId(await bashTool.run({ command: after(6000, "slow"), background: true }, a));
    await bashTool.run({ command: after(6000, "other"), background: true }, b);
    const summary = runningJobsSummary("o6-running-A");
    assert.match(summary, new RegExp(`^${id} \\(\\$ node -e`));
    assert.doesNotMatch(summary, /other/, "别的会话的不列");
  } finally {
    killJobsFor("o6-running-A");
    killJobsFor("o6-running-B");
    cleanup(root);
  }
});
