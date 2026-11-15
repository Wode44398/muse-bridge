// 定时任务用 dimensio 跑（routine-runs.ts，bridge 的 Routines 经 familyCall 调）：新会话 / 续会话起一轮——指令是用户消息、后面跟一条
// kind routine 的片段、这一轮不算真人发话；长轮询拿结局（做完 / 被停下）；续会话撞上在跑回 busy、会话没了回 gone；
// 配置认不了回 config；没记过的一轮（harness 中途重启过）回 unknown。会话由夹具建（脚本化 provider），开跑走生产的 startRun。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, beforeEach, type TestContext } from "node:test";
import { attachSession } from "./test-harness/session-fixture.ts";
import { say, scripted, type ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { startRun, stopSession, type Session } from "./session.ts";
import { messageKind } from "./agent/injections.ts";
import { nobodyHere } from "./session-family.ts";
import type { Turn } from "./agent/turn.ts";
import { _resetRoutines, routineHooks, routineNote, routineStatus, startRoutine } from "./routine-runs.ts";

const ownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-routine-"));
after(() => {
  try { fs.rmSync(ownRoot, { recursive: true, force: true }); } catch { /* 留给 test-global 的清扫 */ }
});
const created: Session[] = [];
beforeEach(() => _resetRoutines());
afterEach(async () => {
  for (const s of created.splice(0)) {
    s.abort?.abort();
    await s.runPromise?.catch(() => {});
  }
  _resetRoutines();
});

function session(adapter: ScriptedAdapter): Session {
  const root = fs.mkdtempSync(path.join(ownRoot, "ws-"));
  const s = attachSession(adapter, root);
  created.push(s);
  return s;
}
const allText = (t: Turn) => t.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");

test("新会话：指令落成用户消息、后面跟 kind routine 的说明；这一轮不算真人；长轮询拿到结局与回答", async (t: TestContext) => {
  const a = scripted(t);
  let s: Session | null = null;
  routineHooks.createSession = () => (s = session(a));
  a.next((turn: Turn) => {
    const text = allText(turn);
    assert.match(text, /do the daily review/);
    assert.match(text, /\[Scheduled task\] "Daily review" started this turn on its own schedule/);
    assert.equal(nobodyHere(s!.id), true, "定时任务那一轮不替用户开新会话");
    return say("ROUTINE-RESULT: 3 commits reviewed");
  });
  const r = await startRoutine({ title: "Daily review", prompt: "do the daily review" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.id, s!.id);
  const st = await routineStatus(r.id, r.runId, 10_000);
  assert.deepEqual([st.ok, st.ok && st.running], [true, false]);
  assert.equal(st.ok && !st.running && st.outcome, "done");
  assert.equal(st.ok && !st.running && st.text, "ROUTINE-RESULT: 3 commits reviewed");
  assert.equal(s!.title, "Daily review", "新会话的标题先用任务名");
  const msgs = s!.state!.messages;
  const user = msgs.find((m) => m.role === "user" && !m.origin)!;
  assert.equal(user.displayText ?? user.content.map((b) => (b.t === "text" ? b.text : "")).join(""), "do the daily review");
  assert.deepEqual(msgs.map((m) => messageKind(m)).filter(Boolean), ["routine"]);
  // 结局记下了：再问一次立即答（不等）
  const again = await routineStatus(r.id, r.runId, 0);
  assert.equal(again.ok && !again.running && again.outcome, "done");
});

test("续上次的会话：在那个会话里接着跑；它正在跑回 busy，会话没了回 gone", async (t: TestContext) => {
  const a = scripted(t);
  const s = session(a);
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  a.next(
    async function* () {
      await gate;
      yield* say("user turn done");
    },
    (turn: Turn) => {
      assert.match(allText(turn), /second run/);
      return say("CONTINUED");
    },
  );
  const busyRun = startRun(s, "the user is chatting here");
  assert.ok(busyRun.started);
  const busy = await startRoutine({ sessionId: s.id, title: "T", prompt: "second run" });
  assert.deepEqual(busy.ok ? null : busy.code, "busy");
  release();
  await busyRun.done;
  const r = await startRoutine({ sessionId: s.id, title: "T", prompt: "second run" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.id, s.id);
  const st = await routineStatus(s.id, r.runId, 10_000);
  assert.equal(st.ok && !st.running && st.text, "CONTINUED");
  const gone = await startRoutine({ sessionId: "00000000-0000-4000-8000-00000000dead", title: "T", prompt: "x" });
  assert.deepEqual(gone.ok ? null : gone.code, "gone");
});

test("在会话里按了停止：结局 aborted、by user；在跑时问到的是 running", async (t: TestContext) => {
  const a = scripted(t);
  routineHooks.createSession = () => session(a);
  let started!: () => void;
  const inStep = new Promise<void>((res) => (started = res));
  // 这一步一直挂着，直到这次请求被停止（脚本化 provider 记下了每次调用收到的 signal）
  a.next(async function* (_turn: Turn) {
    started();
    const sig = a.signals.at(-1);
    await new Promise<void>((res) => (!sig || sig.aborted ? res() : sig.addEventListener("abort", () => res(), { once: true })));
    if (!sig) yield* say("never");
  });
  const r = await startRoutine({ title: "Long", prompt: "take a while" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  await inStep;
  const mid = await routineStatus(r.id, r.runId, 0);
  assert.deepEqual(mid, { ok: true, running: true, waiting: false });
  stopSession(r.id);
  const st = await routineStatus(r.id, r.runId, 10_000);
  assert.equal(st.ok && !st.running && st.outcome, "aborted");
  assert.equal(st.ok && !st.running && st.by, "user");
});

test("配置认不了回 config（不建会话）；没记过的一轮回 unknown 带最后的回答；说明里的任务名收掉引号换行", async (t: TestContext) => {
  const bad = await startRoutine({ title: "X", prompt: "x", config: { provider: "no-such-provider" } });
  assert.deepEqual(bad.ok ? null : bad.code, "config");
  const a = scripted(t);
  const s = session(a);
  a.next(say("OLD ANSWER"));
  const run = startRun(s, "hello");
  await run.done;
  const st = await routineStatus(s.id, "not-a-tracked-run", 0);
  assert.equal(st.ok && !st.running && st.outcome, "unknown");
  assert.equal(st.ok && !st.running && st.text, "OLD ANSWER");
  assert.match(routineNote('a "b"\nc'), /^\[Scheduled task\] "a b c" started/);
  const empty = await startRoutine({ title: "X", prompt: "   " });
  assert.deepEqual(empty.ok ? null : empty.code, "bad");
});
