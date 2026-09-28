import { randomBytes } from "node:crypto";
import type { Block, Msg, Turn } from "../agent/turn.ts";
import type { StreamEvent, StopReason } from "../agent/events.ts";
import type { AdapterConfig, Capabilities, ProviderAdapter } from "./types.ts";
import { readSSE } from "./sse.ts";
import { httpErrorEvent, streamErrorEvent } from "./classify.ts";
import { observeWire } from "./wire-fingerprint.ts";
import { modelLimits, modelSupportsImages, providerMediaBudget } from "../catalog.ts";

const DEFAULTS = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  baseUrl: "https://api.anthropic.com",
};

// U3：工具参数生成进度的上报间隔（活动行「生成参数 · N 字」；太密了只是白占带宽）
export const TOOL_PROGRESS_EVERY_MS = 1_500;

// Legacy manual-thinking budgets — ONLY for models that still accept
// thinking:{type:"enabled",budget_tokens} (Haiku 4.5 and earlier). Adaptive
// models (Opus 4.8/4.7, Sonnet 4.6) 400 on budget_tokens; they use effort instead.
const THINKING_BUDGET: Record<string, number> = { low: 4_000, medium: 8_000, high: 12_000 };

// Adaptive-thinking models: thinking:{type:"adaptive"} + output_config.effort.
// Everything else (haiku-*) uses the legacy budget_tokens path.
function isAdaptive(model: string): boolean {
  return /claude-(opus-4-[78]|sonnet-4-6|sonnet-5|opus-4-6)/i.test(model) ||
    // future-proof: any opus/sonnet at 4.7+ is adaptive; haiku stays legacy.
    (/claude-(opus|sonnet)/i.test(model) && !/haiku/i.test(model));
}

// Map the unified effort ladder to Anthropic's effort values. "max" → "xhigh"
// (what Claude Code calls the extra tier).
const EFFORT_MAP: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

export function createAnthropicAdapter(cfg: AdapterConfig): ProviderAdapter {
  // R1（#1）：按型号读目录里的上限（与 OpenAI 兼容适配器同一条路）。以前一律 200k / 8192，
  // Opus 5.5 一轮最多写 8192 token 就被截断；目录外的自定义 id 才落到下面的扁平默认值。
  const limits = modelLimits(cfg.provider, cfg.model);
  const capabilities: Capabilities = {
    contextWindow: cfg.contextWindow ?? limits.ctx ?? DEFAULTS.contextWindow,
    maxOutputTokens: cfg.maxOutputTokens ?? limits.maxOut ?? DEFAULTS.maxOutputTokens,
    thinking: cfg.thinking ?? true,
    image: modelSupportsImages(cfg.provider, cfg.model),
    // No video input on the Messages API — video falls back to sampled frames.
    video: false,
    cache: true,
    parallelToolCalls: true,
    compactAt: limits.compactAt,
    mediaBudget: providerMediaBudget(cfg.provider),
  };
  const baseUrl = (cfg.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");

  return {
    id: "anthropic",
    model: cfg.model,
    capabilities,
    async *stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const body = encode(turn, cfg.model, capabilities);
      observeWire(turn, "anthropic", body);
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok || !res.body) {
        const raw = await safeText(res);
        yield httpErrorEvent(res, raw); // R7：按业务码 / 话术 / 状态码 / 响应头分类
        return;
      }

      // Per-content-block accumulation state, keyed by block index.
      const blocks = new Map<
        number,
        { type: string; toolId?: string; toolName?: string; jsonBuf: string; reportedAt?: number }
      >();
      let inputTokens = 0;
      let outputTokens = 0;
      // Q4：缓存读 / 写分开记（两者之和加未缓存部分 = inputTokens）。
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let stopReason: StopReason = "end";
      // R17（K18）：兜底 id 全局唯一（见 openai.ts 同处；Anthropic 实际总会给 toolu_ id）
      const idNonce = randomBytes(4).toString("hex");

      for await (const msg of readSSE(res, signal)) {
        if (!msg.data || msg.data === "[DONE]") continue;
        let ev: any;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          continue;
        }

        switch (ev.type) {
          case "message_start": {
            // Sum cached + uncached: downstream treats inputTokens as the
            // measured prompt size (lastContextTokens calibration); with
            // message caching on, input_tokens alone is just the new suffix.
            const u = ev.message?.usage ?? {};
            cacheReadTokens = u.cache_read_input_tokens ?? 0;
            cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
            inputTokens = (u.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens;
            break;
          }

          case "content_block_start": {
            const cb = ev.content_block;
            blocks.set(ev.index, {
              type: cb.type,
              toolId: cb.id,
              toolName: cb.name,
              jsonBuf: "",
              reportedAt: Date.now(),
            });
            // U3：一知道工具名就报，参数可能还要写好几分钟
            if (cb.type === "tool_use") yield { e: "tool_call_begin", id: cb.id ?? `call_${idNonce}_${ev.index}`, name: cb.name ?? "unknown", chars: 0 };
            break;
          }

          case "content_block_delta": {
            const st = blocks.get(ev.index);
            const d = ev.delta;
            if (d.type === "text_delta") {
              yield { e: "text_delta", text: d.text };
            } else if (d.type === "thinking_delta") {
              yield { e: "thinking_delta", text: d.thinking };
            } else if (d.type === "signature_delta" && st) {
              // Emit the signature so the loop can store it for replay.
              yield { e: "thinking_delta", text: "", signature: d.signature };
            } else if (d.type === "input_json_delta" && st) {
              st.jsonBuf += d.partial_json;
              // U3：参数写了多少字，节流上报（活动行「生成参数 · N 字」）
              if (Date.now() - (st.reportedAt ?? 0) >= TOOL_PROGRESS_EVERY_MS) {
                st.reportedAt = Date.now();
                yield { e: "tool_call_begin", id: st.toolId ?? `call_${idNonce}_${ev.index}`, name: st.toolName ?? "unknown", chars: st.jsonBuf.length };
              }
            }
            break;
          }

          case "content_block_stop": {
            const st = blocks.get(ev.index);
            if (st && st.type === "tool_use") {
              let args: Record<string, unknown> = {};
              let argsError: string | undefined;
              try {
                args = st.jsonBuf ? JSON.parse(st.jsonBuf) : {};
              } catch (err) {
                // Don't swallow into {} — the loop feeds this back to the model.
                argsError = (err as Error).message;
              }
              yield {
                e: "tool_call",
                id: st.toolId ?? `call_${idNonce}_${ev.index}`,
                name: st.toolName ?? "unknown",
                args,
                ...(argsError ? { argsError, argsRaw: st.jsonBuf.slice(0, 2000) } : {}),
              };
            }
            break;
          }

          case "message_delta":
            if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
            if (ev.delta?.stop_reason) stopReason = mapStop(ev.delta.stop_reason);
            break;

          case "message_stop":
            yield { e: "usage", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
            yield { e: "turn_done", stopReason };
            return;

          case "error": {
            // In-stream overloaded/rate-limit/api errors are transient (retriable);
            // R7：分类器还认得超窗、欠费这些（先压缩再试 / 重试没用）。
            yield streamErrorEvent(ev.error?.type ?? "stream_error", ev.error);
            return;
          }
        }
      }

      // Stream ended without an explicit message_stop.
      yield { e: "usage", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
      yield { e: "turn_done", stopReason };
    },
  };
}

function mapStop(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    default:
      return "end";
  }
}

// ── Encode neutral Turn -> Anthropic Messages request body ───────────────────

function encode(turn: Turn, model: string, caps: Capabilities) {
  const level = turn.budget.thinking ?? "off";
  const thinkingOn = caps.thinking && level !== "off";
  const adaptive = isAdaptive(model);
  // Legacy budget only matters for non-adaptive (Haiku) models.
  const budgetTokens = thinkingOn && !adaptive ? (THINKING_BUDGET[level] ?? 12_000) : 0;
  // With legacy thinking on, max_tokens must exceed the thinking budget.
  const maxTokens = Math.max(
    turn.budget.maxOutputTokens,
    budgetTokens ? budgetTokens + 1024 : 0,
  );

  const system = encodeSystem(turn, caps.cache);
  const tools = encodeTools(turn, caps.cache);

  const messages = turn.messages.map(encodeMsg);
  if (caps.cache) markMessageCache(messages);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  if (system) body.system = system;
  if (tools.length) body.tools = tools;
  if (adaptive) {
    // Opus 4.7+/Sonnet 4.6: adaptive thinking + effort. budget_tokens would 400.
    // Even at "off" we keep adaptive on (the model self-gates) but pin effort low.
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: EFFORT_MAP[level] ?? "low" };
  } else if (thinkingOn) {
    // Haiku 4.5 and earlier: manual budget.
    body.thinking = { type: "enabled", budget_tokens: budgetTokens };
  }
  if (turn.hints?.providerExtras) Object.assign(body, turn.hints.providerExtras);
  return body;
}

function encodeSystem(turn: Turn, cache: boolean) {
  if (typeof turn.system === "string") {
    if (!turn.system) return undefined;
    const block: any = { type: "text", text: turn.system };
    if (cache) block.cache_control = { type: "ephemeral" };
    return [block];
  }
  const arr = turn.system
    .filter((b) => b.t === "text")
    .map((b) => ({ type: "text", text: (b as { text: string }).text }) as any);
  if (cache && arr.length) arr[arr.length - 1].cache_control = { type: "ephemeral" };
  return arr.length ? arr : undefined;
}

function encodeTools(turn: Turn, cache: boolean) {
  const tools = turn.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  })) as any[];
  // Cache the large static tool prefix (system + tools) with one breakpoint.
  if (cache && tools.length) tools[tools.length - 1].cache_control = { type: "ephemeral" };
  return tools;
}

// Sliding cache breakpoints on the last two messages. The transcript is a
// monotonically growing prefix, so the older mark reproduces the breakpoint the
// previous request wrote (guaranteed hit) and the newer one extends the cache
// for the next turn. With the system + tools marks this uses all 4 allowed slots.
function markMessageCache(messages: any[]) {
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const last = content[content.length - 1];
    // thinking blocks cannot carry cache_control; fall back to an earlier message.
    if (last.type === "thinking" || last.type === "redacted_thinking") continue;
    last.cache_control = { type: "ephemeral" };
    marked++;
  }
}

function encodeMsg(m: Msg) {
  return { role: m.role, content: m.content.map(encodeBlock).filter(Boolean) };
}

function encodeBlock(b: Block): any {
  switch (b.t) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", thinking: b.text, signature: b.signature ?? "" };
    case "image":
      return { type: "image", source: imageSource(b) };
    case "tool_call":
      return { type: "tool_use", id: b.id, name: b.name, input: b.args };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.id,
        is_error: !b.ok,
        content: b.content.map(encodeBlock).filter(Boolean),
      };
  }
}

function imageSource(b: { mime: string; data?: string; url?: string }) {
  if (b.url) return { type: "url", url: b.url };
  return { type: "base64", media_type: b.mime, data: b.data ?? "" };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<no body> (status ${res.status})`;
  }
}
