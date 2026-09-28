// C8（X42、K43、A3）：上下文卫生入口——立即压缩、带摘要开新会话、计划卡「在新会话中实施」。
//
// 修前：长会话只能等自动压缩；计划模式调研完，批准后就在占满调研内容的上下文里实施（小窗口模型尤其吃亏）；
// 没有「换个干净上下文接着干」的入口，缓存冷了也不知道下一条要按全价重读整段。
// 修后：POST /api/sessions/:id/compact 手动压（不看阈值、按现在的用量切）；POST …/handoff {kind:"summary"} 整段写成
// 摘要开新会话（沿用工作区、厂商、型号），{kind:"plan", planId} 把等审批的计划交给自主档的新会话起跑，原会话一句话收尾。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setConfig } from "./config.ts";
import { compactSession, getSession, handoffPlan, handoffWithSummary, HANDOFF_PLAN_PREFIX, type PlanVerdict } from "./session.ts";
import { loadSession } from "./store.ts";
import { fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import { Sandbox } from "./sandbox.ts";

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
const texts = (msgs: readonly { content: { t: string; text?: string }[] }[] | undefined) =>
  (msgs ?? []).map((m) => m.content.map((b) => b.text ?? "").join(""));

async function chatty(t: test.TestContext, extraSteps: Parameters<ReturnType<typeof scripted>["next"]>) {
  // 答复要有点长度：压缩摘要本身几百字，对话太短时「压完没变短」就不提交（那是对的）
  const long = (tag: string) => say(`${tag}：` + "这一段是详细的说明文字，".repeat(300));
  const adapter = scripted(t).next(long("答一"), long("答二"), long("答三"), long("答四"), ...extraSteps);
  const root = tmp("dimensio-c8-");
  const session = attachSession(adapter, root);
  for (const q of ["第一句：说说项目结构", "第二句：看看测试怎么跑", "第三句：列一下改动点", "第四句：先不动手"]) await send(session, q);
  return { adapter, session, root };
}

test("C8 立即压缩：不看阈值，较早的对话换成摘要；太短的报 empty；在跑的报 running", async (t) => {
  const { session } = await chatty(t, [say(fakeSummary("项目结构、测试命令、四个改动点都已讨论，尚未动手。"))]);
  const r = await compactSession(session.id);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.before! > r.after!, `${r.before} → ${r.after}`);
  const rec = await loadSession(session.id);
  assert.ok(rec?.messages.some((m) => m.kind === "compaction-summary"), "转录里有压缩摘要");
  assert.ok(texts(rec?.messages).some((x) => x.includes("第四句")), "最近的一截原样留着");

  const short = attachSession(scripted(t).next(say("好")), tmp("dimensio-c8-short-"));
  await send(short, "你好");
  assert.equal((await compactSession(short.id)).code, "empty");
  short.running = true;
  assert.equal((await compactSession(short.id)).code, "running");
  short.running = false;
});

test("C8 带摘要开新会话：新会话以一条接续摘要开头，沿用工作区与厂商；原会话原样留着", async (t) => {
  setConfig({ provider: "openai", apiKey: "DUMMY-c8-key" }); // 新会话按原会话的厂商建 adapter（只建不调）
  const { session, root } = await chatty(t, [say(fakeSummary("讨论了项目结构与测试命令，列了四个改动点。"))]);
  const before = (await loadSession(session.id))?.messages.length;
  const r = await handoffWithSummary(session.id);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.sessionId && r.sessionId !== session.id);
  const next = await loadSession(r.sessionId!);
  assert.equal(next?.messages.length, 1);
  assert.equal(next?.messages[0].kind, "handoff-summary");
  assert.match(texts(next?.messages)[0], /^\[Handoff\] This session continues from an earlier session/);
  assert.match(texts(next?.messages)[0], /第一句：说说项目结构/, "用户原话照样带过去");
  assert.equal(next?.config.workspace, root);
  assert.equal(next?.config.provider, session.cfg?.provider);
  assert.match(next?.title ?? "", /^接续：/);
  assert.equal((await loadSession(session.id))?.messages.length, before, "原会话一条没动");
});

test("C8 计划卡「在新会话中实施」：原会话的计划落定为转交，新会话自主档起跑、首条消息就是计划", async (t) => {
  // 新会话用 openai 厂商，指向一个本地假服务（只回一句话），不碰网络
  setConfig({ provider: "openai", apiKey: "DUMMY-c8-key" });
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "好的，开始实施。" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const root = tmp("dimensio-c8-plan-");
  const origin = attachSession(scripted(t, { id: "openai" }), root, { mode: "plan" });
  origin.cfg = { ...origin.cfg!, baseUrl };
  const got: { verdict: PlanVerdict | null } = { verdict: null }; // 回调里赋值——放对象里，免得 TS 把它收窄成 null
  const plan = "# 改造登录页\n1. 拆表单组件\n2. 加校验";
  // 生产里 registerPlan 的 finish 会把自己从表里摘掉；桩照做
  origin.pendingPlans.set("p1", {
    resolve: (v) => {
      got.verdict = v;
      origin.pendingPlans.delete("p1");
    },
    plan,
  });

  const r = handoffPlan(origin.id, "p1");
  assert.equal(r.ok, true, r.error);
  assert.equal(got.verdict?.approved, false, "不是批准");
  assert.equal(got.verdict?.handoff, true, "原会话的计划落定为转交");
  const next = getSession(r.sessionId!);
  assert.ok(next);
  assert.equal(next.cfg?.permissionMode, "auto");
  assert.equal(next.cfg?.workspace, root);
  assert.match(next.title, /^实施：改造登录页/);
  await next.runPromise;
  assert.ok(seen.some((b) => b.includes("拆表单组件") && b.includes(HANDOFF_PLAN_PREFIX.slice(0, 12))), "新会话的首条消息就是计划");
  assert.equal(handoffPlan(origin.id, "p1").code, "not_found", "同一份计划不能转两次");
});

test("C8 ExitPlanMode 收到「转交」：成功落定，叫模型别动手、别改计划、一句话收尾", async () => {
  const r = await exitPlanModeTool.run(
    { plan: "# 计划\n1. 做点事" },
    {
      sandbox: new Sandbox(tmp("dimensio-c8-epm-")),
      readFileState: new Map(),
      setTodos: () => {},
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      agentSeesImages: false,
      submitPlan: async () => ({ approved: false, handoff: true }),
    },
  );
  assert.equal(r.ok, true);
  const body = r.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(body, /NEW session/);
  assert.match(body, /Do NOT implement it here/);
});
