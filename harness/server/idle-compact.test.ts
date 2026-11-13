// 空闲压缩（idle-compact.ts，对齐 Claude Code 2.1.299）与压缩加固（摘要分「已完成 / 还剩」、换小窗口型号时由原型号写摘要，2.1.301）。
// 修前：长对话空闲超过 1 小时，提示缓存过期，回来第一条消息要按全价（官方 1 小时缓存写入 2 倍）把整段原样重写一遍；
// 换到窗口更小的型号，紧接着的压缩由装不下这段对话的新型号来写摘要。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { compactManually, COMPACTION_SYSTEM } from "./agent/context.ts";
import { messageKind } from "./agent/injections.ts";
import type { Msg } from "./agent/turn.ts";
import type { StreamEvent } from "./agent/events.ts";
import { cancelIdleCompact, idleCompactRunEnd, idleDelay, startIdleCompact, _fireIdleCompact, _idleTimers } from "./idle-compact.ts";
import { compactIdleSession, dropSession, startRun, type Session } from "./session.ts";
import { fakeSummary, say, scripted, ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { setPrefs } from "./prefs.ts";

const roots: string[] = [];
const sessions: Session[] = [];
const stopIdle = startIdleCompact();
after(() => {
  stopIdle();
  for (const s of sessions) dropSession(s.id);
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
});

function setup(adapter: ScriptedAdapter): Session {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idle-compact-"));
  roots.push(root);
  const s = attachSession(adapter, root);
  sessions.push(s);
  return s;
}

// 一段够压的长对话（中段若干轮问答，每轮几千字）
function longHistory(turns = 12): Msg[] {
  const msgs: Msg[] = [{ role: "user", content: [{ t: "text", text: "总任务：整理报告" }] }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "assistant", content: [{ t: "text", text: `第 ${i} 步的结论 ${"内容".repeat(1500)}` }] });
    msgs.push({ role: "user", content: [{ t: "text", text: `继续第 ${i + 1} 步` }] });
  }
  msgs.push({ role: "assistant", content: [{ t: "text", text: "到这里了" }] });
  return msgs;
}

const summaryOf = (s: Session) => s.state!.messages.find((m) => messageKind(m) === "compaction-summary");

test("定时：缓存 1 小时的会话收尾后排在 54 分钟；5 分钟缓存 / 没缓存的不排；开新一轮就撤掉", (t) => {
  assert.equal(idleDelay(3_600_000), 54 * 60_000);
  const hour = setup(scripted(t, { capabilities: { cacheTtlMs: 3_600_000 } }));
  idleCompactRunEnd(hour);
  assert.ok(_idleTimers.has(hour.id));
  cancelIdleCompact(hour.id);
  assert.ok(!_idleTimers.has(hour.id));
  const five = setup(scripted(t, { capabilities: { cacheTtlMs: 300_000 } }));
  idleCompactRunEnd(five);
  assert.ok(!_idleTimers.has(five.id));
  const none = setup(scripted(t));
  idleCompactRunEnd(none);
  assert.ok(!_idleTimers.has(none.id));
});

test("空闲压缩：上下文够大就压（摘要请求一次，转录里出现压缩摘要）；不够大不动", async (t) => {
  const adapter = scripted(t).next(say(fakeSummary("报告整理到第 12 步")));
  const s = setup(adapter);
  s.state!.messages = longHistory();
  const small = await compactIdleSession(s.id, 10_000_000, new AbortController().signal);
  assert.equal(small.ok, false);
  assert.equal(small.code, "empty");
  assert.equal(adapter.inputs.length, 0, "不够大不发摘要请求");
  const r = await compactIdleSession(s.id, 1_000, new AbortController().signal);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.after! < r.before!);
  assert.ok(summaryOf(s), "转录里有压缩摘要");
  assert.equal(adapter.inputs[0].system, COMPACTION_SYSTEM);
});

test("压到一半用户发话了：这次压缩作废（不留痕迹），用户这一轮照常跑完", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = scripted(t).next(
    async function* (_turn, _n): AsyncIterable<StreamEvent> {
      await gate; // 摘要请求挂着，直到用户发话之后
      yield* say(fakeSummary("不该被采用的摘要"));
    },
    say("收到"),
  );
  const s = setup(adapter);
  s.state!.messages = longHistory();
  await setPrefs({ idleCompactMinTokens: 30_000 }); // 这段对话约 3.6 万 token，默认门槛 12 万
  t.after(() => setPrefs({ idleCompactMinTokens: 120_000 }));
  const before = s.state!.messages.length;
  const firing = _fireIdleCompact(s.id);
  for (let i = 0; i < 200 && adapter.inputs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(adapter.inputs.length, 1, "摘要请求已经发出去、挂着");
  const run = startRun(s, "我回来了");
  assert.ok(run.started, "压缩不占住会话");
  release();
  await firing;
  await run.done;
  assert.equal(summaryOf(s), undefined, "被掐掉的压缩没有提交");
  assert.equal(s.state!.messages.length, before + 2, "原样多了用户这一问一答");
});

test("摘要要求把「已完成，勿重做」和「还剩什么」分开写", () => {
  assert.match(COMPACTION_SYSTEM, /Done \(do not redo\)/);
  assert.match(COMPACTION_SYSTEM, /Remaining/);
});

test("换到窗口更小的型号后的那次压缩：摘要由换之前的型号写，写完清掉；它写不出来再退回现在的型号", async (t) => {
  const oldModel = scripted(t, { model: "big-old" }).next(say(fakeSummary("旧型号写的摘要")));
  const newModel = scripted(t, { model: "small-new" });
  const s = setup(newModel);
  s.state!.messages = longHistory();
  s.state!.switchSummarizer = oldModel;
  await compactManually(s.state!);
  assert.equal(oldModel.inputs.length, 1);
  assert.equal(newModel.inputs.length, 0);
  assert.equal(s.state!.switchSummarizer, undefined, "用过就清");
  assert.match(JSON.stringify(summaryOf(s)), /旧型号写的摘要/);

  const broken = scripted(t, { model: "big-old-2" }).next({ throws: "overloaded" });
  const fallback = scripted(t, { model: "small-new-2" }).next(say(fakeSummary("新型号兜底的摘要")));
  const s2 = setup(fallback);
  s2.state!.messages = longHistory();
  s2.state!.switchSummarizer = broken;
  await compactManually(s2.state!);
  assert.match(JSON.stringify(summaryOf(s2)), /新型号兜底的摘要/);
});
