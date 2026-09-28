// U6（hermes N41）：失败呈现重做——分层描述符直达界面：一句人话、这一轮已经执行过几次工具、原始报错另放；中断不是失败；
// 退避重试写进活动行。
//
// 修前：error 事件只有 message（分类器的人话和原始报文、上游关联头挤在一行）和 retriable；界面把每个 error 都推成一张红卡——
// 用户点停止、服务重启时，别的设备上是一张红色的「aborted」；这一轮已经跑过哪些工具（重发前该先核对）只写在给模型看的边界里；
// 限流退避重试时活动行还停在上一个动作上。
// 修后：error 带 summary（人话）/ class / ran（这一轮执行过几次工具）；中断带 stopped（user / restart），界面显示灰色的
// 「已停止」「服务重启打断了这一轮」；退避前的 context 事件带 retryInMs / retryClass，活动行写「被限流，N 秒后第 K 次重试」。
import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "./agent/loop.ts";
import { RESTART_REASON } from "./retire.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";
import { failureItem, reduceTimeline, retryActivity, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";

const probe: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Probe", description: "probe", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("probed", "ok");
  },
};

async function collect(state: ReturnType<typeof loopState>["state"], signal = new AbortController().signal): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const ev of runAgent(state, signal)) events.push(ev as unknown as Record<string, unknown>);
  return events;
}

function model(): TimelineModel {
  return {
    id: "s1", runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
}
const fx: TimelineEffects = {
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

test("U6 失败带一句人话、类别、这一轮执行过几次工具；原始报错另放（界面标题用人话，原文折起来）", async (t) => {
  const billing = [{
    e: "error" as const,
    kind: "http_402",
    retriable: false,
    class: "billing",
    summary: "账户欠费或额度用完：充值或换一个模型后再试（重试没用）",
    raw: { error: { message: "insufficient balance" } },
  }];
  const adapter = scripted(t).next(calls(call("p1", "Probe"), call("p2", "Probe")), billing);
  const { state } = loopState(t, adapter, { tools: [probe], user: "查一下" });
  const events = await collect(state);
  const err = events.find((e) => e.e === "error")!;
  assert.equal(err.summary, "账户欠费或额度用完：充值或换一个模型后再试（重试没用）");
  assert.equal(err.class, "billing");
  assert.equal(err.ran, 2, "这一轮已经执行过两次工具");
  assert.match(String(err.message), /http_402/, "原始报错还在 message 里");

  const m = model();
  reduceTimeline(m, err, fx);
  const item = m.timeline.at(-1)!;
  assert.equal(item.kind, "error");
  if (item.kind === "error") {
    assert.equal(item.text, err.summary, "标题是人话");
    assert.match(item.detail ?? "", /insufficient balance/, "原文折进详情");
    assert.equal(item.ran, 2);
    assert.equal(item.cls, "billing");
  }
});

test("U6 中断不是失败：带上是谁停的，界面显示灰色的「已停止」/「服务重启打断了这一轮」", async (t) => {
  for (const [reason, stopped, notice] of [[undefined, "user", "已停止"], [RESTART_REASON, "restart", "服务重启打断了这一轮"]] as const) {
    const adapter = scripted(t).always(say("不该走到这"));
    const { state } = loopState(t, adapter, { tools: [probe], user: "干活" });
    const ctl = new AbortController();
    ctl.abort(reason);
    const events = await collect(state, ctl.signal);
    const err = events.find((e) => e.e === "error")!;
    assert.equal(err.message, "aborted");
    assert.equal(err.stopped, stopped);
    const m = model();
    reduceTimeline(m, err, fx);
    assert.deepEqual(m.timeline.at(-1), { kind: "notice", text: notice }, "不是红色报错卡");
    assert.equal(adapter.callCount, 0, "停下之后没再调模型");
  }
});

test("U6 退避重试进活动行：「被限流，N 秒后第 K 次重试」", async (t) => {
  const saved = process.env.DIMENSIO_RETRY_SCALE;
  process.env.DIMENSIO_RETRY_SCALE = "0.001";
  t.after(() => {
    if (saved === undefined) delete process.env.DIMENSIO_RETRY_SCALE;
    else process.env.DIMENSIO_RETRY_SCALE = saved;
  });
  const limited = [{ e: "error" as const, kind: "http_429", retriable: true, class: "rate_limit", summary: "被限流了：会稍后自动重试", retryAfterMs: 5000 }];
  const adapter = scripted(t).next(limited, say("好了"));
  const { state } = loopState(t, adapter, { tools: [probe], user: "查一下" });
  const events = await collect(state);
  const retry = events.find((e) => e.e === "context" && e.retry === 1)!;
  assert.equal(retry.retryClass, "rate_limit");
  assert.equal(typeof retry.retryInMs, "number");
  assert.ok(!events.some((e) => e.e === "error"), "重试之后成功了");
  const m = model();
  reduceTimeline(m, { ...retry, retryInMs: 12_000 }, fx);
  assert.equal(m.activity, "被限流，12 秒后第 1 次重试");
  assert.equal(m.timeline.length, 0, "不进时间线");
  assert.equal(retryActivity("network", 400, 3), "连接断了，1 秒后第 3 次重试");
  assert.equal(retryActivity(undefined, 3000, 2), "出错了，3 秒后第 2 次重试");
});

test("U6 旧格式的错误照旧能看：没有人话就用原文第一行当标题，不重复摆原文", () => {
  assert.deepEqual(failureItem({ e: "error", message: "session is already running", retriable: false }), {
    kind: "error",
    text: "session is already running",
  });
  const long = failureItem({ e: "error", message: "stream failed: socket hang up\nat TLSSocket.x", retriable: true, ran: 0 });
  assert.equal(long.text, "stream failed: socket hang up");
  assert.equal(long.detail, "stream failed: socket hang up\nat TLSSocket.x");
  assert.equal(long.ran, undefined, "0 次不提");
  assert.equal(long.retriable, true);
});
