// M1（#26）：挂起中的问答 / 权限 / 计划卡单列，重连可恢复；问答卡 id 改用 tool_call id；作废时补发 *_cancelled。
// 改写自探针 03-hermes-agent/笔记/probe-pending-lost.ts。
//
// 修前：runLog 撞上上限后，新附着的客户端只收到一条 mirror_desync，挂着的卡只活在内存和 runLog 里，记录与
// 任何 API 都拿不到——手机重连后看不到权限卡 / 计划卡；从记录重建出的问答卡 id 是 tool_call id，服务端
// 却用另铸的 UUID 当键，回答被当成「已失效」静默吞掉，这一轮永久挂起。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import {
  answerAsk,
  createSession,
  dropSession,
  pendingInteractions,
  startRun,
  stopSession,
  watchSession,
  type Session,
} from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { askUserQuestionTool } from "./tools/ask.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { PermissionMode } from "./agent/permissions.ts";
import type { Tool } from "./tools/types.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };

function attach(session: Session, adapter: ProviderAdapter, tools: Tool[], opts: { ask?: string[]; mode?: PermissionMode } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m1-"));
  roots.push(root);
  const mode = opts.mode ?? "auto";
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: tools.map((t) => t.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(tools.map((t) => [t.def.name, t])),
    permissionMode: mode,
    permissionRules: { allow: [], deny: [], ask: opts.ask ?? [] },
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: mode, workspace: root, access: "workspace" };
}

// 第一轮发出 call，之后收尾；calls 记下每次请求里最后一条 tool_result 的文字
function scripted(call: { id: string; name: string; args: Record<string, unknown> }, seen: string[]): ProviderAdapter {
  let n = 0;
  return {
    id: "openai", model: "fake", capabilities: caps,
    async *stream(t) {
      n++;
      const last = t.messages.at(-1);
      const res = last?.content.find((b) => b.t === "tool_result");
      if (res && res.t === "tool_result") seen.push(res.content.map((b) => (b.t === "text" ? b.text : "")).join(""));
      if (n === 1) {
        yield { e: "tool_call", ...call };
        yield { e: "turn_done", stopReason: "tool_use" };
        return;
      }
      yield { e: "text_delta", text: "done" };
      yield { e: "turn_done", stopReason: "end" };
    },
  };
}

async function until(cond: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const question = { questions: [{ header: "方案", question: "走哪条？", options: [{ label: "A" }, { label: "B" }] }] };

test("runLog 撞上限后重连：挂着的问答卡随 desync 下发；按记录重建的卡（tool_call id）能作答", async () => {
  const session = createSession();
  const seen: string[] = [];
  attach(session, scripted({ id: "call_ask_1", name: "AskUserQuestion", args: question }, seen), [askUserQuestionTool]);
  const run = startRun(session, "问我一个问题");
  await until(() => session.pendingAsks.size === 1, "the ask card");

  session.runLogTruncated = true; // 真实情形：Workflow 子 agent 的 delta 把 20 万条打满
  const events: Record<string, unknown>[] = [];
  const off = watchSession(session, (ev) => events.push(ev));
  const desync = events.find((e) => e.e === "mirror_desync") as { pending?: Record<string, unknown>[] } | undefined;
  assert.ok(desync, "新附着的客户端收到 desync");
  const pendingAsk = desync.pending?.find((p) => p.e === "ask");
  assert.ok(pendingAsk, "挂着的问答卡随 desync 一起下发");
  assert.equal(pendingAsk.id, "call_ask_1", "卡片 id 就是转录里的 tool_call id");
  assert.deepEqual(pendingInteractions(session).map((p) => p.id), ["call_ask_1"]);

  // 客户端从记录重建的卡片 id 取自 tool_call——修前这里返回 false，回答被静默吞掉，这一轮永远挂着
  assert.equal(answerAsk(session, "call_ask_1", [{ selected: ["A"] }]), true);
  await run.done;
  off();
  assert.ok(seen.some((s) => s.includes("A")), `模型收到了回答：${JSON.stringify(seen)}`);
  dropSession(session.id);
});

test("权限卡挂着时：随 desync 下发（带规则）；点停止后补发 permission_cancelled", async () => {
  const session = createSession();
  const deploy: Tool = {
    effect: "exec", concurrencySafe: false,
    def: { name: "Deploy", description: "deploy", parameters: { type: "object", properties: {} } },
    async run() {
      return { ok: true, summary: "deployed", content: [{ t: "text", text: "deployed" }] };
    },
  };
  attach(session, scripted({ id: "call_dep_1", name: "Deploy", args: {} }, []), [deploy], { ask: ["Deploy"] });
  const run = startRun(session, "发版");
  await until(() => session.pendingPermissions.size === 1, "the permission card");

  session.runLogTruncated = true;
  const events: Record<string, unknown>[] = [];
  watchSession(session, (ev) => events.push(ev));
  const desync = events.find((e) => e.e === "mirror_desync") as { pending?: Record<string, unknown>[] } | undefined;
  const perm = desync?.pending?.find((p) => p.e === "permission_ask");
  assert.ok(perm, "权限卡随 desync 下发——记录里没有它，修前重连的手机永远看不到");
  assert.equal(perm.tool, "Deploy");
  assert.equal(perm.rule, "Deploy");

  stopSession(session.id);
  await run.done;
  assert.ok(events.some((e) => e.e === "permission_cancelled" && e.id === perm.id), "作废要告诉所有设备");
  assert.equal(pendingInteractions(session).length, 0);
  dropSession(session.id);
});

test("问答卡与计划卡没等到人：补发 *_cancelled；计划不被说成「退回」", async () => {
  const askSession = createSession();
  attach(askSession, scripted({ id: "call_ask_2", name: "AskUserQuestion", args: question }, []), [askUserQuestionTool]);
  const askEvents: Record<string, unknown>[] = [];
  const askRun = startRun(askSession, "问我");
  watchSession(askSession, (ev) => askEvents.push(ev));
  await until(() => askSession.pendingAsks.size === 1, "the ask card");
  stopSession(askSession.id);
  await askRun.done;
  assert.ok(askEvents.some((e) => e.e === "ask_cancelled" && e.id === "call_ask_2"));
  dropSession(askSession.id);

  const planSession = createSession();
  const seen: string[] = [];
  attach(planSession, scripted({ id: "call_plan_1", name: "ExitPlanMode", args: { plan: "1. 改 A\n2. 跑测试" } }, seen), [exitPlanModeTool], { mode: "plan" });
  const planEvents: Record<string, unknown>[] = [];
  const planRun = startRun(planSession, "先出计划");
  watchSession(planSession, (ev) => planEvents.push(ev));
  await until(() => planSession.pendingPlans.size === 1, "the plan card");
  stopSession(planSession.id);
  await planRun.done;
  assert.ok(planEvents.some((e) => e.e === "plan_cancelled"));
  const result = JSON.stringify(planSession.state!.messages);
  assert.match(result, /not a rejection/);
  assert.doesNotMatch(result, /did NOT approve/);
  dropSession(planSession.id);
});
