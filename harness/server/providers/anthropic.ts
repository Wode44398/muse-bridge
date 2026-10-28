import { randomBytes } from "node:crypto";
import type { Block, Msg, Turn } from "../agent/turn.ts";
import type { StreamEvent, StopReason } from "../agent/events.ts";
import type { AdapterConfig, Capabilities, ProviderAdapter } from "./types.ts";
import { readSSE } from "./sse.ts";
import { httpErrorEvent, streamErrorEvent } from "./classify.ts";
import { observeWire } from "./wire-fingerprint.ts";
import { modelLimits, modelSupportsFast, modelSupportsImages, providerMediaBudget } from "../catalog.ts";
import { applyCustomThinking } from "../custom-tiers.ts";
import { MK } from "../model-knowledge.ts";
import type { CustomWire } from "./types.ts";

export const FAST_MODE_BETA = "fast-mode-2026-02-01";
// fast 自己的限流（429 正文：「…rate limit of N fast mode input tokens per minute…」）之后多久不再试 fast。
// 全进程共享：额度是按 org 算的，一个会话撞上了，别的会话、子 agent 再试也是白撞。
export const FAST_COOLDOWN_MS = 15 * 60_000;
const FAST_LIMIT_RE = /fast mode/i;
let fastCooldownUntil = 0;
// 测试用：清掉退避
export function resetFastCooldown(): void {
  fastCooldownUntil = 0;
}

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
// Haiku 4.5 and earlier use the legacy budget_tokens path; Haiku 5.5+ is adaptive
// (CLI 2.1.293 catalog: adaptive_thinking + rejects_disabled_thinking, effort default medium).
function isAdaptive(model: string): boolean {
  return /claude-(opus-4-[78]|sonnet-4-6|sonnet-5|opus-4-6|haiku-([5-9]|\d{2}))/i.test(model) ||
    // future-proof: any opus/sonnet at 4.7+ is adaptive.
    (/claude-(opus|sonnet)/i.test(model) && !/haiku/i.test(model));
}

// The unified ladder uses Anthropic's own effort names, so they pass through 1:1
// (xhigh = Claude Code's "Extra"). 以前把 max 发成 xhigh：真 max 永远发不出去，Sonnet 4.6 没有 xhigh 必 400。
// 每个型号有哪几档由 catalog 决定（Sonnet 4.6 没有 xhigh），effort-contract.test.ts 对照官方表。
const EFFORT_MAP: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function createAnthropicAdapter(cfg: AdapterConfig): ProviderAdapter {
  // R1（#1）：按型号读目录里的上限（与 OpenAI 兼容适配器同一条路）。以前一律 200k / 8192，
  // Opus 5.5 一轮最多写 8192 token 就被截断；目录外的自定义 id 才落到下面的扁平默认值。
  const limits = modelLimits(cfg.provider, cfg.model);
  const custom = cfg.custom;
  const capabilities: Capabilities = {
    contextWindow: cfg.contextWindow ?? limits.ctx ?? DEFAULTS.contextWindow,
    maxOutputTokens: cfg.maxOutputTokens ?? limits.maxOut ?? DEFAULTS.maxOutputTokens,
    thinking: cfg.thinking ?? true,
    image: modelSupportsImages(cfg.provider, cfg.model),
    // No video input on the Messages API — video falls back to sampled frames.
    video: false,
    // 自定义服务（第三方的 Anthropic 兼容端点）多半不认 cache_control：按服务的「提示缓存」开关（官方端点默认开）
    cache: custom ? custom.promptCaching : true,
    parallelToolCalls: true,
    compactAt: limits.compactAt,
    mediaBudget: providerMediaBudget(cfg.provider, cfg.model),
  };
  const baseUrl = (cfg.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
  // 提示缓存 TTL：默认 5 分钟——主对话每轮带几万到十几万 token 的系统提示 + 工具定义 + 历史，用户隔 5 分钟没说话就整段重算。
  // 主会话（cfg.cacheTtl）走官方端点时给 1 小时（写入 2× 计价、读仍按命中价；对齐 bridge 里 Claude 的官方 API 服务）；
  // 子 agent 一轮里请求间隔只有几秒，5 分钟够用、不多付写入费；第三方兼容端点不一定认 ttl，不动。
  // 四个断点用同一个 TTL——官方要求长 TTL 的断点排在短的前面，统一了就不会撞。
  const cacheMark: CacheMark | null = !capabilities.cache
    ? null
    : cfg.cacheTtl === "1h" && hostOf(baseUrl) === "api.anthropic.com"
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };
  // 地址带不带 /v1 都行（以前写死 `${base}/v1/messages`，以 /v1 结尾的自定义地址会拼出 /v1/v1）
  const url = MK.anthropicUrl(baseUrl, "/v1/messages");

  return {
    id: cfg.provider === "anthropic" || !custom ? "anthropic" : cfg.provider,
    model: cfg.model,
    capabilities,
    async *stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const body = encode(turn, cfg.model, capabilities, cacheMark, custom);
      // fast mode：开关开着、型号支持、且不在退避期才发（不支持的型号带 speed 必 400）。speed 参数离了 beta 头也是 400。
      const fast = cfg.fast?.() === true && modelSupportsFast(cfg.provider, cfg.model) && Date.now() >= fastCooldownUntil;
      const send = (withFast: boolean) => {
        const payload = withFast ? { ...body, speed: "fast" } : body;
        observeWire(turn, "anthropic", payload);
        return fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            // 自定义服务：鉴权方式（x-api-key / Bearer / 无）和自定义请求头按服务设置
            ...(custom ? custom.headers : { "x-api-key": cfg.apiKey }),
            ...(withFast ? { "anthropic-beta": FAST_MODE_BETA } : {}),
          },
          body: JSON.stringify(payload),
          signal,
        });
      };
      const errCtx = custom ? { url, name: custom.name, protocol: "anthropic" as const, model: cfg.model } : undefined;
      let res = await send(fast);
      // fast mode 的额度与普通额度分开算（2026-10-14 实测：维护者这个 org 的 fast 额度是每分钟 0 input token，
      // 只有十来个 token 的小请求偶尔放过，真对话一律 429）。撞上 fast 自己的 429 就当场按普通速度重发，
      // 之后一段时间不再试 fast，并在对话里说一声——不让它掉进通用的限流重试，一直「被限流，N 秒后重试」不出字。
      if (fast && res.status === 429) {
        const raw = await safeText(res);
        if (FAST_LIMIT_RE.test(raw)) {
          fastCooldownUntil = Date.now() + FAST_COOLDOWN_MS;
          yield { e: "notice", code: "fast_fallback", cooldownMs: FAST_COOLDOWN_MS };
          res = await send(false);
        } else {
          yield httpErrorEvent(res, raw, errCtx);
          return;
        }
      }

      if (!res.ok || !res.body) {
        const raw = await safeText(res);
        yield httpErrorEvent(res, raw, errCtx); // R7：按业务码 / 话术 / 状态码 / 响应头分类（自定义服务另认地址 / 协议不对、非对话模型）
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

type CacheMark = { type: "ephemeral"; ttl?: "1h" };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function encode(turn: Turn, model: string, caps: Capabilities, cacheMark: CacheMark | null, custom?: CustomWire) {
  const level = turn.budget.thinking ?? "off";
  const thinkingOn = caps.thinking && level !== "off";
  // 自定义服务不按型号名猜 adaptive / budget（小米 /anthropic 不发参数照样思考，只认 thinking.type=disabled）：按型号的档位表发
  const adaptive = !custom && isAdaptive(model);
  // Legacy budget only matters for non-adaptive (Haiku) models.
  const budgetTokens = thinkingOn && !adaptive && !custom ? (THINKING_BUDGET[level] ?? 12_000) : 0;
  // With legacy thinking on, max_tokens must exceed the thinking budget.
  const maxTokens = Math.max(
    turn.budget.maxOutputTokens,
    budgetTokens ? budgetTokens + 1024 : 0,
  );

  const system = encodeSystem(turn, cacheMark);
  const tools = encodeTools(turn, cacheMark);

  // 会话中途从别家换过来：别家的空消息（只剩思考）编码后是空 content，Anthropic 直接 400——跳过
  const messages = normalizeToolIds(turn.messages).map(encodeMsg).filter((m) => m.content.length > 0);
  if (cacheMark) markMessageCache(messages, cacheMark);

  let body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };
  if (system) body.system = system;
  if (tools.length) body.tools = tools;
  if (custom) {
    body = applyCustomThinking(body, custom.model, level, { protocol: "anthropic", cap: caps.maxOutputTokens });
  } else if (adaptive) {
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

function encodeSystem(turn: Turn, cache: CacheMark | null) {
  if (typeof turn.system === "string") {
    if (!turn.system) return undefined;
    const block: any = { type: "text", text: turn.system };
    if (cache) block.cache_control = { ...cache };
    return [block];
  }
  const arr = turn.system
    .filter((b) => b.t === "text")
    .map((b) => ({ type: "text", text: (b as { text: string }).text }) as any);
  if (cache && arr.length) arr[arr.length - 1].cache_control = { ...cache };
  return arr.length ? arr : undefined;
}

function encodeTools(turn: Turn, cache: CacheMark | null) {
  const tools = turn.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  })) as any[];
  // Cache the large static tool prefix (system + tools) with one breakpoint.
  if (cache && tools.length) tools[tools.length - 1].cache_control = { ...cache };
  return tools;
}

// Sliding cache breakpoints on the last two messages. The transcript is a
// monotonically growing prefix, so the older mark reproduces the breakpoint the
// previous request wrote (guaranteed hit) and the newer one extends the cache
// for the next turn. With the system + tools marks this uses all 4 allowed slots.
function markMessageCache(messages: any[], cache: CacheMark) {
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const last = content[content.length - 1];
    // thinking blocks cannot carry cache_control; fall back to an earlier message.
    if (last.type === "thinking" || last.type === "redacted_thinking") continue;
    last.cache_control = { ...cache };
    marked++;
  }
}

function encodeMsg(m: Msg) {
  return { role: m.role, content: m.content.map(encodeBlock).filter(Boolean) };
}

// Anthropic 的 tool_use id 只认 [a-zA-Z0-9_-] 且整个请求里不能重复；会话中途从别家换过来时，转录里是别家的 id
// （Kimi 是 "functions.Bash:0"，而且每轮都从 0 数，同一个 id 反复出现）。按出现顺序重新编号、结果跟着最近一次同名调用走。
// 映射只取决于转录本身，所以每次请求一模一样，不破坏前缀缓存。全是合规 id（一直在 Claude 上跑的会话）时原样返回。
const TOOL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export function normalizeToolIds(messages: Msg[]): Msg[] {
  const seen = new Set<string>();
  const current = new Map<string, string>();
  let n = 0;
  let changed = false;
  const out = messages.map((m) => {
    let touched = false;
    const content = m.content.map((b) => {
      if (b.t === "tool_call") {
        let id = b.id;
        if (!TOOL_ID_RE.test(id) || seen.has(id)) {
          do id = `toolu_h${n++}_${b.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}`; while (seen.has(id));
        }
        seen.add(id);
        current.set(b.id, id);
        if (id === b.id) return b;
        touched = true;
        return { ...b, id };
      }
      if (b.t === "tool_result") {
        const id = current.get(b.id);
        if (!id || id === b.id) return b;
        touched = true;
        return { ...b, id };
      }
      return b;
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : messages;
}

function encodeBlock(b: Block): any {
  switch (b.t) {
    case "text":
      // 空文本块 Anthropic 拒收（别家可能留下 content 为空串的回答）
      return b.text ? { type: "text", text: b.text } : null;
    case "thinking":
      // 没有签名的思考来自别家（会话中途换过来的）：Anthropic 验签必拒，丢掉——别家的思考对 Claude 本来也不回放
      return b.signature ? { type: "thinking", thinking: b.text, signature: b.signature } : null;
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
