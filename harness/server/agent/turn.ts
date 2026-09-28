// The neutral "turn" model — the lingua franca every provider adapter
// translates to and from. Modeled as a superset of Anthropic's block mind:
// the most expressive of the three, so weaker providers slot in losslessly
// (translation is always strong -> weak, which is the easy direction).

export type Role = "user" | "assistant";

export interface AttachmentRef {
  path: string;
  kind: "image" | "video" | "audio" | "file" | "folder";
}

// A file the assistant explicitly hands back in its final response. Unlike
// user attachments these are workspace-backed outputs: the UI renders them as
// openable cards and the artifact route re-validates the session boundary.
export interface ArtifactRef {
  path: string;
  name: string;
  kind: "image" | "video" | "audio" | "pdf" | "office" | "text" | "file";
  size: number;
}

export type Block =
  | { t: "text"; text: string }
  // Anthropic needs `signature` echoed back to continue an interrupted thought.
  | { t: "thinking"; text: string; signature?: string }
  // `asset` points at an immutable, session-owned local image. AgentState
  // materializes it to `data` immediately before a provider call, keeping
  // persisted transcripts small without exposing a local URL to vendors.
  // R12：retired = 一次请求里的历史图片超了额度，这张（最老的工具图之一）已退役——转录照留（界面照样能看），发给
  // provider 时换成一句文字；fullRes = 工具要求原图入模、不降采样（只在进转录之前有意义，进转录时去掉）。
  | { t: "image"; mime: string; data?: string; url?: string; asset?: string; name?: string; retired?: boolean; fullRes?: boolean }
  // Same shape as an image, kept separate so every adapter has to say what it
  // does with video instead of silently posting an mp4 to an image endpoint
  // (Kimi rejects exactly that: "unsupported image format: video/mp4").
  | { t: "video"; mime: string; data?: string; url?: string; asset?: string; name?: string }
  | { t: "audio"; mime: string; data?: string; url?: string; asset?: string; name?: string; durationSeconds?: number }
  // `meta` carries provider-specific replay state INSIDE the transcript (e.g.
  // Gemini's thoughtSignature) so it survives session persistence — adapters
  // must not hold replay state in closures.
  | { t: "tool_call"; id: string; name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }
  // Tool results ride inside a user message (there is no neutral "tool" role).
  // `meta` is UI-only structured data (e.g. AskUserQuestion's answers) persisted
  // for exact history reconstruction; adapters encode only id/ok/content.
  | { t: "tool_result"; id: string; ok: boolean; content: Block[]; meta?: Record<string, unknown> };

export interface Msg {
  role: Role;
  content: Block[];
  // UI-only metadata. Provider adapters deliberately consume only role/content.
  displayText?: string;
  attachments?: AttachmentRef[];
  artifacts?: ArtifactRef[];
  // Internal lifecycle messages remain in the provider transcript but are
  // omitted from the user-facing conversation returned by the session API.
  internal?: boolean;
  // C3（#41）：用户侧消息从哪来。缺省 = 用户本人打的；harness 往转录里塞的一律带 origin——"steer" 是用户运行中插话，
  // "harness" 是门禁 / 预算 / 提醒 / 召回 / 压缩摘要 / 附件转交这类注入，kind 标类别（injections.ts 的名字）。
  // 前后端的判定一律认它，绝不按文本开头猜——以前用户贴回一段提示语，自己的提问就从历史里消失。
  origin?: "steer" | "harness";
  kind?: string;
  // C4：World State 片段更新了哪几节、各节的令牌（world-state.ts）。基线按它从转录里推，不发给 provider。
  world?: Record<string, string>;
  // U8（ZCode E3）：这一轮的用时——盖在这一轮最后一条可见回答上（durationMs 是整轮墙钟，waitedMs 是其中挂着卡片等人的
  // 时间，在卡片挂上 / 落定处计量）。界面折叠这一轮的过程时写「用时 N（等你的 M 不算）」，不发给 provider。
  run?: { durationMs: number; waitedMs: number };
  // N45：这一轮开跑时自动召回了哪些（只有标题、类别、为什么命中，不含正文）——挂在本轮的用户消息上，界面在气泡下写
  // 「召回 N 条」。不发给 provider（召回的正文另有一条 internal 消息）。
  recall?: RecallRef[];
  // 引用会话（把会话块拖进输入框）：这条消息引用了哪些对话（界面上气泡里的芯片）。摘要本身在 content 里给模型看。
  refs?: SessionRef[];
}

export interface SessionRef {
  id: string;
  title: string;
}

export interface RecallRef {
  id: string;
  title: string;
  // 知识类别：memory / profile / command / module / test / guide / verification……
  kind: string;
  // 为什么命中（检索给的理由，一句）
  why?: string;
}

// Unified effort ladder across all providers. Each concrete model supports only
// a subset (see server/catalog.ts) — the adapter maps the chosen level to that
// provider's native wire params (Anthropic effort / DeepSeek+Zhipu reasoning_effort
// / Qwen thinking_budget / Haiku budget_tokens).
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export interface Budget {
  maxOutputTokens: number;
  thinking?: ThinkingLevel;
}

// Anthropic-only prompt-cache breakpoint; ignored by other adapters.
export interface CacheHint {
  // Index into `messages` after which to place a cache_control breakpoint.
  afterMessage: number;
}

// Q4：adapter 编码后的请求体的三种 wire 形状（OpenAI 兼容的几家共用 "openai"）。
export type WireShape = "anthropic" | "openai" | "gemini";

export interface Hints {
  cache?: CacheHint[];
  // Merged verbatim into the provider request body — an escape hatch for
  // native features (Gemini toolConfig, Anthropic betas, ...). Zero cost if unused.
  providerExtras?: Record<string, unknown>;
  // Q4：请求观察者。adapter 在 fetch 之前把编码好的请求体交过来（只读）；只做前缀守恒判定这类诊断，
  // 出错也不影响请求（见 providers/wire-fingerprint.ts 的 observeWire）。
  onWire?: (shape: WireShape, body: Record<string, unknown>) => void;
}

export interface Turn {
  system: string | Block[];
  messages: Msg[];
  tools: ToolDef[];
  budget: Budget;
  hints?: Hints;
}

// ── Tool definitions (the OpenAPI-subset schema all three providers accept) ──

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonObjectSchema;
}

export interface JsonObjectSchema {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProp {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  default?: unknown;
}

// ── Small helpers for building blocks ────────────────────────────────────────

export const text = (s: string): Block => ({ t: "text", text: s });

export function userText(s: string): Msg {
  return { role: "user", content: [text(s)] };
}

export function toolResult(
  id: string,
  ok: boolean,
  body: string | Block[],
  meta?: Record<string, unknown>,
): Block {
  return {
    t: "tool_result",
    id,
    ok,
    content: typeof body === "string" ? [text(body)] : body,
    ...(meta ? { meta } : {}),
  };
}
