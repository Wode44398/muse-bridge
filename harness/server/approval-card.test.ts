// P11（ZCode C1 / C2、kimi K20）：权限卡说人话 + 审批载荷 = 执行事实 + 出卡之前的规划阶段（Workflow 确认进统一权限闸）。
//
// 修前：卡上只有「规则名 + 工具名 + 主体」——为什么问你（强推会改写远端历史？这是控制面文件？）只写在回给模型的英文里；
// Edit 的卡看不到改什么、Write 的卡看不到写什么；注定会被拦的命令（有 ask 规则时的 `rm -rf /`）先弹一张卡、批了才被拦；
// Workflow 的确认在工具的 run() 里另弹一张卡：没人在场（子 agent、无头）就不问直接跑，用户写的 allow 规则放不开它，
// 判定不进权限审计。
// 修后：每种转问都带一句中文原因；卡上摆这次真正要执行的东西（命令、改前 / 改后、写入内容的开头、工作流脚本）；工具的
// prepare() 在判定之前把注定失败的否决掉（不弹卡）、要确认的交给统一权限闸（没人在场 → 不批、不跑）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { runAgent } from "./agent/loop.ts";
import { approvalPreview, PREVIEW_CAP } from "./agent/approval-preview.ts";
import { decide, DeniedTargets, TOOL_CONFIRM_RULE } from "./agent/permissions.ts";
import { pendingInteractions, startRun, watchSession } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { workflowTool } from "./tools/workflow.ts";
import { writeTool } from "./tools/write.ts";
import { ok, type Tool, type ToolContext, type WorkflowRequest } from "./tools/types.ts";
import { reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

const stub = (name: string, effect: Tool["effect"]): Tool => ({
  effect,
  concurrencySafe: false,
  def: { name, description: name, parameters: { type: "object", properties: {} } },
  async run() {
    return ok("ran", "ok");
  },
});
const TOOLS = new Map<string, Tool>([
  ["Bash", bashTool],
  ["Write", stub("Write", "write")],
  ["Workflow", workflowTool],
]);
const CJK = /[一-鿿]/;

test("P11 卡片说人话：每种转问都带一句中文原因（回给模型的英文不变）", () => {
  const root = tmp("dimensio-p11-");
  const why = (tool: string, args: Record<string, unknown>, rules = { allow: [] as string[], deny: [] as string[], ask: [] as string[] }, extra = {}) => {
    const d = decide("auto", tool, TOOLS, args, rules, { root, ...extra });
    assert.equal(d.effect, "ask", `${tool} ${JSON.stringify(args)} 应转问`);
    assert.ok(d.why && CJK.test(d.why), `应有中文原因：${d.why}`);
    assert.ok(d.reason && !CJK.test(d.reason), "回给模型的仍是英文");
    return d.why;
  };
  assert.match(why("Bash", { command: "git push --force origin main" }), /强推/);
  assert.match(why("Bash", { command: 'rm -rf "$TARGET"/' }), /运行时才知道/);
  assert.match(why("Write", { path: path.join(root, "AGENTS.md") }), /控制面文件/);
  assert.match(why("Write", { path: "~/.bashrc" }), /启动文件/);
  const denied = new DeniedTargets();
  denied.record("Write", { path: "src/a.ts" }, null, root);
  assert.match(why("Write", { path: "src/a.ts" }, undefined, { denied }), /刚拒绝过/);
  assert.match(why("Bash", { command: "echo hi" }, { allow: [], deny: [], ask: ["Bash(echo:*)"] }), /你设的规则/);
  assert.match(why("Workflow", { script: "x" }, undefined, { confirm: { reason: "starting a workflow", why: "要启动工作流「x」" } }), /要启动工作流/);
});

test("P11 执行事实：Bash 是命令原文、Edit 是改前 / 改后、Write 是写入内容的开头；长的截断并标出来", () => {
  assert.deepEqual(approvalPreview("Bash", { command: "git push --force origin main", background: true }), {
    kind: "command",
    command: "git push --force origin main",
    background: true,
  });
  assert.deepEqual(approvalPreview("Edit", { path: "AGENTS.md", old_string: "a", new_string: "b", replace_all: true }), {
    kind: "diff",
    path: "AGENTS.md",
    old: "a",
    new: "b",
    replaceAll: true,
  });
  const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const w = approvalPreview("Write", { path: "GUIDE.md", content });
  assert.equal(w?.kind, "write");
  if (w?.kind === "write") {
    assert.equal(w.lines, 100);
    assert.equal(w.head.split("\n").length, 40, "只摆开头 40 行");
    assert.equal(w.truncated, true);
    assert.equal(w.bytes, Buffer.byteLength(content));
  }
  const long = approvalPreview("Bash", { command: "echo " + "x".repeat(PREVIEW_CAP + 10) });
  assert.equal(long?.kind === "command" ? long.command.length : 0, PREVIEW_CAP);
  assert.equal(long?.truncated, true);
  assert.equal(approvalPreview("Read", { path: "a" }), undefined, "没有执行事实可摆的工具不给");
});

// 记下自己被调用的 Bash 探针（权限视图、规划阶段借真 Bash 的）
function probeBash(ran: string[]): Tool {
  return {
    ...bashTool,
    async run(args) {
      ran.push(String(args.command));
      return ok("ran", "ok");
    },
  };
}

async function drive(state: NonNullable<ReturnType<typeof attachSession>["state"]>): Promise<void> {
  state.addUserMessage("干活");
  for await (const _ev of runAgent(state, new AbortController().signal)) {
    /* 跑完为止 */
  }
}
const resultText = (state: NonNullable<ReturnType<typeof attachSession>["state"]>, id: string) => {
  const r = state.messages.flatMap((m) => m.content).find((b) => b.t === "tool_result" && b.id === id);
  return r && r.t === "tool_result" ? JSON.stringify(r.content) : "";
};

test("P11 规划阶段：注定被拦下的调用不弹卡、直接回给模型（以前先弹一张卡，批了才被拦）", async (t) => {
  const ran: string[] = [];
  let cards = 0;
  const root = tmp("dimensio-p11-veto-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# 约定\n- 测试：npm test\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "old\n");
  const adapter = scripted(t).next(
    calls(
      call("r1", "Bash", { command: "rm -rf /" }),
      // 控制面文件（本来就要问）没 Read 就改——实测里撞到过：批了才报「先 Read」
      call("e1", "Edit", { path: "AGENTS.md", old_string: "npm test", new_string: "npm test && npm run lint" }),
      // 覆盖没读过的已有文件
      call("w1", "Write", { path: "notes.txt", content: "new\n" }),
    ),
    say("好"),
  );
  const session = attachSession(adapter, root, { tools: [probeBash(ran), editTool, writeTool] });
  const state = session.state!;
  state.permissionRules = { allow: [], deny: [], ask: ["Bash", "Write"] };
  state.ctx.requestPermission = async () => {
    cards++;
    return { decision: "once" as const };
  };
  await drive(state);
  assert.equal(cards, 0, "一张卡都没弹");
  assert.deepEqual(ran, [], "命令没跑");
  assert.match(resultText(state, "r1"), /safety deny-list/);
  assert.match(resultText(state, "e1"), /You must Read AGENTS\.md before editing it/);
  assert.match(resultText(state, "w1"), /already exists\. Read it before overwriting it/);
  assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "old\n", "没被覆盖");
});

function workflowCtx(runs: string[]): Partial<ToolContext> {
  return {
    runWorkflow: async (req: WorkflowRequest) => {
      runs.push(req.script);
      return { id: "wf_p11", name: "n", description: "d", phases: [], ok: true, agents: [], cached: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, startedAt: 0, logs: [], result: "done" } as any;
    },
  };
}
const SCRIPT = [
  'export const meta = { name: "审一遍", description: "按维度审改动", phases: [{ title: "审" }, { title: "核" }] };',
  'const a = await agent("看看");',
  "return a;",
].join("\n");

test("P11 Workflow 确认进统一权限闸：没人在场不跑；有人在场卡上是中文原因与脚本正文；用户写的 allow 规则能放开", async (t) => {
  // 没人在场（子 agent / 无头）：以前不问就跑，现在按「没被批准」回给模型
  {
    const runs: string[] = [];
    const adapter = scripted(t).next(calls(call("w1", "Workflow", { script: SCRIPT })), say("好"));
    const session = attachSession(adapter, tmp("dimensio-p11-wf-"), { tools: [workflowTool] });
    const state = session.state!;
    Object.assign(state.ctx, workflowCtx(runs));
    state.ctx.requestPermission = undefined;
    await drive(state);
    assert.deepEqual(runs, [], "没人在场：不跑");
    assert.match(resultText(state, "w1"), /no user is attached/);
  }
  // 有人在场：卡由统一权限闸弹，规则名、中文原因、脚本正文都在
  {
    const runs: string[] = [];
    const asked: Record<string, unknown>[] = [];
    const adapter = scripted(t).next(calls(call("w2", "Workflow", { script: SCRIPT })), say("好"));
    const session = attachSession(adapter, tmp("dimensio-p11-wf-"), { tools: [workflowTool] });
    const state = session.state!;
    Object.assign(state.ctx, workflowCtx(runs));
    state.ctx.requestPermission = async (req) => {
      asked.push(req as unknown as Record<string, unknown>);
      return { decision: "once" as const };
    };
    await drive(state);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].rule, TOOL_CONFIRM_RULE);
    assert.match(String(asked[0].why), /要启动工作流「审一遍」/);
    const preview = asked[0].preview as { kind: string; script: string; phases: string[] };
    assert.equal(preview.kind, "script");
    assert.equal(preview.script, SCRIPT);
    assert.deepEqual(preview.phases, ["审", "核"]);
    assert.deepEqual(runs, [SCRIPT], "批了才跑");
  }
  // 用户自己写了 allow 规则：不再问
  {
    const runs: string[] = [];
    let cards = 0;
    const adapter = scripted(t).next(calls(call("w3", "Workflow", { script: SCRIPT })), say("好"));
    const session = attachSession(adapter, tmp("dimensio-p11-wf-"), { tools: [workflowTool] });
    const state = session.state!;
    Object.assign(state.ctx, workflowCtx(runs));
    state.permissionRules = { allow: ["Workflow"], deny: [], ask: [] };
    state.ctx.requestPermission = async () => {
      cards++;
      return { decision: "once" as const };
    };
    await drive(state);
    assert.equal(cards, 0, "allow 规则放开了它");
    assert.deepEqual(runs, [SCRIPT]);
  }
});

const effects: TimelineEffects = {
  foreground: true,
  scheduleFlush: () => {},
  cancelFlush: () => {},
  toast: () => {},
  rememberSession: () => {},
  openBrowserPane: () => {},
  setGlobal: () => {},
  refill: () => {},
  setBrowser: () => {},
};

test("P11 原因与执行事实随 permission_ask 广播、重连拿得回，前端卡片收得下", async (t) => {
  const ran: string[] = [];
  const adapter = scripted(t).next(calls(call("b1", "Bash", { command: "npm publish" })), say("好"));
  const session = attachSession(adapter, tmp("dimensio-p11-ev-"), { tools: [probeBash(ran)] });
  let pendingSnapshot: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "发一下");
  assert.ok(run.started);
  watchSession(session, (ev) => {
    events.push(ev);
    if (ev.e === "permission_ask") {
      pendingSnapshot = pendingInteractions(session); // 重连的设备从这里把卡找回来
      queueMicrotask(() => {
        const id = String(ev.id);
        session.pendingPermissions.get(id)?.resolve({ decision: "deny", note: "先别发" });
        session.pendingPermissions.delete(id);
      });
    }
  });
  await run.done;
  const ask = events.find((e) => e.e === "permission_ask")!;
  assert.match(String(ask.why), /包仓库/);
  assert.deepEqual(ask.preview, { kind: "command", command: "npm publish" });
  const again = pendingSnapshot.find((e) => e.e === "permission_ask")!;
  assert.equal(again.why, ask.why);
  assert.deepEqual(again.preview, ask.preview);
  assert.deepEqual(ran, []);

  const m: TimelineModel = {
    id: "s1", runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
  reduceTimeline(m, ask, effects);
  const item = m.permRefs.get(String(ask.id))!;
  assert.equal(item.why, ask.why);
  assert.deepEqual(item.preview, ask.preview);
  reduceTimeline(m, { e: "permission_ask", id: "x2", tool: "Bash", subject: "ls", preview: "not-an-object" }, effects);
  assert.equal(m.permRefs.get("x2")!.preview, undefined, "形状不对的执行事实不要");
});
