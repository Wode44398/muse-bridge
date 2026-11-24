// OpenRouter 的 reasoning_details（providers/reasoning-details.ts、providers/openai.ts）与端点拒收回传思考时的退路。
// 修前：OpenRouter 流里的 reasoning_details 只取了明文拼进思考，条目本身（签名、加密 data、格式）没留下，下一轮也不回传——
// 经 OpenRouter 跑 Anthropic / Gemini / OpenAI 推理型号时，带工具调用的回合接不上调用前的推理（加密条目整段丢）。
// 火山方舟这类端点见到消息上的 reasoning_content 就 400：回传思考的型号在那里每一轮都失败。
// 全部是假端点（test-harness/wire-fakes.ts），不调真实接口；令牌是 FAKE / DUMMY。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { MK } from "./model-knowledge.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";
import { rejectsReasoningReplay } from "./providers/classify.ts";
import { mergeDetail } from "./providers/reasoning-details.ts";
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

function wire(id: string, upstreamHost: string | undefined, extra: Partial<CustomWire> = {}): CustomWire {
  const g = MK.guessModel(id, { protocol: "openai", route: MK.routeOf(upstreamHost ?? "") });
  return {
    name: "t", protocol: "openai", headers: { authorization: "Bearer FAKE-DUMMY" }, maxTokensField: "max_tokens", promptCaching: false,
    ...(upstreamHost ? { upstreamHost } : {}),
    model: { thinking: g.thinking, efforts: g.efforts, effortField: g.effortField, effortDefault: g.effortDefault, alwaysThinks: g.alwaysThinks, maxOutput: g.maxOutput },
    ...extra,
  } as CustomWire;
}
const adapterFor = (baseUrl: string, id: string, upstreamHost: string | undefined, extra: Partial<CustomWire> = {}) =>
  createOpenAIAdapter({ provider: "custom-0000aaaa", apiKey: "FAKE-DUMMY", model: id, baseUrl, custom: wire(id, upstreamHost, extra) });
const assistantWithTool = (body: any) => body.messages.find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

// 一轮：思考按 OpenRouter 的样子分片来（同一条的分片、签名在后一片里、加密条目只有 data），然后调一次工具
const DETAIL_STEP = [
  { e: "thinking_delta" as const, text: "Let me ", details: [{ type: "reasoning.text", text: "Let me ", id: null, format: "anthropic-claude-v1", index: 0 }] },
  { e: "thinking_delta" as const, text: "check.", details: [{ type: "reasoning.text", text: "check.", signature: "SIG-FAKE-OR", id: null, format: "anthropic-claude-v1", index: 0 }] },
  { e: "thinking_delta" as const, text: "", details: [{ type: "reasoning.encrypted", data: "ENC-DUMMY-1", id: "rs_1", format: "anthropic-claude-v1", index: 1 }] },
  { e: "tool_call" as const, id: "call_1", name: "Probe", args: { n: 1 } },
  { e: "turn_done" as const, stopReason: "tool_use" as const },
];
const EXPECTED_DETAILS = [
  { type: "reasoning.text", text: "Let me check.", id: null, format: "anthropic-claude-v1", index: 0, signature: "SIG-FAKE-OR" },
  { type: "reasoning.encrypted", data: "ENC-DUMMY-1", id: "rs_1", format: "anthropic-claude-v1", index: 1 },
];

test("OpenRouter：流里的 reasoning_details 按条拼好（同一条的分片接起来、加密条目照收）、落进转录，下一轮原样按顺序回传", async (t) => {
  const baseUrl = "http://fake-openrouter.invalid/x/h/openai";
  const fake = fakeProviderFetch(t, { baseUrl, shape: "openai", steps: [DETAIL_STEP, [{ e: "text_delta", text: "好了" }, { e: "turn_done", stopReason: "end" }]] });
  const session = attachSession(adapterFor(baseUrl, "anthropic/claude-opus-5.5", "openrouter.ai"), tmp("dimensio-or-details-"), { tools: [probe] });
  await send(session, "查一下");
  const stored = session.state!.messages.find((m) => m.role === "assistant" && m.content.some((b) => b.t === "tool_call"))!;
  const think = stored.content.find((b) => b.t === "thinking");
  assert.ok(think && think.t === "thinking");
  assert.equal(think.text, "Let me check.");
  assert.deepEqual(think.details, EXPECTED_DETAILS, "条目随转录落盘（同一条的分片已拼好）");
  const replayed = assistantWithTool(fake.bodies[1]);
  assert.deepEqual(replayed.reasoning_details, EXPECTED_DETAILS, "原样、按原顺序回传");
  assert.equal(replayed.tool_calls[0].id, "call_1");
});

test("reasoning_details 只回给 OpenRouter 线路、或拿不到上游身份的网关；认得出是别家上游的不发", async (t) => {
  const history = [
    { role: "user" as const, content: [{ t: "text" as const, text: "go" }] },
    {
      role: "assistant" as const,
      content: [
        { t: "thinking" as const, text: "x", details: [{ type: "reasoning.encrypted", data: "ENC-DUMMY-2", index: 0 }] },
        { t: "tool_call" as const, id: "c1", name: "Probe", args: { n: 1 } },
      ],
    },
    { role: "user" as const, content: [{ t: "tool_result" as const, id: "c1", ok: true, content: [{ t: "text" as const, text: "probe 1" }] }] },
  ];
  const turn = { system: "sys", messages: history, tools: [probe.def], budget: { maxOutputTokens: 1000 } };
  const bodyVia = async (upstream: string | undefined, extra: Partial<CustomWire> = {}) => {
    const baseUrl = `http://fake-${upstream ?? "gateway"}.invalid/v1`;
    const fake = fakeProviderFetch(t, { baseUrl, shape: "openai", steps: [[{ e: "turn_done", stopReason: "end" }]] });
    for await (const _ of adapterFor(baseUrl, "some-model-x", upstream, extra).stream(turn)) void _;
    return assistantWithTool(fake.bodies[0]);
  };
  assert.ok((await bodyVia("openrouter.ai")).reasoning_details, "OpenRouter：回传");
  assert.ok((await bodyVia(undefined)).reasoning_details, "上游不明的网关：照响应里给过的回传");
  assert.equal((await bodyVia("api.deepseek.com")).reasoning_details, undefined, "认得出的别家上游：不发");
  assert.equal((await bodyVia("openrouter.ai", { replayReasoning: false })).reasoning_details, undefined, "服务上明确关掉回传思考：不发");
});

test("端点因回传的思考字段 400（火山方舟形状）：去掉字段重发一次、记一条日志，这个会话之后不再回传；不改服务配置", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => logs.push(a.map(String).join(" ")));
  const baseUrl = "http://fake-ark.invalid/api/v3";
  const refusal = {
    status: 400,
    body: JSON.stringify({ error: { code: "InvalidParameter", message: "The parameter `messages[2].reasoning_content` specified in the request are not valid: unknown field", type: "BadRequest" } }),
  };
  const fake = fakeProviderFetch(t, {
    baseUrl,
    shape: "openai",
    steps: [
      [{ e: "thinking_delta", text: "想一下" }, { e: "tool_call", id: "call_9", name: "Probe", args: { n: 9 } }, { e: "turn_done", stopReason: "tool_use" }],
      refusal,
      [{ e: "text_delta", text: "好了" }, { e: "turn_done", stopReason: "end" }],
      [{ e: "text_delta", text: "又好了" }, { e: "turn_done", stopReason: "end" }],
    ],
  });
  const w = { replayReasoning: true } as Partial<CustomWire>;
  const session = attachSession(adapterFor(baseUrl, "doubao-seed-2-0", "ark.cn-beijing.volces.com", w), tmp("dimensio-ark-"), { tools: [probe] });
  await send(session, "查一下");
  assert.equal(assistantWithTool(fake.bodies[1]).reasoning_content, "想一下", "第一次照服务声明回传");
  assert.equal("reasoning_content" in assistantWithTool(fake.bodies[2]), false, "被拒后去掉字段重发");
  assert.ok(logs.some((l) => /rejected replayed reasoning/.test(l) && /fake-ark\.invalid/.test(l)), "记一条日志");
  await send(session, "再来");
  assert.equal("reasoning_content" in assistantWithTool(fake.bodies[3]), false, "这个会话之后都不再回传");
  assert.equal(w.replayReasoning, true, "服务配置没被改");
  // 去掉字段重发改写了模型看过的历史的编码：报备过，前缀判定器记成 replay-refused，不是未报备的断点
  const breaks = session.state!.prefix.totals.breaks;
  assert.equal(breaks.unexplained, undefined, `没有未报备的断点：${JSON.stringify(breaks)}`);
  assert.equal(breaks["replay-refused"], 1);
});

test("认得出「不收回传思考」的错误：4xx 且点名 reasoning_content / reasoning_details、话术是不认识 / 不允许；别的 400 不算", () => {
  assert.equal(rejectsReasoningReplay(400, '{"error":{"message":"The parameter `messages[1].reasoning_content` specified in the request are not valid"}}'), true);
  assert.equal(rejectsReasoningReplay(400, '{"detail":"Extra inputs are not permitted","loc":["body","messages",3,"reasoning_details"]}'), true);
  assert.equal(rejectsReasoningReplay(422, "unrecognized field reasoning_content"), true);
  assert.equal(rejectsReasoningReplay(400, '{"error":{"message":"max_tokens is too large"}}'), false);
  assert.equal(rejectsReasoningReplay(500, "unknown field reasoning_content"), false, "5xx 不算");
  assert.equal(rejectsReasoningReplay(400, "reasoning_content is required for thinking mode"), false, "要求带上（DeepSeek 那种）不是拒收");
  // OpenAI 兼容端点的标准错误外壳带 "type":"invalid_request_error"：外壳里的 invalid 不算话术
  const shell = (message: string) => JSON.stringify({ error: { message, type: "invalid_request_error", param: null, code: null } });
  assert.equal(rejectsReasoningReplay(400, shell("reasoning_content is required for thinking mode")), false, "带标准外壳的「要求带上」不是拒收");
  assert.equal(rejectsReasoningReplay(400, shell("reasoning_content is missing in assistant tool call message at index 3")), false, "Kimi 形状：缺了不是拒收");
  assert.equal(rejectsReasoningReplay(400, shell("Missing `reasoning_content` field in the assistant message at message index 1")), false, "DeepSeek 形状：缺了不是拒收");
  assert.equal(rejectsReasoningReplay(400, shell("Unrecognized request argument supplied: reasoning_content")), true, "带标准外壳的拒收照样认");
  assert.equal(rejectsReasoningReplay(400, shell("reasoning_content must not be present in assistant messages")), true, "「不许带」是拒收");
  assert.equal(
    rejectsReasoningReplay(422, JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "messages", 1, "reasoning_content"], msg: "Extra inputs are not permitted" }] })),
    true,
    "pydantic 列表形状：字段名只在 loc 里",
  );
});

test("reasoning_details 分片合并：类型、index、id 对得上才拼；签名取后来给的；对不上另起一条", () => {
  const list: Record<string, unknown>[] = [];
  mergeDetail(list, { type: "reasoning.text", text: "a", index: 0 });
  mergeDetail(list, { type: "reasoning.text", text: "b", index: 0, signature: "S" });
  mergeDetail(list, { type: "reasoning.summary", summary: "s1", index: 1 });
  mergeDetail(list, { type: "reasoning.summary", summary: "s2", index: 1 });
  mergeDetail(list, { type: "reasoning.text", text: "c", index: 2 });
  assert.deepEqual(list, [
    { type: "reasoning.text", text: "ab", index: 0, signature: "S" },
    { type: "reasoning.summary", summary: "s1s2", index: 1 },
    { type: "reasoning.text", text: "c", index: 2 },
  ]);
});
