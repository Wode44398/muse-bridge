import type { AdapterConfig, CustomWire, HostWire, ProviderAdapter } from "./types.ts";
import { createAnthropicAdapter } from "./anthropic.ts";
import { createOpenAIAdapter } from "./openai.ts";
import { createGeminiAdapter } from "./gemini.ts";
import { guardStream } from "./sse.ts";
import { getCustomProvider, hostBuiltin, isCustomProviderId, isSharedProvider, requestHeaders } from "../custom-providers.ts";
import { MK } from "../model-knowledge.ts";
import { assertPublicEndpoint, privateEndpointsBlocked } from "../endpoint-guard.ts";

// R2：每家的流都套同一层空闲超时（首字节 / 字节间，见 sse.ts guardStream）。
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function createAdapter(cfg: AdapterConfig): ProviderAdapter {
  const adapter = createProviderAdapter(cfg);
  try {
    applyCacheTtl(adapter, cfg);
  } catch {
    /* 算不出就当不知道：不提示、不赶着压缩 */
  }
  return guardStream(adapter);
}

// 内置厂商没填地址时请求发到哪（认厂商用；地址改过的看地址）
const BUILTIN_HOST: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  gemini: "generativelanguage.googleapis.com",
  qwen: "dashscope.aliyuncs.com",
  zhipu: "open.bigmodel.cn",
  kimi: "api.kimi.com",
  mimo: "api.xiaomimimo.com",
  local: "127.0.0.1",
};

// 提示缓存多久变冷（capabilities.cacheTtlMs，空闲压缩和「缓存冷了」提示都按它）：用户在模型中心填的 > 这次请求自己要的
//（Anthropic 适配器发 ttl:"1h" 时是 1 小时）> 按上游主机 / 型号认厂商（model-knowledge/cache-ttl.mjs）。0 / 不填 = 不知道或不会过期。
function applyCacheTtl(adapter: ProviderAdapter, cfg: AdapterConfig): void {
  const caps = adapter.capabilities;
  const live = isCustomProviderId(cfg.provider) ? getCustomProvider(cfg.provider) : null;
  const user = live ? live.models.find((x) => x.id === cfg.model)?.cacheTtl : hostBuiltin(cfg.provider)?.models.find((x) => x.id === cfg.model)?.cacheTtl;
  const anthropicWire = live ? live.protocol === "anthropic" : cfg.provider === "anthropic";
  // Claude 型号只在请求带 cache_control 时才缓存：适配器没打缓存标记（第三方端点关着「提示缓存」）就是没有缓存。
  // 别家的 Anthropic 兼容端点（DeepSeek、Kimi、小米……）自己自动缓存，照厂商算
  if (user === undefined && anthropicWire && !caps.cacheTtlMs && MK.vendorOf(cfg.model) === "anthropic") return;
  const host = live ? live.upstream || hostnameOf(live.baseUrl) : cfg.baseUrl ? hostnameOf(cfg.baseUrl) : BUILTIN_HOST[cfg.provider] || "";
  const ms = MK.cacheTtlMs(cfg.model, { host, user, requestMinutes: caps.cacheTtlMs === 3_600_000 ? 60 : undefined });
  if (ms > 0) caps.cacheTtlMs = ms;
  else delete caps.cacheTtlMs;
}

// 宿主模型中心接管了这家：把服务的兼容项与这个型号的档位表、调用参数交给适配器（没接管 / 老 bridge = 原样）
function withHost(cfg: AdapterConfig): AdapterConfig {
  const b = hostBuiltin(cfg.provider);
  if (!b) return cfg;
  const m = b.models.find((x) => x.id === cfg.model);
  const host: HostWire = {
    ...(b.replayReasoning !== undefined ? { replayReasoning: b.replayReasoning } : {}),
    ...(b.maxTokensField ? { maxTokensField: b.maxTokensField } : {}),
    ...(b.upstream ? { upstreamHost: b.upstream } : {}),
    ...(m?.tiers ? { model: m.tiers } : {}),
    ...(m?.params ? { params: m.params } : {}),
  };
  return { ...cfg, host };
}

function createProviderAdapter(cfg: AdapterConfig): ProviderAdapter {
  if (isCustomProviderId(cfg.provider)) {
    // 自定义服务：地址、协议、鉴权、型号能力都现读注册表（会话快照里的旧地址不算——改了地址，旧会话接着聊也走新地址）。
    // 按协议分派到现成的三个适配器；它们见到 cfg.custom 就不走按内置厂商 id / 型号名的分支，档位按型号的档位表发。
    const live = getCustomProvider(cfg.provider);
    if (!live) return createOpenAIAdapter(cfg); // 已删掉的服务：照旧按 OpenAI 兼容发，报错会说清楚
    const m = live.models.find((x) => x.id === cfg.model);
    // 成员自己加的服务：发请求前地址先过公网把关、不跟随重定向（endpoint-guard.ts）；管理员共享的不过（地址是管理员定的）
    const guarded = privateEndpointsBlocked() && !isSharedProvider(live.id);
    const custom: CustomWire = {
      name: live.name,
      protocol: live.protocol,
      headers: requestHeaders(live, cfg.apiKey),
      maxTokensField: live.maxTokensField,
      promptCaching: live.promptCaching,
      replayReasoning: live.replayReasoning,
      upstreamHost: live.upstream || hostnameOf(live.baseUrl),
      ...(guarded ? { noRedirect: true } : {}),
      ...(m
        ? { model: { thinking: m.thinking, efforts: m.efforts, effortField: m.effortField, effortDefault: m.effortDefault, alwaysThinks: m.alwaysThinks, maxOutput: m.maxOutput, ...(m.params ? { params: m.params } : {}) } }
        : {}),
    };
    const c: AdapterConfig = { ...cfg, baseUrl: live.baseUrl, custom };
    const adapter = live.protocol === "anthropic" ? createAnthropicAdapter(c) : live.protocol === "gemini" ? createGeminiAdapter(c) : createOpenAIAdapter(c);
    if (!guarded) return adapter;
    return {
      ...adapter,
      async *stream(turn, signal) {
        await assertPublicEndpoint(live.baseUrl);
        yield* adapter.stream(turn, signal);
      },
    };
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
    case "local":
      // All speak the OpenAI Chat Completions wire format; the adapter branches
      // on cfg.provider for the few provider-specific bits (Qwen's enable_thinking,
      // Zhipu's thinking:{type} + reasoning_effort, Kimi's permanent thinking +
      // reasoning_content replay, local llama.cpp's chat_template_kwargs).
      return createOpenAIAdapter(cfg.provider === "local" ? cfg : withHost(cfg));
    default:
      throw new Error(`Unknown provider: ${(cfg as AdapterConfig).provider}`);
  }
}
