// O2（H2 / KM-1）：provider 错误不进脚本——子 agent 撞上限流 / 过载就挂起、在同一个 state 上接着跑（不再变成 null）；
// key / 额度 / 出口被拒让整个 Workflow 停下并说清楚怎么续跑；run 内自适应并发闸（起步爬坡、挂起就缩、没事了能复位）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, StreamEvent } from "./agent/events.ts";
import { RETRY_ATTEMPTS } from "./agent/loop.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { AdaptiveGate, GATE_TIMING, makeWorkflowRunner } from "./agent/workflow.ts";
import { Sandbox } from "./sandbox.ts";
import { scripted } from "./test-harness/scripted-adapter.ts";
import type { SubAgentRequest, SubAgentResult } from "./tools/types.ts";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const env = (root: string) => ({
  provider: "openai" as const,
  apiKey: "FAKE-test-key",
  model: "fake",
  thinking: "off" as const,
  sandbox: new Sandbox(root),
  limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
});
const answer = (text: string): StreamEvent[] => [
  { e: "text_delta", text },
  { e: "usage", inputTokens: 10, outputTokens: 5 },
  { e: "turn_done", stopReason: "end" },
];
const providerError = (cls: string, retriable: boolean): StreamEvent[] => [{ e: "error", kind: `http_${cls}`, retriable, class: cls, summary: cls }];

function fastRetries(t: test.TestContext) {
  const saved = process.env.DIMENSIO_RETRY_SCALE;
  process.env.DIMENSIO_RETRY_SCALE = "0.0001";
  t.after(() => (saved === undefined ? delete process.env.DIMENSIO_RETRY_SCALE : (process.env.DIMENSIO_RETRY_SCALE = saved)));
}

test("O2 子 agent 撞上限流：loop 重试完也不记失败——挂起、在同一个 state 上接着跑，最后照常交回结果", async (t) => {
  fastRetries(t);
  const root = tmp("dimensio-o2-sub-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 前 RETRY_ATTEMPTS 次请求全是 429（loop 自己的重试用完），之后恢复
  const a = scripted(t).next(...Array.from({ length: RETRY_ATTEMPTS }, () => providerError("rate_limit", true)), answer("The entry point is server/index.ts."));
  const events: AgentEvent[] = [];
  const suspended: string[] = [];
  const r = await makeSubAgentRunner(env(root), () => a)({
    prompt: "find the entry point",
    onEvent: (ev) => events.push(ev),
    onSuspend: (why) => suspended.push(why),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "The entry point is server/index.ts.");
  assert.deepEqual(suspended, ["rate_limit"]);
  const ev = events.find((x) => x.e === "subagent_suspended");
  assert.ok(ev && ev.e === "subagent_suspended" && ev.reason === "rate_limit" && ev.attempt === 1);
  assert.equal(a.callCount, RETRY_ATTEMPTS + 1);
});

test("O2 key / 额度这类错误不挂起：子 agent 照旧失败，并带上错误分类", async (t) => {
  fastRetries(t);
  const root = tmp("dimensio-o2-bill-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = scripted(t).next(providerError("billing", false));
  const suspended: string[] = [];
  const r = await makeSubAgentRunner(env(root), () => a)({ prompt: "x", onSuspend: (why) => suspended.push(why) });
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, "billing");
  assert.deepEqual(suspended, []);
});

function stubRunner(answerFor: (req: SubAgentRequest) => Partial<SubAgentResult>) {
  const requests: SubAgentRequest[] = [];
  const run = async (req: SubAgentRequest): Promise<SubAgentResult> => {
    requests.push(req);
    await new Promise((r) => setTimeout(r, 5));
    return {
      ok: true, id: req.id ?? "x", label: req.label ?? "", tier: req.tier ?? "research", model: "fake", provider: "openai",
      text: "", turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, editedFiles: [], trail: [], ...answerFor(req),
    };
  };
  return { run, requests };
}
const META = `export const meta = { name: 'o2', description: 'provider errors' }`;

test("O2 Workflow：key / 额度 / 出口被拒让整个 run 停下，说清楚用哪个 id 续跑（不再变成 null 被脚本吞掉）；其他失败照旧 null", async (t) => {
  const dir = tmp("dimensio-o2-wf-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner((req) =>
    req.prompt === "b" ? { ok: false, error: "insufficient balance", errorClass: "billing" }
    : req.prompt === "c" ? { ok: false, error: "finished without calling SubmitResult" }
    : { text: `done ${req.prompt}` });
  const wf = makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir });
  const plain = await wf({ script: `${META}\nconst a = await agent("a"); const c = await agent("c"); return [a, c];` });
  assert.equal(plain.ok, true, plain.error);
  assert.deepEqual(plain.result, ["done a", null], "不是 provider 的失败照旧是 null");

  const stopped = await wf({ script: `${META}\nconst a = await agent("a"); const b = await agent("b"); return [a, b];` });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error ?? "", /stopped: the model provider refused agent "[^"]+" \(billing: insufficient balance\)/);
  assert.match(stopped.error ?? "", new RegExp(`resumeFromRunId: "${stopped.id}"`));
  assert.ok(runner.requests.every((r) => typeof r.onSuspend === "function"), "子 agent 的挂起会回报给并发闸");
});

test("O2 自适应并发闸：起步先放一批、之后按节奏一个个放；挂起就缩一格（有冷却、至少留 1）；一段时间没事就复位到上限", async (t) => {
  const saved = { ...GATE_TIMING };
  Object.assign(GATE_TIMING, { rampBurst: 2, rampStepMs: 60, shrinkEveryMs: 1_000, growAfterMs: 150 });
  t.after(() => Object.assign(GATE_TIMING, saved));
  const gate = new AdaptiveGate(3);
  t.after(() => gate.close());
  const signal = new AbortController().signal;
  const t0 = Date.now();
  const granted: number[] = [];
  const waits = [0, 1, 2].map(() => gate.acquire(signal).then(() => granted.push(Date.now() - t0)));
  await Promise.all(waits);
  assert.ok(granted[0] < 30 && granted[1] < 30, `前两个立刻放：${granted}`);
  assert.ok(granted[2] >= 50, `第三个按节奏晚一点：${granted[2]}ms`);

  gate.suspended();
  assert.equal(gate.limit, 2);
  gate.suspended();
  assert.equal(gate.limit, 2, "冷却期内不连着缩");
  for (let i = 0; i < 3; i++) gate.release();
  await new Promise((r) => setTimeout(r, 200));
  await gate.acquire(signal);
  assert.equal(gate.limit, 3, "一段时间没有挂起，复位到原来的上限");
  gate.release();
});
