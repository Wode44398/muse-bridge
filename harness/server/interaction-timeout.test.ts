// P7（A8b、X62；#6）：阻塞交互的倒计时兜底。修前：忘了开离开模式时，一张没人看的问答 / 权限 / 计划卡让这一轮
// 永远挂着（还占着并发名额），直到有人点停止。现在到点按各自的方式落定：提问按合理假设继续（auto 档等 10 分钟、
// plan 档等一小时）；权限卡按拒绝处理（fail-closed，文案说明是超时、不是拒绝，也别换条路绕过去）；计划没人审就
// 保持 plan、以计划收尾。卡片带 deadlineAt，作废时 *_cancelled 带 reason: "timeout"。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { PermissionMode } from "./agent/permissions.ts";
import { AgentState } from "./agent/state.ts";
import { createSession, dropSession, startRun, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { markRead } from "./test-harness/trajectory.ts";
import { askUserQuestionTool } from "./tools/ask.ts";
import { editTool } from "./tools/edit.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import type { Tool } from "./tools/types.ts";

// 10 分钟 × 0.0002 = 120 毫秒；一小时 = 720 毫秒
const SCALE = "0.0002";

async function runWithTimeouts(t: TestContext, tools: Tool[], first: ReturnType<typeof calls>, opts: { ask?: string[]; mode?: PermissionMode } = {}) {
  const prev = process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE;
  process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE = SCALE;
  t.after(() => {
    if (prev === undefined) delete process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE;
    else process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE = prev;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p7-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "a\n");
  // plan 档不调 ExitPlanMode 就收尾会被提醒一次——always 接住那次（以及任何多出来的收尾调用）
  const adapter = scripted(t).next(first).always(say("done"));
  const mode = opts.mode ?? "auto";
  const session = createSession();
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: tools.map((tool) => tool.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(tools.map((tool) => [tool.def.name, tool])),
    permissionMode: mode,
    permissionRules: { allow: [], deny: [], ask: opts.ask ?? [] },
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: mode, workspace: root, access: "workspace" };
  markRead(session.state.ctx, ["a.ts"], "a\n"); // P11：没 Read 过的 Edit 在弹卡之前就被否决
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "开始");
  // 截止时间按卡片出现的那一刻算（run 起步要先做召回等，不能按 startRun 算）
  watchSession(session, (ev) => events.push({ ...ev, receivedAt: Date.now() }));
  await run.done;
  const toolText = session.state.messages
    .flatMap((m) => m.content)
    .filter((b) => b.t === "tool_result")
    .map((b) => (b.t === "tool_result" ? b.content.map((c) => (c.t === "text" ? c.text : "")).join("") : ""))
    .join("\n");
  dropSession(session.id);
  return { events, toolText, root };
}

// 卡片从出现到截止有多久
const windowOf = (ev: Record<string, unknown>) => (ev.deadlineAt as number) - (ev.receivedAt as number);

test("P7: a permission card nobody answers fails closed at its deadline — marked as a timeout, not a refusal", async (t) => {
  const r = await runWithTimeouts(t, [editTool], calls(call("e1", "Edit", { path: "a.ts", old_string: "a", new_string: "b" })), { ask: ["Edit"] });
  const ask = r.events.find((e) => e.e === "permission_ask");
  assert.ok(ask && typeof ask.deadlineAt === "number", "卡片带着截止时间");
  const window = windowOf(ask);
  assert.ok(window > 0 && window <= 150, `10 分钟按比例缩成 120ms，实际 ${window}ms`);
  assert.ok(r.events.some((e) => e.e === "permission_cancelled" && e.id === ask.id && e.reason === "timeout"), "所有设备收到超时作废");
  assert.match(r.toolText, /not approved: nobody answered within 10 minutes \(this is not a refusal\)\. Do not try to achieve the same effect/);
  assert.equal(fs.readFileSync(path.join(r.root, "a.ts"), "utf8"), "a\n", "按拒绝处理，文件没改");
});

test("P7: a question nobody answers — auto mode gives up after 10 minutes, plan mode waits an hour — then the agent goes on its assumptions", async (t) => {
  const question = { questions: [{ header: "方案", question: "走哪条？", options: [{ label: "A" }, { label: "B" }] }] };
  const auto = await runWithTimeouts(t, [askUserQuestionTool], calls(call("q1", "AskUserQuestion", question)));
  const autoAsk = auto.events.find((e) => e.e === "ask")!;
  assert.ok(auto.events.some((e) => e.e === "ask_cancelled" && e.id === autoAsk.id && e.reason === "timeout"));
  assert.match(auto.toolText, /Nobody answered within 10 minutes, so the question expired[\s\S]*list the assumptions/);

  const plan = await runWithTimeouts(t, [askUserQuestionTool], calls(call("q2", "AskUserQuestion", question)), { mode: "plan" });
  assert.match(plan.toolText, /Nobody answered within 60 minutes/);
  const planAsk = plan.events.find((e) => e.e === "ask")!;
  const autoWindow = windowOf(autoAsk);
  const planWindow = windowOf(planAsk);
  assert.ok(planWindow > autoWindow * 4, `plan 档等得久得多（${planWindow}ms 对 ${autoWindow}ms）`);
});

test("P7: an unreviewed plan times out into staying in plan mode and ending with the plan — never into an approval", async (t) => {
  const r = await runWithTimeouts(t, [exitPlanModeTool], calls(call("p1", "ExitPlanMode", { plan: "1. 改 a.ts" })), { mode: "plan" });
  const ask = r.events.find((e) => e.e === "plan_ask");
  assert.ok(ask && typeof ask.deadlineAt === "number");
  assert.ok(r.events.some((e) => e.e === "plan_cancelled" && e.id === ask.id && e.reason === "timeout"));
  assert.match(r.toolText, /Nobody reviewed the plan within 60 minutes\. Stay in plan mode/);
  assert.equal(r.events.some((e) => e.e === "plan_resolved"), false, "没人审过，不能当成批准");
});
