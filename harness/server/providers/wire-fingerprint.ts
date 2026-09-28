// Q4（X09）：请求前缀守恒判定的纯函数部分——在【编码后的请求体】上判定这次请求是不是上一次的纯追加。判定点放在
// fetch 之前的 wire 形状上、不放在中立 Turn 上：adapter 自己也会动前缀（拆 tool 消息、回放思维链、合并文本、挪缓存
// 标记），只有编码后的样子才是 provider 真正看到的。只存哈希与字符数，不存正文。
import { createHash } from "node:crypto";
import type { Turn, WireShape } from "../agent/turn.ts";

export type { WireShape };

// adapter 在 fetch 前调它：把编码好的请求体交给这次请求的观察者。观察者出错只记一行，绝不影响请求本身。
export function observeWire(turn: Turn, shape: WireShape, body: Record<string, unknown>): void {
  const observe = turn.hints?.onWire;
  if (!observe) return;
  try {
    observe(shape, body);
  } catch (err) {
    console.warn(`[prefix] request observer failed: ${(err as Error).message}`);
  }
}

export interface WirePart {
  hash: string;
  chars: number;
}

export interface WireFingerprint {
  shape: WireShape;
  tools: WirePart;
  system: WirePart;
  params: WirePart;
  // 消息逐条（Anthropic / OpenAI 的 messages，OpenAI 去掉打头的 system；Gemini 的 contents）
  items: WirePart[];
}

// Anthropic 的 cache_control 标记每次请求都挪到最后两条消息上——它是标记不是内容，不算前缀变化。
const dropMarks = (key: string, value: unknown) => (key === "cache_control" ? undefined : value);

function part(value: unknown): WirePart {
  if (value === undefined) return { hash: "", chars: 0 };
  const json = JSON.stringify(value, dropMarks);
  return { hash: createHash("sha1").update(json).digest("hex").slice(0, 16), chars: json.length };
}

// 其余顶层字段（model、max_tokens、思考档位、providerExtras……）一律算参数：新加的字段默认「影响复用」，
// 要排除必须在这里显式写明（Codex 穷举比较请求属性的同一条纪律）。流式开关不进提示词。
// R9：输出上限也不进——各家的提示词缓存只认前缀、不认输出长度，而 loop 离窗口边缘不远时会逐次夹住它
// （Gemini 的在 generationConfig 里，单独剔掉）。
const NOT_PARAMS = new Set(["messages", "system", "tools", "contents", "systemInstruction", "stream", "stream_options", "max_tokens", "max_completion_tokens", "max_output_tokens"]);

function paramsOf(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) if (!NOT_PARAMS.has(key)) out[key] = body[key];
  const gc = out.generationConfig;
  if (gc && typeof gc === "object" && "maxOutputTokens" in gc) {
    const { maxOutputTokens: _drop, ...rest } = gc as Record<string, unknown>;
    out.generationConfig = rest;
  }
  return out;
}

export function fingerprintWire(shape: WireShape, body: Record<string, unknown>): WireFingerprint {
  const params = part(paramsOf(body));
  if (shape === "openai") {
    const messages = Array.isArray(body.messages) ? (body.messages as { role?: unknown }[]) : [];
    const system = messages[0]?.role === "system" ? messages[0] : undefined;
    return { shape, tools: part(body.tools), system: part(system), params, items: messages.slice(system ? 1 : 0).map(part) };
  }
  if (shape === "gemini") {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    return { shape, tools: part(body.tools), system: part(body.systemInstruction), params, items: contents.map(part) };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return { shape, tools: part(body.tools), system: part(body.system), params, items: messages.map(part) };
}

export type BreakPoint = "tools" | "system" | "params" | number;

export interface PrefixVerdict {
  verdict: "first" | "append" | "break";
  at?: BreakPoint; // 断在哪：工具 / system / 参数，或第几条消息（0 起）
  shared: number; // 与上一次请求相同的前缀消息条数
  items: number; // 本次请求的消息条数
  resentChars: number; // 上一次请求里接不上、要重新处理的字符数（前缀缓存按这个量作废）
}

const HEAD = ["tools", "system", "params"] as const;
const sumChars = (parts: readonly WirePart[]) => parts.reduce((n, p) => n + p.chars, 0);

// 前缀顺序按 工具 → system → 参数 → 消息 估：哪里先不同就断在哪，它和它后面的全部要重算。
export function comparePrefix(prev: WireFingerprint | null, next: WireFingerprint): PrefixVerdict {
  const items = next.items.length;
  if (!prev || prev.shape !== next.shape) return { verdict: "first", shared: 0, items, resentChars: 0 };
  for (let i = 0; i < HEAD.length; i++) {
    const key = HEAD[i];
    if (prev[key].hash !== next[key].hash) {
      const resentChars = sumChars(HEAD.slice(i).map((k) => prev[k])) + sumChars(prev.items);
      return { verdict: "break", at: key, shared: 0, items, resentChars };
    }
  }
  let shared = 0;
  while (shared < prev.items.length && shared < items && prev.items[shared].hash === next.items[shared].hash) shared++;
  if (shared === prev.items.length) return { verdict: "append", shared, items, resentChars: 0 };
  return { verdict: "break", at: shared, shared, items, resentChars: sumChars(prev.items.slice(shared)) };
}

// ── 落盘（会话记录里的「上一次请求」基线，恢复会话后接着比）──────────────────────────────
export interface SerializedFingerprint {
  shape: WireShape;
  t: [string, number];
  s: [string, number];
  p: [string, number];
  i: [string, number][];
}

const pack = (p: WirePart): [string, number] => [p.hash, p.chars];

export function serializeFingerprint(fp: WireFingerprint): SerializedFingerprint {
  return { shape: fp.shape, t: pack(fp.tools), s: pack(fp.system), p: pack(fp.params), i: fp.items.map(pack) };
}

function unpack(raw: unknown): WirePart | null {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string" || typeof raw[1] !== "number") return null;
  return { hash: raw[0], chars: raw[1] };
}

// 形状不对就当没有基线（只是诊断数据，宁缺毋错）。
export function parseFingerprint(raw: unknown): WireFingerprint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof SerializedFingerprint, unknown>>;
  if (r.shape !== "anthropic" && r.shape !== "openai" && r.shape !== "gemini") return null;
  const tools = unpack(r.t), system = unpack(r.s), params = unpack(r.p);
  if (!tools || !system || !params || !Array.isArray(r.i)) return null;
  const items: WirePart[] = [];
  for (const x of r.i) {
    const p = unpack(x);
    if (!p) return null;
    items.push(p);
  }
  return { shape: r.shape, tools, system, params, items };
}
