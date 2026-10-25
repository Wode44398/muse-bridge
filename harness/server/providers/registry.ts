import type { AdapterConfig, CustomWire, ProviderAdapter } from "./types.ts";
import { createAnthropicAdapter } from "./anthropic.ts";
import { createOpenAIAdapter } from "./openai.ts";
import { createGeminiAdapter } from "./gemini.ts";
import { guardStream } from "./sse.ts";
import { getCustomProvider, isCustomProviderId, requestHeaders } from "../custom-providers.ts";

// R2：每家的流都套同一层空闲超时（首字节 / 字节间，见 sse.ts guardStream）。
export function createAdapter(cfg: AdapterConfig): ProviderAdapter {
  return guardStream(createProviderAdapter(cfg));
}

function createProviderAdapter(cfg: AdapterConfig): ProviderAdapter {
  if (isCustomProviderId(cfg.provider)) {
    // 自定义服务：地址、协议、鉴权、型号能力都现读注册表（会话快照里的旧地址不算——改了地址，旧会话接着聊也走新地址）。
    // 按协议分派到现成的三个适配器；它们见到 cfg.custom 就不走按内置厂商 id / 型号名的分支，档位按型号的档位表发。
    const live = getCustomProvider(cfg.provider);
    if (!live) return createOpenAIAdapter(cfg); // 已删掉的服务：照旧按 OpenAI 兼容发，报错会说清楚
    const m = live.models.find((x) => x.id === cfg.model);
    const custom: CustomWire = {
      name: live.name,
      protocol: live.protocol,
      headers: requestHeaders(live, cfg.apiKey),
      maxTokensField: live.maxTokensField,
      promptCaching: live.promptCaching,
      replayReasoning: live.replayReasoning,
      ...(m
        ? { model: { thinking: m.thinking, efforts: m.efforts, effortField: m.effortField, effortDefault: m.effortDefault, alwaysThinks: m.alwaysThinks, maxOutput: m.maxOutput } }
        : {}),
    };
    const c: AdapterConfig = { ...cfg, baseUrl: live.baseUrl, custom };
    if (live.protocol === "anthropic") return createAnthropicAdapter(c);
    if (live.protocol === "gemini") return createGeminiAdapter(c);
    return createOpenAIAdapter(c);
  }
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
