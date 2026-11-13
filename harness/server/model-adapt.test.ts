// 各家模型的调用参数适配（2026-11 逐厂商审计后补的），dimensio 适配器这一侧。每条都对应一次真打确认过的行为。
import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import type { CustomWire } from "./providers/types.ts";
import { createAnthropicAdapter } from "./providers/anthropic.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";
import { floorTierWhenNoOff } from "./custom-tiers.ts";
import { MK } from "./model-knowledge.ts";

function response(events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function send(adapter: { stream: (turn: Turn) => AsyncIterable<unknown> }, turn: Turn): Promise<any> {
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return response([{ type: "message_stop" }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;
  try {
    for await (const _ of adapter.stream(turn)) void _;
  } finally {
    globalThis.fetch = originalFetch;
  }
  return body;
}
const TOOL = { name: "Read", description: "read a file", parameters: { type: "object" as const, properties: { path: { type: "string" as const } } } };
const user = (text: string) => ({ role: "user" as const, content: [{ t: "text" as const, text }] });
const main = (thinking: Turn["budget"]["thinking"]): Turn => ({ system: "sys", messages: [user("hi")], tools: [TOOL], budget: { maxOutputTokens: 4000, thinking } });
const side: Turn = { system: "sys", messages: [user("summarize")], tools: [], budget: { maxOutputTokens: 1500, thinking: "off" } };
function wire(id: string, protocol: "openai" | "anthropic", upstreamHost: string, extra: Partial<CustomWire> = {}): CustomWire {
  const g = MK.guessModel(id, { protocol, route: MK.routeOf(upstreamHost) });
  return {
    name: "t", protocol, headers: { authorization: "Bearer k" }, maxTokensField: "max_tokens", promptCaching: false, replayReasoning: false, upstreamHost,
    model: { thinking: g.thinking, efforts: g.efforts, effortField: g.effortField, effortDefault: g.effortDefault, alwaysThinks: g.alwaysThinks, maxOutput: g.maxOutput },
    ...extra,
  };
}
const openai = (id: string, upstreamHost = "openrouter.ai") =>
  createOpenAIAdapter({ provider: "custom-0000aaaa", apiKey: "k", model: id, baseUrl: "http://127.0.0.1:1/x/h/openai", custom: wire(id, "openai", upstreamHost) });

test("旁路请求（不带工具、思考 off）遇到关不掉思考的型号：发最低档并留推理余量；主循环不受影响", async () => {
  // GPT-6.1 Sol：必须思考、上游默认 medium；Muse Ember 默认 max——1500 的上限会被推理整段吃光（实测正文为空）
  const sol = await send(openai("openai/gpt-6.1-sol"), side);
  assert.equal(sol.reasoning_effort, "low");
  assert.equal(sol.max_tokens, 1500 + 2048);
  const ember = await send(openai("meta/muse-ember"), side);
  assert.equal(ember.reasoning_effort, "minimal");
  // 有真正关闭档的照旧发关闭档，上限不动
  const terra = await send(openai("openai/gpt-6.1-terra"), side);
  assert.equal(terra.reasoning_effort, "none");
  assert.equal(terra.max_tokens, 1500);
  // 没有默认档的通用三档型号（不发参数多半不思考）：不替它打开
  const mistral = await send(openai("mistralai/mistral-large-4-0"), side);
  assert.equal("reasoning_effort" in mistral, false);
  // 主循环：用户选了哪档发哪档
  const mainSol = await send(openai("openai/gpt-6.1-sol"), main("xhigh"));
  assert.equal(mainSol.reasoning_effort, "xhigh");
  assert.equal(mainSol.max_tokens, 4000);
});

test("floorTierWhenNoOff：只对「没有关闭档且默认就在思考」的型号给最低档", () => {
  const t = (ids: string[]) => ids.map((id) => ({ id, name: id, value: id }));
  assert.equal(floorTierWhenNoOff({ thinking: "effort", efforts: t(["low", "high"]), effortDefault: "high" }, "off"), "low");
  assert.equal(floorTierWhenNoOff({ thinking: "effort", efforts: t(["low", "high"]), alwaysThinks: true }, "off"), "low");
  assert.equal(floorTierWhenNoOff({ thinking: "effort", efforts: t(["off", "low", "high"]), effortDefault: "high" }, "off"), "");
  assert.equal(floorTierWhenNoOff({ thinking: "effort", efforts: t(["low", "high"]) }, "off"), "");
  assert.equal(floorTierWhenNoOff({ thinking: "effort", efforts: t(["low", "high"]), effortDefault: "high" }, "low"), "");
  assert.equal(floorTierWhenNoOff({ thinking: "none", efforts: [] }, "off"), "");
  assert.equal(floorTierWhenNoOff(undefined, "off"), "");
});

test("OpenRouter 上的 Claude 带顶层 cache_control（不带就完全不缓存）；别家、别的线路不带", async () => {
  assert.deepEqual((await send(openai("anthropic/claude-opus-5.5"), main("high"))).cache_control, { type: "ephemeral" });
  assert.equal("cache_control" in (await send(openai("openai/gpt-6-luna"), main("high"))), false);
  assert.equal("cache_control" in (await send(openai("anthropic/claude-opus-5.5", "relay.example.com"), main("high"))), false);
});

test("OpenRouter 线路的关闭档发 reasoning_effort:none，不是厂商直连的 thinking / enable_thinking", async () => {
  const ds = await send(openai("deepseek/deepseek-v4.1-flash"), main("off"));
  assert.equal(ds.reasoning_effort, "none");
  assert.equal("thinking" in ds, false);
  const qwenFlash = await send(openai("qwen/qwen3.8-flash"), main("off"));
  assert.deepEqual(qwenFlash.reasoning, { enabled: false });
  assert.equal("enable_thinking" in qwenFlash, false);
  // 直连写法不变
  const direct = MK.guessModel("deepseek-flash", { protocol: "openai" });
  assert.deepEqual(direct.efforts[0].value, { thinking: { type: "disabled" } });
});

test("经模型中心网关的官方 Anthropic 服务：地址是 127.0.0.1，靠卡上带的上游主机认出官方（提示缓存、1 小时 TTL）", async () => {
  const viaHub = (upstreamHost: string, promptCaching: boolean) =>
    createAnthropicAdapter({
      provider: "custom-0000bbbb", apiKey: "k", model: "claude-opus-5-5", baseUrl: "http://127.0.0.1:1/x/h/anthropic", cacheTtl: "1h",
      custom: wire("claude-opus-5-5", "anthropic", upstreamHost, { promptCaching, headers: { "x-api-key": "k" } }),
    });
  const official = await send(viaHub("api.anthropic.com", true), main("high"));
  assert.deepEqual(official.system.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
  // 第三方上游：开了提示缓存也只给默认 5 分钟（不一定认 ttl）
  const relay = await send(viaHub("relay.example.com", true), main("high"));
  assert.deepEqual(relay.system.at(-1).cache_control, { type: "ephemeral" });
  // 没开提示缓存：一个断点都不发
  const off = await send(viaHub("relay.example.com", false), main("high"));
  assert.equal(JSON.stringify(off).includes("cache_control"), false);
});

test("第三方 Anthropic 兼容端点：无签名思考照样回放，DeepSeek 的工具轮缺思考补空块；Claude 型号照旧丢无签名思考", async () => {
  const hist: Turn = {
    system: "sys",
    tools: [TOOL],
    budget: { maxOutputTokens: 1000, thinking: "high" },
    messages: [
      user("hi"),
      { role: "assistant", content: [{ t: "thinking", text: "想一下" }, { t: "tool_call", id: "toolu_1", name: "Read", args: { path: "a" } }] },
      { role: "user", content: [{ t: "tool_result", id: "toolu_1", ok: true, content: [{ t: "text", text: "body" }] }] },
      { role: "assistant", content: [{ t: "tool_call", id: "toolu_2", name: "Read", args: { path: "b" } }] },
      { role: "user", content: [{ t: "tool_result", id: "toolu_2", ok: true, content: [{ t: "text", text: "body" }] }] },
    ],
  };
  const anth = (id: string, host: string) =>
    createAnthropicAdapter({ provider: "custom-0000cccc", apiKey: "k", model: id, baseUrl: "http://127.0.0.1:1/x/h/anthropic", custom: wire(id, "anthropic", host, { headers: { "x-api-key": "k" } }) });
  const ds = await send(anth("deepseek-flash", "api.deepseek.com"), hist);
  assert.deepEqual(ds.messages[1].content[0], { type: "thinking", thinking: "想一下", signature: "" });
  assert.deepEqual(ds.messages[3].content[0], { type: "thinking", thinking: "", signature: "" }, "缺思考的工具轮补空块");
  const mimo = await send(anth("mimo-v2.6-pro", "api.xiaomimimo.com"), hist);
  assert.equal(mimo.messages[1].content[0].type, "thinking", "小米的签名恒为空，思考照样回放");
  assert.equal(mimo.messages[3].content[0].type, "tool_use", "别家不补空块");
  const claude = await send(anth("claude-opus-5-5", "relay.example.com"), hist);
  assert.equal(claude.messages[1].content[0].type, "tool_use", "Claude 上游验签，无签名思考照旧丢");
});

test("Gemini 原生协议：工具 schema 走 parametersJsonSchema（完整 JSON Schema），const、type 数组等关键字原样保留", async () => {
  const { createGeminiAdapter } = await import("./providers/gemini.ts");
  const tool = {
    name: "set_mode",
    description: "set",
    parameters: {
      type: "object" as const,
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: { mode: { const: "fast" }, name: { type: ["string", "null"] }, n: { type: "integer", exclusiveMinimum: 0 } },
      additionalProperties: false,
    },
  } as unknown as Turn["tools"][number];
  const body = await send(createGeminiAdapter({ provider: "gemini", apiKey: "k", model: "gemini-4-argon", baseUrl: "https://google.test/v1beta" }), {
    system: "sys", messages: [user("hi")], tools: [tool], budget: { maxOutputTokens: 1000, thinking: "low" },
  });
  const decl = body.tools[0].functionDeclarations[0];
  assert.equal("parameters" in decl, false, "老字段是 OpenAPI 子集，带这些关键字整轮 400；两个字段互斥");
  assert.deepEqual(decl.parametersJsonSchema.properties.mode, { const: "fast" });
  assert.deepEqual(decl.parametersJsonSchema.properties.name, { type: ["string", "null"] });
  assert.equal(decl.parametersJsonSchema.additionalProperties, false);
  assert.equal("$schema" in decl.parametersJsonSchema, false);
});
