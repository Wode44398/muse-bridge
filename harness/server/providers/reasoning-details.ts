// OpenRouter 的 reasoning_details（Chat Completions）：思考以条目数组返回——reasoning.text（text + signature）、
// reasoning.summary（summary）、reasoning.encrypted（data），各带 id / format / index。带工具调用的回合要把这串条目按原顺序、
// 原样放回 assistant 消息的 reasoning_details，上游（Anthropic、Gemini、OpenAI 推理型号）才接得上调工具前的推理。
// 流式时条目一片一片来（delta.reasoning_details），官方文档的说法是「按顺序拼起来就是完整序列」：同一条（类型、index、id 对得上）
// 的后续分片把 text / summary / data 接在后面、签名等字段取最后给出的；对不上就是新的一条。
// 依据：https://openrouter.ai/docs/guides/best-practices/reasoning-tokens（2026-11-24 核对）。

export type ReasoningDetail = Record<string, unknown>;

const TEXT_FIELDS = ["text", "summary", "data"] as const;
const MAX_DETAILS = 256; // 一次回复里的条目数上限（防异常流把一条消息撑爆）

/** 流里一块 delta 的 reasoning_details：只留对象条目（浅拷贝），没有就是空数组。 */
export function deltaDetails(delta: unknown): ReasoningDetail[] {
  const raw = (delta as { reasoning_details?: unknown } | null)?.reasoning_details;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is ReasoningDetail => Boolean(d) && typeof d === "object" && !Array.isArray(d)).map((d) => ({ ...d }));
}

const sameDetail = (a: ReasoningDetail, b: ReasoningDetail): boolean =>
  a.type === b.type && (a.index ?? null) === (b.index ?? null) && (b.id == null || a.id == null || a.id === b.id);

/** 把一片接到已有的条目序列上（就地改 list）：同一条就拼接，不是就追加。 */
export function mergeDetail(list: ReasoningDetail[], piece: ReasoningDetail): void {
  const last = list[list.length - 1];
  if (!last || !sameDetail(last, piece)) {
    if (list.length < MAX_DETAILS) list.push({ ...piece });
    return;
  }
  for (const [k, v] of Object.entries(piece)) {
    if ((TEXT_FIELDS as readonly string[]).includes(k) && typeof v === "string") last[k] = typeof last[k] === "string" ? `${last[k] as string}${v}` : v;
    else if (v !== null && v !== undefined && v !== "") last[k] = v;
    else if (!(k in last)) last[k] = v;
  }
}

/** 一条 assistant 消息里各思考块的条目，按块的顺序接成要回传的数组（没有就是 null）。 */
export function replayDetails(blocks: readonly { t: string; details?: ReasoningDetail[] }[]): ReasoningDetail[] | null {
  const out: ReasoningDetail[] = [];
  for (const b of blocks) if (b.t === "thinking" && Array.isArray(b.details)) out.push(...b.details);
  return out.length ? out : null;
}
