// R7：provider 错误分类（providers/classify.ts）+ loop 的「超窗先压缩再发」。错误样本按各家文档与线上见过的形状写：
// 业务码优先，代理 / CDN 的 403 ≠ 鉴权失败，上游繁忙 ≠ key 限流，欠费 ≠ 限流，超窗 / 请求体过大先压缩。
import assert from "node:assert/strict";
import test from "node:test";
import { COMPACTION_SYSTEM } from "./agent/context.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { Msg } from "./agent/turn.ts";
import { classifyHttpError, classifyStreamError, type ErrorClass } from "./providers/classify.ts";
import { createAdapter } from "./providers/registry.ts";
import { fakeSummary, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

type Case = [name: string, status: number, body: string, headers: Record<string, string>, want: ErrorClass];
const MATRIX: Case[] = [
  // Anthropic
  ["anthropic 429 限流", 429, `{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}`, {}, "rate_limit"],
  ["anthropic 529 过载", 529, `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, {}, "upstream_busy"],
  ["anthropic 400 超窗", 400, `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}`, {}, "context_overflow"],
  ["anthropic 400 欠费", 400, `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}`, {}, "billing"],
  ["anthropic 401", 401, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`, {}, "auth"],
  ["anthropic 403 出口被拒", 403, `{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}`, {}, "egress_blocked"],
  ["anthropic 413", 413, `{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}`, {}, "request_too_large"],
  // OpenAI
  ["openai 429 欠费", 429, `{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}`, {}, "billing"],
  ["openai 429 限流", 429, `{"error":{"message":"Rate limit reached for gpt-4o","type":"requests","code":"rate_limit_exceeded"}}`, {}, "rate_limit"],
  ["openai 400 超窗", 400, `{"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}`, {}, "context_overflow"],
  ["openai 401", 401, `{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}`, {}, "auth"],
  ["openai 404 模型不存在", 404, `{"error":{"message":"The model 'gpt-9' does not exist","type":"invalid_request_error","code":"model_not_found"}}`, {}, "bad_request"],
  // DeepSeek
  ["deepseek 402 欠费", 402, `{"error":{"message":"Insufficient Balance","type":"unknown_error"}}`, {}, "billing"],
  ["deepseek 503 繁忙", 503, `{"error":{"message":"Server is busy, please try again later","type":"server_error"}}`, {}, "upstream_busy"],
  // Kimi
  ["kimi 429 额度用完", 429, `{"error":{"message":"Your account exceeded current quota","type":"exceeded_current_quota_error"}}`, {}, "billing"],
  ["kimi 429 过载", 429, `{"error":{"message":"The engine is currently overloaded, please try again later","type":"engine_overloaded_error"}}`, {}, "upstream_busy"],
  ["kimi 400 超窗", 400, `{"error":{"message":"Invalid request: Your request exceeded model token limit: 262144","type":"invalid_request_error"}}`, {}, "context_overflow"],
  // 智谱
  ["智谱 1113 欠费", 429, `{"error":{"code":"1113","message":"您的账户已欠费，请充值后重试。"}}`, {}, "billing"],
  ["智谱 1302 限流", 429, `{"error":{"code":"1302","message":"您当前使用该API的并发数过高，请降低并发，或联系客服增加限额。"}}`, {}, "rate_limit"],
  ["智谱 1261 超长", 400, `{"error":{"code":"1261","message":"Prompt 超长"}}`, {}, "context_overflow"],
  // 通义
  ["通义 欠费", 400, `{"error":{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}}`, {}, "billing"],
  ["通义 限流", 429, `{"error":{"code":"Throttling.RateQuota","message":"Requests rate limit exceeded, please try again later."}}`, {}, "rate_limit"],
  // Gemini
  ["gemini 按分钟配额", 429, `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generate_content_free_tier_requests, limit: 10. Please retry in 12s.","status":"RESOURCE_EXHAUSTED"}}`, {}, "rate_limit"],
  ["gemini 按天配额", 429, `{"error":{"code":429,"message":"Quota exceeded for quota metric 'Generate Content API requests per day'","status":"RESOURCE_EXHAUSTED"}}`, {}, "billing"],
  ["gemini 超窗", 400, `{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}`, {}, "context_overflow"],
  ["gemini 地区限制", 400, `{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}`, {}, "egress_blocked"],
  ["gemini 403 没带 key", 403, `{"error":{"code":403,"message":"Method doesn't allow unregistered callers. Please use API Key.","status":"PERMISSION_DENIED"}}`, {}, "auth"],
  // llama.cpp 兼容服务
  ["llama.cpp 超窗", 400, `{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}`, {}, "context_overflow"],
  // 代理 / CDN / 网关
  ["Cloudflare 403 拦截页", 403, `<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>`, { "cf-ray": "8c1f2a3b4c5d6e7f-SJC", server: "cloudflare" }, "egress_blocked"],
  ["代理 502 页", 502, `<html><body><h1>502 Bad Gateway</h1></body></html>`, { server: "nginx" }, "upstream_busy"],
  ["网关 504", 504, `upstream request timeout`, {}, "timeout"],
];

test("R7 provider 错误矩阵：业务码 / 类型 / 话术 / 状态码 / 响应头 → 类别、重试、先压缩", () => {
  const wrong: string[] = [];
  for (const [name, status, body, headers, want] of MATRIX) {
    const c = classifyHttpError(status, body, new Headers(headers));
    if (c.class !== want) wrong.push(`${name}：得到 ${c.class}，应为 ${want}`);
    const retriable = ["rate_limit", "upstream_busy", "timeout", "server"].includes(want);
    const compress = ["context_overflow", "request_too_large"].includes(want);
    if (c.retriable !== retriable || c.compress !== compress) wrong.push(`${name}：retriable=${c.retriable} compress=${c.compress}`);
    if (!c.summary) wrong.push(`${name}：没有人话`);
  }
  assert.deepEqual(wrong, []);
});

test("R7 上游关联头（request-id、cf-ray、server）跟着错误走", () => {
  const c = classifyHttpError(403, "<html>blocked</html>", new Headers({ "cf-ray": "8c1f-SJC", server: "cloudflare", "x-request-id": "req_123" }));
  assert.equal(c.upstream, "request-id=req_123; cf-ray=8c1f-SJC; server=cloudflare");
});

test("R7 流里来的错误同样分类（HTTP 已经 200）", () => {
  assert.equal(classifyStreamError({ type: "overloaded_error", message: "Overloaded" }).class, "upstream_busy");
  assert.equal(classifyStreamError({ type: "invalid_request_error", message: "prompt is too long: 300000 tokens > 200000 maximum" }).compress, true);
  assert.equal(classifyStreamError({ code: 429, status: "RESOURCE_EXHAUSTED", message: "Please retry in 3s" }).class, "rate_limit");
  assert.equal(classifyStreamError({ error: { code: "1113", message: "余额不足" } }).class, "billing");
  assert.equal(classifyStreamError({ type: "api_error", message: "Internal server error" }).retriable, true);
});

// ── OpenAI 兼容适配器的三条出错路径（fetch 层假扮 provider，走真 adapter）─────────────────
function mockFetch(t: test.TestContext, respond: () => Response) {
  t.mock.method(globalThis, "fetch", async () => respond());
}
async function firstError(provider: "zhipu" | "openai"): Promise<Extract<StreamEvent, { e: "error" }>> {
  const adapter = createAdapter({ provider, model: "glm-test", apiKey: "DUMMY-r7-key", baseUrl: "https://provider.invalid/v1" });
  for await (const ev of adapter.stream({ system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 100 } })) {
    if (ev.e === "error") return ev;
  }
  throw new Error("no error event");
}

test("R7 适配器：HTTP 200 的 SSE 里夹着业务错误 → 认得出来（以前当成空回复）", async (t) => {
  mockFetch(t, () => new Response(`data: {"error":{"code":"1113","message":"您的账户已欠费"}}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }));
  const ev = await firstError("zhipu");
  assert.equal(ev.class, "billing");
  assert.equal(ev.retriable, false);
});

test("R7 适配器：HTTP 200 却回了一段 JSON 错误体 → 按错误分类", async (t) => {
  mockFetch(t, () => new Response(`{"error":{"code":"1302","message":"并发数过高"}}`, { status: 200, headers: { "content-type": "application/json" } }));
  const ev = await firstError("zhipu");
  assert.equal(ev.class, "rate_limit");
  assert.equal(ev.retriable, true);
});

test("R7 适配器：CDN 的 403 拦截页 → 出口被拒（不是 key 的问题），带着 cf-ray", async (t) => {
  mockFetch(t, () => new Response("<html><body>Sorry, you have been blocked</body></html>", { status: 403, headers: { "cf-ray": "abc-SJC", server: "cloudflare" } }));
  const ev = await firstError("openai");
  assert.equal(ev.kind, "http_403", "kind 仍是 http_<状态码>");
  assert.equal(ev.class, "egress_blocked");
  assert.match(ev.upstream ?? "", /cf-ray=abc-SJC/);
});

// ── loop：超窗先压一次再发 ─────────────────────────────────────────────────────────
const overflow: StreamEvent[] = [{ e: "error", kind: "http_400", retriable: false, class: "context_overflow", compress: true, summary: "上下文超出了模型窗口", raw: "prompt is too long" }];
const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};
const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
// 窗口 4 万：触发线约 2.7 万 token（主动压缩不会先动手），尾部预算 1.6 万 token；历史约 8 万字符（2 万 token）→ 中段压得出来
function withHistory(t: test.TestContext, steps: StreamEvent[][], tools: Tool[] = []) {
  const adapter = scripted(t, { capabilities: { contextWindow: 40_000 } }).next(...steps);
  const { state } = loopState(t, adapter, { memoryAudit: false, tools });
  state.messages = [user("task"), ...Array.from({ length: 40 }, (_, i) => (i % 2 ? reply("r".repeat(2_000)) : user(`q${i}`)))];
  return { adapter, state };
}

test("R7 超窗：先压一次再发，成了就照常完成", async (t) => {
  const { adapter, state } = withHistory(t, [overflow, say(fakeSummary("前情提要")), say("答复")]);
  state.addUserMessage("接着来");
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 3);
  assert.equal(adapter.inputs[1].system, COMPACTION_SYSTEM, "第二次调用就是压缩摘要");
  assert.ok(events.some((e) => e.e === "context" && e.compacted), "时间线上有「已压缩」");
  assert.ok(!events.some((e) => e.e === "error"));
  assert.ok(state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.startsWith("[Earlier context summary]"))));
});

test("R7 压完这一轮还超：报错收场，不在循环里反复压", async (t) => {
  const { adapter, state } = withHistory(t, [overflow, say(fakeSummary("前情提要")), overflow]);
  state.addUserMessage("接着来");
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 3);
  const err = events.find((e) => e.e === "error") as { message: string } | undefined;
  assert.match(err?.message ?? "", /超出了模型窗口[\s\S]*still too long after compacting once this turn/);
});

test("R7 rapid refill：上一轮刚为超窗压过、这一轮又超 → 熔断，不再压", async (t) => {
  const { adapter, state } = withHistory(t, [overflow, say(fakeSummary("前情提要")), useTool("e1", "Echo"), overflow], [echoTool]);
  state.addUserMessage("接着来");
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 4, "第二次超窗没有再发摘要请求");
  const err = events.find((e) => e.e === "error") as { message: string } | undefined;
  assert.match(err?.message ?? "", /overflowed again right after being compacted/);
});

test("R7 欠费：不重试，一次就报，消息里是人话", async (t) => {
  const billing: StreamEvent[] = [{ e: "error", kind: "http_402", retriable: false, class: "billing", compress: false, summary: "账户欠费或额度用完：充值或换一个模型后再试（重试没用）", raw: "Insufficient Balance" }];
  const adapter = scripted(t).next(billing);
  const { state } = loopState(t, adapter, { user: "问", memoryAudit: false });
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 1);
  const err = events.find((e) => e.e === "error") as { message: string; retriable: boolean } | undefined;
  assert.match(err?.message ?? "", /^账户欠费或额度用完/);
  assert.equal(err?.retriable, false);
});
