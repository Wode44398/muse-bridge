// 自定义服务的调用参数（2026-11-15，bridge 模型中心的「高级调用配置」发过来的）：按协议写进已经编好的请求体。
//
// 形状同 bridge 模型中心 / Claude 外接服务的模型级 params（src/runtime/model-hub/advanced.mjs）。dimensio 认其中这几项：
//   maxTokens     固定每次的输出上限（不超过型号的输出上限）
//   temperature / topP / topK / stop
//   extraBody     JSON 对象，最后深合并（用户说了算）。和 Claude 那边同一套约定：Anthropic 协议整个并进请求；
//                 OpenAI 协议只并 "openai": {…} 里的，Gemini 协议只并 "gemini": {…} 里的（顶层其余键是给 Anthropic 形状用的）
// 思考策略（始终开 / 关）与思考预算只有 Claude 的代理认：dimensio 的思考档位跟着会话走。
import { MK } from "./model-knowledge.ts";

export interface CustomParams {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  extraBody?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const numIn = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** plugin-providers.json 里的 params → 只留认得的、合法的；一个都没有回 undefined。 */
export function cleanCustomParams(raw: unknown): CustomParams | undefined {
  if (!isObj(raw)) return undefined;
  const out: CustomParams = {};
  const maxTokens = numIn(raw.maxTokens, 1, 1_000_000);
  if (maxTokens !== undefined && Number.isInteger(maxTokens)) out.maxTokens = maxTokens;
  const temperature = numIn(raw.temperature, 0, 2);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = numIn(raw.topP, 0, 1);
  if (topP !== undefined) out.topP = topP;
  const topK = numIn(raw.topK, 1, 1000);
  if (topK !== undefined && Number.isInteger(topK)) out.topK = topK;
  if (Array.isArray(raw.stop)) {
    const stop = [...new Set(raw.stop.map((x) => String(x ?? "").slice(0, 64)).filter(Boolean))].slice(0, 8);
    if (stop.length) out.stop = stop;
  }
  if (typeof raw.extraBody === "string" && raw.extraBody.trim() && raw.extraBody.length <= 8000) {
    try {
      const o = JSON.parse(raw.extraBody);
      if (isObj(o)) out.extraBody = o;
    } catch {
      /* 坏 JSON 当没填（bridge 那边保存时就拦过） */
    }
  } else if (isObj(raw.extraBody)) out.extraBody = raw.extraBody;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 把调用参数写进一个已经编好的请求体（Anthropic Messages / OpenAI Chat Completions / Gemini generateContent 形状）。
 * cap：型号的输出上限（固定输出长度不超过它）。返回新对象，不改原来的。
 */
export function applyCustomParams(
  body: Record<string, any>,
  p: CustomParams | undefined,
  protocol: "openai" | "anthropic" | "gemini",
  cap = 0,
): Record<string, any> {
  if (!p) return body;
  let b: Record<string, any> = { ...body };
  const limit = (n: number) => (cap > 0 ? Math.min(n, cap) : n);
  if (protocol === "gemini") {
    const g: Record<string, any> = { ...(isObj(b.generationConfig) ? b.generationConfig : {}) };
    if (p.maxTokens) g.maxOutputTokens = limit(p.maxTokens);
    if (p.temperature !== undefined) g.temperature = p.temperature;
    if (p.topP !== undefined) g.topP = p.topP;
    if (p.topK !== undefined) g.topK = p.topK;
    if (p.stop?.length) g.stopSequences = p.stop;
    b.generationConfig = g;
  } else {
    if (p.maxTokens) {
      // OpenAI 自家推理模型用 max_completion_tokens：调用方随后会按服务设置改名，这里两个都认
      if (b.max_completion_tokens !== undefined && b.max_tokens === undefined) b.max_completion_tokens = limit(p.maxTokens);
      else b.max_tokens = limit(p.maxTokens);
    }
    if (p.temperature !== undefined) b.temperature = p.temperature;
    if (p.topP !== undefined) b.top_p = p.topP;
    if (p.topK !== undefined) b.top_k = p.topK;
    if (p.stop?.length) {
      if (protocol === "anthropic") b.stop_sequences = [...new Set([...(Array.isArray(b.stop_sequences) ? b.stop_sequences : []), ...p.stop])].slice(0, 8);
      else b.stop = p.stop;
    }
  }
  const x = p.extraBody;
  if (x) {
    if (protocol === "openai") {
      if (isObj(x.openai)) b = MK.deepMerge(b, x.openai);
    } else if (protocol === "gemini") {
      if (isObj(x.gemini)) b = MK.deepMerge(b, x.gemini);
    } else {
      const { openai: _o, gemini: _g, ...rest } = x;
      if (Object.keys(rest).length) b = MK.deepMerge(b, rest);
    }
  }
  return b;
}
