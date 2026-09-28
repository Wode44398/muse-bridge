// Q2 / Q4：在 fetch 这一层假扮 provider——请求体原样记下（编码后的 wire 形状，adapter 自己对前缀做的事都在里面），
// 按脚本回 SSE。脚本一步 = 一次 HTTP 请求的回应，与 ScriptedAdapter 一样：多调、少调都在测试收尾判失败。只拦 baseUrl
// 下的请求；别的地址一律记账判失败（测试不出网）。三种形状：Anthropic Messages、OpenAI 兼容 Chat Completions、Gemini。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import type { StopReason, StreamEvent } from "../agent/events.ts";
import type { WireShape } from "../agent/turn.ts";

const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const ANTHROPIC_STOP: Record<StopReason, string> = { end: "end_turn", tool_use: "tool_use", length: "max_tokens", refusal: "refusal" };

// usage：合进回应里的用量对象（测缓存字段解析用），例如 { cache_read_input_tokens: 900 }。
export function anthropicSse(events: readonly StreamEvent[], usage: Record<string, unknown> = {}): string {
  const out: unknown[] = [{ type: "message_start", message: { usage: { input_tokens: 10, ...usage } } }];
  let index = 0;
  for (const ev of events) {
    if (ev.e === "text_delta") {
      out.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: ev.text } });
      out.push({ type: "content_block_stop", index });
      index++;
    } else if (ev.e === "tool_call") {
      out.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: ev.id, name: ev.name } });
      out.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(ev.args) } });
      out.push({ type: "content_block_stop", index });
      index++;
    } else if (ev.e === "turn_done") {
      out.push({ type: "message_delta", delta: { stop_reason: ANTHROPIC_STOP[ev.stopReason] }, usage: { output_tokens: 5 } });
      out.push({ type: "message_stop" });
    }
  }
  return sse(out);
}

const OPENAI_STOP: Record<StopReason, string> = { end: "stop", tool_use: "tool_calls", length: "length", refusal: "content_filter" };

// usage 合进最后那块的 usage（如 { prompt_tokens_details: { cached_tokens: 900 } }）；键 timings 另起一块（llama.cpp 兼容服务的形状）。
export function openaiSse(events: readonly StreamEvent[], usage: Record<string, unknown> = {}): string {
  const out: unknown[] = [];
  let toolIndex = 0;
  const { timings, ...usageFields } = usage;
  for (const ev of events) {
    if (ev.e === "text_delta") {
      out.push({ choices: [{ index: 0, delta: { content: ev.text } }] });
    } else if (ev.e === "tool_call") {
      out.push({
        choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex++, id: ev.id, type: "function", function: { name: ev.name, arguments: JSON.stringify(ev.args) } }] } }],
      });
    } else if (ev.e === "turn_done") {
      out.push({ choices: [{ index: 0, delta: {}, finish_reason: OPENAI_STOP[ev.stopReason] }] });
      out.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, ...usageFields } });
      if (timings) out.push({ choices: [], timings });
    }
  }
  return sse(out) + "data: [DONE]\n\n";
}

// usage 合进 usageMetadata（如 { cachedContentTokenCount: 900 }）。
export function geminiSse(events: readonly StreamEvent[], usage: Record<string, unknown> = {}): string {
  const out: unknown[] = [];
  for (const ev of events) {
    if (ev.e === "text_delta") out.push({ candidates: [{ content: { role: "model", parts: [{ text: ev.text }] } }] });
    else if (ev.e === "tool_call") out.push({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: ev.name, args: ev.args } }] } }] });
    else if (ev.e === "turn_done") {
      out.push({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: ev.stopReason === "length" ? "MAX_TOKENS" : "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, ...usage },
      });
    }
  }
  return sse(out);
}

const ENCODERS: Record<WireShape, (events: readonly StreamEvent[], usage?: Record<string, unknown>) => string> = {
  anthropic: anthropicSse,
  openai: openaiSse,
  gemini: geminiSse,
};

export interface FakeWire {
  readonly bodies: any[];
}

export interface FakeProviderOptions {
  baseUrl: string;
  shape: WireShape;
  steps: StreamEvent[][];
  // 第 n 次请求（0 起）回应里额外带的用量字段
  usage?: (call: number) => Record<string, unknown>;
}

// 装一个假 fetch：baseUrl 下的每个请求记下 JSON 请求体，按顺序回脚本里的下一步。测试收尾还原 fetch 并核对次数。
export function fakeProviderFetch(t: TestContext, opts: FakeProviderOptions): FakeWire {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  const stray: string[] = [];
  let n = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(opts.baseUrl)) {
      stray.push(url);
      return new Response("unexpected request in a test", { status: 400 });
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const call = n++;
    const step = opts.steps[call];
    // 非重试类错误，让 loop 立即收场（而不是按 5xx 重试四次）
    if (!step) return new Response("fake provider script exhausted", { status: 400 });
    return new Response(ENCODERS[opts.shape](step, opts.usage?.(call)), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    assert.deepEqual(stray, [], "测试里出现了发往别处的请求");
    assert.equal(n, opts.steps.length, `假 provider 被请求 ${n} 次，脚本有 ${opts.steps.length} 步`);
  });
  return { bodies };
}

export function fakeAnthropicFetch(t: TestContext, baseUrl: string, steps: StreamEvent[][]): FakeWire {
  return fakeProviderFetch(t, { baseUrl, shape: "anthropic", steps });
}

// ── Anthropic 缓存命中模型（MODELED，移植自探针 probe-context-windows.ts）────────────────────────────
// 请求展平成块：tools → system → 各消息的内容块。带 cache_control 的块 = 写入点（请求之后这段前缀进缓存）；
// 新请求能命中的 = 从它的每个断点往前最多 20 块之内、与历史写入点前缀完全相同的最长位置。
export interface AnthropicCacheRow {
  blocks: number;
  breakpoints: number[]; // 本请求的写入点（块下标）
  hit: number; // 能命中的最长前缀的最后一块下标，-1 = 一点都命中不了
  readChars: number;
  totalChars: number;
}

function flatten(body: any): any[] {
  const blocks: any[] = [];
  for (const tool of body.tools ?? []) blocks.push(tool);
  for (const s of body.system ?? []) blocks.push(s);
  for (const m of body.messages ?? []) for (const c of m.content) blocks.push({ role: m.role, ...c });
  return blocks;
}

export function anthropicCacheModel(bodies: any[]): AnthropicCacheRow[] {
  const written = new Set<string>();
  return bodies.map((body) => {
    const blocks = flatten(body);
    // 前缀键 = 链式哈希：第 i 块的键由第 i-1 块的键与本块内容（去掉 cache_control 标记）决定。
    const keys: string[] = [];
    let acc = "";
    for (const b of blocks) {
      const { cache_control: _mark, ...rest } = b;
      acc = hashOf(acc + JSON.stringify(rest));
      keys.push(acc);
    }
    const sizes = blocks.map((b) => JSON.stringify(b).length);
    const breakpoints = blocks.flatMap((b, i) => (b.cache_control ? [i] : []));
    let hit = -1;
    for (const bp of breakpoints) {
      for (let p = bp; p >= Math.max(0, bp - 20); p--) {
        if (written.has(keys[p])) {
          hit = Math.max(hit, p);
          break;
        }
      }
    }
    for (const bp of breakpoints) written.add(keys[bp]);
    const totalChars = sizes.reduce((a, b) => a + b, 0);
    const readChars = hit >= 0 ? sizes.slice(0, hit + 1).reduce((a, b) => a + b, 0) : 0;
    return { blocks: blocks.length, breakpoints, hit, readChars, totalChars };
  });
}

function hashOf(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}
