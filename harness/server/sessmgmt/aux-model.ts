// 会话管理的旁路小请求（AI 起标题、Tab 输入建议）：用便宜模型问一句、拿回一小段文字。
//
// 选型：会话用哪家就在哪家里挑一个便宜快的型号（同一家 = 同一把 key、同一个地址，成员实例只用得到它自己能用的那几家），
// 那家没有便宜档（本机、自定义服务）就用会话自己的型号。便宜档失败（这把 key 没开通那个型号之类）再用会话自己的型号试一次。
// 不进主对话、不带工具、不思考（恒思考的型号由适配器落到最低档）；有总时限，任何失败都只返回 null，由调用方静默回退。
import type { Msg } from "../agent/turn.ts";
import { modelSpec } from "../catalog.ts";
import { effectiveBaseUrl, resolveKey } from "../config.ts";
import { createAdapter } from "../providers/registry.ts";
import type { AdapterConfig, ProviderAdapter, ProviderId } from "../providers/types.ts";

// 每家的便宜档（目录里没有这个型号了就不用它）
const CHEAP: Partial<Record<string, string>> = {
  anthropic: "claude-haiku-5-5",
  openai: "deepseek-flash",
  qwen: "qwen3.8-flash",
  zhipu: "glm-5.3-flash",
  kimi: "kimi-for-coding-highspeed",
  mimo: "mimo-v2.6-flash",
  gemini: "gemini-3.5-flash",
};

export interface AuxTarget {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
}

// 先试便宜档、再试会话自己的型号（去重）
export function auxCandidates(cfg: AuxTarget): AuxTarget[] {
  const out: AuxTarget[] = [];
  const cheap = CHEAP[cfg.provider];
  // 便宜档与会话同一家：地址沿用会话的（成员实例上由 effectiveBaseUrl 再夹一次）
  if (cheap && cheap !== cfg.model && modelSpec(cfg.provider, cheap)) out.push({ provider: cfg.provider, model: cheap, baseUrl: cfg.baseUrl });
  out.push(cfg);
  return out;
}

type Factory = (cfg: AdapterConfig) => ProviderAdapter;
let factory: Factory = createAdapter;
// 测试用：换掉适配器工厂（脚本化 provider）。传 null 还原
export function setAuxAdapterFactory(f: Factory | null): void {
  factory = f ?? createAdapter;
}

export interface AuxAsk {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function askOnce(target: AuxTarget, q: AuxAsk): Promise<string> {
  // 测试换了工厂（脚本化 provider）时不要真 key
  const apiKey = resolveKey(target.provider) ?? (factory !== createAdapter ? "FAKE-TEST-KEY" : "");
  if (!apiKey) throw new Error("no key");
  const adapter = factory({ provider: target.provider, apiKey, model: target.model, baseUrl: effectiveBaseUrl(target.provider, target.baseUrl) });
  const bounded = q.signal ? AbortSignal.any([q.signal, AbortSignal.timeout(q.timeoutMs)]) : AbortSignal.timeout(q.timeoutMs);
  const messages: Msg[] = [{ role: "user", content: [{ t: "text", text: q.prompt }] }];
  let out = "";
  for await (const ev of adapter.stream({ system: q.system, messages, tools: [], budget: { maxOutputTokens: q.maxOutputTokens, thinking: "off" } }, bounded)) {
    if (ev.e === "text_delta") out += ev.text;
    else if (ev.e === "error") throw new Error(ev.kind);
  }
  if (bounded.aborted) throw new Error(q.signal?.aborted ? "aborted" : "timed out");
  return out;
}

// 依次试候选，第一个拿到非空文字的为准；都不行返回 null（原因只进日志）
export async function askAux(cfg: AuxTarget, q: AuxAsk, label: string): Promise<{ text: string; model: string } | null> {
  for (const target of auxCandidates(cfg)) {
    if (q.signal?.aborted) return null;
    try {
      const text = (await askOnce(target, q)).trim();
      if (text) return { text, model: target.model };
    } catch (e) {
      if (q.signal?.aborted) return null;
      console.warn(`[sessmgmt] ${label}：${target.provider}/${target.model} 没拿到结果（${(e as Error).message}）`);
    }
  }
  return null;
}

// 给旁路请求看的对话摘录：只要人说的话与助手正文（不要工具往返、harness 注入），按条截短，整体取最近的一段
export function conversationExcerpt(messages: Msg[], opts: { maxChars: number; perMessage: number }): { text: string; userTurns: number; assistantTurns: number } {
  const parts: string[] = [];
  let userTurns = 0;
  let assistantTurns = 0;
  for (const m of messages) {
    if (m.internal) continue;
    if (m.role === "user") {
      if (m.origin === "harness") continue;
      const said = (m.displayText ?? m.content.map((b) => (b.t === "text" ? b.text : "")).join("\n")).trim();
      if (!said) continue;
      userTurns++;
      parts.push(`User: ${said.slice(0, opts.perMessage)}`);
    } else if (m.role === "assistant") {
      const said = m.content.map((b) => (b.t === "text" ? b.text : "")).join("").trim();
      if (!said) continue;
      assistantTurns++;
      parts.push(`Assistant: ${said.length > opts.perMessage ? `${said.slice(0, opts.perMessage / 2)} … ${said.slice(-opts.perMessage / 2)}` : said}`);
    }
  }
  let text = parts.join("\n\n");
  if (text.length > opts.maxChars) text = text.slice(-opts.maxChars);
  return { text, userTurns, assistantTurns };
}
