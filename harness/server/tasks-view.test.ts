import assert from "node:assert/strict";
import test from "node:test";
import {
  STALL_MS,
  agentBatchOf,
  agentView,
  batchCounts,
  batchElapsed,
  collectTasks,
  deriveWorkflow,
  dotCells,
  fmtDur,
  fmtTokens,
  splitTasks,
  toolTaskStatus,
  toolTaskTitle,
  workflowNameFromScript,
} from "../web/src/lib/tasks.ts";

// 工作区「任务」面板 / 工作流卡的纯函数层（web/src/lib/tasks.ts）。

const run = (id: string, status: "running" | "ok" | "fail", extra: Record<string, unknown> = {}) =>
  ({ id, label: id, status, tokens: 0, ...extra }) as any;

test("task status: the run record wins; interrupted / aborted runs read as stopped", () => {
  assert.equal(toolTaskStatus({ name: "Agent", status: "running" }), "running");
  assert.equal(toolTaskStatus({ name: "Agent", status: "running", agent: run("a", "running") }), "running");
  // The tool row ended but the run never got its end event → it was cut off.
  assert.equal(toolTaskStatus({ name: "Agent", status: "fail", agent: run("a", "running") }), "stopped");
  assert.equal(toolTaskStatus({ name: "Agent", status: "ok", agent: run("a", "ok") }), "completed");
  assert.equal(toolTaskStatus({ name: "Agent", status: "ok", agent: run("a", "fail", { error: "provider died" }) }), "failed");
  assert.equal(toolTaskStatus({ name: "Workflow", status: "fail", workflow: { status: "fail", error: "workflow aborted" } }), "stopped");
  // History rows without a tool_result are rebuilt as「已中断」.
  assert.equal(toolTaskStatus({ name: "Workflow", status: "fail", summary: "已中断：未拿到结果" }), "stopped");
  assert.equal(toolTaskStatus({ name: "Workflow", status: "fail", summary: "bad workflow meta" }), "failed");
});

test("titles fall back to the script's meta name / label / the prompt's first line", () => {
  assert.equal(workflowNameFromScript("export const meta = {\n  name: 'review-changes',\n  description: 'x' }"), "review-changes");
  assert.equal(workflowNameFromScript("log(1)"), "");
  assert.equal(
    toolTaskTitle({ name: "Workflow", args: { script: `export const meta = { description: "d", name: "sweep" }` } }),
    "sweep",
  );
  assert.equal(toolTaskTitle({ name: "Workflow", args: {}, workflow: { name: "live-name", status: "running" } }), "live-name");
  assert.equal(toolTaskTitle({ name: "Workflow", args: {} }), "工作流");
  assert.equal(toolTaskTitle({ name: "Agent", args: { prompt: "  找出所有调用方\n细节…" } }), "找出所有调用方");
  assert.equal(toolTaskTitle({ name: "Agent", args: { label: "survey", prompt: "p" } }), "survey");
});

test("collect + split: only Agent/Workflow rows; running oldest-first, finished newest-first", () => {
  const tl = [
    { kind: "user", text: "hi" },
    { kind: "tool", id: "t1", name: "Read", status: "ok", args: {} },
    { kind: "tool", id: "t2", name: "Agent", status: "ok", args: {}, agent: run("a1", "ok", { startedAt: 100, durationMs: 50 }) },
    { kind: "tool", id: "t3", name: "Workflow", status: "running", args: {}, workflow: { status: "running", startedAt: 300, agents: [] } },
    { kind: "tool", id: "t4", name: "Agent", status: "ok", args: {}, agent: run("a2", "ok", { startedAt: 200, durationMs: 10 }) },
    { kind: "tool", id: "t5", name: "Agent", status: "running", args: {}, agent: run("a3", "running", { startedAt: 250 }) },
  ];
  const tasks = collectTasks(tl);
  assert.deepEqual(tasks.map((t) => t.key), ["t2", "t3", "t4", "t5"]);
  assert.deepEqual(tasks.map((t) => t.kind), ["agent", "workflow", "agent", "agent"]);
  const { running, finished } = splitTasks(tasks);
  assert.deepEqual(running.map((t) => t.key), ["t5", "t3"]);
  assert.deepEqual(finished.map((t) => t.key), ["t4", "t2"]); // ended at 210 vs 150
});

test("deriveWorkflow: meta order + late phases + loose group; phase status and counts", () => {
  const wf = {
    status: "running" as const,
    currentPhase: "Verify",
    phases: [{ title: "Review" }, { title: "Verify", detail: "one per finding" }, { title: "Report" }],
    agents: [
      run("r1", "ok", { phase: "Review", tokens: 100 }),
      run("r2", "fail", { phase: "Review", tokens: 50 }),
      run("v1", "running", { phase: "Verify", lastAt: 1000 }),
      run("x1", "running", { phase: "Extra" }),
      run("l1", "ok"),
    ],
  };
  const d = deriveWorkflow(wf, { now: 1000 + STALL_MS + 1 });
  assert.deepEqual(d.phases.map((p) => p.title), ["Review", "Verify", "Report", "Extra", ""]);
  assert.deepEqual(d.phases.map((p) => p.status), ["error", "running", "pending", "running", "done"]);
  assert.equal(d.phases[1].detail, "one per finding");
  assert.equal(d.phases[1].counts.stalled, 1);
  assert.deepEqual({ ...d.counts }, { done: 2, running: 2, stalled: 1, error: 1, pending: 0, total: 5 });
  assert.equal(d.tokens, 150);
  // Once the workflow is over, agents still marked running were cut off (red), nothing reads as running.
  const over = deriveWorkflow({ ...wf, status: "fail" });
  assert.ok(over.phases.every((p) => p.status !== "running"));
  assert.equal(over.counts.error, 3);
  assert.equal(over.phases[2].status, "pending");
});

test("dotCells: one cell per agent when it fits; proportional with a floor of one when it doesn't", () => {
  assert.deepEqual(
    dotCells({ done: 1, running: 2, stalled: 1, error: 1, pending: 0, total: 4 }, 36),
    ["done", "running", "stalled", "error"],
  );
  const big = dotCells({ done: 90, running: 5, stalled: 0, error: 1, pending: 4, total: 100 }, 20);
  assert.equal(big.length, 20);
  assert.ok(big.includes("error") && big.includes("pending") && big.includes("running"));
  assert.equal(dotCells({ done: 0, running: 0, stalled: 0, error: 0, pending: 0, total: 0 }, 10).length, 0);
});

test("duration / token formatting", () => {
  assert.equal(fmtDur(0), "0s");
  assert.equal(fmtDur(59_999), "59s");
  assert.equal(fmtDur(65_000), "1m 05s");
  assert.equal(fmtDur(3_723_000), "1h 02m");
  assert.equal(fmtDur(undefined), "");
  assert.equal(fmtTokens(0), "");
  assert.equal(fmtTokens(950), "950");
  assert.equal(fmtTokens(1000), "1k");
  assert.equal(fmtTokens(1_500), "1.5k");
  assert.equal(fmtTokens(12_345), "12k");
  assert.equal(fmtTokens(2_000_000), "2M");
});

test("agentBatchOf: the run of adjacent Agent rows around a tool id (one parallel batch)", () => {
  const tl = [
    { kind: "tool", id: "r", name: "Read", status: "ok", args: {} },
    { kind: "tool", id: "a1", name: "Agent", status: "ok", args: {} },
    { kind: "tool", id: "a2", name: "Agent", status: "ok", args: {} },
    { kind: "text", text: "…" },
    { kind: "tool", id: "a3", name: "Agent", status: "ok", args: {} },
  ];
  assert.deepEqual(agentBatchOf(tl, "a2").map((x) => x.id), ["a1", "a2"]);
  assert.deepEqual(agentBatchOf(tl, "a3").map((x) => x.id), ["a3"]);
  assert.deepEqual(agentBatchOf(tl, "r"), []);
  assert.deepEqual(agentBatchOf(tl, "nope"), []);
});

test("agentView: one reading for the card / stack row / task row; a stopped turn reads its running agents as stopped", () => {
  const steps = [
    { id: "s1", name: "Read", arg: "a.ts", status: "ok" },
    { id: "s2", name: "Grep", arg: "foo", status: "running" },
  ];
  const live = {
    name: "Agent", status: "running", args: { prompt: "调研鉴权\n细节", tools: "coder" },
    agent: run("a", "running", { tier: "coder", model: "accounts/x/models/kimi-k2", steps, toolCalls: 2, tokens: 1200, startedAt: 1000, lastAt: 5000 }),
  };
  const v = agentView(live, { now: 6000, chatRunning: true });
  assert.equal(v.status, "running");
  assert.equal(v.tier, "coder");
  assert.equal(v.model, "kimi-k2");
  assert.equal(v.calls, 2);
  assert.equal(v.time, "5s");
  assert.deepEqual(v.step, { id: "s2", name: "Grep", arg: "foo" });
  assert.equal(v.stalled, false);
  // The last step stays up after it ends (the model is thinking about the next one) — the line must not blank out.
  steps[1].status = "ok";
  assert.equal(agentView(live, { now: 6000, chatRunning: true }).step?.id, "s2");
  // No events for a long while → stalled; rate-limit suspension is its own flag and wins over stalled.
  assert.equal(agentView(live, { now: 5000 + STALL_MS + 1, chatRunning: true }).stalled, true);
  const waiting = { ...live, agent: { ...live.agent, suspendedUntil: 9000 } };
  const w = agentView(waiting, { now: 6000, chatRunning: true });
  assert.equal(w.suspended, true);
  assert.equal(w.stalled, false);
  // The turn was stopped while the agent was still marked running → stopped, no live step, no ticking clock.
  const cut = agentView(live, { now: 6000, chatRunning: false });
  assert.equal(cut.status, "stopped");
  assert.equal(cut.step, null);
  assert.equal(cut.time, "");
  // Before subagent_start there is no run: tier falls back to the tool args, the title to the prompt's first line.
  const pre = agentView({ name: "Agent", status: "running", args: { prompt: "调研鉴权\n细节", tools: "coder" } }, { now: 0, chatRunning: true });
  assert.equal(pre.title, "调研鉴权");
  assert.equal(pre.tier, "coder");
  assert.equal(pre.step, null);
  // Failure carries the first line of the error.
  const bad = agentView({ name: "Agent", status: "fail", args: {}, agent: run("b", "fail", { error: "provider died\nstack…", durationMs: 3000, startedAt: 1 }) }, { now: 0, chatRunning: false });
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "provider died");
  assert.equal(bad.time, "3s");
});

test("batch counts / wall clock across a parallel batch", () => {
  const tools = [
    { name: "Agent", status: "ok", args: {}, agent: run("a", "ok", { startedAt: 1000, durationMs: 4000 }) },
    { name: "Agent", status: "fail", args: {}, agent: run("b", "fail", { error: "boom", startedAt: 2000, durationMs: 9000 }) },
    { name: "Agent", status: "running", args: {}, agent: run("c", "running", { startedAt: 3000 }) },
  ];
  const views = tools.map((x) => agentView(x, { now: 20_000, chatRunning: true }));
  assert.deepEqual(batchCounts(views), { total: 3, running: 1, failed: 1, stopped: 0, done: 1 });
  assert.equal(batchElapsed(tools, true, 20_000), "19s"); // earliest start → now
  assert.equal(batchElapsed(tools.slice(0, 2), false, 20_000), "10s"); // earliest start → latest end
  assert.equal(batchElapsed([{ name: "Agent", status: "ok", args: {} }], false, 0), ""); // old sessions: no timestamps
});
