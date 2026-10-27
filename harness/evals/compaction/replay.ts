// Q6（N47）：把一段真实会话按原顺序一条条回放进生产的 AgentState，每次「要请求模型之前」（用户消息 / 工具结果之后）
// 调生产的 ensureContextFits——微压缩、切分、摘要、熔断都是生产代码，这里一行不抄。窗口可以设得比真实的小，好让
// 中等长度的会话也压上好几轮（反复压缩模拟）。每次整段压缩之后量两样东西：
//   · 腾出多少、压完剩多少（相对触发线）——hermes 的 Jev 教训：每轮能腾出的空间单调衰减 = 棘轮，终会卡死；
//   · 召回：已经不在上下文里原样出现的消息，它们的锚点还能不能在上下文里（摘要等）按字符串找到，按「被压过几轮」分桶。
// R10（二）：archive 开着时接一个内存里的压缩归档（生产 compact() 照常写、摘要里照常列出），回查臂拿它答题。
import { BUFFER_TOKENS, ensureContextFits, estimateTokens } from "../../server/agent/context.ts";
import { AgentState } from "../../server/agent/state.ts";
import type { Msg } from "../../server/agent/turn.ts";
import type { ProviderAdapter } from "../../server/providers/types.ts";
import type { ToolContext } from "../../server/tools/types.ts";
import { ANCHOR_KINDS, type Anchor, type AnchorKind, anchorsOf, contentSig, renderText } from "./anchors.ts";

export interface Tally {
  asked: number;
  recalled: number;
}
const tally = (): Tally => ({ asked: 0, recalled: 0 });
export const AGE_BUCKETS = 4; // 0、1、2、3+ 轮

export interface CompactionEvent {
  at: number; // 回放到原转录第几条时发生
  beforeTokens: number;
  afterTokens: number;
  freed: number; // (before - after) / before
  floor: number; // after / 触发线：越接近 1，下一次越快又要压
  byAge: Tally[]; // 这次压完的召回，按锚点被压过几轮分桶
}

export interface ReplayResult {
  messages: number;
  trigger: number; // 触发线（token）= 窗口 − 缓冲
  events: CompactionEvent[];
  microOnly: number; // 只靠微压缩就回到触发线以下的次数
  failures: number; // 整段压缩失败（生产侧计数，满 3 次熔断）
  final: {
    byKind: Record<AnchorKind, Tally>; // 回放结束时的召回，按锚点种类
    context: Msg[]; // 回放结束时的上下文（答题臂拿它答题）
    questions: Anchor[]; // 回放结束时该考的锚点：来源已不在上下文里原样出现、且原样部分里也找不到
    archives: Map<string, string>; // 压缩归档（archive 开着时）：文件名 → 内容
  };
}

export interface ReplayOptions {
  window: number; // 模拟的上下文窗口（token）
  summarizer: ProviderAdapter; // 生产 summarize 用它出摘要
  system?: string; // 会话记录里的 system（算进用量，和生产一样）
  archive?: boolean; // R10（二）：接内存归档
}

interface Measure {
  byAge: Tally[];
  byKind: Record<AnchorKind, Tally>;
  questions: Anchor[];
}

export async function replay(original: readonly Msg[], opts: ReplayOptions): Promise<ReplayResult> {
  const s = opts.summarizer;
  const adapter: ProviderAdapter = {
    id: s.id,
    model: s.model,
    capabilities: { ...s.capabilities, contextWindow: opts.window },
    stream: (turn, signal) => s.stream(turn, signal),
  };
  const archives = new Map<string, string>();
  let archiveNo = 0;
  const state = new AgentState({
    adapter,
    system: opts.system ?? "",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { readFileState: new Map() } as unknown as ToolContext,
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
    compactionArchive: opts.archive
      ? {
          plan: (count) => {
            archiveNo++;
            return count <= 1 ? [`/archive/compacted-${archiveNo}.txt`] : Array.from({ length: count }, (_, k) => `/archive/compacted-${archiveNo}-${k + 1}.txt`);
          },
          write: async (list) => {
            for (const f of list) archives.set(f.path, f.text);
          },
        }
      : undefined,
  });
  const trigger = opts.window - BUFFER_TOKENS;
  const sigs: string[] = [];
  const anchors: Anchor[] = [];
  const lostAt = new Map<Anchor, number>(); // 锚点第一次「来源不在上下文里原样出现」时，已经做过几次整段压缩
  const events: CompactionEvent[] = [];
  let microOnly = 0;
  let failures = 0;

  const measure = (generation: number): Measure => {
    const originals = new Set(sigs);
    const inContext = new Set(state.messages.map(contentSig));
    const verbatim = renderText(state.messages.filter((m) => originals.has(contentSig(m))));
    const synthetic = renderText(state.messages.filter((m) => !originals.has(contentSig(m))));
    const byAge = Array.from({ length: AGE_BUCKETS }, tally);
    const byKind = Object.fromEntries(ANCHOR_KINDS.map((k) => [k, tally()])) as Record<AnchorKind, Tally>;
    const questions: Anchor[] = [];
    for (const a of anchors) {
      if (inContext.has(sigs[a.source])) continue; // 来源还原样在上下文里：不用召回
      if (!lostAt.has(a)) lostAt.set(a, generation);
      if (verbatim.includes(a.needle)) continue; // 答案就在原样保留的部分里：不算考题
      const hit = synthetic.includes(a.needle);
      const age = Math.min(generation - lostAt.get(a)!, AGE_BUCKETS - 1);
      byAge[age].asked++;
      byKind[a.kind].asked++;
      if (hit) {
        byAge[age].recalled++;
        byKind[a.kind].recalled++;
      }
      questions.push(a);
    }
    return { byAge, byKind, questions };
  };

  for (let i = 0; i < original.length; i++) {
    const m = original[i];
    state.messages.push(structuredClone(m)); // 克隆：微压缩就地改写的是上下文里的那份，原转录不动
    sigs.push(contentSig(m));
    anchors.push(...anchorsOf(m, i));
    if (m.role !== "user") continue; // 生产在每次请求模型之前检查：用户消息 / 工具结果之后
    const beforeTokens = estimateTokens(state.system, state.messages);
    const count = state.messages.length;
    const failuresBefore = state.compactionFailures;
    const fit = await ensureContextFits(state);
    if (state.compactionFailures > failuresBefore) failures++;
    if (state.messages.length < count) {
      const afterTokens = estimateTokens(state.system, state.messages);
      const { byAge } = measure(events.length + 1);
      events.push({ at: i, beforeTokens, afterTokens, freed: (beforeTokens - afterTokens) / beforeTokens, floor: afterTokens / trigger, byAge });
    } else if (fit.compacted) {
      microOnly++;
    }
  }
  const end = measure(events.length);
  return {
    messages: original.length,
    trigger,
    events,
    microOnly,
    failures,
    final: { byKind: end.byKind, context: state.messages, questions: end.questions, archives },
  };
}

// 摘要臂之外的对照：drop = 压缩照常切分，但摘要里什么都不留——量出「摘要到底贡献了多少」的下限。占位文字要够长
// （生产把短得离谱的摘要当成没写，#83），且不含任何锚点。
const DROP_PLACEHOLDER =
  "(summary omitted) This comparison arm keeps nothing from the compacted part of the conversation on purpose: it is the floor " +
  "that the real summary is measured against. Continue from the most recent messages, which are kept verbatim below.";

export function emptySummarizer(base: ProviderAdapter): ProviderAdapter {
  return {
    id: base.id,
    model: `${base.model} (drop)`,
    capabilities: base.capabilities,
    async *stream() {
      yield { e: "text_delta", text: DROP_PLACEHOLDER };
      yield { e: "turn_done", stopReason: "end" };
    },
  };
}
