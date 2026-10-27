import type { Turn } from "../agent/turn.ts";
import type { StreamEvent } from "../agent/events.ts";
import type { Tier } from "../model-knowledge.ts";

export type BuiltinProviderId = "anthropic" | "openai" | "qwen" | "zhipu" | "kimi" | "mimo" | "gemini" | "local";
// custom-<hex>：用户在「模型服务」里自己加的第三方接口（OpenAI / Anthropic / Gemini 协议，server/custom-providers.ts）
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
  // Anthropic fast mode 开关，每次请求现读（全局粘性设置，菜单一关下一次请求就停）；型号不支持时适配器自己不发。
  fast?: () => boolean;
  // 自定义服务（registry 现读注册表填）：鉴权与自定义头、型号的档位表等。有它时适配器不走按内置厂商 id / 型号名的分支。
  custom?: CustomWire;
}

// 自定义服务发请求要的东西（custom-providers.ts 的记录摘出来的，适配器不直接依赖注册表）
export interface CustomWire {
  name: string; // 服务名（报错人话里用：「去模型服务 › 名字」）
  protocol: "openai" | "anthropic" | "gemini";
  headers: Record<string, string>; // 鉴权 + 自定义请求头，替换适配器默认的鉴权头
  maxTokensField: "max_tokens" | "max_completion_tokens";
  promptCaching: boolean;
  replayReasoning: boolean;
  // 这个型号的思考写法（档位表，形状同 src/model-knowledge）；注册表里没这个型号时没有，什么思考参数都不发
  model?: {
    thinking: string;
    efforts: Tier[];
    effortField: string;
    effortDefault: string;
    alwaysThinks: boolean;
    maxOutput: number;
  };
}

export interface ProviderAdapter {
  id: ProviderId;
  model: string;
  capabilities: Capabilities;
  // Encode the neutral turn to the provider wire format, call the API, and
  // translate the provider's stream back into neutral StreamEvents.
  stream(turn: Turn, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
