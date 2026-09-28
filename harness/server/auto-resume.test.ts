// M13（D6、N35、X33）：开跑 marker + 服务重启 / 进程死掉之后自动续跑（Codex 形态）+ 重启循环熔断。
//
// 修前：部署（M8 排空）把在跑的长任务按「服务重启」切断，转录里写明了，但要等人回来说一句「继续」；进程直接死掉的更糟——
// 下一个进程根本不知道哪些轮是被切断的。
// 修后：一轮开跑写 marker（<sessions>/running/<id>.json），正常收尾删、被重启切断的留着并标上、进程死了自然留着；下一个
// 进程起来扫 marker，新开一轮接着做（首条是 harness 片段 kind resume，不重提原 prompt）；连着续跑超过上限就停、留一句说明。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { processTable } from "./proc-tree.ts";
import { RESTART_REASON } from "./retire.ts";
import { clearRunMarker, readRunMarker, writeRunMarker } from "./run-markers.ts";
import { MAX_AUTO_RESUMES, RESUME_KIND, RESUME_STOPPED_KIND, resumeInterruptedRuns, startRun, stopSession } from "./session.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";

const roots: string[] = [];
// 全量测试里各文件共用一个临时数据根：resumeInterruptedRuns 会扫整个 running/ 目录，别的测试文件在跑的轮也有 marker——
// 这个文件换一个自己的会话目录（收尾还原成进入时的值，不要 delete）
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m13-sessions-"));
roots.push(process.env.SESSIONS_DIR);
after(() => {
  process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const textOf = (m: { content: { t: string; text?: string }[] } | undefined) => (m?.content ?? []).map((b) => b.text ?? "").join("");
// 等模型真的被调到（开跑前还有检查点、知识预热几次 await；太早停 / 切断，脚本那一步就留给了下一轮）
async function calledOnce(adapter: { callCount: number }): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (adapter.callCount < 1) {
    if (Date.now() > deadline) assert.fail("the model was never called");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 卡在半路的一步：等测试放行才吐字（放行之前测试可以停它、切断它）
function gated(): { step: () => AsyncIterable<StreamEvent>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release: () => release(),
    step: async function* () {
      await gate;
      yield* say("写到一半");
    },
  };
}

test("M13 marker：开跑时写、做完删；用户停的也删", async (t) => {
  let seenMidRun: unknown = "unset";
  const adapter = scripted(t).next(() => {
    seenMidRun = readRunMarker(session.id);
    return say("好");
  });
  const session = attachSession(adapter, tmp("dimensio-m13-a-"));
  await send(session, "你好");
  assert.ok(seenMidRun && typeof seenMidRun === "object", "跑的时候 marker 在");
  assert.equal(readRunMarker(session.id), null, "做完就删");

  const g = gated();
  const a2 = scripted(t).next(g.step);
  const s2 = attachSession(a2, tmp("dimensio-m13-b-"));
  const run = startRun(s2, "长任务");
  assert.ok(readRunMarker(s2.id));
  await calledOnce(a2);
  stopSession(s2.id);
  g.release();
  await run.done;
  assert.equal(readRunMarker(s2.id), null, "用户停的不续跑");
});

test("M13 被「服务重启」切断：marker 留着、标上 restart；下一个进程起来自动续跑一轮，首条是 harness 片段，做完删 marker", async (t) => {
  const g = gated();
  const adapter = scripted(t).next(g.step, say("接着做完了"));
  const session = attachSession(adapter, tmp("dimensio-m13-c-"));
  const run = startRun(session, "把报告写完");
  await calledOnce(adapter);
  session.abort!.abort(RESTART_REASON); // M8 排空就是这么切的
  g.release();
  await run.done;
  const marker = readRunMarker(session.id);
  assert.equal(marker?.interrupted, "restart");
  assert.equal(marker?.resumes, 0);

  const r = await resumeInterruptedRuns();
  assert.deepEqual(r.resumed, [session.id]);
  await session.runPromise;
  const msgs = session.state!.messages;
  const head = msgs.find((m) => m.kind === RESUME_KIND);
  assert.ok(head, "续跑那一轮的首条是 harness 片段");
  assert.equal(head.origin, "harness");
  assert.match(textOf(head), /^\[Resumed\] The previous run was interrupted by a server restart/);
  assert.equal(msgs.filter((m) => m.role === "user" && !m.origin && textOf(m) === "把报告写完").length, 1, "不重提原 prompt");
  assert.ok(textOf(msgs.at(-1)).includes("接着做完了"));
  assert.equal(readRunMarker(session.id), null, "续跑做完就删");
});

test("M13 进程直接死掉（marker 没标 restart）按「意外停下」续跑；连着续跑到上限就停、留一句说明", async (t) => {
  const crashed = attachSession(scripted(t).next(say("好"), say("接着做")), tmp("dimensio-m13-d-"));
  await send(crashed, "开始");
  writeRunMarker(crashed.id, { runId: "r-crash", startedAt: Date.now(), resumes: 0 });
  const r1 = await resumeInterruptedRuns();
  assert.ok(r1.resumed.includes(crashed.id));
  await crashed.runPromise;
  assert.match(textOf(crashed.state!.messages.find((m) => m.kind === RESUME_KIND)), /stopped unexpectedly/);

  const looping = attachSession(scripted(t).next(say("好")), tmp("dimensio-m13-e-"));
  await send(looping, "开始");
  writeRunMarker(looping.id, { runId: "r-loop", startedAt: Date.now(), resumes: MAX_AUTO_RESUMES, interrupted: "restart" });
  const r2 = await resumeInterruptedRuns();
  assert.ok(r2.gaveUp.includes(looping.id));
  assert.ok(!r2.resumed.includes(looping.id));
  assert.equal(looping.running, false, "没再起跑");
  assert.equal(readRunMarker(looping.id), null, "marker 清掉，不再试");
  const note = looping.state!.messages.at(-1);
  assert.equal(note?.kind, RESUME_STOPPED_KIND);
  assert.match(textOf(note), /interrupted 3 times in a row/);
  clearRunMarker(crashed.id);
});

test("M13 别的还活着的进程写的 marker 不续（那是人家正在跑的轮）；主人已经不在的照续", { skip: process.platform !== "win32" }, async (t) => {
  const table = await processTable();
  const parent = table.find((row) => row.pid === process.ppid);
  assert.ok(parent, "父进程在进程表里");
  const busy = attachSession(scripted(t).next(say("好")), tmp("dimensio-m13-f-"));
  await send(busy, "开始");
  writeRunMarker(busy.id, { runId: "r-other", startedAt: Date.now(), resumes: 0, pid: parent.pid, pidCreated: parent.created });
  const r1 = await resumeInterruptedRuns();
  assert.ok(!r1.resumed.includes(busy.id), "父进程还活着：不续");
  assert.ok(readRunMarker(busy.id), "marker 原样留着（等它自己收尾）");
  // PID 对得上、创建时间对不上 = PID 被复用了，原主人已经不在
  const gone = attachSession(scripted(t).next(say("好"), say("接着做")), tmp("dimensio-m13-g-"));
  await send(gone, "开始");
  writeRunMarker(gone.id, { runId: "r-reused", startedAt: Date.now(), resumes: 0, pid: parent.pid, pidCreated: parent.created - 3_600_000 });
  const r2 = await resumeInterruptedRuns();
  assert.ok(r2.resumed.includes(gone.id), "PID 复用：原主人不在，照续");
  await gone.runPromise;
  clearRunMarker(busy.id);
});
