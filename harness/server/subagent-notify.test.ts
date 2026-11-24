// 后台子 agent 走真会话：父会话这一轮收工之后子 agent 才跑完——自动开一轮，首条是 task-notification（带报告）；发起那次 Agent
// 调用的卡片记录从「在跑」改成最终结果。用户停会话：后台子 agent 一并停下，不为它开轮，用户下一条消息时附上。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { makeSubAgentHost } from "./agent/subagent.ts";
import { _resetAgentRegistry, registerAgent } from "./agent/subagent/registry.ts";
import { messageKind } from "./agent/injections.ts";
import type { Turn } from "./agent/turn.ts";
import { _resetJobNotify, jobNotifyRunEnd, jobNotifyRunStart, queueTaskNotice, TASK_NOTIFICATION_KIND } from "./job-notify.ts";
import { setPrefs } from "./prefs.ts";
import { Sandbox } from "./sandbox.ts";
import { dropSession, restoreSessionFiles, rewindSession, rollbackSession, startRun, stopSession, type Session } from "./session.ts";
import { backgroundAgentEnded, composeAgentNotice, idleFilesSnapshot, recordUndeliveredAgentNotices, settlePendingAgentCards, settleStaleAgentCards } from "./session/subagents.ts";
import { listCheckpoints, takeCheckpoint } from "./checkpoints.ts";
import type { PersistedSession } from "./store.ts";
import type { SubAgentResult } from "./tools/types.ts";
import { say, scripted, useTool, type ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { agentTool } from "./tools/agent.ts";

const roots: string[] = [];
const sessions: Session[] = [];
after(() => {
  _resetJobNotify();
  _resetAgentRegistry();
  for (const s of sessions) dropSession(s.id);
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
});

function setup(parent: ScriptedAdapter, child: ScriptedAdapter): Session {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-notify-"));
  roots.push(root);
  const session = attachSession(parent, root, { tools: [agentTool] });
  sessions.push(session);
  const state = session.state!;
  state.ctx.ownerId = session.id;
  const host = makeSubAgentHost(
    {
      provider: "openai", apiKey: "FAKE-KEY", model: "fake", thinking: "off", sandbox: new Sandbox(root),
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, ownerId: session.id,
      parent: () => session.state ?? undefined,
      onBackgroundEnd: (end) => backgroundAgentEnded(session.id, end),
    },
    () => child,
  );
  state.ctx.runSubAgent = host.run;
  state.ctx.subAgents = host.control;
  return session;
}

const lastUserText = (turn: Turn): string => {
  for (let i = turn.messages.length - 1; i >= 0; i--) {
    const m = turn.messages[i];
    if (m.role === "user") return m.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  }
  return "";
};

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function agentMeta(session: Session): Record<string, unknown> | undefined {
  for (const m of session.state!.messages) {
    for (const b of m.content) if (b.t === "tool_result" && b.id === "a1") return b.meta?.subagent as Record<string, unknown>;
  }
  return undefined;
}

test("父会话收工之后后台子 agent 才跑完：自动开一轮，首条是带报告的 task-notification；卡片记录改成最终结果", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let notice = "";
  const parent = scripted(t).next(
    useTool("a1", "Agent", { prompt: "survey the modules", background: true, label: "survey" }),
    say("started it"),
    (turn) => {
      notice = lastUserText(turn);
      return say("got the report");
    },
  );
  const child = scripted(t).next(async function* () {
    await gate;
    yield* say("CHILD-REPORT-777");
  });
  const session = setup(parent, child);
  const run = startRun(session, "kick it off");
  assert.ok(run.started);
  await run.done;
  assert.equal(agentMeta(session)?.status, "running");
  release();
  await until(() => parent.inputs.length === 3 && !session.running);
  await session.runPromise;
  assert.match(notice, /^<task-notification>\nBackground sub-agent \S+ \(survey\) completed\./);
  assert.match(notice, /CHILD-REPORT-777/);
  const head = session.state!.messages.find((m) => messageKind(m) === "task-notification");
  assert.ok(head, "通知以 harness 片段落盘");
  const meta = agentMeta(session)!;
  assert.equal(meta.status, undefined);
  assert.equal(meta.ok, true);
  assert.equal(meta.text, "CHILD-REPORT-777");
});

test("用户停会话：后台子 agent 一并停下、卡片记成停止；不为它开轮，下一条用户消息时附上", async (t) => {
  let seen = "";
  const parent = scripted(t).next(
    useTool("a1", "Agent", { prompt: "long survey", background: true, label: "long" }),
    say("started"),
    (turn) => {
      seen = turn.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");
      return say("ok");
    },
  );
  const child = scripted(t);
  child.next(async function* (_turn, n) {
    const sig = child.signals[n - 1];
    await new Promise<void>((resolve) => (sig?.aborted ? resolve() : sig?.addEventListener("abort", () => resolve(), { once: true })));
    throw new Error("aborted");
  });
  const session = setup(parent, child);
  const run = startRun(session, "start it");
  await run.done;
  await until(() => child.callCount === 1);
  const report = stopSession(session.id);
  assert.equal(report.agentsStopped, 1);
  await until(() => agentMeta(session)?.status === undefined);
  assert.equal(agentMeta(session)?.stopReason, "aborted");
  await new Promise((r) => setTimeout(r, 2_500)); // 攒批的时间过了也没有开轮
  assert.equal(parent.inputs.length, 2);
  const next = startRun(session, "what happened?");
  await next.done;
  assert.match(seen, /Background sub-agent \S+ \(long\) stopped \(the user stopped this session\)/);
});

const result = (extra: Partial<SubAgentResult> = {}): SubAgentResult => ({
  ok: true, id: "zz000001", label: "late", tier: "research", model: "fake", provider: "openai", text: "LATE-REPORT",
  turns: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, editedFiles: [], trail: [], ...extra,
});

test("子 agent 在发起它的 tool_result 落进转录之前就结束：结局先记着，这一轮收尾 / 记录恢复时补上；读过外部内容的报告把父会话标上", (t) => {
  const session = setup(scripted(t), scripted(t));
  assert.equal(session.state!.externalContentSeen, false);
  backgroundAgentEnded(session.id, { id: "zz000001", toolId: "late-call", prompt: "p", result: result({ externalContent: true }), schema: false });
  _resetJobNotify(); // 只看卡片与标记，不让通知开轮
  assert.equal(session.state!.externalContentSeen, true, "K9：报告转述了外部内容");
  // 这时 tool_result 才落进转录（同一步里还有慢调用）
  session.state!.messages.push({ role: "user", content: [{ t: "tool_result", id: "late-call", ok: true, content: [], meta: { subagent: { id: "zz000001", status: "running", ok: true } } }] });
  settlePendingAgentCards(session);
  const meta = session.state!.messages.at(-1)!.content[0] as { meta?: { subagent?: Record<string, unknown> } };
  assert.equal(meta.meta?.subagent?.status, undefined);
  assert.equal(meta.meta?.subagent?.text, "LATE-REPORT");

  // 会话不在内存里（之后从盘上恢复）：恢复时写真实结局，不记成「被重启停掉」
  backgroundAgentEnded("ghost-owner", { id: "zz000002", toolId: "ghost-call", prompt: "p", result: result({ id: "zz000002", ok: false, error: "boom", stopReason: "provider_error" }), schema: false });
  _resetJobNotify();
  const messages = [{ role: "user" as const, content: [{ t: "tool_result" as const, id: "ghost-call", ok: true, content: [], meta: { subagent: { id: "zz000002", status: "running", ok: true } } }] }];
  settleStaleAgentCards("ghost-owner", messages);
  const sub = messages[0].content[0].meta.subagent as Record<string, unknown>;
  assert.equal(sub.error, "boom");
  assert.equal(sub.stopReason, "provider_error");
});

test("有后台子 agent 在跑：回滚、撤销文件改动、从这里改写都拒绝并说明", async (t) => {
  const session = setup(scripted(t), scripted(t));
  const rec = {
    id: "bgroll01", owner: session.id, label: "writer", type: "coder", tier: "coder" as const, background: true,
    status: "running" as const, startedAt: Date.now(), runs: 1, ctrl: new AbortController(), done: null, inbox: [],
  };
  registerAgent(rec);
  t.after(() => {
    (rec as { status: string }).status = "completed";
  });
  const rb = await rollbackSession(session.id, 1);
  assert.equal(rb.ok, false);
  assert.equal(rb.code, "running");
  assert.match(rb.error ?? "", /background sub-agents are still running/);
  const rs = await restoreSessionFiles(session.id, ["a.txt"]);
  assert.equal(rs.code, "running");
  const rw = await rewindSession(session.id, { ordinal: 0, text: "x" });
  assert.equal(rw.code, "running");
});

test("jobNotify 偏好关着：父会话最后一步时到的子 agent 报告被收回之后照样叫醒", async (t) => {
  await setPrefs({ jobNotify: false });
  t.after(() => setPrefs({ jobNotify: true }));
  let seen = "";
  const parent = scripted(t).next((turn) => {
    seen = lastUserText(turn);
    return say("got it");
  });
  const session = setup(parent, scripted(t));
  const notice = composeAgentNotice({ id: "zz000003", prompt: "p", result: result({ id: "zz000003", label: "late one" }), schema: false });
  // 模拟：通知已在这一轮的最后一步排进父会话，这一轮收尾时还没注入
  session.state!.queueFamily(notice, TASK_NOTIFICATION_KIND);
  jobNotifyRunEnd(session);
  await until(() => parent.inputs.length === 1 && !session.running);
  await session.runPromise;
  assert.match(seen, /Background sub-agent zz000003 \(late one\) completed/);
});

test("父会话没在跑时，后台子 agent 的破坏性命令前快照接到这个会话最新的那张检查点上（没有检查点就什么都不做）", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-idle-cp-"));
  roots.push(work);
  fs.writeFileSync(path.join(work, "a.txt"), "one\n");
  const id = `idle-cp-${Date.now()}`;
  await idleFilesSnapshot(id, work, "rm -rf gen");
  assert.equal((await listCheckpoints(id)).length, 0, "还没开过一轮：不拍");
  const rec = {
    v: 1, id, createdAt: Date.now(), updatedAt: Date.now(), title: id,
    config: { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: work, access: "workspace" },
    system: "test", messages: [], todos: [], totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] }, counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  } as unknown as PersistedSession;
  const cp = await takeCheckpoint(rec, work, "turn 1");
  assert.ok(cp, "检查点可用");
  fs.writeFileSync(path.join(work, "a.txt"), "two\n"); // 父会话收工之后后台子 agent 改的
  await idleFilesSnapshot(id, work, "rm -rf gen");
  const last = (await listCheckpoints(id)).at(-1)!;
  assert.equal(last.kind, "files");
  assert.equal(last.run, cp!.n);
  assert.match(last.label, /后台子 agent/);
});

test("收口：用户发话那一轮第一步之前就结束（被 hook 拦下 / 刚开头就停）——带进来的 quiet 通知放回去、不为它开轮；下一条消息照样附上", async (t) => {
  let seen = "";
  const parent = scripted(t).next((turn) => {
    seen = turn.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");
    return say("ok");
  });
  const session = setup(parent, scripted(t));
  const notice = composeAgentNotice({ id: "zz000004", prompt: "p", result: result({ id: "zz000004", label: "stopped one", ok: false, stopReason: "aborted" }), schema: false, cause: "user" });
  queueTaskNotice(session.id, notice, { wake: false });
  // 用户发了一条消息：攒着的通知排进这一轮的注入队列……
  jobNotifyRunStart(session, true);
  // ……可这一轮一步都没跑（UserPromptSubmit hook 拦下了）就收尾
  jobNotifyRunEnd(session);
  await new Promise((r) => setTimeout(r, 2_500)); // 攒批的时间过了
  assert.equal(parent.inputs.length, 0, "没有自己开一轮");
  const next = startRun(session, "what happened?");
  await next.done;
  assert.match(seen, /Background sub-agent zz000004 \(stopped one\) stopped \(the user stopped this session\)/, "下一条真送到模型的消息照样附上");
});

test("收口：服务退出时还没送达的子 agent 报告（攒批窗口里排着的、收尾时收回攒着的）写进转录，之后也不再开轮", async (t) => {
  const parent = scripted(t);
  const session = setup(parent, scripted(t));
  const pendingOne = composeAgentNotice({ id: "zz000005", prompt: "p", result: result({ id: "zz000005", label: "just finished" }), schema: false });
  const heldOne = composeAgentNotice({ id: "zz000006", prompt: "p", result: result({ id: "zz000006", label: "held one" }), schema: false });
  queueTaskNotice(session.id, pendingOne); // 2 秒攒批窗口里
  session.state!.queueFamily(heldOne, TASK_NOTIFICATION_KIND); // 这一轮注入队列里，收尾被收回攒着
  jobNotifyRunEnd(session);
  recordUndeliveredAgentNotices();
  const notes = session.state!.messages.filter((m) => messageKind(m) === TASK_NOTIFICATION_KIND).map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));
  assert.ok(notes.some((n) => n.includes("zz000005 (just finished) completed")), notes.join("\n---\n"));
  assert.ok(notes.some((n) => n.includes("zz000006 (held one) completed")));
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(parent.inputs.length, 0, "写进转录的不再另开一轮");
});
