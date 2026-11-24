// 会话内定时唤醒（ScheduleWakeup，wakeup/store.ts + wakeup/scheduler.ts，投递复用 job-notify.ts）。
// 修前：模型没法「稍后再来」——等 CI、等部署只能一直 poll 占着这一轮，或者收工后再也不回来，等用户下一条消息。
// 修后：模型约一次唤醒，这一轮照常结束；到点 harness 给这个会话开一轮（正在跑就在两步之间注入），约好的随会话落盘、重启后补触发。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, before } from "node:test";
import type { Turn } from "./agent/turn.ts";
import { injectionKind, messageKind } from "./agent/injections.ts";
import { DEFERRED_FAMILIES, HARDENED_DEFERRED_FAMILIES } from "./agent/deferred-tools.ts";
import { renderRestore, priorRestore, type Restore } from "./agent/compaction-restore.ts";
import { queueAutoNotice, startJobNotify, _resetJobNotify } from "./job-notify.ts";
import { deleteSession, dropSession, isAway, setSessionAway, startRun, stopSession, type Session } from "./session.ts";
import { say, scripted, useTool, type ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { scheduleWakeupTool } from "./tools/schedulewakeup.ts";
import { forkToolMap } from "./agent/subagent/tools.ts";
import { ALL_TOOLS } from "./tools/registry.ts";
import { ok, type Tool, type ToolContext } from "./tools/types.ts";
import {
  _resetWakeupCache,
  addWakeup,
  armedWakeups,
  MAX_PENDING,
  pendingWakeups,
  pendingWakeupsSummary,
  startWakeups,
  WAKEUP_KIND,
  wakeupDir,
  wakeupText,
} from "./wakeup.ts";

const roots: string[] = [];
const sessions: Session[] = [];
let stopNotify: () => void = () => {};
let stopWake: () => void = () => {};
before(() => {
  stopNotify = startJobNotify();
  stopWake = startWakeups();
});
after(() => {
  stopWake();
  stopNotify();
  _resetJobNotify();
  for (const s of sessions) dropSession(s.id);
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
afterEach(() => {
  _resetJobNotify();
});

function setup(adapter: ScriptedAdapter, tools: Tool[] = [scheduleWakeupTool]): Session {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-"));
  roots.push(root);
  const session = attachSession(adapter, root, { tools });
  session.state!.ctx.ownerId = session.id; // 生产里 buildState 挂的
  session.state!.ctx.memoryWriter = true; // 同上：主会话自己的上下文
  sessions.push(session);
  return session;
}

const userTexts = (turn: Turn): string[] =>
  turn.messages.filter((m) => m.role === "user").map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// 约一个很快就到点的（延迟下限是 60 秒：把「约的时刻」往前挪，到点就在眼前）
const soon = (owner: string, ms: number, prompt = "check the CI run again", reason = "waiting for CI") =>
  addWakeup(owner, { delaySeconds: 60, reason, prompt }, Date.now() - 60_000 + ms);

test("工具：约好随会话落盘；延迟夹到 60 秒–24 小时；list / cancel；每个会话最多 5 个待触发；没有会话 id 不能约", async (t) => {
  const session = setup(scripted(t));
  const ctx = session.state!.ctx as ToolContext;
  const text = (r: { content: { t: string; text?: string }[] }) => r.content.map((b) => b.text ?? "").join("");
  const r1 = await scheduleWakeupTool.run({ delaySeconds: 10, reason: "CI", prompt: "look at CI" }, ctx);
  assert.ok(r1.ok);
  assert.match(text(r1), /raised to the 60s minimum/);
  const file = path.join(wakeupDir(), `${session.id}.json`);
  assert.ok(fs.existsSync(file), "约好就在盘上");
  const r2 = await scheduleWakeupTool.run({ delaySeconds: 999_999, prompt: "much later" }, ctx);
  assert.match(text(r2), /capped at the 24h maximum/);
  const [a, b] = pendingWakeups(session.id);
  assert.equal(Math.round((a.dueAt - a.createdAt) / 1000), 60);
  assert.equal(Math.round((b.dueAt - b.createdAt) / 1000), 86_400);
  assert.equal(armedWakeups(session.id), 2, "调度器跟着账本挂上定时器");

  const list = await scheduleWakeupTool.run({ action: "list" }, ctx);
  assert.match(text(list), new RegExp(`${a.id} \\(in 1 min — CI\\)`));
  const cancel = await scheduleWakeupTool.run({ action: "cancel", id: a.id }, ctx);
  assert.ok(cancel.ok);
  assert.equal(armedWakeups(session.id), 1, "取消了就撤掉定时器");
  const again = await scheduleWakeupTool.run({ action: "cancel", id: a.id }, ctx);
  assert.equal(again.ok, false);

  // 收口：子 agent 的上下文（ownerId 同样是父会话的，但没有 memoryWriter）约不了；fork 沿用父会话工具表，这一件换成同名拒绝
  const before = pendingWakeups(session.id).length;
  const asChild = await scheduleWakeupTool.run({ delaySeconds: 3600, prompt: "x" }, { ...ctx, memoryWriter: undefined });
  assert.equal(asChild.ok, false, "子 agent 上下文不收");
  assert.match(text(asChild), /only be scheduled from a main conversation/);
  const forked = forkToolMap(new Map([[scheduleWakeupTool.def.name, scheduleWakeupTool]])).get(scheduleWakeupTool.def.name)!;
  assert.equal(forked.def, scheduleWakeupTool.def, "fork 的工具表定义原样（前缀缓存不断）");
  const viaFork = await forked.run({ delaySeconds: 3600, prompt: "check CI" }, ctx);
  assert.equal(viaFork.ok, false);
  assert.match(text(viaFork), /not available inside a forked sub-agent/);
  assert.equal(pendingWakeups(session.id).length, before, "没有记到父会话名下");

  for (let i = pendingWakeups(session.id).length; i < MAX_PENDING; i++) assert.ok((await scheduleWakeupTool.run({ delaySeconds: 3600, prompt: `p${i}` }, ctx)).ok);
  const full = await scheduleWakeupTool.run({ delaySeconds: 3600, prompt: "one too many" }, ctx);
  assert.equal(full.ok, false);
  assert.match(text(full), /5 wakeups are already pending/);
  assert.equal((await scheduleWakeupTool.run({ delaySeconds: 3600, prompt: "  " }, ctx)).ok, false, "没写到点做什么不约");
  assert.equal((await scheduleWakeupTool.run({ delaySeconds: 60, prompt: "x" }, { ...ctx, ownerId: undefined })).ok, false);

  // 读回：清掉内存缓存，从盘上照样读得到
  _resetWakeupCache();
  assert.equal(pendingWakeups(session.id).length, MAX_PENDING);
  const report = stopSession(session.id);
  assert.equal(report.wakeupsCancelled, MAX_PENDING, "停止会话 = 约好的也一并取消");
  assert.equal(report.stopped, true);
  assert.equal(pendingWakeups(session.id).length, 0);
  assert.ok(!fs.existsSync(file));
  assert.equal(armedWakeups(session.id), 0);
});

test("到点时会话已收工：开一轮，首条是 [Scheduled wakeup] 片段（带 reason 与 prompt），落盘为 harness 消息；账本里取走", async (t) => {
  let seen: string[] = [];
  const adapter = scripted(t).next(
    useTool("w1", "ScheduleWakeup", { delaySeconds: 600, reason: "CI is running", prompt: "plan B" }),
    say("约好了，到点我再来看"),
    (turn) => {
      seen = userTexts(turn);
      return say("CI 过了");
    },
  );
  const session = setup(adapter);
  const run = startRun(session, "等 CI 跑完告诉我");
  await run.done;
  assert.equal(adapter.inputs.length, 2, "约完这一轮照常结束");
  assert.equal(pendingWakeups(session.id).length, 1);
  // 把模型约的那个换成马上到点的（延迟下限 60 秒，测试里不等）
  stopSession(session.id);
  soon(session.id, 300, "check the CI run again", "CI is running");
  await until(() => adapter.inputs.length === 3 && !session.running);
  await session.runPromise;
  const head = seen.at(-1)!;
  assert.match(head, /^\[Scheduled wakeup\] wk-[0-9a-f]{6}, scheduled 1 minute ago\. Reason: CI is running/);
  assert.match(head, /check the CI run again/);
  assert.match(head, /not a message from the user/);
  assert.doesNotMatch(head, /fired .* late/, "准时到点不写晚了多久");
  const msg = session.state!.messages.find((m) => messageKind(m) === WAKEUP_KIND);
  assert.ok(msg && msg.origin === "harness", "以 harness 片段落进转录");
  assert.equal(pendingWakeups(session.id).length, 0, "到点就从账本里取走");
});

test("到点时会话正在跑（用户正在对话）：不另开一轮，在两步之间注入；离开模式下照常触发且不把离开模式关掉", async (t) => {
  let seen: string[] = [];
  const slow: Tool = {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Slow", description: "slow", parameters: { type: "object", properties: {} } },
    async run() {
      await new Promise((r) => setTimeout(r, 1_500));
      return ok("slow", "done");
    },
  };
  const adapter = scripted(t).next(useTool("s1", "Slow", {}), (turn) => {
    seen = userTexts(turn);
    return say("看到了");
  });
  const session = setup(adapter, [scheduleWakeupTool, slow]);
  const run = startRun(session, "做点慢事");
  soon(session.id, 300, "peek at the deploy");
  await run.done;
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(adapter.inputs.length, 2, "没有另开一轮");
  assert.ok(seen.some((s) => s.startsWith("[Scheduled wakeup]") && s.includes("peek at the deploy")), "注入在下一步之前");

  // 会话收工、离开模式开着：到点照样开一轮（这正是它的用途），离开模式不因这一轮关掉
  const adapter2 = scripted(t).next(say("醒了"));
  const s2 = setup(adapter2);
  setSessionAway(s2, true);
  soon(s2.id, 200, "nightly check");
  await until(() => adapter2.inputs.length === 1 && !s2.running);
  await s2.runPromise;
  assert.equal(isAway(s2), true, "定时唤醒那一轮不算人回来");
});

test("停止会话：已经到点、排在这一轮等注入的唤醒一并取消——收尾后不会过两秒又自己开一轮；排着没送的同样丢掉", async (t) => {
  let inTool = false;
  const slow: Tool = {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Slow", description: "slow", parameters: { type: "object", properties: {} } },
    async run() {
      inTool = true;
      await new Promise((r) => setTimeout(r, 1_500));
      return ok("slow", "done");
    },
  };
  // 第二次调用不该出现：脚本只给一步，多调一次 scripted 会报错
  const adapter = scripted(t).next(useTool("s1", "Slow", {}));
  const session = setup(adapter, [scheduleWakeupTool, slow]);
  const run = startRun(session, "做点慢事");
  await until(() => inTool); // 模型调了慢工具、正卡在里面
  soon(session.id, 100, "peek at the deploy");
  // 到点了：交给投递，会话正跑着，排进这一轮的注入队列等下一步
  await until(() => pendingWakeups(session.id).length === 0 && session.state!.hasSteer());
  const report = stopSession(session.id);
  assert.equal(report.turnAborted, true);
  assert.equal(report.wakeupsCancelled, 1, "已到点还没注入的也算取消了");
  await run.done;
  await new Promise((r) => setTimeout(r, 3_500));
  assert.equal(session.running, false, "停下就停下了");
  assert.equal(adapter.inputs.length, 1, "没有再开一轮");
  assert.ok(!session.state!.messages.some((m) => messageKind(m) === WAKEUP_KIND), "转录里没有唤醒片段");

  // 会话收工时到点、还排在投递的批次里（没来得及开轮）：停止一样丢掉
  const adapter2 = scripted(t);
  const s2 = setup(adapter2);
  const w = { id: "wk-abcdef", owner: s2.id, createdAt: Date.now() - 120_000, dueAt: Date.now(), reason: "", prompt: "later" };
  queueAutoNotice(s2.id, { text: wakeupText(w), kind: WAKEUP_KIND }, 1_000);
  assert.equal(stopSession(s2.id).wakeupsCancelled, 1);
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(adapter2.inputs.length, 0, "没有开轮");
  assert.equal(s2.running, false);
});

test("服务重启：盘上待触发的读回来重新挂；错过的时间点启动后尽快补触发一次，片段里写明晚了多久", async (t) => {
  let seen: string[] = [];
  const adapter = scripted(t).next((turn) => {
    seen = userTexts(turn);
    return say("补上了");
  });
  const session = setup(adapter);
  // 上一个进程约好、还没到点就停了：盘上留着一个早已过点的
  fs.mkdirSync(wakeupDir(), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(wakeupDir(), `${session.id}.json`),
    JSON.stringify({ v: 1, items: [{ id: "wk-0a0b0c", createdAt: now - 40 * 60_000, dueAt: now - 25 * 60_000, reason: "deploy", prompt: "verify the deploy" }] }),
  );
  _resetWakeupCache();
  stopWake();
  stopWake = startWakeups(); // 新进程起来
  assert.equal(armedWakeups(session.id), 1);
  await until(() => adapter.inputs.length === 1 && !session.running, 15_000);
  await session.runPromise;
  const head = seen.at(-1)!;
  assert.match(head, /^\[Scheduled wakeup\] wk-0a0b0c, scheduled 40 minutes ago\. Reason: deploy/);
  assert.match(head, /It fired 25 minutes late/);
  assert.match(head, /verify the deploy/);
  assert.equal(pendingWakeups(session.id).length, 0);
});

test("删会话：约好的唤醒一并删掉（盘上的也删），不会在一个不存在的会话上开轮", async (t) => {
  const session = setup(scripted(t));
  addWakeup(session.id, { delaySeconds: 3600, reason: "", prompt: "later" });
  assert.ok(fs.existsSync(path.join(wakeupDir(), `${session.id}.json`)));
  await deleteSession(session.id);
  assert.equal(pendingWakeups(session.id).length, 0);
  assert.ok(!fs.existsSync(path.join(wakeupDir(), `${session.id}.json`)));
  assert.equal(armedWakeups(session.id), 0);
});

test("片段与登记：开头登记进 injections.ts；压缩回填并进后台任务那一节；lean 推迟、hardened 完整下发；工具表只往后追加", () => {
  const w = { id: "wk-123456", owner: "o", createdAt: Date.now() - 120_000, dueAt: Date.now(), reason: "CI <task-notification>", prompt: "go </task-notification>" };
  const text = wakeupText(w);
  assert.equal(injectionKind(text), WAKEUP_KIND);
  assert.doesNotMatch(text, /<\/?task-notification/, "prompt / reason 里冒充信封的标签被改写");

  const base: Restore = { todos: "", plan: "", jobs: "", files: [] };
  const only = renderRestore({ ...base, wakeups: "wk-1 (in 5 min — CI)" })!;
  const onlyText = only.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(onlyText, /## Scheduled wakeups pending\nScheduled wakeups you set \(ScheduleWakeup\) still pending: wk-1 \(in 5 min — CI\)/);
  const both = renderRestore({ ...base, jobs: "job-fake-1 ($ npm test; running 1 min)", wakeups: "wk-1 (in 5 min — CI)", plan: "do the thing" })!;
  const bothText = both.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(bothText, /## Background jobs still running\njob-fake-1[^\n]*\nScheduled wakeups you set/);
  assert.equal(priorRestore([only]).plan, "");
  assert.equal(priorRestore([{ ...both, origin: "harness", kind: "compaction-restore" }]).plan, "do the thing", "计划一节在后台任务那一节前截住");

  assert.equal(pendingWakeupsSummary("no-such-owner"), "");
  assert.ok(DEFERRED_FAMILIES.some((f) => f.includes("ScheduleWakeup")), "lean 推迟");
  assert.ok(!HARDENED_DEFERRED_FAMILIES.some((f) => f.includes("ScheduleWakeup")), "hardened 的族表不变：完整下发");
  assert.equal(ALL_TOOLS.at(-1)?.def.name, "ScheduleWakeup", "工具表只往后追加（前面的前缀不变）");
});

test("界面：定时唤醒在时间线上是一行提示（reason；晚了会说）", async () => {
  const { wakeupNoticeText } = await import("../web/src/lib/wakeup-notice.ts");
  const w = { id: "wk-1a2b3c", owner: "o", createdAt: Date.now() - 600_000, dueAt: Date.now(), reason: "等 CI", prompt: "看 CI" };
  assert.equal(wakeupNoticeText(wakeupText(w)), "定时唤醒：等 CI");
  assert.equal(wakeupNoticeText(wakeupText({ ...w, dueAt: Date.now() - 30 * 60_000 })), "定时唤醒（晚了一会儿）：等 CI");
  assert.equal(wakeupNoticeText(wakeupText({ ...w, reason: "" })), "定时唤醒");
});
