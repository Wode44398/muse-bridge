import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import { createAnthropicAdapter } from "./providers/anthropic.ts";
import { createGeminiAdapter } from "./providers/gemini.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";

function response(events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function drain(adapter: { stream: (turn: Turn) => AsyncIterable<unknown> }, turn: Turn): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of adapter.stream(turn)) events.push(event);
  return events;
}

const turn: Turn = {
  system: "system prompt",
  messages: [
    {
      role: "assistant",
      content: [
        { t: "thinking", text: "reasoning", signature: "anthropic-signature" },
        {
          t: "tool_call",
          id: "call-1",
          name: "Read",
          args: { path: "src/app.ts" },
          meta: { thoughtSignature: "gemini-signature" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { t: "tool_result", id: "call-1", ok: true, content: [{ t: "text", text: "file body" }] },
      ],
    },
  ],
  tools: [
    {
      name: "Read",
      description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ],
  budget: { maxOutputTokens: 1000, thinking: "low" },
};

test("provider adapters replay neutral tool transcripts in their native wire formats", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = new Map<string, any>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    bodies.set(url, JSON.parse(String(init?.body ?? "{}")));
    if (url.includes("anthropic.test")) {
      return response([
        { type: "message_start", message: { usage: { input_tokens: 5 } } },
        { type: "message_stop" },
      ]);
    }
    if (url.includes("google.test")) {
      return response([
        {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        },
      ]);
    }
    return response([
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      "[DONE]",
    ]);
  }) as typeof fetch;

  try {
    await drain(
      createOpenAIAdapter({
        provider: "openai",
        apiKey: "test-key",
        model: "deepseek-flash",
        baseUrl: "https://openai.test/v1",
      }),
      turn,
    );
    await drain(
      createAnthropicAdapter({
        provider: "anthropic",
        apiKey: "test-key",
        model: "claude-sonnet-4-6",
        baseUrl: "https://anthropic.test",
      }),
      turn,
    );
    await drain(
      createGeminiAdapter({
        provider: "gemini",
        apiKey: "test-key",
        model: "gemini-3.5-flash",
        baseUrl: "https://google.test/v1beta",
      }),
      turn,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openai = bodies.get("https://openai.test/v1/chat/completions");
  const oaCall = openai.messages.find((message: any) => message.role === "assistant").tool_calls[0];
  assert.equal(oaCall.id, "call-1");
  assert.deepEqual(JSON.parse(oaCall.function.arguments), { path: "src/app.ts" });
  assert.deepEqual(
    openai.messages.find((message: any) => message.role === "tool"),
    { role: "tool", tool_call_id: "call-1", content: "file body" },
  );

  const anthropic = bodies.get("https://anthropic.test/v1/messages");
  assert.deepEqual(anthropic.messages[0].content[0], {
    type: "thinking",
    thinking: "reasoning",
    signature: "anthropic-signature",
  });
  assert.equal(anthropic.messages[0].content[1].type, "tool_use");
  assert.equal(anthropic.messages[0].content[1].id, "call-1");
  assert.equal(anthropic.messages[0].content[1].name, "Read");
  assert.deepEqual(anthropic.messages[0].content[1].input, { path: "src/app.ts" });
  assert.equal(anthropic.messages[1].content[0].tool_use_id, "call-1");

  const gemini = bodies.get(
    "https://google.test/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
  );
  assert.deepEqual(gemini.contents[0].parts[0], {
    functionCall: { name: "Read", args: { path: "src/app.ts" } },
    thoughtSignature: "gemini-signature",
  });
  assert.equal(gemini.contents[1].parts[0].functionResponse.name, "Read");
  assert.deepEqual(gemini.contents[1].parts[0].functionResponse.response, {
    output: "file body",
    ok: true,
  });
});

test("OpenAI-compatible adapter preserves malformed streamed tool arguments for loop recovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "bad-call", function: { name: "Read", arguments: '{"path":' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "[DONE]",
  ])) as typeof fetch;
  try {
    const events = await drain(
      createOpenAIAdapter({
        provider: "openai",
        apiKey: "test-key",
        model: "deepseek-flash",
        baseUrl: "https://openai.test/v1",
      }),
      turn,
    ) as any[];
    const call = events.find((event) => event.e === "tool_call");
    assert.equal(call.id, "bad-call");
    assert.match(call.argsError, /JSON|Unexpected|position|end/i);
    assert.equal(call.argsRaw, '{"path":');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider adapters encode a neutral image block as native multimodal input", async () => {
  const imageTurn: Turn = {
    system: "inspect images",
    messages: [{
      role: "user",
      content: [
        { t: "text", text: "What is shown?" },
        { t: "image", mime: "image/png", data: "aGVsbG8=" },
      ],
    }],
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
  };
  const originalFetch = globalThis.fetch;
  const bodies = new Map<string, any>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    bodies.set(url, JSON.parse(String(init?.body ?? "{}")));
    if (url.includes("anthropic.test")) {
      return response([{ type: "message_stop" }]);
    }
    if (url.includes("google.test")) {
      return response([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    }
    return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;

  try {
    await drain(createOpenAIAdapter({
      provider: "qwen", apiKey: "test", model: "qwen3.7-plus", baseUrl: "https://openai.test/v1",
    }), imageTurn);
    await drain(createAnthropicAdapter({
      provider: "anthropic", apiKey: "test", model: "claude-sonnet-4-6", baseUrl: "https://anthropic.test",
    }), imageTurn);
    await drain(createGeminiAdapter({
      provider: "gemini", apiKey: "test", model: "gemini-3.5-flash", baseUrl: "https://google.test/v1beta",
    }), imageTurn);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openaiPart = bodies.get("https://openai.test/v1/chat/completions").messages
    .find((message: any) => message.role === "user").content[1];
  assert.deepEqual(openaiPart, {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aGVsbG8=" },
  });
  const anthropicPart = bodies.get("https://anthropic.test/v1/messages").messages[0].content[1];
  assert.equal(anthropicPart.type, "image");
  assert.deepEqual(anthropicPart.source, {
    type: "base64", media_type: "image/png", data: "aGVsbG8=",
  });
  const geminiPart = bodies.get(
    "https://google.test/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
  ).contents[0].parts[1];
  assert.deepEqual(geminiPart, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
});

test("catalog capability prevents text-only Qwen models from receiving images", () => {
  const plus = createOpenAIAdapter({ provider: "qwen", apiKey: "test", model: "qwen3.7-plus" });
  const max = createOpenAIAdapter({ provider: "qwen", apiKey: "test", model: "qwen3.7-max" });
  const flash = createOpenAIAdapter({ provider: "qwen", apiKey: "test", model: "qwen3.7-flash" });
  assert.equal(plus.capabilities.image, true);
  assert.equal(max.capabilities.image, false);
  assert.equal(flash.capabilities.image, false);
});

test("Kimi adapter maps efforts, replays reasoning, and takes catalog limits", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;

  try {
    // k3: effort ladder + permanent thinking + reasoning replay in tool loops.
    const k3 = createOpenAIAdapter({
      provider: "kimi", apiKey: "test", model: "k3", baseUrl: "https://kimi.test/coding/v1",
    });
    assert.equal(k3.capabilities.contextWindow, 1_048_576);
    assert.equal(k3.capabilities.maxOutputTokens, 65_536);
    assert.equal(k3.capabilities.image, true);
    await drain(k3, turn); // turn's budget.thinking is "low"
    await drain(k3, { ...turn, budget: { maxOutputTokens: 1000, thinking: "max" } });
    // "off" cannot exist on a permanently-thinking model — it maps to the floor.
    await drain(k3, { ...turn, budget: { maxOutputTokens: 1000, thinking: "off" } });

    // K2.8 Preview (still the kimi-for-coding id): grew a ladder + 1M ctx on
    // 2026-09-11 — reasoning_effort rides along, mapped like k3.
    const coding = createOpenAIAdapter({
      provider: "kimi", apiKey: "test", model: "kimi-for-coding", baseUrl: "https://kimi.test/coding/v1",
    });
    assert.equal(coding.capabilities.contextWindow, 1_048_576);
    await drain(coding, { ...turn, budget: { maxOutputTokens: 1000, thinking: "high" } });

    // K2.7 Highspeed: the one Kimi model without a ladder — must not be sent.
    const highspeed = createOpenAIAdapter({
      provider: "kimi", apiKey: "test", model: "kimi-for-coding-highspeed", baseUrl: "https://kimi.test/coding/v1",
    });
    assert.equal(highspeed.capabilities.contextWindow, 262_144);
    await drain(highspeed, turn);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(bodies[1].reasoning_effort, "max");
  assert.equal(bodies[2].reasoning_effort, "low");
  assert.equal(bodies[3].reasoning_effort, "high");
  assert.equal("reasoning_effort" in bodies[4], false);
  // Kimi never uses the DeepSeek/Zhipu thinking:{type} switch.
  assert.equal("thinking" in bodies[0], false);
  // The assistant thinking block rides back as reasoning_content (Preserved
  // Thinking) for every Kimi model; other OpenAI-compatible vendors drop it.
  for (const body of bodies) {
    const assistant = body.messages.find((message: any) => message.role === "assistant");
    assert.equal(assistant.reasoning_content, "reasoning");
  }
});

test("non-Kimi OpenAI-compatible vendors still drop thinking blocks from replay", async () => {
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;
  try {
    await drain(createOpenAIAdapter({
      provider: "openai", apiKey: "test", model: "deepseek-flash", baseUrl: "https://openai.test/v1",
    }), turn);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const assistant = body.messages.find((message: any) => message.role === "assistant");
  assert.equal("reasoning_content" in assistant, false);
});

// 2026-09-10 新增的三家型号：DeepSeek V4.1-Flash（`deepseek-flash`，low 成了真档位 +
// 原生视觉）、GLM-5.3 系列（恒思考，thinking.type 只收 enabled）、Qwen3.8（图+视频）。
test("DeepSeek V4.1-Flash 的 low 不再折叠成 high", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;
  try {
    const flash = createOpenAIAdapter({
      provider: "openai", apiKey: "test", model: "deepseek-flash", baseUrl: "https://openai.test/v1",
    });
    for (const thinking of ["off", "low", "medium", "high", "max"] as const) {
      await drain(flash, { ...turn, budget: { ...turn.budget, thinking } });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(bodies.map((b) => b.thinking.type), [
    "disabled", "enabled", "enabled", "enabled", "enabled",
  ]);
  assert.deepEqual(bodies.map((b) => b.reasoning_effort), [
    undefined, "low", "high", "high", "max",
  ]);
});

test("GLM-5.3 恒思考：thinking.type 永远 enabled，三档 low/high/max", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;
  try {
    const glm53 = createOpenAIAdapter({
      provider: "zhipu", apiKey: "test", model: "glm-5.3", baseUrl: "https://zhipu.test/v4",
    });
    // "off" 只可能来自没走 clampEffort 的旧配置 —— 依然不许发 disabled。
    for (const thinking of ["off", "low", "high", "max"] as const) {
      await drain(glm53, { ...turn, budget: { ...turn.budget, thinking } });
    }
    const glm52 = createOpenAIAdapter({
      provider: "zhipu", apiKey: "test", model: "glm-5.2", baseUrl: "https://zhipu.test/v4",
    });
    await drain(glm52, { ...turn, budget: { ...turn.budget, thinking: "off" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(bodies.slice(0, 4).map((b) => b.thinking.type), [
    "enabled", "enabled", "enabled", "enabled",
  ]);
  assert.deepEqual(bodies.slice(0, 4).map((b) => b.reasoning_effort), [
    "low", "low", "high", "max",
  ]);
  // 5.2 还是能真关思考的，5.3 的强制开不许溢出到它身上。
  assert.equal(bodies[4].thinking.type, "disabled");
  assert.equal("reasoning_effort" in bodies[4], false);
});

test("catalog: qwen3.8 全系与 deepseek-flash 认图，qwen3.8 还认视频", () => {
  const q38max = createOpenAIAdapter({ provider: "qwen", apiKey: "test", model: "qwen3.8-max" });
  const q38flash = createOpenAIAdapter({ provider: "qwen", apiKey: "test", model: "qwen3.8-flash" });
  const dsFlash = createOpenAIAdapter({ provider: "openai", apiKey: "test", model: "deepseek-flash" });
  for (const a of [q38max, q38flash]) {
    assert.equal(a.capabilities.image, true);
    assert.equal(a.capabilities.video, true);
    assert.equal(a.capabilities.contextWindow, 1_000_000);
    assert.equal(a.capabilities.maxOutputTokens, 131_072);
  }
  assert.equal(dsFlash.capabilities.image, true);
  // V4.1-Flash 只吃 image_url —— video_url 实测直接 400，绝不能标 true。
  assert.equal(dsFlash.capabilities.video, false);
});

// 2026-09-10 regression: a session died with "Invalid assistant message: content
// or tool_calls must be set" and could never resume. The done-gate retracts a
// turn but keeps it in the provider transcript; when that turn was thinking-only
// (V4.1-Flash can end a turn with reasoning and empty content) it serialized to
// {role:"assistant", content:null} and DeepSeek 400'd on every later request.
test("thinking-only assistant turn never serializes to a content-less message", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }) as typeof fetch;

  try {
    const thinkingOnly: Turn = {
      system: "s",
      messages: [
        { role: "user", content: [{ t: "text", text: "scan" }] },
        // The retracted turn: reasoning happened, nothing else came out.
        { role: "assistant", content: [{ t: "thinking", text: "long reasoning" }] },
        { role: "user", content: [{ t: "text", text: "[Automated check] …" }] },
      ],
      tools: [],
      budget: { maxOutputTokens: 256 },
      thinking: "off",
    } as unknown as Turn;

    // Non-replay provider (DeepSeek): thinking is dropped, so content must still
    // be set to something the API accepts — an empty string, never null.
    const ds = createOpenAIAdapter({
      provider: "openai", apiKey: "test", model: "deepseek-flash", baseUrl: "https://ds.test",
    });
    await drain(ds, thinkingOnly);
    const dsAssistant = bodies[0].messages.find((m: any) => m.role === "assistant");
    assert.equal(dsAssistant.content, "", "content must be set, not null");
    assert.equal(dsAssistant.tool_calls, undefined);

    // Replay provider (Kimi): reasoning_content rides along, but content still
    // has to be set — reasoning_content alone does NOT satisfy the check.
    const kimi = createOpenAIAdapter({
      provider: "kimi", apiKey: "test", model: "k3", baseUrl: "https://kimi.test/coding/v1",
    });
    await drain(kimi, thinkingOnly);
    const kimiAssistant = bodies[1].messages.find((m: any) => m.role === "assistant");
    assert.equal(kimiAssistant.content, "");
    assert.equal(kimiAssistant.reasoning_content, "long reasoning");

    // A tool-call turn keeps content:null — that shape is valid and unchanged.
    const withCall: Turn = {
      ...thinkingOnly,
      messages: [
        { role: "user", content: [{ t: "text", text: "scan" }] },
        { role: "assistant", content: [{ t: "tool_call", id: "c1", name: "bash", args: { command: "ls" } }] },
      ],
    } as unknown as Turn;
    await drain(ds, withCall);
    const callAssistant = bodies[2].messages.find((m: any) => m.role === "assistant");
    assert.equal(callAssistant.content, null);
    assert.equal(callAssistant.tool_calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
