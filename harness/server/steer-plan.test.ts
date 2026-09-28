// 清单 #75/#76/#77：运行中插话、plan 模式批准、规则问询三条阻塞链路的端到端契约。
// 都用脚本化的假 provider 驱动真 loop + 真 session，不打任何外部 API。
// Q1：迁到共享脚本化 provider（test-harness/）。模型一共被调了几次由收尾的 assertDone 兜底——以前手写的
// else 分支让多调几次也照样绿（插话 / 计划提醒那两条原来只断言了「至少 / 大约几次」）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { AgentState, visibleMessages } from "./agent/state.ts";
import type { Turn } from "./agent/turn.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import {
  createSession,
  dropSession,
  resolvePermission,
  resolvePlan,
  startRun,
  steerSession,
  watchSession,
  type Session,
} from "./session.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import { readTool } from "./tools/read.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
// 基线来自 test-setup.ts 的全局临时目录——还原而不是 delete，否则后续用例落回生产 sessions/。
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const TOOLS = [memoryAuditTool, exitPlanModeTool, readTool];

function attach(session: Session, adapter: ProviderAdapter, root: string, mode: "auto" | "plan" = "auto"): AgentState {
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    completeMemoryAudit: (d, r) => state.completeMemoryAudit(d, r),
  };
  state = new AgentState({
    adapter,
    system: "test",
    tools: TOOLS.map((t) => t.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(TOOLS.map((t) => [t.def.name, t])),
    permissionMode: mode,
    permissionRules: { allow: [], deny: [], ask: ["Read(*)"] },
  });
  session.state = state;
  session.cfg = {
    provider: "openai",
    model: "fake",
    thinking: "off",
    permissionMode: mode,
    workspace: root,
    access: "workspace",
  };
  return state;
}

// 收尾用的审计调用（loop 的 MemoryAudit 门禁要求）
const audit = () =>
  useTool("audit", "MemoryAudit", { decision: "none", reason: "Synthetic test turn produces no durable project knowledge." });

// 模型每次调用时看到的 user 文本（插话 / 提醒是否真的进了上下文全靠它）
const userTexts = (t: Turn): string[] =>
  t.messages.filter((m) => m.role === "user").map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));

test("a message sent mid-run is injected at the next turn boundary", { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-steer-");
  let held = true;
  const adapter = scripted(t).next(
    async function* (): AsyncIterable<StreamEvent> {
      yield { e: "text_delta", text: "working" };
      while (held) await new Promise((r) => setTimeout(r, 5)); // 等测试插话
      yield { e: "turn_done", stopReason: "end" };
    },
    audit(),
    say("done"),
  );
  const session = createSession();
  attach(session, adapter, root);
  const events: any[] = [];
  const run = startRun(session, "原任务");
  watchSession(session, (ev) => events.push(ev));
  // 等待失败也必须放行假 provider：否则 while(held) 让本测试进程永不退出，全量并发时整套挂死。
  try {
    await waitFor(() => events.some((e) => e.e === "text_delta" && e.text === "working"));
    // 运行中插话：立即 fanout（所有设备可见），随后在回合边界注入
    const steered = steerSession(session, "改成蓝色");
    assert.equal(steered.ok, true);
    assert.equal(typeof steered.id, "string", "U2：没带 id 时服务端补一个");
    assert.ok(events.some((e) => e.e === "steer_queued" && e.text === "改成蓝色"));
  } finally {
    held = false;
  }
  await run.done;

  assert.ok(events.some((e) => e.e === "steer_applied" && e.text === "改成蓝色"));
  // 第一轮看不到插话；插话之后的某一轮必须看到（且带「插话」前缀标记）
  const seen = adapter.inputs.map(userTexts);
  assert.equal(seen[0].some((p) => p.includes("改成蓝色")), false, "插话不能溯及已发出的那一轮");
  const later = seen.slice(1).flat().join("\n");
  assert.match(later, /改成蓝色/);
  assert.match(later, /运行中插话/);
  // #78：插话恰好赶上「审计前的收尾」——模型下一轮只交了审计，以前 loop 就拿插话之前那句「working」收工，
  // 插话没人回应（第三步脚本从没被用上，手写假模型的 else 分支掩盖了这件事）。
  const finals = visibleMessages(session.state!.messages)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.t === "text").map((b) => (b.t === "text" ? b.text : "")));
  assert.equal(finals.at(-1), "done", "插话之后的回应才是最终答复");
  dropSession(session.id);
});

test("steering keeps a finishing run alive instead of dropping the message", { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-steer-tail-");
  const session = createSession();
  const adapter = scripted(t).next(
    audit(), // 关掉记忆门禁，让下一轮的「无工具收尾」成为真收尾
    // 第二轮就是收尾轮：插话必须让 loop 再转一圈而不是结束
    function* (): Iterable<StreamEvent> {
      steerSession(session, "等一下，别提交");
      yield* say("答完了");
    },
    say("答完了"),
  );
  attach(session, adapter, root);
  const events: any[] = [];
  const run = startRun(session, "任务");
  watchSession(session, (ev) => events.push(ev));
  await run.done;

  assert.ok(events.some((e) => e.e === "steer_applied" && e.text === "等一下，别提交"), "插话最终被注入");
  // 收尾轮遇到插话继续转了一圈（恰好三次调用由收尾的 assertDone 核对）
  dropSession(session.id);
});

test("plan mode blocks writes, and approving flips the session to auto in the same run", { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-plan-");
  const adapter = scripted(t).next(
    useTool("p1", "ExitPlanMode", { plan: "1. 改 a.ts\n2. 跑测试" }),
    audit(),
    say("开始执行"),
  );
  const session = createSession();
  const state = attach(session, adapter, root, "plan");
  const events: any[] = [];
  const run = startRun(session, "帮我改个东西");
  watchSession(session, (ev) => events.push(ev));

  await waitFor(() => events.some((e) => e.e === "plan_ask"));
  const ask = events.find((e) => e.e === "plan_ask");
  assert.match(ask.plan, /改 a\.ts/);
  assert.equal(state.permissionMode, "plan", "批准前仍是 plan");

  assert.equal(resolvePlan(session, ask.id, true), true);
  await run.done;

  assert.equal(state.permissionMode, "auto", "批准后同一轮内切到自主执行");
  assert.ok(events.some((e) => e.e === "plan_resolved" && e.approved === true));
  assert.ok(events.some((e) => e.e === "mode" && e.permissionMode === "auto"));
  assert.equal(session.cfg?.permissionMode, "auto", "模式要落到会话快照里（重开不回 plan）");
  // 落定后再点一次 = 幂等 no-op
  assert.equal(resolvePlan(session, ask.id, true), false);
  dropSession(session.id);
});

test("an ask rule blocks the call until the user decides; deny reaches the model as a tool error", { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-perm-");
  fs.writeFileSync(path.join(root, "a.txt"), "hello");
  const adapter = scripted(t).next(useTool("r1", "Read", { path: "a.txt" }), audit(), say("好"));
  const session = createSession();
  attach(session, adapter, root); // rules.ask = ["Read(*)"]
  const events: any[] = [];
  const run = startRun(session, "读一下 a.txt");
  watchSession(session, (ev) => events.push(ev));

  await waitFor(() => events.some((e) => e.e === "permission_ask"));
  const req = events.find((e) => e.e === "permission_ask");
  assert.equal(req.tool, "Read");
  assert.equal(req.subject, "a.txt");
  assert.equal(req.rule, "Read(*)");
  // 还没裁决时，工具不该已经跑完
  assert.equal(events.some((e) => e.e === "tool_end" && e.id === "r1"), false);

  assert.equal(resolvePermission(session, req.id, "deny"), true);
  await run.done;
  assert.ok(events.some((e) => e.e === "permission_resolved" && e.decision === "deny"));
  assert.ok(events.some((e) => e.e === "tool_permission" && e.decision === "deny"));
  // 第二次调用时模型看到的上一条结果必须是「被拒」，并且看得见原因
  assert.match(JSON.stringify(adapter.inputs[1].messages.at(-1)), /Denied by permission policy/);
  dropSession(session.id);
});

test('"allow for this session" stops asking again for the same call', { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-perm-session-");
  fs.writeFileSync(path.join(root, "a.txt"), "hello");
  const adapter = scripted(t).next(
    useTool("r1", "Read", { path: "a.txt" }),
    useTool("r2", "Read", { path: "a.txt" }),
    audit(),
    say("done"),
  );
  const session = createSession();
  const state = attach(session, adapter, root);
  const events: any[] = [];
  const run = startRun(session, "读两次");
  watchSession(session, (ev) => events.push(ev));

  await waitFor(() => events.some((e) => e.e === "permission_ask"));
  const first = events.find((e) => e.e === "permission_ask");
  assert.equal(resolvePermission(session, first.id, "session"), true);
  await run.done;

  // 第二次同形调用不应再问：全程只有一张权限卡
  assert.equal(events.filter((e) => e.e === "permission_ask").length, 1);
  // P5：记的是一字不差的字面规则（Tool(=原文)），原文里的 * ? 不再当通配符
  assert.ok(state.effectiveRules().allow.includes("Read(=a.txt)"), "本会话 allow 规则已追加");
  assert.equal(events.filter((e) => e.e === "tool_end" && e.name === "Read").length, 2, "两次读都真的跑了");
  dropSession(session.id);
});

// 实测发现：plan 模式下模型可能直接用散文答「我的计划是…」而不调 ExitPlanMode，
// 用户于是永远等不到批准卡。收尾前必须提醒一次；且只提醒一次（纯问句在 plan
// 模式下直接回答是对的，不该被逼着交计划）。
test("plan mode nudges once when the model tries to finish without ExitPlanMode", { timeout: 15_000 }, async (t) => {
  const root = temp("dimensio-plan-nudge-");
  // 先关掉记忆门禁，把「无工具收尾」暴露给 plan 门禁；之后每次都只用散文收尾，永不调 ExitPlanMode。
  // 提醒一次之后模型仍不交计划 → 接受它的回答收工，不能无限缠斗：恰好三次调用（收尾的 assertDone 核对）。
  const adapter = scripted(t).next(audit(), say("我的计划是先改 a.ts"), say("我的计划是先改 a.ts"));
  const session = createSession();
  const state = attach(session, adapter, root, "plan");
  const run = startRun(session, "帮我加个功能");
  await run.done;

  assert.equal(state.planNudges, 1, "提醒恰好一次");
  assert.match(adapter.inputs.map(userTexts).flat().join(" "), /ExitPlanMode/, "提醒内容点名了 ExitPlanMode");
  assert.equal(state.permissionMode, "plan", "没批准就还在 plan");
  dropSession(session.id);
});
