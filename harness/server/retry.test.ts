// R8：重试加厚——10 次、通用退避指数增长且封顶 60s、限流 15s 一档递增、[一半, 全额] 随机抖动；provider 的 Retry-After
// 照办、最长 5 分钟；等下去会越过这一轮的截止时间就不等。
import assert from "node:assert/strict";
import test from "node:test";
import { RETRY_ATTEMPTS, retryDelayMs } from "./agent/loop.ts";
import type { StreamEvent } from "./agent/events.ts";
import { retryAfterMs } from "./providers/sse.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";

const busy = (retryAfter?: number): StreamEvent[] => [{ e: "error", kind: "http_503", retriable: true, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}), raw: "overloaded" }];

test("R8 等多久：通用退避 0.5s 起翻倍、限流 15s 一档，都封顶 60s、在 [一半, 全额] 之间抖动；给了 Retry-After 就照办", () => {
  const lo = () => 0;
  const hi = () => 1;
  assert.deepEqual([1, 2, 3, 4].map((r) => retryDelayMs(r, {}, hi)), [500, 1000, 2000, 4000]);
  assert.deepEqual([1, 2, 3].map((r) => retryDelayMs(r, {}, lo)), [250, 500, 1000], "抖动的下沿是一半");
  assert.equal(retryDelayMs(8, {}, hi), 60_000, "封顶 60s（不再是 4s）");
  assert.equal(retryDelayMs(10, {}, lo), 30_000);
  assert.deepEqual([1, 2, 3, 4, 5].map((r) => retryDelayMs(r, { rateLimited: true }, hi)), [15_000, 30_000, 45_000, 60_000, 60_000]);
  assert.equal(retryDelayMs(3, { rateLimited: true, retryAfterMs: 7_000 }, hi), 7_000, "provider 说了等多久就照办，不抖动");
  for (let i = 0; i < 50; i++) {
    const d = retryDelayMs(6, {});
    assert.ok(d >= 8_000 && d <= 16_000, `抖动越界：${d}`);
  }
});

test("R8 Retry-After 最长照办 5 分钟（以前 2 分钟）", () => {
  const res = (v: string) => new Response(null, { status: 429, headers: { "retry-after": v } });
  assert.equal(retryAfterMs(res("200")), 200_000);
  assert.equal(retryAfterMs(res("600")), 300_000);
  assert.equal(retryAfterMs(res(new Date(Date.now() + 20 * 60_000).toUTCString())), 300_000);
  assert.equal(retryAfterMs(res("0.2")), 1_000, "下限 1 秒不变");
});

test("R8 连着 9 次可重试的失败，第 10 次成了照样完成；10 次都失败才报错收场", async (t) => {
  assert.equal(RETRY_ATTEMPTS, 10);
  const nine = scripted(t).next(...Array.from({ length: 9 }, () => busy(1)), say("终于好了"));
  const { state } = loopState(t, nine, { user: "做点事" });
  const { events } = await drive(state, nine);
  assert.equal(nine.callCount, 10);
  assert.ok(!events.some((e) => e.e === "error"), "没有报错");
  assert.ok(state.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.t === "text" && b.text === "终于好了")));

  const ten = scripted(t).next(...Array.from({ length: 10 }, () => busy(1)));
  const run = loopState(t, ten, { user: "再做点事" });
  const second = await drive(run.state, ten);
  assert.equal(ten.callCount, 10, "恰好 10 次，不多调");
  assert.ok(second.events.some((e) => e.e === "error"));
});

test("R8 等下去会越过这一轮的截止时间：不等，带着上一次的错立刻收场", async (t) => {
  const adapter = scripted(t).next(busy(60_000));
  const { state } = loopState(t, adapter, { user: "赶时间" });
  state.setRunBudget({ deadlineMs: 5_000 });
  const started = Date.now();
  const { events } = await drive(state, adapter);
  assert.ok(Date.now() - started < 3_000, "没有傻等 60 秒");
  assert.equal(adapter.callCount, 1);
  const err = events.find((e) => e.e === "error") as { message?: string } | undefined;
  assert.match(err?.message ?? "", /overloaded[\s\S]*would pass this run's deadline/);
});
