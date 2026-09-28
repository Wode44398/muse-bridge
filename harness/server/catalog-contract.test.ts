// R1（#1）：目录与适配器的契约——测的是两份数据之间的关系，不是型号清单快照。
// 改写自探针 03-hermes-agent/笔记/probe-catalog-contract.ts。
//
// 修前：Anthropic、Gemini 适配器不读目录，一律用自己的扁平默认值（Anthropic 200k / 8192）——Opus 5.5 一轮最多
// 写 8192 token 就被截断；目录里 14 个型号没声明 ctx / maxOut，谁也说不清它们按多大算。

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG } from "./catalog.ts";
import { createAdapter } from "./providers/registry.ts";
import type { Turn } from "./agent/turn.ts";

test("目录里每个模型都声明了上下文窗口与最大输出", () => {
  const missing: string[] = [];
  for (const spec of CATALOG) {
    for (const m of spec.models) {
      if (!(Number(m.ctx) > 0) || !(Number(m.maxOut) > 0)) missing.push(`${spec.id}/${m.id}`);
    }
  }
  assert.deepEqual(missing, [], `没声明的型号：${missing.join(", ")}`);
});

test("每家适配器给出的 capabilities 与目录一致", () => {
  const mismatch: string[] = [];
  for (const spec of CATALOG) {
    for (const m of spec.models) {
      const cap = createAdapter({ provider: spec.id, model: m.id, apiKey: "FAKE-DUMMY-KEY" }).capabilities;
      if (cap.contextWindow !== m.ctx) mismatch.push(`${spec.id}/${m.id} ctx 目录=${m.ctx} 适配器=${cap.contextWindow}`);
      if (cap.maxOutputTokens !== m.maxOut) mismatch.push(`${spec.id}/${m.id} maxOut 目录=${m.maxOut} 适配器=${cap.maxOutputTokens}`);
    }
  }
  assert.deepEqual(mismatch, []);
});

test("Opus 5.5 一轮能写到会话天花板，不再卡在 8192", async () => {
  const adapter = createAdapter({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "FAKE-DUMMY-KEY" });
  assert.equal(adapter.capabilities.maxOutputTokens, 128_000);
  assert.equal(adapter.capabilities.contextWindow, 1_000_000);
  // 会话按 min(适配器上限, 65536) 下发预算（session.ts）；请求体里的 max_tokens 就是它
  const budget = Math.min(adapter.capabilities.maxOutputTokens, 65_536);
  const original = globalThis.fetch;
  let body: any = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  try {
    const turn: Turn = { system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: budget, thinking: "high" } };
    for await (const _ of adapter.stream(turn)) { /* drain */ }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(body?.max_tokens, 65_536, "修前是 8192");
});

test("Haiku 4.5 的传统思考预算放得下：max_tokens 永远大于 budget_tokens", async () => {
  const adapter = createAdapter({ provider: "anthropic", model: "claude-haiku-4-5", apiKey: "FAKE-DUMMY-KEY" });
  const budget = Math.min(adapter.capabilities.maxOutputTokens, 65_536);
  const original = globalThis.fetch;
  let body: any = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  try {
    const turn: Turn = { system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: budget, thinking: "high" } };
    for await (const _ of adapter.stream(turn)) { /* drain */ }
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(body.thinking?.budget_tokens > 0);
  assert.ok(body.max_tokens > body.thinking.budget_tokens);
  assert.ok(body.max_tokens <= 64_000, "不超过 Haiku 4.5 的官方上限");
});

test("目录外的自定义 id 仍落到各家的扁平默认值", () => {
  assert.equal(createAdapter({ provider: "anthropic", model: "claude-custom-x", apiKey: "FAKE" }).capabilities.maxOutputTokens, 8_192);
  assert.equal(createAdapter({ provider: "gemini", model: "gemini-custom-x", apiKey: "FAKE" }).capabilities.contextWindow, 1_000_000);
});
