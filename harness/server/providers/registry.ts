import type { AdapterConfig, ProviderAdapter } from "./types.ts";
import { createAnthropicAdapter } from "./anthropic.ts";
import { createOpenAIAdapter } from "./openai.ts";
import { createGeminiAdapter } from "./gemini.ts";
import { guardStream } from "./sse.ts";

// R2：每家的流都套同一层空闲超时（首字节 / 字节间，见 sse.ts guardStream）。
export function createAdapter(cfg: AdapterConfig): ProviderAdapter {
  return guardStream(createProviderAdapter(cfg));
}

function createProviderAdapter(cfg: AdapterConfig): ProviderAdapter {
  switch (cfg.provider) {
    case "anthropic":
      return createAnthropicAdapter(cfg);
    case "gemini":
      // Gemini speaks its own contents[]/parts[] wire format — its own adapter.
      return createGeminiAdapter(cfg);
    case "openai":
    case "qwen":
    case "zhipu":
    case "kimi":
    case "mimo":
      // All speak the OpenAI Chat Completions wire format; the adapter branches
      // on cfg.provider for the few provider-specific bits (Qwen's enable_thinking,
      // Zhipu's thinking:{type} + reasoning_effort, Kimi's permanent thinking +
      // reasoning_content replay).
      return createOpenAIAdapter(cfg);
    default:
      throw new Error(`Unknown provider: ${(cfg as AdapterConfig).provider}`);
  }
}
