import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import type { AdapterConfig } from "./providers/types.ts";
import { createAnthropicAdapter } from "./providers/anthropic.ts";

// 提示缓存 TTL：主会话（cacheTtl:"1h"）走官方端点时四个断点都带 ttl:"1h"；子 agent（不传）、第三方地址一律默认 5 分钟。
// 四个断点同一个 TTL——官方要求长 TTL 的断点排在短的前面，混用会 400。

const turn: Turn = {
  system: "s",
  messages: [
    { role: "user", content: [{ t: "text", text: "hi" }] },
    { role: "assistant", content: [{ t: "text", text: "yo" }] },
    { role: "user", content: [{ t: "text", text: "again" }] },
  ],
  tools: [{ name: "Read", description: "d", parameters: { type: "object", properties: {} } }],
  budget: { maxOutputTokens: 16, thinking: "medium" },
} as unknown as Turn;

const done = new Response(
  ['{"type":"message_start","message":{"usage":{"input_tokens":1}}}', '{"type":"message_stop"}'].map((d) => `data: ${d}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

async function marks(cfg: Partial<AdapterConfig>): Promise<{ marks: unknown[]; headers: Record<string, string> }> {
  const originalFetch = globalThis.fetch;
  let body: any;
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    headers = init.headers as Record<string, string>;
    return done.clone();
  }) as typeof fetch;
  try {
    const adapter = createAnthropicAdapter({ provider: "anthropic", apiKey: "FAKE-key", model: "claude-opus-5-5", ...cfg });
    for await (const _ of adapter.stream(turn)) void _;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const out: unknown[] = [];
  for (const b of body.system ?? []) if (b.cache_control) out.push(b.cache_control);
  for (const t of body.tools ?? []) if (t.cache_control) out.push(t.cache_control);
  for (const m of body.messages) for (const b of m.content) if (b.cache_control) out.push(b.cache_control);
  return { marks: out, headers };
}

test("主会话 + 官方端点（默认地址）：四个断点全是 1 小时，不带 beta 头", async () => {
  const { marks: m, headers } = await marks({ cacheTtl: "1h" });
  assert.equal(m.length, 4);
  for (const c of m) assert.deepEqual(c, { type: "ephemeral", ttl: "1h" });
  assert.equal(headers["anthropic-beta"], undefined);
});

test("主会话 + 显式写官方地址（带 /v1、末尾斜杠）也算官方", async () => {
  const { marks: m } = await marks({ cacheTtl: "1h", baseUrl: "https://API.anthropic.com/v1/" });
  assert.equal(m.length, 4);
  for (const c of m) assert.deepEqual(c, { type: "ephemeral", ttl: "1h" });
});

test("子 agent（不传 cacheTtl）：默认 5 分钟", async () => {
  const { marks: m } = await marks({});
  assert.equal(m.length, 4);
  for (const c of m) assert.deepEqual(c, { type: "ephemeral" });
});

test("第三方兼容地址：不带 ttl（不一定认）", async () => {
  const { marks: m } = await marks({ cacheTtl: "1h", baseUrl: "https://anthropic.test" });
  assert.equal(m.length, 4);
  for (const c of m) assert.deepEqual(c, { type: "ephemeral" });
});
