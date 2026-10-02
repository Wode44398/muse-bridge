import type { Turn } from "../agent/turn.ts";
import type { StreamEvent } from "../agent/events.ts";

export type BuiltinProviderId = "anthropic" | "openai" | "qwen" | "zhipu" | "kimi" | "mimo" | "gemini";
// custom-<hex>：用户在「模型服务」里自己加的 OpenAI 兼容端点（server/custom-providers.ts）
export type ProviderId = BuiltinProviderId | `custom-${string}`;

export interface Capabilities {
  contextWindow: number;
  maxOutputTokens: number;
  thinking: boolean;
  image: boolean;
  // Whether the model ingests a video file itself. When false, video is sampled
  // into frames and sent as images instead.
  video: boolean;
  // Native audio input; absent means unsupported.
  audio?: boolean;
  cache: boolean;
  parallelToolCalls: boolean;
  // R11：按成本压缩的触发线（token）。目录按型号配；不配时窗口 ≥ 512K 的模型默认 256K（见 agent/context.ts）。
  compactAt?: number;
  // R12：一次请求里历史图片的额度（目录按 provider 配）；不给就用默认 20 张 / 24 MB。
  mediaBudget?: { maxImages: number; maxBytes: number; keepRecent?: number };
}

export interface AdapterConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  // Optional overrides (context window / max output vary per model).
  contextWindow?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
}

export interface ProviderAdapter {
  id: ProviderId;
  model: string;
  capabilities: Capabilities;
  // Encode the neutral turn to the provider wire format, call the API, and
  // translate the provider's stream back into neutral StreamEvents.
  stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
