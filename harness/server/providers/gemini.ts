import type { Block, Msg, Turn } from "../agent/turn.ts";
import type { StreamEvent, StopReason } from "../agent/events.ts";
import type { AdapterConfig, Capabilities, ProviderAdapter } from "./types.ts";
import { readSSE } from "./sse.ts";
import { httpErrorEvent, streamErrorEvent } from "./classify.ts";
import { observeWire } from "./wire-fingerprint.ts";
import { modelLimits, modelSupportsImages, modelSupportsVideo, providerMediaBudget } from "../catalog.ts";
import { applyCustomThinking } from "../custom-tiers.ts";
import type { CustomWire } from "./types.ts";

// Google Gemini via the AI-Studio REST endpoint (generativelanguage.googleapis.com,
// v1beta) using a plain `x-goog-api-key` — no SDK, no ADC, matching this project's
// raw-fetch/zero-dep ethos (the other adapters do the same). Speaks Gemini's own
// wire format (contents[]/parts[]/functionCall/functionResponse), which is unlike
// both Anthropic and OpenAI, hence its own adapter rather than a shared one.

const DEFAULTS = {
  contextWindow: 1_000_000,
  // Gemini 2.5/3 Flash accept up to 64k output tokens, and — critically — a
  // model's THINKING tokens are billed against this same output budget. At
  // thinkingLevel HIGH on a large task the model can spend >16k tokens just
  // thinking, hit MAX_TOKENS, and finish before ever emitting the answer (the
  // user sees a wall of thought summaries and no deliverable). Give thinking +
  // answer real room. The session still clamps to its own ceiling.
  maxOutputTokens: 65_536,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
};

// Gemini 3 (thinkingLevel) vs Gemini 2.5 (thinkingBudget). Map the unified effort
// ladder to the family's actual knob. See catalog.ts for which tiers each model
// exposes; this only translates whatever level survives the clamp.
// 「3 代」= 3 及以后（含 gemini-4-argon）：thinkingLevel、thoughtSignature、可混 google_search。只有 1.x/2.x 例外。
const GEN3_PLUS = /gemini-(?![12]\.)\d/i;
function thinkingConfig(model: string, level: string): Record<string, unknown> | undefined {
  if (level === "off") {
    // Only Gemini 2.5 can truly disable thinking (budget 0). Gemini 3 has no off.
    if (/gemini-2\.5/i.test(model) && !/pro/i.test(model)) {
      return { thinkingBudget: 0 };
    }
    return undefined;
  }
  if (GEN3_PLUS.test(model)) {
    // thinkingLevel: MINIMAL | LOW | MEDIUM | HIGH. MINIMAL 只有 3.5 Flash 有（3.1 Pro 拒收），catalog 只给 3.5 Flash 这一档。
    // xhigh / max 只可能来自没走 clamp 的旧值——落到 HIGH，Gemini 3 没有更高的档。
    const lv = level === "max" || level === "xhigh" ? "HIGH" : level.toUpperCase();
    return { thinkingLevel: lv, includeThoughts: true };
  }
  // Gemini 2.5: budget in tokens. -1 = automatic. 2.5-pro can't be 0.
  const budget: Record<string, number> = { low: 512, medium: -1, high: 24_576, max: 24_576 };
  return { thinkingBudget: budget[level] ?? -1, includeThoughts: true };
}

export function createGeminiAdapter(cfg: AdapterConfig): ProviderAdapter {
  // R1（#1）：按型号读目录里的上限；目录外的自定义 id 才落到扁平默认值。
  const limits = modelLimits(cfg.provider, cfg.model);
  const capabilities: Capabilities = {
    contextWindow: cfg.contextWindow ?? limits.ctx ?? DEFAULTS.contextWindow,
    maxOutputTokens: cfg.maxOutputTokens ?? limits.maxOut ?? DEFAULTS.maxOutputTokens,
    thinking: cfg.thinking ?? true,
    image: modelSupportsImages(cfg.provider, cfg.model),
    video: modelSupportsVideo(cfg.provider, cfg.model),
    cache: false,
    parallelToolCalls: true,
    compactAt: limits.compactAt,
    mediaBudget: providerMediaBudget(cfg.provider, cfg.model),
  };
  const baseUrl = (cfg.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");

  // Gemini 3 attaches a thoughtSignature to each functionCall part; it must be
  // echoed back verbatim on replay or the model 400s ("function call must be
  // accompanied by a thought signature"). It rides on the tool_call block's
  // `meta` (NOT in adapter closures) so it survives session persistence; the
  // functionResponse name-pairing is rebuilt by prescanning the transcript.
  let callSeq = 0;

  return {
    id: cfg.custom ? cfg.provider : "gemini",
    model: cfg.model,
    capabilities,
    async *stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const body = encode(turn, cfg.model, capabilities, cfg.custom);

      const url = `${baseUrl}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;
      observeWire(turn, "gemini", body);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 自定义服务：鉴权方式（x-goog-api-key / Bearer / 无）和自定义请求头按服务设置
          ...(cfg.custom ? cfg.custom.headers : { "x-goog-api-key": cfg.apiKey }),
        },
        body: JSON.stringify(body),
        signal,
        ...(cfg.custom?.noRedirect ? { redirect: "error" as const } : {}),
      });

      if (!res.ok || !res.body) {
        const raw = await safeText(res);
        // R7：按业务码 / 话术 / 状态码 / 响应头分类（自定义服务另认地址 / 协议不对、非对话模型）
        yield httpErrorEvent(res, raw, cfg.custom ? { url, name: cfg.custom.name, protocol: "gemini", model: cfg.model } : undefined);
        return;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      // Q4：隐式缓存命中量（cachedContentTokenCount，含在 promptTokenCount 里）；没回报就不填。
      let cacheReadTokens: number | undefined;
      let sawToolCall = false;
      let stopReason: StopReason = "end";

      for await (const msg of readSSE(res, signal)) {
        if (!msg.data || msg.data === "[DONE]") continue;
        let ev: any;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          continue;
        }

        if (ev.usageMetadata) {
          inputTokens = ev.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens =
            (ev.usageMetadata.candidatesTokenCount ?? 0) +
            (ev.usageMetadata.thoughtsTokenCount ?? 0);
          if (typeof ev.usageMetadata.cachedContentTokenCount === "number") cacheReadTokens = ev.usageMetadata.cachedContentTokenCount;
        }
        if (ev.error) {
          yield streamErrorEvent(ev.error.status || "stream_error", ev.error);
          return;
        }

        const cand = ev.candidates?.[0];
        if (!cand) continue;
        for (const part of cand.content?.parts ?? []) {
          if (part.functionCall) {
            sawToolCall = true;
            const id = `gemini_${Date.now()}_${callSeq++}`;
            const name = part.functionCall.name ?? "unknown";
            yield {
              e: "tool_call",
              id,
              name,
              args: (part.functionCall.args as Record<string, unknown>) ?? {},
              meta:
                typeof part.thoughtSignature === "string"
                  ? { thoughtSignature: part.thoughtSignature }
                  : undefined,
            };
          } else if (typeof part.text === "string" && part.text) {
            if (part.thought === true) yield { e: "thinking_delta", text: part.text };
            else yield { e: "text_delta", text: part.text };
          }
        }
        if (cand.finishReason) stopReason = mapStop(cand.finishReason);
      }

      if (sawToolCall) stopReason = "tool_use";
      yield { e: "usage", inputTokens, outputTokens, ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}) };
      yield { e: "turn_done", stopReason };
    },
  };
}

function mapStop(reason: string): StopReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
      return "refusal";
    default:
      return "end";
  }
}

// ── Encode neutral Turn -> Gemini generateContent request body ───────────────

function encode(turn: Turn, model: string, caps: Capabilities, custom?: CustomWire) {
  // Prescan the transcript for tool_call blocks: Gemini pairs a functionResponse
  // to its call by NAME, but the neutral tool_result block only carries the id.
  // Rebuilding the map from the messages themselves (instead of adapter state)
  // keeps replay correct across session persistence/restore.
  const nameById = new Map<string, string>();
  for (const m of turn.messages) {
    for (const b of m.content) {
      if (b.t === "tool_call") nameById.set(b.id, b.name);
    }
  }
  const signed = GEN3_PLUS.test(model);
  const contents = turn.messages.map((m) => encodeMsg(m, nameById, signed)).filter((c) => c.parts.length);

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: turn.budget.maxOutputTokens || caps.maxOutputTokens,
    },
  };

  const sys = systemString(turn.system);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };

  if (turn.tools.length) {
    const tools: Record<string, unknown>[] = [
      {
        functionDeclarations: turn.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchema(t.parameters),
        })),
      },
    ];
    // Gemini 3 can combine a built-in tool (Grounding with Google Search) with
    // custom function calling in the SAME generateContent request; Gemini 2.5/2.0
    // cannot (they must pick one), so scope this to the 3.x family. Uses the same
    // Gemini key — no extra credential. The model only issues a search when it
    // judges the prompt needs fresh facts, so this pairs live "discovery" with
    // WebFetch's deep-read at no cost on tasks that don't need it. Two wire
    // requirements, both verified against the live API: (1) the tool shape for the
    // generateContent endpoint is {google_search:{}} (the Interactions API's
    // {type:"google_search"} is a DIFFERENT endpoint); (2) mixing a built-in tool
    // with function calling additionally needs toolConfig.includeServerSideTool-
    // Invocations=true, or the request 400s ("Please enable ...").
    // 自定义服务（第三方的 Gemini 兼容端点）不一定认内置的 google_search：不加
    if (GEN3_PLUS.test(model) && !custom) {
      tools.push({ google_search: {} });
      body.toolConfig = { includeServerSideToolInvocations: true };
    }
    body.tools = tools;
  }

  const level = turn.budget.thinking ?? "off";
  if (custom) {
    // 自定义服务：按型号的档位表写 generationConfig.thinkingConfig（共用 applyTier），不按型号名猜
    const out = applyCustomThinking(body, custom.model, level, { protocol: "gemini" });
    if (turn.hints?.providerExtras) Object.assign(out, turn.hints.providerExtras);
    return out;
  }
  if (caps.thinking) {
    const tc = thinkingConfig(model, level);
    if (tc) (body.generationConfig as any).thinkingConfig = tc;
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

// One neutral message -> one Gemini content. Roles: user -> "user", assistant ->
// "model". tool_result blocks become functionResponse parts (Gemini pairs them by
// name/order, not id). Thinking blocks are dropped — only the thoughtSignature
// riding on the tool_call block's meta matters for replay.
// 别家留下的调用（会话中途换到 Gemini 3）一个签名都没有：Gemini 3 对缺签名的 functionCall 会 400，官方给的迁移写法是
// 在这条消息的第一个调用上填这个占位值跳过校验（并行调用本来就只有第一个带签名）。2.5 不强制签名，不填。
const FOREIGN_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function encodeMsg(m: Msg, nameById: Map<string, string>, signed = false): { role: string; parts: any[] } {
  const role = m.role === "assistant" ? "model" : "user";
  const parts: any[] = [];
  let needsSignature = signed && m.role === "assistant" &&
    !m.content.some((b) => b.t === "tool_call" && typeof b.meta?.thoughtSignature === "string" && b.meta.thoughtSignature);

  for (const b of m.content) {
    if (b.t === "text") {
      if (b.text) parts.push({ text: b.text });
    } else if (b.t === "image" || b.t === "video") {
      // inlineData is mime-agnostic, so video rides the same part shape.
      if (b.url) parts.push({ fileData: { fileUri: b.url } });
      else parts.push({ inlineData: { mimeType: b.mime, data: b.data ?? "" } });
    } else if (b.t === "tool_call") {
      const part: any = { functionCall: { name: b.name, args: b.args ?? {} } };
      const sig = b.meta?.thoughtSignature;
      if (typeof sig === "string" && sig) part.thoughtSignature = sig;
      else if (needsSignature) {
        part.thoughtSignature = FOREIGN_THOUGHT_SIGNATURE;
        needsSignature = false;
      }
      parts.push(part);
    } else if (b.t === "tool_result") {
      parts.push({
        functionResponse: {
          name: nameById.get(b.id) ?? "tool",
          response: { output: toolResultText(b), ok: b.ok },
        },
      });
    }
    // thinking blocks: intentionally dropped.
  }

  return { role, parts };
}

function toolResultText(b: Extract<Block, { t: "tool_result" }>): string {
  return b.content
    .filter((c) => c.t === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

// Gemini's function-declaration schema is an OpenAPI subset and rejects a few
// JSON-Schema-isms (notably $schema and additionalProperties). Strip them.
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === "$schema" || k === "additionalProperties") continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return schema;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<no body> (status ${res.status})`;
  }
}
