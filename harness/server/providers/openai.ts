import { randomBytes } from "node:crypto";
import type { Block, Msg, Turn } from "../agent/turn.ts";
import type { StreamEvent, StopReason } from "../agent/events.ts";
import type { AdapterConfig, Capabilities, ProviderAdapter } from "./types.ts";
import { readSSE } from "./sse.ts";
import { httpErrorEvent, streamErrorEvent } from "./classify.ts";
import { observeWire } from "./wire-fingerprint.ts";
import { TOOL_PROGRESS_EVERY_MS } from "./anthropic.ts";
import { modelLimits, modelSpec, modelSupportsImages, modelSupportsVideo, modelSupportsAudio, providerMediaBudget } from "../catalog.ts";

const DEFAULTS = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  baseUrl: "https://api.openai.com/v1",
};

export function createOpenAIAdapter(cfg: AdapterConfig): ProviderAdapter {
  // Catalog entries are authoritative per model (not merely per provider):
  // qwen3.7-plus is multimodal while qwen3.7 max/flash are text-only, whereas the
  // whole qwen3.8 line and deepseek-flash (V4.1) see images natively.
  // Custom model ids fall back to the catalog helper's conservative heuristic.
  const canSeeImages = modelSupportsImages(cfg.provider, cfg.model);
  // Catalog knows per-model limits (K3 is 1M ctx, GLM-5.2 is 1M, permanently-
  // thinking models need output headroom) — flat provider defaults otherwise.
  const limits = modelLimits(cfg.provider, cfg.model);
  const capabilities: Capabilities = {
    contextWindow: cfg.contextWindow ?? limits.ctx ?? DEFAULTS.contextWindow,
    maxOutputTokens: cfg.maxOutputTokens ?? limits.maxOut ?? DEFAULTS.maxOutputTokens,
    thinking: cfg.thinking ?? false,
    image: canSeeImages,
    video: modelSupportsVideo(cfg.provider, cfg.model),
    audio: modelSupportsAudio(cfg.provider, cfg.model),
    cache: false,
    parallelToolCalls: true,
    compactAt: limits.compactAt,
    mediaBudget: providerMediaBudget(cfg.provider),
  };
  const baseUrl = (cfg.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
  // Kimi and MiMo require the original reasoning trace on subsequent tool
  // turns; keep it in the neutral transcript and replay as reasoning_content.
  const replayReasoning = cfg.provider === "kimi" || cfg.provider === "mimo";

  return {
    id: cfg.provider,
    model: cfg.model,
    capabilities,
    async *stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const body = encode(turn, cfg.model, capabilities, replayReasoning);
      const level = turn.budget.thinking ?? "off";
      const on = level !== "off";
      // Each OpenAI-compatible vendor gates reasoning differently — these mirror
      // the per-model effort ladders declared in catalog.ts.
      if (cfg.provider === "openai") {
        // DeepSeek: thinking:{type} + reasoning_effort. 自 V4.1-Flash
        // (`deepseek-flash`, 2026-09-10) 起 low/high/max 三档都是真的——实测同一道
        // 组合数题，low 的 reasoning_content 明显短于 high/max，所以 low 不再折叠成
        // high。medium 没有对应档，向下并入 high。留在单子里的 v4-pro 只收 high/max
        // （catalog 的 efforts 已经把 low 夹掉了）。普通 OpenAI 端点会忽略这两个字段。
        body.thinking = { type: on ? "enabled" : "disabled" };
        if (on) {
          body.reasoning_effort = level === "max" ? "max" : level === "low" ? "low" : "high";
        }
      } else if (cfg.provider === "qwen") {
        // Qwen3.7/3.8 (DashScope): enable_thinking + thinking_budget. No
        // reasoning_effort. 3.8 的思维链上限是 262144 token，这里的三档远在其下，
        // 是刻意的成本闸——要更长的思考就把下面的数字调大，不是模型不支持。
        body.enable_thinking = on;
        if (on) {
          body.thinking_budget =
            level === "high" ? 32_768 : level === "medium" ? 16_384 : 8_192;
        }
        // DashScope built-in web search: let Qwen consult the live web when it
        // judges the prompt needs current facts (same "model decides" model as
        // Gemini's google_search — uses the existing DashScope key, no extra
        // credential). Two hard-won wire constraints, both verified against the
        // live API: (1) it grounds only in STREAMING mode — non-stream + thinking
        // 400s ("Non-streaming mode does not support Web Search in thinking mode");
        // we always stream, so fine. (2) Do NOT pass search_options.search_strategy
        // ="agent": that agent mode rejects any request that also declares tools
        // (400 "Agent mode does not support tools"), and the harness always injects
        // tools. Bare enable_search (default strategy) grounds fine alongside
        // function calling. Proof: without it qwen3.7-plus answered the STALE
        // deepseek-chat/-reasoner; with it, the current deepseek-v4-pro/-flash.
        body.enable_search = true;
      } else if (cfg.provider === "zhipu") {
        // Zhipu GLM: reasoning trace streams in delta.reasoning_content (handled
        // below). glm-5.2 takes reasoning_effort (high/max); glm-5 is on/off only.
        // glm-5.3 系列恒思考——thinking.type 只认 "enabled"，发 "disabled" 是无效值，
        // 所以这里强制开；catalog 也没给它 off 档，clampEffort 会把 off 夹成 low。
        // 三档 low/high/max 与 5.3 服务端一一对应（服务端默认 max）。
        const alwaysThinks = /glm-5\.3/i.test(cfg.model);
        body.thinking = { type: on || alwaysThinks ? "enabled" : "disabled" };
        if ((on || alwaysThinks) && /glm-5\.[23]/i.test(cfg.model)) {
          body.reasoning_effort =
            level === "max" ? "max" : level === "low" || level === "off" ? "low" : "high";
        }
      } else if (cfg.provider === "kimi") {
        // Kimi for Coding: thinking is permanent (supports_thinking_type:"only"),
        // so there is no off switch and "off" just rides the lowest tier. The
        // effort ladder (reasoning_effort low/high/max) is declared per model in
        // catalog.ts straight from /models think_efforts — k3, k3-256k and the
        // K2.8 Preview behind kimi-for-coding have it, K2.7 Highspeed does not
        // and silently ignores the field. We only send it where the catalog says
        // it means something; unknown custom ids get it too (harmless when
        // ignored, and the endpoint never 400s on it). Temperature is server-
        // managed on this endpoint — never set it.
        const ladder = modelSpec("kimi", cfg.model)?.efforts;
        if (!ladder || ladder.length > 1) {
          body.reasoning_effort =
            level === "max" ? "max" : level === "high" || level === "medium" ? "high" : "low";
        }
      } else if (cfg.provider === "mimo") {
        // MiMo V2.6 exposes a binary thinking switch, not an effort ladder.
        // max is rejected by Chat Completions; temperature/top_p are managed
        // by MiMo in thinking mode. Preserve reasoning_content for tool loops.
        body.thinking = { type: on ? "enabled" : "disabled" };
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
        delete body.reasoning_effort;
      }
      observeWire(turn, "openai", body);
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok || !res.body) {
        let raw = await safeText(res);
        if (cfg.provider === "mimo" && cfg.model === "mimo-v2.6-pro-ultraspeed" &&
            res.status === 400 && /not supported model/i.test(raw)) {
          raw = "当前 MiMo API 端点或密钥未开放 UltraSpeed。请在设置中配置有 UltraSpeed 权限的 API Key/地址，或选择普通 Pro / Flash。\n" + raw;
        }
        yield httpErrorEvent(res, raw); // R7：按业务码 / 话术 / 状态码 / 响应头分类
        return;
      }
      // R7：有的厂商出错时回 200 + 一段 JSON（不是 SSE）——读出来按错误分类，别当成「空回复」
      if ((res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
        const raw = await safeText(res);
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* 原样交给分类器 */
        }
        yield streamErrorEvent("http_200_error", parsed);
        return;
      }

      // Accumulate streamed tool calls by their choice index.
      const toolCalls = new Map<number, { id: string; name: string; argsBuf: string; reportedAt?: number }>();
      // R17（K18）：服务端没给 id 时的兜底要全局唯一——以前是 call_<序号>，每一轮都从 call_0 起，同一段转录里会撞 id
      //（K1 按 id 查证据就会查到别的调用）。09-25 实测真实会话 2100 次调用四家都给了 id，这里只是兜底。
      const idNonce = randomBytes(4).toString("hex");
      let inputTokens = 0;
      let outputTokens = 0;
      // Q4：输入里命中缓存的量，各家字段不同；没回报就不填（和「命中 0」区分开）。
      let cacheReadTokens: number | undefined;
      let stopReason: StopReason = "end";

      for await (const msg of readSSE(res, signal)) {
        if (!msg.data || msg.data === "[DONE]") continue;
        let ev: any;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          continue;
        }
        // R7：国内厂商常把业务错误夹在 SSE 块里（HTTP 已经是 200）
        if (ev?.error && !ev.choices) {
          yield streamErrorEvent(String(ev.error.type ?? ev.error.code ?? "stream_error"), ev);
          return;
        }

        if (ev.usage) {
          inputTokens = ev.usage.prompt_tokens ?? inputTokens;
          outputTokens = ev.usage.completion_tokens ?? outputTokens;
          // OpenAI / Kimi / Qwen / GLM：prompt_tokens_details.cached_tokens；DeepSeek：prompt_cache_hit_tokens
          const cached = ev.usage.prompt_tokens_details?.cached_tokens ?? ev.usage.prompt_cache_hit_tokens;
          if (typeof cached === "number") cacheReadTokens = cached;
        }
        // llama.cpp 兼容服务（自定义 baseUrl）：最后一块带 timings，cache_n = 这次复用的 KV
        if (typeof ev.timings?.cache_n === "number") cacheReadTokens = ev.timings.cache_n;

        const choice = ev.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content) {
          yield { e: "text_delta", text: delta.content };
        }
        // DeepSeek-reasoner and some compatible endpoints stream reasoning here.
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          yield { e: "thinking_delta", text: delta.reasoning_content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let slot = toolCalls.get(idx);
            if (!slot) {
              slot = { id: tc.id ?? `call_${idNonce}_${idx}`, name: "", argsBuf: "" };
              toolCalls.set(idx, slot);
            }
            if (tc.id) slot.id = tc.id;
            const named = !slot.name && Boolean(tc.function?.name);
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.argsBuf += tc.function.arguments;
            // U3：一知道工具名就报，之后按时间节流报参数写了多少字（活动行「生成参数 · N 字」）
            if (named || (slot.name && Date.now() - (slot.reportedAt ?? 0) >= TOOL_PROGRESS_EVERY_MS)) {
              slot.reportedAt = Date.now();
              yield { e: "tool_call_begin", id: slot.id, name: slot.name, chars: slot.argsBuf.length };
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = mapStop(choice.finish_reason);
        }
      }

      // Flush accumulated tool calls once the stream is complete. Malformed
      // argument JSON (truncated stream, model glitch) is NOT silently swallowed
      // into {} — the loop feeds the parse error back so the model can re-issue.
      for (const [, slot] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        let argsError: string | undefined;
        try {
          args = slot.argsBuf ? JSON.parse(slot.argsBuf) : {};
        } catch (err) {
          argsError = (err as Error).message;
        }
        yield {
          e: "tool_call",
          id: slot.id,
          name: slot.name || "unknown",
          args,
          ...(argsError ? { argsError, argsRaw: slot.argsBuf.slice(0, 2000) } : {}),
        };
      }

      yield { e: "usage", inputTokens, outputTokens, ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}) };
      yield { e: "turn_done", stopReason };
    },
  };
}

function mapStop(reason: string): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "length";
    case "content_filter":
      return "refusal";
    default:
      return "end";
  }
}

// ── Encode neutral Turn -> OpenAI Chat Completions request body ──────────────

function encode(turn: Turn, model: string, caps: Capabilities, replayReasoning = false) {
  const messages: any[] = [];

  const system = systemString(turn.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of turn.messages) messages.push(...encodeMsg(m, replayReasoning));

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: turn.budget.maxOutputTokens || caps.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (turn.tools.length) {
    body.tools = turn.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (turn.hints?.providerExtras) Object.assign(body, turn.hints.providerExtras);
  return body;
}

function systemString(system: Turn["system"]): string {
  if (typeof system === "string") return system;
  return system
    .filter((b) => b.t === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
}

// One neutral message can expand into several OpenAI messages: tool_result
// blocks must become their own `role:"tool"` messages (OpenAI has no neutral
// tool role — results ride in a user message in our model).
function encodeMsg(m: Msg, replayReasoning = false): any[] {
  const out: any[] = [];
  const toolResults = m.content.filter((b) => b.t === "tool_result");
  const rest = m.content.filter((b) => b.t !== "tool_result");

  if (m.role === "assistant") {
    const textParts: string[] = [];
    const thinkParts: string[] = [];
    const toolCalls: any[] = [];
    for (const b of rest) {
      if (b.t === "text") textParts.push(b.text);
      // Thinking blocks: dropped on plain OpenAI endpoints (no replay concept),
      // but replayed as reasoning_content where the vendor mandates it (Kimi's
      // K2.7 Preserved Thinking / K3 tool loops).
      else if (b.t === "thinking") {
        if (replayReasoning && b.text) thinkParts.push(b.text);
      } else if (b.t === "tool_call") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.args) },
        });
      }
    }
    const msg: any = { role: "assistant" };
    // DeepSeek hard-rejects an assistant message carrying neither content nor
    // tool_calls ("Invalid assistant message: content or tool_calls must be
    // set"), and reasoning_content does NOT satisfy it — verified live. A turn
    // can legitimately end with thinking only: V4.1-Flash sometimes returns
    // reasoning with empty content, and loop.ts's done-gate deliberately keeps
    // such a retracted turn in the provider transcript. Since thinking blocks
    // are dropped for every non-replay provider, that message serializes to
    // nothing and poisons the history for good — every later request replays it
    // and 400s, so the session can never continue. An empty string counts as
    // "set", so only leave content null when tool_calls carry the message.
    msg.content = textParts.join("") || (toolCalls.length ? null : "");
    if (thinkParts.length) msg.reasoning_content = thinkParts.join("\n");
    if (toolCalls.length) msg.tool_calls = toolCalls;
    out.push(msg);
  } else {
    // user: text/image content becomes one user message (if any).
    const parts = rest.map(userPart).filter(Boolean);
    if (parts.length) {
      const onlyText = parts.every((p: any) => p.type === "text");
      out.push({
        role: "user",
        content: onlyText ? parts.map((p: any) => p.text).join("") : parts,
      });
    }
  }

  // tool_result blocks -> role:"tool" messages, paired by tool_call_id.
  for (const b of toolResults) {
    if (b.t !== "tool_result") continue;
    out.push({ role: "tool", tool_call_id: b.id, content: toolMessageText(b) });
  }
  return out;
}

// R17（K17）：OpenAI 兼容的 tool 消息没有「失败」字段（Anthropic 有 is_error，Gemini 在 response 里带 ok）——失败的结果补一个
// 「Error:」前缀（本来就以 error 开头的不重复加），空输出给占位，模型才分得清「这一步没成」与「成功了但没有输出」。
export function toolMessageText(b: Extract<Block, { t: "tool_result" }>): string {
  const text = b.content
    .filter((c) => c.t === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
  if (b.ok) return text.trim() ? text : b.content.some((c) => c.t !== "text") ? "(non-text output)" : "(no output)";
  const body = text.trim() ? text : "(no details)";
  return /^\s*error\b/i.test(body) ? body : `Error: ${body}`;
}

function userPart(b: Block): any {
  if (b.t === "text") return { type: "text", text: b.text };
  if (b.t === "image") {
    const url = b.url ?? `data:${b.mime};base64,${b.data ?? ""}`;
    return { type: "image_url", image_url: { url } };
  }
  if (b.t === "audio") {
    return { type: "input_audio", input_audio: { data: b.url ?? `data:${b.mime};base64,${b.data ?? ""}` } };
  }
  if (b.t === "video") {
    // Kimi's own part type. Posting the same bytes as image_url is refused
    // outright ("unsupported image format: video/mp4"), so this is not a
    // cosmetic alias — it is the only shape that works (verified 2026-08-20).
    const url = b.url ?? `data:${b.mime};base64,${b.data ?? ""}`;
    return { type: "video_url", video_url: { url } };
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<no body> (status ${res.status})`;
  }
}
