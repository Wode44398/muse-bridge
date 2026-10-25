import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import { createAnthropicAdapter, FAST_COOLDOWN_MS, FAST_MODE_BETA, resetFastCooldown } from "./providers/anthropic.ts";
import { modelSupportsFast } from "./catalog.ts";
import { getConfig, resolveConfig } from "./config.ts";

// fast mode：开关开着且型号支持 → 请求体带 speed:"fast" + beta 头；其余情况两样都不带（不支持的型号带了必 400）。

const turn: Turn = {
  system: "s",
  messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }],
  tools: [],
  budget: { maxOutputTokens: 16, thinking: "medium" },
} as unknown as Turn;

const done = new Response(
  ['{"type":"message_start","message":{"usage":{"input_tokens":1}}}', '{"type":"message_stop"}'].map((d) => `data: ${d}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

async function capture(model: string, fast?: () => boolean): Promise<{ body: any; headers: Record<string, string> }> {
  resetFastCooldown();
  const originalFetch = globalThis.fetch;
  let seen: { body: any; headers: Record<string, string> } | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = { body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    return done.clone();
  }) as typeof fetch;
  try {
    const adapter = createAnthropicAdapter({ provider: "anthropic", apiKey: "FAKE-key", model, baseUrl: "https://anthropic.test", fast });
    for await (const _ of adapter.stream(turn)) void _;
  } finally {
    globalThis.fetch = originalFetch;
  }
  return seen!;
}

test("fast 开着 + 支持的型号：带 speed 与 beta 头", async () => {
  const { body, headers } = await capture("claude-opus-5-5", () => true);
  assert.equal(body.speed, "fast");
  assert.equal(headers["anthropic-beta"], FAST_MODE_BETA);
});

test("fast 关着：什么都不带", async () => {
  const { body, headers } = await capture("claude-opus-5-5", () => false);
  assert.equal(body.speed, undefined);
  assert.equal(headers["anthropic-beta"], undefined);
});

test("fast 开着但型号不支持（Sonnet 5.5）：不发，免得 400", async () => {
  const { body, headers } = await capture("claude-sonnet-5-5", () => true);
  assert.equal(body.speed, undefined);
  assert.equal(headers["anthropic-beta"], undefined);
});

test("开关现读：同一个适配器，关掉后下一次请求就不带", async () => {
  let on = true;
  const first = await capture("claude-opus-5", () => on);
  on = false;
  const second = await capture("claude-opus-5", () => on);
  assert.equal(first.body.speed, "fast");
  assert.equal(second.body.speed, undefined);
});

test("目录的 fast 表与 2026-10-14 实测一致", () => {
  for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) assert.equal(modelSupportsFast("anthropic", m), true, m);
  for (const m of ["claude-sonnet-5-5", "claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-5-5"]) assert.equal(modelSupportsFast("anthropic", m), false, m);
  assert.equal(modelSupportsFast("kimi", "k3"), false);
});

test("配置：fast 只收布尔值", () => {
  assert.equal(resolveConfig(getConfig(), { fast: true }).fast, true);
  assert.throws(() => resolveConfig(getConfig(), { fast: "yes" as unknown as boolean }), /fast must be/);
});

// ── fast 自己的 429：当场按普通速度重发、退避一段时间、在对话里说一声 ─────────────────────────
const fastLimited = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your rate limit of 0 fast mode input tokens per minute" } }), { status: 429 });
const plainLimited = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your rate limit of 2000000 input tokens per minute" } }), { status: 429 });

async function runSeq(replies: Array<() => Response>, fast: () => boolean = () => true) {
  const originalFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push({ body: JSON.parse(String(init.body)), headers: init.headers });
    return (replies.shift() ?? (() => done.clone()))();
  }) as typeof fetch;
  const events: any[] = [];
  try {
    const adapter = createAnthropicAdapter({ provider: "anthropic", apiKey: "FAKE-key", model: "claude-opus-5-5", baseUrl: "https://anthropic.test", fast });
    for await (const ev of adapter.stream(turn)) events.push(ev);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { sent, events };
}

test("fast 撞 fast 自己的 429：当场按普通速度重发，发一条 notice，不报错", async () => {
  resetFastCooldown();
  const { sent, events } = await runSeq([fastLimited]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.speed, "fast");
  assert.equal(sent[1].body.speed, undefined);
  assert.equal(sent[1].headers["anthropic-beta"], undefined);
  assert.deepEqual(events.find((e) => e.e === "notice"), { e: "notice", code: "fast_fallback", cooldownMs: FAST_COOLDOWN_MS });
  assert.equal(events.some((e) => e.e === "error"), false);
  assert.equal(events.at(-1).e, "turn_done");
});

test("退避期内不再试 fast，也不重复提示；清掉退避后照旧发 fast", async () => {
  resetFastCooldown();
  await runSeq([fastLimited]);
  const during = await runSeq([]);
  assert.equal(during.sent.length, 1);
  assert.equal(during.sent[0].body.speed, undefined);
  assert.equal(during.events.some((e) => e.e === "notice"), false);
  resetFastCooldown();
  const after = await runSeq([]);
  assert.equal(after.sent[0].body.speed, "fast");
});

test("fast 开着但撞的是普通额度的 429：不降级、不退避，照常交给通用重试", async () => {
  resetFastCooldown();
  const { sent, events } = await runSeq([plainLimited]);
  assert.equal(sent.length, 1);
  assert.equal(events.some((e) => e.e === "notice"), false);
  assert.equal(events.find((e) => e.e === "error")?.retriable, true);
  const next = await runSeq([]);
  assert.equal(next.sent[0].body.speed, "fast");
});
