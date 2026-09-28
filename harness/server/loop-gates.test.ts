// Q1（K45）+ F9：loop 门禁先后顺序的场景清单。每个场景一段事件轨迹快照（t.assert.snapshot）钉住「一轮之内各道
// 门禁谁先谁后」，另配一两条不变量断言管语义。以后大改 loop（批 2R：reactive compact、重试、交互超时……）时，
// 顺序一变，快照 diff 就出现在提交里。
//
// 纪律（hermes 修订，写进 harness/AGENTS.md）：快照只用于这类「顺序本身就是契约」的场景，其余写不变量；
// 快照 diff 必须有人看过——不许为了让测试变绿去跑 --test-update-snapshots，也不许改被测场景的清单。
import assert from "node:assert/strict";
import test from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { visibleMessages } from "./agent/state.ts";
import type { AgentState } from "./agent/state.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { fail, ok, type Tool } from "./tools/types.ts";

const RAW = { serializers: [(v: unknown) => String(v)] };
const schema = { type: "object" as const, properties: {} };

const edit: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Edit", description: "fake edit", parameters: schema },
  async run() {
    return ok("edited", "edited");
  },
};

const bash: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Bash", description: "fake bash", parameters: schema },
  async run(args) {
    const passed = args.pass === true;
    return {
      ...(passed ? ok("test passed", "exit 0") : fail("test failed", "exit 1")),
      verification: { passed, detail: passed ? "npm test (exit 0)" : "npm test (exit 1)" },
    };
  },
};

const memoryAudit = () =>
  useTool("audit", "MemoryAudit", { decision: "none", reason: "This synthetic gate scenario produces no durable project knowledge." });

function visibleFinals(state: AgentState): string[] {
  return visibleMessages(state.messages)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.t === "text").map((b) => (b.t === "text" ? b.text : "")));
}

test("F9-1 验证门禁：编辑后想直接收尾 → 撤回并追问 → 验证通过 → 记忆审计（对用户隐藏）→ 以审计前那句收工", async (t) => {
  const adapter = scripted(t).next(
    useTool("e1", "Edit", { path: "a.ts" }),
    say("改好了"),
    useTool("v1", "Bash", { command: "npm test", verify: true, pass: true }),
    say("验证通过，改好了"),
    memoryAudit(),
  );
  const { state } = loopState(t, adapter, { tools: [edit, bash, memoryAuditTool], memoryAudit: true, user: "把 a.ts 改一下" });
  const { events, trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.equal(events.filter((e) => e.e === "turn_discard").length, 1, "没验证的那版被撤回");
  assert.deepEqual(visibleFinals(state), ["验证通过，改好了"]);
});

test("F9-2 验证门禁追问用尽（V2）：三次追问都不验证 → 第四版放行并附「未验证」尾注", async (t) => {
  const adapter = scripted(t).next(
    useTool("e1", "Edit", { path: "a.ts" }),
    say("好了 1"),
    say("好了 2"),
    say("好了 3"),
    say("好了 4"),
  );
  const { state } = loopState(t, adapter, { tools: [edit, bash], finalFootnotes: true, user: "把 a.ts 改一下" });
  const { events, trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.equal(events.filter((e) => e.e === "turn_discard").length, 3);
  assert.equal(state.verificationGateGaveUp, true);
  assert.match(visibleFinals(state).join("\n"), /未验证/);
});

test("F9-3 输出被截断：stop=length → 续写提示 → 完整答复", async (t) => {
  const adapter = scripted(t).next(say("前半段", "length"), say("后半段"));
  const { state } = loopState(t, adapter, { user: "写一段长的" });
  const { trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.equal(state.lengthContinues, 0, "续写成功后计数归零");
});

test("F9-4 记忆审计门禁：无工具收尾 → 追问审计（对用户隐藏）→ 交审计 → 以审计前那句收工", async (t) => {
  const adapter = scripted(t).next(say("答复"), memoryAudit());
  const { state } = loopState(t, adapter, { tools: [memoryAuditTool], memoryAudit: true, user: "问个问题" });
  const { trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.equal(state.memoryAuditCompleted, true);
  assert.deepEqual(visibleFinals(state), ["答复"]);
});

test("F9-5 插话赶上审计前的收尾（#78）：插话注入后模型只交审计 → 不拿旧答复收工 → 回应插话后才收尾", async (t) => {
  let state!: AgentState;
  const adapter = scripted(t).next(
    function* (): Iterable<StreamEvent> {
      state.queueSteer("改成蓝色", "steer-1"); // 用户在这一轮收尾时插话
      yield* say("working");
    },
    memoryAudit(),
    say("改成蓝色了"),
  );
  ({ state } = loopState(t, adapter, { tools: [memoryAuditTool], memoryAudit: true, user: "做个按钮" }));
  const { trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.equal(visibleFinals(state).at(-1), "改成蓝色了");
});

test("F9-6 连接中断与限流：抛错 → 429（按 Retry-After）→ 重试成功", async (t) => {
  const adapter = scripted(t).next(
    { throws: "synthetic connection reset" },
    [{ e: "error", kind: "http_429", retriable: true, retryAfterMs: 1, raw: "rate limited" }],
    say("ok"),
  );
  const { state } = loopState(t, adapter, { user: "hi" });
  const { events, trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.deepEqual(events.filter((e) => e.e === "context" && e.retry).map((e) => (e as { retry?: number }).retry), [1, 2]);
});

test("F9-7 plan 模式没交计划就想收尾：提醒一次 → 仍用散文作答 → 接受收工（不无限缠斗）", async (t) => {
  const adapter = scripted(t).next(say("我的计划是先改 a.ts"), say("我的计划是先改 a.ts，再跑测试"));
  const { state } = loopState(t, adapter, { tools: [exitPlanModeTool], permissionMode: "plan", user: "帮我加个功能" });
  const { trajectory } = await drive(state, adapter);
  t.assert.snapshot(trajectory, RAW);
  assert.equal(state.planNudges, 1);
  assert.equal(state.permissionMode, "plan");
});
