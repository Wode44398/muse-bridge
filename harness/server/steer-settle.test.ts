// M3（#27、#45）：插话队列在所有 run 出口清算；没答的权限卡不记成「用户拒绝」。
// 改写自探针 04-codex/笔记/probe-steer-error-exit.ts 与 03-hermes-agent/笔记/probe-steer-leftover.ts。
//
// 修前：run 以错误结束（没点停止）或被停止时，还没送进模型的插话留在队列里；下一轮用户正常发新消息，旧插话
// 带着「优先于此前的指示」前缀排在新消息【之后】注入——agent 去执行用户已经推翻的指令。停止时挂着的权限卡
// 在转录里写成 `user declined: run stopped`。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { createSession, dropSession, startRun, steerSession, stopSession, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { Turn } from "./agent/turn.ts";
import type { Tool } from "./tools/types.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m3-"));
  roots.push(dir);
  return dir;
}

const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };
const userTexts = (t: Turn) =>
  t.messages.filter((m) => m.role === "user").map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));

function attach(session: ReturnType<typeof createSession>, adapter: ProviderAdapter, root: string, tools: Tool[] = [], rules = { allow: [] as string[], deny: [] as string[], ask: [] as string[] }) {
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: tools.map((t) => t.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(tools.map((t) => [t.def.name, t])),
    permissionMode: "auto",
    permissionRules: rules,
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
}

test("run 以错误结束：没送进模型的插话退回客户端，不在下一轮倒序注入", async () => {
  const root = workspace();
  const session = createSession();
  let call = 0;
  let run2View: string[] = [];
  attach(session, {
    id: "openai", model: "fake", capabilities: caps,
    async *stream(t) {
      call++;
      if (call === 1) {
        yield { e: "text_delta", text: "正在按方案A修改……" };
        steerSession(session, "改成方案B"); // 用户在手机上打字纠偏
        yield { e: "error", kind: "invalid_request_error", retriable: false, raw: "400 synthetic" };
        return;
      }
      run2View = userTexts(t);
      yield { e: "text_delta", text: "ok" };
      yield { e: "turn_done", stopReason: "end" };
    },
  }, root);
  const events: Record<string, unknown>[] = [];
  const run1 = startRun(session, "原任务：按方案A改");
  watchSession(session, (ev) => events.push(ev));
  await run1.done;
  const returned = events.find((e) => e.e === "steer_returned") as { texts?: string[] } | undefined;
  assert.deepEqual(returned?.texts, ["改成方案B"], "退回给客户端放回输入框");
  assert.equal(session.state!.hasSteer(), false, "队列清空");

  await startRun(session, "算了，回到方案A，重试一次").done;
  assert.ok(run2View.some((x) => x.includes("回到方案A")));
  assert.ok(!run2View.some((x) => x.includes("改成方案B")), "被用户推翻的旧插话不许再进下一轮");
  dropSession(session.id);
});

test("停止时挂着的权限卡：转录写「没答」，不写「用户拒绝」", async () => {
  const root = workspace();
  const session = createSession();
  const risky: Tool = {
    effect: "exec", concurrencySafe: false,
    def: { name: "Deploy", description: "deploy", parameters: { type: "object", properties: {} } },
    async run() {
      return { ok: true, summary: "deployed", content: [{ t: "text", text: "deployed" }] };
    },
  };
  let call = 0;
  attach(session, {
    id: "openai", model: "fake", capabilities: caps,
    async *stream() {
      call++;
      if (call === 1) {
        yield { e: "tool_call", id: "d1", name: "Deploy", args: {} };
        yield { e: "turn_done", stopReason: "tool_use" };
        return;
      }
      yield { e: "text_delta", text: "ok" };
      yield { e: "turn_done", stopReason: "end" };
    },
  }, root, [risky], { allow: [], deny: [], ask: ["Deploy"] });
  const run = startRun(session, "发版");
  const events: Record<string, unknown>[] = [];
  watchSession(session, (ev) => events.push(ev));
  const deadline = Date.now() + 10_000;
  while (session.pendingPermissions.size === 0) {
    if (Date.now() > deadline) assert.fail("permission card never appeared");
    await new Promise((r) => setTimeout(r, 10));
  }
  steerSession(session, "先别发版"); // probe-steer-leftover ①：插了一句话……
  stopSession(session.id); // ……卡片还没答，用户又点了停止
  await run.done;
  const results = JSON.stringify(session.state!.messages);
  assert.doesNotMatch(results, /user declined/);
  assert.match(results, /not approved: the run was stopped before the user answered \(this is not a refusal/);
  // 停止出口同样清算插话：退回客户端放回输入框，不留到下一轮倒序注入
  const returned = events.find((e) => e.e === "steer_returned") as { texts?: string[] } | undefined;
  assert.deepEqual(returned?.texts, ["先别发版"]);
  assert.equal(session.state!.hasSteer(), false);
  dropSession(session.id);
});
