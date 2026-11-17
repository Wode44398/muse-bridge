// Bash 工具的特征基准：拆分 tools/bash.ts 前后，后台 job、job 结束后的自动开轮、verify 证据、命令闸、前台转后台这些
// 端到端流程的事件序列、发给模型的请求与落盘记录逐字不变。走生产路径（buildState 建的真工具表、真 shell）。
//
// 不进 npm test。跑法与重新生成见 session-flows.test.ts 开头。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { startJobNotify, _resetJobNotify } from "../job-notify.ts";
import { createSession, dropSession, stopSession } from "../session.ts";
import { listJobs, moveForegroundToBackground, stopJob } from "../tools/bash.ts";
import { call, calls, say, scripted, useTool, type ScriptedAdapter } from "../test-harness/scripted-adapter.ts";
import { baselineStore, Normalizer } from "./normalize.ts";
import { configure, lastUserText, Trace, turn, waitFor, workspace } from "./flow-kit.ts";

const store = baselineStore(path.join(import.meta.dirname, "bash-flows.baseline.json"), {
  update: process.env.UPDATE_CHAR_BASELINE === "1",
  actualDir: process.env.CHAR_ACTUAL_DIR,
});
const roots: string[] = [];
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-sessions-"));
roots.push(process.env.SESSIONS_DIR);
const BASE_SEMANTIC = process.env.KNOWLEDGE_AUTO_SEMANTIC;
process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
let stopNotify: () => void = () => {};
before(() => {
  stopNotify = startJobNotify();
});
after(() => {
  stopNotify();
  _resetJobNotify();
  store.flush();
  process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  if (BASE_SEMANTIC === undefined) delete process.env.KNOWLEDGE_AUTO_SEMANTIC;
  else process.env.KNOWLEDGE_AUTO_SEMANTIC = BASE_SEMANTIC;
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

// 后台 job id 带着这个进程的启动标记，PID 每次不同
const norm = () => new Normalizer([
  [/\bjob(\d+)-[a-z0-9]{1,8}\b/g, "job$1-<boot>"],
  [/\b(pid)([ :=]*)\d+/gi, "$1$2<n>"],
  [/started at \d\d:\d\d/g, "started at <hh:mm>"],
  [/dimensio-char-out-[A-Za-z0-9]{6}/g, "dimensio-char-out-<rand>"],
]);
// 第 n 次模型调用发生的当下，那一轮还在跑：拿住它的 runPromise（收尾一开始就清空，事后等不到落盘）
function runAtCall(adapter: ScriptedAdapter, s: { runPromise: Promise<void> | null }, n: number): () => Promise<void> {
  let p: Promise<void> | null = null;
  adapter.onCall = (k) => {
    if (k === n) p = s.runPromise;
  };
  return async () => {
    await waitFor(`第 ${n} 次模型调用`, () => p !== null, 30_000);
    await p;
  };
}
const jobIdIn = (text: string): string => /\bjob\d+-[a-z0-9]+\b/.exec(text)?.[0] ?? "no-job-id";

test("BX01 后台 job 在这一轮收工之后才结束：自动开一轮，首条是 task-notification", async (t) => {
  const tr = new Trace(t, store, norm());
  configure(workspace(roots));
  const s = createSession();
  const adapter = scripted(t, { model: "deepseek-flash" });
  const wake = runAtCall(adapter, s, 3);
  await turn(tr, s, "run", "后台跑一下", [useTool("b1", "Bash", { command: "sleep 2; echo BG-MARK-123", background: true }), say("开跑了，跑完告诉你。"), say("看到了，输出是 BG-MARK-123。")], { adapter });
  tr.note("after-first-run", { calls: adapter.callCount, jobs: listJobs(s.id) });
  await wake();
  tr.steps.push({ label: "wake:requests", value: tr.requests(adapter.inputs.slice(2)) });
  tr.note("jobs", listJobs(s.id));
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX01-background-wake");
  dropSession(s.id);
});

test("BX02 后台 job 在启动的早退窗口里就结束：结果直接在工具结果里，不再叫醒", async (t) => {
  const tr = new Trace(t, store, norm());
  configure(workspace(roots));
  const s = createSession();
  const adapter = scripted(t, { model: "deepseek-flash" });
  await turn(tr, s, "run", "后台跑个快的", [useTool("b1", "Bash", { command: "echo quick-done", background: true }), say("已经跑完了。")], { adapter });
  await new Promise((r) => setTimeout(r, 3_000));
  tr.note("calls", adapter.callCount);
  tr.note("running", s.running);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX02-background-early");
  dropSession(s.id);
});

test("BX03 模型操作后台 job：列出、等一会儿、收掉；界面停掉的不叫醒", async (t) => {
  const tr = new Trace(t, store, norm());
  configure(workspace(roots));
  const s = createSession();
  let id = "";
  await turn(tr, s, "run", "起一个长任务再收掉", [
    useTool("b1", "Bash", { command: "sleep 30; echo never-printed", background: true }),
    (turnIn) => {
      id = jobIdIn(lastUserText(turnIn));
      return useTool("b2", "Bash", { jobs: true });
    },
    () => useTool("b3", "Bash", { wait: id, timeout: 400 }),
    () => useTool("b4", "Bash", { poll: id }),
    () => useTool("b5", "Bash", { kill: id }),
    () => useTool("b6", "Bash", { poll: "job999-zzzz" }),
    say("收掉了。"),
  ]);
  tr.note("jobs-after", listJobs(s.id));
  await turn(tr, s, "ui-stop", "再起一个", [useTool("c1", "Bash", { command: "sleep 30", background: true }), say("开跑了。")]);
  const job = listJobs(s.id).find((j) => j.state === "running");
  tr.note("ui-stop", { found: Boolean(job), stopped: job ? stopJob(s.id, job.id) : false, again: job ? stopJob(s.id, job.id) : false });
  await new Promise((r) => setTimeout(r, 2_500));
  tr.note("running-after-ui-stop", s.running);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX03-job-ops");
  dropSession(s.id);
});

test("BX04 verify 证据：管道里 pipefail；`||` 兜底的拒收不执行；只是看看的命令不算证据", async (t) => {
  const tr = new Trace(t, store, norm());
  configure(workspace(roots));
  const s = createSession();
  await turn(tr, s, "run", "验证一下", [
    useTool("v1", "Bash", { command: "echo ok | cat", verify: true }),
    useTool("v2", "Bash", { command: "false || true", verify: true }),
    useTool("v3", "Bash", { command: "ls", verify: true }),
    useTool("v4", "Bash", { command: "false | cat", verify: true }),
    say("验证完了。"),
  ]);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX04-verify");
  dropSession(s.id);
});

test("BX05 命令闸：危险命令、杀宿主进程硬拒；读工作区外的文件弹卡，拒绝", async (t) => {
  const tr = new Trace(t, store, norm());
  const root = workspace(roots);
  configure(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-out-"));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, "x.txt"), "outside\n");
  const outsideFile = path.join(outside, "x.txt").replace(/\\/g, "/");
  const s = createSession();
  await turn(tr, s, "run", "试几个命令", [
    useTool("d1", "Bash", { command: "rm -rf /" }),
    useTool("d2", "Bash", { command: "taskkill /IM node.exe /F" }),
    useTool("d3", "Bash", { command: `cat '${outsideFile}'` }),
    useTool("d4", "Bash", { command: "cat ../../etc/passwd" }),
    say("有几条被拦了。"),
  ], {
    during: async (_a, live) => {
      await waitFor("工作区外读的卡", () => live().some((e) => e.e === "permission_ask"));
      const card = live().find((e) => e.e === "permission_ask")!;
      tr.note("card", { tool: card.tool, subject: card.subject, sessionRules: card.sessionRules });
      const { resolvePermission } = await import("../session.ts");
      tr.note("deny", resolvePermission(s, String(card.id), "deny"));
    },
  });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX05-policy");
  dropSession(s.id);
});

test("BX06 前台命令转后台：这次调用立刻交回已有输出，跑完再叫醒", async (t) => {
  const tr = new Trace(t, store, norm());
  configure(workspace(roots));
  const s = createSession();
  const adapter = scripted(t, { model: "deepseek-flash" });
  const wake = runAtCall(adapter, s, 3);
  await turn(tr, s, "run", "跑个慢命令", [useTool("b1", "Bash", { command: "echo first-line; sleep 3; echo moved-out" }), say("转到后台了。"), say("后台的也跑完了。")], {
    adapter,
    during: async (_a, live) => {
      await waitFor("Bash 开跑", () => live().some((e) => e.e === "tool_start"));
      await waitFor("转后台", () => moveForegroundToBackground(s.id, "b1"), 10_000);
      tr.note("moved-again", moveForegroundToBackground(s.id, "b1"));
    },
  });
  await wake();
  tr.steps.push({ label: "wake:requests", value: tr.requests(adapter.inputs.slice(2)) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX06-foreground-to-background");
  dropSession(s.id);
});

test("BX07 停止会话收掉它的后台 job；前台命令按停止中止", async (t) => {
  const tr = new Trace(t, store, norm());
  configure(workspace(roots));
  const s = createSession();
  await turn(tr, s, "bg", "起个后台任务", [useTool("b1", "Bash", { command: "sleep 30", background: true }), say("开跑了。")]);
  tr.note("stop", stopSession(s.id));
  tr.note("jobs-after-stop", listJobs(s.id));
  await turn(tr, s, "fg", "跑个前台慢命令", [calls(call("b2", "Bash", { command: "sleep 20; echo late" }))], {
    during: async (_a, live) => {
      await waitFor("前台命令开跑", () => live().some((e) => e.e === "tool_start"));
      await new Promise((r) => setTimeout(r, 300));
      tr.note("stop-fg", stopSession(s.id));
    },
  });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("BX07-stop-reaps");
  dropSession(s.id);
  assert.ok(true);
});

