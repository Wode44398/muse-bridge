// R14（一）：Bash 长命令——前台到点不杀、转后台（交回已有输出与 job id）；要的时限超过前台上限直接后台跑；界面「转后台」按到
// 正在跑的那次调用；子进程环境驯服交互式工具（分页器不开、不输出颜色）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Sandbox } from "./sandbox.ts";
import { bashTool, childEnv, killJobsFor, moveForegroundToBackground } from "./tools/bash.ts";
import type { ToolContext } from "./tools/types.ts";

const textOf = (r: { content?: { t: string; text?: string }[] }) => (r.content ?? []).map((b) => b.text ?? "").join("");

function ctxFor(t: test.TestContext, owner: string, extra: Partial<ToolContext> = {}): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r14-"));
  t.after(() => {
    killJobsFor(owner);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* 刚杀掉的子进程可能还攥着 cwd */
    }
  });
  return {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1_000, bashMaxTimeoutMs: 5_000 },
    agentSeesImages: false,
    ownerId: owner,
    ...extra,
  };
}

async function pollUntilDone(ctx: ToolContext, job: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const text = textOf(await bashTool.run({ poll: job }, ctx));
    if (!/still running/.test(text)) return text;
    if (Date.now() > deadline) assert.fail(`job ${job} never finished: ${text.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const SLOW = `node -e "console.log('start'); setTimeout(() => console.log('end'), 2500)"`;

test("R14 前台命令到点不杀：转后台、交回已有输出与 job id；之后 poll 拿到跑完的结果", { timeout: 60_000 }, async (t) => {
  const ctx = ctxFor(t, "r14-timeout");
  const r = await bashTool.run({ command: SLOW, timeout: 1_000 }, ctx);
  assert.equal(r.ok, true);
  const text = textOf(r);
  assert.match(text, /start/);
  assert.match(text, /it hit the timeout and was moved to the background as (job\d+(?:-[a-z0-9]+)?) instead of being killed/);
  const job = /as (job\d+(?:-[a-z0-9]+)?)/.exec(text)![1];
  const done = await pollUntilDone(ctx, job);
  assert.match(done, /\[exit 0\]/);
  assert.match(done, /start[\s\S]*end/, "进程没被杀，跑完了");
});

test("R14 要的时限超过前台上限（这里 5 秒）：直接后台跑", { timeout: 60_000 }, async (t) => {
  const ctx = ctxFor(t, "r14-long-ask");
  const r = await bashTool.run({ command: SLOW, timeout: 60_000 }, ctx);
  const text = textOf(r);
  assert.match(text, /above the 5000 ms foreground limit, so this runs as a background job/);
  const job = /job\d+(?:-[a-z0-9]+)?/.exec(text)?.[0];
  assert.ok(job, text);
  assert.match(await pollUntilDone(ctx, job!), /\[exit 0\][\s\S]*end/);
});

test("R14 界面「转后台」：按到正在跑的那次调用（只认同一个会话），这次调用立刻交回", { timeout: 60_000 }, async (t) => {
  const ctx = ctxFor(t, "r14-user", { callId: "call-7", limits: { bashTimeoutMs: 60_000, bashMaxTimeoutMs: 60_000 } });
  const running = bashTool.run({ command: SLOW }, ctx);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(moveForegroundToBackground("someone-else", "call-7"), false, "别的会话按不到");
  assert.equal(moveForegroundToBackground("r14-user", "call-7"), true);
  const started = Date.now();
  const text = textOf(await running);
  assert.ok(Date.now() - started < 1_000, "不用等命令跑完");
  assert.match(text, /the user moved it to the background as (job\d+(?:-[a-z0-9]+)?)/);
  assert.equal(moveForegroundToBackground("r14-user", "call-7"), false, "转过一次就不在前台了");
  assert.match(await pollUntilDone(ctx, /as (job\d+(?:-[a-z0-9]+)?)/.exec(text)![1]), /end/);
});

test("R14 运行中的实时尾行：每秒推一次最新几行（先脱敏），可以转后台；跑完不再推", { timeout: 60_000 }, async (t) => {
  const events: { e: string; id?: string; tail?: string; canBackground?: boolean }[] = [];
  const ctx = ctxFor(t, "r14-tail", {
    callId: "call-9",
    limits: { bashTimeoutMs: 60_000, bashMaxTimeoutMs: 60_000 },
    emit: (ev) => events.push(ev as never),
  });
  const cmd = `node -e "let i=0;const t=setInterval(()=>{console.log('tick '+(++i)+(i===2?' sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE01':''));if(i===8){clearInterval(t)}},300)"`;
  const r = await bashTool.run({ command: cmd }, ctx);
  assert.equal(r.ok, true);
  const progress = events.filter((ev) => ev.e === "tool_progress");
  assert.ok(progress.length >= 1, "跑了两秒多，至少推过一次");
  assert.ok(progress.every((ev) => ev.id === "call-9" && ev.canBackground === true));
  assert.ok(progress.some((ev) => /tick \d/.test(ev.tail ?? "")));
  assert.ok(progress.every((ev) => !(ev.tail ?? "").includes("sk-ant-FAKE")), "尾行先脱敏");
  const count = progress.length;
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(events.filter((ev) => ev.e === "tool_progress").length, count, "跑完就不再推");
});

test("R14 子进程环境驯服交互式工具：分页器不开、不输出颜色", () => {
  const env = childEnv();
  for (const k of ["PAGER", "GIT_PAGER", "GH_PAGER", "MANPAGER"]) assert.equal(env[k], "cat", k);
  assert.equal(env.TERM, "dumb");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});
