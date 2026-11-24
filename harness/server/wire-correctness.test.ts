// 线路正确性：模型能力不该被请求编码吃掉。
//
// 修前：① Anthropic 一轮里的多块思考被拼成一块、只留最后一个签名、挪到正文和工具调用前面；redacted_thinking 不收；
// display 默认 omitted 时思考原文为空，连同签名整块丢掉——Opus 4.7+ / Fable 的思考从来没回传过。② 经本机网关或第三方
// Anthropic 兼容端点的卡没声明提示缓存时按主机名判成关。③ 型号表不认识的型号，流里给过 reasoning_content 也不回传。
// ④ 百炼 / llama.cpp 的 parallel_tool_calls 默认 false，没人发，一轮只出一个调用。⑤ OpenAI 兼容线路上，同一条用户消息里
// 「工具结果 + 正文」编码成 user 在 tool 之前，配对断了。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import type { Block, Msg, Turn } from "./agent/turn.ts";
import { AssistantAssembler } from "./agent/loop/assistant-blocks.ts";
import { createAnthropicAdapter, resetCacheRejections } from "./providers/anthropic.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";
import type { CustomWire } from "./providers/types.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { fakeProviderFetch } from "./test-harness/wire-fakes.ts";
import { ok, type Tool } from "./tools/types.ts";

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

const probe: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Probe", description: "probe", parameters: { type: "object", properties: { n: { type: "number" } } } },
  async run(args) {
    return ok("probed", `probe ${String(args.n)}`);
  },
};
const TOOL = probe.def;
const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const noCache = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));
const assistantWithTool = (body: any) => body.messages.find((m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "tool_use"));

async function drain(adapter: { stream: (turn: Turn) => AsyncIterable<StreamEvent> }, turn: Turn): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of adapter.stream(turn)) out.push(ev);
  return out;
}

// ── 1. Anthropic 思考块 ─────────────────────────────────────────────────────────

test("Anthropic：多块思考逐块、按原顺序落转录并回传，各带各的签名；redacted_thinking 原样回传；空原文带签名的块不丢", async (t) => {
  const baseUrl = "http://fake-anthropic.invalid";
  const wire = fakeProviderFetch(t, {
    baseUrl,
    shape: "anthropic",
    steps: [
      [
        { e: "thinking_delta", text: "", redacted: "REDACTED-DUMMY" },
        { e: "thinking_delta", text: "先看看", signature: "SIG-FAKE-1" },
        { e: "text_delta", text: "我查一下。" },
        { e: "thinking_delta", text: "", signature: "SIG-FAKE-2" },
        { e: "tool_call", id: "toolu_1", name: "Probe", args: { n: 1 } },
        { e: "turn_done", stopReason: "tool_use" },
      ],
      [{ e: "text_delta", text: "好了" }, { e: "turn_done", stopReason: "end" }],
    ],
  });
  const adapter = createAnthropicAdapter({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "FAKE-KEY", baseUrl });
  const session = attachSession(adapter, tmp("dimensio-wire-think-"), { tools: [probe] });
  await send(session, "查一下");

  const stored = session.state!.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.t === "tool_call"))!;
  assert.deepEqual(stored.content.map((b) => b.t), ["thinking", "thinking", "text", "thinking", "tool_call"], "转录按产出顺序");
  assert.deepEqual(stored.content[0], { t: "thinking", text: "", redacted: "REDACTED-DUMMY" });
  assert.deepEqual(stored.content[1], { t: "thinking", text: "先看看", signature: "SIG-FAKE-1" });
  assert.deepEqual(stored.content[3], { t: "thinking", text: "", signature: "SIG-FAKE-2" });

  const replayed = noCache(assistantWithTool(wire.bodies[1])) as any;
  assert.deepEqual(replayed.content, [
    { type: "redacted_thinking", data: "REDACTED-DUMMY" },
    { type: "thinking", thinking: "先看看", signature: "SIG-FAKE-1" },
    { type: "text", text: "我查一下。" },
    { type: "thinking", thinking: "", signature: "SIG-FAKE-2" },
    { type: "tool_use", id: "toolu_1", name: "Probe", input: { n: 1 } },
  ]);
});

test("Anthropic：旧会话里拼成一块、排在最前的思考照旧回放（落盘格式向后兼容）", async (t) => {
  const baseUrl = "http://fake-anthropic-old.invalid";
  const wire = fakeProviderFetch(t, { baseUrl, shape: "anthropic", steps: [[{ e: "turn_done", stopReason: "end" }]] });
  const adapter = createAnthropicAdapter({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "FAKE-KEY", baseUrl });
  const legacy: Msg = {
    role: "assistant",
    content: [
      { t: "thinking", text: "合在一起的思考", signature: "SIG-FAKE-OLD" },
      { t: "text", text: "旧答复" },
      { t: "tool_call", id: "toolu_old", name: "Probe", args: {} },
    ],
  };
  await drain(adapter, {
    system: "sys",
    tools: [TOOL],
    budget: { maxOutputTokens: 1000, thinking: "high" },
    messages: [user("hi"), legacy, { role: "user", content: [{ t: "tool_result", id: "toolu_old", ok: true, content: [{ t: "text", text: "x" }] }] }],
  });
  assert.deepEqual((noCache(wire.bodies[0].messages[1]) as any).content, [
    { type: "thinking", thinking: "合在一起的思考", signature: "SIG-FAKE-OLD" },
    { type: "text", text: "旧答复" },
    { type: "tool_use", id: "toolu_old", name: "Probe", input: {} },
  ]);
});

test("Anthropic：redacted_thinking 只发给验签的上游；不验签的第三方型号（小米）不收这个块", async (t) => {
  const baseUrl = "http://fake-anthropic-mimo.invalid";
  const wire = fakeProviderFetch(t, { baseUrl, shape: "anthropic", steps: [[{ e: "turn_done", stopReason: "end" }]] });
  const custom: CustomWire = { name: "t", protocol: "anthropic", headers: { "x-api-key": "FAKE-KEY" }, maxTokensField: "max_tokens", promptCaching: false, replayReasoning: false, upstreamHost: "api.xiaomimimo.com" };
  const adapter = createAnthropicAdapter({ provider: "custom-0000dddd", apiKey: "FAKE-KEY", model: "mimo-v2.6-pro", baseUrl, custom });
  await drain(adapter, {
    system: "sys",
    tools: [TOOL],
    budget: { maxOutputTokens: 1000, thinking: "high" },
    messages: [
      user("hi"),
      { role: "assistant", content: [{ t: "thinking", text: "", redacted: "REDACTED-DUMMY" }, { t: "thinking", text: "想" }, { t: "tool_call", id: "toolu_1", name: "Probe", args: {} }] },
      { role: "user", content: [{ t: "tool_result", id: "toolu_1", ok: true, content: [{ t: "text", text: "x" }] }] },
    ],
  });
  const types = wire.bodies[0].messages[1].content.map((c: any) => c.type);
  assert.deepEqual(types, ["thinking", "tool_use"]);
});

test("拼块器：按下标切块，签名封块，正文 / 工具调用隔开的思考另起；工具调用取最终参数、流里没占位的接在末尾", () => {
  const a = new AssistantAssembler();
  a.thinking({ text: "a", index: 0 });
  a.thinking({ text: "b", index: 0 });
  a.thinking({ text: "c", index: 1 }); // 换了下标：新的一块
  a.thinking({ text: "", signature: "SIG-FAKE", index: 1 });
  a.thinking({ text: "d" }); // 签名之后：新的一块
  a.text("x");
  a.text("y");
  a.thinking({ text: "e" });
  a.call();
  a.thinking({ text: "f" });
  const out = a.build([
    { id: "c1", name: "Probe", args: { n: 2 } },
    { id: "c2", name: "Probe", args: { n: 3 } },
  ]);
  assert.deepEqual(out, [
    { t: "thinking", text: "ab" },
    { t: "thinking", text: "c", signature: "SIG-FAKE" },
    { t: "thinking", text: "d" },
    { t: "text", text: "xy" },
    { t: "thinking", text: "e" },
    { t: "tool_call", id: "c1", name: "Probe", args: { n: 2 }, meta: undefined },
    { t: "thinking", text: "f" },
    { t: "tool_call", id: "c2", name: "Probe", args: { n: 3 }, meta: undefined },
  ] satisfies Block[]);
});

test("拼块器：同一轮两个调用 id 相同（或都为空）时按出现顺序各占一块，参数不串、一个不丢", () => {
  const a = new AssistantAssembler();
  a.text("并行查两处");
  a.call();
  a.call();
  const out = a.build([
    { id: "", name: "Probe", args: { n: 1 } },
    { id: "", name: "Probe", args: { n: 2 } },
  ]);
  assert.deepEqual(out, [
    { t: "text", text: "并行查两处" },
    { t: "tool_call", id: "", name: "Probe", args: { n: 1 }, meta: undefined },
    { t: "tool_call", id: "", name: "Probe", args: { n: 2 }, meta: undefined },
  ] satisfies Block[]);
});

test("OpenAI 兼容：端点给的工具调用 id 为空或重复时重新编号，转录里两个调用、两条结果一一配对", async (t) => {
  const baseUrl = "http://fake-dupid.invalid/v1";
  const wire = fakeProviderFetch(t, {
    baseUrl,
    shape: "openai",
    steps: [
      [
        { e: "tool_call", id: "", name: "Probe", args: { n: 1 } },
        { e: "tool_call", id: "", name: "Probe", args: { n: 2 } },
        { e: "tool_call", id: "dup", name: "Probe", args: { n: 3 } },
        { e: "tool_call", id: "dup", name: "Probe", args: { n: 4 } },
        { e: "turn_done", stopReason: "tool_use" },
      ],
      [{ e: "text_delta", text: "完成" }, { e: "turn_done", stopReason: "end" }],
    ],
  });
  const adapter = createOpenAIAdapter({ provider: "openai", model: "deepseek-flash", apiKey: "FAKE-KEY", baseUrl });
  const session = attachSession(adapter, tmp("dimensio-wire-dupid-"), { tools: [probe] });
  await send(session, "并行探");
  const stored = session.state!.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.t === "tool_call"))!;
  const calls = stored.content.filter((b) => b.t === "tool_call") as Extract<Block, { t: "tool_call" }>[];
  assert.deepEqual(calls.map((c) => c.args.n), [1, 2, 3, 4], "四个调用都在、参数各是各的");
  const ids = calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 4, "id 两两不同");
  assert.ok(ids.every(Boolean), "没有空 id");
  assert.equal(ids[2], "dup", "头一个用到的 id 原样保留");
  const asst = wire.bodies[1].messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert.deepEqual(asst.tool_calls.map((c: any) => c.id), ids);
  const toolIds = wire.bodies[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
  assert.deepEqual(toolIds, ids, "每个调用一条结果，按 id 配上");
});

// ── 2. 提示缓存标记 ─────────────────────────────────────────────────────────────

const relayWire = (promptCaching: boolean): CustomWire => ({
  name: "relay", protocol: "anthropic", headers: { "x-api-key": "FAKE-KEY" }, maxTokensField: "max_tokens", promptCaching, replayReasoning: false, upstreamHost: "relay.example.com",
});
const simple = (): Turn => ({ system: "sys", tools: [TOOL], budget: { maxOutputTokens: 1000, thinking: "high" }, messages: [user("hi")] });

test("经网关的第三方 Anthropic 兼容卡：打缓存标记（不带 1 小时）；缓存时长等响应里真见到缓存读写才报，且只报 5 分钟", async (t) => {
  const baseUrl = "http://127.0.0.1:1/x/h/anthropic";
  const wire = fakeProviderFetch(t, {
    baseUrl,
    shape: "anthropic",
    steps: [[{ e: "turn_done", stopReason: "end" }], [{ e: "turn_done", stopReason: "end" }]],
    usage: (call) => (call === 0 ? {} : { cache_creation_input_tokens: 900 }),
  });
  const adapter = createAnthropicAdapter({ provider: "custom-0000eeee", apiKey: "FAKE-KEY", model: "claude-opus-5-5", baseUrl, cacheTtl: "1h", custom: relayWire(true) });
  assert.equal(adapter.capabilities.cacheTtlMs, undefined, "还不知道上游真缓存没有：不报时长，空闲压缩不赶");
  await drain(adapter, simple());
  assert.deepEqual(wire.bodies[0].system.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(adapter.capabilities.cacheTtlMs, undefined, "响应里没有缓存读写：照旧不报");
  await drain(adapter, simple());
  assert.equal(adapter.capabilities.cacheTtlMs, 300_000, "见到缓存写入：按 5 分钟报（不冒领官方端点的 1 小时）");
});

test("官方 Anthropic 端点：缓存时长建适配器时就报（主会话 1 小时）", () => {
  const adapter = createAnthropicAdapter({ provider: "anthropic", apiKey: "FAKE-KEY", model: "claude-opus-5-5", baseUrl: "https://api.anthropic.com", cacheTtl: "1h" });
  assert.equal(adapter.capabilities.cacheTtlMs, 3_600_000);
});

test("第三方端点以 cache_control 为由 400：去掉标记当场重发，这个服务之后不再发", async (t) => {
  resetCacheRejections();
  t.after(resetCacheRejections);
  const baseUrl = "http://fake-relay.invalid/anthropic";
  const wire = fakeProviderFetch(t, {
    baseUrl,
    shape: "anthropic",
    steps: [
      { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content.0.cache_control: Extra inputs are not permitted" } }) },
      [{ e: "text_delta", text: "OK" }, { e: "turn_done", stopReason: "end" }],
      [{ e: "turn_done", stopReason: "end" }],
    ],
  });
  const make = () => createAnthropicAdapter({ provider: "custom-0000ffff", apiKey: "FAKE-KEY", model: "claude-opus-5-5", baseUrl, custom: relayWire(true) });
  const adapter = make();
  const events = await drain(adapter, simple());
  assert.ok(events.some((e) => e.e === "text_delta" && e.text === "OK"), "重发那次照常出字");
  assert.ok(JSON.stringify(wire.bodies[0]).includes("cache_control"));
  assert.equal(JSON.stringify(wire.bodies[1]).includes("cache_control"), false);
  assert.equal(adapter.capabilities.cache, false);
  assert.equal(adapter.capabilities.cacheTtlMs, undefined, "Claude 型号不带标记就没有缓存");
  const again = make();
  assert.equal(again.capabilities.cache, false, "同一个服务新建的适配器不再发");
  await drain(again, simple());
  assert.equal(JSON.stringify(wire.bodies[2]).includes("cache_control"), false);
});

test("第三方端点别的 400 照常报错，不重发", async (t) => {
  resetCacheRejections();
  const baseUrl = "http://fake-relay-2.invalid/anthropic";
  fakeProviderFetch(t, { baseUrl, shape: "anthropic", steps: [{ status: 400, body: JSON.stringify({ error: { type: "invalid_request_error", message: "max_tokens too large" } }) }] });
  const adapter = createAnthropicAdapter({ provider: "custom-0000aaab", apiKey: "FAKE-KEY", model: "claude-opus-5-5", baseUrl, custom: relayWire(true) });
  const events = await drain(adapter, simple());
  assert.ok(events.some((e) => e.e === "error"));
  assert.equal(adapter.capabilities.cache, true);
});

// ── 3. reasoning_content 回传 ───────────────────────────────────────────────────

test("OpenAI 兼容：型号表不认识的型号，流里给过 reasoning_content 的思考在工具续轮原样回传", async (t) => {
  const baseUrl = "http://fake-compat.invalid/v1";
  const wire = fakeProviderFetch(t, {
    baseUrl,
    shape: "openai",
    steps: [
      [{ e: "thinking_delta", text: "先探一下" }, { e: "tool_call", id: "call_1", name: "Probe", args: { n: 1 } }, { e: "turn_done", stopReason: "tool_use" }],
      [{ e: "text_delta", text: "完成" }, { e: "turn_done", stopReason: "end" }],
    ],
  });
  const adapter = createOpenAIAdapter({ provider: "openai", model: "acme-reasoner-1", apiKey: "FAKE-KEY", baseUrl });
  const session = attachSession(adapter, tmp("dimensio-wire-rc-"), { tools: [probe] });
  await send(session, "探一下");
  const stored = session.state!.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.t === "tool_call"))!;
  assert.deepEqual(stored.content[0], { t: "thinking", text: "先探一下", wire: "reasoning_content" });
  const asst = wire.bodies[1].messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert.equal(asst.reasoning_content, "先探一下");
});

test("OpenAI 兼容：认不出的型号发到 OpenAI 官方端点不带 reasoning_content；表里认识、没标回传的型号照旧不带", async (t) => {
  const thought: Msg = { role: "assistant", content: [{ t: "thinking", text: "想过", wire: "reasoning_content" }, { t: "tool_call", id: "call_1", name: "Probe", args: {} }] };
  const turn: Turn = {
    system: "sys",
    tools: [TOOL],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    messages: [user("hi"), thought, { role: "user", content: [{ t: "tool_result", id: "call_1", ok: true, content: [{ t: "text", text: "x" }] }] }],
  };
  const official = fakeProviderFetch(t, { baseUrl: "https://api.openai.com/v1", shape: "openai", steps: [[{ e: "turn_done", stopReason: "end" }], [{ e: "turn_done", stopReason: "end" }]] });
  await drain(createOpenAIAdapter({ provider: "openai", model: "acme-reasoner-1", apiKey: "FAKE-KEY", baseUrl: "https://api.openai.com/v1" }), turn);
  assert.equal(official.bodies[0].messages[2].reasoning_content, undefined);
  await drain(createOpenAIAdapter({ provider: "openai", model: "gpt-5.5", apiKey: "FAKE-KEY", baseUrl: "https://api.openai.com/v1" }), turn);
  assert.equal(official.bodies[1].messages[2].reasoning_content, undefined);
});

test("OpenAI 兼容：服务上明确关掉「回传思考」时，认不出的型号也不回传 reasoning_content；没声明才自动回传", async (t) => {
  const baseUrl = "http://fake-compat-off.invalid/v1";
  const wire = fakeProviderFetch(t, { baseUrl, shape: "openai", steps: [[{ e: "turn_done", stopReason: "end" }], [{ e: "turn_done", stopReason: "end" }]] });
  const thought: Msg = { role: "assistant", content: [{ t: "thinking", text: "想过", wire: "reasoning_content" }, { t: "tool_call", id: "call_1", name: "Probe", args: {} }] };
  const turn: Turn = {
    system: "sys",
    tools: [TOOL],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    messages: [user("hi"), thought, { role: "user", content: [{ t: "tool_result", id: "call_1", ok: true, content: [{ t: "text", text: "x" }] }] }],
  };
  const wireOf = (replayReasoning?: boolean): CustomWire => ({
    name: "ark", protocol: "openai", headers: { authorization: "Bearer FAKE-KEY" }, maxTokensField: "max_tokens", promptCaching: false, upstreamHost: "ark.example.com",
    ...(replayReasoning !== undefined ? { replayReasoning } : {}),
  });
  await drain(createOpenAIAdapter({ provider: "custom-0000abcd", model: "ep-20250101-dummy", apiKey: "FAKE-KEY", baseUrl, custom: wireOf(false) }), turn);
  await drain(createOpenAIAdapter({ provider: "custom-0000abcd", model: "ep-20250101-dummy", apiKey: "FAKE-KEY", baseUrl, custom: wireOf() }), turn);
  assert.equal(wire.bodies[0].messages[2].reasoning_content, undefined, "明确关掉：不回传");
  assert.equal(wire.bodies[1].messages[2].reasoning_content, "想过", "没声明：自动回传");
});

// ── 4. 并行工具调用 ─────────────────────────────────────────────────────────────

test("并行工具调用：百炼（Qwen）默认不并行，显式发 parallel_tool_calls:true；默认就并行的线路不发；不带工具的旁路请求不发", async (t) => {
  const baseUrl = "http://fake-par.invalid/v1";
  const wire = fakeProviderFetch(t, { baseUrl, shape: "openai", steps: [[{ e: "turn_done", stopReason: "end" }], [{ e: "turn_done", stopReason: "end" }], [{ e: "turn_done", stopReason: "end" }]] });
  await drain(createOpenAIAdapter({ provider: "qwen", model: "qwen3.8-max", apiKey: "FAKE-KEY", baseUrl }), simple());
  await drain(createOpenAIAdapter({ provider: "qwen", model: "qwen3.8-max", apiKey: "FAKE-KEY", baseUrl }), { ...simple(), tools: [] });
  await drain(createOpenAIAdapter({ provider: "openai", model: "deepseek-flash", apiKey: "FAKE-KEY", baseUrl }), simple());
  assert.equal(wire.bodies[0].parallel_tool_calls, true);
  assert.equal("parallel_tool_calls" in wire.bodies[1], false);
  assert.equal("parallel_tool_calls" in wire.bodies[2], false);
});

// ── 5. 角色配对 ─────────────────────────────────────────────────────────────────

test("OpenAI 兼容：同一条用户消息里工具结果之后还有正文时，tool 消息紧跟 assistant，正文排在后面", async (t) => {
  const baseUrl = "http://fake-order.invalid/v1";
  const wire = fakeProviderFetch(t, { baseUrl, shape: "openai", steps: [[{ e: "turn_done", stopReason: "end" }]] });
  await drain(createOpenAIAdapter({ provider: "openai", model: "deepseek-flash", apiKey: "FAKE-KEY", baseUrl }), {
    system: "sys",
    tools: [TOOL],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    messages: [
      user("hi"),
      { role: "assistant", content: [{ t: "tool_call", id: "call_1", name: "Probe", args: {} }] },
      { role: "user", content: [{ t: "tool_result", id: "call_1", ok: true, content: [{ t: "text", text: "x" }] }, { t: "text", text: "顺便说一句" }] },
    ],
  });
  assert.deepEqual(wire.bodies[0].messages.map((m: any) => m.role), ["system", "user", "assistant", "tool", "user"]);
});
